// Sessions: every visitor (a cookie) gets an engine of their own in a worker thread (engine.ts), so twenty people can
// each run a dossier at the same time without replacing each other's case. The main thread only routes: calls go to the
// visitor's worker, the worker's live stream goes to that visitor's open pages. A few booted workers wait unclaimed, so
// a new visitor does not wait for the engine to start. The limits all sessions share (LLM calls, requests per public
// host) are counted here and granted to the workers as permits (permits.ts).

import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"
import { config } from "../config"
import type { EngineOp, FromEngine, SessionWorkerData, ToEngine } from "./protocol"

/** One open page: a WebSocket, or an SSE response when the page fell back to it. Data arrives already as JSON. */
export interface LiveClient {
	send(event: string, json: string): void
	/** the events of the current run, each already JSON */
	replay(events: readonly string[]): void
	close(): void
	isClosed(): boolean
}

/** An error the server answers with its own status (the message is in Serbian; messageIn translates it). */
export class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

export const SESSION_LOST = "Sesija je prekinuta. Osvežite stranicu."

// Events of the current run, replayed after the snapshot on (re)connect so a page reload rebuilds the live Gantt.
const HISTORY_MAX = 8000
const ENGINE_FILE = new URL("./engine.ts", import.meta.url)
const DATA_FILE = new URL("./data-worker.ts", import.meta.url)

let seq = 0

export class Session {
	readonly label = `s${++seq}`
	readonly clients = new Set<LiveClient>()
	sid: string | undefined
	lastActive = Date.now()
	readonly ready: Promise<void>
	/** permits this worker holds: permit id → key */
	readonly held = new Map<number, string>()
	private history: string[] = []
	private worker: Worker
	private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	private nextCall = 0
	private abandonTimer: NodeJS.Timeout | undefined
	private dead = false
	private booted = false

	constructor(private readonly pool: SessionPool) {
		const dataPort = pool.dataPort()
		const workerData: SessionWorkerData = { dosijeSession: this.label, dataPort }
		this.worker = new Worker(ENGINE_FILE, {
			workerData,
			transferList: dataPort ? [dataPort] : [],
			resourceLimits: { maxOldGenerationSizeMb: config.sessions.memoryMb },
		})
		let markReady: () => void
		let markFailed: (e: Error) => void
		this.ready = new Promise<void>((resolve, reject) => {
			markReady = resolve
			markFailed = reject
		})
		this.ready.catch(() => {})
		this.worker.on("message", (m: FromEngine) => {
			if (m.t !== "ready") return this.onMessage(m)
			this.booted = true
			markReady()
		})
		this.worker.on("error", (err) => console.error(`[${this.label}] worker:`, err))
		this.worker.on("exit", (code) => {
			markFailed(new RequestError(503, SESSION_LOST))
			if (!this.booted) this.pool.bootFailed()
			this.end(code === 0 ? "kraj" : `worker je stao (kod ${code})`)
		})
	}

	get alive(): boolean {
		return !this.dead
	}

	async call<T = unknown>(op: EngineOp, args: Record<string, unknown> = {}): Promise<T> {
		await this.ready
		if (this.dead) throw new RequestError(503, SESSION_LOST)
		this.lastActive = Date.now()
		const id = ++this.nextCall
		return new Promise<T>((resolve, reject) => {
			this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject })
			this.post({ t: "call", id, op, args })
		})
	}

	/** A page opened its live stream: the snapshot and the replay first, then every event as it happens. */
	async attach(c: LiveClient): Promise<void> {
		clearTimeout(this.abandonTimer)
		try {
			const snapshot = await this.call("state")
			if (c.isClosed() || this.dead) return
			// results and events come over one port in the order the worker sent them: the history now holds every event
			// up to this snapshot, and nothing after it is missed because the page is added in the same tick
			c.send("snapshot", JSON.stringify(snapshot))
			c.replay(this.history)
			this.clients.add(c)
			this.lastActive = Date.now()
		} finally {
			if (this.clients.size === 0 && !this.dead) this.scheduleAbandon()
		}
	}

	detach(c: LiveClient): void {
		if (!this.clients.delete(c)) return
		this.lastActive = Date.now()
		if (this.clients.size === 0) this.scheduleAbandon()
	}

	/** One-time searches: when the last open page is gone (closed, not just reloaded), the session is dropped. */
	scheduleAbandon(): void {
		clearTimeout(this.abandonTimer)
		this.abandonTimer = setTimeout(() => {
			if (this.clients.size === 0) this.stop("stranica je zatvorena")
		}, config.sessions.abandonMs)
		this.abandonTimer.unref?.()
	}

	stop(reason: string): void {
		if (this.dead) return
		this.end(reason)
		void this.worker.terminate()
	}

	post(m: ToEngine): void {
		if (!this.dead) this.worker.postMessage(m)
	}

	private onMessage(m: FromEngine): void {
		switch (m.t) {
			case "result": {
				const call = this.calls.get(m.id)
				this.calls.delete(m.id)
				if (!call) return
				if (m.ok) call.resolve(m.value)
				else call.reject(m.status ? new RequestError(m.status, m.message) : new Error(m.message))
				return
			}
			case "ev":
				this.lastActive = Date.now()
				if (m.type === "dosije.started" || m.type === "mapa.started") this.history = []
				this.history.push(m.json)
				if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX)
				for (const c of this.clients) c.send("ev", m.json)
				return
			case "push":
				this.lastActive = Date.now()
				for (const c of this.clients) c.send(m.event, m.json)
				return
			case "permit.acquire":
				this.pool.permits.acquire(this, m.id, m.key)
				return
			case "permit.release":
				this.pool.permits.release(this, m.id)
				return
		}
	}

	private end(reason: string): void {
		if (this.dead) return
		this.dead = true
		clearTimeout(this.abandonTimer)
		for (const call of this.calls.values()) call.reject(new RequestError(503, SESSION_LOST))
		this.calls.clear()
		for (const c of [...this.clients]) {
			try {
				c.close()
			} catch {
				// already closed
			}
		}
		this.clients.clear()
		this.history = []
		this.pool.forget(this, reason)
	}
}

/** Shared counters: "llm" (LLM_CONCURRENCY_TOTAL) and "host:<host>" (HTTP_PER_HOST_TOTAL). FIFO across sessions. */
class PermitBroker {
	private counters = new Map<string, { active: number; queue: { s: Session; id: number }[] }>()

	private limit(key: string): number {
		return key === "llm" ? config.shared.llmConcurrency : config.shared.requestsPerHost
	}

	private counter(key: string) {
		let c = this.counters.get(key)
		if (!c) this.counters.set(key, (c = { active: 0, queue: [] }))
		return c
	}

	acquire(s: Session, id: number, key: string): void {
		const c = this.counter(key)
		if (c.active < this.limit(key)) {
			c.active++
			this.grant(s, id, key)
		} else c.queue.push({ s, id })
	}

	release(s: Session, id: number): void {
		const key = s.held.get(id)
		if (key === undefined) return
		s.held.delete(id)
		const c = this.counter(key)
		let next = c.queue.shift()
		while (next && !next.s.alive) next = c.queue.shift()
		// the permit passes straight to the next one waiting; the count stays the same
		if (next) this.grant(next.s, next.id, key)
		else c.active = Math.max(0, c.active - 1)
	}

	/** A worker that ended gives back everything it held, and leaves every queue. */
	releaseAll(s: Session): void {
		for (const c of this.counters.values()) c.queue = c.queue.filter((w) => w.s !== s)
		for (const id of [...s.held.keys()]) this.release(s, id)
	}

	usage(): Record<string, { active: number; waiting: number }> {
		const out: Record<string, { active: number; waiting: number }> = {}
		for (const [key, c] of this.counters) if (c.active || c.queue.length) out[key] = { active: c.active, waiting: c.queue.length }
		return out
	}

	private grant(s: Session, id: number, key: string): void {
		s.held.set(id, key)
		s.post({ t: "permit.granted", id })
	}
}

export class SessionPool {
	readonly permits = new PermitBroker()
	private bySid = new Map<string, Session>()
	private warm: Session[] = []
	private closing = false
	private lastBootFailure = 0
	private data: Worker | undefined

	/** Boots the data worker and the warm workers. */
	start(): void {
		this.startData()
		this.refill()
	}

	/** A new session's end of a channel to the data worker (none while it restarts: the session then reads the index itself). */
	dataPort(): MessagePort | undefined {
		if (!this.data) return undefined
		const { port1, port2 } = new MessageChannel()
		this.data.postMessage({ t: "port", port: port1 }, [port1])
		return port2
	}

	get(sid: string): Session | undefined {
		const s = this.bySid.get(sid)
		return s?.alive ? s : undefined
	}

	/** Whether a new visitor would get a session now (a free place, a warm worker, or an idle session to give up). */
	hasRoom(): boolean {
		return this.total() < config.sessions.max || this.warm.length > 0 || this.idleVictim() !== undefined
	}

	/** The visitor's session, a new one, or null when the server is full. */
	claim(sid: string): Session | null {
		const existing = this.get(sid)
		if (existing) return existing
		if (this.closing) return null
		let s = this.warm.shift()
		if (!s) {
			if (this.total() >= config.sessions.max) {
				const victim = this.idleVictim()
				if (!victim) return null
				victim.stop("mesto je dato novom posetiocu")
			}
			s = new Session(this)
		}
		s.sid = sid
		this.bySid.set(sid, s)
		s.lastActive = Date.now()
		// a session nobody ever opens a page for is dropped like an abandoned one
		s.scheduleAbandon()
		console.log(`[sesije] ${s.label} otvorena (${this.bySid.size}/${config.sessions.max})`)
		this.refill()
		return s
	}

	forget(s: Session, reason: string): void {
		this.permits.releaseAll(s)
		this.warm = this.warm.filter((w) => w !== s)
		if (s.sid && this.bySid.get(s.sid) === s) {
			this.bySid.delete(s.sid)
			console.log(`[sesije] ${s.label} zatvorena: ${reason} (${this.bySid.size}/${config.sessions.max})`)
		}
		this.refill()
	}

	/** A worker that ended before its engine was ready: the next warm one waits, so a broken boot cannot spin. */
	bootFailed(): void {
		this.lastBootFailure = Date.now()
	}

	status() {
		return {
			sessions: this.bySid.size,
			max: config.sessions.max,
			warm: this.warm.length,
			livePages: [...this.bySid.values()].reduce((n, s) => n + s.clients.size, 0),
			shared: this.permits.usage(),
		}
	}

	shutdown(): void {
		this.closing = true
		for (const s of [...this.bySid.values(), ...this.warm]) s.stop("server se gasi")
		void this.data?.terminate()
	}

	private startData(): void {
		const w = new Worker(DATA_FILE)
		w.on("error", (err) => console.error("[podaci] worker:", err))
		w.on("exit", (code) => {
			if (this.data === w) this.data = undefined
			if (this.closing) return
			console.error(`[podaci] worker je stao (kod ${code}); ponovo za 5 s`)
			setTimeout(() => this.startData(), 5000).unref?.()
		})
		this.data = w
	}

	private total(): number {
		return this.bySid.size + this.warm.length
	}

	/** The session idle for longest, if it has been idle past DOSIJE_IDLE_EVICT_MS. */
	private idleVictim(): Session | undefined {
		const cutoff = Date.now() - config.sessions.idleEvictMs
		let victim: Session | undefined
		for (const s of this.bySid.values()) if (s.lastActive < cutoff && (!victim || s.lastActive < victim.lastActive)) victim = s
		return victim
	}

	private refill(): void {
		if (this.closing) return
		const wait = Math.max(0, this.lastBootFailure + 5000 - Date.now())
		const timer = setTimeout(() => {
			while (!this.closing && this.warm.length < config.sessions.warm && this.total() < config.sessions.max) this.warm.push(new Session(this))
		}, wait)
		timer.unref?.()
	}
}

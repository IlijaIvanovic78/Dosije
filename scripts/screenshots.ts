// The README screenshots: a headless Chrome, driven over the DevTools protocol, goes through the app like a visitor and
// writes docs/img/*.png. Run it against a server in scripted mode, so the run is free and the same every time:
//   DOSIJE_MODE=scripted npm start                     (another terminal; PORT=3007 for another port)
//   npm run screenshots -- --url http://localhost:3000
// Chrome is found in the usual places; CHROME_PATH points to another one (Edge works too).

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const arg = (name: string, fallback: string) => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = arg("url", "http://localhost:3000").replace(/\/$/, "")
const OUT = path.resolve(arg("out", "docs/img"))
const PORT = 9333
const DESKTOP = { width: 1440, height: 900, dpr: 1, mobile: false }
const PHONE = { width: 390, height: 844, dpr: 2, mobile: true }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function chromePath(): string {
	const candidates = [
		process.env.CHROME_PATH,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	]
	const found = candidates.find((p) => p && fs.existsSync(p))
	if (!found) throw new Error("Chrome nije pronađen: postavite CHROME_PATH")
	return found
}

/** A minimal DevTools protocol client over the WebSocket of one page. */
class Page {
	private id = 0
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
	private constructor(private ws: WebSocket) {
		ws.addEventListener("message", (m) => {
			const msg = JSON.parse(String(m.data))
			const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined
			if (!p) return
			this.pending.delete(msg.id)
			if (msg.error) p.reject(new Error(msg.error.message))
			else p.resolve(msg.result)
		})
	}

	static async open(url: string): Promise<Page> {
		const ws = new WebSocket(url)
		await new Promise((resolve, reject) => {
			ws.addEventListener("open", resolve, { once: true })
			ws.addEventListener("error", reject, { once: true })
		})
		return new Page(ws)
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<any> {
		const id = ++this.id
		this.ws.send(JSON.stringify({ id, method, params }))
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
	}

	async eval<T = unknown>(expression: string): Promise<T> {
		const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
		if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
		return r.result.value as T
	}

	async waitFor(expression: string, timeoutMs = 30_000, label = expression): Promise<void> {
		const end = Date.now() + timeoutMs
		while (Date.now() < end) {
			if (await this.eval<boolean>(`Boolean(${expression})`).catch(() => false)) return
			await sleep(250)
		}
		throw new Error(`čekao sam predugo: ${label}`)
	}

	async viewport(v: typeof DESKTOP): Promise<void> {
		await this.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: v.mobile })
		await this.send("Emulation.setTouchEmulationEnabled", { enabled: v.mobile, maxTouchPoints: v.mobile ? 5 : 1 })
	}

	async goto(url: string): Promise<void> {
		await this.send("Page.navigate", { url })
		await sleep(300)
		await this.waitFor(`document.readyState === "complete"`, 20_000)
	}

	async click(selector: string): Promise<void> {
		await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`, 20_000, selector)
		await this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`)
	}

	async shot(name: string): Promise<void> {
		await sleep(700)
		// the start page has a photo behind it: JPEG keeps that small, the rest of the interface stays sharp as PNG
		const jpeg = name.endsWith(".jpg")
		const { data } = await this.send("Page.captureScreenshot", jpeg ? { format: "jpeg", quality: 82 } : { format: "png" })
		fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"))
		console.log(`  ${name}`)
	}
}

/** A visitor of their own: no cookie (a new session) and the interface in the given language. */
async function freshVisit(page: Page, lang: "sr" | "en"): Promise<void> {
	await page.send("Network.clearBrowserCookies")
	await page.goto(`${BASE}/`)
	await page.eval(`localStorage.clear(); localStorage.setItem("dosije.lang", "${lang}")`)
	await page.goto(`${BASE}/`)
	await page.waitFor(`document.querySelectorAll("#heroChips .example").length >= 4`, 20_000, "aktuelne institucije")
	await sleep(1200)
}

const startExample = (page: Page, i: number) => page.eval(`document.querySelectorAll("#heroChips .example")[${i}].click()`)
const caseDone = `!document.getElementById("doneCard").hidden`
const scrollTo = (page: Page, selector: string, block = "start") => page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "${block}" })`)

async function desktop(page: Page): Promise<void> {
	await page.viewport(DESKTOP)
	await freshVisit(page, "sr")
	await page.shot("00-start.jpg")
	// the sources carousel and the QR code under it, below the top bar
	await scrollTo(page, "#srcTitle")
	await page.eval(`window.scrollBy(0, -110)`)
	await page.shot("01-try-it.png")

	await startExample(page, 0)
	// mid-run: the core agents and the ones the Fabrika spawned work at the same time and the first signals are in
	await page.waitFor(`document.querySelectorAll("#lanesDyn .lane").length >= 8 && document.querySelectorAll("#findList > *").length >= 6`, 60_000, "agenti i prvi nalazi")
	await sleep(1500)
	await page.shot("02-team-live.png")

	await page.waitFor(caseDone, 300_000, "dosije je spreman")
	await page.eval(`document.getElementById("dosijeScroll").scrollTop = 0`)
	await page.shot("03-done.png")
	await scrollTo(page, "#signalsBody")
	await page.eval(`document.getElementById("dosijeScroll").scrollBy(0, -90)`)
	await page.shot("04-signals.png")

	await page.click("#btnReport")
	await page.waitFor(`!document.getElementById("reportModal").hidden && document.getElementById("reportBody").textContent.length > 200`, 20_000, "izveštaj")
	await page.shot("05-report.png")
	await page.click("#reportClose")

	await page.click("#btnMapa")
	await sleep(800)
	// the list starts with the preset institutions
	await page.click("#btnMapaRun")
	await page.waitFor(`document.getElementById("mapaStatus").classList.contains("running")`, 20_000, "mapa je pokrenuta")
	await page.waitFor(`document.getElementById("mapaStatus").classList.contains("done") && document.querySelectorAll("#mapaRows > *").length >= 6`, 240_000, "mapa prioriteta")
	await page.shot("06-mapa.png")

	// the scripted agents write their findings in Serbian, so the English interface is shown on the start page
	await freshVisit(page, "en")
	await page.shot("07-en.jpg")
}

async function phone(page: Page): Promise<void> {
	await page.viewport(PHONE)
	await freshVisit(page, "sr")
	await page.shot("08-phone-start.jpg")
	await startExample(page, 2)
	await page.waitFor(`document.querySelectorAll("#lanesDyn .lane").length >= 3`, 60_000, "agenti na telefonu")
	await sleep(3000)
	await page.shot("09-phone-team.png")
	// when the dossier is ready the phone switches to it on its own
	await page.waitFor(caseDone, 300_000, "dosije je spreman (telefon)")
	await sleep(1500)
	await page.shot("10-phone-dossier.png")
}

async function main(): Promise<void> {
	const config = await (await fetch(`${BASE}/api/config`)).json()
	if (config.mode !== "scripted") console.log(`Server radi u režimu ${config.mode}: svaki dosije troši LLM kredite.`)
	fs.mkdirSync(OUT, { recursive: true })
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dosije-shots-"))
	const chrome = spawn(chromePath(), ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--window-size=1440,900", "about:blank"], { stdio: "ignore" })
	try {
		let target: { type: string; webSocketDebuggerUrl: string } | undefined
		for (let i = 0; i < 60 && !target; i++) {
			await sleep(250)
			const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>).catch(() => [])
			target = list.find((t) => t.type === "page")
		}
		if (!target) throw new Error("Chrome nije otvorio stranicu")
		const page = await Page.open(target.webSocketDebuggerUrl)
		await page.send("Page.enable")
		await page.send("Network.enable")
		await page.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Belgrade" })
		console.log(`slike u ${OUT}`)
		await desktop(page)
		await phone(page)
	} finally {
		chrome.kill()
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err)
		process.exit(1)
	},
)

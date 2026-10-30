// Report modal: Markdown render, download, print/PDF, copy.

import { renderMarkdown } from "./markdown.js"
import { state, on } from "./store.js"
import { api } from "./api.js"
import { toast, dismissToasts } from "./toast.js"
import { fmtClock } from "./format.js"

let modal, body, copyBtn, titleEl

export function openReport() {
	if (!state.report) {
		toast({ kind: "info", title: "Izveštaj još nije spreman", text: "Pojaviće se kad agenti završe dosije." })
		return
	}
	body.innerHTML = renderMarkdown(state.report.markdown)
	titleEl.textContent = state.institution?.name ? `Dosije: ${state.institution.name}` : "Dosije"
	modal.hidden = false
	dismissToasts(".toast.done")
	requestAnimationFrame(() => modal.classList.add("open"))
	document.body.classList.add("modal-open")
	body.scrollTop = 0
	modal.querySelector(".modal-card").focus({ preventScroll: true })
}

export function closeReport() {
	modal.classList.remove("open")
	document.body.classList.remove("modal-open")
	setTimeout(() => {
		if (!modal.classList.contains("open")) modal.hidden = true
	}, 220)
}

async function download() {
	let text = state.report?.markdown || ""
	try {
		const remote = await api.reportMd()
		if (typeof remote === "string" && remote.trim()) text = remote
	} catch {}
	const blob = new Blob([text], { type: "text/markdown;charset=utf-8" })
	const a = document.createElement("a")
	a.href = URL.createObjectURL(blob)
	a.download = `dosije-${state.caseId || "izvestaj"}.md`
	document.body.appendChild(a)
	a.click()
	a.remove()
	setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

async function copy() {
	const text = state.report?.markdown || ""
	try {
		await navigator.clipboard.writeText(text)
	} catch {
		const ta = document.createElement("textarea")
		ta.value = text
		ta.style.cssText = "position:fixed;opacity:0"
		document.body.appendChild(ta)
		ta.select()
		document.execCommand("copy")
		ta.remove()
	}
	copyBtn.textContent = "Kopirano ✓"
	setTimeout(() => (copyBtn.textContent = "Kopiraj"), 1800)
}

function print() {
	document.body.classList.add("printing-report")
	const cleanup = () => {
		document.body.classList.remove("printing-report")
		window.removeEventListener("afterprint", cleanup)
	}
	window.addEventListener("afterprint", cleanup)
	window.print()
}

export function initReport() {
	modal = document.getElementById("reportModal")
	body = document.getElementById("reportBody")
	copyBtn = document.getElementById("reportCopy")
	titleEl = document.getElementById("reportTitle")
	document.getElementById("reportClose").addEventListener("click", closeReport)
	document.getElementById("reportDownload").addEventListener("click", download)
	document.getElementById("reportPrint").addEventListener("click", print)
	copyBtn.addEventListener("click", copy)
	modal.addEventListener("mousedown", (e) => {
		if (e.target === modal) closeReport()
	})
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !modal.hidden) closeReport()
	})
	on("done", (report) => {
		if (!report) return
		toast({
			kind: "done",
			title: "Dosije je spreman",
			text: `Izveštaj generisan u ${fmtClock(Date.parse(report.generatedAt) || Date.now())}. Pregledaj signale i šta još treba proveriti.`,
			ttl: 16000,
			actions: [{ label: "Otvori izveštaj", onClick: openReport }],
		})
	})
}

// Report modal: Markdown render, download, print/PDF, copy.

import { renderMarkdown } from "./markdown.js"
import { state } from "./store.js"
import { api } from "./api.js"
import { toast, dismissToasts } from "./toast.js"
import { t, getLang } from "./i18n.js"

let modal, body, copyBtn, titleEl
// the Markdown on screen: the report itself, or its English translation
let shown = ""

export function openReport() {
	if (!state.report) {
		toast({ kind: "info", title: t("Izveštaj još nije spreman"), text: t("Pojaviće se kad agenti završe dosije.") })
		return
	}
	shown = state.report.markdown
	if (getLang() === "en") {
		body.replaceChildren(Object.assign(document.createElement("p"), { className: "empty-line", textContent: t("Prevodim izveštaj…") }))
		const caseId = state.caseId
		api.reportMd()
			.then((en) => {
				if (modal.hidden || state.caseId !== caseId || typeof en !== "string") return
				shown = en
				body.innerHTML = renderMarkdown(en)
			})
			.catch(() => !modal.hidden && (body.innerHTML = renderMarkdown(shown)))
	} else body.innerHTML = renderMarkdown(shown)
	titleEl.textContent = state.institution?.name ? `${t("Izveštaj")} · ${state.institution.name}` : t("Izveštaj")
	modal.hidden = false
	dismissToasts(".toast.done")
	document.body.classList.add("modal-open")
	modal.querySelector(".modal-scroll").scrollTop = 0
	modal.querySelector(".modal-card").focus({ preventScroll: true })
}

export function closeReport() {
	document.body.classList.remove("modal-open")
	modal.hidden = true
}

export async function downloadReport() {
	let text = state.report?.markdown || ""
	try {
		const remote = await api.reportMd()
		if (typeof remote === "string" && remote.trim()) text = remote
	} catch {}
	const blob = new Blob([text], { type: "text/markdown;charset=utf-8" })
	const a = document.createElement("a")
	a.href = URL.createObjectURL(blob)
	a.download = `dosije-${state.caseId || "izvestaj"}${getLang() === "en" ? "-en" : ""}.md`
	document.body.appendChild(a)
	a.click()
	a.remove()
	setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

async function copy() {
	const text = shown || state.report?.markdown || ""
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
	copyBtn.textContent = t("Kopirano")
	setTimeout(() => (copyBtn.textContent = t("Kopiraj")), 1800)
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
	document.getElementById("reportDownload").addEventListener("click", downloadReport)
	document.getElementById("reportPrint").addEventListener("click", print)
	copyBtn.addEventListener("click", copy)
	modal.addEventListener("mousedown", (e) => {
		if (e.target === modal) closeReport()
	})
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !modal.hidden) closeReport()
	})
}

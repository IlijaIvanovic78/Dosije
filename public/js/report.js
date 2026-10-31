// Report modal: the Markdown report as a document on screen, and its download as a PDF file.

import { renderMarkdown } from "./markdown.js"
import { state } from "./store.js"
import { toast, dismissToasts } from "./toast.js"
import { t } from "./i18n.js"
import { downloadPdf, pdfName } from "./pdf.js"

let modal, body, titleEl, pdfBtn

export function openReport() {
	if (!state.report) {
		toast({ kind: "info", title: t("Izveštaj još nije spreman"), text: t("Pojaviće se kad agenti završe dosije.") })
		return
	}
	// written in the language the case was started in
	body.innerHTML = renderMarkdown(state.report.markdown)
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

let busy = false

/** Downloads the report as a PDF. `btn` shows the work while the file is made. */
export async function downloadReport(btn = pdfBtn) {
	if (!state.report || busy) return
	busy = true
	const label = btn?.querySelector("span[data-i18n]") ?? btn
	const before = label?.textContent
	if (btn) btn.disabled = true
	if (label) label.textContent = t("Pravim PDF…")
	try {
		const text = state.report.markdown
		const name = state.institution?.name || state.input || ""
		await downloadPdf(text, { title: `${t("Dosije")} · ${name}`, footer: `${t("Dosije")} · ${name}`, fileName: pdfName(name) })
	} catch (e) {
		console.warn("pdf", e)
		toast({ kind: "error", title: t("PDF nije napravljen"), text: t("Proverite internet vezu i pokušajte ponovo. Izveštaj možete i da odštampate iz pregledača.") })
	} finally {
		busy = false
		if (btn) btn.disabled = false
		if (label && before !== undefined) label.textContent = before
	}
}

export function initReport() {
	modal = document.getElementById("reportModal")
	body = document.getElementById("reportBody")
	titleEl = document.getElementById("reportTitle")
	pdfBtn = document.getElementById("reportPdf")
	document.getElementById("reportClose").addEventListener("click", closeReport)
	pdfBtn.addEventListener("click", () => downloadReport(pdfBtn))
	modal.addEventListener("mousedown", (e) => {
		if (e.target === modal) closeReport()
	})
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !modal.hidden) closeReport()
	})
}

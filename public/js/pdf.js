// The report as a PDF file, made in the browser from the rendered report: real text (selectable, with working links), not
// a picture of the page. pdfmake is loaded from the CDN on the first download only.

import { renderMarkdown } from "./markdown.js"

const BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/"
const FILES = [
	["pdfmake.min.js", "sha512-w61kvDEdEhJPJLSAJpuL+RWp1+zTBUUpgPaP+6pcqCk78wQkOaExjnGWrVbovojeisWGQS7XZKz+gr3L+GPYLg=="],
	["vfs_fonts.min.js", "sha512-EFlschXPq/G5zunGPRSYqazR1CMKj0cQc8v6eMrQwybxgIbhsfoO5NAMQX3xFDQIbFlViv53o7Hy+yCWw6iZxA=="],
]

const INK = "#1f2528"
const MUTED = "#686e70"
const LINK = "#6f4130"
const ACCENT = "#8f5944"
const RULE = "#cdc5b6"
const PAPER = "#f4f1ea"
const WIDTH = 595.28 - 2 * 56 // A4 minus the side margins

let loading

function loadScript(src, integrity) {
	return new Promise((resolve, reject) => {
		const s = document.createElement("script")
		s.src = src
		s.integrity = integrity
		s.crossOrigin = "anonymous"
		s.referrerPolicy = "no-referrer"
		s.onload = resolve
		s.onerror = () => reject(new Error(`could not load ${src}`))
		document.head.append(s)
	})
}

/** pdfmake first, then its fonts (they register on the pdfMake global). */
function loadPdfMake() {
	loading ??= (async () => {
		for (const [file, integrity] of FILES) await loadScript(BASE + file, integrity)
		if (!window.pdfMake) throw new Error("pdfmake missing")
		return window.pdfMake
	})().catch((e) => {
		loading = undefined
		throw e
	})
	return loading
}

/** Inline text with its marks: bold, italics, links. */
function inline(node, marks = {}) {
	const out = []
	for (const n of node.childNodes) {
		if (n.nodeType === Node.TEXT_NODE) {
			if (n.textContent) out.push({ text: n.textContent, ...marks })
			continue
		}
		if (n.nodeType !== Node.ELEMENT_NODE) continue
		const tag = n.tagName
		if (tag === "BR") out.push({ text: "\n" })
		else if (tag === "STRONG" || tag === "B") out.push(...inline(n, { ...marks, bold: true }))
		else if (tag === "EM" || tag === "I") out.push(...inline(n, { ...marks, italics: true }))
		else if (tag === "DEL") out.push(...inline(n, { ...marks, decoration: "lineThrough" }))
		else if (tag === "CODE") out.push(...inline(n, { ...marks, color: MUTED }))
		else if (tag === "A") out.push(...inline(n, { ...marks, link: n.href, color: LINK, decoration: "underline" }))
		else out.push(...inline(n, marks))
	}
	return out
}

function list(n) {
	const items = [...n.children].map((li) => {
		const depth = Number(/d(\d)/.exec(li.className)?.[1] || 0)
		return { text: inline(li), margin: [depth * 14, 0, 0, 3] }
	})
	return { [n.tagName === "OL" ? "ol" : "ul"]: items, margin: [0, 0, 0, 8] }
}

function table(t) {
	const rows = [...t.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => ({ text: inline(c), bold: c.tagName === "TH", fontSize: 8.5 })))
	const cols = Math.max(1, ...rows.map((r) => r.length))
	for (const r of rows) while (r.length < cols) r.push({ text: "" })
	return { table: { headerRows: 1, widths: Array(cols).fill("*"), body: rows }, layout: "lightHorizontalLines", margin: [0, 2, 0, 10] }
}

const rule = (top = 4, bottom = 10) => ({ canvas: [{ type: "line", x1: 0, y1: 0, x2: WIDTH, y2: 0, lineWidth: 0.6, lineColor: RULE }], margin: [0, top, 0, bottom] })

function blocks(root) {
	const out = []
	for (const n of root.children) {
		const tag = n.tagName
		if (tag === "H1") out.push({ text: inline(n), style: "h1" }, { canvas: [{ type: "line", x1: 0, y1: 0, x2: WIDTH, y2: 0, lineWidth: 1.2, lineColor: INK }], margin: [0, 2, 0, 12] })
		else if (tag === "H2") out.push({ text: inline(n), style: "h2" })
		else if (/^H[3-6]$/.test(tag)) out.push({ text: inline(n), style: "h3" })
		else if (tag === "P") out.push({ text: inline(n), style: "p" })
		else if (tag === "UL" || tag === "OL") out.push(list(n))
		else if (tag === "HR") out.push(rule())
		else if (tag === "BLOCKQUOTE")
			out.push({
				table: { widths: ["*"], body: [[{ text: inline(n), margin: [8, 6, 8, 6] }]] },
				layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 2.5 : 0), vLineColor: () => ACCENT, fillColor: () => PAPER },
				margin: [0, 2, 0, 12],
			})
		else if (n.classList.contains("md-table")) {
			const t = n.querySelector("table")
			if (t) out.push(table(t))
		} else if (tag === "DIV" || tag === "SECTION") out.push({ stack: blocks(n) })
	}
	return out
}

/** A file name from the institution: "Radio televizija Srbije, Beograd" -> "dosije-radio-televizija-srbije-beograd.pdf". */
export function pdfName(name) {
	const slug = String(name || "izvestaj")
		.toLowerCase()
		.replace(/đ/g, "dj")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9а-яё]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
	return `dosije-${slug || "izvestaj"}.pdf`
}

/** Builds the PDF from the report's Markdown and starts the download. */
export async function downloadPdf(markdown, { title, footer, fileName }) {
	const pdfMake = await loadPdfMake()
	const root = document.createElement("div")
	root.innerHTML = renderMarkdown(markdown)
	const doc = {
		pageSize: "A4",
		pageMargins: [56, 56, 56, 64],
		info: { title, creator: "Dosije" },
		content: blocks(root),
		defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.3, color: INK },
		styles: {
			h1: { fontSize: 19, bold: true, lineHeight: 1.15 },
			h2: { fontSize: 13.5, bold: true, margin: [0, 14, 0, 6] },
			h3: { fontSize: 11, bold: true, margin: [0, 9, 0, 3] },
			p: { margin: [0, 0, 0, 7] },
		},
		footer: (page, pages) => ({
			columns: [
				{ text: footer, color: MUTED, fontSize: 8 },
				{ text: `${page} / ${pages}`, alignment: "right", color: MUTED, fontSize: 8 },
			],
			margin: [56, 26, 56, 0],
		}),
	}
	await new Promise((resolve) => pdfMake.createPdf(doc).download(fileName, resolve))
}

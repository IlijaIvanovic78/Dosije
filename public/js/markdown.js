// Small Markdown renderer. Everything is HTML-escaped FIRST; only then are our
// own tags produced, so untrusted text can never inject markup.

import { esc } from "./format.js"

function inline(raw) {
	let t = esc(raw)
	const codes = []
	t = t.replace(/`([^`]+)`/g, (_, c) => {
		codes.push(c)
		return `\u0000${codes.length - 1}\u0000`
	})
	t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`)
	t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
	t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
	t = t.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
	t = t.replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>")
	t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>")
	return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`)
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const splitRow = (l) =>
	l
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim())

export function renderMarkdown(src) {
	const lines = String(src ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
	const out = []
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		if (!line.trim()) {
			i++
			continue
		}
		const fence = line.match(/^```(\w*)/)
		if (fence) {
			const buf = []
			i++
			while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
			i++
			out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`)
			continue
		}
		const hd = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
		if (hd) {
			const n = hd[1].length
			out.push(`<h${n}>${inline(hd[2])}</h${n}>`)
			i++
			continue
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push("<hr>")
			i++
			continue
		}
		if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
			const head = splitRow(line)
			i += 2
			const body = []
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) body.push(splitRow(lines[i++]))
			out.push(
				`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
					.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
					.join("")}</tbody></table></div>`,
			)
			continue
		}
		if (/^\s*>\s?/.test(line)) {
			const buf = []
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""))
			out.push(`<blockquote>${buf.map(inline).join("<br>")}</blockquote>`)
			continue
		}
		const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
		if (li) {
			const ordered = /\d/.test(li[2])
			const items = []
			while (i < lines.length) {
				const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
				if (!m) {
					// continuation line of the previous item
					if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
						items[items.length - 1].text += ` ${lines[i].trim()}`
						i++
						continue
					}
					break
				}
				items.push({ depth: Math.min(2, Math.floor(m[1].length / 2)), text: m[3] })
				i++
			}
			out.push(renderList(items, ordered))
			continue
		}
		const buf = []
		while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes("|") && isTableSep(lines[i + 1] ?? ""))) buf.push(lines[i++])
		out.push(`<p>${buf.map((l) => inline(l.trim())).join("<br>")}</p>`)
	}
	return out.join("\n")
}

function renderList(items, ordered) {
	const tag = ordered ? "ol" : "ul"
	return `<${tag}>${items.map((it) => `<li class="d${it.depth}">${inline(it.text)}</li>`).join("")}</${tag}>`
}

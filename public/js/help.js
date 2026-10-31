// The guide behind the "?" in the top bar (how Dosije works, how to read a dossier) and the rotating strip of sources on
// the start screen.

let modal, opener

function openHelp() {
	opener = document.activeElement
	modal.hidden = false
	document.body.classList.add("modal-open")
	modal.querySelector(".help-scroll").scrollTop = 0
	modal.querySelector(".help-card").focus({ preventScroll: true })
}

function closeHelp() {
	if (modal.hidden) return
	modal.hidden = true
	document.body.classList.remove("modal-open")
	opener?.focus?.({ preventScroll: true })
}

export function initHelp() {
	modal = document.getElementById("helpModal")
	document.getElementById("btnHelp").addEventListener("click", openHelp)
	document.getElementById("helpClose").addEventListener("click", closeHelp)
	modal.addEventListener("mousedown", (e) => {
		if (e.target === modal) closeHelp()
	})
	modal.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeHelp()
		// keep Tab inside the dialog
		if (e.key !== "Tab") return
		const focusable = [...modal.querySelectorAll("button, a[href]")]
		const first = focusable[0]
		const last = focusable.at(-1)
		if (e.shiftKey && (document.activeElement === first || document.activeElement === modal.querySelector(".help-card"))) {
			e.preventDefault()
			last.focus()
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault()
			first.focus()
		}
	})
}

/** The source cards run in a loop: the list is shown twice in a row (the copy is hidden from screen readers). */
export function initSources() {
	const track = document.getElementById("srcTrack")
	for (const li of [...track.children]) {
		const copy = li.cloneNode(true)
		copy.setAttribute("aria-hidden", "true")
		copy.classList.add("dup")
		track.appendChild(copy)
	}
}

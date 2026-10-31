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

const PHONE = window.matchMedia("(max-width: 860px)")
const STILL = window.matchMedia("(prefers-reduced-motion: reduce)")
const STEP_MS = 2200
const AFTER_TOUCH_MS = 4000

/**
 * The source cards run in a loop: the list is shown twice in a row (the copy is hidden from screen readers). On a phone
 * the strip is a row to swipe instead (styles.css), and it moves on by one card every couple of seconds; a swipe holds
 * it for a moment, and it waits while it is off screen.
 */
export function initSources() {
	const track = document.getElementById("srcTrack")
	for (const li of [...track.children]) {
		const copy = li.cloneNode(true)
		copy.setAttribute("aria-hidden", "true")
		copy.classList.add("dup")
		track.appendChild(copy)
	}

	const strip = track.parentElement
	let heldUntil = 0
	for (const ev of ["pointerdown", "touchstart", "wheel"]) strip.addEventListener(ev, () => (heldUntil = Date.now() + AFTER_TOUCH_MS), { passive: true })
	const onScreen = () => {
		const r = strip.getBoundingClientRect()
		return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight
	}
	setInterval(() => {
		if (!PHONE.matches || STILL.matches || document.hidden || Date.now() < heldUntil || !onScreen()) return
		const card = track.querySelector(".src-card")
		const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4
		if (atEnd) strip.scrollTo({ left: 0, behavior: "smooth" })
		else strip.scrollBy({ left: card.offsetWidth + (parseFloat(getComputedStyle(track).columnGap) || 0), behavior: "smooth" })
	}, STEP_MS)
}

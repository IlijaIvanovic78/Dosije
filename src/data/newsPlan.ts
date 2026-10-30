// One place that decides HOW the media are searched for an institution or a person, so the agents' tool, the cache warmer and
// the QA script build identical queries (the cache key is made of them). Aliases and exclusions come from
// data/static/news-aliases.json plus the institution table (a longer institution name that contains this one is excluded).

import fs from "node:fs"
import path from "node:path"
import { searchName } from "./names"
import { nameTokens } from "./newsMatch"
import type { NewsSearchOptions } from "./sources/news"

interface InstitutionLike {
	slug?: string
	name: string
	shortName?: string
}

interface Extra {
	aliases?: string[]
	exclude?: string[]
}

const STATIC_DIR = path.resolve(process.cwd(), "data", "static")

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(path.join(STATIC_DIR, file), "utf8")) as T
	} catch {
		return fallback
	}
}

let extra: Record<string, Extra> | undefined
let table: { slug: string; name: string }[] | undefined

const extras = () => (extra ??= readJson<Record<string, Extra>>("news-aliases.json", {}))
const known = () => (table ??= readJson<{ slug: string; name: string }[]>("institutions.json", []))
const unique = (list: (string | undefined)[]): string[] => [...new Set(list.filter((x): x is string => !!x && x.trim().length > 0).map((x) => x.trim()))]

const sameTokens = (a: string[], b: string[]) => a.length === b.length && a.every((t) => b.includes(t))

export function institutionNames(inst: InstitutionLike): { query: string; aliases: string[]; exclude: string[] } {
	const query = searchName(inst.name)
	const own = nameTokens(query)
	// the slug is optional: a bare name finds the known institution with the same distinctive tokens
	const slug = inst.slug ?? known().find((k) => sameTokens(nameTokens(searchName(k.name)), own))?.slug
	const e = slug ? (extras()[slug] ?? {}) : {}
	inst = { ...inst, slug }
	// another known institution whose distinctive tokens include all of ours is a longer name for something else
	const longer = known()
		.filter((k) => k.slug !== inst.slug)
		.map((k) => searchName(k.name))
		.filter((n) => {
			const t = nameTokens(n)
			return t.length > own.length && own.every((x) => t.includes(x))
		})
	return {
		query,
		aliases: unique([inst.shortName, ...(e.aliases ?? [])]).filter((a) => a.toLowerCase() !== query.toLowerCase()),
		exclude: unique([...(e.exclude ?? []), ...longer]),
	}
}

/** Media search for the institution itself (default: the last 12 months). */
export function institutionNewsPlan(inst: InstitutionLike, days = 365, limit = 60): { query: string; opts: NewsSearchOptions } {
	const n = institutionNames(inst)
	return { query: n.query, opts: { days, limit, kind: "institution", aliases: n.aliases, exclude: n.exclude } }
}

/** Media search for a person: only articles that name the person together with the institution (or a firm) count. */
export function personNewsPlan(person: string, inst: InstitutionLike, firms: string[] = [], days = 730, limit = 40): { query: string; opts: NewsSearchOptions } {
	const n = institutionNames(inst)
	return { query: person.trim(), opts: { days, limit, kind: "person", context: unique([...firms, n.query, ...n.aliases]), exclude: n.exclude } }
}

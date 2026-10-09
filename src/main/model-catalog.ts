import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the two BUILT-IN seats actually offer, discovered from the harnesses
 * themselves instead of a hand-maintained list in `providers.ts`.
 *
 * A curated array goes stale silently and invisibly: the picker kept advertising
 * "GPT-5 Codex" and "GPT-5" long after the Codex CLI had moved to the GPT-5.6
 * family, so every user's first act was to pick a model that no longer exists.
 * The two harnesses can both be ASKED — `codex debug models` prints its whole
 * model table as JSON, and the Claude Agent SDK's `Query.supportedModels()`
 * returns the same list the `/model` menu shows — so this module holds the pure
 * half of doing that: the parsers, plus a TTL cache over the file the service's
 * provider owner persists.
 *
 * Pure on purpose (the `codex-retry.ts` / `providers-store.ts` pattern): NO
 * electron import, an injected `baseDir` and an injected clock, so the whole
 * thing unit-tests in the bun tier (test/model-catalog.mjs). The impure parts sit
 * around it — the provider owner runs the CLI probe (`ProviderData.swift`) and writes
 * the cache, `providers.ts` resolves
 * the data dir, schedules the refresh and assembles `ModelChoice[]`, and
 * `backends/claude.ts` feeds the Claude side through `recordClaudeModels` once a
 * live query exists.
 *
 * NOTHING here throws. A model list is a nicety; a parse failure, a refused
 * write or a hand-mangled cache file must degrade to "we don't know yet"
 * (→ the caller's last-resort curated list), never break the picker or a turn.
 */

/** One offerable model: the id handed to the backend + what the picker shows. */
export interface CatalogModel {
  id: string
  label: string
}

/** The two built-in seats. User connections are NOT cached here — their catalog
 *  comes from the connection's own `/models` probe and lives in providers.json. */
export type CatalogBackend = 'claude' | 'codex'

/**
 * How long a discovered list is trusted before a background refresh is due.
 *
 * One day (LKM-164): a new model shows up the day after it ships, without a
 * reinstall, and no CLI is spawned or list rewritten more than once a day.
 * Staleness never HIDES the cached list (see `ModelCatalog.get`) — it only asks
 * the caller to refresh behind it, so the TTL costs the user nothing when it
 * expires at an awkward moment. A bundled SDK/CLI bump does hide it: see `harness`.
 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

/** Well past anything this writes (two lists of ~10 short strings). A bigger
 *  file isn't a big cache, it's a corrupt one. */
const MAX_CACHE_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// Parsers — both take UNTRUSTED input (a CLI's stdout, an SDK's loosely-typed
// payload) and must never throw or let junk through to the picker.
// ---------------------------------------------------------------------------

/**
 * Models out of `codex debug models` — `{"models":[{slug, display_name,
 * visibility, priority, …}]}`.
 *
 * Two things matter beyond shape-tolerance:
 *
 *  - **`visibility` is a hard filter.** The table carries entries the CLI itself
 *    never lists: `gpt-5.6-sol-wm` and `codex-auto-review` are `"hide"`, i.e.
 *    internal/derived seats a user cannot pick in `codex` either. Offering them
 *    would put models in the picker that fail (or behave strangely) at turn time.
 *    Only `"list"` is admitted — an unknown future value is treated as hidden,
 *    because listing something the CLI has deliberately marked non-listable is
 *    the worse failure.
 *  - **`priority` is the CLI's own ranking** (1 = the flagship). Today it happens
 *    to match array order, but the field is the contract and the array order
 *    isn't, so sort by it and use the original index only to break ties.
 *
 * The payload is ~300KB (every entry embeds its full `base_instructions`), so it
 * is parsed and thrown away — never logged, never cached whole.
 */
export function parseCodexModels(json: unknown): CatalogModel[] {
  const raw = (json as { models?: unknown } | null)?.models
  if (!Array.isArray(raw)) return []
  const ranked: Array<{ model: CatalogModel; priority: number; index: number }> = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as {
      slug?: unknown
      display_name?: unknown
      visibility?: unknown
      priority?: unknown
    }
    if (e.visibility !== 'list') continue
    const id = typeof e.slug === 'string' ? e.slug.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const display = typeof e.display_name === 'string' ? e.display_name.trim() : ''
    ranked.push({
      model: { id, label: display || id },
      // A missing/NaN priority sorts last rather than first — an entry the CLI
      // didn't rank should not outrank the flagship it did.
      priority: typeof e.priority === 'number' && Number.isFinite(e.priority) ? e.priority : 1e9,
      index
    })
  }
  ranked.sort((a, b) => a.priority - b.priority || a.index - b.index)
  return ranked.map((r) => r.model)
}

/**
 * Models out of the Claude Agent SDK's `Query.supportedModels()` — `ModelInfo[]`
 * (`{value, displayName, description, …}`). Also accepts `{models: […]}` so a
 * future SDK that wraps the array doesn't silently empty the catalog.
 *
 * Order is preserved: the SDK returns them already ranked the way the `/model`
 * menu shows them, and there's no priority field to re-derive that from.
 *
 * Note the SDK's list LEADS with its own `{value: 'default'}` sentinel — the
 * exact string trezi uses for "omit the model, use the account default". It is
 * kept here (this module reports what the harness said) and dropped by the
 * caller, which prepends its own sentinel; see `providers.ts#builtinChoices`.
 */
export function parseClaudeModels(json: unknown): CatalogModel[] {
  const raw = Array.isArray(json) ? json : (json as { models?: unknown } | null)?.models
  if (!Array.isArray(raw)) return []
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { value?: unknown; displayName?: unknown }
    const id = typeof e.value === 'string' ? e.value.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const display = typeof e.displayName === 'string' ? e.displayName.trim() : ''
    out.push({ id, label: display || id })
  }
  return out
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

export interface ModelCatalog {
  /**
   * The cached list for a backend, or null when we've never discovered one.
   *
   * Deliberately returns a STALE list too: an expired entry is still a far
   * better answer than the curated fallback, and the picker must render now.
   * Pair it with `isStale` to decide whether to also refresh behind the render.
   */
  get: (backend: CatalogBackend) => CatalogModel[] | null
  /** True when there's no entry, or it has aged past the TTL — i.e. the caller
   *  should kick off a (background) refresh. */
  isStale: (backend: CatalogBackend) => boolean
  /**
   * Record a freshly discovered list and persist it. An EMPTY list is ignored:
   * a failed probe (CLI missing, a query that died before answering) must not
   * overwrite a good cached list with nothing, nor start a TTL on a non-answer.
   */
  set: (backend: CatalogBackend, models: CatalogModel[]) => void
}

interface CacheEntry {
  at: number
  models: CatalogModel[]
  /** The bundled harness that produced the list (`harnessStamp`); absent before LKM-164. */
  harness?: string
}

interface CacheFile {
  version: 1
  entries: Partial<Record<CatalogBackend, CacheEntry>>
}

const BACKENDS: CatalogBackend[] = ['claude', 'codex']

/** The bundled packages that decide what a seat's model ids mean: the SDK and the CLI
 *  it runs (the Claude CLI ships inside its SDK at the same version). */
export const HARNESS_PACKAGES: Record<CatalogBackend, string[]> = {
  claude: ['@anthropic-ai/claude-agent-sdk'],
  codex: ['@openai/codex-sdk', '@openai/codex']
}

/** `pkg@version` for each of a seat's harness packages that `version` knows; '' when none. */
export function harnessStamp(
  backend: CatalogBackend,
  version: (pkg: string) => string | null | undefined
): string {
  return HARNESS_PACKAGES[backend]
    .map((pkg) => {
      const v = version(pkg)
      return v ? `${pkg}@${v}` : ''
    })
    .filter(Boolean)
    .join(' ')
}

/** A package's version from `<root>/node_modules`, read directly: both SDKs' `exports`
 *  hide `package.json` from `require.resolve`. Null when it is missing or unreadable. */
export function installedVersion(root: string, pkg: string): string | null {
  try {
    const { version } = JSON.parse(
      readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')
    ) as { version?: unknown }
    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  }
}

/**
 * A TTL cache over `<baseDir>/model-catalog.json`.
 *
 * The disk half is what makes a fresh launch honest. Claude's list can only be
 * read off a LIVE query, and Codex's needs a ~1s subprocess — so with an
 * in-memory-only cache every cold start would show the curated fallback until
 * the user happened to open a session. Persisting means a user sees real models
 * from the second launch onward, whatever they do first.
 *
 * `now` is injected so the TTL is testable without sleeping; `baseDir` is
 * injected so this module never asks electron for a path (see the file header).
 */
export function createModelCatalog(opts: {
  baseDir: string
  now?: () => number
  ttlMs?: number
  /**
   * The bundled SDK/CLI versions per backend (`harnessStamp`). A cached list from a
   * different harness is no list at all (LKM-164): the old CLI resolved aliases like
   * `opus` to older models, and its list can name models the new one dropped. '' (or
   * no option) means unknown, and then any entry is accepted.
   */
  harness?: (backend: CatalogBackend) => string
  /** The file's writer: the Swift provider owner (the only one since LKM-111). False
   *  when it could not take the write; the list then lives in memory for this run. */
  persist: (backend: CatalogBackend, models: CatalogModel[], harness?: string) => boolean
}): ModelCatalog {
  const file = join(opts.baseDir, 'model-catalog.json')
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? CATALOG_TTL_MS
  const harness = (backend: CatalogBackend): string => {
    try {
      return opts.harness?.(backend) ?? ''
    } catch {
      return ''
    }
  }
  const current = (backend: CatalogBackend, entry: CacheEntry | undefined) => {
    const stamp = harness(backend)
    return entry && (!stamp || entry.harness === stamp) ? entry : undefined
  }

  // Read-through, once. Only this app run writes this file (itself, or through
  // `persist` the Swift owner it hands each list to), so re-reading it on every
  // `choices()` call would be pure syscall tax on the picker's hot path.
  let entries: Partial<Record<CatalogBackend, CacheEntry>> | null = null

  const isEntry = (v: unknown): v is CacheEntry => {
    const e = v as CacheEntry | null
    return (
      !!e &&
      typeof e.at === 'number' &&
      Number.isFinite(e.at) &&
      (e.harness === undefined || typeof e.harness === 'string') &&
      Array.isArray(e.models) &&
      e.models.every(
        (m) =>
          !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.label === 'string'
      )
    )
  }

  /** Any unreadable/unparseable/mis-shaped file reads as "no cache". Unlike
   *  providers.json there is nothing to preserve here — every value is
   *  re-derivable from the harness, so the owner simply overwrites the corrupt
   *  file on the next successful discovery. */
  const load = (): Partial<Record<CatalogBackend, CacheEntry>> => {
    if (entries) return entries
    entries = {}
    try {
      const rawText = readFileSync(file, 'utf8')
      if (rawText.length > MAX_CACHE_BYTES) return entries
      const parsed = JSON.parse(rawText) as CacheFile | null
      const found = parsed?.entries
      if (!found || typeof found !== 'object') return entries
      for (const backend of BACKENDS) {
        const entry = (found as Record<string, unknown>)[backend]
        // Per-backend validation: one mangled half must not cost the other.
        if (isEntry(entry) && entry.models.length) entries[backend] = entry
      }
    } catch {
      /* not created yet, unreadable, or not JSON — all mean "no cache" */
    }
    return entries
  }

  const get = (backend: CatalogBackend): CatalogModel[] | null =>
    current(backend, load()[backend])?.models ?? null

  const isStale = (backend: CatalogBackend): boolean => {
    const entry = current(backend, load()[backend])
    if (!entry) return true
    const age = now() - entry.at
    // A negative age means the clock moved backwards (a DST/NTP correction, or a
    // cache file copied from another machine) — treat it as stale rather than
    // letting a future timestamp pin the entry as fresh forever.
    return age < 0 || age > ttlMs
  }

  const set = (backend: CatalogBackend, models: CatalogModel[]): void => {
    if (!models.length) return
    const stamp = harness(backend)
    load()[backend] = { at: now(), models, ...(stamp ? { harness: stamp } : {}) }
    // A refused write costs persistence, not correctness: the in-memory entry above
    // still serves this whole app run.
    opts.persist(backend, models, stamp || undefined)
  }

  return { get, isStale, set }
}

// ---------------------------------------------------------------------------
// The app's one catalog
// ---------------------------------------------------------------------------

/**
 * `providers.ts` owns the app's catalog (it's the one that knows the data dir),
 * but the CLAUDE half can only be discovered from inside a live session — in
 * `backends/claude.ts`. Rather than have that backend import electron-tainted
 * `providers.ts` (and close an import cycle: `providers.ts` is already imported
 * by `backends/codex.ts`), providers.ts INSTALLS its catalog here and the
 * backend hands its findings back through `recordClaudeModels`.
 */
let shared: ModelCatalog | null = null

/** Install the app's catalog. Called once, from `registerProviderIpc`. (Not
 *  named `use…` — biome's rules-of-hooks lint reads that prefix as a React hook
 *  and rejects the call site.) */
export function setModelCatalog(catalog: ModelCatalog): void {
  shared = catalog
}

/**
 * Fire-and-forget from `backends/claude.ts` with the result of
 * `Query.supportedModels()`. Never throws and never blocks: a session must not
 * fail, stall, or log because a dropdown wanted fresher labels. A no-op before
 * `useModelCatalog` has run (a session that somehow starts before the IPC is
 * registered), for an empty/unparseable payload, and while the cached list is
 * fresh: every session answers, but the list is rewritten at most once a day, or
 * at once after an SDK bump (LKM-164).
 */
export function recordClaudeModels(raw: unknown): void {
  try {
    if (!shared?.isStale('claude')) return
    const models = parseClaudeModels(raw)
    if (models.length) shared.set('claude', models)
  } catch {
    /* see above — a catalog is never worth disturbing a session for */
  }
}

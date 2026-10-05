import { readFile, stat } from 'fs/promises'
import { isAbsolute, join, normalize } from 'path'
import { ipcMain, views } from '../native/platform'
import type {
  ControlPanelManifest,
  ResolvedControlPanel,
  ResolvedControlParam,
  StyleEditResult
} from '../shared/api'
import {
  lexLiteral,
  locateAnchor,
  partitionStoreEntries,
  renderLiteral,
  resolveLiteralValue,
  upsertPanel,
  validateManifest
} from './control-manifest'
import { editingOwner } from './editing-owner'
import { commitEdit, withinRoot } from './props'
import { contentHash } from './source-owner'

/**
 * Custom-control panel store + literal apply (v10 Custom Controls). Manifests
 * live in `<repo>/.trezi/control-panels.json` — the same sidecar directory as
 * annotations.json. All mutations are serialized through a promise chain and
 * committed by the editing owner (S12: the Swift service, hash-bound, in the
 * repository lane) as the SOLE writer (the agent is denied `.trezi/` writes). The file on disk is user-editable and
 * therefore untrusted: every load re-runs each panel through validateManifest,
 * keeping entries that fail (or exceed the panel cap, or duplicate an id) OUT
 * of resolution but PRESERVED verbatim across rewrites — a hand-edit typo in
 * one panel must never be erased by an unrelated save. Every file path read
 * from the store is re-checked for root containment before any fs access.
 */

interface ControlStore {
  version: 1
  /** Validated manifests first, then preserved raw entries (re-partitioned on
   *  every load — see partitionStoreEntries). */
  panels: unknown[]
}

interface LoadedStore {
  panels: ControlPanelManifest[]
  /** Raw entries kept out of resolution but written back on every mutation. */
  preserved: unknown[]
  /** False when a store FILE exists but can't be loaded as one (bad JSON,
   *  wrong shape, oversized) — mutations refuse rather than clobber it. */
  writable: boolean
  /** SHA-256 of the bytes read (null: no store file). A write is bound to it. */
  hash: string | null
}

const dir = (root: string): string => join(root, '.trezi')
const file = (root: string): string => join(dir(root), 'control-panels.json')

// Well past any store main itself writes (20 panels × 32KB manifests plus
// preserved entries carried over) — a bigger file is corrupt, not merely big;
// don't JSON.parse it on every controls IPC call.
const MAX_STORE_BYTES = 1024 * 1024

/** Resolve a manifest's repo-relative file against root, refusing escapes —
 *  the props.ts resolveSource/withinRoot containment pattern. */
function resolveRepoFile(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null
  const abs = normalize(join(root, rel))
  return withinRoot(root, abs) ? abs : null
}

/** Load + re-validate the store. Missing file → empty writable store; a file
 *  that isn't loadable AS a store (bad JSON / wrong shape / oversized) → empty
 *  and NOT writable, so a mutation can't clobber what a hand-edit broke.
 *  Loadable entries are partitioned: valid panels resolve (validateManifest
 *  rebuilds each from known fields — nothing from disk is returned as-is);
 *  everything else is preserved verbatim for the next write. */
async function readStore(root: string): Promise<LoadedStore> {
  let size: number
  try {
    size = (await stat(file(root))).size
  } catch {
    return { panels: [], preserved: [], writable: true, hash: null } // no store yet
  }
  const corrupt: LoadedStore = { panels: [], preserved: [], writable: false, hash: null }
  if (size > MAX_STORE_BYTES) return corrupt
  let parsed: unknown, hash: string
  try {
    const bytes = await readFile(file(root))
    hash = contentHash(bytes)
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return corrupt
  }
  const raw = (parsed as { panels?: unknown } | null)?.panels
  if (!Array.isArray(raw)) return corrupt
  return { ...partitionStoreEntries(raw), writable: true, hash }
}

/** The editing owner (S12) commits the store atomically, only if the file still
 *  holds the bytes `readStore` read — a hand edit in between is refused, never
 *  overwritten. Preserved entries ride along after the validated panels, verbatim. */
async function writeStore(
  root: string,
  panels: ControlPanelManifest[],
  preserved: unknown[],
  hash: string | null
): Promise<void> {
  const store: ControlStore = { version: 1, panels: [...panels, ...preserved] }
  const result = await editingOwner().sidecar(
    root,
    'control-panels.json',
    hash,
    JSON.stringify(store, null, 2) + '\n'
  )
  if (!result.ok)
    throw new Error(
      '.trezi/control-panels.json changed while saving; nothing was written. Try again.'
    )
}

// Main is the only writer, but two IPC calls can interleave at their awaits.
// Serialize all mutations through a promise chain so read-modify-write is atomic.
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.catch(() => undefined)
  return run
}

/**
 * Validate + persist a manifest (the `define_controls` callback and any future
 * save path both land here). Upserts by (file, component): regenerating a
 * panel for the same component REPLACES it in place — never duplicates. At the
 * 20-panel cap with no upsert slot the save is REJECTED with an error (no
 * silent eviction). Returns the saved manifest or `{ error }`.
 */
export function saveManifest(
  root: string,
  input: unknown
): Promise<ControlPanelManifest | { error: string }> {
  return serialize(async () => {
    const manifest = validateManifest(input)
    if ('error' in manifest) return manifest
    if (!resolveRepoFile(root, manifest.file)) return { error: 'file escapes the project root' }
    const store = await readStore(root)
    if (!store.writable)
      return { error: '.trezi/control-panels.json is not a valid store — fix or delete it first' }
    const next = upsertPanel(store.panels, manifest)
    if ('error' in next) return next
    await writeStore(root, next, store.preserved, store.hash)
    return manifest
  })
}

export function removePanel(root: string, id: string): Promise<ControlPanelManifest[]> {
  return serialize(async () => {
    const store = await readStore(root)
    const next = store.panels.filter((p) => p.id !== id)
    if (store.writable && next.length !== store.panels.length)
      await writeStore(root, next, store.preserved, store.hash)
    return next
  })
}

export async function listPanels(root: string): Promise<ControlPanelManifest[]> {
  return (await readStore(root)).panels
}

/**
 * Panels matching the current selection, values freshly resolved against the
 * LIVE tree (manifests store no values — see control-manifest.ts). `files` is
 * the selection's candidate repo-relative files (the two-stamp match: the
 * element's own source file and its `componentSource` file), `component` the
 * inspected component name; panels whose component matches sort first.
 */
export async function resolvePanels(
  root: string,
  files: string[],
  component?: string
): Promise<ResolvedControlPanel[]> {
  const panels = (await readStore(root)).panels.filter((p) => files.includes(p.file))
  panels.sort((a, b) => Number(b.component === component) - Number(a.component === component))
  const cache = new Map<string, string | null>()
  const readSource = async (rel: string): Promise<string | null> => {
    if (!cache.has(rel)) {
      const abs = resolveRepoFile(root, rel)
      cache.set(rel, abs ? await readFile(abs, 'utf8').catch(() => null) : null)
    }
    return cache.get(rel) ?? null
  }
  const resolved: ResolvedControlPanel[] = []
  for (const manifest of panels) {
    const code = await readSource(manifest.file)
    const params: ResolvedControlParam[] = manifest.params.map((param) => {
      if (param.apply.strategy === 'literal') {
        if (code == null) return { ...param, value: null, valid: false, reason: 'file missing' }
        const loc = locateAnchor(code, param.apply.anchor)
        if ('error' in loc) {
          const reason = loc.error === 'missing' ? 'anchor not found' : 'anchor ambiguous'
          return { ...param, value: null, valid: false, reason }
        }
        const value = resolveLiteralValue(code, param)
        if (value == null)
          return { ...param, value: null, valid: false, reason: 'literal not found' }
        return { ...param, value, valid: true }
      }
      // 'prop' — the island resolves the current value itself via its existing
      // props:inspect flow (the inspection also proves the prop still exists);
      // 'style' — resolved island-side from the live element.styles snapshot.
      // Both are valid-by-default here: their targets are checked at apply time.
      return { ...param, value: null, valid: true }
    })
    resolved.push({ manifest, params })
  }
  return resolved
}

/** A bezier value may arrive as `cubic-bezier(a, b, c, d)` text (the island's
 *  canonical readout shape) — coerce to the 4-number array renderLiteral wants. */
function coerceBezier(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const nums = value.match(/-?\d*\.?\d+/g)?.map(Number)
  return nums && nums.length === 4 ? nums : value
}

/**
 * Apply a value to a literal-strategy param: re-read the file FRESH, re-enforce
 * anchor-exactly-once (a stale anchor refuses — never a wrong-site splice), lex
 * the current literal, and splice a main-rendered replacement (clamped/
 * validated — supplied values are never spliced raw). Returns StyleEditResult's
 * `{ applied, error? }` shape (commitEdit's PropEditResult is the same shape;
 * the literal path has no strategy/needsAgent variants).
 */
export async function applyLiteral(
  root: string,
  panelId: string,
  paramId: string,
  value: unknown
): Promise<StyleEditResult> {
  const panel = (await readStore(root)).panels.find((p) => p.id === panelId)
  if (!panel) return { applied: false, error: 'Panel not found.' }
  const param = panel.params.find((p) => p.id === paramId)
  if (!param) return { applied: false, error: 'Param not found.' }
  if (param.apply.strategy !== 'literal')
    return { applied: false, error: 'Param is not a literal control.' }
  const abs = resolveRepoFile(root, panel.file)
  if (!abs) return { applied: false, error: 'File escapes the project root.' }
  let code: string
  try {
    code = await readFile(abs, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }
  const loc = locateAnchor(code, param.apply.anchor)
  if ('error' in loc) {
    const which = loc.error === 'missing' ? 'not found' : 'ambiguous'
    return { applied: false, error: `Anchor ${which} — regenerate the panel.` }
  }
  const lit = lexLiteral(code, loc.at, param.kind)
  if (!lit)
    return { applied: false, error: 'Literal not found after anchor — regenerate the panel.' }
  const shape = lit.raw.startsWith('[') ? 'array' : 'string'
  const rendered = renderLiteral(
    param.kind,
    param.kind === 'bezier' ? coerceBezier(value) : value,
    param,
    shape
  )
  if (typeof rendered !== 'string') return { applied: false, error: rendered.error }
  const after = code.slice(0, lit.start) + rendered + code.slice(lit.end)
  return commitEdit(root, abs, code, after, `control:${panelId}:${paramId}`)
}

export function registerControlsIpc(): void {
  ipcMain.handle(
    'controls:get',
    (_e, root: string, opts: { files: string[]; component?: string }) =>
      resolvePanels(root, Array.isArray(opts?.files) ? opts.files : [], opts?.component)
  )
  ipcMain.handle('controls:list', (_e, root: string) => listPanels(root))
  ipcMain.handle('controls:remove', async (_e, root: string, id: string) => {
    const panels = await removePanel(root, id)
    // Tell the renderer to re-resolve. Without this the island only hides the
    // panel locally, so main's cached panel state and the renderer's fetched
    // list both keep the deleted panel — it would come back on the next island
    // reload and could still be picked as a Regenerate target.
    for (const w of [...views.values()].filter((view) => view.id !== 'preview'))
      if (!w.webContents.isDestroyed()) w.webContents.send('controls:updated', { root })
    return panels
  })
  ipcMain.handle(
    'controls:apply-literal',
    (_e, root: string, panelId: string, paramId: string, value: unknown) =>
      applyLiteral(root, panelId, paramId, value)
  )
}

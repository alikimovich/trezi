/**
 * Inspector Custom tab requests (LKM-323). PURE — no fs, no IPC — so the whole flow is
 * unit-testable (test/control-requests.mjs). The user asks for controls in plain text;
 * the agent answers with one fenced `trezi-controls` block naming the request, and
 * this module turns that UNTRUSTED answer into the panel to save: a new panel, the next
 * revision of a commented panel, or one commented control replaced in place with every
 * other control kept. Every result still goes through validateManifest; the literal
 * anchors are checked against the live file by control-panels.ts.
 */
import type { ControlPanelManifest, ControlParam } from '../shared/api'
import { oneLine } from '../shared/selection-context'
import { locateAnchor, MAX_PANELS, resolveLiteralValue, validateManifest } from './control-manifest'

export const CONTROLS_FENCE = 'trezi-controls'

/** What a request revises: nothing (a new panel), a whole panel, or one of its controls. */
export interface ControlsTarget {
  panel: ControlPanelManifest
  param?: string
}

/** The manifest the answer's `trezi-controls` block carries for `request`, or why there is none.
 *  The agent may decline with `{"request": …, "error": "…"}`; its reason is shown as one line. */
export function parseControlsAnswer(
  text: string,
  request: string
): { manifest: unknown } | { error: string } {
  const fences = [...text.matchAll(/```trezi-controls[^\S\n]*\n([\s\S]*?)```/g)]
  if (!fences.length) return { error: 'The agent answered without a control panel.' }
  for (const fence of fences.reverse()) {
    let parsed: any
    try {
      parsed = JSON.parse(fence[1])
    } catch {
      continue
    }
    if (parsed?.request !== request) continue
    if (typeof parsed.error === 'string' && parsed.error.trim())
      return { error: `The agent could not make these controls: ${oneLine(parsed.error, 300)}` }
    if (parsed.manifest === undefined) return { error: 'The answer has no control panel.' }
    return { manifest: parsed.manifest }
  }
  return { error: 'The control panel in the answer could not be read.' }
}

/** A readable, store-unique panel id from its title (`corner-radius`, `corner-radius-2`). */
export function panelId(title: unknown, taken: string[]): string {
  const base =
    (typeof title === 'string' ? title : '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'controls'
  let id = base,
    n = 2
  while (taken.includes(id)) id = `${base}-${n++}`
  return id
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v != null && !Array.isArray(v)

/**
 * The panel an answer saves. `files` are the selected element's repo-relative files (its
 * own source and its owning component's): a new or revised panel must live in one of them.
 * A comment on a panel keeps its id and creation time and adds a revision; a comment on a
 * control takes only that control from the answer (by id, or the answer's single new
 * control) and keeps every other control exactly as it was.
 */
export function requestedPanel(
  raw: unknown,
  files: string[],
  taken: string[],
  target?: ControlsTarget,
  now = new Date().toISOString()
): ControlPanelManifest | { error: string } {
  if (!isObject(raw)) return { error: 'The answer has no control panel.' }
  const old = target?.panel
  let next: Record<string, unknown>
  if (!old) next = { ...raw, id: panelId(raw.title, taken), createdAt: now, revision: 1 }
  else if (target.param === undefined)
    next = {
      ...raw,
      id: old.id,
      createdAt: old.createdAt,
      revision: (old.revision ?? 1) + 1,
      presentation: old.presentation,
      replay: old.replay
    }
  else {
    const param = old.params.find((p) => p.id === target.param)
    if (!param) return { error: 'This control was removed meanwhile.' }
    if (raw.file !== undefined && raw.file !== old.file)
      return { error: `A control stays in its panel's file (${old.file}).` }
    const params = Array.isArray(raw.params) ? raw.params.filter(isObject) : []
    const fresh = params.filter((p) => !old.params.some((o) => o.id === p.id))
    const revised = params.find((p) => p.id === param.id) ?? (fresh.length === 1 ? fresh[0] : null)
    if (!revised) return { error: `The answer did not change “${param.label}”.` }
    next = {
      ...old,
      revision: (old.revision ?? 1) + 1,
      params: old.params.map((p) => (p.id === param.id ? revised : p))
    }
  }
  if (next.presentation === undefined) delete next.presentation
  if (next.replay === undefined) delete next.replay
  const manifest = validateManifest(next)
  if ('error' in manifest) return { error: `The control panel is not valid: ${manifest.error}.` }
  if (!files.includes(manifest.file) && manifest.file !== old?.file)
    return {
      error: `The panel must use the selected element's source (${files.join(', ') || 'none'}), not ${manifest.file}.`
    }
  return manifest
}

/** The controls the answer added or changed: only those must resolve now. */
export function changedParams(manifest: ControlPanelManifest, old?: ControlPanelManifest) {
  return manifest.params.filter((p) => {
    const before = old?.file === manifest.file && old.params.find((o) => o.id === p.id)
    return !before || JSON.stringify(before) !== JSON.stringify(p)
  })
}

/** Why each literal control does not resolve in `code` (null: the file is missing). */
export function unresolvedLiterals(code: string | null, params: ControlParam[]): string[] {
  const problems: string[] = []
  for (const param of params) {
    if (param.apply.strategy !== 'literal') continue
    const label = `“${param.label}”`
    if (code == null) {
      problems.push(`${label}: the file is missing`)
      continue
    }
    const at = locateAnchor(code, param.apply.anchor)
    if ('error' in at)
      problems.push(
        `${label}: ${JSON.stringify(param.apply.anchor)} ${at.error === 'missing' ? 'is not in the file' : 'occurs more than once'}`
      )
    else if (resolveLiteralValue(code, param) == null)
      problems.push(`${label}: no ${param.kind} literal follows its anchor`)
  }
  return problems
}

/** Appends a new panel, or replaces the panel `replace` in place. */
export function placePanel(
  panels: ControlPanelManifest[],
  manifest: ControlPanelManifest,
  replace?: string
): ControlPanelManifest[] | { error: string } {
  if (replace !== undefined) {
    const at = panels.findIndex((p) => p.id === replace)
    if (at === -1 || manifest.id !== replace) return { error: 'This panel was removed meanwhile.' }
    const next = panels.slice()
    next[at] = manifest
    return next
  }
  if (panels.some((p) => p.id === manifest.id))
    return { error: `panel id '${manifest.id}' is already used by another panel` }
  if (panels.length >= MAX_PANELS)
    return { error: `This project already has ${MAX_PANELS} control panels. Remove one first.` }
  return [...panels, manifest]
}

/** One control removed from its panel (a new revision); the last one removes the panel. */
export function withoutParam(
  panels: ControlPanelManifest[],
  panel: string,
  param: string
): ControlPanelManifest[] | { error: string } {
  const old = panels.find((p) => p.id === panel)
  if (!old?.params.some((p) => p.id === param))
    return { error: 'This control was removed meanwhile.' }
  const params = old.params.filter((p) => p.id !== param)
  if (!params.length) return panels.filter((p) => p !== old)
  return panels.map((p) => (p === old ? { ...old, params, revision: (old.revision ?? 1) + 1 } : p))
}

import { sourceSelector, sourceStamp } from './source-stamp'
/**
 * Layers panel — DOM tree walk + node resolution, injected alongside the rest
 * of `preload.ts` into the previewed app's isolated world. Split out because
 * `preload.ts` is already large; this module owns everything the tree needs
 * and `preload.ts` only wires the IPC channels into it.
 *
 * Node identity is a DOM CHILD-INDEX PATH (`[0,2,1]`), not a stable id — there
 * is no such thing here. `data-trezi-source` stamps aren't unique (a `.map()`
 * over N items puts the same stamp on N nodes) and `cssPath` is lossy (5-level
 * cap), so a path recomputed fresh on every walk is the only workable handle.
 * Every action that resolves a path back to a live element re-validates a
 * cheap fingerprint (tag + source) at the leaf — the same self-healing
 * discipline `resolveStyleTarget()` uses for the styles panel's selection.
 *
 * `LayerNode`/`LayersSnapshot`/`LayerFingerprint` live in `../shared/api` (the
 * single source of truth for the renderer↔preload contract) — re-exported
 * here so callers in this file can keep importing them locally.
 */

import type { LayerFingerprint, LayerNode, LayersSnapshot } from '../shared/api'
import { isScopeClass } from '../shared/display-classes'

export { isScopeClass } from '../shared/display-classes'
export type { LayerFingerprint, LayerNode, LayersSnapshot }

// Elements not worth showing as page structure: script-ish/head-ish tags the
// user never reorders, plus icon internals (treated as a leaf below).
const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta'])
const LEAF_TAGS = new Set(['svg'])

const MAX_NODES = 4000
const MAX_DEPTH = 30
const MAX_CHILDREN_PER_PARENT = 200

/** Element children only — text/comment nodes don't get a tree row. */
function elementChildren(el: Element): Element[] {
  return Array.from(el.children)
}

/**
 * Walk from `document.body` (not `documentElement`) — trezi's own overlay
 * chrome (`ensureOverlay`'s host, the status pill, the mobile frame) is all
 * appended to `documentElement`, so rooting here excludes it for free.
 */
export function buildLayersSnapshot(): LayersSnapshot {
  const nodes: LayerNode[] = []
  const stampCounts = new Map<string, number>()
  let totalSeen = 0
  let truncated = false

  const visit = (el: Element, parentPath: number[] | null, depth: number): void => {
    if (nodes.length >= MAX_NODES) {
      truncated = true
      return
    }
    totalSeen++
    const path = parentPath ? [...parentPath, elIndex(el)] : []
    const source = sourceStamp(el)
    if (source) stampCounts.set(source, (stampCounts.get(source) ?? 0) + 1)

    const tag = el.tagName.toLowerCase()
    // Scope classes are dropped BEFORE the 5-class cap — filtering later would
    // let a row whose first five classes are all scope markers show nothing.
    const classes =
      typeof el.className === 'string' && el.className.trim()
        ? el.className
            .trim()
            .split(/\s+/)
            .filter((c) => !isScopeClass(c))
            .slice(0, 5)
            .map((c) => c.slice(0, 30))
        : []
    const isLeafTag = LEAF_TAGS.has(tag)
    const children = isLeafTag
      ? []
      : elementChildren(el).filter((c) => !SKIP_TAGS.has(c.tagName.toLowerCase()))
    const text =
      children.length === 0 && !isLeafTag
        ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || null
        : null

    nodes.push({
      path,
      parentPath,
      depth,
      tag: tag.slice(0, 20),
      id: (el.id || '').slice(0, 50) || null,
      classes,
      source: source ? source.slice(0, 256) : null,
      componentSource: (sourceStamp(el, true) || '').slice(0, 256) || null,
      text,
      childCount: children.length,
      dupStamp: false // filled in after the walk, once counts are final
    })

    if (depth >= MAX_DEPTH) return
    const capped = children.slice(0, MAX_CHILDREN_PER_PARENT)
    if (children.length > MAX_CHILDREN_PER_PARENT) truncated = true
    for (const child of capped) {
      if (nodes.length >= MAX_NODES) {
        truncated = true
        break
      }
      visit(child, path, depth + 1)
    }
  }

  if (document.body) visit(document.body, null, 0)

  for (const n of nodes) {
    if (n.source && (stampCounts.get(n.source) ?? 0) > 1) n.dupStamp = true
  }

  return { nodes, truncated, totalSeen }
}

/** This element's index among its parent's ELEMENT children. */
function elIndex(el: Element): number {
  const parent = el.parentElement
  if (!parent) return 0
  return Array.from(parent.children).indexOf(el)
}

/**
 * Resolve a child-index path back to a live element, descending via
 * `children[i]` from `document.body`. Returns null if the path runs off the
 * end anywhere along the way (the DOM changed since the path was computed).
 */
function resolvePath(path: number[]): Element | null {
  let el: Element | null = document.body
  for (const i of path) {
    if (!el) return null
    el = el.children[i] ?? null
  }
  return el
}

/**
 * Resolve a path AND verify it still points at the element the caller expects
 * (by tag + source). A stale path (the DOM shifted since the snapshot) fails
 * closed — callers must not act on a wrong-element resolution.
 */
export function resolveLayerElement(path: number[], fingerprint: LayerFingerprint): Element | null {
  const el = resolvePath(path)
  if (!el) return null
  if (el.tagName.toLowerCase() !== fingerprint.tag) return null
  const src = sourceStamp(el)
  if ((src || null) !== (fingerprint.source || null)) return null
  return el
}

/**
 * `el`'s child-index path from `document.body`, the handle a Layers row has (LKM-179):
 * a picked element carries it so the tree can select its row. Null outside the body or
 * deeper than the tree walks.
 */
export function layerPathOf(el: Element): number[] | null {
  const path: number[] = []
  let node: Element = el
  while (node !== document.body) {
    const parent = node.parentElement
    if (!parent || path.length > MAX_DEPTH) return null
    path.unshift(elIndex(node))
    node = parent
  }
  return path
}

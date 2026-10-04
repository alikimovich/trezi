import { readFile } from 'fs/promises'
import type { MoveNodeRequest, MoveNodeResult } from '../shared/api'
import { toAgent } from './move-node-agent'
import { moveSiblingWithinParent, type Span } from './move-node-splice'
import { commitEdit, type ResolvedSource } from './props'

/**
 * The static-HTML counterpart of `move-node.ts` — actually the SIMPLEST of the
 * three movers. `stampHtml` (html-source.ts) runs at SERVE time over the
 * current file, so every element gets a fresh, unique `line:col` stamp on
 * every request — there is no `.map()`/`{#each}`-equivalent ambiguity to gate
 * against here, and no templated-container check is needed. parse5's tree is
 * naturally parent-aware (`childNodes` arrays) and already carries each
 * node's full span (`sourceCodeLocation.startOffset/endOffset`), so there's no
 * full-span lookup step either — same-parent + whitespace mechanics only.
 *
 * Its own small parse5 loader + parent walk (not `ast-walk.ts`'s generic one):
 * parse5's tree carries `parentNode` back-references, which a naive
 * key-by-key walk would loop on — descending via `childNodes` only avoids
 * that risk entirely, and is simpler for a tree this well-known-shaped.
 */

type Parse5 = typeof import('parse5')
let parse5Promise: Promise<Parse5> | null = null
const loadParse5 = (): Promise<Parse5> => (parse5Promise ??= import('parse5'))

interface P5Loc {
  startOffset: number
  endOffset: number
  startLine: number
  startCol: number
}
interface P5Node {
  nodeName: string
  tagName?: string
  value?: string
  childNodes?: P5Node[]
  sourceCodeLocation?: { startOffset: number; endOffset: number; startTag?: P5Loc } | null
}

/** The element whose OWN start tag sits at `line:col` (mirrors `spliceHtmlText`'s match). */
function findByLoc(doc: P5Node, line: number, col: number): P5Node | null {
  let found: P5Node | null = null
  const walk = (node: P5Node): void => {
    for (const child of node.childNodes ?? []) {
      const st = child.sourceCodeLocation?.startTag
      if (st && st.startLine === line && st.startCol === col) {
        found = child
        return
      }
      walk(child)
      if (found) return
    }
  }
  walk(doc)
  return found
}

/** The parent whose `childNodes` array contains `target`, by reference. */
function findParent(doc: P5Node, target: P5Node): P5Node | null {
  const walk = (node: P5Node): P5Node | null => {
    for (const child of node.childNodes ?? []) {
      if (child === target) return node
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(doc)
}

const isWhitespaceText = (n: P5Node): boolean =>
  n.nodeName === '#text' && /^\s*$/.test(n.value ?? '')

/** A span view over a `P5Node`, for the shared splice primitive (`Span`
 *  needs top-level `start`/`end`; parse5 nests them under `sourceCodeLocation`). */
interface P5Span extends Span {
  node: P5Node
}

function moveWithinParent(
  html: string,
  children: P5Node[],
  draggedEl: P5Node,
  targetEl: P5Node,
  position: 'before' | 'after'
): string | null {
  // Every spliced node must carry a location — an auto-inserted/unlocatable
  // node (parse5 can synthesize these for malformed markup) has no safe span.
  if (children.some((n) => !n.sourceCodeLocation)) return null

  const spans: P5Span[] = children.map((node) => ({
    start: node.sourceCodeLocation?.startOffset ?? 0,
    end: node.sourceCodeLocation?.endOffset ?? 0,
    node
  }))
  const draggedSpan = spans.find((s) => s.node === draggedEl)
  const targetSpan = spans.find((s) => s.node === targetEl)
  if (!draggedSpan || !targetSpan) return null

  return moveSiblingWithinParent(html, spans, draggedSpan, targetSpan, position, (s) =>
    isWhitespaceText(s.node)
  )
}

export async function applyMoveNodeHtml(
  root: string,
  req: MoveNodeRequest,
  file: string,
  draggedLoc: ResolvedSource,
  targetLoc: ResolvedSource
): Promise<MoveNodeResult> {
  if (draggedLoc.column == null || targetLoc.column == null) {
    return toAgent(root, req, 'Could not resolve the exact source position.')
  }
  let html: string
  try {
    html = await readFile(file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }

  let doc: P5Node
  try {
    const { parse } = await loadParse5()
    doc = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node
  } catch {
    return toAgent(root, req, 'Could not parse the HTML.')
  }

  const draggedEl = findByLoc(doc, draggedLoc.line, draggedLoc.column)
  const targetEl = findByLoc(doc, targetLoc.line, targetLoc.column)
  if (!draggedEl || !targetEl) {
    return toAgent(
      root,
      req,
      'Could not find one of these elements in the current source — it may have moved.'
    )
  }

  if (req.position === 'inside') {
    return toAgent(
      root,
      req,
      'Moving an element into a different container needs your judgment on scope and structure.'
    )
  }

  const draggedParent = findParent(doc, draggedEl)
  const targetParent = findParent(doc, targetEl)
  if (!draggedParent || !targetParent || draggedParent !== targetParent) {
    return toAgent(
      root,
      req,
      'These elements are not direct siblings — moving across containers needs your judgment.'
    )
  }

  const next = moveWithinParent(
    html,
    draggedParent.childNodes ?? [],
    draggedEl,
    targetEl,
    req.position
  )
  if (next == null) {
    return toAgent(root, req, 'Could not compute a safe reorder for these two elements.')
  }

  const res = await commitEdit(root, file, html, next, `move:${req.sessionId}`)
  return res.applied ? { applied: true } : { applied: false, error: res.error }
}

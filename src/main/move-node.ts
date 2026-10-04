import { readFile } from 'fs/promises'
import type { MoveNodeRequest, MoveNodeResult } from '../shared/api'
import { type AstNode, ancestorChain, findContainer } from './ast-walk'
import { toAgent } from './move-node-agent'
import { applyMoveNodeHtml } from './move-node-html'
import { moveSiblingWithinParent } from './move-node-splice'
import { applyMoveNodeSvelte } from './move-node-svelte'
import {
  type BabelNode,
  collectNodes,
  commitEdit,
  locateJsxOpening,
  parseFile,
  resolveSource
} from './props'

/**
 * The Layers panel's drag-to-reorder engine (React/JSX). Same hybrid shape as
 * every other direct-edit engine in this codebase: an easy majority (a real
 * sibling reorder under one parent) splices directly; anything that can't be
 * PROVEN safe — a shared stamp, a different file, a different parent, or an
 * element templated by a `.map()`/conditional — routes to the agent with a
 * ready-made prompt instead of guessing.
 *
 * v1 scope: same-file, same-IMMEDIATE-parent `before`/`after` only. `inside`
 * (reparenting) is always `needsAgent` — moving among true siblings under the
 * identical parent is the one case where scope-safety (does the moved node
 * reference locals only valid at its old position?) is trivially guaranteed,
 * and it's also an indentation win: identical nesting depth means the
 * target's own leading whitespace is already the right template for the
 * moved node's new position.
 */

function isValidRequest(req: MoveNodeRequest): boolean {
  return (
    !!req &&
    typeof req.dragged?.source === 'string' &&
    typeof req.target?.source === 'string' &&
    (req.position === 'before' || req.position === 'after' || req.position === 'inside') &&
    typeof req.sessionId === 'string' &&
    req.sessionId.length > 0 &&
    req.sessionId.length <= 100
  )
}

/**
 * The full-span `JSXElement` for a located opening element — `applyTextEdit`'s
 * and `readSourceView`'s idiom, generalized: match by `openingElement.start`
 * against a shared `collectNodes(ast, 'JSXElement', …)` pass so both the
 * dragged and target lookups resolve to nodes from the SAME parsed ast (their
 * object identity is what the container lookup below depends on).
 */
function fullElement(elements: BabelNode[], opening: BabelNode): BabelNode | null {
  return (
    elements.find((e) => (e.openingElement as BabelNode | undefined)?.start === opening.start) ??
    null
  )
}

/**
 * The immediate JSX container (`JSXElement` OR `JSXFragment` — both carry a
 * `.children` array) holding `node`. `findContainer` is the shared, framework-
 * agnostic walk (`ast-walk.ts`); this is just its JSX-shaped accessor.
 */
function findJsxContainer(
  ast: BabelNode,
  node: BabelNode
): { parent: BabelNode; children: BabelNode[] } | null {
  const c = findContainer(ast, node, (n) =>
    n.type === 'JSXElement' || n.type === 'JSXFragment'
      ? (n.children as unknown[] | undefined)
      : undefined
  )
  return c ? { parent: c.parent as BabelNode, children: c.children as BabelNode[] } : null
}

/**
 * Is `node` (or any ancestor) inside a `.map()`/`.filter().map()` call, or a
 * `{cond && <X/>}` / ternary `JSXExpressionContainer`? Either means the
 * CURRENT render's sibling order isn't the template's order — the render may
 * show exactly one instance today, but the underlying template still isn't
 * safe to hand-splice (a `.map()` over a single-item array is still a `.map()`).
 */
function isTemplated(chain: AstNode[]): boolean {
  for (const n of chain) {
    if (n.type === 'CallExpression') {
      const callee = n.callee as { type?: string; property?: { name?: string } } | undefined
      if (callee?.type === 'MemberExpression' && callee.property?.name === 'map') return true
    }
    if (n.type === 'JSXExpressionContainer') {
      const expr = (n.expression as { type?: string } | undefined)?.type
      if (expr === 'LogicalExpression' || expr === 'ConditionalExpression') return true
    }
  }
  return false
}

const isWhitespaceText = (n: BabelNode): boolean =>
  n.type === 'JSXText' && /^\s*$/.test(String((n as { value?: unknown }).value ?? ''))

/**
 * Apply a Layers-panel drag for a `.tsx`/`.jsx`/`.ts`/`.js` file. Dispatched
 * from `applyMoveNode` once the file extension is known.
 */
async function applyMoveNodeReact(
  root: string,
  req: MoveNodeRequest,
  file: string,
  draggedLoc: { line: number; column?: number },
  targetLoc: { line: number; column?: number }
): Promise<MoveNodeResult> {
  let code: string
  try {
    code = await readFile(file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }

  // Parse ONCE — both lookups must resolve against the SAME ast so the JSX
  // element objects are reference-equal (the container/ancestor walks below
  // key on object identity, not position).
  const ast = await parseFile(code)
  const draggedOpening = locateJsxOpening(ast, draggedLoc.line, draggedLoc.column)
  const targetOpening = locateJsxOpening(ast, targetLoc.line, targetLoc.column)
  if (!draggedOpening || !targetOpening) {
    return toAgent(
      root,
      req,
      'Could not find one of these elements in the current source — it may have moved.'
    )
  }

  const elements: BabelNode[] = []
  collectNodes(ast, 'JSXElement', elements)
  const draggedEl = fullElement(elements, draggedOpening.opening)
  const targetEl = fullElement(elements, targetOpening.opening)
  if (!draggedEl || !targetEl) {
    return toAgent(
      root,
      req,
      'Could not resolve the full element (a Fragment or an unusual JSX shape).'
    )
  }

  if (req.position === 'inside') {
    return toAgent(
      root,
      req,
      'Moving an element into a different container needs your judgment on scope and structure.'
    )
  }

  const draggedContainer = findJsxContainer(ast, draggedEl)
  const targetContainer = findJsxContainer(ast, targetEl)
  if (!draggedContainer || !targetContainer || draggedContainer.parent !== targetContainer.parent) {
    return toAgent(
      root,
      req,
      'These elements are not direct siblings — moving across containers needs your judgment.'
    )
  }

  const draggedChain = ancestorChain(ast, draggedEl) ?? []
  const targetChain = ancestorChain(ast, targetEl) ?? []
  if (isTemplated(draggedChain) || isTemplated(targetChain)) {
    return toAgent(
      root,
      req,
      'One of these is rendered from a loop or a conditional in the code, not a fixed position — describe the intended change to the underlying data/condition instead.'
    )
  }

  const next = moveSiblingWithinParent(
    code,
    draggedContainer.children,
    draggedEl,
    targetEl,
    req.position,
    isWhitespaceText
  )
  if (next == null) {
    return toAgent(root, req, 'Could not compute a safe reorder for these two elements.')
  }

  const res = await commitEdit(root, file, code, next, `move:${req.sessionId}`)
  return res.applied ? { applied: true } : { applied: false, error: res.error }
}

export async function applyMoveNode(root: string, req: MoveNodeRequest): Promise<MoveNodeResult> {
  if (!isValidRequest(req)) return { applied: false, error: 'Invalid move request.' }

  // Two DOM instances sharing one stamp can only arise from one JSX/template
  // literal rendered more than once (a `.map()` body, an `{#each}` block) —
  // reordering "instance 2 before instance 1" isn't a source edit, it's a
  // DATA-order change. Cheapest, most decisive gate — checked before any file
  // I/O, and it's the case the Layers panel's own `dupStamp` hint anticipates.
  if (req.dragged.source === req.target.source) {
    return toAgent(
      root,
      req,
      "These render from the same place in the code — describe how you'd like the underlying list reordered."
    )
  }

  const draggedLoc = resolveSource(root, req.dragged.source)
  const targetLoc = resolveSource(root, req.target.source)
  if (!draggedLoc || !targetLoc) {
    return { applied: false, error: 'Could not resolve the source location.' }
  }
  if (draggedLoc.file !== targetLoc.file) {
    return toAgent(root, req, 'These elements are in different files — reorder them across files.')
  }

  if (draggedLoc.file.endsWith('.svelte')) {
    return applyMoveNodeSvelte(root, req, draggedLoc.file, draggedLoc, targetLoc)
  }
  if (/\.html?$/i.test(draggedLoc.file)) {
    return applyMoveNodeHtml(root, req, draggedLoc.file, draggedLoc, targetLoc)
  }
  return applyMoveNodeReact(root, req, draggedLoc.file, draggedLoc, targetLoc)
}

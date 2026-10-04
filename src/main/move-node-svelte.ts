import { readFile } from 'fs/promises'
import type { MoveNodeRequest, MoveNodeResult } from '../shared/api'
import { type AstNode, ancestorChain, findContainer } from './ast-walk'
import { toAgent } from './move-node-agent'
import { moveSiblingWithinParent } from './move-node-splice'
import { commitEdit, type ResolvedSource } from './props'
import { findElement, parseSvelte } from './props-svelte'

/**
 * The Svelte counterpart of `move-node.ts` — same v1 contract (same-file,
 * same-immediate-parent `before`/`after` only; everything else `needsAgent`),
 * mirroring the `props.ts`/`props-svelte.ts` pairing already used for prop and
 * style edits. `findElement`'s node span already covers the full element
 * (children + closing tag, unlike babel's opening-tag-only span), so there's
 * no full-span lookup step here — only the parent/sibling and containment
 * primitives are new, and both come from the shared `ast-walk.ts`.
 */

/** An element's children live in its OWN `.fragment.nodes` array (Svelte 5's
 *  "modern" ast); the top-level markup hangs off the parsed component's
 *  `.fragment.nodes` too, so this one accessor covers both. */
function svelteChildrenOf(n: AstNode): unknown[] | undefined {
  return (n.fragment as { nodes?: unknown[] } | undefined)?.nodes
}

/** Is `node` (or any ancestor) inside an `{#each}` or `{#if}` block? Either
 *  means the current markup's sibling order isn't the template's fixed order —
 *  the Svelte counterpart of React's `.map()`/conditional check. */
function isTemplated(chain: AstNode[]): boolean {
  return chain.some((n) => n.type === 'EachBlock' || n.type === 'IfBlock')
}

const isWhitespaceText = (n: AstNode): boolean =>
  n.type === 'Text' && /^\s*$/.test(String((n as { data?: unknown }).data ?? ''))

/** `AstNode`'s `start`/`end` are `unknown` (duck-typed), but every node this
 *  mover handles carries real offsets — normalize once for the shared splice
 *  primitive, which requires them typed as `number`. */
interface SveltePosNode extends AstNode {
  start: number
  end: number
}
const asSpan = (n: AstNode): SveltePosNode => n as SveltePosNode

export async function applyMoveNodeSvelte(
  root: string,
  req: MoveNodeRequest,
  file: string,
  draggedLoc: ResolvedSource,
  targetLoc: ResolvedSource
): Promise<MoveNodeResult> {
  let code: string
  try {
    code = await readFile(file, 'utf8')
  } catch {
    return { applied: false, error: 'Could not read the source file.' }
  }

  const ast = await parseSvelte(code)
  if (!ast) return toAgent(root, req, 'Could not parse the component.')

  const draggedEl = findElement(ast, code, draggedLoc.line, draggedLoc.column) as AstNode | null
  const targetEl = findElement(ast, code, targetLoc.line, targetLoc.column) as AstNode | null
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

  const draggedContainer = findContainer(ast, draggedEl, svelteChildrenOf)
  const targetContainer = findContainer(ast, targetEl, svelteChildrenOf)
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
      'One of these is rendered from an {#each}/{#if} block, not a fixed position — describe the intended change to the underlying data/condition instead.'
    )
  }

  const next = moveSiblingWithinParent(
    code,
    (draggedContainer.children as AstNode[]).map(asSpan),
    asSpan(draggedEl),
    asSpan(targetEl),
    req.position,
    isWhitespaceText
  )
  if (next == null) {
    return toAgent(root, req, 'Could not compute a safe reorder for these two elements.')
  }

  const res = await commitEdit(root, file, code, next, `move:${req.sessionId}`)
  return res.applied ? { applied: true } : { applied: false, error: res.error }
}

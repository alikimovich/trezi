import type { LayerNode, LayersSnapshot, MoveNodeRequest, SelectedElement } from '../shared/api'

/** The preview's selection as Layers follows it (LKM-179): its last row and its fingerprint. */
export interface LayerSelection {
  path: number[] | null
  tag: string
  source: string | null
  id: string | null
}

/** A tree move waiting for the page to re-render, so its element can stay selected. */
interface PendingMove {
  path: number[]
  tag: string
  id: string | null
  text: string | null
  before: string
  until: number
}

const samePath = (a?: readonly number[] | null, b?: readonly number[] | null) =>
  !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index])

const treeSignature = (nodes: readonly LayerNode[] | undefined) =>
  JSON.stringify((nodes ?? []).map((node) => [node.path, node.tag, node.source]))

/**
 * The row of `selection` in a fresh tree. Its own path while that row keeps the tag and
 * source; after an edit or HMR shifted it, the one row with that source location, tag
 * (and id), or the one nearest the old path when a loop repeats the stamp.
 */
export function resolveLayerSelection(
  nodes: readonly LayerNode[],
  selection: LayerSelection | null
): number[] | null {
  if (!selection) return null
  const exact = selection.path ? nodes.find((node) => samePath(node.path, selection.path)) : null
  if (exact && exact.tag === selection.tag && exact.source === selection.source) return exact.path
  if (!selection.source) return null
  const matches = nodes.filter(
    (node) =>
      node.tag === selection.tag &&
      node.source === selection.source &&
      (!selection.id || node.id === selection.id)
  )
  if (matches.length <= 1) return matches[0]?.path ?? null
  const old = selection.path
  if (!old) return null
  const shared = (path: number[]) => {
    let count = 0
    while (count < path.length && count < old.length && path[count] === old[count]) count++
    return count
  }
  return matches.reduce((best, node) => (shared(node.path) > shared(best.path) ? node : best)).path
}

/** Where a before/after move among one parent's children puts the dragged row; null otherwise. */
export function movedLayerPath(
  dragged: readonly number[],
  target: readonly number[],
  position: MoveNodeRequest['position']
): number[] | null {
  if (position === 'inside' || !dragged.length || dragged.length !== target.length) return null
  const parent = dragged.slice(0, -1)
  if (!samePath(parent, target.slice(0, -1))) return null
  const from = dragged[dragged.length - 1]
  let to = target[target.length - 1]
  if (to > from) to--
  return [...parent, position === 'before' ? to : to + 1]
}

export class NativeLayersController {
  visible = false
  root = ''
  snapshot: LayersSnapshot | null = null
  error = ''
  /** One line under the tree: why a move went to the agent or failed. */
  notice = ''
  selection: LayerSelection | null = null
  private pending: PendingMove | null = null
  private generation = 0
  constructor(
    readonly invoke: (channel: string, ...args: any[]) => Promise<any>,
    readonly send: (channel: string, ...args: any[]) => Promise<any>,
    readonly render: (state: any) => void,
    readonly fallback: (root: string, prompt: string) => Promise<void>,
    readonly now: () => number = Date.now
  ) {}
  publish() {
    const nodes = this.snapshot?.nodes ?? []
    const selected = resolveLayerSelection(nodes, this.selection)
    if (selected && this.selection) this.selection.path = selected
    this.render({
      visible: this.visible,
      root: this.root,
      error: this.error,
      notice: this.notice,
      nodes,
      selected,
      truncated: this.snapshot?.truncated ?? false,
      total: this.snapshot?.totalSeen ?? 0
    })
  }
  async activate(root: string) {
    this.root = root
    this.snapshot = null
    this.pending = null
    this.notice = ''
    ++this.generation
    this.publish()
    if (this.visible && root) await this.refresh()
  }
  async toggle() {
    this.visible = !this.visible
    await this.send('layers:set-watch', this.visible)
    if (!this.visible) {
      ++this.generation
      this.notice = ''
      await this.send('layers:hover', null)
    }
    this.publish()
    if (this.visible) await this.refresh()
  }
  /** The preview's selection changed: a page click, a row, the editing island or the chat chip. */
  selected(element: SelectedElement | null) {
    this.selection = element
      ? {
          path: Array.isArray(element.layerPath) ? element.layerPath : null,
          tag: element.tag,
          source: element.source,
          id: element.id
        }
      : null
    if (this.visible) this.publish()
  }
  async refresh() {
    if (!this.visible || !this.root) return
    const generation = ++this.generation
    try {
      const snapshot = await this.invoke('layers:read')
      if (generation !== this.generation) return
      this.snapshot = snapshot
      this.error = snapshot ? '' : 'Could not read the preview. Reload the page and try again.'
    } catch (error) {
      if (generation !== this.generation) return
      this.error = String(error)
    }
    const moved = this.settleMove()
    this.publish()
    if (moved)
      await this.send('layers:select', {
        path: moved.path,
        fingerprint: { tag: moved.tag, source: moved.source }
      })
  }
  /** The moved element once the page shows the move; it becomes the selection. */
  private settleMove(): LayerNode | null {
    const pending = this.pending,
      nodes = this.snapshot?.nodes
    if (!pending || !nodes) return null
    if (this.now() > pending.until) {
      this.pending = null
      return null
    }
    if (treeSignature(nodes) === pending.before) return null
    const node = nodes.find((candidate) => samePath(candidate.path, pending.path))
    if (
      !node ||
      node.tag !== pending.tag ||
      node.id !== pending.id ||
      (pending.text !== null && node.text !== pending.text)
    )
      return null
    this.pending = null
    this.selection = { path: node.path, tag: node.tag, source: node.source, id: node.id }
    return node
  }
  async move(request: MoveNodeRequest, follow?: Omit<PendingMove, 'before' | 'until'>) {
    const root = this.root
    if (!root) return
    const before = treeSignature(this.snapshot?.nodes)
    const result = await this.invoke('layers:move', root, request)
    if (result.needsAgent && result.agentPrompt) await this.fallback(root, result.agentPrompt)
    if (root !== this.root) return
    if (result.applied) {
      this.notice = ''
      if (follow) this.pending = { ...follow, before, until: this.now() + 8000 }
      await this.refresh()
    } else {
      this.notice = result.needsAgent
        ? 'The source cannot express this move directly; the agent is making it.'
        : String(result.error || 'Could not move the element.')
      this.publish()
    }
  }
  async action(action: {
    root: string
    action: string
    path?: number[]
    target?: number[]
    position?: MoveNodeRequest['position']
  }) {
    if (action.root !== this.root) return
    const find = (path?: number[]): LayerNode | undefined =>
      this.snapshot?.nodes.find((node) => samePath(node.path, path))
    let node = find(action.path)
    if (action.action === 'close') {
      if (this.visible) await this.toggle()
      return
    }
    if (action.action === 'refresh') {
      await this.refresh()
      return
    }
    if (action.action === 'hover' || action.action === 'select') {
      // A row click is the selection until the page reports the pick back.
      if (action.action === 'select' && node)
        this.selection = { path: node.path, tag: node.tag, source: node.source, id: node.id }
      await this.send(
        `layers:${action.action}`,
        node ? { path: node.path, fingerprint: { tag: node.tag, source: node.source } } : null
      )
      return
    }
    // The native outline can still hold a row while a page-change read is in flight.
    // Refresh once before discarding a drop whose paths are absent from our snapshot.
    if (action.action === 'move' && (!node || !find(action.target))) {
      await this.refresh()
      if (action.root !== this.root) return
      node = find(action.path)
    }
    const target = find(action.target)
    const position = action.position
    if (
      action.action === 'move' &&
      node?.source &&
      target?.source &&
      position &&
      ['before', 'after', 'inside'].includes(position)
    ) {
      const path = movedLayerPath(node.path, target.path, position)
      await this.move(
        {
          dragged: { source: node.source },
          target: { source: target.source },
          position,
          sessionId: crypto.randomUUID()
        },
        path ? { path, tag: node.tag, id: node.id, text: node.text } : undefined
      )
    }
  }
}

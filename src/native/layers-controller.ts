import type { LayerNode, LayersSnapshot, MoveNodeRequest } from '../shared/api'
export class NativeLayersController {
  visible = false
  root = ''
  snapshot: LayersSnapshot | null = null
  error = ''
  private generation = 0
  constructor(
    readonly invoke: (channel: string, ...args: any[]) => Promise<any>,
    readonly send: (channel: string, ...args: any[]) => Promise<any>,
    readonly render: (state: any) => void,
    readonly fallback: (root: string, prompt: string) => Promise<void>
  ) {}
  publish() {
    this.render({
      visible: this.visible,
      root: this.root,
      error: this.error,
      nodes: this.snapshot?.nodes ?? [],
      truncated: this.snapshot?.truncated ?? false,
      total: this.snapshot?.totalSeen ?? 0
    })
  }
  async activate(root: string) {
    this.root = root
    this.snapshot = null
    ++this.generation
    this.publish()
    if (this.visible && root) await this.refresh()
  }
  async toggle() {
    this.visible = !this.visible
    await this.send('layers:set-watch', this.visible)
    if (!this.visible) {
      ++this.generation
      await this.send('layers:hover', null)
    }
    this.publish()
    if (this.visible) await this.refresh()
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
    this.publish()
  }
  async move(request: MoveNodeRequest) {
    const root = this.root
    if (!root) return
    const result = await this.invoke('layers:move', root, request)
    if (result.needsAgent && result.agentPrompt) await this.fallback(root, result.agentPrompt)
    if (root !== this.root) return
    if (result.applied) await this.refresh()
    else if (result.error) {
      this.error = result.error
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
      this.snapshot?.nodes.find((node) => JSON.stringify(node.path) === JSON.stringify(path))
    const node = find(action.path)
    if (action.action === 'close') {
      if (this.visible) await this.toggle()
      return
    }
    if (action.action === 'refresh') {
      await this.refresh()
      return
    }
    if (action.action === 'hover' || action.action === 'select') {
      await this.send(
        `layers:${action.action}`,
        node ? { path: node.path, fingerprint: { tag: node.tag, source: node.source } } : null
      )
      return
    }
    const target = find(action.target)
    if (
      action.action === 'move' &&
      node?.source &&
      target?.source &&
      ['before', 'after', 'inside'].includes(action.position ?? '')
    )
      await this.move({
        dragged: { source: node.source },
        target: { source: target.source },
        position: action.position!,
        sessionId: crypto.randomUUID()
      })
  }
}

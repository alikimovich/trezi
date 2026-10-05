import type { EditingOwner, NavigationEvent } from '../main/editing-owner'
import type { PreviewOpenRequest } from '../shared/preview-navigation'

export interface NavigationView {
  /** The active project's root, its current chat, and its running web server (if any). */
  active(): { root: string; chat: string; url: string | null } | null
  load(url: string): Promise<unknown>
}

/**
 * Deferred preview navigation (S12). An agent's `open_preview` asks the editing owner
 * to hold the path until the turn that asked lands; the owner releases or drops it
 * (failure, park, a newer turn, leaving the chat). This controller only performs the
 * load, and only in the chat and project that asked, once its web server is running.
 */
export class NavigationController {
  /** Chats with a released request not opened yet (waiting for the server). */
  private readonly ready = new Set<string>()
  constructor(
    readonly owner: EditingOwner,
    readonly view: NavigationView,
    readonly turn: (chat: string) => string | null,
    readonly report: (error: unknown) => void = () => {}
  ) {}

  async request(request: PreviewOpenRequest) {
    const active = this.view.active()
    // Never followed into another chat or project.
    if (!active || active.root !== request.root || active.chat !== request.key) return
    if (await this.owner.navigate(request.key, request.root, request.path, this.turn(request.key)))
      this.ready.add(request.key)
    await this.open()
  }

  async boundary(chat: string, kind: NavigationEvent, turn: string | null) {
    if (await this.owner.navigation(chat, kind, turn)) this.ready.add(chat)
    else if (kind !== 'landed') this.ready.delete(chat)
    await this.open()
  }

  /** Opens a released request when its chat is active and its server runs (safe to call often). */
  async open() {
    const active = this.view.active()
    for (const chat of [...this.ready]) {
      if (active?.chat === chat && !active.url) continue
      this.ready.delete(chat)
      if (active?.chat !== chat) {
        await this.owner.navigation(chat, 'close', null)
        continue
      }
      const taken = await this.owner.navigationTake(chat)
      if (!taken || taken.root !== active.root) continue
      const base = new URL(active.url!)
      if (!['http:', 'https:'].includes(base.protocol)) continue
      await this.view.load(base.origin + taken.path)
    }
  }

  /** `open` without awaiting, for render hooks. */
  poke() {
    if (this.ready.size) void this.open().catch(this.report)
  }
}

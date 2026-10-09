import type { EditingOwner, NavigationEvent } from '../main/editing-owner'
import { type PreviewDispatch, previewLoads } from '../main/preview-loads'
import type { PreviewOpenRequest } from '../shared/preview-navigation'

export interface NavigationView {
  /** The active project's root, its current chat, and its running web server (if any). */
  active(): { root: string; chat: string; url: string | null } | null
  load(url: string): Promise<unknown>
  /** The preview already shows `url`, loaded (LKM-200). */
  showing?(url: string): Promise<boolean>
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

  /** Handles one request and reports what happened to the waiting tool (LKM-196). */
  async request(request: PreviewOpenRequest) {
    const report = (outcome: PreviewDispatch) => previewLoads.dispatched(request.id, outcome)
    const active = this.view.active()
    // Never followed into another chat or project.
    if (!active || active.root !== request.root || active.chat !== request.key)
      return report('elsewhere')
    try {
      const turn = request.now ? null : this.turn(request.key)
      const ready = await this.owner.navigate(
        request.key,
        request.root,
        request.path,
        turn,
        request.now
      )
      if (ready) this.ready.add(request.key)
      // A page opened now (no unlanded work) is not reloaded when the preview already shows it.
      const opened = await this.open(request.now ? request.key : null)
      report(
        opened.get(request.key) ??
          (!ready ? 'deferred' : this.ready.has(request.key) ? 'no-server' : 'dropped')
      )
    } catch (error) {
      report('dropped')
      throw error
    }
  }

  async boundary(chat: string, kind: NavigationEvent, turn: string | null) {
    if (await this.owner.navigation(chat, kind, turn)) this.ready.add(chat)
    else if (kind !== 'landed') this.ready.delete(chat)
    await this.open()
  }

  /** Opens a released request when its chat is active and its server runs (safe to call
   *  often). Returns the chats it opened; `keep` is a chat whose page is not reloaded
   *  when the preview already shows it. */
  async open(keep: string | null = null): Promise<Map<string, 'loading' | 'already-loaded'>> {
    const opened = new Map<string, 'loading' | 'already-loaded'>()
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
      const url = base.origin + taken.path
      if (chat === keep && (await this.view.showing?.(url))) {
        opened.set(chat, 'already-loaded')
        continue
      }
      await this.view.load(url)
      opened.set(chat, 'loading')
    }
    return opened
  }

  /** `open` without awaiting, for render hooks. */
  poke() {
    if (this.ready.size) void this.open().catch(this.report)
  }
}

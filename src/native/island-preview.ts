import { ISLAND_OVERRIDE, ISLAND_OVERRIDE_REPLY } from '../shared/preview-channels'
import type { IslandOverrideMessage, IslandOverrideRequest } from '../shared/preview-channels'
import type { IslandPreviewPort } from '../main/island-overrides'
import { ipcMain, views } from './platform'

/**
 * The preview end of a Shadow island gesture (LKM-140): requests to
 * `src/preview/island-override.ts` in the isolated content world, answered on the reply
 * channel. Only the preview may answer; an unanswered request (no page, a reload in
 * progress) counts as "nothing shown" for apply and "not yet" for settle.
 */
export function islandPreviewPort(timeoutMs = 400): IslandPreviewPort {
  let sequence = 0
  const pending = new Map<number, (value: unknown) => void>()
  ipcMain.on(ISLAND_OVERRIDE_REPLY, (event, reply: { id?: unknown; value?: unknown } | undefined) => {
    if (event.sender !== views.get('preview')?.webContents) return
    if (typeof reply?.id === 'number') pending.get(reply.id)?.(reply.value)
  })
  const ask = (message: IslandOverrideMessage) => {
    const view = views.get('preview')
    if (!view) return Promise.resolve(undefined)
    const id = ++sequence
    return new Promise<unknown>(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(null) }, timeoutMs)
      pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value) })
      const request: IslandOverrideRequest = { id, ...message }
      view.webContents.send(ISLAND_OVERRIDE, request)
    })
  }
  return {
    apply: async (key, from, css) => {
      const shown = await ask({ op: 'apply', key, from, css })
      return typeof shown === 'number' ? shown : 0
    },
    // No preview view holds nothing; no answer yet is not settled.
    settle: async (key, css) => {
      const done = await ask({ op: 'settle', key, css })
      return done === undefined ? true : typeof done === 'boolean' ? done : null
    },
    clear: key => ask({ op: 'clear', key })
  }
}

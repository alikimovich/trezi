import type { ChatUiImage } from '../shared/chat-ui'
import { getPreviewUrl, previewAgentHost } from './preview-state'

/** An option's preview image: small enough to live in the transcript and every chat
 *  frame that changes its message (LKM-208); a tile is about 190 pt wide. */
export const CHAT_UI_IMAGE = { width: 360, maxBytes: 120 * 1024, timeoutMs: 8000 } as const

interface Prepared {
  crop: { x: number; y: number; width: number; height: number }
  scrolled: boolean
  restore: { x: number; y: number }
}

/**
 * Capture the user's preview as it is now: the visible page, or one element scrolled into
 * view and cropped (the same preparation as `preview_screenshot`). Errors are text for the
 * agent; the option then shows "No preview" instead of a skeleton.
 */
export async function captureChatUiImage(
  capture: true | { selector: string }
): Promise<ChatUiImage | { error: string }> {
  const host = previewAgentHost()
  const url = getPreviewUrl()
  if (!host?.thumbnail || !url)
    return { error: 'No project preview is open: open_preview the variant first.' }
  const route = routeOf(url)
  if (capture === true) return image(await host.thumbnail(null, CHAT_UI_IMAGE.width), route)
  const prepared = (await host.evaluate(
    `globalThis.__treziAgentInspect?.prepareCapture(${JSON.stringify({ selector: capture.selector, index: 0 })}) ?? null`,
    'preview',
    CHAT_UI_IMAGE.timeoutMs
  )) as Prepared | { error: string } | null
  if (!prepared) return { error: 'The preview instrumentation is not ready. Try again.' }
  if ('error' in prepared) return prepared
  try {
    if (prepared.crop.width < 1 || prepared.crop.height < 1)
      return { error: `${capture.selector} has no visible area to capture.` }
    if (prepared.scrolled)
      await host.evaluate(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
        'preview',
        CHAT_UI_IMAGE.timeoutMs
      )
    return image(await host.thumbnail(prepared.crop, CHAT_UI_IMAGE.width), route)
  } finally {
    if (prepared.scrolled)
      await host
        .evaluate(
          `globalThis.__treziAgentInspect?.restoreScroll(${JSON.stringify(prepared.restore)}) ?? null`,
          'preview',
          CHAT_UI_IMAGE.timeoutMs
        )
        .catch(() => {})
  }
}

function image(jpeg: string | null, route: string): ChatUiImage | { error: string } {
  if (!jpeg) return { error: 'No preview capture is available.' }
  if ((jpeg.length * 3) / 4 > CHAT_UI_IMAGE.maxBytes)
    return { error: 'The preview capture is too large; capture one element instead.' }
  return { src: `data:image/jpeg;base64,${jpeg}`, route }
}

function routeOf(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`.slice(0, 300)
  } catch {
    return ''
  }
}

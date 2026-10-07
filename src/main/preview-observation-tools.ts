import { type PreviewToolResult, runPreviewAgentTool } from './preview-agent-tools'
import { describePage, previewPage } from './preview-page'
import { capturePreview } from './preview-state'

/** Every preview observer; each answers as MCP content (text or one image). */
export const PREVIEW_OBSERVERS = [
  'preview_location',
  'preview_screenshot',
  'preview_inspect',
  'preview_evaluate',
  'preview_console',
  'preview_viewport'
] as const
export type PreviewObserver = (typeof PREVIEW_OBSERVERS)[number]
export const isPreviewObserver = (action: unknown): action is PreviewObserver =>
  PREVIEW_OBSERVERS.includes(action as PreviewObserver)

/**
 * Read the user's current view on demand; this does not prove an edit has landed.
 * `root` is the chat's project: the answer is refused while the preview shows another
 * server, and otherwise ends with the page it describes (URL, port, route; LKM-199).
 */
export async function observeAgentPreview(
  action: PreviewObserver,
  args: unknown = {},
  root?: string
): Promise<PreviewToolResult> {
  const { page, refusal } = await previewPage(root)
  if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true }
  if (action === 'preview_location') {
    return {
      content: [
        {
          type: 'text',
          text: page
            ? `The user's preview is currently showing ${page.url} (port ${page.port}, route ${page.route}).`
            : 'No project preview is open.'
        }
      ]
    }
  }
  const result = await observe(action, args)
  if (page && !result.isError) result.content.push({ type: 'text', text: describePage(page) })
  return result
}

async function observe(action: PreviewObserver, args: unknown): Promise<PreviewToolResult> {
  if (action !== 'preview_screenshot')
    return runPreviewAgentTool(action as Exclude<PreviewObserver, 'preview_location'>, args)
  // An element-cropped capture (LKM-138) when a selector or point is given.
  const target = (args ?? {}) as { selector?: unknown; x?: unknown; y?: unknown }
  if (typeof target.selector === 'string' || (target.x !== undefined && target.y !== undefined))
    return runPreviewAgentTool('preview_screenshot', args)
  const img = await capturePreview()
  if (!img || img.isEmpty()) {
    return { content: [{ type: 'text', text: 'No project preview capture is available.' }] }
  }
  // Swift supplies a bounded JPEG; keep the same limit for other image sources.
  const scaled = img.getSize().width > 1200 ? img.resize({ width: 1200 }) : img
  const jpeg = scaled.toJPEG(70)
  if (!jpeg.length) {
    return { content: [{ type: 'text', text: 'No project preview capture is available.' }] }
  }
  return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] }
}

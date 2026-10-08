import { type PreviewToolResult, runPreviewAgentTool } from './preview-agent-tools'
import { describeIdentity, liveHead, type PreviewIdentity } from './preview-identity'
import { previewLoads } from './preview-loads'
import { describePage, previewPage } from './preview-page'
import { previewSpeed, speedLabel } from './preview-speed'
import { capturePreviewForAgent } from './preview-state'
import { phase } from './tool-timing'

/** Every preview observer; each answers as MCP content (text or one image). */
export const PREVIEW_OBSERVERS = [
  'preview_location',
  'preview_screenshot',
  'preview_inspect',
  'preview_evaluate',
  'preview_console',
  'preview_viewport',
  'preview_speed'
] as const
export type PreviewObserver = (typeof PREVIEW_OBSERVERS)[number]
type Content = PreviewToolResult['content'][number]
export const isPreviewObserver = (action: unknown): action is PreviewObserver =>
  PREVIEW_OBSERVERS.includes(action as PreviewObserver)

/** The identity block every observation ends with (LKM-200), machine-readable. */
export const identityText = (identity: PreviewIdentity) =>
  `${describeIdentity(identity)}\n${JSON.stringify({ preview: identity })}`

/** A slowed or paused preview (LKM-206) changes what timing-sensitive reads see. */
const speedNote = (action: PreviewObserver): Content[] =>
  previewSpeed.speed === 1 || action === 'preview_speed'
    ? []
    : [
        {
          type: 'text',
          text: `Preview speed: ${speedLabel(previewSpeed.speed)} (slow motion: page animations and timers run ${previewSpeed.speed === 0 ? 'paused' : 'slowed'}; preview_speed with speed 1 restores normal timing).`
        }
      ]

/**
 * Read the user's current view on demand; this does not prove an edit has landed.
 * `root` is the chat's project: the answer is refused while the preview shows another
 * server, and otherwise ends with the page it describes (URL, port, route; LKM-199)
 * and its identity: preview session, navigation, document start and served revision
 * (LKM-200). An observation the page navigated away from while it ran is refused.
 */
export async function observeAgentPreview(
  action: PreviewObserver,
  args: unknown = {},
  root?: string
): Promise<PreviewToolResult> {
  // The live HEAD read runs while the page answers (it is cached for the identity).
  if (root) void liveHead(root)
  const navigation = previewLoads.navigation
  const { page, identity, refusal } = await previewPage(root)
  if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true }
  if (action === 'preview_location') {
    return {
      content: [
        {
          type: 'text',
          text: page
            ? `The user's preview is currently showing ${page.url} (port ${page.port}, route ${page.route}).`
            : 'No project preview is open.'
        },
        ...(page ? speedNote(action) : []),
        ...(page ? [{ type: 'text' as const, text: identityText(identity) }] : [])
      ]
    }
  }
  const result = await observe(action, args)
  if (previewLoads.navigation !== navigation)
    return {
      content: [
        {
          type: 'text',
          text: `The preview navigated while ${action} ran (navigation ${navigation} → ${previewLoads.navigation}), so its answer could mix two documents and was discarded. Call ${action} again.`
        }
      ],
      isError: true
    }
  if (page && !result.isError)
    result.content.push(
      ...speedNote(action),
      { type: 'text', text: describePage(page) },
      { type: 'text', text: identityText(identity) }
    )
  return result
}

async function observe(action: PreviewObserver, args: unknown): Promise<PreviewToolResult> {
  if (action !== 'preview_screenshot')
    return phase('read', () =>
      runPreviewAgentTool(action as Exclude<PreviewObserver, 'preview_location'>, args)
    )
  // An element-cropped capture (LKM-138) when a selector or point is given.
  const target = (args ?? {}) as { selector?: unknown; x?: unknown; y?: unknown; full?: unknown }
  if (typeof target.selector === 'string' || (target.x !== undefined && target.y !== undefined))
    return phase('capture', () => runPreviewAgentTool('preview_screenshot', args))
  // LKM-200: one bounded JPEG rendered at its sent size (full resolution only on request).
  const frame = await capturePreviewForAgent(target.full === true)
  if (!frame?.jpeg.length) {
    return { content: [{ type: 'text', text: 'No project preview capture is available.' }] }
  }
  return {
    content: [
      { type: 'image', data: frame.jpeg.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'text', text: `Screenshot: ${frame.width}×${frame.height} px JPEG.` }
    ]
  }
}

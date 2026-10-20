import type { AgentBrowser } from './agent-browser'
import { type PreviewToolResult, VIEWPORT_PRESETS } from './preview-agent-tools'

/**
 * LOCAL-WEBKIT-2: `preview_viewport` on the agent browser. Each session's page keeps its
 * own CSS width, height and color scheme until it is restored or closed: the native host
 * resizes only that offscreen view and sets only its appearance
 * (`PreviewAgent.setAgentViewport`), so the user's preview, its layout and the app's
 * appearance never change and nothing restores itself behind the agent's back.
 * `preview_verify` records this state in its receipt; it is emulation on this Mac.
 */

export type AgentTheme = 'light' | 'dark' | 'system'
export interface AgentViewport {
  width: number
  height: number
  theme: AgentTheme
}
export const AGENT_VIEWPORT_DEFAULT: AgentViewport = { width: 1280, height: 800, theme: 'system' }
const WIDTH = { min: 240, max: 3840 }
const HEIGHT = { min: 240, max: 2160 }
const THEMES: AgentTheme[] = ['light', 'dark', 'system']

/** The viewport after `raw` is applied to `current`, or why it is refused. Pure. */
export function parseAgentViewport(
  raw: unknown,
  current: AgentViewport = AGENT_VIEWPORT_DEFAULT
): AgentViewport | { error: string } {
  const args = (raw ?? {}) as Record<string, unknown>
  if (args.restore === true) return { ...AGENT_VIEWPORT_DEFAULT }
  const next = { ...current }
  if (args.preset !== undefined) {
    const width = VIEWPORT_PRESETS[args.preset as keyof typeof VIEWPORT_PRESETS]
    if (!width)
      return { error: `Unknown preset. Use one of: ${Object.keys(VIEWPORT_PRESETS).join(', ')}.` }
    next.width = width
  } else if (args.width !== undefined) {
    if (
      !Number.isInteger(args.width) ||
      (args.width as number) < WIDTH.min ||
      (args.width as number) > WIDTH.max
    )
      return { error: `width must be ${WIDTH.min}–${WIDTH.max} CSS px.` }
    next.width = args.width as number
  }
  if (args.height !== undefined) {
    if (
      !Number.isInteger(args.height) ||
      (args.height as number) < HEIGHT.min ||
      (args.height as number) > HEIGHT.max
    )
      return { error: `height must be ${HEIGHT.min}–${HEIGHT.max} CSS px.` }
    next.height = args.height as number
  }
  if (args.theme !== undefined) {
    if (!THEMES.includes(args.theme as AgentTheme))
      return { error: 'theme must be light, dark or system.' }
    next.theme = args.theme as AgentTheme
  }
  if (
    args.preset === undefined &&
    args.width === undefined &&
    args.height === undefined &&
    args.theme === undefined
  )
    return { error: 'Pass a preset, width, height or theme, or restore: true.' }
  return next
}

/** The page's own size and scheme in the first frame laid out at `width` × `height`. */
const measureCode = (v: AgentViewport) =>
  `new Promise((r) => { const end = performance.now() + 1500; const tick = () => (Math.abs(innerWidth - ${v.width}) <= 1 && Math.abs(innerHeight - ${v.height}) <= 1) || performance.now() > end ? r({ innerWidth, innerHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches }) : requestAnimationFrame(tick); requestAnimationFrame(tick) })`

export interface MeasuredViewport {
  innerWidth: number
  innerHeight: number
  dark: boolean | null
}

/** The page's own size and scheme right now, as a receipt records them (null: unread). */
export const measureAgentPage = (browser: AgentBrowser) =>
  browser.host
    .evaluate(
      "({ innerWidth, innerHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches })",
      'preview',
      2000
    )
    .catch(() => null) as Promise<MeasuredViewport | null>

/** Why the page is not laid out as `viewport` claims, or null. Pure: a receipt never
 *  states a size or scheme the page did not have. */
export function viewportMismatch(
  viewport: AgentViewport,
  measured: MeasuredViewport | null
): string | null {
  if (!measured) return 'viewport-unmeasured: the page did not report its size'
  if (
    Math.abs(measured.innerWidth - viewport.width) > 1 ||
    Math.abs(measured.innerHeight - viewport.height) > 1
  )
    return `viewport-not-applied: the page is ${measured.innerWidth}×${measured.innerHeight}, not ${viewport.width}×${viewport.height}`
  if (viewport.theme !== 'system' && measured.dark !== (viewport.theme === 'dark'))
    return `viewport-not-applied: the page prefers ${measured.dark ? 'dark' : 'light'}, not ${viewport.theme}`
  return null
}

export async function applyAgentViewport(browser: AgentBrowser, viewport: AgentViewport) {
  await browser.host.setViewport(viewport.width, { height: viewport.height, theme: viewport.theme })
  browser.viewport = viewport
  return ((await browser.host
    .evaluate(measureCode(viewport), 'preview', 4000)
    .catch(() => null)) ?? {
    innerWidth: 0,
    innerHeight: 0,
    dark: null
  }) as { innerWidth: number; innerHeight: number; dark: boolean | null }
}

export async function agentViewportTool(
  browser: AgentBrowser,
  raw: unknown
): Promise<PreviewToolResult> {
  const next = parseAgentViewport(raw, browser.viewport)
  if ('error' in next) return { content: [{ type: 'text', text: next.error }], isError: true }
  const page = await applyAgentViewport(browser, next)
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            viewport: next,
            page,
            ...((raw as { restore?: unknown })?.restore === true ? { restored: true } : {}),
            scope:
              "This session's agent browser only, until restore: true or the page closes. The user's preview is unchanged. This is emulation in WebKit on this Mac, not a device or OS."
          },
          null,
          2
        )
      }
    ]
  }
}

import { projectKey } from '../shared/projectKey'
import type { AgentBrowser, AgentNotice } from './agent-browser'
import { refScope, refToken, resolveRef } from './agent-refs'
import type { PreviewToolResult } from './preview-agent-tools'
import { previewServers } from './preview-evidence'
import { getPreviewUrl } from './preview-state'

/**
 * `preview_interact` (LKM-230): click, type, press keys, hover, scroll, select an option
 * or wait, in the session's private agent browser only, never in the user's preview.
 * The page side is `src/preview/agent-interact.ts`; the host refuses off-origin
 * navigation, external form posts and downloads (`agentPolicy` in
 * `src/native/PreviewPlatform.swift`). Every answer carries the resulting URL, any
 * console errors and a small screenshot. LOCAL-WEBKIT-2: `refs` lists element refs
 * (`./agent-refs`) any action can target, and every action states its input fidelity:
 * untrusted synthetic DOM events, no CSS :hover, only some key defaults emulated.
 */

export const INTERACT_ACTIONS = [
  'click',
  'type',
  'press',
  'hover',
  'scroll',
  'select',
  'wait',
  'refs'
] as const
/** What an interaction in the WebKit agent browser is, stated in every report. */
export const INTERACT_FIDELITY = {
  events: 'synthetic-dom',
  trusted: false,
  cssHover: false,
  keyDefaults: 'emulated subset (others are refused)',
  trustedInput: 'preview_verify engine "chromium"'
} as const
export const INTERACT_USER_REFUSAL =
  'preview_interact runs only in the agent browser; it never touches the user\'s preview. Omit target or use target: "agent".'
/** How long a navigation an interaction started may take to load. */
export const INTERACT_NAVIGATION_MS = 10_000
const THUMBNAIL_WIDTH = 480
const NOTICE_GRACE_MS = 150

/** What the page side runs (it mirrors `InteractRequest` in `src/preview/agent-interact.ts`). */
export interface InteractArgs {
  action: (typeof INTERACT_ACTIONS)[number]
  selector?: string
  index?: number
  source?: string
  /** An element ref token from `refs` (LOCAL-WEBKIT-2). */
  ref?: string
  /** refs: how many to list (default 50, at most 150). */
  limit?: number
  x?: number
  y?: number
  text?: string
  clear?: boolean
  key?: string
  option?: string
  deltaX?: number
  deltaY?: number
  to?: 'top' | 'bottom'
  networkIdle?: boolean
  hidden?: boolean
  timeoutMs?: number
  force?: boolean
  /** Bun only: attach the small screenshot (default true). */
  screenshot: boolean
}

const str = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max ? value : undefined
const finite = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max ? value : undefined

/** The validated request, or why it is refused. Pure, so the limits are unit-tested. */
export function parseInteraction(raw: unknown): InteractArgs | { error: string } {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const action = a.action as InteractArgs['action']
  if (!INTERACT_ACTIONS.includes(action))
    return { error: `action must be one of ${INTERACT_ACTIONS.join(', ')}.` }
  const request: InteractArgs = { action, screenshot: a.screenshot !== false }
  for (const [key, max] of [
    ['selector', 1000],
    ['source', 500],
    ['ref', 40],
    ['text', 1000],
    ['key', 60],
    ['option', 500]
  ] as const) {
    if (a[key] === undefined) continue
    const value = str(a[key], max)
    if (value === undefined)
      return { error: `${key} must be a string of at most ${max} characters.` }
    request[key] = value
  }
  if (a.index !== undefined) {
    if (!Number.isInteger(a.index) || (a.index as number) < 0 || (a.index as number) > 999)
      return { error: 'index must be an integer 0–999.' }
    request.index = a.index as number
  }
  if (a.limit !== undefined) {
    if (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 150)
      return { error: 'limit must be an integer 1–150.' }
    request.limit = a.limit as number
  }
  if ((a.x === undefined) !== (a.y === undefined))
    return { error: 'Give both x and y, or neither.' }
  if (a.x !== undefined) {
    const x = finite(a.x, 100_000)
    const y = finite(a.y, 100_000)
    if (x === undefined || y === undefined || x < 0 || y < 0)
      return { error: 'x and y are viewport CSS pixels (0 or more).' }
    Object.assign(request, { x, y })
  }
  for (const key of ['deltaX', 'deltaY'] as const) {
    if (a[key] === undefined) continue
    const value = finite(a[key], 100_000)
    if (value === undefined) return { error: `${key} must be a number of pixels.` }
    request[key] = value
  }
  if (a.to !== undefined) {
    if (a.to !== 'top' && a.to !== 'bottom') return { error: 'to must be "top" or "bottom".' }
    request.to = a.to
  }
  if (a.timeoutMs !== undefined) {
    const ms = finite(a.timeoutMs, 15_000)
    if (ms === undefined || ms < 100) return { error: 'timeoutMs must be 100–15000.' }
    request.timeoutMs = Math.floor(ms)
  }
  for (const key of ['clear', 'networkIdle', 'hidden', 'force'] as const) {
    if (a[key] === undefined) continue
    if (typeof a[key] !== 'boolean') return { error: `${key} must be true or false.` }
    request[key] = a[key]
  }
  const target =
    request.ref || request.selector?.trim() || request.source?.trim() || request.x !== undefined
  if ((action === 'click' || action === 'hover' || action === 'select') && !target)
    return { error: `${action} needs a selector, ref, source or x/y point.` }
  if (action === 'refs' && (request.ref || request.source || request.x !== undefined))
    return { error: 'refs lists elements: pass an optional selector and limit only.' }
  if (action === 'wait' && request.ref)
    return { error: 'wait takes a selector or text; a ref names an element that already exists.' }
  if (action === 'type' && request.text === undefined) return { error: 'type needs text.' }
  if (action === 'press' && !request.key?.trim())
    return { error: 'press needs a key, e.g. "Enter" or "Meta+a".' }
  if (action === 'select' && request.option === undefined)
    return { error: 'select needs an option (value or label).' }
  if (action === 'wait' && !request.selector?.trim() && !request.text && !request.networkIdle)
    return { error: 'wait needs a selector, text or networkIdle: true.' }
  return request
}

/** Opens the shown route (or `/`) when the agent browser has no page yet; the error text otherwise. */
export async function ensureAgentPage(
  browser: AgentBrowser,
  liveRoot: string
): Promise<string | null> {
  if (browser.url) return null
  const server = previewServers.get(projectKey(liveRoot))
  // A private page (LOCAL-WEBKIT-1) starts its own server; it only borrows the shown route.
  if (!server && browser.runtime !== 'private')
    return 'The project dev server is stopped. Call restart_dev_server.'
  const shown = getPreviewUrl()
  const route =
    shown && server && new URL(shown).origin === new URL(server.url).origin
      ? new URL(shown).pathname + new URL(shown).search + new URL(shown).hash
      : '/'
  await browser.open(route)
  return null
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits until a navigation the interaction started has loaded, was refused or failed. */
async function settleNavigation(browser: AgentBrowser, navigation: number, notices: number) {
  const started = Date.now()
  while (Date.now() - started < INTERACT_NAVIGATION_MS) {
    if (browser.navigation !== navigation && !browser.loading) return 'loaded'
    const last = browser.notices?.slice(notices).at(-1)
    if (last && !browser.loading) return last.phase
    await pause(50)
  }
  return 'timeout'
}

type PageAnswer = Record<string, unknown> & {
  error?: string
  refused?: string
  consoleSeq?: number
  navigating?: boolean
}
type After = { url?: string; title?: string; consoleErrors?: unknown[]; droppedErrors?: number }

type RefsAnswer = {
  error?: string
  document?: string
  refs?: { ref: string }[]
}

/** `refs`: the page's elements, each with a ref token scoped to this browser and navigation. */
async function listRefs(browser: AgentBrowser, request: InteractArgs) {
  const answer = (await browser.host.evaluate(
    `globalThis.__treziAgentObserve?.refs(${JSON.stringify({ selector: request.selector, limit: request.limit })}) ?? null`,
    'preview',
    5000
  )) as RefsAnswer | null
  if (!answer)
    return { action: 'refs', ok: false, error: 'The agent browser page is not ready. Try again.' }
  if (answer.error || !answer.document) return { action: 'refs', ok: false, error: answer.error }
  const scope = refScope(browser.id, browser.navigation, answer.document)
  const { document: _document, ...rest } = answer
  return {
    action: 'refs',
    ok: true,
    ...rest,
    refs: (answer.refs ?? []).map((entry) => ({ ...entry, ref: refToken(scope, entry.ref) })),
    scope: `Refs work in this session's agent browser until it navigates or the element is removed; then call refs again.`
  }
}

/**
 * Runs one validated interaction and reports the page after it (the report object only:
 * `preview_verify` steps use it too).
 */
export async function interactionReport(
  browser: AgentBrowser,
  request: InteractArgs
): Promise<Record<string, unknown> & { action: string; ok: boolean; error?: string }> {
  if (request.action === 'refs') return listRefs(browser, request)
  const { screenshot: _screenshot, limit: _limit, ref: token, ...page } = request
  if (token) {
    const resolved = resolveRef(browser, token)
    if ('error' in resolved) return { action: request.action, ok: false, ...resolved }
    Object.assign(page, resolved)
  }
  const navigation = browser.navigation
  const notices = browser.notices?.length ?? 0
  const timeout = (request.action === 'wait' ? (request.timeoutMs ?? 5000) : 3000) + 2000
  let answer: PageAnswer
  try {
    answer = ((await browser.host.evaluate(
      `globalThis.__treziAgentInteract?.run(${JSON.stringify(page)}) ?? { error: 'The agent browser page is not ready. Try again.' }`,
      'preview',
      timeout
    )) as PageAnswer | null) ?? { error: 'The agent browser page did not answer.' }
  } catch (error) {
    // A navigation can end the document while the call is still waiting for it.
    if (
      browser.loading ||
      browser.navigation !== navigation ||
      (browser.notices?.length ?? 0) > notices
    )
      answer = { navigating: true }
    else throw error
  }
  const { consoleSeq = 0, navigating = false, ...result } = answer
  // A script navigation (location.href = …) reaches the host's policy a moment later.
  if (!result.error && !navigating && (request.action === 'click' || request.action === 'press'))
    for (let i = 0; i < 3 && !browser.loading && (browser.notices?.length ?? 0) === notices; i++)
      await pause(NOTICE_GRACE_MS / 3)
  const outcome =
    navigating || browser.loading || (browser.notices?.length ?? 0) > notices
      ? await settleNavigation(browser, navigation, notices)
      : null
  const navigated = browser.navigation !== navigation
  const blocked = (browser.notices?.slice(notices) ?? []).map(
    ({ phase, reason, url, message }: AgentNotice) => ({
      phase,
      ...(reason ? { reason } : {}),
      url,
      ...(message ? { message } : {})
    })
  )
  const after = ((await browser.host
    .evaluate(
      `globalThis.__treziAgentInteract?.after(${navigated ? 0 : consoleSeq}) ?? null`,
      'preview',
      2000
    )
    .catch(() => null)) ?? {}) as After
  return {
    action: request.action,
    ok: !result.error && !blocked.some((notice) => notice.phase === 'blocked'),
    ...result,
    url: after.url ?? browser.url,
    ...(after.title ? { title: after.title } : {}),
    navigated,
    ...(outcome === 'timeout'
      ? { navigation: `still loading after ${INTERACT_NAVIGATION_MS / 1000} s` }
      : {}),
    ...(blocked.length ? { blocked } : {}),
    consoleErrors: after.consoleErrors ?? [],
    ...(after.droppedErrors ? { droppedErrors: after.droppedErrors } : {}),
    ...(request.action === 'wait' ? {} : { fidelity: INTERACT_FIDELITY })
  }
}

/** Runs one validated interaction on the agent browser and reports the page after it. */
export async function runAgentInteraction(
  browser: AgentBrowser,
  request: InteractArgs
): Promise<PreviewToolResult> {
  const report = await interactionReport(browser, request)
  const screenshot = request.screenshot && request.action !== 'refs'
  const content: PreviewToolResult['content'] = [
    { type: 'text', text: JSON.stringify(report, null, 2) }
  ]
  if (screenshot && browser.host.thumbnail) {
    const jpeg = await browser.host.thumbnail(null, THUMBNAIL_WIDTH).catch(() => null)
    if (jpeg) content.push({ type: 'image', data: jpeg, mimeType: 'image/jpeg' })
  }
  return { content, ...(report.ok ? {} : { isError: true }) }
}

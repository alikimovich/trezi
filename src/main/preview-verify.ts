import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectKey } from '../shared/projectKey'
import { type AgentBrowser, agentBrowser, openAgentBrowser } from './agent-browser'
import { snapshotOf } from './agent-identity'
import { ensureAgentPage, interactionReport } from './agent-interact'
import { resolveRef } from './agent-refs'
import { agentRuntime, ensureAgentRuntime } from './agent-runtime'
import {
  AGENT_VIEWPORT_DEFAULT,
  type AgentViewport,
  applyAgentViewport,
  measureAgentPage,
  parseAgentViewport,
  viewportMismatch
} from './agent-viewport'
import { managedBrowserWrapper } from './backends/managed-browser-path'
import { type CheckResult, isElementCheck, type Observation, pollChecks } from './browser-checks'
import { runManagedCli } from './managed-browser-cli'
import type { PreviewToolResult } from './preview-agent-tools'
import { previewServers } from './preview-evidence'
import type { PreviewIdentity } from './preview-identity'
import {
  artifactDirectory,
  macOSVersion,
  NOT_COVERED,
  newReceiptId,
  type ReceiptStep,
  receiptSession,
  receiptStatus,
  receiptSummary,
  receiptValue,
  recordReceipt,
  sessionReceipts,
  type VerificationReceipt,
  writeArtifact
} from './verification-receipts'
import { parseVerify, type VerifyArgs } from './verify-args'
import { runChromiumChecks } from './verify-chromium'

/**
 * LOCAL-WEBKIT-2: `preview_verify`. The host loads the session's page, runs the setup
 * steps, observes the checks itself and writes a receipt (`./verification-receipts`)
 * bound to the exact source snapshot, the private server's generation, the document and
 * the engine, with the screenshot it captured. `engine: "chromium"` runs the same checks
 * through Trezi's managed agent-browser (`./verify-chromium`) against the same server.
 * `list: true` reads back this session's receipts with whether each still holds.
 */

export interface VerifyScope {
  root: string
  liveRoot: string
  emitKey: string
}

let wrapperOverride: string | null = null
/** Test seam: the managed wrapper `engine: "chromium"` runs (`null` restores the real one). */
export function setVerifyWrapperForTests(path: string | null): void {
  wrapperOverride = path
}

const textResult = (text: string, isError = false): PreviewToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {})
})
const route = (url: string) => {
  const u = new URL(url)
  return u.pathname + u.search + u.hash
}
const LIVE_SERVER =
  "live-server: this session works in the live checkout, whose visible dev server has no private generation or exact-source record; receipts verify only a chat worktree's private server"

export async function runPreviewVerify(
  raw: unknown,
  scope: VerifyScope
): Promise<PreviewToolResult> {
  const args = parseVerify(raw)
  if ('error' in args) return textResult(args.error, true)
  const session = receiptSession(scope.emitKey, projectKey(scope.root))
  if ('list' in args) return listReceipts(scope, session)
  try {
    const receipt =
      args.engine === 'chromium'
        ? await chromiumReceipt(args, scope, session)
        : await webkitReceipt(args, scope, session)
    if ('error' in receipt) return textResult(receipt.error, true)
    // The request as given, so a landing Retry can run the same checks (LOCAL-WEBKIT-3).
    receipt.recipe = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
    recordReceipt(session, receipt)
    return answer(receipt, receipt.engine === 'webkit' ? receipt.artifacts[0]?.path : undefined)
  } catch (error) {
    return textResult(
      `preview_verify failed: ${error instanceof Error ? error.message : String(error)}`,
      true
    )
  }
}

function answer(receipt: VerificationReceipt, jpeg?: string): PreviewToolResult {
  const content: PreviewToolResult['content'] = [
    { type: 'text', text: receiptSummary(receipt) },
    { type: 'text', text: JSON.stringify(receipt, null, 2) }
  ]
  if (jpeg) {
    content.push({
      type: 'image',
      data: readFileSync(jpeg).toString('base64'),
      mimeType: 'image/jpeg'
    })
  }
  return { content, ...(receipt.verified ? {} : { isError: true }) }
}

const webkitCoverage = (viewport: AgentViewport) => ({
  engine: 'WebKit (system WKWebView, offscreen)',
  os: macOSVersion(),
  emulated: {
    viewport: `${viewport.width}×${viewport.height} CSS px view size (no device emulation)`,
    colorScheme:
      viewport.theme === 'system' ? 'system appearance' : `${viewport.theme} (view appearance)`
  },
  notCovered: NOT_COVERED
})

type Built = VerificationReceipt | { error: string }

async function webkitReceipt(
  args: VerifyArgs,
  scope: VerifyScope,
  session: string
): Promise<Built> {
  const started = Date.now()
  const browser = await agentBrowser(scope.emitKey, scope.root, 'webkit', scope.liveRoot)
  if (args.viewport) {
    const viewport = parseAgentViewport(args.viewport, browser.viewport)
    if ('error' in viewport) return viewport
    await applyAgentViewport(browser, viewport)
  }
  const steps: ReceiptStep[] = []
  if (args.path) {
    await browser.open(args.path, { reload: args.reload })
    steps.push({ action: 'open', target: args.path, ok: true })
  } else if (!browser.url) {
    const stopped = await ensureAgentPage(browser, scope.liveRoot)
    if (stopped) return { error: stopped }
    steps.push({ action: 'open', target: browser.url ? route(browser.url) : '/', ok: true })
  } else if (args.reload) {
    await browser.open(route(browser.url), { reload: true })
    steps.push({ action: 'reload', target: route(browser.url ?? '/'), ok: true })
  }
  // A page that no longer shows the worktree's current source is loaded again first.
  const shown = browser.runtime === 'private' && browser.url ? await browser.identity() : null
  if (shown && !shown.source?.verified && browser.url) {
    await browser.open(route(browser.url), { reload: true })
    steps.push({
      action: 'reload',
      target: route(browser.url),
      ok: true,
      detail: `the page did not show the current source (${shown.source?.reason ?? 'unknown'})`
    })
  }
  let stopped: string | null = null
  for (const request of args.steps) {
    const report = await interactionReport(browser, request)
    const target = request.selector ?? request.ref ?? request.source ?? request.key ?? request.text
    steps.push({
      action: request.action,
      ...(target ? { target: target.slice(0, 300) } : {}),
      ok: report.ok,
      ...(report.ok ? {} : { detail: String(report.error ?? 'refused').slice(0, 500) })
    })
    if (!report.ok) {
      stopped = `step-failed: ${request.action}`
      break
    }
  }
  const before = await browser.identity()
  const navigation = browser.navigation
  const document = (await browser.host
    .evaluate('globalThis.__treziAgentObserve?.document ?? null', 'preview', 2000)
    .catch(() => null)) as string | null
  let checks: CheckResult[] = []
  if (!stopped && !document)
    stopped = 'the agent page is not ready (no Trezi observer in this document)'
  if (!stopped) {
    const polled = await pollChecks(args.checks, (pending, until) =>
      observeWebkit(browser, args, pending, navigation, document as string, until)
    )
    checks = polled.results
    if (polled.aborted) stopped = polled.aborted
  }
  const viewport = browser.viewport ?? AGENT_VIEWPORT_DEFAULT
  const measured = await measureAgentPage(browser)
  const receiptId = newReceiptId()
  const frame = args.screenshot ? await browser.capture(false).catch(() => null) : null
  const artifacts = frame
    ? [
        writeArtifact(session, `${receiptId}.jpg`, frame.jpeg, 'image/jpeg', {
          width: frame.width,
          height: frame.height
        })
      ]
    : []
  const after = await browser.identity()
  const agent = (await browser.host
    .evaluate('navigator.userAgent', 'preview', 1000)
    .catch(() => null)) as string | null
  const checksPassed = !stopped && checks.length > 0 && checks.every((c) => c.pass)
  const reason =
    stopped ??
    (checksPassed
      ? (webkitReason(browser, before, after, navigation, args.screenshot && !frame) ??
        viewportMismatch(viewport, measured))
      : 'checks-failed')
  return {
    id: receiptId,
    createdAt: new Date(started).toISOString(),
    engine: 'webkit',
    engineDetail: `System WebKit${agent ? `: ${agent.slice(0, 240)}` : ''}`,
    input: 'synthetic-dom',
    coverage: webkitCoverage(viewport),
    runtime: {
      kind: browser.runtime === 'private' ? 'private' : 'live',
      agent: browser.id,
      root: browser.root,
      url: after.runtime?.url ?? null,
      generation: after.runtime?.generation ?? null
    },
    source: {
      snapshot: after.source?.served ?? null,
      tree: after.source?.servedTree ?? null,
      head: after.source?.head ?? after.servedRevision,
      dirty: after.source?.dirty ?? 0
    },
    document: {
      url: browser.url,
      navigation: browser.navigation,
      startedAt: after.documentStartedAt
    },
    viewport: { ...viewport, measured },
    steps,
    checks: checks.map((c) => ({ ...c, actual: receiptValue(c.actual) })),
    artifacts,
    checksPassed,
    verified: checksPassed && reason === null,
    reason,
    ms: Date.now() - started
  }
}

/** Why passing checks would still not verify this WebKit run, or null. */
function webkitReason(
  browser: AgentBrowser,
  before: PreviewIdentity,
  after: PreviewIdentity,
  navigation: number,
  missingShot: boolean
): string | null {
  if (browser.runtime !== 'private') return LIVE_SERVER
  for (const identity of [before, after])
    if (!identity.source?.verified)
      return `source-not-verified: ${identity.source?.reason ?? 'unknown'}`
  if (before.source?.served !== after.source?.served) return 'source-changed'
  if (before.runtime?.generation !== after.runtime?.generation) return 'runtime-restarted'
  if (navigation !== browser.navigation) return 'navigated'
  if (before.documentStartedAt !== after.documentStartedAt) return 'document-replaced'
  return missingShot ? 'screenshot-unavailable' : null
}

/** One observation round in the agent page's isolated world. */
async function observeWebkit(
  browser: AgentBrowser,
  args: VerifyArgs,
  pending: number[],
  navigation: number,
  document: string,
  until: number
) {
  if (browser.navigation !== navigation || browser.loading)
    return { abort: 'the page navigated during the checks' }
  // The page's answer is awaited for no longer than the round has left.
  const left = until - Date.now()
  if (left <= 0) return { abort: 'the checks ran out of time' }
  const targets = new Map<number, Observation>()
  const asked: number[] = []
  const requests: Record<string, unknown>[] = []
  for (const i of pending) {
    const check = args.checks[i]
    if (!isElementCheck(check)) continue
    const request: Record<string, unknown> = {
      ...(check.kind === 'attribute' ? { attrs: [check.name] } : {}),
      ...(check.kind === 'style' ? { styles: [check.name] } : {})
    }
    if (check.ref) {
      const resolved = resolveRef(browser, check.ref)
      if ('error' in resolved) {
        targets.set(i, { error: resolved.error, stale: resolved.stale })
        continue
      }
      Object.assign(request, resolved)
    } else
      Object.assign(request, { selector: check.selector, source: check.source, index: check.index })
    asked.push(i)
    requests.push(request)
  }
  const seen = (await browser.host
    .evaluate(
      `globalThis.__treziAgentObserve?.observe(${JSON.stringify({ targets: requests, consoleSince: 0 })}) ?? null`,
      'preview',
      Math.min(4000, left)
    )
    .catch(() => null)) as {
    document?: string
    url?: string
    title?: string
    consoleErrors?: number
    targets?: Observation[]
  } | null
  if (!seen) return { abort: 'the agent page did not answer' }
  if (seen.document !== document) return { abort: 'the document was replaced during the checks' }
  asked.forEach((i, n) => {
    targets.set(i, seen.targets?.[n] ?? { error: 'not observed' })
  })
  return {
    targets,
    page: {
      url: seen.url ?? null,
      title: seen.title ?? null,
      consoleErrors: typeof seen.consoleErrors === 'number' ? seen.consoleErrors : null
    }
  }
}

let cliVersion: string | null = null

async function chromiumReceipt(
  args: VerifyArgs,
  scope: VerifyScope,
  session: string
): Promise<Built> {
  const started = Date.now()
  const wrapper = wrapperOverride ?? managedBrowserWrapper(__dirname)
  if (!wrapper)
    return {
      error:
        'Trezi\'s managed agent-browser wrapper (Trezi.app/Contents/Resources/browser/bin/managed/agent-browser) is missing from this build, so engine "chromium" is unavailable. No other browser is used; rebuild Trezi.'
    }
  // The wrapper's exit 3 names a missing CLI or headless shell before anything starts.
  const probe = await runManagedCli(wrapper, null, scope.root, ['--version'], 15_000)
  const missing = probe.stderr.match(/dependency: ([a-z-]+): ([^\n]+)/)
  if (probe.code === 3 && missing) return dependencyError(missing[1], missing[2])
  if (probe.code !== 0)
    return {
      error: `Trezi's managed agent-browser did not start: ${probe.stderr.trim().slice(0, 300) || `exit ${probe.code}`}`
    }
  cliVersion = probe.stdout.trim().split('\n')[0]?.slice(0, 80) || cliVersion
  // The same server the session's WebKit page uses: its private runtime in a worktree.
  const isolated = projectKey(scope.root) !== projectKey(scope.liveRoot)
  const page = isolated
    ? await agentBrowser(scope.emitKey, scope.root, 'webkit', scope.liveRoot)
    : null
  const server = page
    ? await ensureAgentRuntime(page.id, scope.root)
    : previewServers.get(projectKey(scope.liveRoot))
  if (!server) return { error: 'The project dev server is stopped. Call restart_dev_server.' }
  const generation = page ? (agentRuntime(page.id)?.generation ?? null) : null
  const origin = new URL(server.url).origin
  const path =
    args.path ?? (page?.url && new URL(page.url).origin === origin ? route(page.url) : '/')
  const viewport = args.viewport
    ? (parseAgentViewport(args.viewport, page?.viewport) as AgentViewport)
    : (page?.viewport ?? AGENT_VIEWPORT_DEFAULT)
  const receiptId = newReceiptId()
  const before = await snapshotOf(scope.root)
  const outcome = await runChromiumChecks({
    wrapper,
    cwd: scope.root,
    url: new URL(path, server.url).href,
    origin,
    viewport,
    steps: args.steps,
    checks: args.checks,
    screenshotPath: args.screenshot ? join(artifactDirectory(session), `${receiptId}.png`) : null
  })
  if (outcome.dependency)
    return dependencyError(outcome.dependency.kind, outcome.dependency.message)
  const after = await snapshotOf(scope.root)
  const now = page ? agentRuntime(page.id) : null
  const checksPassed =
    !outcome.stopped && outcome.checks.length > 0 && outcome.checks.every((c) => c.pass)
  let reason: string | null = outcome.stopped ?? (checksPassed ? null : 'checks-failed')
  if (!reason && !page) reason = LIVE_SERVER
  else if (!reason && (!before?.id || !after?.id)) reason = 'snapshot-unavailable'
  else if (!reason && before?.id !== after?.id) reason = 'source-changed'
  else if (!reason && (!now || now.generation !== generation)) reason = 'runtime-restarted'
  else if (!reason && (!outcome.url || new URL(outcome.url).origin !== origin))
    reason = 'left-server'
  else if (!reason && args.screenshot && !outcome.artifacts.length)
    reason = 'screenshot-unavailable'
  return {
    id: receiptId,
    createdAt: new Date(started).toISOString(),
    engine: 'chromium',
    engineDetail: `Chromium headless shell through Trezi's managed agent-browser${cliVersion ? ` (${cliVersion})` : ''}${outcome.warnings ? `; ${outcome.warnings} CLI warning${outcome.warnings === 1 ? '' : 's'} (not page errors)` : ''}`,
    input: 'cdp-trusted',
    coverage: {
      engine: 'Chromium (headless shell)',
      os: macOSVersion(),
      emulated: {
        viewport: `${viewport.width}×${viewport.height} CSS px (CDP viewport emulation)`,
        colorScheme:
          viewport.theme === 'system'
            ? 'headless default (light)'
            : `${viewport.theme} (CDP media emulation)`
      },
      notCovered: NOT_COVERED
    },
    runtime: {
      kind: page ? 'private' : 'live',
      agent: page?.id ?? null,
      root: scope.root,
      url: server.url,
      generation
    },
    source: {
      snapshot: before?.id && before.id === after?.id ? before.id : null,
      tree: before?.id && before.id === after?.id ? before.tree : null,
      head: after?.head ?? null,
      dirty: after?.dirty ?? 0
    },
    // The URL the checks were pinned to; the run stops if the page's URL ever differs.
    document: { url: outcome.pinned, navigation: null, startedAt: null },
    viewport,
    steps: outcome.steps,
    checks: outcome.checks.map((c) => ({ ...c, actual: receiptValue(c.actual) })),
    artifacts: outcome.artifacts,
    checksPassed,
    verified: checksPassed && reason === null,
    reason,
    ms: Date.now() - started
  }
}

const dependencyError = (kind: string, message: string) => ({
  error: `preview_verify engine "chromium" needs a dependency: ${kind}: ${message} Nothing was checked and no receipt was written; WebKit checks (engine "webkit") still work.`
})

/** This session's receipts and whether each still holds for the checkout, server and page. */
async function listReceipts(scope: VerifyScope, session: string): Promise<PreviewToolResult> {
  const receipts = sessionReceipts(session)
  const snapshot = await snapshotOf(scope.root)
  const page = openAgentBrowser(scope.emitKey, scope.root, scope.liveRoot)
  const shown = page ? await page.identity() : null
  const list = receipts.map((receipt) => {
    const server = receipt.runtime.agent ? agentRuntime(receipt.runtime.agent) : null
    const samePage = page && page.id === receipt.runtime.agent
    const status = receiptStatus(receipt, {
      snapshot: snapshot?.id ?? null,
      generation: server?.generation ?? null,
      serverRunning: !!server,
      navigation: samePage ? page.navigation : null,
      documentStartedAt: samePage ? (shown?.documentStartedAt ?? null) : null
    })
    return {
      id: receipt.id,
      createdAt: receipt.createdAt,
      engine: receipt.engine,
      checks: `${receipt.checks.filter((c) => c.pass).length}/${receipt.checks.length}`,
      verified: receipt.verified,
      current: status.current,
      ...(status.reason ? { reason: status.reason } : {}),
      snapshot: receipt.source.snapshot,
      artifacts: receipt.artifacts.map(({ path, sha256 }) => ({ path, sha256 }))
    }
  })
  return textResult(
    JSON.stringify(
      {
        receipts: list,
        scope:
          "This session's receipts only (newest last, at most 20). A receipt is current only while the worktree's exact source, the private server generation and, for WebKit, the page's document are unchanged."
      },
      null,
      2
    )
  )
}

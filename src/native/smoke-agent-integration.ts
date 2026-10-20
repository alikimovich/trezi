import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentBrowser,
  agentBrowser,
  closeAgentBrowser,
  privateName
} from '../main/agent-browser'
import { agentRuntimes, stopAgentRuntime } from '../main/agent-runtime'
import {
  adoptSession,
  afterTurn,
  beforeTurn,
  isolatedCwd,
  isolationSnapshot,
  releaseChat,
  resolveParkedChat,
  retryLanding
} from '../main/chat-isolation'
import { integrationGate } from '../main/integration-gate'
import { previewServers } from '../main/preview-evidence'
import { previewLoads } from '../main/preview-loads'
import { runPreviewVerify } from '../main/preview-verify'
import {
  clearReceipts,
  receiptSession,
  setVerificationArtifactsRoot
} from '../main/verification-receipts'
import type { SessionRecord } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import type { NativeBridge } from './bridge'
import { bridge } from './bridge'
import { initRepo } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const A = 'native-gate-a'
const B = 'native-gate-b'
const PROJECT = 'Gate Project'
const html = (title: string, heading: string) =>
  `<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${heading}</h1></body></html>`
/** Each page's own cookie and storage marker; one shared store would show both. */
const mark = (who: string) =>
  `(() => { document.cookie = 'trezi_${who}=1; path=/; max-age=3600'; localStorage.setItem('trezi-who', '${who}'); sessionStorage.setItem('trezi-who', '${who}'); return true })()`
const MARKERS =
  "JSON.stringify({cookie:document.cookie,local:localStorage.getItem('trezi-who'),session:sessionStorage.getItem('trezi-who'),heading:document.querySelector('h1')?.textContent ?? null,path:location.pathname})"
/** The passive OS focus state no agent work may move (`smokeFocusSnapshot`). */
const FOCUS = [
  'frontmostPID',
  'key',
  'responder',
  'resignCount',
  'keyLostCount',
  'activationCount',
  'cursorX',
  'cursorY'
]
type Markers = { cookie: string; local: string; session: string; heading: string; path: string }
type Receipt = {
  id: string
  verified: boolean
  reason: string | null
  engine: string
  input: string
  engineDetail: string
  source: { snapshot: string; tree: string; head: string; dirty: number }
  runtime: { url: string; generation: number | null; agent: string | null }
}

let browsers: { key: string; root: string }[] = []
let chats: string[] = []
let scratch = ''

/**
 * LOCAL-WEBKIT-3: two agents' chats in their own worktrees, each with its own private dev
 * server and WebKit page, land only what a host check passed on, provider-free and with the
 * real chat landing, repository owner and gate. A receipt made stale by a later edit and a
 * failing check both hold the work with live untouched; checks in WebKit and managed
 * Chromium on the same exact source let it land, and the visible preview reloads the new
 * code in place with its cookie, storage and the window's focus intact. A concurrent user
 * edit of the same file becomes a conflict whose resolution is checked again before it
 * lands. Each page keeps its own cookie and storage throughout.
 */
export async function checkAgentIntegration(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  firstProject: string
) {
  const project = join(fixture, `../${PROJECT}`)
  rmSync(project, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'index.html'), html('Gate', 'Gate base'))
  writeFileSync(join(project, 'other.html'), html('Other', 'Other base'))
  initRepo(project)
  const out = join(artifacts, 'agent-integration')
  mkdirSync(out, { recursive: true })
  scratch = mkdtempSync(join(tmpdir(), 'trezi-agent-integration-'))
  setVerificationArtifactsRoot(join(scratch, 'receipts'))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const userMarkers = async () => JSON.parse(String(await page(MARKERS))) as Markers
  const agentMarkers = async (browser: AgentBrowser) =>
    JSON.parse(String(await browser.host.evaluate(MARKERS, 'preview', 2000))) as Markers
  const focus = async () =>
    (await bridge().request('smokeFocusSnapshot')) as Record<string, unknown>
  const shot = async (name: string) =>
    writeFileSync(
      join(out, `${name}.png`),
      Buffer.from((await host.request('captureShell')) as string, 'base64')
    )
  const liveFile = (file: string) => readFileSync(join(project, file), 'utf8')
  const evidence: Record<string, unknown> = {}

  await nativeWorkspace.command({ type: 'open', root: project })
  await waitFor(
    () => nativeWorkspace.active?.key !== firstProject && nativeWorkspace.active,
    'the gate project is open',
    30_000
  )
  const liveRoot = nativeWorkspace.active?.root ?? project
  await waitFor(
    async () => (await userMarkers()).heading === 'Gate base',
    'the gate project preview',
    60_000
  )
  const live = previewServers.get(projectKey(liveRoot))
  assert.ok(live, 'the visible preview has a live server')
  const liveOrigin = new URL(live.url).origin
  const baseHead = git(project, 'rev-parse', 'HEAD')
  const baseTree = git(project, 'rev-parse', 'HEAD^{tree}')

  // The user's own page state in the visible preview.
  await page(mark('user'))
  const user0 = await userMarkers()
  assert.match(user0.cookie, /trezi_user=1/)
  assert.deepEqual([user0.local, user0.session], ['user', 'user'])
  // The baseline once opening the project has settled: two consecutive samples agree.
  let focus0 = await focus()
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    const current = await focus()
    if (JSON.stringify(current) === JSON.stringify(focus0)) break
    focus0 = current
  }
  const focusUnchanged = async (phase: string) => {
    const now = await focus()
    for (const field of FOCUS)
      assert.equal(now[field], focus0[field], `${phase}: focus ${field} changed`)
    return now
  }
  const userKept = async (phase: string, heading: string) => {
    const now = await userMarkers()
    assert.deepEqual(
      { ...now, heading },
      { ...user0, heading },
      `${phase}: the user's cookie, storage and route`
    )
    assert.equal(now.heading, heading, `${phase}: the visible page shows the live code`)
    assert.equal(nativeWorkspace.active?.root, liveRoot, `${phase}: the project is unchanged`)
    const server = previewServers.get(projectKey(liveRoot))
    assert.deepEqual([server?.url, server?.pid], [live.url, live.pid], `${phase}: live server`)
    await focusUnchanged(phase)
    return now
  }
  await shot('before')

  // Two chats, each in its own worktree with independent edits.
  const open = async (key: string) => {
    const cwd = await isolatedCwd(liveRoot, key)
    chats.push(key)
    assert.notEqual(cwd, liveRoot, `${key} has a worktree of its own`)
    adoptSession(key, { id: key } as SessionRecord, liveRoot)
    await beforeTurn(key, 'edit')
    return cwd
  }
  const wtA = await open(A)
  const wtB = await open(B)
  const scopeA = { emitKey: A, root: wtA, liveRoot }
  writeFileSync(join(wtA, 'index.html'), html('Gate', 'Gate by A draft'))
  writeFileSync(join(wtB, 'other.html'), html('Other', 'Other by B draft'))
  const verify = async (key: string, root: string, args: Record<string, unknown>) => {
    const result = await runPreviewVerify(args, { emitKey: key, root, liveRoot })
    const json = result.content[1]
    assert.ok(json?.type === 'text', `a receipt: ${JSON.stringify(result.content[0])}`)
    const receipt = JSON.parse(json.text) as Receipt
    writeFileSync(join(out, `receipt-${receipt.id}.json`), JSON.stringify(receipt, null, 2))
    return receipt
  }
  const heading = (equals: string) => [{ kind: 'text', selector: 'h1', equals, timeoutMs: 3000 }]

  // Their private pages: own servers, own cookies and storage; the user's page is untouched.
  browsers.push({ key: A, root: wtA }, { key: B, root: wtB })
  const a = await agentBrowser(A, wtA, 'webkit', liveRoot)
  const b = await agentBrowser(B, wtB, 'webkit', liveRoot)
  const [openedA, openedB] = await Promise.all([a.open('/'), b.open('/other.html')])
  const origins = [openedA.url, openedB.url].map((url) => new URL(url).origin)
  assert.equal(new Set([...origins, liveOrigin]).size, 3, 'three distinct servers')
  await a.host.evaluate(mark('agent_a'), 'preview', 2000)
  await b.host.evaluate(mark('agent_b'), 'preview', 2000)
  const markersA = await agentMarkers(a)
  const markersB = await agentMarkers(b)
  assert.equal(markersA.heading, 'Gate by A draft')
  assert.equal(markersB.heading, 'Other by B draft')
  for (const [markers, who] of [
    [markersA, 'agent_a'],
    [markersB, 'agent_b']
  ] as const) {
    assert.equal(markers.cookie, `trezi_${who}=1`, `${who} sees only its own cookie`)
    assert.deepEqual([markers.local, markers.session], [who, who])
  }
  await userKept('two private pages', 'Gate base')
  assert.equal(git(project, 'rev-parse', 'HEAD^{tree}'), baseTree)
  assert.equal(git(project, 'status', '--porcelain'), '', 'live is untouched')
  const [jpegA, jpegB] = await Promise.all([a.capture(), b.capture()])
  if (jpegA?.jpeg.length) writeFileSync(join(out, 'agent-a.jpg'), jpegA.jpeg)
  if (jpegB?.jpeg.length) writeFileSync(join(out, 'agent-b.jpg'), jpegB.jpeg)
  await shot('agents-isolated')
  evidence.isolated = {
    user: user0,
    agents: { a: markersA, b: markersB },
    servers: { live: live.url, a: openedA.url, b: openedB.url },
    sources: { a: openedA.identity.source, b: openedB.identity.source }
  }

  // A's check passed on its draft; its next edit makes that receipt stale, so the turn holds.
  const draft = await verify(A, wtA, { path: '/', checks: heading('Gate by A draft') })
  assert.equal(draft.verified, true, JSON.stringify(draft))
  writeFileSync(join(wtA, 'index.html'), html('Gate', 'Gate by A'))
  assert.equal((await integrationGate(scopeA)).reason, 'unchecked')
  await afterTurn(A, 'Gate heading', [], 'success')
  const staleHold = isolationSnapshot(A)
  assert.equal(staleHold?.state, 'parked')
  assert.match(staleHold?.error ?? '', /no check passed on this exact source/)
  assert.equal(git(project, 'rev-parse', 'HEAD'), baseHead, 'a stale receipt lands nothing')
  assert.equal(liveFile('index.html'), html('Gate', 'Gate base'))

  // Checks in WebKit and managed Chromium on the same exact source, then Retry lands it.
  const webkit = await verify(A, wtA, { path: '/', checks: heading('Gate by A') })
  const chromium = await verify(A, wtA, {
    engine: 'chromium',
    path: '/',
    checks: heading('Gate by A')
  })
  assert.equal(webkit.verified, true, JSON.stringify(webkit))
  assert.equal(chromium.verified, true, JSON.stringify(chromium))
  assert.equal(chromium.engine, 'chromium')
  assert.equal(chromium.input, 'cdp-trusted')
  assert.equal(chromium.source.tree, webkit.source.tree, 'one exact source in both engines')
  assert.equal(chromium.runtime.url, webkit.runtime.url, 'one private server')
  assert.notEqual(webkit.source.tree, draft.source.tree)
  const gateA = await integrationGate(scopeA)
  assert.equal(gateA.ok, true, JSON.stringify(gateA))
  assert.equal(gateA.candidate, webkit.source.tree)
  const retriedA = await retryLanding(A)
  assert.deepEqual(retriedA, { ok: true, state: 'isolated' })
  const landedA = {
    head: git(project, 'rev-parse', 'HEAD'),
    tree: git(project, 'rev-parse', 'HEAD^{tree}')
  }
  assert.equal(landedA.tree, gateA.candidate, 'live holds exactly the checked tree')
  assert.equal(liveFile('other.html'), html('Other', 'Other base'), "B's work is not live")
  await waitFor(
    async () => (await userMarkers()).heading === 'Gate by A',
    'the visible preview reloads the landed code',
    20_000
  )
  const user1 = await userKept('A landed', 'Gate by A')
  await shot('after')
  evidence.landedA = {
    candidate: gateA.candidate,
    live: landedA,
    receipts: {
      stale: { id: draft.id, tree: draft.source.tree },
      webkit: { id: webkit.id, tree: webkit.source.tree, url: webkit.runtime.url },
      chromium: { id: chromium.id, tree: chromium.source.tree, detail: chromium.engineDetail }
    },
    staleHold,
    user: user1
  }

  // B's failing check blocks its landing; live is unchanged.
  const failing = await verify(B, wtB, { path: '/other.html', checks: heading('Other by B') })
  assert.equal(failing.verified, false)
  await afterTurn(B, 'Other heading', [], 'success')
  const failedHold = isolationSnapshot(B)
  assert.match(failedHold?.error ?? '', /did not pass on this exact source/)
  assert.equal(git(project, 'rev-parse', 'HEAD'), landedA.head, 'a failed check lands nothing')
  assert.equal(liveFile('other.html'), html('Other', 'Other base'))

  // B fixes it and passes, but the user edited the same file meanwhile: Retry does not
  // overwrite it, the overlap is a conflict, and its resolution is new, unchecked source.
  writeFileSync(join(wtB, 'other.html'), html('Other', 'Other by B'))
  const fixed = await verify(B, wtB, { path: '/other.html', checks: heading('Other by B') })
  assert.equal(fixed.verified, true, JSON.stringify(fixed))
  const userOther = html('Other', 'Other by the user')
  writeFileSync(join(project, 'other.html'), userOther)
  const retriedB = await retryLanding(B)
  assert.equal(retriedB.ok, true, JSON.stringify(retriedB))
  assert.equal(isolationSnapshot(B)?.state, 'parked', 'the drift is a conflict, not a landing')
  assert.equal(liveFile('other.html'), userOther, "the user's edit is kept")
  assert.equal(git(project, 'rev-parse', 'HEAD'), landedA.head)
  const prep = await resolveParkedChat(B)
  assert.deepEqual(prep, { ok: true, conflicted: ['other.html'] })
  assert.match(readFileSync(join(wtB, 'other.html'), 'utf8'), /<<<<<<<|>>>>>>>/)
  assert.equal(liveFile('other.html'), userOther, 'conflict markers stay in the worktree')
  const merged = html('Other', 'Other by B and the user')
  writeFileSync(join(wtB, 'other.html'), merged)
  await afterTurn(B, 'Resolve conflicts', [], 'success')
  const unresolvedHold = isolationSnapshot(B)
  assert.match(unresolvedHold?.error ?? '', /no check passed on this exact source/)
  assert.equal(liveFile('other.html'), userOther, 'an unchecked resolution lands nothing')
  const resolved = await verify(B, wtB, {
    path: '/other.html',
    checks: heading('Other by B and the user')
  })
  assert.equal(resolved.verified, true, JSON.stringify(resolved))
  const retriedResolved = await retryLanding(B)
  assert.deepEqual(retriedResolved, { ok: true, state: 'isolated' })
  const landedB = {
    head: git(project, 'rev-parse', 'HEAD'),
    tree: git(project, 'rev-parse', 'HEAD^{tree}')
  }
  assert.equal(landedB.tree, resolved.source.tree, 'live holds exactly the checked resolution')
  assert.equal(liveFile('other.html'), merged)
  assert.equal(liveFile('index.html'), html('Gate', 'Gate by A'))
  assert.equal(git(project, 'status', '--porcelain'), '')
  const user2 = await userKept('B landed', 'Gate by A')
  evidence.landedB = {
    live: landedB,
    receipts: {
      failed: { id: failing.id, tree: failing.source.tree, reason: failing.reason },
      fixed: { id: fixed.id, tree: fixed.source.tree },
      resolved: { id: resolved.id, tree: resolved.source.tree }
    },
    holds: { failedHold, unresolvedHold },
    conflicted: prep.conflicted,
    user: user2
  }

  // Each page still has only its own state.
  assert.equal((await agentMarkers(a)).cookie, 'trezi_agent_a=1')
  assert.equal((await agentMarkers(b)).cookie, 'trezi_agent_b=1')

  // Cleanup: the private pages and servers stop, the worktrees go, the live server stays.
  await cleanupAgentIntegration()
  assert.deepEqual(agentRuntimes(), [], 'no private runtime is left')
  for (const root of [wtA, wtB]) assert.equal(existsSync(root), false, `${root} is removed`)
  const listed = git(project, 'worktree', 'list', '--porcelain')
  assert.ok(!listed.includes(wtA) && !listed.includes(wtB), listed)
  await userKept('cleanup', 'Gate by A')
  evidence.focus = { before: focus0, after: await focusUnchanged('end'), compared: FOCUS }
  evidence.project = { root: liveRoot, base: { head: baseHead, tree: baseTree } }
  writeFileSync(join(out, 'agent-integration.json'), JSON.stringify(evidence, null, 2))
  await restoreAgentIntegration(host, firstProject)
  console.log(
    `Native agent integration: two worktrees with private WebKit pages; a stale receipt and a failed check held their work with live unchanged; WebKit and managed Chromium checks on tree ${gateA.candidate} landed exactly that tree and the visible preview reloaded with its cookie, storage and focus; a concurrent user edit became a checked conflict resolution (${landedB.tree}). Artifacts: ${out}`
  )
}

/** Close the private pages and chats this check opened (idempotent). */
async function cleanupAgentIntegration() {
  for (const { key, root } of browsers) {
    await closeAgentBrowser(privateName(key, root))
    clearReceipts(receiptSession(key, projectKey(root)))
  }
  browsers = []
  for (const key of chats) await releaseChat(key)
  chats = []
  for (const runtime of agentRuntimes()) await stopAgentRuntime(runtime.agent)
  setVerificationArtifactsRoot(null)
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
}

/** Back to the first fixture project, with the gate project closed. */
export async function restoreAgentIntegration(host: NativeBridge, firstProject: string) {
  await cleanupAgentIntegration()
  const gate = nativeWorkspace.state.projects.find((p) => p.root.endsWith(`/${PROJECT}`))
  if (firstProject && nativeWorkspace.active?.key !== firstProject) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${firstProject}` })
    await waitFor(() => nativeWorkspace.active?.key === firstProject, 'first project selected')
  }
  if (gate) await nativeWorkspace.command({ type: 'close', key: gate.key })
  await waitFor(
    () => !nativeWorkspace.state.projects.some((p) => p.root.endsWith(`/${PROJECT}`)),
    'the gate project is closed'
  )
  // The next check pins the preview's document: hand it over only once the first
  // project's page has loaded and no navigation is still under way.
  let seen = -1
  await waitFor(
    async () => {
      const quiet = !previewLoads.busy && previewLoads.navigation === seen
      seen = previewLoads.navigation
      if (!quiet) return false
      await new Promise((resolve) => setTimeout(resolve, 500))
      return (
        !previewLoads.busy &&
        previewLoads.navigation === seen &&
        (await host.request('evaluate', {
          view: 'preview',
          code: '!!document.querySelector("#native-title")'
        })) === true
      )
    },
    'the first project preview settled',
    20000
  )
}

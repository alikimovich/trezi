import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  type AgentBrowser,
  agentBrowser,
  closeAgentBrowser,
  privateName
} from '../main/agent-browser'
import { type InteractArgs, interactionReport, parseInteraction } from '../main/agent-interact'
import { agentRuntimes, stopAgentRuntime } from '../main/agent-runtime'
import type { PreviewToolResult } from '../main/preview-agent-tools'
import { previewServers } from '../main/preview-evidence'
import { runPreviewVerify } from '../main/preview-verify'
import {
  clearReceipts,
  receiptSession,
  setVerificationArtifactsRoot
} from '../main/verification-receipts'
import { projectKey } from '../shared/projectKey'
import { nativeWorkspace } from './workspace-runtime'

type Page = (code: string) => Promise<unknown>
const KEY = 'native-agent-verify'
const OTHER = 'native-agent-verify-other'
const USER_STATE =
  "JSON.stringify({url:location.href,width:innerWidth,height:innerHeight,dark:matchMedia('(prefers-color-scheme: dark)').matches,x:scrollX,y:scrollY,title:document.title})"
const page = (
  heading: string
) => `<!doctype html><html><head><title>Verify</title><link rel="icon" href="data:,"><style>
body { font: 16px system-ui; background: rgb(250, 250, 250); color: rgb(17, 17, 17) }
@media (prefers-color-scheme: dark) { body { background: rgb(17, 17, 17); color: rgb(240, 240, 240) } }
.menu .item { display: none } .menu:hover .item { display: block }
</style></head><body><h1>${heading}</h1>
<button id="save" type="button">Save</button><p id="status">Idle</p>
<div class="menu">Menu<a class="item" href="#more">More</a></div>
<ul><li>One</li><li>Two</li><li>Three</li></ul>
<script>document.querySelector('#save').addEventListener('click', () => setTimeout(() => { document.querySelector('#status').textContent = 'Saved' }, 1500))</script>
</body></html>`

const receiptOf = (result: PreviewToolResult) => {
  const json = result.content[1]
  assert.ok(json?.type === 'text', `a receipt: ${JSON.stringify(result.content[0])}`)
  return JSON.parse(json.text)
}
const interaction = (raw: Record<string, unknown>): InteractArgs => {
  const request = parseInteraction({ ...raw, screenshot: false })
  if ('error' in request) assert.fail(request.error)
  return request
}
const textOf = (result: PreviewToolResult) =>
  result.content[0]?.type === 'text' ? result.content[0].text : ''
const listed = async (scope: { root: string; liveRoot: string; emitKey: string }) =>
  JSON.parse(textOf(await runPreviewVerify({ list: true }, scope))).receipts as {
    id: string
    verified: boolean
    current: boolean
    reason?: string
  }[]

/**
 * LOCAL-WEBKIT-2: `preview_verify` and element refs against a chat worktree's private
 * agent page in real offscreen WebKit, then the same checks in managed Chromium through
 * the real wrapper. The host asserts and records; the receipt is bound to the worktree's
 * exact source, the private server's generation and the document, goes stale on a
 * navigation and an edit, and a later run verifies the new source. A synthetic hover
 * never satisfies a :hover style; trusted Chromium input does. The user's preview keeps
 * its size, color scheme and route throughout.
 */
export async function checkAgentVerify(page_: Page, artifacts: string) {
  const active = nativeWorkspace.active
  assert.ok(active, 'an open project for the agent page')
  const live = previewServers.get(projectKey(active.root))
  assert.ok(live, 'the visible preview has a live server')
  const userBefore = await page_(USER_STATE)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-agent-verify-')))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Trezi', '-c', 'user.email=smoke@trezi.invalid', ...args],
      {
        cwd,
        stdio: 'pipe'
      }
    ).toString()
  const repo = join(scratch, 'repo')
  const tree = join(scratch, 'chat')
  mkdirSync(repo)
  writeFileSync(join(repo, 'index.html'), page('Base'))
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'worktree', 'add', '-q', '-b', 'chat', tree)
  writeFileSync(join(tree, 'index.html'), page('Agent verify'))
  const out = join(artifacts, 'agent-verify')
  mkdirSync(out, { recursive: true })
  setVerificationArtifactsRoot(join(scratch, 'receipts'))
  const scope = { root: tree, liveRoot: active.root, emitKey: KEY }
  const evidence: Record<string, unknown> = {}
  const keep = (name: string, receipt: { artifacts: { path: string }[] }) => {
    writeFileSync(join(out, `${name}.json`), JSON.stringify(receipt, null, 2))
    for (const artifact of receipt.artifacts)
      if (existsSync(artifact.path))
        copyFileSync(artifact.path, join(out, `${name}-${basename(artifact.path)}`))
  }
  const userUnchanged = async (phase: string) =>
    assert.equal(await page_(USER_STATE), userBefore, `${phase}: the user's preview is unchanged`)
  let browser: AgentBrowser | null = null
  let other: AgentBrowser | null = null
  try {
    // A verified WebKit receipt: a click, a condition wait, the dark scheme at 390 px.
    const first = await runPreviewVerify(
      {
        path: '/',
        viewport: { width: 390, height: 700, theme: 'dark' },
        steps: [{ action: 'click', selector: '#save' }],
        checks: [
          { kind: 'text', selector: '#status', equals: 'Saved', timeoutMs: 5000 },
          { kind: 'style', selector: 'body', name: 'background-color', equals: 'rgb(17, 17, 17)' },
          { kind: 'count', selector: 'li', equals: 3 },
          { kind: 'url', equals: '/' },
          { kind: 'title', equals: 'Verify' },
          { kind: 'noConsoleErrors' }
        ]
      },
      scope
    )
    const verified = receiptOf(first)
    keep('webkit-verified', verified)
    assert.equal(
      verified.verified,
      true,
      `${textOf(first)}\n${JSON.stringify(verified.checks)} ${verified.reason}`
    )
    assert.notEqual(first.isError, true)
    assert.equal(verified.engine, 'webkit')
    assert.equal(verified.input, 'synthetic-dom')
    assert.equal(verified.runtime.kind, 'private')
    assert.equal(verified.runtime.root, tree)
    assert.notEqual(
      new URL(verified.runtime.url).origin,
      new URL(live.url).origin,
      'its own server'
    )
    assert.match(verified.source.snapshot, /\S/)
    // The status changes 1.5 s after the click: the condition wait, not the first read, passed.
    assert.ok(verified.checks[0].ms >= 600, `the status changed later: ${verified.checks[0].ms} ms`)
    assert.deepEqual(
      verified.viewport.measured,
      { innerWidth: 390, innerHeight: 700, dark: true },
      'the receipt records what the page reported'
    )
    assert.deepEqual(verified.coverage.notCovered.slice(0, 3), ['Windows', 'Android', 'iOS'])
    assert.equal(verified.artifacts.length, 1)
    assert.match(verified.artifacts[0].sha256, /^[0-9a-f]{64}$/)
    const webkitShot = verified.artifacts[0]
    assert.ok(
      Math.abs(webkitShot.width / webkitShot.height - 390 / 700) < 0.02,
      `the screenshot is the 390×700 page: ${JSON.stringify(webkitShot)}`
    )
    assert.ok(
      first.content.some((c) => c.type === 'image'),
      'the screenshot is attached'
    )
    browser = await agentBrowser(KEY, tree, 'webkit', active.root)
    const size = (await browser.host.evaluate(
      "({ w: innerWidth, h: innerHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches })",
      'preview',
      2000
    )) as { w: number; h: number; dark: boolean }
    assert.deepEqual(
      size,
      { w: 390, h: 700, dark: true },
      'the agent page has its own size and scheme'
    )
    await userUnchanged('a dark 390 px agent run')
    assert.deepEqual(
      (await listed(scope)).map((r) => [r.id, r.current]),
      [[verified.id, true]],
      'the receipt holds while nothing moved'
    )

    // Synthetic hover never sets :hover: a :hover selector is refused, and a hover step
    // leaves a hover-only menu hidden (an honest failed receipt, not a pass).
    const hoverSelector = await runPreviewVerify(
      { checks: [{ kind: 'visible', selector: '.menu:hover .item' }] },
      scope
    )
    assert.equal(hoverSelector.isError, true)
    assert.match(textOf(hoverSelector), /:hover.*engine "chromium"/)
    const hovered = await runPreviewVerify(
      {
        steps: [{ action: 'hover', selector: '.menu' }],
        checks: [{ kind: 'visible', selector: '.menu .item' }]
      },
      scope
    )
    const hoverReceipt = receiptOf(hovered)
    keep('webkit-hover', hoverReceipt)
    assert.deepEqual([hoverReceipt.verified, hoverReceipt.reason], [false, 'checks-failed'])
    assert.equal(hovered.isError, true)

    // Refs: issued for this page and document, refused by another session, stale after a reload.
    const refs = await interactionReport(browser, interaction({ action: 'refs' }))
    assert.equal(refs.ok, true, JSON.stringify(refs))
    const save = (refs.refs as { ref: string; text?: string; element: string }[]).find(
      (r) => r.element === 'button#save' && r.text === 'Save'
    )
    assert.ok(save, JSON.stringify(refs.refs))
    assert.match(save.ref, /^[0-9a-f]{8}:e\d+$/)
    assert.equal(
      JSON.stringify(refs).includes('"document"'),
      false,
      "the page's document id stays in the host"
    )
    const byRef = receiptOf(
      await runPreviewVerify({ checks: [{ kind: 'visible', ref: save.ref }] }, scope)
    )
    assert.equal(byRef.verified, true, JSON.stringify(byRef.checks))
    other = await agentBrowser(OTHER, tree, 'webkit', active.root)
    assert.notEqual(other.id, browser.id)
    const foreign = await interactionReport(other, interaction({ action: 'click', ref: save.ref }))
    assert.equal(foreign.ok, false)
    assert.match(String(foreign.error), /not issued by this session's agent browser/)
    const otherList = JSON.parse(
      textOf(await runPreviewVerify({ list: true }, { ...scope, emitKey: OTHER }))
    )
    assert.deepEqual(otherList.receipts, [], "another session never sees this session's receipts")
    await browser.open('/', { reload: true })
    const stale = await interactionReport(browser, interaction({ action: 'click', ref: save.ref }))
    assert.equal(stale.ok, false)
    assert.match(String(stale.error), /stale/)
    const afterReload = await listed(scope)
    assert.equal(afterReload.find((r) => r.id === verified.id)?.reason, 'navigated')
    evidence.refs = { save, foreign: foreign.error, stale: stale.error }

    // An edit to the worktree invalidates every receipt; a new run verifies the new source.
    writeFileSync(join(tree, 'index.html'), page('Agent verify edited'))
    const afterEdit = await listed(scope)
    assert.deepEqual(
      afterEdit.filter((r) => r.verified).map((r) => r.reason),
      afterEdit.filter((r) => r.verified).map(() => 'source-changed'),
      JSON.stringify(afterEdit)
    )
    const fresh = receiptOf(
      await runPreviewVerify(
        {
          checks: [{ kind: 'text', selector: 'h1', equals: 'Agent verify edited', timeoutMs: 5000 }]
        },
        scope
      )
    )
    keep('webkit-after-edit', fresh)
    assert.equal(fresh.verified, true, JSON.stringify(fresh))
    assert.notEqual(fresh.source.snapshot, verified.source.snapshot, 'a new exact source')
    evidence.lists = { afterReload, afterEdit }
    await userUnchanged('refs, a reload and an edit')

    // The same server through managed Chromium: trusted hover sets :hover.
    const chromium = await runPreviewVerify(
      {
        engine: 'chromium',
        path: '/',
        viewport: { width: 390, height: 700, theme: 'dark' },
        steps: [
          { action: 'click', selector: '#save' },
          { action: 'hover', selector: '.menu' }
        ],
        checks: [
          { kind: 'text', selector: '#status', equals: 'Saved', timeoutMs: 6000 },
          { kind: 'visible', selector: '.menu:hover .item' },
          { kind: 'style', selector: 'body', name: 'background-color', equals: 'rgb(17, 17, 17)' },
          { kind: 'text', selector: 'h1', equals: 'Agent verify edited' },
          { kind: 'noConsoleErrors' }
        ]
      },
      scope
    )
    const crReceipt = receiptOf(chromium)
    keep('chromium', crReceipt)
    assert.equal(
      crReceipt.verified,
      true,
      `${textOf(chromium)}\n${JSON.stringify({ steps: crReceipt.steps, checks: crReceipt.checks })}`
    )
    assert.equal(crReceipt.engine, 'chromium')
    assert.equal(crReceipt.input, 'cdp-trusted')
    assert.equal(crReceipt.runtime.url, verified.runtime.url, 'the same private server')
    assert.equal(crReceipt.source.snapshot, fresh.source.snapshot, 'the same exact source')
    assert.match(crReceipt.engineDetail, /agent-browser/)
    assert.equal(crReceipt.artifacts[0]?.mimeType, 'image/png')
    const shot = crReceipt.artifacts[0]
    assert.ok(
      shot?.width >= 390 && Math.abs(shot.width / shot.height - 390 / 700) < 0.02,
      JSON.stringify(shot)
    )
    await userUnchanged('a managed Chromium run')
    evidence.receipts = {
      verified: verified.id,
      hover: hoverReceipt.id,
      fresh: fresh.id,
      chromium: { id: crReceipt.id, detail: crReceipt.engineDetail }
    }
    writeFileSync(join(out, 'agent-verify.json'), JSON.stringify(evidence, null, 2))
    console.log(
      `Native agent verify: WebKit receipts bound to ${tree}'s private server and exact source (stale after a reload and an edit, verified again after), refs scoped and stale-checked, synthetic hover refused/failed, managed Chromium verified the same source with trusted hover; user preview unchanged. Artifacts: ${out}`
    )
  } finally {
    clearReceipts(receiptSession(KEY, projectKey(tree)))
    clearReceipts(receiptSession(OTHER, projectKey(tree)))
    setVerificationArtifactsRoot(null)
    if (browser) await closeAgentBrowser(privateName(KEY, tree))
    if (other) await closeAgentBrowser(privateName(OTHER, tree))
    for (const runtime of agentRuntimes()) await stopAgentRuntime(runtime.agent)
    rmSync(scratch, { recursive: true, force: true })
  }
}

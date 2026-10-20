import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentBrowser,
  agentBrowser,
  closeAgentBrowser,
  privateName
} from '../main/agent-browser'
import { agentRuntimes, stopAgentRuntime } from '../main/agent-runtime'
import { previewServers } from '../main/preview-evidence'
import { runPreviewVerify } from '../main/preview-verify'
import {
  clearReceipts,
  receiptSession,
  setVerificationArtifactsRoot
} from '../main/verification-receipts'
import { projectKey } from '../shared/projectKey'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const HEADING = "document.querySelector('h1')?.textContent ?? null"
const KEY = 'native-agent-navigation'
const ROUNDS = 20
const page = (heading: string) =>
  `<!doctype html><html><head><title>Navigation</title><link rel="icon" href="data:,"></head><body><h1>${heading}</h1></body></html>`
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * LOCAL-WEBKIT-PUBLISH: an agent's `open` is answered by the navigation it started, never
 * by the cancel (NSURLErrorDomain -999) of another one. The private page also navigates by
 * itself: the static server's live reload calls `location.reload()` after every file
 * change, and WebKit cancels whichever navigation was in flight. So `open` is raced against
 * the page's own reload (staggered so either one starts first) and against a file write
 * (the live reload), and every open must still resolve loaded, with no raw cancel error.
 * A final `preview_verify` of that source must verify.
 */
export async function checkAgentNavigation(artifacts: string) {
  const active = nativeWorkspace.active
  assert.ok(active, 'an open project for the agent page')
  assert.ok(previewServers.get(projectKey(active.root)), 'the visible preview has a live server')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-agent-navigation-')))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Trezi', '-c', 'user.email=smoke@trezi.invalid', ...args],
      { cwd, stdio: 'pipe' }
    ).toString()
  const repo = join(scratch, 'repo')
  const tree = join(scratch, 'chat')
  mkdirSync(repo)
  writeFileSync(join(repo, 'index.html'), page('Base'))
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'worktree', 'add', '-q', '-b', 'chat', tree)
  setVerificationArtifactsRoot(join(scratch, 'receipts'))
  const scope = { root: tree, liveRoot: active.root, emitKey: KEY }
  const evidence: Record<string, unknown> = { rounds: ROUNDS }
  let browser: AgentBrowser | null = null
  try {
    writeFileSync(join(tree, 'index.html'), page('Start'))
    browser = await agentBrowser(KEY, tree, 'webkit', active.root)
    const first = await browser.open('/')
    assert.equal(first.loaded, true)
    const agent = browser
    const reloadPage = () =>
      agent.host.evaluate('location.reload()', 'preview', 1000).catch(() => null)
    const openReload = () => agent.open('/', { reload: true })

    // Reload and open started together, the page's reload first on odd rounds. The
    // stagger only varies which navigation is in flight when the other starts.
    for (let i = 0; i < ROUNDS; i++) {
      const stagger = (i % 5) * 6
      const [opened] = await Promise.all([
        i % 2 ? wait(stagger).then(openReload) : openReload(),
        i % 2 ? reloadPage() : wait(stagger).then(reloadPage)
      ])
      assert.equal(opened.loaded, true, `round ${i}: open resolved loaded`)
      assert.equal(new URL(opened.url).pathname, '/', `round ${i}: route`)
    }

    // A write (the live reload) with the open straight after it, as an agent edits then checks.
    for (let i = 0; i < ROUNDS; i++) {
      writeFileSync(join(tree, 'index.html'), page(`Edit ${i}`))
      const opened = await openReload()
      assert.equal(opened.loaded, true, `write round ${i}: open resolved loaded`)
    }

    // The last write's live reload has landed once the page shows it; then nothing is
    // left to navigate and the receipt below checks a settled document.
    writeFileSync(join(tree, 'index.html'), page('Final'))
    const shown = () => agent.host.evaluate(HEADING, 'preview', 1000).catch(() => null)
    await waitFor(
      async () => (await shown()) === 'Final',
      'the live reload shows the last edit',
      6000
    ).catch(() => openReload())
    assert.equal(await shown(), 'Final')

    const result = await runPreviewVerify(
      { path: '/', checks: [{ kind: 'text', selector: 'h1', equals: 'Final', timeoutMs: 3000 }] },
      scope
    )
    const json = result.content[1]
    assert.ok(json?.type === 'text', `a receipt: ${JSON.stringify(result.content[0])}`)
    const receipt = JSON.parse(json.text)
    assert.equal(receipt.verified, true, `${JSON.stringify(receipt.checks)} ${receipt.reason}`)
    evidence.receipt = { id: receipt.id, verified: receipt.verified, engine: receipt.engine }
    writeFileSync(join(artifacts, 'agent-navigation.json'), JSON.stringify(evidence, null, 2))
    console.log(
      `Native agent navigation: ${ROUNDS} opens raced the page's own reload and ${ROUNDS} opens followed a file write; every open resolved loaded (no -999) and the final receipt verified.`
    )
  } finally {
    clearReceipts(receiptSession(KEY, projectKey(tree)))
    setVerificationArtifactsRoot(null)
    if (browser) await closeAgentBrowser(privateName(KEY, tree))
    for (const runtime of agentRuntimes()) await stopAgentRuntime(runtime.agent)
    rmSync(scratch, { recursive: true, force: true })
  }
}

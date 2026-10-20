import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentBrowser,
  agentBrowser,
  closeAgentBrowser,
  privateName,
  releaseAgentBrowsersFor
} from '../main/agent-browser'
import { agentRuntimes, stopAgentRuntime } from '../main/agent-runtime'
import { previewServers } from '../main/preview-evidence'
import type { PreviewIdentity } from '../main/preview-identity'
import { projectKey } from '../shared/projectKey'
import type { NativeBridge } from './bridge'
import { bridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

type Page = (code: string) => Promise<unknown>
const KEY = 'native-agent-runtime'
const USER_STATE =
  'JSON.stringify({url:location.href,width:innerWidth,x:scrollX,y:scrollY,selection:getSelection()?.toString(),title:document.title})'
const HEADING = "document.querySelector('h1')?.textContent ?? null"

/**
 * LOCAL-WEBKIT-1: two agents' private pages, each loading its own worktree from its own
 * private dev server, while the user's preview, project, live server and focus stay as
 * they were. The worktrees share one HEAD and differ only in uncommitted files, so the
 * pages' source identities must differ by content, not by revision. A base change and
 * an edit make the edited page unverified until it loads the new source; closing and
 * releasing stop the private servers and never the visible one.
 */
export async function checkAgentRuntime(host: NativeBridge, page: Page, artifacts: string) {
  const active = nativeWorkspace.active
  assert.ok(active, 'an open project for the private runtimes')
  const live = previewServers.get(projectKey(active.root))
  assert.ok(live, 'the visible preview has a live server')
  const liveOrigin = new URL(live.url).origin
  const userBefore = await page(USER_STATE)
  const focusBefore = (await bridge().request('smokeFocusSnapshot')) as Record<string, unknown>
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-agent-runtime-')))
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
  const pathA = join(scratch, 'agent-a')
  const pathB = join(scratch, 'agent-b')
  mkdirSync(repo)
  writeFileSync(join(repo, 'index.html'), '<!doctype html><title>base</title><h1>Base</h1>')
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'worktree', 'add', '-q', '-b', 'agent-a', pathA)
  git(repo, 'worktree', 'add', '-q', '-b', 'agent-b', pathB)
  const html = (text: string) => `<!doctype html><title>${text}</title><h1>${text}</h1>`
  writeFileSync(join(pathA, 'index.html'), html('Agent A'))
  writeFileSync(join(pathB, 'index.html'), html('Agent B'))
  const evidence: Record<string, unknown> = { live: { url: live.url, pid: live.pid } }
  const heading = (browser: AgentBrowser) => browser.host.evaluate(HEADING, 'preview', 1000)
  const userUnchanged = async (phase: string) => {
    assert.equal(await page(USER_STATE), userBefore, `${phase}: the user's preview is unchanged`)
    assert.equal(nativeWorkspace.active?.root, active.root, `${phase}: the project is unchanged`)
    const server = previewServers.get(projectKey(active.root))
    assert.deepEqual([server?.url, server?.pid], [live.url, live.pid], `${phase}: live server`)
    const focus = (await bridge().request('smokeFocusSnapshot')) as Record<string, unknown>
    for (const field of ['frontmostPID', 'key', 'responder', 'resignCount', 'keyLostCount'])
      assert.equal(focus[field], focusBefore[field], `${phase}: focus ${field} changed`)
  }
  const summary = (identity: PreviewIdentity) => ({
    session: identity.session,
    navigation: identity.navigation,
    stale: identity.stale,
    runtime: identity.runtime,
    source: identity.source
  })
  let a: AgentBrowser | null = null
  let b: AgentBrowser | null = null
  try {
    // A chat and its spawn share one key; their worktrees make them two private pages.
    a = await agentBrowser(KEY, pathA, 'webkit', active.root)
    b = await agentBrowser(KEY, pathB, 'webkit', active.root)
    assert.notEqual(a, b)
    assert.equal(a.runtime, 'private')
    const [openedA, openedB] = await Promise.all([a.open('/'), b.open('/')])
    const originA = new URL(openedA.url).origin
    const originB = new URL(openedB.url).origin
    assert.equal(new Set([originA, originB, liveOrigin]).size, 3, 'three distinct servers')
    for (const origin of [originA, originB]) assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(await heading(a), 'Agent A')
    assert.equal(await heading(b), 'Agent B')
    for (const [opened, root] of [
      [openedA, pathA],
      [openedB, pathB]
    ] as const) {
      assert.equal(opened.identity.source?.verified, true, JSON.stringify(opened.identity))
      assert.equal(opened.identity.runtime?.kind, 'private')
      assert.equal(opened.identity.runtime?.root, root)
      assert.equal(new URL(opened.identity.runtime?.url ?? '').origin, new URL(opened.url).origin)
    }
    assert.equal(openedA.identity.source?.head, openedB.identity.source?.head, 'one HEAD')
    assert.notEqual(
      openedA.identity.source?.served,
      openedB.identity.source?.served,
      'different uncommitted source, different identity'
    )
    evidence.opened = { a: summary(openedA.identity), b: summary(openedB.identity) }
    await userUnchanged('open two private pages')

    // A base change (a commit, outside the served files) leaves the document unverified.
    git(pathA, 'commit', '-q', '--allow-empty', '-m', 'base moves')
    const moved = await a.identity()
    assert.equal(moved.source?.verified, false)
    assert.equal(moved.source?.reason, 'source-changed')
    assert.equal((await b.identity()).source?.verified, true, 'the other worktree is unaffected')
    const reloaded = await a.open('/', { reload: true })
    assert.equal(reloaded.identity.source?.verified, true, 'a reload verifies the new source')
    evidence.baseChange = { stale: summary(moved), reloaded: summary(reloaded.identity) }

    // An edit: never verified while the page shows the old file; live reload (or an
    // explicit reload) loads it, and only then is it verified again.
    writeFileSync(join(pathA, 'index.html'), html('Agent A edited'))
    const edited = await a.identity()
    if (edited.source?.verified) assert.equal(await heading(a), 'Agent A edited')
    let path = 'live-reload'
    const fresh = await waitFor(
      async () => {
        const identity = await a?.identity()
        return identity?.source?.verified && (await heading(a as AgentBrowser)) === 'Agent A edited'
          ? identity
          : null
      },
      'the edited worktree reloads in its private page',
      6000
    ).catch(async () => {
      path = 'reload'
      return (await (a as AgentBrowser).open('/', { reload: true })).identity
    })
    assert.equal(await heading(a), 'Agent A edited')
    assert.equal(fresh.source?.verified, true)
    assert.notEqual(fresh.source?.served, reloaded.identity.source?.served)
    assert.equal(await heading(b), 'Agent B', 'the other page is untouched')
    evidence.edit = { immediately: summary(edited), loadedBy: path, fresh: summary(fresh) }
    await userUnchanged('edit and reload a private page')

    const [shotA, shotB] = await Promise.all([a.capture(), b.capture()])
    assert.ok(shotA?.jpeg.length && shotB?.jpeg.length, 'private page snapshots')
    writeFileSync(join(artifacts, 'agent-runtime-a.jpg'), shotA.jpeg)
    writeFileSync(join(artifacts, 'agent-runtime-b.jpg'), shotB.jpeg)
    writeFileSync(
      join(artifacts, 'agent-runtime-shell.png'),
      Buffer.from((await host.request('captureShell')) as string, 'base64')
    )

    // Closing A stops its server only; releasing B's worktree (its session closed) stops B's.
    const urlA = openedA.url
    const urlB = openedB.url
    await closeAgentBrowser(privateName(KEY, pathA))
    a = null
    const refused = async (url: string) =>
      fetch(url, { signal: AbortSignal.timeout(2000) }).then(
        () => false,
        () => true
      )
    assert.ok(await refused(urlA), "a closed page's private server stops")
    const servingB = await fetch(urlB, { signal: AbortSignal.timeout(2000) })
    assert.match(await servingB.text(), /Agent B/)
    assert.equal(await releaseAgentBrowsersFor(pathB), 1)
    b = null
    assert.ok(await refused(urlB), "a released worktree's private server stops")
    assert.deepEqual(agentRuntimes(), [], 'no private runtime is left')
    await userUnchanged('close and release private pages')
    const liveAnswer = await fetch(live.url, { signal: AbortSignal.timeout(5000) })
    assert.ok(liveAnswer.status < 500, 'the visible server still answers')
    evidence.closed = { urlA, urlB, liveStatus: liveAnswer.status }
    writeFileSync(join(artifacts, 'agent-runtime.json'), JSON.stringify(evidence, null, 2))
    console.log(
      'Native agent runtimes: two private WebKit pages served their own worktrees (same HEAD, different source), a base change and an edit were unverified until reloaded, and the user preview, project, live server and focus were untouched.'
    )
  } finally {
    if (a) await closeAgentBrowser(privateName(KEY, pathA))
    if (b) await closeAgentBrowser(privateName(KEY, pathB))
    for (const runtime of agentRuntimes()) await stopAgentRuntime(runtime.agent)
    rmSync(scratch, { recursive: true, force: true })
  }
}

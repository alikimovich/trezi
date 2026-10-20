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
import { bridge } from './bridge'
import { checkProvisionalCancel } from './smoke-agent-navigation-gate'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const HEADING = "document.querySelector('h1')?.textContent ?? null"
const KEY = 'native-agent-navigation'
const CLOSING = 'native-agent-navigation-closing'
const ROUNDS = 20
const STALE_MESSAGE = 'The network connection was lost.'
const page = (heading: string) =>
  `<!doctype html><html><head><title>Navigation</title><link rel="icon" href="data:,"></head><body><h1>${heading}</h1></body></html>`
// Two loads that never finish on their own: the live-reload stream is a script and an
// image that never complete, so the document stays loading until another navigation
// replaces it. `hold.html` holds only the load that follows `sessionStorage.hold = '1'`
// (and clears the flag, so the open that replaces it loads normally). `self.html` holds
// and reloads itself the first time it is opened with a given query.
const HOLD = `var hold = '/__trezi_reload?v=hold'
  var script = document.createElement('script'); script.src = hold; document.head.appendChild(script)
  var image = document.createElement('img'); image.src = hold; document.head.appendChild(image)`
const holding = `<!doctype html><html><head><title>Held</title><link rel="icon" href="data:,">
<script>
(function () {
  var held = sessionStorage.getItem('hold') === '1'
  sessionStorage.removeItem('hold')
  if (!held) return
  document.documentElement.dataset.held = '1'
  ${HOLD}
})()
</script></head><body><h1>Held</h1></body></html>`
const selfReloading = `<!doctype html><html><head><title>Self reload</title><link rel="icon" href="data:,">
<script>
(function () {
  var seen = 'reloaded:' + location.search
  if (sessionStorage.getItem(seen)) return
  sessionStorage.setItem(seen, '1')
  ${HOLD}
  location.reload()
})()
</script></head><body><h1>Reloaded</h1></body></html>`

interface HostOpen {
  url: string
  loaded: boolean
}
interface NavigationEvent {
  view?: string
  phase?: string
  message?: string
  url?: string
  stale?: boolean
}

/**
 * LOCAL-WEBKIT-PUBLISH: an agent's `open` is answered by the navigation it started, never
 * by the cancel (NSURLErrorDomain -999) of another one. WebKit cancels whichever
 * navigation is in flight when another starts, and the private page navigates by itself
 * too (the static server's live reload, a script's `location.reload()`). Each phase runs
 * on its own and the failures are reported together; the run fails if any phase did:
 *
 * 1. provisional cancel (`./smoke-agent-navigation-gate`): a page's own navigation held
 *    provisional by a fixture dev server is replaced by the agent's open, so WebKit really
 *    cancels it (-999). The open must resolve loaded on its own route and the cancel must be
 *    reported as not the open's (`stale`); the old routing rejected the open with it. A
 *    second part delivers a `stale` failure on the bridge while an open is held (synthetic
 *    Bun-state coverage, not a native error).
 * 2. supersede: two opens sent back to back; the second must resolve loaded on its own
 *    route, ROUNDS times, and only the replaced navigation may be reported cancelled. WebKit
 *    replaces the first load before it starts, so no cancel is reported here (observed):
 *    the count is recorded, not required.
 * 3. committed page replaced: a reload held in flight after it committed is replaced by
 *    the open's load; WebKit reports no failure for it and the open's own navigation
 *    answers.
 * 4. hard reload (caches clear asynchronously): superseded by another open it must not
 *    start a navigation of its own or answer the newer open; closed meanwhile it is
 *    rejected.
 * 5. page-initiated: a page that reloads itself during its own open.
 * 6. opens raced against the page's reload and straight after file writes (live reload).
 * 7. a final `preview_verify` of the exact source verifies.
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
  const failures: string[] = []
  let browser: AgentBrowser | null = null
  let observe: ((event: NavigationEvent) => void) | null = null
  let onLoaded: ((event: { view?: string }) => void) | null = null
  try {
    // Written before the page exists, so no live reload of an older page lands in a round.
    writeFileSync(join(tree, 'index.html'), page('Start'))
    writeFileSync(join(tree, 'hold.html'), holding)
    writeFileSync(join(tree, 'self.html'), selfReloading)
    writeFileSync(join(tree, 'other.html'), page('Other'))
    browser = await agentBrowser(KEY, tree, 'webkit', active.root)
    const agent = browser
    const view = `agent:${agent.id}`
    const first = await agent.open('/')
    assert.equal(first.loaded, true)
    const origin = new URL(first.url).origin
    const hostOpen = (url: string, hard = false, target = view) =>
      bridge().request(
        'agentBrowserOpen',
        { view: target, url, reload: hard, hard },
        11_000
      ) as Promise<HostOpen>

    // What the host reported for this page, newest last (the notices Bun keeps are capped).
    const trace: string[] = []
    let starts = 0
    const cancels: string[] = []
    observe = (event) => {
      if (event.view !== view) return
      trace.push(
        `${event.phase}${event.message ? `:${event.message}` : ''}${event.stale ? ':stale' : ''} ${(event.url ?? '').replace(origin, '')}`
      )
      if (event.phase === 'start') starts++
      if (event.phase === 'failed' && event.message === 'cancelled') cancels.push(event.url ?? '')
    }
    bridge().on('agent-navigation', observe)
    onLoaded = (event: { view?: string }) => {
      if (event.view === view) trace.push('loaded')
    }
    bridge().on('loaded', onLoaded)

    const phase = async (name: string, run: () => Promise<void>) => {
      try {
        await run()
      } catch (error) {
        const message = `${name}: ${(error as Error).message} (host events: ${trace.slice(-16).join(' | ')})`
        failures.push(message)
        console.log(`Native agent navigation phase failed — ${message}`)
      }
    }
    const reloadPage = () =>
      agent.host.evaluate('location.reload()', 'preview', 1000).catch(() => null)
    const openReload = () => agent.open('/', { reload: true })
    const shown = (code = HEADING) => agent.host.evaluate(code, 'preview', 1000).catch(() => null)
    /** The shown `hold.html` reloads itself and that reload is held in flight, committed. */
    const holdReload = async (query: string) => {
      const settled = await agent.open(`/hold.html${query}`, { reload: true })
      assert.equal(settled.loaded, true, 'the page to hold opened')
      // One expression: the host evaluates `await (code)`, so two statements would not parse.
      await agent.host
        .evaluate("(sessionStorage.setItem('hold', '1'), location.reload())", 'preview', 1000)
        .catch(() => null)
      await waitFor(
        async () => (await shown('document.documentElement.dataset.held ?? null')) === '1',
        'the page reload is held in flight',
        5000
      )
    }

    await phase('provisional cancel', async () => {
      evidence.provisionalCancel = await checkProvisionalCancel(
        scratch,
        active.root,
        git,
        STALE_MESSAGE
      )
    })

    await phase('supersede', async () => {
      // Two opens sent back to back: the second open's load replaces the first's. If WebKit
      // reports the cancel (-999) of the first, it must not answer the second open (the old
      // routing did). Every round must resolve the second open on its own route.
      let cancelledRounds = 0
      for (let i = 0; i < ROUNDS; i++) {
        const cancelsBefore = cancels.length
        const [replaced, opened] = await Promise.allSettled([
          hostOpen(`${origin}/hold.html?a=${i}`),
          hostOpen(`${origin}/hold.html?b=${i}`)
        ])
        assert.equal(replaced.status, 'rejected', `round ${i}: the replaced open was rejected`)
        assert.match(String((replaced as PromiseRejectedResult).reason), /superseded/)
        assert.equal(
          opened.status,
          'fulfilled',
          `round ${i}: the second open: ${JSON.stringify(opened)}`
        )
        const done = new URL((opened as PromiseFulfilledResult<HostOpen>).value.url)
        assert.equal(done.pathname + done.search, `/hold.html?b=${i}`, `round ${i}: route`)
        assert.equal(await shown('location.search'), `?b=${i}`, `round ${i}: its page is shown`)
        const cancelled = cancels.slice(cancelsBefore)
        assert.ok(
          cancelled.every((url) => !url.includes(`b=${i}`)),
          `round ${i}: only the replaced navigation was cancelled: ${cancelled.join(' ')}`
        )
        if (cancelled.length) cancelledRounds++
      }
      // Observed natively (verify run 5): the first load is replaced before WebKit starts it,
      // so no cancel is reported in these rounds (0 of 20); the provisional-cancel phase
      // above is the one that makes WebKit cancel a navigation. The count is recorded only.
      evidence.supersede = { opens: ROUNDS, roundsWithObservedCancel: cancelledRounds }
    })

    await phase('committed page replaced', async () => {
      // A reload held in flight after it committed is replaced by the open's load. WebKit
      // reports no failure for it (observed), so the open's own navigation must answer.
      let replaced = 0
      for (let i = 0; i < 5; i++) {
        await holdReload(`?round=${i}`)
        const startsBefore = starts
        const opened = await agent.open(`/hold.html?round=${i}`, { reload: true })
        assert.equal(opened.loaded, true, `round ${i}: open resolved loaded`)
        assert.equal(new URL(opened.url).pathname, '/hold.html', `round ${i}: route`)
        assert.equal(await shown(), 'Held', `round ${i}: the open's page is shown`)
        assert.ok(starts > startsBefore, `round ${i}: the open's own navigation started`)
        replaced++
      }
      evidence.committedReplaced = { opens: replaced, cancelsObserved: cancels.length }
    })

    await phase('hard reload', async () => {
      // Superseded while its caches clear, the hard reload must not load: that load would
      // cancel the newer open's and could answer it with the wrong page.
      const startsBeforeHard = starts
      const [hard, newer] = await Promise.allSettled([
        hostOpen(`${origin}/`, true),
        hostOpen(`${origin}/other.html`)
      ])
      assert.equal(hard.status, 'rejected', 'the superseded hard reload was rejected')
      assert.match(String((hard as PromiseRejectedResult).reason), /superseded/)
      assert.equal(newer.status, 'fulfilled', `the newer open resolved: ${JSON.stringify(newer)}`)
      assert.equal(
        new URL((newer as PromiseFulfilledResult<HostOpen>).value.url).pathname,
        '/other.html'
      )
      assert.equal(await shown('location.pathname'), '/other.html')
      assert.equal(
        starts - startsBeforeHard,
        1,
        'the superseded hard reload started no navigation of its own'
      )
      // The same for a page closed while its caches clear (a page of its own, so this one stays).
      await bridge().request('agentBrowserCreate', { session: CLOSING })
      const closingOpen = hostOpen(`${origin}/`, true, `agent:${CLOSING}`).catch(
        (error) => error as Error
      )
      await bridge().request('agentBrowserClose', { session: CLOSING })
      assert.match(
        String(await closingOpen),
        /closed/,
        'a hard reload of a page closed meanwhile is rejected'
      )
      evidence.hardReload = {
        supersededRejected: true,
        newerOwnUrl: '/other.html',
        closedRejected: true
      }
    })

    await phase('page-initiated reload', async () => {
      for (let i = 0; i < 5; i++) {
        const opened = await agent.open(`/self.html?round=${i}`, { reload: true })
        assert.equal(opened.loaded, true, `round ${i}: open resolved loaded`)
        assert.equal(new URL(opened.url).pathname, '/self.html', `round ${i}: route`)
        assert.equal(await shown(), 'Reloaded', `round ${i}: the reloaded page is shown`)
      }
    })

    await phase('races', async () => {
      // Reload and open started together; which one is issued first alternates.
      for (let i = 0; i < ROUNDS; i++) {
        const reload = i % 2 ? reloadPage() : null
        const opening = openReload()
        const [opened] = await Promise.all([opening, reload ?? reloadPage()])
        assert.equal(opened.loaded, true, `round ${i}: open resolved loaded`)
        assert.equal(new URL(opened.url).pathname, '/', `round ${i}: route`)
      }
      // A write (the live reload) with the open straight after it, as an agent edits then checks.
      for (let i = 0; i < ROUNDS; i++) {
        writeFileSync(join(tree, 'index.html'), page(`Edit ${i}`))
        const opened = await openReload()
        assert.equal(opened.loaded, true, `write round ${i}: open resolved loaded`)
      }
    })

    await phase('receipt', async () => {
      // The last write's live reload has landed once the page shows it; then nothing is
      // left to navigate and the receipt below checks a settled document.
      writeFileSync(join(tree, 'index.html'), page('Final'))
      await waitFor(
        async () => (await shown()) === 'Final',
        'the live reload shows the last edit',
        6000
      )
      const result = await runPreviewVerify(
        {
          path: '/',
          checks: [{ kind: 'text', selector: 'h1', equals: 'Final', timeoutMs: 3000 }]
        },
        scope
      )
      const json = result.content[1]
      assert.ok(json?.type === 'text', `a receipt: ${JSON.stringify(result.content[0])}`)
      const receipt = JSON.parse(json.text)
      assert.equal(receipt.verified, true, `${JSON.stringify(receipt.checks)} ${receipt.reason}`)
      evidence.receipt = { id: receipt.id, verified: receipt.verified, engine: receipt.engine }
    })

    evidence.cancelsObserved = cancels.length
    evidence.failures = failures
    evidence.hostEvents = trace.slice(-40)
    writeFileSync(join(artifacts, 'agent-navigation.json'), JSON.stringify(evidence, null, 2))
    assert.deepEqual(failures, [], `agent navigation phases failed:\n${failures.join('\n')}`)
    console.log(
      `Native agent navigation: opens that really cancelled a provisional page navigation, ${ROUNDS} superseded opens and held-reload replacements each resolved loaded on their own route; a (synthetic) stale failure kept the load and source capture; a superseded and a closed hard reload never loaded; the final receipt verified.`
    )
  } finally {
    if (observe) bridge().off('agent-navigation', observe)
    if (onLoaded) bridge().off('loaded', onLoaded)
    await bridge()
      .request('agentBrowserClose', { session: CLOSING })
      .catch(() => {})
    clearReceipts(receiptSession(KEY, projectKey(tree)))
    setVerificationArtifactsRoot(null)
    if (browser) await closeAgentBrowser(privateName(KEY, tree))
    for (const runtime of agentRuntimes()) await stopAgentRuntime(runtime.agent)
    rmSync(scratch, { recursive: true, force: true })
  }
}

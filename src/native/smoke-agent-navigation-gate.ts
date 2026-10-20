import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentBrowser, closeAgentBrowser, privateName } from '../main/agent-browser'
import { bridge } from './bridge'
import { waitFor } from './smoke-wait'

/**
 * LOCAL-WEBKIT-PUBLISH: the test-only dev server behind the `agent-navigation` smoke's
 * provisional-cancel phase. It lives in a disposable worktree and is started by the
 * ordinary private agent runtime (`bun run dev`, the worktree's own detection); nothing of
 * it ships. `/gate/hold` accepts a request and sends no headers, so the main-frame
 * navigation to it stays provisional until the test releases it (`/__ctl/release`) or
 * WebKit cancels it; `/__ctl/held` lists what is held.
 */
const SERVER = `import { createServer } from 'node:http'
const held = new Map()
let next = 0
const page = (title) => '<!doctype html><html><head><title>Gate</title><link rel="icon" href="data:,"></head><body><h1>' + title + '</h1></body></html>'
const send = (res, body, type = 'text/html; charset=utf-8') => {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}
createServer((req, res) => {
  const url = new URL(req.url, 'http://gate')
  if (url.pathname === '/__ctl/held') return send(res, JSON.stringify([...held.values()].map((entry) => entry.url)), 'application/json')
  if (url.pathname === '/__ctl/release') {
    const count = held.size
    for (const [id, entry] of held) {
      held.delete(id)
      send(entry.res, page('Released ' + entry.url))
    }
    return send(res, JSON.stringify({ released: count }), 'application/json')
  }
  if (url.pathname === '/gate/hold') {
    const id = ++next
    held.set(id, { url: req.url, res })
    res.on('close', () => held.delete(id))
    return
  }
  send(res, page('Page ' + req.url))
}).listen(Number(process.env.PORT), process.env.HOST, () => console.log('Local: http://' + process.env.HOST + ':' + process.env.PORT + '/'))
`

const GATE_KEY = 'native-agent-navigation-gate'
const HEADING = "document.querySelector('h1')?.textContent ?? null"
const ROUNDS = 10

export interface GateNavigationEvent {
  view?: string
  phase?: string
  message?: string
  url?: string
  stale?: boolean
}

/**
 * The original -999, made deterministic with a real WKWebView. The page starts a
 * navigation of its own (the live reload's `location.reload()` in the field) to a
 * same-origin URL whose response the server holds before any header, so it is still
 * provisional when the agent's `open` loads and WebKit cancels it (NSURLErrorDomain -999,
 * `didFailProvisionalNavigation`). The open must resolve loaded on its own route; the
 * cancelled navigation must be reported as a cancel the open does not own (`stale`); the
 * old routing rejected the open with that cancel. Then, with the open's own response held
 * too, a failure flagged `stale` is delivered on the bridge while it is pending: that part
 * is synthetic Bun-state coverage (the host cannot be made to deliver a real stale
 * non-cancel failure, as one main-frame navigation replaces the other), not a native error.
 */
export async function checkProvisionalCancel(
  scratch: string,
  liveRoot: string,
  git: (cwd: string, ...args: string[]) => string,
  staleMessage: string
) {
  const repo = join(scratch, 'gate-repo')
  const tree = join(scratch, 'gate-chat')
  mkdirSync(repo)
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'agent-navigation-gate',
      private: true,
      packageManager: 'bun@1.3.13',
      scripts: { dev: 'bun server.mjs' }
    })
  )
  writeFileSync(join(repo, 'server.mjs'), SERVER)
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'gate')
  git(repo, 'worktree', 'add', '-q', '-b', 'chat', tree)
  const agent = await agentBrowser(GATE_KEY, tree, 'webkit', liveRoot)
  const view = `agent:${agent.id}`
  const events: GateNavigationEvent[] = []
  const listen = (event: GateNavigationEvent) => {
    if (event.view === view) events.push(event)
  }
  bridge().on('agent-navigation', listen)
  try {
    const first = await agent.open('/')
    assert.equal(first.loaded, true, 'the gate page opened')
    const origin = new URL(first.url).origin
    const held = async (): Promise<string[]> =>
      (await (await fetch(`${origin}/__ctl/held`)).json()) as string[]
    const release = () => fetch(`${origin}/__ctl/release`).then((response) => response.text())
    const holding = (path: string) =>
      waitFor(async () => (await held()).includes(path), `the server holds ${path}`, 5000)
    const shown = () => agent.host.evaluate(HEADING, 'preview', 1000).catch(() => null)
    const cancelsSince = (from: number) =>
      events.slice(from).filter((e) => e.phase === 'failed' && e.message === 'cancelled')
    const summary = () =>
      events
        .slice(-12)
        .map(
          (e) =>
            `${e.phase}${e.message ? `:${e.message}` : ''}${e.stale ? ':stale' : ''} ${(e.url ?? '').replace(origin, '')}`
        )
        .join(' | ')
    /** The shown page starts a navigation of its own, held provisional by the server. */
    const startHeld = async (path: string) => {
      // One expression: the host evaluates `await (code)`.
      await agent.host
        .evaluate(`location.assign(${JSON.stringify(path)})`, 'preview', 1000)
        .catch(() => null)
      await holding(path)
    }

    let cancelled = 0
    for (let i = 0; i < ROUNDS; i++) {
      const shownPage = await agent.open(`/page?show=${i}`, { reload: true })
      assert.equal(shownPage.loaded, true, `round ${i}: the page to leave opened`)
      const from = events.length
      await startHeld(`/gate/hold?r=${i}`)
      const opened = await agent.open(`/page?o=${i}`, { reload: true })
      assert.equal(opened.loaded, true, `round ${i}: open resolved loaded (${summary()})`)
      const done = new URL(opened.url)
      assert.equal(done.pathname + done.search, `/page?o=${i}`, `round ${i}: route`)
      assert.equal(await shown(), `Page /page?o=${i}`, `round ${i}: the open's page is shown`)
      await waitFor(
        async () => cancelsSince(from).length > 0,
        `round ${i}: the held navigation's cancel was reported`,
        3000
      )
      const reported = cancelsSince(from)
      // The cancel's URL is not used: WebKit reports the replacing load's URL for the
      // navigation it cancelled (observed). The open's own navigation started, and every
      // failure of the round is a cancel the host flagged as not the open's.
      assert.ok(
        events.slice(from).some((e) => e.phase === 'start' && (e.url ?? '').includes(`o=${i}`)),
        `round ${i}: the open's own navigation started (${summary()})`
      )
      assert.ok(
        events
          .slice(from)
          .filter((e) => e.phase === 'failed')
          .every((e) => e.message === 'cancelled' && e.stale === true),
        `round ${i}: a failure was reported as the open's (not stale): ${summary()}`
      )
      cancelled += reported.length
      await release()
    }

    // Synthetic Bun-state coverage: the open's own response is held as well, so it is
    // pending while a failure flagged `stale` arrives.
    const shownPage = await agent.open('/page?show=stale', { reload: true })
    assert.equal(shownPage.loaded, true)
    const from = events.length
    await startHeld('/gate/hold?r=stale')
    const opening = agent.open('/gate/hold?o=stale', { reload: true })
    await holding('/gate/hold?o=stale')
    await waitFor(
      async () => cancelsSince(from).length > 0,
      'the held navigation was cancelled by the second hold',
      3000
    )
    bridge().emit('agent-navigation', {
      view,
      phase: 'failed',
      url: `${origin}/old`,
      message: staleMessage,
      stale: true
    })
    assert.equal(agent.loading, true, 'a stale failure did not end the load in flight')
    await release()
    const survived = await opening
    assert.equal(survived.loaded, true, 'the held open resolved once released')
    assert.equal(new URL(survived.url).pathname, '/gate/hold')
    assert.equal(
      survived.identity.stale,
      false,
      `a stale failure kept the source capture: ${JSON.stringify(survived.identity.runtime)}`
    )
    assert.ok(
      agent.notices?.some((notice) => notice.message === staleMessage),
      'the stale failure is still reported as a notice'
    )
    return {
      rounds: ROUNDS,
      cancelsObserved: cancelled,
      staleSynthetic: true,
      events: summary()
    }
  } finally {
    bridge().off('agent-navigation', listen)
    await closeAgentBrowser(privateName(GATE_KEY, tree)).catch(() => {})
  }
}

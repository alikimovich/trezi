/**
 * preview_interact (LKM-230): request limits, the report every call returns (URL, console
 * errors, screenshot, navigation and host refusals) and the refusal to drive the user's
 * preview. The WebKit page side and the host's navigation policy are covered by the
 * native `agent-interact` smoke check.
 *
 * Run with: bun test/agent-interact.mjs
 */
import assert from 'node:assert/strict'
import { closeAgentBrowser, registerChromiumBrowser } from '../src/main/agent-browser.ts'
import {
  INTERACT_ACTIONS,
  INTERACT_FIDELITY,
  INTERACT_USER_REFUSAL,
  parseInteraction,
  runAgentInteraction
} from '../src/main/agent-interact.ts'
import { runTreziTool } from '../src/main/session-tools.ts'

// --- limits ------------------------------------------------------------------------------
const refused = (args, pattern) => {
  const parsed = parseInteraction(args)
  assert.ok('error' in parsed, `${JSON.stringify(args)} must be refused`)
  assert.match(parsed.error, pattern)
}
assert.deepEqual(INTERACT_ACTIONS, [
  'click',
  'type',
  'press',
  'hover',
  'scroll',
  'select',
  'wait',
  'refs'
])
refused({}, /action must be one of/)
refused({ action: 'drag' }, /action must be one of/)
refused({ action: 'click' }, /needs a selector, ref, source or x\/y/)
refused({ action: 'refs', ref: 'abcd1234:e1' }, /optional selector and limit/)
refused({ action: 'refs', limit: 151 }, /limit must be/)
refused({ action: 'wait', ref: 'abcd1234:e1' }, /a ref names an element/)
refused({ action: 'click', ref: 'x'.repeat(41) }, /at most 40/)
refused({ action: 'hover' }, /needs a selector/)
refused({ action: 'select', selector: '#s' }, /needs an option/)
refused({ action: 'type', selector: '#q' }, /needs text/)
refused({ action: 'press' }, /needs a key/)
refused({ action: 'wait' }, /selector, text or networkIdle/)
refused({ action: 'click', x: 10 }, /both x and y/)
refused({ action: 'click', x: -1, y: 2 }, /viewport CSS pixels/)
refused({ action: 'click', selector: 'a'.repeat(1001) }, /at most 1000/)
refused({ action: 'type', selector: '#q', text: 'x'.repeat(1001) }, /at most 1000/)
refused({ action: 'click', selector: 'a', index: 1.5 }, /index/)
refused({ action: 'wait', text: 'x', timeoutMs: 20_000 }, /timeoutMs/)
refused({ action: 'scroll', to: 'middle' }, /top" or "bottom/)
refused({ action: 'click', selector: 'a', force: 'yes' }, /true or false/)
assert.deepEqual(parseInteraction({ action: 'click', selector: '#a', index: 2 }), {
  action: 'click',
  selector: '#a',
  index: 2,
  screenshot: true
})
assert.deepEqual(parseInteraction({ action: 'scroll', deltaY: 300, screenshot: false }), {
  action: 'scroll',
  deltaY: 300,
  screenshot: false
})
assert.equal(parseInteraction({ action: 'wait', networkIdle: true }).networkIdle, true)
assert.equal(
  parseInteraction({ action: 'click', source: 'src/App.tsx:12' }).source,
  'src/App.tsx:12'
)

// --- the report --------------------------------------------------------------------------
/** A browser whose page answers `run`/`after` from a script and whose host emits notices. */
function stubBrowser(script) {
  const browser = {
    id: 'stub',
    root: '/repo',
    url: 'http://localhost:5173/filter',
    navigation: 1,
    loading: false,
    notices: [],
    servedRevision: null,
    speed: 1,
    calls: [],
    host: {
      async evaluate(code) {
        browser.calls.push(code)
        if (code.includes('.run('))
          return script.run(browser, JSON.parse(code.match(/run\((.*)\) \?\?/)[1]))
        if (code.includes('.after('))
          return script.after(browser, Number(code.match(/after\((\d+)\)/)[1]))
        return null
      },
      async thumbnail(rect, width) {
        browser.thumb = [rect, width]
        return 'SlBFRw=='
      }
    },
    async identity() {
      return {
        session: 'ps-agent-stub',
        navigation: browser.navigation,
        documentStartedAt: null,
        servedRevision: 'abc',
        liveRevision: 'abc',
        stale: false
      }
    },
    async open() {
      throw new Error('not used')
    },
    async capture() {
      return null
    },
    async setSpeed() {},
    async step() {},
    async close() {}
  }
  return browser
}
const parse = (args) => {
  const request = parseInteraction(args)
  assert.ok(!('error' in request))
  return request
}
const reportOf = (result) => JSON.parse(result.content[0].text)

// A click that changes the page: URL, console errors since the click, a 480 px thumbnail.
{
  const browser = stubBrowser({
    run: (_b, request) => ({
      element: 'button#filter-design',
      clicked: request.selector,
      consoleSeq: 4,
      navigating: false
    }),
    after: (b, since) => ({
      url: b.url,
      title: 'Filter',
      consoleErrors: since === 4 ? [{ level: 'error', text: 'boom' }] : [],
      droppedErrors: 0
    })
  })
  const result = await runAgentInteraction(
    browser,
    parse({ action: 'click', selector: '#filter-design' })
  )
  assert.notEqual(result.isError, true)
  const report = reportOf(result)
  assert.equal(report.ok, true)
  assert.equal(report.url, 'http://localhost:5173/filter')
  assert.equal(report.navigated, false)
  assert.deepEqual(
    report.consoleErrors,
    [{ level: 'error', text: 'boom' }],
    'errors since the click'
  )
  assert.ok(
    !('consoleSeq' in report) && !('navigating' in report),
    'page bookkeeping stays internal'
  )
  assert.deepEqual(result.content[1], { type: 'image', data: 'SlBFRw==', mimeType: 'image/jpeg' })
  assert.deepEqual(browser.thumb, [null, 480])
  assert.ok(!browser.calls[0].includes('screenshot'), 'the page never sees Bun-only options')
  // LOCAL-WEBKIT-2: every action states its fidelity; nothing claims trusted input or :hover.
  assert.deepEqual(report.fidelity, INTERACT_FIDELITY)
  assert.equal(report.fidelity.trusted, false)
  assert.equal(report.fidelity.cssHover, false)
}

// LOCAL-WEBKIT-2: refs are scoped to one browser, navigation and document.
{
  const browser = stubBrowser({
    run: (_b, request) => ({ element: 'button', got: request, consoleSeq: 0, navigating: false }),
    after: (b) => ({ url: b.url, consoleErrors: [] })
  })
  const evaluate = browser.host.evaluate
  browser.host.evaluate = async (code) =>
    code.includes('.refs(')
      ? {
          document: 'doc-1',
          url: browser.url,
          title: 'T',
          total: 1,
          truncated: false,
          refs: [{ ref: 'e1', element: 'button#go', role: 'button', text: 'Go' }]
        }
      : evaluate(code)
  const listed = await runAgentInteraction(browser, parse({ action: 'refs' }))
  assert.equal(listed.content.length, 1, 'refs attach no screenshot')
  const refs = reportOf(listed)
  assert.equal(refs.ok, true)
  assert.ok(!('document' in refs), 'the page document id stays in the host')
  const token = refs.refs[0].ref
  assert.match(token, /^[0-9a-f]{8}:e1$/, 'the agent sees a host-scoped token')
  const used = reportOf(
    await runAgentInteraction(browser, parse({ action: 'click', ref: token, screenshot: false }))
  )
  assert.equal(used.ok, true)
  assert.deepEqual(
    [used.got.ref, used.got.document, used.got.selector],
    ['e1', 'doc-1', undefined],
    'the page resolves the ref in the document it was issued in'
  )
  const other = stubBrowser({ run: () => ({}), after: () => ({}) })
  other.id = 'another-session'
  const foreign = reportOf(
    await runAgentInteraction(other, parse({ action: 'click', ref: token, screenshot: false }))
  )
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /not issued by this session's agent browser/)
  browser.navigation++
  const calls = browser.calls.length
  const stale = await runAgentInteraction(
    browser,
    parse({ action: 'click', ref: token, screenshot: false })
  )
  assert.equal(stale.isError, true)
  assert.equal(reportOf(stale).stale, true)
  assert.match(reportOf(stale).error, /is stale: the agent page navigated/)
  assert.equal(browser.calls.length, calls, 'a stale ref never reaches the page')
  const forged = reportOf(
    await runAgentInteraction(
      browser,
      parse({ action: 'click', ref: 'deadbeef:e1', screenshot: false })
    )
  )
  assert.match(forged.error, /not issued by this session's agent browser/)
}

// A page refusal (upload/download/off-origin/external form) is an error with its kind.
for (const kind of ['upload', 'download', 'navigation', 'form']) {
  const browser = stubBrowser({
    run: () => ({ error: `${kind} refused`, refused: kind, consoleSeq: 0, navigating: false }),
    after: (b) => ({ url: b.url, consoleErrors: [] })
  })
  const result = await runAgentInteraction(
    browser,
    parse({ action: 'click', selector: '#x', screenshot: false })
  )
  assert.equal(result.isError, true)
  assert.equal(reportOf(result).refused, kind)
  assert.equal(result.content.length, 1, 'screenshot: false attaches no image')
}

// The host blocks a script navigation: the notice is reported and the call fails.
{
  const browser = stubBrowser({
    run: (b) => {
      setTimeout(() => {
        b.notices.push({
          phase: 'blocked',
          reason: 'navigation',
          url: 'https://example.invalid/',
          at: Date.now()
        })
      }, 20)
      return { consoleSeq: 0, navigating: false }
    },
    after: (b) => ({ url: b.url, consoleErrors: [] })
  })
  const result = await runAgentInteraction(
    browser,
    parse({ action: 'click', selector: '#leave', screenshot: false })
  )
  assert.equal(result.isError, true)
  const report = reportOf(result)
  assert.equal(report.ok, false)
  assert.deepEqual(report.blocked, [
    { phase: 'blocked', reason: 'navigation', url: 'https://example.invalid/' }
  ])
  assert.equal(report.url, 'http://localhost:5173/filter')
}

// A same-origin navigation: the answer waits for the load and reads the new document.
{
  const browser = stubBrowser({
    run: (b) => {
      b.loading = true
      setTimeout(() => {
        b.url = 'http://localhost:5173/filter?q=cards'
        b.navigation++
        b.loading = false
      }, 30)
      return { consoleSeq: 9, navigating: true }
    },
    after: (b, since) => ({ url: b.url, consoleErrors: [], since })
  })
  const result = await runAgentInteraction(
    browser,
    parse({ action: 'press', selector: '#q', key: 'Enter' })
  )
  const report = reportOf(result)
  assert.equal(report.navigated, true)
  assert.equal(report.url, 'http://localhost:5173/filter?q=cards')
  assert.ok(
    browser.calls.some((c) => c.includes('.after(0)')),
    'a new document reads its console from 0'
  )
}

// The page call fails because the document went away mid-call: treated as a navigation.
{
  const browser = stubBrowser({
    run: () => null,
    after: (b) => ({ url: b.url, consoleErrors: [] })
  })
  browser.host.evaluate = async (code) => {
    if (code.includes('.run(')) {
      browser.loading = true
      setTimeout(() => {
        browser.navigation++
        browser.loading = false
      }, 10)
      throw new Error('JavaScript execution returned a result of an unsupported type')
    }
    return { url: 'http://localhost:5173/next', consoleErrors: [] }
  }
  const report = reportOf(
    await runAgentInteraction(browser, parse({ action: 'click', selector: 'a', screenshot: false }))
  )
  assert.equal(report.navigated, true)
  assert.equal(report.url, 'http://localhost:5173/next')
}

// --- the session tool --------------------------------------------------------------------
const scope = {
  root: '/repo',
  liveRoot: '/repo',
  emitKey: 'chat-interact',
  background: false,
  notify() {}
}
const user = await runTreziTool(
  'preview_interact',
  { action: 'click', selector: 'h1', target: 'user' },
  scope
)
assert.equal(user.isError, true)
assert.equal(user.content[0].text, INTERACT_USER_REFUSAL, "the user's preview is never driven")
const invalid = await runTreziTool('preview_interact', { action: 'click' }, scope)
assert.equal(invalid.isError, true)
assert.match(invalid.content[0].text, /needs a selector/)

let made = null
registerChromiumBrowser(async () => {
  made = stubBrowser({
    run: () => ({ element: 'h1', consoleSeq: 0, navigating: false }),
    after: (b) => ({ url: b.url, consoleErrors: [] })
  })
  return made
})
const routed = await runTreziTool(
  'preview_interact',
  { action: 'click', selector: 'h1', engine: 'chromium', screenshot: false },
  scope
)
assert.notEqual(routed.isError, true, JSON.stringify(routed))
assert.equal(reportOf(routed).ok, true)
assert.match(routed.content.at(-1).text, /^Preview identity: /, 'the answer ends with the identity')
assert.ok(made.calls.some((c) => c.includes('__treziAgentInteract?.run(')))
await closeAgentBrowser('chromium:chat-interact')
registerChromiumBrowser(null)

console.log(
  'AGENT-INTERACT OK — limits, report (URL, console errors, screenshot), refusals, host blocks, navigation wait, user preview refused'
)

/**
 * LOCAL-WEBKIT-2: preview_verify without a desktop. Check and step limits and engine
 * refusals, the host's verdicts (no page or agent can supply a pass), condition waits
 * on a fake clock, receipt invalidation and per-session isolation, agent viewport
 * parsing, the managed CLI's answer parsing, and the managed Chromium route through the
 * real `bin/managed/agent-browser` wrapper: a missing CLI is the precise dependency, a
 * fake CLI's facts are judged here, its stderr warnings are not page errors, and a run
 * on the live server is never verified. The WebKit page side is the native
 * `agent-verify` smoke check.
 *
 * Run with: bun test/browser-verify.mjs
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REF_PATTERN } from '../src/main/agent-refs.ts'
import {
  AGENT_VIEWPORT_DEFAULT,
  parseAgentViewport,
  viewportMismatch
} from '../src/main/agent-viewport.ts'
import { CHECK_LIMITS, judge, parseChecks, pollChecks } from '../src/main/browser-checks.ts'
import {
  cliDependency,
  cliEntries,
  cliScalar,
  cliStyle,
  parseCliJson,
  pngSize
} from '../src/main/managed-browser-cli.ts'
import { previewServers } from '../src/main/preview-evidence.ts'
import { runPreviewVerify, setVerifyWrapperForTests } from '../src/main/preview-verify.ts'
import { runTreziTool } from '../src/main/session-tools.ts'
import {
  clearReceipts,
  receiptSession,
  receiptStatus,
  recordReceipt,
  sessionReceipts,
  setVerificationArtifactsRoot
} from '../src/main/verification-receipts.ts'
import { parseVerify, VERIFY_LIMITS } from '../src/main/verify-args.ts'
import { runChromiumChecks } from '../src/main/verify-chromium.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const work = mkdtempSync(join(tmpdir(), 'trezi-verify-'))
setVerificationArtifactsRoot(join(work, 'artifacts'))

// --- checks: limits and refusals ---------------------------------------------------------
const refusedChecks = (raw, pattern, engine = 'webkit') => {
  const parsed = parseChecks(raw, engine)
  assert.ok('error' in parsed, `${JSON.stringify(raw)} must be refused`)
  assert.match(parsed.error, pattern)
}
refusedChecks([], /non-empty list/)
refusedChecks(Array(CHECK_LIMITS.checks + 1).fill({ kind: 'exists', selector: 'h1' }), /At most 20/)
refusedChecks([{ kind: 'eval', selector: 'h1' }], /kind must be one of/)
refusedChecks(
  [{ kind: 'text', selector: 'h1' }],
  /checks\[0\]: text needs exactly one of equals or contains/
)
refusedChecks(
  [{ kind: 'text', selector: 'h1', equals: 'a', contains: 'a' }],
  /exactly one of equals/
)
refusedChecks([{ kind: 'exists' }], /exactly one of selector, ref or source/)
refusedChecks([{ kind: 'exists', selector: 'h1', ref: 'abcd1234:e1' }], /exactly one/)
refusedChecks([{ kind: 'url', selector: 'h1', equals: '/' }], /checks the page; give no element/)
refusedChecks([{ kind: 'count', ref: 'abcd1234:e1', min: 1 }], /takes a selector/)
refusedChecks([{ kind: 'count', selector: 'li' }], /equals, min or max/)
refusedChecks([{ kind: 'attribute', selector: 'a', name: 'on click' }], /valid attribute name/)
refusedChecks([{ kind: 'style', selector: 'a', equals: 'red' }], /CSS property name/)
refusedChecks([{ kind: 'state', selector: 'input' }], /state needs one of/)
refusedChecks(
  [{ kind: 'text', selector: 'p', equals: 'x'.repeat(1001) }],
  /equals must be a string/
)
refusedChecks([{ kind: 'exists', selector: 'p', timeoutMs: 10_001 }], /timeoutMs must be/)
// Synthetic events never set :hover, :active or :focus-visible in WebKit: refused, routed.
refusedChecks([{ kind: 'visible', selector: '.menu:hover .item' }], /:hover.*engine "chromium"/)
refusedChecks([{ kind: 'exists', selector: 'button:focus-visible' }], /:focus-visible/)
assert.ok('checks' in parseChecks([{ kind: 'visible', selector: '.menu:hover' }], 'chromium'))
refusedChecks([{ kind: 'exists', ref: 'abcd1234:e1' }], /WebKit agent page/, 'chromium')
refusedChecks(
  [{ kind: 'state', selector: 'input', state: 'focused' }],
  /focus is not readable/,
  'chromium'
)
refusedChecks(
  [{ kind: 'text', selector: 'li', index: 2, contains: 'x' }],
  /index is WebKit-only/,
  'chromium'
)
assert.deepEqual(
  parseChecks([{ kind: 'count', selector: 'li', min: 2, timeoutMs: 500 }], 'webkit'),
  {
    checks: [{ kind: 'count', selector: 'li', min: 2, timeoutMs: 500 }]
  }
)

// --- verdicts: decided here from observed facts ------------------------------------------
const page = { url: 'http://127.0.0.1:4100/settings?tab=a', title: 'Settings', consoleErrors: 0 }
const check = (raw) => parseChecks([raw], 'webkit').checks[0]
const verdict = (raw, seen, facts = page) => judge(check(raw), seen, facts)
assert.equal(
  verdict({ kind: 'url', equals: '/settings?tab=a' }, null).pass,
  true,
  'a route compares the path'
)
assert.equal(verdict({ kind: 'url', equals: 'http://127.0.0.1:4100/settings' }, null).pass, false)
assert.equal(verdict({ kind: 'title', contains: 'Sett' }, null).pass, true)
assert.equal(verdict({ kind: 'noConsoleErrors' }, null, { ...page, consoleErrors: 2 }).pass, false)
assert.equal(
  verdict({ kind: 'noConsoleErrors' }, null, { ...page, consoleErrors: null }).pass,
  false,
  'unreadable console errors never pass'
)
const seen = {
  count: 1,
  found: true,
  visible: true,
  text: 'Saved',
  value: 'a@b.c',
  checked: true,
  disabled: false,
  focused: false,
  attrs: { 'aria-pressed': 'true', title: null },
  styles: { color: 'rgb(0, 0, 0)' }
}
assert.equal(verdict({ kind: 'text', selector: 'p', equals: 'Saved' }, seen).pass, true)
assert.equal(
  verdict({ kind: 'text', selector: 'p', equals: 'saved' }, seen).pass,
  false,
  'exact means exact'
)
assert.equal(verdict({ kind: 'value', selector: 'input', contains: '@' }, seen).pass, true)
assert.equal(
  verdict(
    { kind: 'value', selector: 'input', equals: 'x' },
    { ...seen, value: undefined, valueHidden: true }
  ).detail,
  'password values are never read'
)
assert.equal(
  verdict({ kind: 'attribute', selector: 'b', name: 'aria-pressed', equals: 'true' }, seen).pass,
  true
)
assert.equal(
  verdict({ kind: 'attribute', selector: 'b', name: 'title' }, seen).pass,
  false,
  'absent attribute'
)
assert.equal(
  verdict({ kind: 'attribute', selector: 'b', name: 'role' }, seen).pass,
  false,
  'unread attribute fails'
)
assert.equal(
  verdict({ kind: 'style', selector: 'b', name: 'color', equals: 'rgb(0, 0, 0)' }, seen).pass,
  true
)
assert.equal(verdict({ kind: 'state', selector: 'i', state: 'enabled' }, seen).pass, true)
assert.equal(verdict({ kind: 'state', selector: 'i', state: 'focused' }, seen).pass, false)
assert.equal(verdict({ kind: 'hidden', selector: 'i' }, { count: 0, found: false }).pass, true)
assert.equal(verdict({ kind: 'hidden', selector: 'i' }, seen).pass, false)
assert.equal(verdict({ kind: 'absent', selector: 'i' }, { count: 0, found: false }).pass, true)
assert.equal(
  verdict({ kind: 'count', selector: 'li', min: 2, max: 3 }, { count: 3, found: true }).pass,
  true
)
assert.equal(
  verdict({ kind: 'count', selector: 'li', equals: 2 }, { count: 3, found: true }).pass,
  false
)
assert.equal(
  verdict({ kind: 'visible', selector: 'i' }, { error: 'Ref x is stale', stale: true }).pass,
  false
)
assert.equal(verdict({ kind: 'exists', selector: 'i' }, null).detail, 'not observed')

// --- condition waits on a fake clock -------------------------------------------------------
{
  let t = 0
  const clock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms
    }
  }
  const checks = parseChecks(
    [
      { kind: 'text', selector: '#status', equals: 'Done', timeoutMs: 1000 },
      { kind: 'exists', selector: '#never', timeoutMs: 200 },
      { kind: 'title', equals: 'Settings' }
    ],
    'webkit'
  ).checks
  const rounds = []
  const polled = await pollChecks(
    checks,
    async (pending) => {
      rounds.push(pending)
      const targets = new Map()
      if (pending.includes(0))
        targets.set(0, { count: 1, found: true, text: t >= 300 ? 'Done' : 'Saving…' })
      if (pending.includes(1)) targets.set(1, { count: 0, found: false })
      return { targets, page }
    },
    clock
  )
  assert.equal(polled.results[0].pass, true, 'a condition that holds in time passes')
  assert.equal(polled.results[0].ms, 300, 'when it first held')
  assert.equal(polled.results[1].pass, false, 'a condition past its timeout fails')
  assert.ok(polled.results[1].ms >= 200 && polled.results[1].ms < 300)
  assert.equal(polled.results[2].pass, true)
  assert.deepEqual(rounds[0], [0, 1, 2])
  assert.ok(
    rounds.slice(1).every((pending) => !pending.includes(2)),
    'a held check is fixed'
  )
  const aborted = await pollChecks(
    checks,
    async () => ({ abort: 'the page navigated during the checks' }),
    clock
  )
  assert.equal(aborted.aborted, 'the page navigated during the checks')
  assert.ok(
    aborted.results.every((r) => !r.pass),
    'an aborted run fails every pending check'
  )
}

// --- preview_verify arguments --------------------------------------------------------------
const refusedVerify = (raw, pattern) => {
  const parsed = parseVerify(raw)
  assert.ok('error' in parsed, `${JSON.stringify(raw)} must be refused`)
  assert.match(parsed.error, pattern)
}
const one = [{ kind: 'exists', selector: 'h1' }]
refusedVerify({ checks: one, target: 'user' }, /never checks or moves the user's preview/)
refusedVerify({ checks: one, engine: 'firefox' }, /engine must be/)
refusedVerify({ checks: one, path: 'https://example.com/' }, /path must be a route/)
refusedVerify(
  {
    checks: one,
    steps: Array(VERIFY_LIMITS.steps + 1).fill({ action: 'wait', networkIdle: true })
  },
  /at most 10/
)
refusedVerify({ checks: one, steps: [{ action: 'refs' }] }, /refs is not a setup step/)
refusedVerify({ checks: one, steps: [{ action: 'click' }] }, /steps\[0\]: click needs a selector/)
refusedVerify(
  { checks: one, engine: 'chromium', steps: [{ action: 'scroll', deltaY: 100 }] },
  /not available as a managed Chromium step/
)
refusedVerify(
  { checks: one, engine: 'chromium', steps: [{ action: 'click', x: 1, y: 2 }] },
  /take a CSS selector/
)
refusedVerify(
  { checks: one, engine: 'chromium', steps: [{ action: 'type', text: 'x' }] },
  /type needs a selector/
)
refusedVerify({ checks: one, viewport: { width: 100 } }, /viewport: width must be/)
refusedVerify({ checks: one, viewport: { theme: 'sepia' } }, /theme must be/)
refusedVerify({ steps: [] }, /non-empty list/)
assert.deepEqual(parseVerify({ list: true }), { list: true })
const parsedVerify = parseVerify({
  checks: one,
  path: '/settings',
  steps: [{ action: 'click', selector: '#save', screenshot: true }],
  viewport: { preset: 'mobile', theme: 'dark' }
})
assert.equal(parsedVerify.engine, 'webkit')
assert.equal(parsedVerify.screenshot, true)
assert.equal(parsedVerify.steps[0].screenshot, false, 'steps never attach their own screenshot')

// --- agent viewport --------------------------------------------------------------------------
assert.deepEqual(parseAgentViewport({ preset: 'mobile', height: 700, theme: 'dark' }), {
  width: 390,
  height: 700,
  theme: 'dark'
})
assert.deepEqual(
  parseAgentViewport({ theme: 'light' }, { width: 768, height: 900, theme: 'dark' }),
  { width: 768, height: 900, theme: 'light' },
  'only the given fields change'
)
assert.deepEqual(
  parseAgentViewport({ restore: true }, { width: 768, height: 900, theme: 'dark' }),
  AGENT_VIEWPORT_DEFAULT
)
assert.match(parseAgentViewport({}).error, /Pass a preset/)
assert.match(parseAgentViewport({ height: 5000 }).error, /height must be/)
// A receipt never claims a size or scheme the page did not report.
const dark390 = { width: 390, height: 700, theme: 'dark' }
assert.equal(viewportMismatch(dark390, { innerWidth: 390, innerHeight: 700, dark: true }), null)
assert.match(
  viewportMismatch(dark390, { innerWidth: 390, innerHeight: 800, dark: true }),
  /^viewport-not-applied: the page is 390×800, not 390×700/
)
assert.match(
  viewportMismatch(dark390, { innerWidth: 390, innerHeight: 700, dark: false }),
  /^viewport-not-applied: the page prefers light, not dark/
)
assert.match(viewportMismatch(dark390, null), /^viewport-unmeasured/)
assert.equal(
  viewportMismatch(AGENT_VIEWPORT_DEFAULT, { innerWidth: 1280, innerHeight: 800, dark: false }),
  null,
  'the system scheme is whatever the page reports'
)

// --- receipts: invalidation and isolation ------------------------------------------------------
const receipt = (over = {}) => ({
  id: 'vr-000000000001',
  createdAt: new Date(0).toISOString(),
  engine: 'webkit',
  engineDetail: 'System WebKit',
  input: 'synthetic-dom',
  coverage: {
    engine: 'WebKit',
    os: 'macOS',
    emulated: { viewport: '1280×800', colorScheme: 'system' },
    notCovered: ['Windows', 'Android', 'iOS']
  },
  runtime: {
    kind: 'private',
    agent: 'a1',
    root: '/wt',
    url: 'http://127.0.0.1:4100',
    generation: 3
  },
  source: { snapshot: 'snap-1', head: 'abc', dirty: 1 },
  document: { url: 'http://127.0.0.1:4100/', navigation: 2, startedAt: 't0' },
  viewport: AGENT_VIEWPORT_DEFAULT,
  steps: [],
  checks: [{ index: 0, check: 'exists h1', pass: true, expected: true, actual: 1, ms: 0 }],
  artifacts: [],
  checksPassed: true,
  verified: true,
  reason: null,
  ms: 5,
  ...over
})
const now = {
  snapshot: 'snap-1',
  generation: 3,
  serverRunning: true,
  navigation: 2,
  documentStartedAt: 't0'
}
assert.deepEqual(receiptStatus(receipt(), now), { current: true, reason: null })
assert.equal(
  receiptStatus(receipt(), { ...now, snapshot: 'snap-2' }).reason,
  'source-changed',
  'an edit invalidates'
)
assert.equal(receiptStatus(receipt(), { ...now, snapshot: null }).reason, 'snapshot-unavailable')
assert.equal(receiptStatus(receipt(), { ...now, serverRunning: false }).reason, 'runtime-stopped')
assert.equal(
  receiptStatus(receipt(), { ...now, generation: 4 }).reason,
  'runtime-restarted',
  'a restart invalidates'
)
assert.equal(
  receiptStatus(receipt(), { ...now, navigation: 3 }).reason,
  'navigated',
  'a navigation invalidates'
)
assert.equal(
  receiptStatus(receipt(), { ...now, documentStartedAt: 't1' }).reason,
  'document-replaced'
)
assert.equal(receiptStatus(receipt(), { ...now, navigation: null }).reason, 'page-closed')
assert.equal(
  receiptStatus(receipt({ engine: 'chromium' }), { ...now, navigation: null }).current,
  true,
  'Chromium receipts bind source and server only'
)
assert.equal(
  receiptStatus(receipt({ verified: false, reason: 'checks-failed' }), now).reason,
  'checks-failed',
  'a failed run never becomes current'
)
{
  const mine = receiptSession('chat-a', projectKey('/wt'))
  const theirs = receiptSession('chat-b', projectKey('/wt'))
  assert.notEqual(mine, theirs)
  const files = []
  for (let i = 0; i < 21; i++) {
    const path = join(work, `shot-${i}.jpg`)
    writeFileSync(path, 'x')
    files.push(path)
    recordReceipt(
      mine,
      receipt({
        id: `vr-${String(i).padStart(12, '0')}`,
        artifacts: [
          {
            kind: 'screenshot',
            path,
            sha256: '',
            bytes: 1,
            width: 1,
            height: 1,
            mimeType: 'image/jpeg'
          }
        ]
      })
    )
  }
  assert.equal(sessionReceipts(mine).length, 20, 'at most 20 receipts per session')
  assert.ok(!existsSync(files[0]), "an evicted receipt's artifact is deleted")
  assert.ok(existsSync(files[20]))
  assert.equal(
    sessionReceipts(theirs).length,
    0,
    "another session never sees this session's receipts"
  )
  clearReceipts(mine)
  assert.ok(!existsSync(files[20]))
}

// --- managed CLI answers -------------------------------------------------------------------------
assert.deepEqual(parseCliJson('warming up\n{"success":true,"data":{"count":2}}\n'), {
  success: true,
  data: { count: 2 }
})
assert.deepEqual(
  parseCliJson('{\n  "success": false,\n  "data": null,\n  "error": "Element not found"\n}'),
  { success: false, data: null, error: 'Element not found' }
)
assert.equal(parseCliJson('PASS everything is fine'), null, 'plain text is never an answer')
assert.equal(parseCliJson('{"data":{"count":1}}'), null, 'no success flag, no answer')
assert.equal(cliScalar({ count: 3 }, ['count']), 3)
assert.equal(cliScalar({ selector: '#a', text: 'Hi' }, ['missing']), 'Hi', 'the only scalar field')
assert.equal(cliScalar({ a: 'x', b: 'y' }, ['text']), undefined, 'an ambiguous shape is unreadable')
assert.equal(cliScalar(true, ['visible']), true)
assert.deepEqual(cliEntries({ errors: [1, 2] }), [1, 2])
assert.equal(cliEntries({ a: [], b: [] }), undefined)
assert.equal(
  cliStyle({ elements: [{ styles: { 'background-color': 'red' } }] }, 'backgroundColor'),
  'red'
)
assert.equal(
  cliStyle({ elements: [{ color: 'a' }, { color: 'b' }] }, 'color'),
  undefined,
  'several elements are ambiguous'
)
const png = Buffer.alloc(33)
png.writeUInt32BE(0x89504e47, 0)
png.writeUInt32BE(0x0d0a1a0a, 4)
png.writeUInt32BE(13, 8)
png.write('IHDR', 12, 'ascii')
png.writeUInt32BE(640, 16)
png.writeUInt32BE(480, 20)
assert.deepEqual(pngSize(png), { width: 640, height: 480 })
assert.equal(pngSize(Buffer.from('not a png')), null)
assert.deepEqual(
  cliDependency({
    code: 3,
    stdout: '',
    stderr: 'Trezi agent-browser: dependency: headless-shell: not installed.\n',
    timedOut: false
  }),
  { kind: 'headless-shell', message: 'not installed.' }
)
assert.equal(
  cliDependency({ code: 1, stdout: '', stderr: 'dependency: vercel-cli: x', timedOut: false }),
  null
)

// --- the managed Chromium route through the real wrapper ---------------------------------------------
const wrapper = join(import.meta.dir, '../bin/managed/agent-browser')
Object.assign(process.env, { TREZI_BROWSER_TEST: '1', TREZI_BROWSER_TEST_ROOT: join(work, 'ab') })
// Every fake CLI call is two Bun starts (wrapper and fake CLI): 2 s for a round of ten checks
// when idle, over a minute under parallel test load. This section judges the CLI's facts;
// the run, check and wait budgets are covered by test/browser-verify-bounds.mjs.
const checkTotal = CHECK_LIMITS.totalMs
CHECK_LIMITS.totalMs = 600_000
try {
  const run = (over = {}) => ({
    wrapper,
    cwd: work,
    url: 'http://127.0.0.1:4100/settings',
    origin: 'http://127.0.0.1:4100',
    viewport: { width: 390, height: 700, theme: 'dark' },
    steps: [],
    checks: one,
    screenshotPath: null,
    budgetMs: 600_000,
    ...over
  })
  {
    process.env.TREZI_BROWSER_TEST_CLI = join(work, 'no-such-agent-browser')
    const missing = await runChromiumChecks(run())
    assert.equal(missing.dependency?.kind, 'vercel-cli', 'a missing CLI is the precise dependency')
    assert.match(missing.dependency.message, /npm install -g agent-browser/)
    assert.equal(missing.checks.length, 0, 'nothing was checked')
  }
  // A fake Vercel CLI behind the real wrapper: it answers facts only, with a startup warning.
  const shell = join(work, 'chrome-headless-shell')
  writeFileSync(shell, '#!/bin/sh\nexit 0\n')
  chmodSync(shell, 0o755)
  const log = join(work, 'cli.log')
  const cli = join(work, 'agent-browser')
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require('node:fs')
const argv = process.argv.slice(2)
const args = argv.slice(argv.indexOf('--headed') + 2).filter((a) => a !== '--json')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
console.error('Warning: startup options ignored (daemon already running)')
const ok = (data) => console.log(JSON.stringify({ success: true, data }))
const [cmd, a, b, c] = args
const url = process.env.FAKE_URL || 'http://127.0.0.1:4100/settings'
if (cmd === 'get' && a === 'url') ok({ url })
else if (cmd === 'get' && a === 'title') ok({ title: 'Settings' })
else if (cmd === 'get' && a === 'count') ok({ count: b === '#missing' ? 0 : b === 'li' ? 3 : 1 })
else if (cmd === 'get' && a === 'text') ok({ selector: b, text: '  Saved\\n all ' })
else if (cmd === 'get' && a === 'value') ok({ first: 'x', second: 'y' })
else if (cmd === 'get' && a === 'attr') ok({ attribute: c, value: 'true' })
else if (cmd === 'get' && a === 'styles') ok({ elements: [{ styles: { color: 'rgb(255, 255, 255)' } }] })
else if (cmd === 'is') ok({ [a]: true })
else if (cmd === 'errors') ok({ errors: [] })
else if (cmd === 'console') ok({ messages: process.env.FAKE_CONSOLE_ERROR ? [{ type: 'error', text: 'boom' }] : [{ type: 'log', text: 'hi' }] })
else if (cmd === 'screenshot') {
  fs.writeFileSync(a, Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64'))
  ok({ path: a })
} else if (cmd === 'click' && a === '#broken') {
  console.log(JSON.stringify({ success: false, error: 'Element not found: #broken' }))
  process.exit(1)
} else ok({})
`
  )
  chmodSync(cli, 0o755)
  Object.assign(process.env, { TREZI_BROWSER_TEST_CLI: cli, TREZI_BROWSER_TEST_SHELL: shell })
  {
    const checks = parseChecks(
      [
        { kind: 'text', selector: '#status', equals: 'Saved all' },
        { kind: 'count', selector: 'li', equals: 3 },
        { kind: 'visible', selector: '#status' },
        { kind: 'absent', selector: '#missing' },
        { kind: 'attribute', selector: '#toggle', name: 'aria-pressed', equals: 'true' },
        { kind: 'style', selector: '#status', name: 'color', equals: 'rgb(255, 255, 255)' },
        { kind: 'state', selector: '#save', state: 'enabled' },
        { kind: 'url', equals: '/settings' },
        { kind: 'title', equals: 'Settings' },
        { kind: 'noConsoleErrors' }
      ],
      'chromium'
    ).checks
    const shot = join(work, 'chromium.png')
    const outcome = await runChromiumChecks(
      run({
        checks,
        steps: parseVerify({
          checks: one,
          engine: 'chromium',
          steps: [
            { action: 'click', selector: '#save' },
            { action: 'press', selector: '#q', key: 'Enter' },
            { action: 'wait', selector: '#status', timeoutMs: 15_000 }
          ]
        }).steps,
        screenshotPath: shot
      })
    )
    assert.equal(outcome.dependency, undefined)
    assert.equal(outcome.stopped, null, JSON.stringify(outcome.steps))
    for (const result of outcome.checks) assert.equal(result.pass, true, JSON.stringify(result))
    assert.ok(outcome.warnings > 0, 'the CLI warned on stderr')
    assert.equal(outcome.checks.at(-1).actual, 0, 'CLI warnings are never page console errors')
    assert.deepEqual(
      outcome.artifacts.map(({ width, height, mimeType }) => [width, height, mimeType]),
      [[640, 480, 'image/png']]
    )
    assert.match(outcome.artifacts[0].sha256, /^[0-9a-f]{64}$/)
    const calls = (await Bun.file(log).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(calls.slice(0, 4), [
      ['open', 'http://127.0.0.1:4100/settings'],
      ['set', 'viewport', '390', '700'],
      ['set', 'media', 'dark'],
      ['reload']
    ])
    assert.deepEqual(calls.slice(4, 7), [
      ['click', '#save'],
      ['focus', '#q'],
      ['press', 'Enter']
    ])
    assert.deepEqual(calls.at(-1), ['close'], 'the private session is always closed')
    assert.ok(
      !calls.some((c) => ['eval', 'download', 'cookies', 'storage'].includes(c[0])),
      'no page code, downloads or storage'
    )
  }
  {
    process.env.FAKE_CONSOLE_ERROR = '1'
    const checks = parseChecks(
      [{ kind: 'noConsoleErrors' }, { kind: 'value', selector: '#email', equals: 'x' }],
      'chromium'
    ).checks
    const outcome = await runChromiumChecks(run({ checks }))
    delete process.env.FAKE_CONSOLE_ERROR
    assert.equal(outcome.checks[0].pass, false, 'a page console error fails')
    assert.equal(outcome.checks[1].pass, false, 'an ambiguous CLI answer fails instead of passing')
    assert.match(outcome.checks[1].detail, /could not be read/)
  }
  {
    const outcome = await runChromiumChecks(
      run({
        steps: parseVerify({
          checks: one,
          engine: 'chromium',
          steps: [{ action: 'click', selector: '#broken' }]
        }).steps
      })
    )
    assert.match(outcome.stopped, /^step-failed: click: Element not found/)
    assert.equal(outcome.checks.length, 0, 'no checks after a failed step')
  }
  {
    process.env.FAKE_URL = 'https://example.com/'
    const outcome = await runChromiumChecks(run())
    delete process.env.FAKE_URL
    assert.equal(outcome.stopped, 'the page left the dev server')
  }

  // --- the session tool ---------------------------------------------------------------------------
  {
    const scope = {
      root: work,
      liveRoot: work,
      emitKey: 'chat-verify',
      background: false,
      notify() {}
    }
    const user = await runTreziTool('preview_verify', { checks: one, target: 'user' }, scope)
    assert.equal(user.isError, true)
    assert.match(user.content[0].text, /never checks or moves the user's preview/)
    const empty = JSON.parse(
      (await runTreziTool('preview_verify', { list: true }, scope)).content[0].text
    )
    assert.deepEqual(empty.receipts, [])
    setVerifyWrapperForTests(wrapper)
    // A missing dependency: the precise error, no receipt, no fallback.
    process.env.TREZI_BROWSER_TEST_CLI = join(work, 'no-such-agent-browser')
    const missing = await runPreviewVerify({ checks: one, engine: 'chromium' }, scope)
    assert.equal(missing.isError, true)
    assert.match(
      missing.content[0].text,
      /needs a dependency: vercel-cli: .*No browser was launched\..*Nothing was checked and no receipt was written/s
    )
    process.env.TREZI_BROWSER_TEST_CLI = cli
    // The live checkout's visible server: checks run, the receipt is honestly not verified.
    previewServers.set(projectKey(work), { url: 'http://127.0.0.1:4100', port: 4100 })
    const live = await runPreviewVerify(
      { checks: [{ kind: 'title', equals: 'Settings' }], engine: 'chromium', path: '/settings' },
      scope
    )
    previewServers.delete(projectKey(work))
    assert.equal(live.isError, true)
    const liveReceipt = JSON.parse(live.content[1].text)
    assert.equal(liveReceipt.checksPassed, true)
    assert.equal(
      liveReceipt.verified,
      false,
      'the live server has no private generation or exact-source record'
    )
    assert.match(liveReceipt.reason, /^live-server/)
    assert.equal(liveReceipt.input, 'cdp-trusted')
    assert.deepEqual(liveReceipt.coverage.notCovered.slice(0, 3), ['Windows', 'Android', 'iOS'])
    assert.match(liveReceipt.coverage.emulated.viewport, /CDP viewport emulation/)
    assert.ok(existsSync(liveReceipt.artifacts[0].path), 'the screenshot artifact exists')
    assert.match(live.content[0].text, /NOT verified: live-server/)
    const listed = JSON.parse(
      (await runTreziTool('preview_verify', { list: true }, scope)).content[0].text
    )
    assert.deepEqual(
      listed.receipts.map((r) => [r.id, r.verified, r.current]),
      [[liveReceipt.id, false, false]]
    )
    const other = JSON.parse(
      (await runTreziTool('preview_verify', { list: true }, { ...scope, emitKey: 'chat-other' }))
        .content[0].text
    )
    assert.deepEqual(other.receipts, [], "another session's list is empty")
    setVerifyWrapperForTests(null)
    clearReceipts(receiptSession(scope.emitKey, projectKey(work)))
  }
} finally {
  CHECK_LIMITS.totalMs = checkTotal
}
assert.ok(REF_PATTERN.test('0123abcd:e12') && !REF_PATTERN.test('e12'))

setVerificationArtifactsRoot(null)
rmSync(work, { recursive: true, force: true })
console.log(
  'BROWSER-VERIFY OK — check limits and engine refusals, host verdicts, condition waits, receipts invalidated and session-scoped, viewport, CLI parsing, managed Chromium (missing dependency, fake CLI judged here, warnings not errors, live server not verified)'
)

/**
 * LKM-138 unit checks, no desktop: the preview_evaluate guards (static validation and
 * the membrane runtime, run in a fresh `node:vm` realm standing in for the TreziAgent
 * world), tool routing against a fake native host, and the Claude session isolation.
 * The WebKit behavior itself is covered by the native `agent-preview` smoke check.
 *
 * Run with: bun test/preview-agent-tools.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import {
  claudeIsolationOptions,
  personalClaudePlugins
} from '../src/main/backends/claude-isolation.ts'
import {
  EVALUATE_LIMITS,
  evaluationCode,
  runPreviewAgentTool,
  VIEWPORT_PRESETS,
  validateExpression
} from '../src/main/preview-agent-tools.ts'

// --- static validation ---------------------------------------------------------------
for (const ok of [
  '1 + 1',
  "document.querySelectorAll('h1').length",
  'await Promise.resolve(2)',
  '[...document.images].map((i) => i.src)'
])
  assert.equal(await validateExpression(ok), null, ok)
for (const [bad, reason] of [
  ['(() => { while (true) {} })()', /loops/],
  ['(() => { for (;;) {} })()', /loops/],
  ['(() => { do {} while (1) })()', /loops/],
  ["import('x')", /import\(\)/],
  ['(() => { a: 1 })()', /labels/],
  ['(() => { debugger })()', /debugger/],
  ['x <!-- y', /HTML-like comments/],
  ['1; 2', /single JavaScript expression/],
  ['', /Pass a JavaScript expression/],
  ['1'.repeat(EVALUATE_LIMITS.maxExpression + 1), /limit is 8000/]
])
  assert.match(await validateExpression(bad), reason, bad.slice(0, 40))

// --- the membrane runtime, in a separate realm ------------------------------------------
const writes = []
const realm = vm.createContext({
  setTimeout,
  clearTimeout,
  title: 'Fixture',
  location: { href: 'http://localhost/', assign: (url) => writes.push(url) },
  localStorage: { setItem: (k, v) => writes.push(k + v) },
  page: { items: [1, 2, 3], nested: { deep: true } }
})
const run = (expression, limits) => vm.runInContext(evaluationCode(expression, limits), realm)
const ok = async (expression) => {
  const result = await run(expression)
  assert.equal(result.ok, true, `${expression}: ${result.error}`)
  return result.value
}
const rejected = async (expression, pattern, limits) => {
  const result = await run(expression, limits)
  assert.equal(result.ok, false, `${expression} must be rejected`)
  assert.match(result.error, pattern, expression)
}
assert.equal(await ok('1 + 1'), 2)
assert.equal(await ok('title'), 'Fixture')
assert.deepEqual(await ok('page.items.map((n) => n * 2)'), [2, 4, 6])
assert.deepEqual(await ok('({ ...page.nested, extra: await Promise.resolve(1) })'), {
  deep: true,
  extra: 1
})
assert.equal(await ok('window.title'), 'Fixture')
// Writes and navigation never reach the page.
await rejected("globalThis.title = 'x'", /read-only/)
assert.equal(
  await ok('page.items.push(4)'),
  4,
  'page arrays arrive as copies; pushing changes only the copy'
)
await rejected('delete page.nested', /read-only/)
await rejected('Object.defineProperty(page, "x", { value: 1 })', /read-only/)
await rejected("location.href = 'http://evil.test/'", /read-only/)
await rejected("location.assign('http://evil.test/')", /not a read-only call/)
await rejected("localStorage.setItem('k', 'v')", /localStorage is not available/)
await rejected("Function('return 1')()", /Function is not available/)
await rejected("[].constructor.constructor('return 1')()", /Compiling code is not available/)
await rejected("(async () => {}).constructor('return 1')()", /Compiling code is not available/)
await rejected("eval('1')", /eval is not available/)
assert.deepEqual(writes, [], 'nothing was written or navigated')
assert.equal(vm.runInContext('title', realm), 'Fixture')
assert.equal(vm.runInContext('page.items.length', realm), 3)
// Size and time limits.
await rejected("Array.from({ length: 100 }, () => 'x'.repeat(3000))", /Result too large/)
await rejected('new Promise(() => {})', /Timed out after 50 ms/, { timeMs: 50, maxBytes: 65536 })
assert.equal((await ok("'y'.repeat(10000)")).length, 4001, 'long strings are clipped')

// --- routing against a fake native host -------------------------------------------------
const calls = []
let width = 1000
const png = Buffer.from('png')
const host = {
  async evaluate(code, world) {
    calls.push({ world, code: code.slice(0, 60) })
    if (code.includes('__treziAgentRuntime'))
      return { ok: true, type: 'number', value: 2, bytes: 1, ms: 0 }
    if (code.includes('__treziAgentInspect?.inspect'))
      return {
        element: '<div#card>',
        styles: { 'box-shadow': 'rgba(0, 0, 0, 0.5) 0px 4px 12px 0px' }
      }
    if (code.includes('prepareCapture'))
      return {
        element: '<div#card>',
        source: 'index.html:4:1',
        rect: { x: 10, y: 20, width: 100, height: 50 },
        crop: { x: 10, y: 20, width: 100, height: 50 },
        scrolled: true,
        restore: { x: 0, y: 0 }
      }
    if (code.includes('restoreScroll')) return true
    if (code.includes('__treziAgentConsole'))
      return {
        total: 1,
        dropped: 0,
        entries: [{ seq: 1, level: 'pageerror', text: 'Error: boom' }]
      }
    if (code.includes('innerWidth')) return { innerWidth: width, innerHeight: 700 }
    return true
  },
  async captureRect(rect) {
    calls.push({ capture: rect })
    return {
      isEmpty: () => false,
      toPNG: () => png,
      toJPEG: () => Buffer.from('jpeg'),
      getSize: () => ({ width: rect.width * 2, height: rect.height * 2 })
    }
  },
  async setViewport(next) {
    calls.push({ viewport: next })
    width = next ?? 1000
    return { width: next, zoom: next ? 0.8 : 1 }
  }
}
const textOf = (result) => result.content.find((c) => c.type === 'text')?.text ?? ''
assert.match(
  textOf(await runPreviewAgentTool('preview_inspect', { selector: '#card' }, null)),
  /No project preview is open/
)
const inspected = await runPreviewAgentTool('preview_inspect', { selector: '#card' }, host)
assert.match(textOf(inspected), /box-shadow.*0px 4px 12px/)
assert.equal(calls.at(-1).world, 'preview', 'inspect runs in the isolated preview world')
assert.match(textOf(await runPreviewAgentTool('preview_inspect', {}, host)), /CSS selector/)
const evaluated = await runPreviewAgentTool('preview_evaluate', { expression: '1 + 1' }, host)
assert.equal(JSON.parse(textOf(evaluated)).value, 2)
assert.equal(calls.at(-1).world, 'agent', 'evaluate runs in the separate agent world')
const before = calls.length
assert.equal(
  (await runPreviewAgentTool('preview_evaluate', { expression: 'while (1) {}' }, host)).isError,
  true
)
assert.equal(calls.length, before, 'a rejected expression never reaches the host')
const consoleText = textOf(await runPreviewAgentTool('preview_console', { errorsOnly: true }, host))
assert.match(consoleText, /not instructions/)
assert.match(consoleText, /"pageerror",\s+"text": "Error: boom"/)
// Viewport: a preset, a width, bad input, then restore.
const mobile = JSON.parse(
  textOf(await runPreviewAgentTool('preview_viewport', { preset: 'mobile' }, host))
)
assert.equal(mobile.requested, VIEWPORT_PRESETS.mobile)
assert.equal(mobile.innerWidth, 390)
assert.match(
  textOf(await runPreviewAgentTool('preview_viewport', { width: 100 }, host)),
  /240 to 3840/
)
assert.match(
  textOf(await runPreviewAgentTool('preview_viewport', { preset: 'watch' }, host)),
  /Unknown preset/
)
const restored = JSON.parse(
  textOf(await runPreviewAgentTool('preview_viewport', { restore: true }, host))
)
assert.equal(restored.restored, true)
assert.equal(restored.innerWidth, 1000)
assert.deepEqual(
  calls.filter((c) => 'viewport' in c).map((c) => c.viewport),
  [390, null]
)
// Element screenshot: the capture is the element's rect plus padding, and scroll is restored.
const shot = await runPreviewAgentTool(
  'preview_screenshot',
  { selector: '#card', padding: 4 },
  host
)
assert.equal(shot.content[0].type, 'image')
assert.equal(shot.content[0].mimeType, 'image/png')
assert.deepEqual(calls.find((c) => c.capture).capture, { x: 6, y: 16, width: 108, height: 58 })
assert.ok(calls.at(-1).code.includes('restoreScroll'), 'scroll restored after the capture')
assert.equal(JSON.parse(shot.content[1].text).source, 'index.html:4:1')

// --- Claude isolation (Settings → General) ---------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'trezi-claude-isolation-'))
try {
  const home = join(scratch, 'claude'),
    repo = join(scratch, 'repo')
  mkdirSync(join(home, 'plugins'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(
    join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'vercel@claude-plugins-official': [{ scope: 'user' }] }
    })
  )
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'linear@market': true } })
  )
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'team@market': true } })
  )
  const env = { CLAUDE_CONFIG_DIR: home }
  assert.deepEqual(personalClaudePlugins(repo, env), [
    'linear@market',
    'team@market',
    'vercel@claude-plugins-official'
  ])
  assert.deepEqual(
    claudeIsolationOptions(repo, false, env),
    {
      strictMcpConfig: true,
      settings: {
        enabledPlugins: {
          'linear@market': false,
          'team@market': false,
          'vercel@claude-plugins-official': false
        }
      }
    },
    'off (the default): only Trezi MCP servers and no personal plugins'
  )
  assert.deepEqual(
    claudeIsolationOptions(repo, true, env),
    {},
    'on: the user’s own setup loads unchanged'
  )
  assert.deepEqual(
    claudeIsolationOptions(join(scratch, 'empty'), false, {
      CLAUDE_CONFIG_DIR: join(scratch, 'none')
    }),
    { strictMcpConfig: true }
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(
  'PREVIEW-AGENT-TOOLS OK — evaluate validation + read-only/bounded membrane, inspect/console/viewport/element-crop routing, Claude plugin isolation'
)

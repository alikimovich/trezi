/** LKM-165: Claude starts and resumes with one canonical cwd, even through a symlink. */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer, calls, scripts } from './helpers/claude-sdk-mock.mjs'

let failed = 0
const ok = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failed++
  }
}
const { claudeProvider } = await import('../src/main/backends/claude.ts')

const base = mkdtempSync(join(tmpdir(), 'claude-cwd-'))
mkdirSync(join(base, 'real', 'wt'), { recursive: true })
symlinkSync(join(base, 'real'), join(base, 'link'))
const linked = join(base, 'link', 'wt')
const resolved = realpathSync(linked)
ok(linked !== resolved, 'the fixture path really contains a symlink')

const start = async (context) => {
  scripts.push(answer())
  const session = await claudeProvider.startSession(linked, {}, () => null, {
    emitKey: 'p#chat',
    onEvent: () => {},
    ...context
  })
  session.shutdown()
}
await start({})
await start({ resumeSessionId: 'abc' })
ok(calls.length === 2, 'two queries were opened')
ok(calls[0].options.cwd === resolved, `start uses the realpath (${calls[0].options.cwd})`)
ok(calls[1].options.cwd === resolved, `resume uses the realpath (${calls[1].options.cwd})`)
ok(calls[0].options.cwd === calls[1].options.cwd, 'start and resume share one cwd')
ok(calls[1].options.resume === 'abc', 'the resume id is passed through')

if (failed) process.exit(1)
console.log('claude-cwd: OK')
process.exit(0)

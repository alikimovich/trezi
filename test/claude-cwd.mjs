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

const start = async (context, root = linked) => {
  scripts.push(answer())
  const events = []
  const session = await claudeProvider.startSession(root, {}, () => null, {
    emitKey: 'p#chat',
    onEvent: (event) => events.push(event),
    ...context
  })
  const record = session.record
  // The session id is stamped off the init message, once a turn runs.
  if (context.send) {
    session.send('hello')
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'done'); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
  }
  session.shutdown()
  return record
}
const started = await start({ send: true })
await start({ resumeSessionId: 'abc' })
ok(calls.length === 2, 'two queries were opened')
ok(calls[0].options.cwd === resolved, `start uses the realpath (${calls[0].options.cwd})`)
ok(calls[1].options.cwd === resolved, `resume uses the realpath (${calls[1].options.cwd})`)
ok(calls[0].options.cwd === calls[1].options.cwd, 'start and resume share one cwd')
ok(calls[1].options.resume === 'abc', 'the resume id is passed through')
ok(started.sdkSessionId === 'new-session', 'the session id is on the record')
ok(started.sdkCwd === resolved, `the cwd is stored with the session id (${started.sdkCwd})`)

// The cwd stored with the session id is the one a resume passes, while it is still the chat's
// directory (here the same directory under another spelling).
const before = calls.length
await start({ resumeSessionId: 'abc', resumeCwd: linked })
ok(
  calls[before].options.cwd === linked,
  `resume passes the stored cwd (${calls[before].options.cwd})`
)
// A stored cwd that is gone, or is another directory, never moves the chat out of its worktree.
await start({ resumeSessionId: 'abc', resumeCwd: join(base, 'missing') })
ok(calls[before + 1].options.cwd === resolved, 'a vanished stored cwd falls back to the worktree')
await start({ resumeSessionId: 'abc', resumeCwd: base })
ok(calls[before + 2].options.cwd === resolved, 'another directory falls back to the worktree')
await start({ resumeCwd: linked })
ok(calls[before + 3].options.cwd === resolved, 'a new session ignores a stored cwd')

if (failed) process.exit(1)
console.log('claude-cwd: OK')
process.exit(0)

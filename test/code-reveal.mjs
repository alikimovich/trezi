import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openAgentCode } from '../src/main/code-tools.ts'

const root = await mkdtemp(join(tmpdir(), 'trezi-code-reveal-'))
const outside = await mkdtemp(join(tmpdir(), 'trezi-code-outside-'))
try {
  await writeFile(
    join(root, 'motion.ts'),
    'const duration = 300\nfunction replay() {\n  animate(duration)\n}\n'
  )
  await writeFile(join(outside, 'private.ts'), 'private code')
  await symlink(join(outside, 'private.ts'), join(root, 'escape.ts'))
  const events = []
  const call = (args) =>
    openAgentCode(root, '/live/project', 'chat-key', args, (channel, payload) =>
      events.push({ channel, payload })
    )
  assert.equal((await call({ file: 'motion.ts', startLine: 2, endLine: 4 })).requested, true)
  assert.equal(events[0].channel, 'source:reveal')
  const request = events[0].payload
  assert.equal(request.root, '/live/project')
  assert.equal(request.key, 'chat-key')
  assert.equal(request.code, 'function replay() {\n  animate(duration)\n}')
  for (const args of [
    { file: 'escape.ts', startLine: 1 },
    { file: '../outside.ts', startLine: 1 },
    { file: join(outside, 'private.ts'), startLine: 1 },
    { file: 'motion.ts', startLine: 0 },
    { file: 'motion.ts', startLine: 3, endLine: 2 },
    { file: 'motion.ts', startLine: 2, endLine: 99 }
  ])
    assert((await call(args)).error, JSON.stringify(args))
  assert.equal(events.length, 1)
  console.log(
    'CODE-REVEAL OK — exact range, relocation, ambiguous/stale rejection, path and symlink boundaries'
  )
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}

// Preview navigation validates routes before sending a chat/project-scoped event.
const { openAgentPreview } = await import('../src/main/preview-tools.ts')
const navigation = []
const navigate = (path, background = false) =>
  openAgentPreview(
    '/project',
    'chat',
    { path },
    (channel, request) => navigation.push({ channel, request }),
    background
  )
assert.equal((await navigate('/work/article?view=full#intro')).requested, true)
assert.deepEqual(navigation[0], {
  channel: 'preview:open',
  request: {
    root: '/project',
    key: 'chat',
    path: '/work/article?view=full#intro',
    id: navigation[0].request.id,
    now: true
  }
})
for (const path of [
  '//evil.test',
  '/\\evil.test',
  'https://evil.test',
  'javascript:alert(1)',
  '/a\nb',
  '',
  null
])
  assert((await navigate(path)).error, String(path))
assert((await navigate('/article', true)).error)
assert.equal(navigation.length, 1)

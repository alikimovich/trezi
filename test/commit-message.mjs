/**
 * LKM-189: landing commit messages describe the change, never the user's prompt.
 * `commit-message.ts` with a mocked model: a generated subject and bullets, the 3 s
 * timeout falling back to the deterministic changed-files message, refused answers
 * (prompt echo, "[Attached files]", chatter, over-long), Conventional Commits, the
 * combined diff of a re-squashed (parked) change, and trailers kept out of the subject.
 * Uses a real temp git repo.
 *
 * Run with: bun test/commit-message.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  changeEvidence,
  DESCRIBE_TIMEOUT_MS,
  describeChange,
  fallbackSubject,
  fullCommitMessage,
  parseCommitMessage,
  usesConventionalCommits,
  withTrailers
} from '../src/main/commit-message.ts'
import { describeAgentOptions } from '../src/shared/background-model.ts'

const dir = mkdtempSync(join(tmpdir(), 'trezi-commit-message-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const files = [
  { path: 'src/components/key-tile.tsx', status: 'modified' },
  { path: 'src/screens/home.tsx', status: 'modified' },
  { path: 'src/components/bottom-bar.tsx', status: 'modified' }
]
const evidence = {
  files,
  stat: ' 3 files changed',
  excerpt: '+  border-radius: var(--radius-pill);'
}
const PROMPT = 'hm, that is very strange. make the key tiles round please'

try {
  // --- Deterministic fallback from the changed files. ---
  assert.equal(fallbackSubject(files), 'Update key-tile.tsx, home.tsx and bottom-bar.tsx')
  assert.equal(
    fallbackSubject([...files, { path: 'a/b.css', status: 'modified' }]),
    'Update key-tile.tsx, home.tsx, bottom-bar.tsx and 1 more file'
  )
  assert.equal(fallbackSubject([{ path: 'new.ts', status: 'added' }]), 'Add new.ts')
  assert.equal(
    fallbackSubject([{ path: 'old.ts', status: 'deleted' }], true),
    'chore: remove old.ts'
  )
  const many = Array.from({ length: 9 }, (_, i) => ({
    path: `src/${'very-long-component-name-'.repeat(2)}${i}.tsx`,
    status: 'modified'
  }))
  assert.ok(fallbackSubject(many).length <= 72, fallbackSubject(many))

  // --- A mocked model writes the message; the prompt carries the diff, not the request. ---
  let seen = ''
  const generated = await describeChange({
    evidence,
    prompt: PROMPT,
    reply: 'I made the key tiles pill-shaped using the --radius-pill token.',
    generate: async (prompt) => {
      seen = prompt
      return 'Make key tiles pill-shaped with --radius-pill\n\n- Round key tiles with the pill radius token\n- Keep the bottom bar aligned with the new tiles\n- Update the home screen grid spacing'
    }
  })
  assert.equal(generated.generated, true)
  assert.equal(generated.subject, 'Make key tiles pill-shaped with --radius-pill')
  assert.ok(generated.body.startsWith('- Round key tiles'), generated.body)
  assert.ok(generated.body.endsWith('Changed areas: src/components, src/screens'), generated.body)
  assert.ok(seen.includes('modified src/screens/home.tsx'), 'the file list is in the prompt')
  assert.ok(seen.includes('--radius-pill'), 'the diff excerpt is in the prompt')
  assert.ok(seen.includes('pill-shaped using'), "the agent's final reply is in the prompt")
  assert.ok(!seen.includes('very strange'), 'the user prompt is never sent')

  // --- Timeout: the landing waits 3 s at most, then the deterministic message. ---
  assert.equal(DESCRIBE_TIMEOUT_MS, 3000)
  let aborted = false
  const started = Date.now()
  const late = await describeChange({
    evidence,
    generate: (_prompt, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        setTimeout(() => resolve('Too late\n\n- x'), 10_000).unref()
      })
  })
  const waited = Date.now() - started
  assert.ok(waited >= 2900 && waited < 3600, `waited ${waited} ms`)
  assert.ok(aborted, 'the model call is aborted at the deadline')
  assert.equal(late.generated, false)
  assert.equal(late.subject, 'Update key-tile.tsx, home.tsx and bottom-bar.tsx')
  assert.ok(late.body.includes('- Update src/screens/home.tsx'), late.body)

  // A failing or absent model falls back at once.
  const failed = await describeChange({
    evidence,
    generate: async () => Promise.reject(new Error('offline'))
  })
  assert.equal(failed.generated, false)
  assert.equal((await describeChange({ evidence })).generated, false)

  // --- No prompt text in the subject: echoes and chatter are refused. ---
  const refuse = (raw) =>
    assert.equal(parseCommitMessage(raw, { prompt: PROMPT, files }), null, `refused: ${raw}`)
  refuse(`${PROMPT}\n\n- x`)
  refuse('Hm, that is very strange. Make the key tiles round please\n\n- x')
  refuse('[Attached files]\n\n- x')
  refuse("Sure, here's the commit message\n\n- x")
  refuse(`${'Update '.repeat(15)}\n\n- x`)
  refuse('Make key tiles round') // no bullets
  refuse('Please run /login to authenticate\n\n- x')
  const echoed = await describeChange({
    evidence,
    prompt: PROMPT,
    generate: async () => `${PROMPT}\n\n- a`
  })
  assert.equal(echoed.generated, false)
  assert.ok(!echoed.subject.includes('strange'))
  const tidy = parseCommitMessage(
    'Subject: "Move Account to the Home top bar."\n\n* Add a Shop tab\n• Drop the old menu',
    { files }
  )
  assert.equal(tidy.subject, 'Move Account to the Home top bar')
  assert.ok(tidy.body.startsWith('- Add a Shop tab\n- Drop the old menu'), tidy.body)
  const capped = parseCommitMessage(`Add tabs\n\n${'- point\n'.repeat(9)}`)
  assert.equal(capped.body.split('\n').length, 6, 'at most six bullets')

  // --- Conventional Commits when the project's history uses them. ---
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  for (const subject of ['feat: add tiles', 'fix(ui): align bar', 'chore: bump', 'docs: readme']) {
    git(repo, 'commit', '-q', '--allow-empty', '-m', subject)
  }
  assert.equal(await usesConventionalCommits(repo), true)
  assert.equal(
    parseCommitMessage('Make tiles round\n\n- x', { conventional: true }).subject,
    'chore: make tiles round'
  )
  assert.equal(
    parseCommitMessage('feat(tiles): make tiles round\n\n- x', { conventional: true }).subject,
    'feat(tiles): make tiles round'
  )
  let conventionalPrompt = ''
  await describeChange({
    evidence,
    conventional: true,
    generate: async (p) => {
      conventionalPrompt = p
      return null
    }
  })
  assert.ok(conventionalPrompt.includes('Conventional Commits'))
  const plain = join(dir, 'plain')
  mkdirSync(plain)
  git(plain, 'init', '-q', '-b', 'main')
  git(plain, 'config', 'user.name', 'Test')
  git(plain, 'config', 'user.email', 'test@example.com')
  git(plain, 'commit', '-q', '--allow-empty', '-m', 'Initial commit')
  assert.equal(await usesConventionalCommits(plain), false)
  assert.equal(await usesConventionalCommits(join(dir, 'missing')), false)

  // --- Squash regeneration: the evidence is the combined diff since the fork point. ---
  writeFileSync(join(plain, 'a.txt'), 'a\n')
  writeFileSync(join(plain, '.gitignore'), 'node_modules\n')
  git(plain, 'add', '.')
  git(plain, 'commit', '-qm', 'base')
  const base = git(plain, 'rev-parse', 'HEAD')
  writeFileSync(join(plain, 'a.txt'), 'parked turn\n')
  git(plain, 'commit', '-qam', 'squashed parked turn') // the first turn's squashed commit
  writeFileSync(join(plain, 'b.txt'), 'second turn\n') // the next turn, uncommitted
  mkdirSync(join(plain, '.trezi'))
  writeFileSync(join(plain, '.trezi', 'state.json'), '{}\n')
  const combined = await changeEvidence(plain, base)
  assert.deepEqual(combined.files, [
    { path: 'a.txt', status: 'modified' },
    { path: 'b.txt', status: 'added' }
  ])
  assert.ok(combined.excerpt.includes('+parked turn'), combined.excerpt)
  assert.ok(combined.excerpt.includes('+second turn'), combined.excerpt)
  assert.ok(combined.stat.includes('b.txt'), combined.stat)
  assert.equal(
    (await describeChange({ evidence: combined })).subject,
    'Update a.txt and b.txt',
    'the regenerated message covers both turns'
  )

  // --- Trailers close the body; the subject never carries them. ---
  const trailers = { 'Trezi-Turn': '3', 'Trezi-Chat': 'trezi/chat-abc' }
  const text = fullCommitMessage(generated, trailers)
  assert.ok(text.startsWith('Make key tiles pill-shaped with --radius-pill\n\n- Round'))
  assert.ok(text.endsWith('\n\nTrezi-Turn: 3\nTrezi-Chat: trezi/chat-abc'), text)
  assert.equal(withTrailers('', trailers), 'Trezi-Turn: 3\nTrezi-Chat: trezi/chat-abc')
  writeFileSync(join(plain, 'c.txt'), 'c\n')
  git(plain, 'add', 'c.txt')
  git(plain, 'commit', '-q', '-m', text)
  assert.equal(git(plain, 'log', '-1', '--format=%s'), generated.subject)
  assert.equal(
    git(plain, 'log', '-1', '--format=%(trailers:key=Trezi-Turn,valueonly)'),
    '3',
    'git reads the trailer'
  )

  // --- The background model for descriptions: small and fast per provider. ---
  assert.equal(describeAgentOptions({ model: 'opus', effort: 'high' }).model, 'haiku')
  assert.equal(describeAgentOptions({ model: 'opus', effort: 'high' }).effort, undefined)
  assert.equal(describeAgentOptions({ provider: 'codex' }).model, 'gpt-6-sol')
  assert.equal(describeAgentOptions({ provider: 'codex' }).effort, 'low')
  const gateway = { provider: 'codex', connectionId: 'gw', model: 'exact/model' }
  assert.deepEqual(describeAgentOptions(gateway), gateway)

  console.log(
    'COMMIT-MESSAGE OK — mocked model, 3 s fallback, no prompt text, conventional, combined diff, trailers'
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

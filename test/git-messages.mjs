// LKM-150: the service reads Git's stderr without depending on Git's version.
// src/service/GitMessages.swift is compiled alone and fed stderr recorded from real
// Git, so this passes on any local Git:
// - `2.50` rows were recorded from git 2.50.1 (Apple Git-155) applying to fixture
//   repos, except rows marked `catalogue` (Git's message wording, not recorded here);
//   2.39 prints these messages the same way;
// - git 2.55 spells a patch location as `<patch path>:N` instead of `line N`. Its
//   corrupt-patch line is the GitHub runner's (LKM-142 log); the other 2.55 locations
//   follow that spelling. `2.31` rows carry the older three-way wording. Each version
//   of a case must parse to the same fields and message, and no message may show the
//   scratch patch path;
// - push: the per-ref status lines (untranslated in every version) decide a retry.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipUnlessSwift } from './helpers/darwin.mjs'

skipUnlessSwift('the Swift Git message parser')
const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'trezi-git-messages-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const binary = join(scratch, 'git-messages')
const compiler = process.platform === 'darwin' ? ['xcrun', 'swiftc'] : ['swiftc']
const built = spawnSync(
  compiler[0],
  [
    ...compiler.slice(1),
    '-module-cache-path',
    join(scratch, 'module-cache'),
    'src/service/GitMessages.swift',
    'test/fixtures/git-messages/main.swift',
    '-o',
    binary
  ],
  { cwd: root, encoding: 'utf8', timeout: 180_000 }
)
assert.equal(built.status, 0, `swiftc: ${built.error || ''}\n${built.stdout}\n${built.stderr}`)

function parse(cases) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: 30_000
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// The service's scratch lives in the profile, which may contain spaces.
const patchFile =
  '/Users/runner/Library/Application Support/Trezi/service/repository/scratch/apply-0F6E1B7A-1C2D-4E5F-8A9B-0C1D2E3F4A5B.patch'
const ONE = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-one\n+ONE\n'
const TWO =
  'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-one\n+ONE\n two\n three\n' +
  'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,2 @@\n-x\n+X\n'
const NOTE = 'Performing three-way merge...\n'
const BLOB =
  'error: repository lacks the necessary blob to perform 3-way merge.\nFalling back to direct application...\n'
const BLOB_OLD = 'error: repository lacks the necessary blob to fall back on 3-way merge.\n'

const cases = [
  {
    name: 'corrupt patch',
    patch: ONE,
    stderr: {
      '2.50': 'error: corrupt patch at line 7\n',
      2.55: `error: corrupt patch at ${patchFile}:7\n`
    },
    problems: [{ reason: 'corrupt patch', file: 'a.txt', line: 7 }],
    message: 'a.txt: corrupt patch at line 7',
    unreadable: true
  },
  {
    name: 'corrupt patch in the second file',
    patch: TWO,
    stderr: {
      '2.50': 'error: corrupt patch at line 15\n',
      2.55: `error: corrupt patch at ${patchFile}:15\n`
    },
    problems: [{ reason: 'corrupt patch', file: 'b.txt', line: 15 }],
    message: 'b.txt: corrupt patch at line 15',
    unreadable: true
  },
  {
    name: 'fragment without header',
    patch: '@@ -1 +1 @@\n-a\n+b\n',
    stderr: {
      '2.50': 'error: patch fragment without header at line 1: @@ -1 +1 @@\n',
      2.55: `error: patch fragment without header at ${patchFile}:1: @@ -1 +1 @@\n`
    },
    problems: [{ reason: 'unreadable', file: null, line: 1 }],
    message: 'patch fragment without header at line 1: @@ -1 +1 @@',
    unreadable: true
  },
  {
    name: 'header without file name',
    patch: ONE, // catalogue
    stderr: {
      '2.50':
        'error: git diff header lacks filename information when removing 1 leading pathname component (line 1)\n',
      2.55: `error: git diff header lacks filename information when removing 1 leading pathname component (${patchFile}:1)\n`
    },
    problems: [{ reason: 'unreadable', file: 'a.txt', line: 1 }],
    message:
      'a.txt: git diff header lacks filename information when removing 1 leading pathname component (line 1)',
    unreadable: true
  },
  {
    name: 'no valid patches',
    patch: 'hello\nworld\n',
    stderr: { '2.50': 'error: No valid patches in input (allow with "--allow-empty")\n' },
    problems: [{ reason: 'unreadable', file: null, line: null }],
    message: 'No valid patches in input (allow with "--allow-empty")',
    unreadable: true
  },
  {
    name: 'patch does not apply (three-way)',
    patch: ONE,
    stderr: {
      '2.50': `${BLOB}error: patch failed: a.txt:1\nerror: a.txt: patch does not apply\n`,
      2.31: `${BLOB_OLD}Falling back to three-way merge...\nerror: patch failed: a.txt:1\nerror: a.txt: patch does not apply\n`
    },
    problems: [
      { reason: 'missing blob', file: null, line: null },
      { reason: 'patch failed', file: 'a.txt', line: 1 },
      { reason: 'does not apply', file: 'a.txt', line: null }
    ],
    message: 'patch failed: a.txt:1; a.txt: patch does not apply',
    unreadable: false
  },
  {
    name: 'already exists',
    patch: ONE,
    stderr: { '2.50': 'error: b.txt: already exists in working directory\n' },
    problems: [{ reason: 'already exists', file: 'b.txt', line: null }],
    message: 'b.txt: already exists in working directory',
    unreadable: false
  },
  {
    name: 'already exists in index',
    patch: ONE, // catalogue
    stderr: { '2.50': 'error: b.txt: already exists in index\n' },
    problems: [{ reason: 'already exists', file: 'b.txt', line: null }],
    message: 'b.txt: already exists in index',
    unreadable: false
  },
  {
    name: 'does not exist in index',
    patch: ONE,
    stderr: { '2.50': 'error: c.txt: does not exist in index\n' },
    problems: [{ reason: 'does not exist', file: 'c.txt', line: null }],
    message: 'c.txt: does not exist in index',
    unreadable: false
  },
  {
    name: 'does not exist in the working tree',
    patch: ONE,
    stderr: { '2.50': 'error: c.txt: No such file or directory\n' },
    problems: [{ reason: 'does not exist', file: 'c.txt', line: null }],
    message: 'c.txt: No such file or directory',
    unreadable: false
  },
  {
    name: 'does not match index',
    patch: ONE,
    stderr: { '2.50': 'error: a.txt: does not match index\n' }, // from a stale private index
    problems: [{ reason: 'does not match index', file: 'a.txt', line: null }],
    message: 'a.txt: does not match index',
    unreadable: false
  },
  {
    name: 'only the missing blob',
    patch: ONE,
    stderr: { '2.50': BLOB, 2.31: BLOB_OLD },
    problems: [{ reason: 'missing blob', file: null, line: null }],
    unreadable: false
  },
  {
    name: 'unreadable scratch patch',
    patch: ONE,
    stderr: { '2.50': `error: can't open patch '${patchFile}': No such file or directory\n` },
    problems: [{ reason: 'other', file: null, line: null }],
    message: "can't open patch 'the patch': No such file or directory",
    unreadable: false
  },
  {
    name: 'no error lines',
    patch: ONE,
    stderr: { '2.50': `${NOTE}Applied patch to 'b.txt' with conflicts.\nU b.txt\n` },
    problems: [],
    message: 'U b.txt',
    unreadable: false
  }
]

const flat = cases.flatMap((item) =>
  Object.entries(item.stderr).map(([git, stderr]) => ({ item, git, stderr }))
)
const answers = parse(flat.map(({ item, stderr }) => ({ stderr, patch: item.patch, patchFile })))
for (const [index, { item, git, stderr }] of flat.entries()) {
  const answer = answers[index],
    label = `${item.name} (git ${git})`
  assert.deepEqual(
    answer.problems.map(({ reason, file, line }) => ({ reason, file, line })),
    item.problems,
    label
  )
  if (item.message) assert.equal(answer.message, item.message, label)
  assert.equal(answer.unreadable, item.unreadable, label)
  for (const shown of [
    answer.message,
    answer.scrubbed,
    ...answer.problems.map((problem) => problem.text)
  ]) {
    assert.ok(
      !shown.includes('apply-') && !shown.includes('/scratch/'),
      `${label} shows the scratch patch: ${shown}`
    )
  }
  if (stderr.includes(patchFile))
    assert.ok(answer.scrubbed.includes('line ') || answer.scrubbed.includes('the patch'), label)
}
// Every version of a case parses to the same fields and message.
for (const item of cases) {
  const seen = flat.flatMap((entry, index) => (entry.item === item ? [answers[index]] : []))
  for (const answer of seen.slice(1)) {
    assert.deepEqual(
      answer.problems.map(({ reason, file, line }) => ({ reason, file, line })),
      seen[0].problems.map(({ reason, file, line }) => ({ reason, file, line })),
      item.name
    )
    assert.equal(answer.message, seen[0].message, item.name)
  }
}

// Another spelling of a scratch path (a resolved /private symlink, another scratch) is scrubbed too.
const other = '/private/var/folders/x y/T/scratch/apply-11111111-2222-3333-4444-555555555555.patch'
const [moved, described] = parse([
  { stderr: `error: corrupt patch at ${other}:7\n`, patch: ONE, patchFile },
  {
    stderr: `Command failed: git apply --3way --whitespace=nowarn ${patchFile}\nerror: patch failed: a.txt:1\n`,
    patch: ONE,
    patchFile
  }
])
assert.equal(moved.message, 'a.txt: corrupt patch at line 7')
assert.equal(
  described.scrubbed,
  'Command failed: git apply --3way --whitespace=nowarn the patch\nerror: patch failed: a.txt:1\n'
)
console.log('GIT-MESSAGES apply PASS')

const remote = '/tmp/pushrec/remote.git'
const pushes = [
  {
    name: 'fetch first',
    rejected: true,
    stderr:
      `To ${remote}\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '${remote}'\n` +
      'hint: Updates were rejected because the remote contains work that you do not\nhint: have locally.\n'
  },
  {
    name: 'non-fast-forward',
    rejected: true,
    stderr: `To ${remote}\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to '${remote}'\n`
  },
  {
    name: 'remote rejected',
    rejected: true,
    stderr: `remote: denied by policy        \nTo ${remote}\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to '${remote}'\n`
  },
  // A translated Git keeps the ref status untranslated.
  {
    name: 'localized',
    rejected: true,
    stderr: `To ${remote}\n ! [rejected]        main -> main (fetch first)\nFehler: Fehler beim Versenden einiger Referenzen nach '${remote}'\n`
  },
  {
    name: 'unknown refspec',
    rejected: false,
    stderr:
      "error: src refspec main does not match any\nerror: failed to push some refs to 'origin'\n"
  },
  {
    name: 'authentication',
    rejected: false,
    stderr: "fatal: Authentication failed for 'https://github.com/x/y.git/'\n"
  },
  {
    name: 'a remote named rejected',
    rejected: false,
    stderr: "fatal: 'rejected' does not appear to be a git repository\n"
  }
]
const pushed = parse(pushes.map(({ stderr }) => ({ kind: 'push', stderr })))
for (const [index, push] of pushes.entries())
  assert.equal(pushed[index].rejected, push.rejected, push.name)
console.log('GIT-MESSAGES push PASS')
console.log('GIT-MESSAGES OK')

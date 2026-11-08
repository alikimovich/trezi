// LKM-444 follow-up: a status event is not repeated, so the Git read that answers it must
// start after the change it reports. The read in flight may have looked at the tree
// earlier; under load (a slow `git diff`) the old code handed the later call that stale
// answer and a known overlap never rendered (test/peer-feedback.mjs, 3 of 16 loaded runs).
// A stand-in `git` takes its snapshot when it starts and answers 400 ms later, which is
// exactly a loaded host. No owner, no provider.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishPeer, peerObservedFiles, startPeer } from '../src/main/peer-work.ts'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-peer-reads-')))
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8' }).trim()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const repo = join(home, 'repo')
mkdirSync(repo)
git(repo, 'init', '-q')
git(repo, 'config', 'user.email', 'fixture@trezi.test')
git(repo, 'config', 'user.name', 'Trezi fixture')
writeFileSync(join(repo, 'a.txt'), 'one\n')
git(repo, 'add', '.')
git(repo, 'commit', '-qm', 'base')
const base = git(repo, 'rev-parse', 'HEAD')

const log = join(home, 'git.log')
const bin = join(home, 'bin')
mkdirSync(bin)
writeFileSync(
  join(bin, 'git'),
  `#!/bin/sh\necho "$@" >> '${log}'\n[ -e '${join(home, 'fail')}' ] && { sleep 0.4; exit 1; }\nout=$('${realGit}' "$@")\nstatus=$?\nsleep 0.4\nprintf '%s\\n' "$out"\nexit $status\n`
)
chmodSync(join(bin, 'git'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
const reads = () =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => / diff /.test(line)).length

try {
  await startPeer(
    {
      id: 'reader',
      project: repo,
      origin: 'background',
      parent: '',
      goal: 'edit a.txt',
      intendedFiles: [],
      observedFiles: [],
      base,
      phase: 'running'
    },
    undefined,
    repo
  )

  // Control: a call with nothing in flight is one read and sees the tree as it is.
  assert.deepEqual(await peerObservedFiles(repo, [], 'reader'), [], 'a clean tree observes nothing')
  assert.equal(reads(), 1, 'a call with nothing in flight is one read')

  // The change lands while a read that started before it is still answering. A loaded host
  // can push the stand-in past the 2 s Git timeout: that read answers "incomplete" ('\0'),
  // the correct fallback rather than the stale answer under test, so only then the burst is
  // replayed (bounded) from a clean tree. A stale `[]` still fails at once.
  let late
  let alsoLate
  for (let attempt = 1; ; attempt++) {
    const before = reads()
    const early = peerObservedFiles(repo, [], 'reader')
    await pause(150)
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    late = peerObservedFiles(repo, [], 'reader')
    alsoLate = peerObservedFiles(repo, [], 'reader')
    const earlyAnswer = await early
    const lateAnswer = await late
    const timedOut = [earlyAnswer, lateAnswer].some((answer) => answer.includes('\0'))
    if (timedOut && attempt < 3) {
      console.log(`Peer observed reads: Git timed out under load (attempt ${attempt}); replaying`)
      writeFileSync(join(repo, 'a.txt'), 'one\n')
      continue
    }
    assert.deepEqual(earlyAnswer, [], 'the early read answers for the tree it saw')
    assert.deepEqual(
      lateAnswer,
      ['a.txt'],
      'a call made after the change is not answered by a read that began before it'
    )
    assert.equal(await alsoLate, lateAnswer, 'calls made meanwhile share the one fresh read')
    assert.equal(late, alsoLate, 'and are the same promise: reads stay bounded to two per burst')
    assert.equal(reads() - before, 2, 'the early read and one fresh read')
    break
  }

  // After the burst the key is free again: the next call reads once.
  const afterBurst = reads()
  assert.deepEqual(await peerObservedFiles(repo, [], 'reader'), ['a.txt'])
  assert.equal(reads() - afterBurst, 1, 'a later call is one read again')

  // When Git fails, the shared fresh read answers with what every one of its callers had
  // captured (and the incomplete mark), not only the first caller's list.
  writeFileSync(join(home, 'fail'), '')
  const failing = peerObservedFiles(repo, ['x.txt'], 'reader')
  const firstLate = peerObservedFiles(repo, ['y.txt'], 'reader')
  const secondLate = peerObservedFiles(repo, ['z.txt'], 'reader')
  assert.deepEqual(await failing, ['x.txt', '\0'], 'the failed read keeps its own captured files')
  assert.equal(firstLate, secondLate, 'the late callers share one read')
  const unknown = await firstLate
  for (const path of ['y.txt', 'z.txt', '\0'])
    assert.ok(unknown.includes(path), `the shared failed read keeps ${JSON.stringify(path)}`)
  console.log('Peer observed reads: a late change is never answered by an earlier read')
} finally {
  finishPeer('reader')
  rmSync(home, { recursive: true, force: true })
}
process.exit(0)

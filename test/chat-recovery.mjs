import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleReclaimed, initChatIsolation } from '../src/main/chat-isolation.ts'
import { pruneOrphans } from '../src/main/worktrees.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-chat-recovery-')))
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const records = new Map()
initChatIsolation({
  worktreesDir: () => join(base, 'worktrees'),
  store: () => ({
    get: (id) => records.get(id),
    save: (record) => records.set(record.id, record),
    remove: (id) => records.delete(id)
  }),
  getWindow: () => null
})

try {
  for (const prefix of ['praxis', 'trezi']) {
    for (const dirty of [true, false]) {
      const id = `${prefix}-${dirty ? 'dirty' : 'clean'}`
      const root = join(base, id)
      const worktrees = join(base, `${id}-worktrees`)
      const checkout = join(worktrees, id)
      const branch = `${prefix}/chat-${id}`
      mkdirSync(root)
      mkdirSync(worktrees)
      git(root, 'init', '-q', '-b', 'main')
      git(root, 'config', 'user.name', 'Test')
      git(root, 'config', 'user.email', 'test@local')
      writeFileSync(join(root, 'README'), 'original\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'initial')
      git(root, 'worktree', 'add', '-b', branch, checkout, 'main')
      writeFileSync(join(checkout, 'recovered.txt'), `${id} unlanded work\n`)
      if (!dirty) {
        git(checkout, 'add', '.')
        git(checkout, 'commit', '-qm', 'unmerged turn')
      }
      const reclaimed = await pruneOrphans(root, worktrees)
      assert.deepEqual(reclaimed, [{ id, dirty, branch, repoRoot: root }])
      assert.equal(existsSync(checkout), false)
      await handleReclaimed(reclaimed)
      const record = records.get(`chatpark-${id}`)
      assert.ok(record, `${id}: reclaimed work must remain accessible through chat recovery`)
      assert.equal(record.branch, branch)
      assert.equal(record.projectRoot, root)
      assert.equal(record.title, 'Recovered chat changes')
      assert.deepEqual(record.filesTouched, ['recovered.txt'])
      assert.equal(git(root, 'show', `${record.branch}:recovered.txt`), `${id} unlanded work`)
      assert.equal(existsSync(join(root, 'recovered.txt')), false, 'recovery does not apply work')
      await handleReclaimed(reclaimed)
      assert.equal(records.get(record.id).startedAt, record.startedAt)
      assert.equal((await pruneOrphans(root, worktrees)).length, 0)
    }
  }
  assert.equal(records.size, 4, 'repeated recovery does not duplicate records')
  console.log('CHAT RECOVERY OK — dirty and clean-unmerged legacy/current branches')
} finally {
  rmSync(base, { recursive: true, force: true })
}

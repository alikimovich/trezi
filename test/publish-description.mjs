import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generatePublishDescription,
  parsePublishDescription
} from '../src/main/publish-description.ts'

const root = mkdtempSync(join(tmpdir(), 'trezi-pr-test-'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
try {
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'app.js'), 'export const size = 1\n')
  git('add', '.')
  git('commit', '-m', 'Initial')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('checkout', '-b', 'feature')
  writeFileSync(join(root, 'app.js'), 'export const size = 2\n')
  git('commit', '-am', 'PRIVATE CHAT PROMPT do it for me')
  // A remote reconciliation's committed changes must also be described.
  writeFileSync(join(root, 'remote.js'), 'export const reconciled = true\n')
  git('add', '.')
  git('commit', '-m', 'Reconciled remote contribution')
  // Uncommitted edits are not in the pushed PR.
  writeFileSync(join(root, 'app.js'), 'PRIVATE UNPUBLISHED EDIT\n')
  let prompt = ''
  const result = await generatePublishDescription(root, 'main', 'feature', async (input) => {
    prompt = input
    return JSON.stringify({ title: 'Increase size', body: 'Increase the default size to two.' })
  })
  assert.equal(result.title, 'Increase size')
  assert.ok(prompt.includes('+export const size = 2'))
  assert.ok(prompt.includes('+export const reconciled = true'))
  assert.ok(!prompt.includes('PRIVATE CHAT PROMPT'))
  assert.ok(!prompt.includes('PRIVATE UNPUBLISHED EDIT'))
  await assert.rejects(
    generatePublishDescription(root, 'main', 'feature', async () => {
      throw new Error('offline')
    }),
    /Could not generate.*Luna/
  )
  assert.throws(() => parsePublishDescription('{"title":"x","body":""}'))
  assert.throws(() =>
    parsePublishDescription(JSON.stringify({ title: 'x', body: 'word '.repeat(121) }))
  )
  assert.throws(() => parsePublishDescription('not json'))
  console.log(
    'PUBLISH-DESCRIPTION OK — committed diff, reconciled changes, no chat, bounded output and explicit failure'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

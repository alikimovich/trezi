// LKM-132: Trezi's earlier names appear only in the read-compatibility shims listed
// in docs/agent-guide/legacy-names.md (linked from AGENTS.md), each only in the files
// that page names. Tests of the shims, the PROGRESS/TASKS history and the compiled
// asset catalog are the exceptions.
// A listed file that no longer carries an earlier name is a stale entry. Pure; reads git.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
assert.match(
  readFileSync(join(root, 'AGENTS.md'), 'utf8'),
  /^## Legacy names$[^#]*\]\(docs\/agent-guide\/legacy-names\.md\)/m,
  'AGENTS.md links the one list'
)
const page = readFileSync(join(root, 'docs/agent-guide/legacy-names.md'), 'utf8')
const rows = page
  .split('\n')
  .filter(
    (line) => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Shim')
  )
const listed = new Set(
  rows.flatMap((row) =>
    [
      ...row
        .split(' | ')
        .at(-1)
        .matchAll(/`([^`]+)`/g)
    ].map((match) => match[1])
  )
)
assert.ok(listed.size > 20, 'the table lists the shim files')
for (const path of listed) assert.ok(existsSync(join(root, path)), `listed file exists: ${path}`)

const exempt = (path) =>
  path.startsWith('test/') ||
  ['docs/PROGRESS.md', 'docs/TASKS.md', 'build/Assets.car'].includes(path)
let found
try {
  found = execFileSync('git', ['grep', '-il', '--untracked', '-e', 'praxis', '-e', 'dsgn'], {
    cwd: root,
    encoding: 'utf8'
  })
} catch (error) {
  if (error.status !== 1) throw error
  found = ''
}
const hits = found.split('\n').filter(Boolean)
const unlisted = hits.filter((path) => !listed.has(path) && !exempt(path))
assert.deepEqual(unlisted, [], 'an earlier name outside the files the legacy-names page lists')
const stale = [...listed].filter((path) => !hits.includes(path))
assert.deepEqual(
  stale,
  [],
  'listed in the legacy-names page but no longer carrying an earlier name'
)
console.log(
  `LEGACY-NAMES AUDIT OK — ${hits.length} files carry an earlier name, all listed or exempt`
)

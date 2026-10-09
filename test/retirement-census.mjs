// S15 retirement census (docs/SWIFT-BACKEND-RETIREMENT.md), executable:
// - every Bun module under src/main, src/native and src/shared that writes files, runs a
//   process or sends a signal has exactly one census row, and every row still has one;
// - the gate line counts the Bun-owned rows and must stay open: LKM-111 removed the
//   rollback launch, so no shipped file may name its switch or flag again;
// - the project sidecars the editing owner commits are the same set in Swift and TS,
//   and the modules moved to it (notes, starter tokens) write nothing themselves.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')

const WRITES = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'unlink',
  'unlinkSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'truncate',
  'truncateSync',
  'createWriteStream',
  'chmod',
  'chmodSync',
  'utimes',
  'utimesSync'
])
const PROCESSES = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork'
])

/** The effects a module can perform, from its imports and Bun/process calls. */
export function effects(source) {
  const found = new Set()
  for (const match of source.matchAll(
    /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](?:node:)?(fs|fs\/promises|child_process)['"]/g
  )) {
    if (match[1]) continue
    for (const raw of match[2].split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
      if (WRITES.has(name)) found.add('fs')
      if (PROCESSES.has(name)) found.add('process')
    }
  }
  // A namespace or default import can reach anything.
  if (
    /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+['"](?:node:)?(fs|fs\/promises|child_process)['"]/.test(
      source
    )
  )
    found.add('namespace')
  if (/\brequire\(\s*['"](?:node:)?(fs|fs\/promises|child_process)['"]\s*\)/.test(source))
    found.add('namespace')
  if (/\bBun\.(spawn|spawnSync|write)\(/.test(source)) found.add('process')
  if (/\bprocess\.kill\(/.test(source)) found.add('signal')
  return found
}

// The scanner itself: a named write, a process, a namespace import, a signal; types and reads are not effects.
assert.deepEqual(
  [...effects("import { readFile, writeFile as w } from 'node:fs/promises'")],
  ['fs']
)
assert.deepEqual([...effects("import { execFile } from 'child_process'")], ['process'])
assert.deepEqual([...effects("import * as fs from 'fs'")], ['namespace'])
assert.deepEqual([...effects("import fs from 'node:fs'")], ['namespace'])
assert.deepEqual([...effects('process.kill(-pid, 0)')], ['signal'])
assert.deepEqual(
  [
    ...effects(
      "import type { ChildProcess } from 'node:child_process'\nimport { readFile, stat } from 'fs/promises'"
    )
  ],
  []
)

const walk = (directory) =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(join(root, path)).isDirectory()) return walk(path)
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : []
  })
const scanned = new Map(
  ['src/main', 'src/native', 'src/shared']
    .flatMap(walk)
    .map((path) => [relative('.', path), effects(read(path))])
    .filter(([, found]) => found.size)
)

const doc = read('docs/SWIFT-BACKEND-RETIREMENT.md')
const CLASSES = new Set(['helper', 'test', 'bun'])
const rows = [...doc.matchAll(/^\| `(src\/[^`]+)` \| (\w+) \| ([^|]+) \| ([^|]+) \|$/gm)].map(
  ([, path, kind, owner, effect]) => ({ path, kind, owner: owner.trim(), effect: effect.trim() })
)
assert.ok(rows.length > 0, 'the census table parses')

const listed = new Map()
for (const row of rows) {
  assert.ok(!listed.has(row.path), `${row.path} is listed once`)
  listed.set(row.path, row)
  assert.ok(CLASSES.has(row.kind), `${row.path}: unknown class ${row.kind}`)
  assert.ok(row.kind === 'test' || row.owner !== '—', `${row.path} names its final owner`)
  assert.ok(row.effect, `${row.path} names its effect`)
  assert.ok(
    scanned.has(row.path),
    `${row.path} has no file, process or signal effect any more: remove its row (and update the gate)`
  )
  if (row.kind === 'test')
    assert.match(row.path, /^src\/native\/smoke-/, `${row.path}: only smoke fixtures are test rows`)
}
const missing = [...scanned.keys()].filter((path) => !listed.has(path))
assert.deepEqual(missing, [], `modules with effects missing from the census: ${missing.join(', ')}`)

// The gate line agrees with the rows. LKM-111 removed the rollback launch and its Bun
// twins, so there is nothing to fall back to: the gate stays open (no Bun-owned row),
// and no launcher, service flag or module may bring the rollback back.
const bun = rows.filter((row) => row.kind === 'bun')
const gate = doc.match(/\*\*Retirement gate: (?:blocked by (\d+) Bun-owned rows?|open)\.\*\*/)
assert.ok(gate, 'the status names the retirement gate')
assert.equal(Number(gate[1] ?? 0), bun.length, 'the gate counts the Bun-owned rows')
assert.deepEqual(
  bun.map((row) => row.path),
  [],
  'with no rollback launch, every effect has its Swift owner'
)
const shipped = [
  ...['src', 'scripts', 'bin'].flatMap(function files(directory) {
    return readdirSync(join(root, directory)).flatMap((name) => {
      const path = join(directory, name)
      return statSync(join(root, path)).isDirectory()
        ? files(path)
        : /\.(ts|mjs|cjs|js|swift)$|^trezi$/.test(name)
          ? [path]
          : []
    })
  }),
  'package.json',
  'install.sh'
]
for (const path of shipped) {
  const text = read(path)
  assert.doesNotMatch(
    text,
    /TREZI_BACKEND_OWNER|TREZI_PROVIDER_HELPERS/,
    `${path} still names a removed launch switch`
  )
  assert.doesNotMatch(text, /["'`]--legacy["'`]/, `${path} still passes TreziService --legacy`)
}

// Project sidecars: one set in Swift and TS; the moved modules only render.
const swiftNames = read('src/service/EditingStores.swift').match(
  /static let names: Set<String> = \[([^\]]*)\]/
)[1]
const tsNames = read('src/main/editing-owner.ts').match(
  /export const SIDECAR_NAMES[^=]*= \[([^\]]*)\]/
)[1]
const names = (text) => [...text.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]).sort()
assert.deepEqual(names(swiftNames), names(tsNames), 'Swift and TS commit the same sidecars')
assert.deepEqual(names(tsNames), ['annotations.json', 'control-panels.json', 'tokens.json'])
for (const path of ['src/main/annotation-store.ts', 'src/main/tokens.ts'])
  assert.deepEqual([...effects(read(path))], [], `${path} writes through the editing owner only`)

// `.trezi/` project files belong to the editing owner: the helpers a chat worktree
// carries are the ones setup installs, and the migration moves the three .dsgn files.
const literals = (text) => [...text.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
const swiftProject = read('src/service/EditingProject.swift'),
  swiftSetup = read('src/service/WorkflowSetup.swift')
assert.deepEqual(
  literals(swiftProject.match(/static let helpers = \[([^\]]*)\]/)[1]).sort(),
  literals(swiftSetup.match(/static let helpers: Set<String> = \[([^\]]*)\]/)[1])
    .map((path) => path.replace(/^\.trezi\//, ''))
    .sort(),
  'worktrees carry the helpers setup installs'
)
assert.deepEqual(literals(swiftProject.match(/static let dsgnFiles = \[([^\]]*)\]/)[1]), [
  'annotations.json',
  'tokens.json',
  'control-panels.json'
])

const count = (kind) => rows.filter((row) => row.kind === kind).length
console.log(
  `RETIREMENT CENSUS OK — ${rows.length} modules with effects classified (${count('helper')} helper, ${count('test')} test, ${bun.length} Bun-owned: gate ${bun.length ? 'blocked' : 'open'}; no rollback launch)`
)

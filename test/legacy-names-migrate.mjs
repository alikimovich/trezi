/**
 * The one-time rename to Trezi names (LKM-132), run by the real Swift editing owner
 * (`EditingLegacyNames.swift`):
 *  - a dirty tree is never rewritten without confirmation (byte-for-byte unchanged);
 *  - confirmed, or on a clean tree, `.praxis/praxis-*` helpers become `.trezi/trezi-*`,
 *    config imports and `data-praxis-*` stamps follow, and nothing is committed;
 *  - a helper that differs from the current one is kept under `.trezi/legacy/praxis/`;
 *  - binary and ignored files are untouched; a second run is a no-op.
 *
 * Run with: bun test/legacy-names-migrate.mjs
 */
import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { editingOwner } from '../src/main/editing-owner.ts'

const work = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-legacy-names-')))
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const read = (root, path) => readFileSync(join(root, path), 'utf8')
const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const snapshot = (root) => {
  const files = {}
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      if (name === '.git') continue
      const path = rel ? `${rel}/${name}` : name
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else files[path] = readFileSync(join(root, path)).toString('base64')
    }
  }
  walk('')
  return files
}

/** A project set up before the rename: helper, config import, static stamps, event listener. */
function legacyProject(name) {
  const root = join(work, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  write(
    root,
    '.praxis/praxis-source.cjs',
    "module.exports = () => ({ name: 'praxis-source', attr: 'data-praxis-source' })\n"
  )
  write(
    root,
    'vite.config.js',
    "import source from './.praxis/praxis-source.cjs'\nexport default { plugins: [source()] }\n"
  )
  write(root, 'index.html', '<main data-praxis-source="index.html:1:1">Hi</main>\n')
  write(root, 'src/app.js', "window.addEventListener('praxis:animation-replay', replay)\n")
  write(root, '.gitignore', 'node_modules\n.praxis/cache\n')
  writeFileSync(
    join(root, 'logo.bin'),
    Buffer.from([0, 1, 2, ...Buffer.from('data-praxis-source')])
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'legacy')
  return root
}

try {
  const owner = editingOwner()

  // Dirty tree: planned, refused without confirmation, nothing changes.
  const dirty = legacyProject('dirty')
  write(
    dirty,
    'src/app.js',
    "window.addEventListener('praxis:animation-replay', replay) // edited\n"
  )
  const plan = await owner.legacyNames(dirty)
  assert.equal(plan.legacy, true)
  assert.equal(plan.clean, false, 'an uncommitted edit makes the tree dirty')
  assert.deepEqual(plan.helpers, ['.praxis/praxis-source.cjs'])
  assert.deepEqual(
    plan.files,
    ['.gitignore', 'index.html', 'src/app.js', 'vite.config.js'],
    'binary files are not candidates'
  )
  const before = snapshot(dirty)
  const refused = await owner.migrateNames(dirty, false)
  assert.deepEqual(refused, { migrated: false, dirty: true })
  assert.deepEqual(snapshot(dirty), before, 'a dirty tree is never rewritten without confirmation')

  // Confirmed: rewritten, not committed; the user's own edit survives.
  const done = await owner.migrateNames(dirty, true)
  assert.equal(done.migrated, true)
  assert.equal(done.dirty, true)
  assert.equal(
    read(dirty, 'vite.config.js'),
    "import source from './.trezi/trezi-source.cjs'\nexport default { plugins: [source()] }\n"
  )
  assert.equal(read(dirty, 'index.html'), '<main data-trezi-source="index.html:1:1">Hi</main>\n')
  assert.equal(
    read(dirty, 'src/app.js'),
    "window.addEventListener('trezi:animation-replay', replay) // edited\n"
  )
  assert.equal(read(dirty, '.gitignore'), 'node_modules\n.trezi/cache\n')
  assert.equal(
    read(dirty, '.trezi/trezi-source.cjs'),
    "module.exports = () => ({ name: 'trezi-source', attr: 'data-trezi-source' })\n"
  )
  assert.ok(!existsSync(join(dirty, '.praxis')), 'the legacy folder is gone')
  assert.ok(!existsSync(join(dirty, '.trezi/praxis-source.cjs')), 'no legacy copy left in .trezi')
  assert.ok(
    readFileSync(join(dirty, 'logo.bin')).includes('data-praxis-source'),
    'binary files are untouched'
  )
  assert.equal(git(dirty, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing is committed')
  assert.deepEqual(await owner.legacyNames(dirty), {
    legacy: false,
    clean: false,
    files: [],
    helpers: []
  })
  const after = snapshot(dirty)
  assert.deepEqual(
    await owner.migrateNames(dirty, true),
    { migrated: false, dirty: true },
    'a second run is a no-op'
  )
  assert.deepEqual(snapshot(dirty), after, 'and changes nothing')

  // Clean tree: migrates without asking; a differing current helper wins, the old one is kept.
  const clean = legacyProject('clean')
  write(clean, '.trezi/trezi-source.cjs', '// current helper\n')
  const cleanPlan = await owner.legacyNames(clean)
  assert.equal(cleanPlan.clean, true, 'untracked .trezi/ metadata does not make the tree dirty')
  const migrated = await owner.migrateNames(clean, false)
  assert.equal(migrated.migrated, true)
  assert.equal(migrated.dirty, false)
  assert.deepEqual(migrated.kept, ['.trezi/legacy/praxis/praxis-source.cjs'])
  assert.equal(read(clean, '.trezi/trezi-source.cjs'), '// current helper\n')
  assert.equal(
    read(clean, '.trezi/legacy/praxis/praxis-source.cjs'),
    "module.exports = () => ({ name: 'praxis-source', attr: 'data-praxis-source' })\n"
  )
  assert.match(read(clean, 'vite.config.js'), /\.trezi\/trezi-source\.cjs/)
  assert.equal(git(clean, 'rev-list', '--count', 'HEAD').trim(), '1', 'nothing is committed')

  // A folder outside git is never clean: it waits for confirmation too.
  const loose = join(work, 'loose')
  write(loose, 'index.html', '<p data-praxis-source="index.html:1:1"></p>\n')
  assert.deepEqual(await owner.migrateNames(loose, false), { migrated: false, dirty: true })
  assert.equal(read(loose, 'index.html'), '<p data-praxis-source="index.html:1:1"></p>\n')
  assert.equal((await owner.migrateNames(loose, true)).migrated, true)
  assert.equal(read(loose, 'index.html'), '<p data-trezi-source="index.html:1:1"></p>\n')

  console.log(
    'LEGACY-NAMES OK — dirty tree refused unless confirmed; helpers, imports and stamps renamed; nothing committed'
  )
} catch (err) {
  console.error('LEGACY-NAMES FAILED:', err?.stack ?? err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}

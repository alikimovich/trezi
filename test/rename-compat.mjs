import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { touchesSidecar } from '../src/main/backends/tools'
import { editingOwner } from '../src/main/editing-owner'
import { isWorkBranch } from '../src/main/git'
import { canonicalPreference } from '../src/native/preferences'
import { nativeProfilePath, nativeSessionPath } from '../src/native/profile-path'
import { sourceStamp } from '../src/preview/source-stamp'
import { compatibleEnvironment } from '../src/shared/rename-compat'
import { useRunnerEnv } from './helpers/runner-env.mjs'

// The service's editing owner runs the migration (LKM-111 removed the TS copy).
const migrateLegacySidecar = (project) => editingOwner().migrateSidecar(project)
const root = mkdtempSync(join(tmpdir(), 'trezi rename-'))
// The CI runner's conditions (LKM-142): no Git identity, `git init` not on main, HOME and TMPDIR with spaces.
// biome-ignore lint/correctness/useHookAtTopLevel: not a React hook, it sets the process env
useRunnerEnv(root)
const put = (path, value) => writeFileSync(path, value)

const binary = join(root, 'profile-paths')
function buildProfilePaths() {
  const built = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-module-cache-path',
      join(root, 'module-cache'),
      'src/service/ProfilePaths.swift',
      'test/fixtures/profile-paths/main.swift',
      '-o',
      binary
    ],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 300_000 }
  )
  assert.equal(built.status, 0, `swiftc: ${built.error || ''}\n${built.stdout}\n${built.stderr}`)
}
/** What the service does before Bun starts (ProfilePaths.swift, LKM-102): `kind` is `profile` or `sessions`. */
function migrate(kind, path, cwd) {
  const run = spawnSync(binary, [kind, path], { cwd, encoding: 'utf8' })
  return run.status === 0 ? { path: run.stdout.trim() } : { error: run.stderr.trim() }
}

/** The service is the only writer of the aliases (LKM-111 removed Bun's twin). Each case:
 * Swift migrates it, then Bun's resolver (profile-path.ts) must give the same answer on
 * the migrated tree and change nothing. Before a migration, Bun refuses and changes nothing. */
function profileParity() {
  const snapshot = (base, dir = base) =>
    readdirSync(dir)
      .sort()
      .flatMap((name) => {
        const path = join(dir, name),
          info = lstatSync(path),
          key = relative(base, path)
        if (info.isSymbolicLink())
          return [`${key} -> ${readlinkSync(path).replaceAll(realpathSync(base), '<case>')}`]
        if (info.isDirectory()) return [`${key}/`, ...snapshot(base, path)]
        return [`${key}: ${readFileSync(path, 'utf8')}`]
      })
  // Relative to the case, whether a path came through the temp dir's link or its real path.
  const rel = (base, path) =>
    relative(
      realpathSync(base),
      path.startsWith(`${base}/`) ? realpathSync(base) + path.slice(base.length) : path
    )
  const answer = (run, base) => {
    try {
      return { path: rel(base, run()) }
    } catch (error) {
      return { error: error.message ?? String(error) }
    }
  }
  let index = 0
  const twin = (kind, setup, target = '', cwd = false) => {
    const base = join(root, 'parity', String(++index))
    mkdirSync(base, { recursive: true })
    setup(base)
    return again(kind, base, target, cwd)
  }
  const again = (kind, base, target = '', cwd = false) => {
    const call = kind === 'profile' ? nativeProfilePath : nativeSessionPath
    const run = migrate(kind, cwd ? target : join(base, target), cwd ? base : undefined)
    const swiftAnswer =
      run.error === undefined
        ? { path: rel(base, resolve(cwd ? realpathSync(base) : base, run.path)) }
        : run
    const tree = snapshot(base)
    const saved = process.cwd()
    if (cwd) process.chdir(base)
    const tsAnswer = answer(() => resolve(call(cwd ? target : join(base, target))), base)
    process.chdir(saved)
    assert.deepEqual(tsAnswer, swiftAnswer, `${kind} ${target}: Bun resolves what Swift migrated`)
    assert.deepEqual(snapshot(base), tree, `${kind} ${target}: Bun changes nothing`)
    return { base, answer: swiftAnswer }
  }
  const store = (dir, name, content = 'keep me') => {
    mkdirSync(join(dir, name, 'worktrees', 'chat'), { recursive: true })
    put(join(dir, name, 'sessions.json'), content)
  }
  // Profiles: fresh (nothing created), legacy (relative alias), repeated, broken, collision, a file.
  assert.deepEqual(twin('profile', () => {}).answer, { path: 'Trezi Native' })
  const legacy = (base) => {
    mkdirSync(join(base, 'Praxis Native'))
    put(join(base, 'Praxis Native', 'native.lock'), '1')
  }
  const aliased = twin('profile', legacy)
  assert.equal(readlinkSync(join(aliased.base, 'Trezi Native')), 'Praxis Native')
  again('profile', aliased.base) // repeated
  twin('profile', (base) => {
    legacy(base)
    symlinkSync('Praxis Native', join(base, 'Trezi Native'))
  })
  assert.match(
    twin('profile', (base) => symlinkSync('missing', join(base, 'Trezi Native'))).answer.error,
    /broken/
  )
  assert.match(
    twin('profile', (base) => {
      legacy(base)
      mkdirSync(join(base, 'Trezi Native'))
    }).answer.error,
    /Separate/
  )
  assert.match(
    twin('profile', (base) => put(join(base, 'Praxis Native'), 'file')).answer.error,
    /real directory/
  )
  twin('profile', () => {}, 'missing-support')
  // Session stores: praxis, dsgn, both (same and different), relative profile, an interrupted alias, collisions.
  for (const name of ['praxis', 'dsgn']) {
    const done = twin('sessions', (base) => store(base, name))
    assert.equal(realpathSync(join(done.base, 'trezi')), realpathSync(join(done.base, name)))
    again('sessions', done.base) // repeated
    rmSync(join(done.base, 'trezi'))
    again('sessions', done.base) // interrupted
  }
  twin('sessions', (base) => {
    store(base, 'praxis')
    symlinkSync('praxis', join(base, 'dsgn'))
  })
  assert.match(
    twin('sessions', (base) => {
      store(base, 'praxis')
      store(base, 'dsgn')
    }).answer.error,
    /Both Praxis and dsgn/
  )
  assert.match(
    twin('sessions', (base) => {
      store(base, 'praxis')
      mkdirSync(join(base, 'trezi'))
    }).answer.error,
    /Separate Trezi/
  )
  assert.match(
    twin('sessions', (base) => put(join(base, 'praxis'), 'file')).answer.error,
    /real directory/
  )
  twin(
    'sessions',
    (base) => {
      mkdirSync(join(base, 'profile'))
      store(join(base, 'profile'), 'praxis')
    },
    './profile',
    true
  )
  twin('sessions', (base) => {
    store(base, 'praxis')
    symlinkSync(realpathSync(join(base, 'praxis')), join(base, 'trezi'))
  })
  // Bun never creates an alias the service did not.
  const unmigrated = join(root, 'parity', 'unmigrated')
  mkdirSync(unmigrated, { recursive: true })
  legacy(unmigrated)
  store(unmigrated, 'praxis')
  const before = snapshot(unmigrated)
  assert.throws(() => nativeProfilePath(unmigrated), /service did not migrate/)
  assert.throws(() => nativeSessionPath(unmigrated), /service did not migrate/)
  assert.deepEqual(snapshot(unmigrated), before)
}
try {
  buildProfilePaths()
  const version = spawnSync(
    process.execPath,
    [new URL('../bin/trezi.mjs', import.meta.url).pathname, '--version'],
    { encoding: 'utf8' }
  )
  assert.equal(version.status, 0)
  assert.match(version.stdout, /^Trezi /)
  const fresh = join(root, 'fresh')
  mkdirSync(fresh)
  assert.equal(nativeProfilePath(fresh), join(fresh, 'Trezi Native'))
  assert(!existsSync(join(fresh, 'Praxis Native')))
  const support = join(root, 'support'),
    old = join(support, 'Praxis Native')
  mkdirSync(join(old, 'praxis', 'worktrees', 'chat'), { recursive: true })
  put(join(old, 'native.lock'), String(process.pid))
  put(join(old, 'workspace.json'), '{"draft":"keep me"}')
  put(join(old, 'praxis', 'sessions.json'), '{"conversation":"keep me too"}')
  migrate('profile', support)
  const profile = nativeProfilePath(support)
  assert.equal(realpathSync(profile), realpathSync(old))
  assert.equal(
    readFileSync(join(profile, 'native.lock'), 'utf8'),
    String(process.pid),
    'both versions see the same writer lock'
  )
  assert.equal(nativeProfilePath(support), profile)
  migrate('sessions', profile)
  const sessions = nativeSessionPath(profile)
  assert.equal(
    readFileSync(join(sessions, 'sessions.json'), 'utf8'),
    '{"conversation":"keep me too"}'
  )
  assert.equal(
    realpathSync(join(sessions, 'worktrees', 'chat')),
    realpathSync(join(old, 'praxis', 'worktrees', 'chat'))
  )
  assert.equal(nativeSessionPath(profile), sessions)
  // Both override names may contain relative paths. Alias targets must still
  // resolve to the existing physical store on initial and repeated migration.
  const originalCwd = process.cwd()
  process.chdir(root)
  try {
    for (const envName of ['TREZI_USER_DATA', 'PRAXIS_USER_DATA']) {
      for (const legacy of ['praxis', 'dsgn']) {
        const directory = join(root, envName, legacy)
        mkdirSync(join(directory, legacy), { recursive: true })
        put(join(directory, legacy, 'sessions.json'), 'preserved')
        const override = `./${envName}/${legacy}`
        const env = { [envName]: override }
        compatibleEnvironment(env)
        migrate('sessions', env.TREZI_USER_DATA)
        const migrated = nativeSessionPath(env.TREZI_USER_DATA)
        assert.equal(readFileSync(join(migrated, 'sessions.json'), 'utf8'), 'preserved')
        assert.equal(realpathSync(migrated), realpathSync(join(directory, legacy)))
        assert.equal(nativeSessionPath(env.TREZI_USER_DATA), migrated)
        rmSync(migrated)
        assert.throws(() => nativeSessionPath(env.TREZI_USER_DATA), /service did not migrate/)
        migrate('sessions', env.TREZI_USER_DATA)
        assert.equal(nativeSessionPath(env.TREZI_USER_DATA), migrated)
        assert.equal(readFileSync(join(migrated, 'sessions.json'), 'utf8'), 'preserved')
      }
    }
  } finally {
    process.chdir(originalCwd)
  }
  // A real Git worktree continues to resolve through the new session alias.
  const repository = join(root, 'repo')
  mkdirSync(repository)
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  git(repository, ['init', '-q'])
  git(repository, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@local',
    'commit',
    '--allow-empty',
    '-m',
    'base',
    '-q'
  ])
  const legacyWorktree = join(old, 'praxis', 'worktrees', 'real')
  git(repository, ['worktree', 'add', '-b', 'praxis/chat-fixture', legacyWorktree])
  assert.equal(git(join(sessions, 'worktrees', 'real'), ['status', '--porcelain']), '')
  assert(
    git(repository, ['worktree', 'list', '--porcelain']).includes(realpathSync(legacyWorktree))
  )
  // The profile lock (and the old `native.lock` reservation) is the service's: a Bun
  // backend started without it refuses before touching the profile, so it can never
  // share one with a running Trezi of either version.
  const backend = new URL(
    '../out/native/Trezi.app/Contents/Resources/backend/index.cjs',
    import.meta.url
  )
  if (existsSync(backend)) {
    const env = { ...process.env, TREZI_USER_DATA: profile }
    delete env.TREZI_SERVICE_LOCKED
    const blocked = spawnSync(process.execPath, [backend.pathname], {
      env,
      encoding: 'utf8',
      timeout: 10000
    })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /must be started by its service/)
    assert.equal(
      readFileSync(join(profile, 'native.lock'), 'utf8'),
      String(process.pid),
      'the refused backend leaves the lock alone'
    )
  }

  // Interruption after the profile alias but before the session alias: the service resumes it.
  rmSync(sessions)
  migrate('sessions', profile)
  assert.equal(nativeSessionPath(profile), sessions)
  // Preference names: the owner stores praxis names beside their canonical copy (test/preferences-owner.mjs).
  assert.equal(canonicalPreference('praxis:old'), 'trezi:old')
  assert.equal(canonicalPreference('praxis.old'), 'trezi.old')
  assert.equal(canonicalPreference('trezi:new'), 'trezi:new')
  const collision = join(root, 'collision')
  mkdirSync(join(collision, 'Praxis Native'), { recursive: true })
  mkdirSync(join(collision, 'Trezi Native'))
  assert.throws(() => nativeProfilePath(collision), /Separate/)
  const both = join(root, 'both')
  mkdirSync(join(both, 'praxis'), { recursive: true })
  mkdirSync(join(both, 'trezi'))
  assert.throws(() => nativeSessionPath(both), /Separate/)
  profileParity()
  const project = join(root, 'project')
  mkdirSync(join(project, '.praxis'), { recursive: true })
  put(join(project, '.praxis', 'annotations.json'), '["legacy"]')
  put(join(project, '.praxis', 'control-panels.json'), '{"panels":[]}')
  put(join(project, '.praxis', 'praxis-source.cjs'), '// existing config imports this')
  await migrateLegacySidecar(project)
  assert.equal(readFileSync(join(project, '.trezi', 'annotations.json'), 'utf8'), '["legacy"]')
  assert(existsSync(join(project, '.praxis', 'praxis-source.cjs')))
  await migrateLegacySidecar(project)
  // A partially completed migration copies missing entries on restart.
  rmSync(join(project, '.trezi', 'control-panels.json'))
  await migrateLegacySidecar(project)
  assert(existsSync(join(project, '.trezi', 'control-panels.json')))
  put(join(project, '.trezi', 'annotations.json'), '["canonical"]')
  await migrateLegacySidecar(project)
  assert.equal(readFileSync(join(project, '.trezi', 'annotations.json'), 'utf8'), '["canonical"]')
  assert.equal(readFileSync(join(project, '.praxis', 'annotations.json'), 'utf8'), '["legacy"]')
  const unsafe = join(root, 'unsafe')
  mkdirSync(unsafe)
  symlinkSync(join(project, '.praxis'), join(unsafe, '.praxis'))
  await assert.rejects(migrateLegacySidecar(unsafe), /real directory/)
  const env = { PRAXIS_USER_DATA: 'old', PRAXIS_CODEX_BIN: 'codex', TREZI_USER_DATA: 'new' }
  compatibleEnvironment(env)
  assert.equal(env.TREZI_USER_DATA, 'new')
  assert.equal(env.TREZI_CODEX_BIN, 'codex')
  for (const name of ['trezi', 'praxis', 'dsgn']) {
    assert(touchesSidecar('Write', { file_path: `/repo/.${name}/secrets.json` }))
    assert(isWorkBranch(`${name}/main`))
  }
  const attrs = new Map([['data-praxis-source', 'old:1:1']])
  const element = { getAttribute: (key) => attrs.get(key) ?? null }
  assert.equal(sourceStamp(element), 'old:1:1')
  attrs.set('data-trezi-source', 'new:2:1')
  assert.equal(sourceStamp(element), 'new:2:1')
  console.log(
    'RENAME-COMPAT OK: fresh, legacy, repeated, interruption, collisions, Swift profile-path parity, ownership, preferences, environment and stamps'
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

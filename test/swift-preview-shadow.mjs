/**
 * LKM-275: the Trezi-owned shadow xcodebuild and SwiftPM run in instead of the user's
 * project. Layout (symlinked folders, copied `.xcodeproj` and package manifests, no
 * `.git`/`.build`/`.swiftpm`), local packages outside the project and transitive ones,
 * path mapping back to the project (also through `/private`), removal however the run
 * ends (and a stale shadow swept), and the guarantee that nothing a tool writes in the
 * shadow reaches the real tree: its entries, empty folders and mtimes stay as they were.
 */
import assert from 'node:assert/strict'
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
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  Shadow,
  findPackageDirs,
  packageDirs,
  runInShadow,
  withLocalDependencies,
  withShadow,
  xcodeSpec
} = await import('../src/swift-preview/shadow.ts')

const temp = mkdtempSync(join(tmpdir(), 'swift-shadow-'))
const write = (path, text = '') => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
/** Every entry (empty folders too) with kind, size and mtime. */
const snapshot = (dir, prefix = '', out = {}) => {
  for (const name of readdirSync(dir).sort()) {
    const stat = lstatSync(join(dir, name))
    const kind = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file'
    out[`${prefix}${name}`] = `${kind}:${kind === 'file' ? stat.size : 0}:${stat.mtimeMs}`
    if (kind === 'dir') snapshot(join(dir, name), `${prefix}${name}/`, out)
  }
  return out
}
const isLink = (path) => lstatSync(path).isSymbolicLink()

try {
  // ws/Shared (a package outside the project), ws/app (the project), a transitive chain.
  const ws = join(temp, 'ws')
  const app = join(ws, 'app')
  write(
    join(ws, 'Shared/Package.swift'),
    '// swift-tools-version:5.9\nlet p = Package(name: "Shared", dependencies: [.package(path: "../Deep")])'
  )
  write(join(ws, 'Shared/Sources/Shared/Shared.swift'), 'public let shared = 1')
  write(join(ws, 'Deep/Package.swift'), '// swift-tools-version:5.9\nlet p = Package(name: "Deep")')
  write(join(ws, 'Deep/Sources/Deep/Deep.swift'), 'public let deep = 1')
  write(join(ws, 'Unrelated/Package.swift'), 'let p = Package(name: "Unrelated")')
  write(
    join(app, 'Packages/Core/Package.swift'),
    '// swift-tools-version:5.9\nlet p = Package(name: "Core", dependencies: [.package(path: "../../../Shared")])'
  )
  write(join(app, 'Packages/Core/Package.resolved'), '{}')
  write(join(app, 'Packages/Core/Sources/Core/Core.swift'), 'public let core = 1')
  write(join(app, 'Packages/Core/Resources/empty.txt'))
  mkdirSync(join(app, 'Packages/Core/EmptyFolder'))
  write(join(app, 'Packages/Core/.build/artifact'), 'x')
  write(join(app, 'Packages/Core/.swiftpm/state'), 'x')
  write(join(app, 'App.xcodeproj/project.pbxproj'), '// pbxproj')
  mkdirSync(join(app, 'App.xcodeproj/xcuserdata'))
  write(join(app, 'App/AppMain.swift'), '@main struct A {}')
  mkdirSync(join(app, 'App/Empty'))
  write(join(app, '.git/HEAD'), 'ref')
  write(join(app, 'node_modules/Hidden/Package.swift'), 'let p = Package(name: "Hidden")')
  write(join(app, '.hidden/Package.swift'), 'let p = Package(name: "Hidden2")')
  write(join(app, 'DerivedData/Stale/Package.swift'), 'let p = Package(name: "Stale")')
  // Old mtimes: any touch shows.
  for (const path of [join(app, 'App.xcodeproj'), join(app, 'Packages/Core'), app, ws])
    utimesSync(path, new Date(2020, 0, 1), new Date(2020, 0, 1))

  // --- Discovery ---
  assert.deepEqual(
    findPackageDirs(app),
    [join(app, 'Packages/Core')],
    'no hidden/generated folders'
  )
  assert.deepEqual(
    withLocalDependencies([join(app, 'Packages/Core')]).sort(),
    [join(app, 'Packages/Core'), join(ws, 'Shared'), join(ws, 'Deep')].sort(),
    'local packages come along, transitively, outside the project too'
  )
  assert.deepEqual(
    packageDirs(
      app,
      [
        { kind: 'local', path: '../Shared' },
        { kind: 'remote', path: 'x' },
        { kind: 'local', path: 'missing' }
      ],
      [join(app, 'Packages/Core')]
    ).sort(),
    [join(app, 'Packages/Core'), join(ws, 'Shared')].sort()
  )
  const spec = xcodeSpec(app, { kind: 'project', path: 'App.xcodeproj' }, findPackageDirs(app))
  assert.deepEqual(spec.copies, [join(app, 'App.xcodeproj')])
  assert.deepEqual(
    xcodeSpec(
      app,
      { kind: 'workspace', path: 'App.xcworkspace', projects: ['Other/O.xcodeproj'] },
      []
    ).copies,
    [join(app, 'App.xcworkspace'), join(app, 'Other/O.xcodeproj')]
  )

  // --- Layout ---
  const before = snapshot(ws)
  const shadow = new Shadow(join(temp, 'shadow-1'), spec)
  shadow.create()
  const root = shadow.root
  assert.equal(root, join(temp, 'shadow-1/app'), 'the folder name is kept (package identities)')
  assert.ok(isLink(join(root, 'App')), 'project folders are links')
  assert.equal(readlinkSync(join(root, 'App')), join(app, 'App'))
  assert.ok(!isLink(join(root, 'App.xcodeproj')), 'the .xcodeproj is a copy')
  assert.equal(readFileSync(join(root, 'App.xcodeproj/project.pbxproj'), 'utf8'), '// pbxproj')
  assert.ok(existsSync(join(root, 'App.xcodeproj/xcuserdata')), 'with its empty folders')
  assert.ok(!existsSync(join(root, '.git')), 'history is not mirrored')
  assert.ok(isLink(join(root, 'node_modules')), 'other folders are links')
  const core = join(root, 'Packages/Core')
  assert.ok(!isLink(join(root, 'Packages')), 'the folders on the way to a package are real')
  assert.ok(!isLink(core), 'a package folder is a real folder')
  assert.ok(!isLink(join(core, 'Package.swift')) && !isLink(join(core, 'Package.resolved')))
  assert.ok(isLink(join(core, 'Sources')) && isLink(join(core, 'Resources')))
  assert.ok(isLink(join(core, 'EmptyFolder')), 'even an empty one')
  for (const name of ['.build', '.swiftpm'])
    assert.ok(!existsSync(join(core, name)), `${name} is not mirrored`)
  assert.ok(
    existsSync(join(temp, 'shadow-1/Shared/Package.swift')),
    'a package outside the project'
  )
  assert.ok(existsSync(join(temp, 'shadow-1/Deep/Package.swift')), 'and its dependency')
  assert.ok(!existsSync(join(temp, 'shadow-1/Unrelated')), 'but not unrelated ones')
  assert.equal(shadow.of(join(ws, 'Shared')), join(temp, 'shadow-1/Shared'))

  // What a tool writes lands in the copies and package folders, never in the project.
  mkdirSync(join(root, 'App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/configuration'), {
    recursive: true
  })
  writeFileSync(join(root, 'App.xcodeproj/project.xcworkspace/contents.xcworkspacedata'), 'x')
  mkdirSync(join(core, '.swiftpm/configuration'), { recursive: true })
  mkdirSync(join(core, '.swiftpm/xcode'), { recursive: true })
  writeFileSync(join(core, 'Package.resolved'), '{"changed":true}')
  mkdirSync(join(temp, 'shadow-1/Shared/.swiftpm/configuration'), { recursive: true })
  assert.deepEqual(snapshot(ws), before, 'the project tree is exactly as it was')
  assert.equal(readFileSync(join(app, 'Packages/Core/Package.resolved'), 'utf8'), '{}')

  // --- Mapping ---
  const real = realpathSync(shadow.dir)
  assert.equal(
    shadow.map(`error: ${root}/App.xcodeproj and ${real}/app/App/AppMain.swift`),
    `error: ${app}/App.xcodeproj and ${app}/App/AppMain.swift`
  )
  assert.equal(
    shadow.map(`${join(temp, 'shadow-1/Shared')}/Package.swift`),
    `${join(ws, 'Shared')}/Package.swift`
  )
  assert.equal(shadow.map(''), '')
  shadow.remove()
  assert.ok(!existsSync(shadow.dir))

  // --- runInShadow: removal however the run ends, mapped output, no project fallback ---
  const cache = join(temp, 'cache')
  const base = join(cache, 'shadow')
  let cwd = ''
  const ok = await runInShadow(cache, spec, async (dir) => {
    cwd = dir
    mkdirSync(join(dir, 'App.xcodeproj/project.xcworkspace'))
    return { code: 0, stdout: `${dir}/App/AppMain.swift`, stderr: `at ${dir}`, error: '' }
  })
  assert.ok(cwd.startsWith(base) && cwd.endsWith('/app'), cwd)
  assert.deepEqual(
    [ok.stdout, ok.stderr],
    [`${app}/App/AppMain.swift`, `at ${app}`],
    "paths in the output are the project's"
  )
  assert.deepEqual(readdirSync(base), [], 'the shadow is removed')
  const thrown = await runInShadow(cache, spec, async () => {
    throw new Error('tool crashed')
  })
  assert.match(thrown.error, /could not prepare its shadow copy of the project/)
  assert.match(thrown.error, /tool crashed/)
  assert.deepEqual(readdirSync(base), [], 'removed after a crash too')
  await assert.rejects(
    withShadow(cache, spec, async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  assert.deepEqual(readdirSync(base), [])
  assert.deepEqual(snapshot(ws), before, 'the project is untouched by all of it')

  // A shadow that cannot be made: the tool never runs and the project is not the fallback.
  const blocked = join(temp, 'blocked')
  writeFileSync(blocked, 'a file where a folder belongs')
  let ran = false
  const failed = await runInShadow(blocked, spec, async () => {
    ran = true
    return { code: 0, stdout: '', stderr: '', error: '' }
  })
  assert.equal(ran, false)
  assert.match(failed.error, /the project itself is never used to run build tools/)
  assert.deepEqual(snapshot(ws), before)

  // A project that vanished or has dangling links does not break the shadow.
  symlinkSync(join(temp, 'nowhere'), join(app, 'Dangling'))
  const dangling = await runInShadow(cache, spec, async (dir) => ({
    code: 0,
    stdout: String(isLink(join(dir, 'Dangling'))),
    stderr: '',
    error: ''
  }))
  assert.equal(dangling.stdout, 'true')
  rmSync(join(app, 'Dangling'))
  utimesSync(app, new Date(2020, 0, 1), new Date(2020, 0, 1))

  // Stale shadows (a crashed run) are swept; fresh ones, which may be in use, are not.
  mkdirSync(join(base, 'old'), { recursive: true })
  mkdirSync(join(base, 'fresh'), { recursive: true })
  utimesSync(join(base, 'old'), new Date(2020, 0, 1), new Date(2020, 0, 1))
  await withShadow(cache, spec, async () => {})
  assert.deepEqual(readdirSync(base), ['fresh'])

  // Concurrent runs do not share state: each has its own shadow.
  const cwds = await Promise.all(
    [1, 2, 3].map((n) =>
      runInShadow(cache, spec, async (dir) => {
        writeFileSync(join(dir, 'App.xcodeproj', `mine-${n}`), String(n))
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          code: 0,
          stdout: readdirSync(join(dir, 'App.xcodeproj'))
            .filter((f) => f.startsWith('mine'))
            .join(),
          stderr: '',
          error: ''
        }
      })
    )
  )
  assert.deepEqual(
    cwds.map((r) => r.stdout),
    ['mine-1', 'mine-2', 'mine-3']
  )
  assert.deepEqual(snapshot(ws), before)

  // --- Regression: shadow-run tools keep their sandbox ---
  for (const file of ['shadow', 'build-settings', 'package-build'])
    assert.doesNotMatch(
      readFileSync(new URL(`../src/swift-preview/${file}.ts`, import.meta.url), 'utf8'),
      /disable-sandbox/,
      file
    )
  console.log('swift-preview-shadow: layout, mapping, cleanup and an untouched project verified.')
} finally {
  rmSync(temp, { recursive: true, force: true })
}

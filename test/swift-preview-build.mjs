/**
 * LKM-275 with the real toolchain: `test/fixtures/swift-package-app` (an app target, a
 * framework target and a local package with a resource, plus an asset catalog) builds
 * through a PreviewSession with settings from `xcodebuild -showBuildSettings`, the
 * package from `swift build` and the catalog from actool, all in Trezi's derived data,
 * and renders. Then a disposable copy of Scraib-xcode, when the original is on this
 * machine: its resolved settings (SWIFT_VERSION 5, DEBUG, macOS 14) match an independent
 * `xcodebuild -showBuildSettings` and the app target builds. The original is only read
 * and is byte-compared afterwards. Where this process runs inside another sandbox that
 * stops SwiftPM's or the compiler's own sandbox, the run says ENVIRONMENT and stops:
 * nothing is retried with a sandbox turned off.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRAIB = process.env.TREZI_SCRAIB_XCODE || '/Users/panda/dev/scraib-xcode'
const SCRAIB_PREVIEWS = join(
  ROOT,
  'docs/evidence/lkm-273/scraib-validation/xcode-target-previews.swift'
)
const { PreviewSession } = await import('../src/swift-preview/session.ts')
const { treziManifestDir } = await import('../src/main/swift-preview.ts')
const { splitList, swiftVersionFlag } = await import('../src/swift-preview/settings.ts')

const ENVIRONMENT =
  /another sandbox|sandbox_apply|could not apply SwiftPM's|plugin server could not start/

/**
 * Every file and folder under a folder (`.git` aside, the folder itself included): path
 * to a content hash and the mtime. Folders, empty ones too, count: creating and removing
 * a folder in the project is a write even when nothing is left behind (it moves the
 * parent's mtime).
 */
function tree(dir) {
  const entries = { '.': `folder@${lstatSync(dir).mtimeMs}` }
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      if (name === '.git') continue
      const path = join(folder, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        entries[`${relative(dir, path)}/`] = `folder@${stat.mtimeMs}`
        walk(path)
      } else
        entries[relative(dir, path)] = `${
          stat.isFile()
            ? createHash('sha256').update(readFileSync(path)).digest('hex')
            : stat.isSymbolicLink()
              ? 'symlink'
              : 'other'
        }@${stat.mtimeMs}`
    }
  }
  walk(dir)
  return entries
}

/** The paths added, removed or changed between two `tree`s. */
function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort()
    .map((path) => `${!(path in before) ? '+' : !(path in after) ? '-' : '~'} ${path}`)
}

// Elapsed seconds on each session's start and end, so a CI log shows which build was slow
// (LKM-345). Static names only.
const startedAt = Date.now()
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`

async function run(name, options) {
  const logs = []
  const session = new PreviewSession({
    hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
    moduleCache: MODULE_CACHE,
    log: (line) => logs.push(line),
    pollMs: 150,
    ...options
  })
  const begun = Date.now()
  console.log(`swift-preview-build: [${elapsed()}] start ${name}`)
  session.start()
  const end = Date.now() + 360_000
  while (Date.now() < end && !['ready', 'failed', 'error'].includes(session.state.status))
    await new Promise((resolve) => setTimeout(resolve, 200))
  console.log(
    `swift-preview-build: [${elapsed()}] ${name} ${session.state.status} (${((Date.now() - begun) / 1000).toFixed(1)}s)`
  )
  return { session, logs, state: session.state }
}

/** The reason this process cannot run the real tools, or ''. */
function environment(state) {
  const texts = [
    state.message,
    state.output,
    ...(state.build?.errors ?? []),
    state.toolchain?.capability?.message ?? ''
  ]
  if (state.status === 'ready') return ''
  if (state.toolchain?.capability?.status === 'unavailable')
    return state.toolchain.capability.message
  return texts.find((t) => ENVIRONMENT.test(t ?? '')) ?? ''
}

const temp = mkdtempSync(join(tmpdir(), 'swift-build-'))
try {
  if (process.platform !== 'darwin')
    console.log('swift-preview-build: real check skipped (not macOS)')
  else if (await fixture()) await scraib()
} finally {
  rmSync(temp, { recursive: true, force: true })
}

/** The fixture; false when this environment cannot run the real tools. */
async function fixture() {
  // --- The multi-module fixture with a local package and resources ---
  const project = join(temp, 'gallery')
  cpSync(join(ROOT, 'test/fixtures/swift-package-app'), project, { recursive: true })
  const before = tree(project)
  const cacheDir = join(temp, 'DerivedData/gallery')
  const gallery = await run('fixture build', { root: project, cacheDir })
  try {
    const reason = environment(gallery.state)
    if (reason) {
      console.log(`swift-preview-build: ENVIRONMENT: real build not run: ${reason}`)
      assert.deepEqual(changes(before, tree(project)), [], 'the project stays untouched')
      return false
    }
    const s = gallery.state
    assert.equal(
      s.status,
      'ready',
      `${s.message}\n${s.output}\n${gallery.logs.slice(-20).join('\n')}`
    )
    assert.deepEqual(s.plan.blockers, [])
    assert.deepEqual(
      s.plan.modules.map((m) => [m.module, m.entries]),
      [
        ['GalleryKit', []],
        ['Gallery', ['Gallery/GalleryApp.swift']]
      ]
    )
    assert.deepEqual(s.build.settingsFrom, {
      GalleryKit: 'xcodebuild (scheme Gallery)',
      Gallery: 'xcodebuild (scheme Gallery)'
    })
    const app = s.plan.modules[1].settings
    assert.equal(app.swiftVersion, '5')
    assert.equal(app.deploymentTarget, '14.0')
    for (const define of ['DEBUG', 'GALLERY_FIXTURE', 'GALLERY_FLAG'])
      assert.ok(app.defines.includes(define), `${define} in ${app.defines}`)
    assert.ok(
      app.dropped.some((d) => d.flag === '-Xfrontend -warn-long-function-bodies=500'),
      JSON.stringify(app.dropped)
    )
    assert.ok(s.build.derivedData.startsWith(cacheDir), s.build.derivedData)
    assert.ok(s.build.packages.bin.startsWith(cacheDir), s.build.packages.bin)
    assert.ok(
      s.build.packages.bundles.some((b) => b.endsWith('StudioDesign_StudioDesign.bundle')),
      JSON.stringify(s.build.packages)
    )
    assert.ok(s.build.resources.assets.startsWith(cacheDir), JSON.stringify(s.build.resources))
    assert.deepEqual(s.build.resources.symbols, ['Gallery'])
    // The module's own catalog beside its dylib: `Bundle(for:)`, which the symbols use.
    const galleryKey = s.build.modules.find((m) => m.module === 'Gallery')?.key
    const galleryDir = join(cacheDir, 'modules', `Gallery-${galleryKey}`)
    assert.ok(
      existsSync(join(galleryDir, 'Assets.car')),
      `${galleryDir}: ${existsSync(galleryDir) ? readdirSync(galleryDir) : 'missing'}`
    )
    const badge = await gallery.session.describe('tagline-badge')
    assert.ok(badge.includes('Tagline: Hello from the package bundle'), JSON.stringify(badge))
    const card = await gallery.session.describe('brand-card')
    for (const text of ['Brand: 0.20 0.40 0.80', 'Flags: DEBUG GALLERY_FIXTURE GALLERY_FLAG'])
      assert.ok(card.includes(text), `${text} in ${JSON.stringify(card)}`)
    const frame = await gallery.session.frame('brand-card')
    assert.deepEqual([frame.width, frame.height], [360, 170])
    console.log(
      `swift-preview-build: fixture built with ${s.toolchain.toolchain?.developerDir} in ${s.durationMs} ms: package bundle, asset catalog and settings verified`
    )
  } finally {
    await gallery.session.stop()
  }
  // Not just no leftovers: no write at all. Every entry, empty folders and mtimes included
  // (the `.xcodeproj` and `Packages/StudioDesign` among them), is as it was.
  assert.deepEqual(changes(before, tree(project)), [], 'nothing was written into the project')
  assert.ok(Object.keys(before).includes('Gallery.xcodeproj/'), 'the tree covers the project')
  assert.ok(Object.keys(before).includes('Packages/StudioDesign/'))
  return true
}

/** Scraib-xcode, a disposable copy; the original is only read. */
async function scraib() {
  if (!existsSync(join(SCRAIB, 'scraib.xcodeproj')))
    return console.log(
      `swift-preview-build: Scraib check not run: ${SCRAIB} is not on this machine`
    )
  const original = tree(SCRAIB)
  const copy = join(temp, 'scraib')
  cpSync(SCRAIB, copy, {
    recursive: true,
    filter: (path) => !/\/(\.git|DerivedData|build|\.build)(\/|$)/.test(path)
  })
  const manifestDir = treziManifestDir(copy, join(temp, 'userData'))
  mkdirSync(join(manifestDir, 'Previews'), { recursive: true })
  cpSync(SCRAIB_PREVIEWS, join(manifestDir, 'Previews/TreziPreviews.swift'))
  writeFileSync(
    join(manifestDir, 'trezi-previews.json'),
    JSON.stringify({ name: 'Scraib (disposable copy)', target: 'scraib', previews: ['Previews'] })
  )
  // The independent xcodebuild query below creates state of its own: it gets its own copy.
  const check = join(temp, 'scraib-check')
  cpSync(copy, check, { recursive: true })
  const copied = tree(copy)
  const built = await run('Scraib build', {
    root: copy,
    cacheDir: join(temp, 'DerivedData/scraib'),
    manifestDir
  })
  try {
    const s = built.state
    const reason = environment(s)
    if (reason) console.log(`swift-preview-build: ENVIRONMENT: Scraib build not run: ${reason}`)
    else {
      const settings = s.plan.modules.find((m) => m.module === 'scraib')?.settings
      assert.ok(settings, JSON.stringify(s.plan?.modules?.map((m) => m.module)))
      assert.equal(s.build.settingsFrom.scraib, 'xcodebuild (scheme scraib)')
      // An independent xcodebuild run on the copy, in its own derived data.
      const shown = spawnSync(
        '/usr/bin/xcodebuild',
        [
          '-showBuildSettings',
          '-json',
          '-project',
          join(check, 'scraib.xcodeproj'),
          '-scheme',
          'scraib',
          '-configuration',
          'Debug',
          '-destination',
          'platform=macOS',
          '-derivedDataPath',
          join(temp, 'xcodebuild-check')
        ],
        { encoding: 'utf8', env: { ...process.env, ...s.toolchain.env }, cwd: check }
      )
      const entries = JSON.parse(shown.stdout.slice(shown.stdout.indexOf('[')))
      const xcode = entries.find((e) => e.target === 'scraib').buildSettings
      assert.equal(settings.swiftVersion, swiftVersionFlag(xcode.SWIFT_VERSION))
      assert.equal(settings.deploymentTarget, xcode.MACOSX_DEPLOYMENT_TARGET)
      for (const define of splitList(xcode.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? ''))
        assert.ok(settings.defines.includes(define), `${define} in ${settings.defines}`)
      assert.deepEqual(
        [settings.swiftVersion, settings.defines.includes('DEBUG'), settings.deploymentTarget],
        ['5', true, '14.0'],
        'SWIFT_VERSION 5, DEBUG and macOS 14'
      )
      assert.equal(s.status, 'ready', `${s.message}\n${s.output}`)
      const texts = await built.session.describe(s.previews[0].id)
      console.log(
        `swift-preview-build: Scraib copy built in ${s.durationMs} ms (Swift ${settings.swiftVersion}, defines ${settings.defines.join(' ')}, macOS ${settings.deploymentTarget}, ${s.previews.length} previews, ${texts.length} texts; dropped ${settings.dropped.map((d) => d.flag).join(', ') || 'none'})`
      )
    }
  } finally {
    await built.session.stop()
  }
  assert.deepEqual(
    changes(copied, tree(copy)),
    [],
    'the Scraib copy, empty folders and mtimes included (its .xcodeproj too), is as it was'
  )
  assert.deepEqual(changes(original, tree(SCRAIB)), [], 'the Scraib original is byte-identical')
  console.log('swift-preview-build: Scraib original byte-compared unchanged')
}

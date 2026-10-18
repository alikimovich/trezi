import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeProjectInfo } from '../shared/api'
import type { NativeBridge } from './bridge'
import { initRepo } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const CARD = 'Gallery/BrandCard.swift'
const FOLDER = '/Swift Gallery'

/**
 * LKM-275: the native build authority in Trezi. Opens a copy of
 * `test/fixtures/swift-package-app` (an app target, a framework target that uses a local
 * package with a `Bundle.module` resource, and an asset catalog with generated symbols),
 * waits for the build, checks the settings came from `xcodebuild -showBuildSettings`
 * (SWIFT_VERSION 5, the conditions, OTHER_SWIFT_FLAGS' `-D` with the `-Xfrontend` flag
 * dropped and reported, macOS 14), that the package and the catalog were built in Trezi's
 * derived data, and that both components render with their resources. An app-module edit
 * rebuilds only that module. The project's Git tree stays clean throughout.
 */
export async function checkSwiftBuild(
  host: NativeBridge,
  invoke: (channel: string, ...args: any[]) => Promise<any>,
  fixture: string,
  root: string,
  artifacts: string,
  firstProject: string
) {
  const project = join(fixture, `..${FOLDER}`)
  rmSync(project, { recursive: true, force: true })
  cpSync(join(root, 'test/fixtures/swift-package-app'), project, { recursive: true })
  initRepo(project)
  // Every change, ignored files included; only Trezi's own `.trezi/` sidecar (not build
  // output, and never in a snapshot) is left out.
  const gitStatus = () =>
    spawnSync('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], {
      cwd: project,
      encoding: 'utf8'
    })
      .stdout.split('\n')
      .filter((line) => line.trim() && !/^.. \.trezi\//.test(line))
      .join('\n')
  assert.equal(gitStatus(), '', 'the copy starts committed')
  const initialTree = snapshot(project)
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const state = () =>
    page(`(() => {
      const api = window.__treziSwiftPreview
      if (!api || !api.state) return null
      const img = document.getElementById('frame'), s = api.state
      return { status: s.status, generation: s.generation, message: s.message,
        shown: document.body.dataset.shown || '', loaded: img.complete && img.naturalWidth > 0,
        plan: s.plan && { modules: s.plan.modules.map((m) => ({ module: m.module, entries: m.entries,
          settings: m.settings })), blockers: s.plan.blockers, warnings: s.plan.warnings,
          dependencies: s.plan.dependencies, resources: s.plan.resources },
        build: s.build }
    })()`)
  const describe = (id: string) =>
    page(`fetch('/describe?preview=${id}').then((r) => r.json()).then((r) => r.texts)`) as Promise<
      string[]
    >
  const select = async (id: string, generation: number) => {
    await page(`window.__treziSwiftPreview.select(${JSON.stringify(id)})`)
    return waitFor(
      async () => {
        const s = await state()
        return s?.shown === `${id}@${generation}` && s.loaded && s
      },
      `${id} frame of build ${generation}`,
      20_000
    )
  }
  const capture = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeFileSync(
      join(artifacts, `swift-build-${name}.png`),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  }
  const ready = (generation: number, label: string) =>
    waitFor(
      async () => {
        const s = await state()
        if (s?.status === 'error' || (s?.status === 'failed' && s.generation < generation))
          throw new Error(`${label}: ${s.message}`)
        return s?.status === 'ready' && s.generation >= generation && s
      },
      label,
      300_000
    )
  const evidence: Record<string, unknown> = {}

  await nativeWorkspace.command({ type: 'open', root: project })
  assert.notEqual(nativeWorkspace.active?.key ?? '', firstProject, 'the Xcode project is open')
  await waitFor(() => nativeWorkspace.state.status.kind === 'running', 'driver running', 60_000)
  const first = await ready(1, 'first build with packages and resources')
  evidence.firstBuild = first
  assert.deepEqual(first.plan.blockers, [])
  assert.deepEqual(
    first.plan.modules.map((m: any) => [m.module, m.entries]),
    [
      ['GalleryKit', []],
      ['Gallery', ['Gallery/GalleryApp.swift']]
    ],
    'the app target compiled minus its entry point'
  )
  const build = first.build
  assert.deepEqual(build.settingsFrom, {
    GalleryKit: 'xcodebuild (scheme Gallery)',
    Gallery: 'xcodebuild (scheme Gallery)'
  })
  const app = first.plan.modules[1].settings
  assert.deepEqual(
    [app.swiftVersion, app.deploymentTarget],
    ['5', '14.0'],
    'SWIFT_VERSION 5 and macOS 14 from xcodebuild'
  )
  for (const define of ['DEBUG', 'GALLERY_FIXTURE', 'GALLERY_FLAG'])
    assert.ok(app.defines.includes(define), `${define} in ${app.defines}`)
  assert.ok(
    app.dropped.some(
      (d: any) =>
        d.setting === 'OTHER_SWIFT_FLAGS' && d.flag === '-Xfrontend -warn-long-function-bodies=500'
    ),
    JSON.stringify(app.dropped)
  )
  assert.match(build.derivedData, /swift-previews\/DerivedData\/[0-9a-f]{12}\/xcode-/)
  assert.ok(build.packages.bin.startsWith(join(build.derivedData, '..')), build.packages.bin)
  assert.ok(
    build.packages.bundles.some((b: string) => b.endsWith('StudioDesign_StudioDesign.bundle'))
  )
  assert.match(build.resources.assets, /\/resources\/assets-[0-9a-f]{16}\/Assets\.car$/)
  assert.deepEqual(build.resources.symbols, ['Gallery'])
  assert.deepEqual(build.resources.errors, [])
  assert.deepEqual(
    first.plan.dependencies.packages.map((p: any) => [p.identity, p.kind]),
    [['studiodesign', 'local']]
  )

  // Both components render with their resources and settings.
  evidence.badge = await select('tagline-badge', first.generation)
  const badge = await describe('tagline-badge')
  assert.ok(badge.includes('Tagline: Hello from the package bundle'), JSON.stringify(badge))
  await capture('package-resource')
  evidence.card = await select('brand-card', first.generation)
  const card = await describe('brand-card')
  for (const text of ['Brand: 0.20 0.40 0.80', 'Flags: DEBUG GALLERY_FIXTURE GALLERY_FLAG'])
    assert.ok(card.includes(text), `${text} in ${JSON.stringify(card)}`)
  await capture('asset-catalog-settings')

  // The project panel names the settings source, the dropped flag, the package and the catalog.
  await page(`document.getElementById('project').open = true`)
  evidence.panel = await waitFor(
    () =>
      page(`(() => {
        const text = document.getElementById('project-body').innerText
        return /Build settings/.test(text) && /from xcodebuild \\(scheme Gallery\\): Swift 5, macOS 14\\.0/.test(text) &&
          /Dropped OTHER_SWIFT_FLAGS -Xfrontend/.test(text) && /Package studiodesign \\(local\\)/.test(text) &&
          /Asset catalog Gallery\\/Assets\\.xcassets \\(actool\\), with asset symbols/.test(text) &&
          /Derived data \\(Trezi-owned\\)/.test(text) && text
      })()`),
    'build authority in the project panel'
  )
  await capture('project-panel')
  await page(`document.getElementById('project').open = false`)
  const info = (await invoke('project:native', project)) as NativeProjectInfo
  assert.equal(info.error, '')
  const reported = info.build as { settingsFrom: Record<string, string> } | null
  assert.equal(reported?.settingsFrom.Gallery, 'xcodebuild (scheme Gallery)', 'project:native')

  // An app-module edit: GalleryKit and the package come from the cache.
  const file = join(project, CARD)
  const original = readFileSync(file, 'utf8')
  assert.ok(original.includes('"Flags: \\('))
  writeFileSync(file, original.replace('"Flags: \\(', '"Build flags: \\('))
  const edited = await ready(first.generation + 1, 'rebuild after an app edit')
  const cached = Object.fromEntries(edited.build.modules.map((m: any) => [m.module, m.cached]))
  assert.deepEqual(
    cached,
    { GalleryKit: true, Gallery: false },
    JSON.stringify(edited.build.modules)
  )
  assert.equal(edited.build.packages.cached, true, 'the package build is reused')
  assert.equal(edited.build.resources.cached, true, 'the catalog is reused')
  await select('brand-card', edited.generation)
  assert.ok(
    (await describe('brand-card')).includes('Build flags: DEBUG GALLERY_FIXTURE GALLERY_FLAG')
  )
  evidence.rebuild = { modules: edited.build.modules, packages: edited.build.packages }
  writeFileSync(file, original)
  await ready(edited.generation + 1, 'rebuild after the revert')

  // The build wrote nothing in the project: Git sees no change, and the whole tree
  // (empty folders and every mtime, the `.xcodeproj` and the package included) is as it was.
  assert.equal(gitStatus(), '', 'the project tree is unchanged (ignored files included)')
  // The check's own edit (written, then restored) is the one entry it touched itself.
  const finalTree = snapshot(project)
  finalTree[CARD] = initialTree[CARD]
  assert.deepEqual(
    Object.entries(finalTree).filter(([path, stamp]) => initialTree[path] !== stamp),
    [],
    'no entry of the project changed during the builds'
  )
  assert.deepEqual(
    Object.keys(finalTree).filter((path) => !(path in initialTree)),
    [],
    'no entry was added to the project'
  )
  assert.deepEqual(
    Object.keys(initialTree).filter((path) => !(path in finalTree)),
    [],
    'no entry was removed from the project'
  )
  evidence.provenance = {
    syntheticDirectWrites: [`${CARD}: "Flags:" → "Build flags:", then back`],
    fixtures: [
      'Edits are direct writes to the opened copy, not chat turns.',
      'The page panel is opened through the DOM; no OS input.'
    ]
  }
  writeFileSync(join(artifacts, 'swift-build.json'), JSON.stringify(evidence, null, 2))
  await restoreSwiftBuild(host, firstProject)
  console.log(
    'Native Swift build authority: xcodebuild settings, a local package with Bundle.module and an asset catalog build and render.'
  )
}

/**
 * Every entry below `dir` (folders, empty ones too, files, links) with its kind, size and
 * mtime; Git's own folder and Trezi's `.trezi/` sidecar are left out.
 */
function snapshot(dir: string, prefix = '', out: Record<string, string> = {}) {
  for (const name of readdirSync(dir).sort()) {
    if (!prefix && (name === '.git' || name === '.trezi')) continue
    const path = join(dir, name)
    const stat = lstatSync(path)
    const kind = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file'
    out[`${prefix}${name}`] = `${kind}:${kind === 'file' ? stat.size : 0}:${stat.mtimeMs}`
    if (kind === 'dir') snapshot(path, `${prefix}${name}/`, out)
  }
  return out
}

/** Back to the first fixture project and its page, with the Xcode project closed. */
export async function restoreSwiftBuild(host: NativeBridge, firstProject: string) {
  const gallery = nativeWorkspace.state.projects.find((p) => p.root.endsWith(FOLDER))
  if (firstProject && nativeWorkspace.active?.key !== firstProject) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${firstProject}` })
    await waitFor(() => nativeWorkspace.active?.key === firstProject, 'first project selected')
  }
  if (gallery) await nativeWorkspace.command({ type: 'close', key: gallery.key })
  await waitFor(
    () =>
      host.request('evaluate', {
        view: 'preview',
        code: '!!document.querySelector("#native-title")'
      }),
    'first project page shown',
    20_000
  )
}

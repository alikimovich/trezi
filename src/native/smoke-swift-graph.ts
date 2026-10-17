import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeProjectInfo } from '../shared/api'
import type { NativeBridge } from './bridge'
import { initRepo } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const FORMAT = 'StudioKit/StudioFormat.swift'
const FOLDER = '/Swift Studio'

/**
 * LKM-273: a multi-module Xcode project in Trezi. Opens a copy of
 * `test/fixtures/swift-multi-module` (an app target with `@main` that depends on a
 * framework target), waits for the target-graph build (StudioKit, then Studio, then the
 * host), captures a library SwiftUI and AppKit component and the cross-module app view,
 * opens the page's project panel, reads `project:native`, then breaks and fixes the
 * library module: the error names StudioKit and its file while the last good build stays.
 */
export async function checkSwiftGraph(
  host: NativeBridge,
  invoke: (channel: string, ...args: any[]) => Promise<any>,
  fixture: string,
  root: string,
  artifacts: string,
  firstProject: string
) {
  const project = join(fixture, `..${FOLDER}`)
  rmSync(project, { recursive: true, force: true })
  cpSync(join(root, 'test/fixtures/swift-multi-module'), project, { recursive: true })
  initRepo(project)
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const state = () =>
    page(`(() => {
      const api = window.__treziSwiftPreview, body = document.body
      if (!api || !api.state) return null
      const img = document.getElementById('frame'), s = api.state
      return { status: s.status, generation: s.generation, stale: s.stale, message: s.message,
        preview: api.preview, previews: s.previews.map((p) => p.id), shown: body.dataset.shown || '',
        loaded: img.complete && img.naturalWidth > 0, width: img.width, height: img.height,
        manifest: s.manifest, failures: api.failures,
        plan: s.plan && { target: s.plan.target, modules: s.plan.modules.map((m) => ({ module: m.module,
          dependencies: m.dependencies, sources: m.sources, entries: m.entries })),
          blockers: s.plan.blockers, warnings: s.plan.warnings },
        problems: [...document.querySelectorAll('#problem-list li')].map((li) => li.textContent),
        toolchain: s.toolchain && { dir: s.toolchain.toolchain && s.toolchain.toolchain.developerDir,
          env: s.toolchain.env, preview: s.toolchain.capability && s.toolchain.capability.status,
          chip: document.getElementById('toolchain').textContent } }
    })()`)
  const describe = (id: string) =>
    page(`fetch('/describe?preview=${id}').then((r) => r.json()).then((r) => r.texts)`)
  const shown = (id: string, generation: number) =>
    waitFor(
      async () => {
        const s = await state()
        return s?.shown === `${id}@${generation}` && s.loaded && s
      },
      `${id} frame of build ${generation}`,
      20_000
    )
  const select = async (id: string, generation: number) => {
    await page(`window.__treziSwiftPreview.select(${JSON.stringify(id)})`)
    return shown(id, generation)
  }
  const capture = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeFileSync(
      join(artifacts, `swift-graph-${name}.png`),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  }
  const write = (from: string, to: string) => {
    const file = join(project, FORMAT)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes(from), `${FORMAT} has ${from}`)
    writeFileSync(file, text.replace(from, to))
  }
  const evidence: Record<string, unknown> = {}

  await nativeWorkspace.command({ type: 'open', root: project })
  assert.notEqual(nativeWorkspace.active?.key ?? '', firstProject, 'the Xcode project is open')
  await waitFor(() => nativeWorkspace.state.status.kind === 'running', 'driver running', 60_000)
  evidence.firstBuild = await waitFor(
    async () => {
      const s = await state()
      if (s?.status === 'error') throw new Error(`Target-graph build: ${s.message}`)
      return s?.status === 'ready' && s
    },
    'first target-graph build',
    240_000
  )
  const first = evidence.firstBuild as { plan: any; manifest: any; message: string }
  assert.deepEqual(
    first.plan.modules.map((m: any) => [m.module, m.dependencies, m.entries]),
    [
      ['StudioKit', [], []],
      ['Studio', ['StudioKit'], ['Studio/StudioApp.swift']]
    ],
    'the library first; the @main file left out'
  )
  assert.equal(first.manifest.source, 'repo')
  assert.match(first.manifest.treziPath, /swift-previews\/[0-9a-f]{16}\/trezi-previews\.json$/)
  // LKM-274: the selected developer directory, process-local, shown in the header.
  const toolchain = (evidence.firstBuild as { toolchain: any }).toolchain
  assert.ok(toolchain?.dir, 'the build selected a developer directory')
  assert.deepEqual(toolchain.env, { DEVELOPER_DIR: toolchain.dir })
  assert.ok(
    ['supported', 'unsupported', 'unavailable'].includes(toolchain.preview),
    toolchain.preview
  )
  assert.ok(toolchain.chip.includes('#Preview'), `toolchain chip: ${toolchain.chip}`)

  // Library SwiftUI and AppKit components and the cross-module app view, in Trezi.
  evidence.swiftui = await select('status-badge', 1)
  assert.ok((await describe('status-badge')).includes('Reviews: 2 items'))
  await capture('library-swiftui')
  evidence.appkit = await select('level-meter', 1)
  assert.ok((await describe('level-meter')).includes('Level 3 of 5'))
  await capture('library-appkit')
  evidence.crossModule = await select('project-header', 1)
  const header = await describe('project-header')
  assert.ok(header.includes('Launch plan') && header.includes('Open tasks: 3 items'), `${header}`)
  await capture('cross-module')

  // The project panel and the backend's read of the same graph.
  await page(`document.getElementById('project').open = true`)
  evidence.panel = await waitFor(
    () =>
      page(`(() => {
        const text = document.getElementById('project-body').innerText
        return /StudioKit framework/.test(text) && /Build plan for Studio/.test(text) &&
          /Toolchain/.test(text) && /xcode-select stays/.test(text) && text
      })()`),
    'project panel'
  )
  await capture('project-panel')
  await page(`document.getElementById('project').open = false`)
  const info = (await invoke('project:native', project)) as NativeProjectInfo
  assert.equal(info.error, '', 'the backend read the graph from the driver')
  assert.deepEqual(info.structure?.projects, ['Studio.xcodeproj'])
  assert.equal(info.toolchain?.developerDir, toolchain.dir, 'project:native reports the toolchain')
  assert.equal(info.toolchain?.preview, toolchain.preview)
  const graph = info.graph as { containers: { path: string; targets: any[]; errors: string[] }[] }
  evidence.projectNative = {
    structure: info.structure,
    toolchain: info.toolchain,
    manifest: { repoExists: info.manifest.repoExists, treziExists: info.manifest.treziExists },
    containers: graph.containers.map((c) => ({
      path: c.path,
      errors: c.errors,
      targets: c.targets.map((t) => ({ name: t.name, kind: t.kind, dependencies: t.dependencies }))
    }))
  }

  // A compile error in the library module: located in StudioKit, the last good build stays.
  write('value == 1 ?', 'valeu == 1 ?')
  evidence.failed = await waitFor(
    async () => {
      const s = await state()
      return s?.status === 'failed' && s.problems.length > 0 && s
    },
    'library compile error shown',
    120_000
  )
  const failed = evidence.failed as {
    problems: string[]
    stale: boolean
    message: string
    failures: number
  }
  assert.match(failed.problems[0], /^\[StudioKit\] StudioKit\/StudioFormat\.swift:6:\d+: .*valeu/)
  assert.match(failed.message, /Build failed in StudioKit/)
  assert.equal(failed.stale, true)
  assert.ok(failed.failures >= 1, 'the failure reached the page console')
  assert.ok((await describe('project-header')).includes('Launch plan'), 'the old host answers')
  await capture('library-error')

  // The fix recovers.
  write('valeu == 1 ?', 'value == 1 ?')
  evidence.recovered = await shown('project-header', 2)
  assert.equal((evidence.recovered as { status: string }).status, 'ready')
  await capture('recovered')
  evidence.provenance = {
    syntheticDirectWrites: [`${FORMAT}: value → valeu (error), then back (fix)`],
    fixtures: [
      'Edits are direct writes to the opened copy, not chat turns (the chat landing path is covered by the LKM-271 swift-preview check).',
      'The page panel is opened through the DOM; no OS input.'
    ]
  }
  writeFileSync(join(artifacts, 'swift-graph.json'), JSON.stringify(evidence, null, 2))
  await restoreSwiftGraph(host, firstProject)
  assert.ok(
    !nativeWorkspace.state.projects.some((p) => p.root === project),
    'the Xcode project is closed'
  )
  console.log(
    'Native Swift target graph: library modules build, render, fail in place and recover.'
  )
}

/** Back to the first fixture project and its page, with the Xcode project closed. */
export async function restoreSwiftGraph(host: NativeBridge, firstProject: string) {
  const studio = nativeWorkspace.state.projects.find((p) => p.root.endsWith(FOLDER))
  if (firstProject && nativeWorkspace.active?.key !== firstProject) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${firstProject}` })
    await waitFor(() => nativeWorkspace.active?.key === firstProject, 'first project selected')
  }
  if (studio) await nativeWorkspace.command({ type: 'close', key: studio.key })
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

import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const SEARCH = 'Sources/DemoComponents/SearchPanelController.swift'

/**
 * LKM-271: a native Swift project in Trezi. Opens a copy of
 * `test/fixtures/swift-components`, waits for the preview driver's first build, then
 * captures the SwiftUI and AppKit previews, clicks and types into them through the
 * page, rebuilds after a source edit in the live tree (where a chat turn lands), shows
 * a compile error with the last good build kept, and recovers after the fix.
 */
export async function checkSwiftPreview(
  host: NativeBridge,
  fixture: string,
  root: string,
  artifacts: string,
  firstProject: string
) {
  const project = join(fixture, '../Swift Components')
  rmSync(project, { recursive: true, force: true })
  cpSync(join(root, 'test/fixtures/swift-components'), project, { recursive: true })
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const state = () =>
    page(`(() => {
      const api = window.__treziSwiftPreview, body = document.body
      if (!api || !api.state) return null
      const img = document.getElementById('frame')
      return { status: api.state.status, generation: api.state.generation, stale: api.state.stale,
        preview: api.preview, previews: api.state.previews.map((p) => p.id), shown: body.dataset.shown || '',
        message: api.state.message, failures: api.failures, width: img.width, height: img.height,
        loaded: img.complete && img.naturalWidth > 0,
        problems: [...document.querySelectorAll('#problem-list li')].map((li) => li.textContent) }
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
      join(artifacts, `swift-preview-${name}.png`),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  }
  // DOM input on the frame: the same path a click or key in the preview takes.
  const pointer = (x: number, y: number) =>
    page(`(() => {
      const stage = document.getElementById('stage'), box = document.getElementById('frame').getBoundingClientRect()
      const at = { clientX: box.left + ${x}, clientY: box.top + ${y}, bubbles: true, button: 0, detail: 1 }
      stage.dispatchEvent(new MouseEvent('mousedown', at))
      window.dispatchEvent(new MouseEvent('mouseup', at))
      return true
    })()`)
  const keys = (text: string[]) =>
    page(`(() => {
      const stage = document.getElementById('stage')
      for (const key of ${JSON.stringify(text)}) {
        stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        stage.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
      }
      return true
    })()`)
  const evidence: Record<string, unknown> = {}

  await nativeWorkspace.command({ type: 'open', root: project })
  const swiftKey = nativeWorkspace.active?.key ?? ''
  assert.notEqual(swiftKey, firstProject, 'the Swift project is open')
  await waitFor(() => nativeWorkspace.state.status.kind === 'running', 'driver running', 60_000)
  // A cold Clang module cache makes the first build slow.
  evidence.firstBuild = await waitFor(
    async () => {
      const s = await state()
      if (s?.status === 'error') throw new Error(`Swift preview build: ${s.message}`)
      return s?.status === 'ready' && s
    },
    'first Swift preview build',
    180_000
  )

  // Real rendering of SwiftUI and AppKit, in Trezi's preview.
  evidence.swiftui = await select('profile-card', 1)
  await capture('swiftui')
  evidence.appkit = await select('rating-control', 1)
  assert.deepEqual(await describe('rating-control'), ['Rating', '3 of 5 stars'])
  await capture('appkit')

  // Interaction: a click and a key on the AppKit control, then the mixed panel's field.
  await pointer(180, 16)
  await waitFor(
    async () => (await describe('rating-control')).includes('5 of 5 stars'),
    'rating click'
  )
  await keys(['ArrowLeft'])
  await waitFor(
    async () => (await describe('rating-control')).includes('4 of 5 stars'),
    'rating key'
  )
  await select('search-panel', 1)
  await pointer(100, 62)
  await keys(['s', 'l', 'Enter'])
  await waitFor(
    async () => (await describe('search-panel')).includes('Results for sl: Slider'),
    'search typed'
  )
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  evidence.interaction = await describe('search-panel')
  await capture('interaction')

  // A source edit in the live tree rebuilds; the new host shows it.
  const source = join(project, SEARCH)
  const original = readFileSync(source, 'utf8')
  writeFileSync(source, original.replace('"Search components"', '"Find components"'))
  await shown('search-panel', 2)
  assert.ok((await describe('search-panel')).includes('Find components'), 'the edit is on screen')
  evidence.edited = await state()
  await capture('edited')

  // A compile error shows in the page next to the last good build.
  writeFileSync(
    source,
    readFileSync(source, 'utf8').replace('index.search(query)', 'index.serch(query)')
  )
  evidence.failed = await waitFor(
    async () => {
      const s = await state()
      return s?.status === 'failed' && s.problems.length > 0 && s
    },
    'compile error shown',
    60_000
  )
  const failed = evidence.failed as { problems: string[]; stale: boolean; failures: number }
  assert.match(failed.problems[0], /SearchPanelController\.swift:59:\d+: .*serch/)
  assert.equal(failed.stale, true)
  assert.ok(failed.failures >= 1, 'the failure reached the page console')
  await capture('error')

  // The fix recovers.
  writeFileSync(
    source,
    readFileSync(source, 'utf8').replace('index.serch(query)', 'index.search(query)')
  )
  evidence.recovered = await shown('search-panel', 3)
  assert.equal((evidence.recovered as { status: string }).status, 'ready')
  await capture('recovered')
  writeFileSync(join(artifacts, 'swift-preview.json'), JSON.stringify(evidence, null, 2))
  // The runner calls `cleanup` only after a failure; a pass restores here.
  await restoreSwiftPreview(host, firstProject)
  assert.ok(
    !nativeWorkspace.state.projects.some((p) => p.root === project),
    'the Swift project is closed'
  )
  console.log('Native Swift previews: SwiftUI and AppKit render, take input, rebuild and recover.')
}

/** Back to the first fixture project and its page, with the Swift project closed. */
export async function restoreSwiftPreview(host: NativeBridge, firstProject: string) {
  const swift = nativeWorkspace.state.projects.find((p) => p.root.endsWith('/Swift Components'))
  if (firstProject && nativeWorkspace.active?.key !== firstProject) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${firstProject}` })
    await waitFor(() => nativeWorkspace.active?.key === firstProject, 'first project selected')
  }
  if (swift) await nativeWorkspace.command({ type: 'close', key: swift.key })
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

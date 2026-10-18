import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeProjectInfo } from '../shared/api'
import type { NativeBridge } from './bridge'
import { initRepo } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const FOLDER = '/Swift Notes'
const PREVIEW = 'preview:NotesKit/TagCounter.swift#1'
const PRIVATE = 'preview:Notes/Sidebar.swift#1'
const COMPONENT = 'component:NotesKit.TagCounter'
const CONTROLLER = 'component:Notes.SummaryViewController'

/**
 * LKM-276: a native project with intact `#Preview` blocks and no manifest. Opens a
 * committed copy of `test/fixtures/swift-preview-macros` (an app and a framework target),
 * which Trezi previews without asking (one previewable target), from declarations it
 * generates into its own folder. Renders a chosen `#Preview` (`@Previewable` state), one
 * that uses private same-file declarations (an isolated overlay), a component with an
 * inferred sample and an AppKit view controller; the page lists `#Preview` blocks and
 * components apart and names each unsupported entry with its reason. The project's
 * content hash and Git tree are unchanged afterwards.
 */
export async function checkSwiftMacros(
  host: NativeBridge,
  invoke: (channel: string, ...args: any[]) => Promise<any>,
  fixture: string,
  root: string,
  artifacts: string,
  firstProject: string
) {
  const project = join(fixture, `..${FOLDER}`)
  rmSync(project, { recursive: true, force: true })
  cpSync(join(root, 'test/fixtures/swift-preview-macros'), project, { recursive: true })
  initRepo(project)
  const gitStatus = () =>
    spawnSync('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], {
      cwd: project,
      encoding: 'utf8'
    })
      .stdout.split('\n')
      .filter((line) => line.trim() && !/^.. \.trezi\//.test(line))
      .join('\n')
  assert.equal(gitStatus(), '', 'the copy starts committed')
  const initialHash = contentHash(project)
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const state = () =>
    page(`(() => {
      const api = window.__treziSwiftPreview
      if (!api || !api.state) return null
      const img = document.getElementById('frame'), s = api.state
      return { status: s.status, generation: s.generation, message: s.message,
        shown: document.body.dataset.shown || '', loaded: img.complete && img.naturalWidth > 0,
        previews: s.previews.map((p) => p.id), manifest: s.manifest, catalog: s.catalog,
        toolchain: s.toolchain && { dir: s.toolchain.toolchain && s.toolchain.toolchain.developerDir,
          preview: s.toolchain.capability && s.toolchain.capability.status } }
    })()`)
  const describe = (id: string) =>
    page(
      `fetch('/describe?preview=' + encodeURIComponent(${JSON.stringify(id)})).then((r) => r.json()).then((r) => r.texts)`
    ) as Promise<string[]>
  // `describe` reads AppKit text and accessibility values only; a SwiftUI `Text` is not
  // in an offscreen window's tree. SwiftUI frames are compared by their PNG instead:
  // its IHDR size and an FNV-1a digest of the bytes.
  const frame = (id: string) =>
    page(`fetch('/frame?preview=' + encodeURIComponent(${JSON.stringify(id)})).then((r) => r.arrayBuffer()).then((b) => {
      const bytes = new Uint8Array(b), view = new DataView(b)
      let hash = 0x811c9dc5
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
      return { width: view.getUint32(16), height: view.getUint32(20), bytes: bytes.length, digest: hash.toString(16) }
    })`) as Promise<{ width: number; height: number; bytes: number; digest: string }>
  const select = async (id: string, generation: number) => {
    await page(`window.__treziSwiftPreview.select(${JSON.stringify(id)})`)
    return waitFor(
      async () => {
        const s = await state()
        return s?.shown === `${id}@${generation}` && s.loaded && { shown: s.shown }
      },
      `${id} frame of build ${generation}`,
      20_000
    )
  }
  const capture = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeFileSync(
      join(artifacts, `swift-macros-${name}.png`),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  }
  const evidence: Record<string, unknown> = {}

  await nativeWorkspace.command({ type: 'open', root: project })
  assert.notEqual(nativeWorkspace.active?.key ?? '', firstProject, 'the Xcode project is open')
  await waitFor(() => nativeWorkspace.state.status.kind === 'running', 'driver running', 60_000)
  const first = await waitFor(
    async () => {
      const s = await state()
      if (s?.status === 'error' || s?.status === 'failed' || s?.status === 'setup')
        throw new Error(`generated build: ${s.status}: ${s.message}`)
      return s?.status === 'ready' && s
    },
    'the generated build',
    300_000
  )
  evidence.firstBuild = { ...first, catalog: undefined }
  assert.equal(first.manifest.source, 'none', 'no manifest anywhere')
  const catalog = first.catalog
  evidence.catalog = catalog
  assert.deepEqual(
    [catalog.target, catalog.project, catalog.chosenBy],
    ['Notes', 'Notes.xcodeproj', 'the only previewable target'],
    'no target question: one previewable target'
  )
  assert.match(catalog.dir, /swift-previews\/[0-9a-f]{16}\/generated$/)
  assert.ok(!catalog.dir.startsWith(project), 'generated outside the project')
  for (const id of [PREVIEW, PRIVATE, COMPONENT, CONTROLLER])
    assert.ok(first.previews.includes(id), `${id} is built (${first.previews})`)
  const reasons = Object.fromEntries(
    catalog.entries.filter((e: any) => !e.supported).map((e: any) => [e.title, e.reason])
  )
  for (const [title, reason] of [
    ['Shared store', /preview modifier trait/],
    ['App window', /app entry file/],
    ['Tagged', /generic/],
    ['NibController', /nib or storyboard/],
    ['iOS only', /compiled out for the preview host \(only where #if \(os\(iOS\)\)\)/]
  ] as const)
    assert.match(reasons[title] ?? '', reason, `${title} is listed with its reason`)

  // A chosen #Preview with @Previewable state, then one built from an isolated overlay.
  const frames: Record<string, Awaited<ReturnType<typeof frame>>> = {}
  evidence.frames = frames
  evidence.preview = await select(PREVIEW, first.generation)
  frames[PREVIEW] = await frame(PREVIEW)
  await capture('preview')
  evidence.overlay = await select(PRIVATE, first.generation)
  frames[PRIVATE] = await frame(PRIVATE)
  // A chosen component with its inferred sample, and an AppKit view controller.
  evidence.component = await select(COMPONENT, first.generation)
  frames[COMPONENT] = await frame(COMPONENT)
  assert.equal(
    catalog.entries.find((e: any) => e.id === COMPONENT)?.sample,
    'TagCounter(count: .constant(1), label: "Label")'
  )
  await capture('component')
  evidence.controller = await select(CONTROLLER, first.generation)
  assert.ok((await describe(CONTROLLER)).includes('3 notes'))
  for (const [id, f] of Object.entries(frames))
    assert.ok(
      f.width > 40 && f.height > 20 && f.bytes > 1_000,
      `${id} drew a frame: ${JSON.stringify(f)}`
    )
  // The same view with "Tags: 3" (@Previewable state) and with "Label: 1" (the sample).
  assert.notEqual(frames[PREVIEW].digest, frames[COMPONENT].digest, 'two different TagCounters')
  assert.notEqual(frames[PRIVATE].digest, frames[PREVIEW].digest)

  // The page groups the picker and lists what it cannot show, and why.
  await page(`document.getElementById('unsupported').open = true`)
  evidence.page = await waitFor(
    () =>
      page(`(() => {
        const groups = [...document.querySelectorAll('#picker .group')].map((g) => g.textContent)
        const items = [...document.querySelectorAll('#unsupported-list li')].map((li) => li.innerText)
        const targets = document.getElementById('targets').innerText
        return groups.join() === '#Preview,Components' && items.length >= 5 &&
          /Previewing Notes \\(the only previewable target\\)/.test(targets) && { groups, items, targets }
      })()`),
    'the catalog on the preview page'
  )
  await capture('catalog')
  await page(`document.getElementById('unsupported').open = false`)
  const info = (await invoke('project:native', project)) as NativeProjectInfo
  assert.equal(info.error, '')
  assert.equal(info.catalog?.target, 'Notes', 'project:native reports the catalog')

  // No file of the project changed: same content hash, and Git sees nothing.
  const finalHash = contentHash(project)
  evidence.hash = { before: initialHash, after: finalHash }
  assert.equal(finalHash, initialHash, 'the fixture copy is byte-identical')
  assert.equal(gitStatus(), '', 'the project tree is unchanged (ignored files included)')
  evidence.provenance = {
    fixtures: [
      'A committed copy of test/fixtures/swift-preview-macros; nothing in it is edited.',
      'Previews are chosen through the page API and the panel is opened through the DOM; no OS input.'
    ]
  }
  writeFileSync(join(artifacts, 'swift-macros.json'), JSON.stringify(evidence, null, 2))
  await restoreSwiftMacros(host, firstProject)
  console.log(
    'Native Swift previews without a manifest: a chosen #Preview and a chosen component render from generated declarations; the project is unchanged.'
  )
}

/** SHA-256 over every file's path and bytes, Git's folder and Trezi's `.trezi/` left out. */
function contentHash(dir: string): string {
  const hash = createHash('sha256')
  const visit = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      if (!prefix && (name === '.git' || name === '.trezi')) continue
      const child = join(path, name)
      if (lstatSync(child).isDirectory()) visit(child, `${prefix}${name}/`)
      else hash.update(`${prefix}${name}\0`).update(readFileSync(child))
    }
  }
  visit(dir, '')
  return hash.digest('hex')
}

/** Back to the first fixture project and its page, with the Xcode project closed. */
export async function restoreSwiftMacros(host: NativeBridge, firstProject: string) {
  const notes = nativeWorkspace.state.projects.find((p) => p.root.endsWith(FOLDER))
  if (firstProject && nativeWorkspace.active?.key !== firstProject) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${firstProject}` })
    await waitFor(() => nativeWorkspace.active?.key === firstProject, 'first project selected')
  }
  if (notes) await nativeWorkspace.command({ type: 'close', key: notes.key })
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

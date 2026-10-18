import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { appVersion, buildStamp } from './app-version'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

/**
 * LKM-277: shared pieces of the Scraib acceptance checks (`smoke-scraib-xcode.ts`,
 * `smoke-scraib-open.ts`): a read-only digest of an original, the disposable copy, the
 * machine's `xcode-select` and Trezi's own build, and the preview page's state.
 */

/**
 * A read-only digest of `dir`: SHA-256 over every entry's path and bytes (link targets for
 * links), and over every entry's kind, size and mtime (folders too). Folders named in
 * `statOnly` (build output) get the second only, folders named in `leaveOut` neither.
 * Nothing is written and no Git command runs.
 */
export function digestTree(
  dir: string,
  statOnly: readonly string[] = [],
  leaveOut: readonly string[] = []
) {
  const content = createHash('sha256')
  const stats = createHash('sha256')
  let files = 0
  let entries = 0
  const visit = (path: string, prefix: string, read: boolean) => {
    for (const name of readdirSync(path).sort()) {
      if (leaveOut.includes(name)) continue
      const child = join(path, name)
      const rel = `${prefix}${name}`
      const stat = lstatSync(child)
      const kind = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file'
      entries++
      stats.update(`${rel}\0${kind}\0${kind === 'file' ? stat.size : 0}\0${stat.mtimeMs}\n`)
      if (kind === 'dir') visit(child, `${rel}/`, read && !statOnly.includes(name))
      else if (read) {
        files++
        content.update(`${rel}\0`)
        content.update(kind === 'link' ? readlinkSync(child) : readFileSync(child))
      }
    }
  }
  visit(dir, '', true)
  return {
    path: dir,
    files,
    entries,
    contentSha256: content.digest('hex'),
    statSha256: stats.digest('hex'),
    statOnly: [...statOnly],
    leaveOut: [...leaveOut]
  }
}

/** Copy an original's working tree, leaving out the named top-level or nested folders. */
export function copyOriginal(from: string, to: string, leaveOut: readonly string[]) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !leaveOut.includes(basename(source))
  })
}

/** HEAD of a repository through `rev-parse` only (no index refresh, nothing written). */
export const headOf = (dir: string) =>
  spawnSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8'
  }).stdout.trim()

/** The machine's developer directory as `xcode-select -p` reports it, with no `DEVELOPER_DIR`. */
export function xcodeSelect(): string {
  const env = { ...process.env }
  delete env.DEVELOPER_DIR
  const run = spawnSync('xcode-select', ['-p'], { env, encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : `failed: ${run.stderr.trim()}`
}

/** Trezi's own build: the stamped version and the checkout it was built from. */
export function treziBuild(root: string) {
  const git = (...args: string[]) =>
    spawnSync('git', ['--no-optional-locks', ...args], {
      cwd: root,
      encoding: 'utf8'
    }).stdout.trim()
  return {
    app: appVersion(),
    stamp: buildStamp(),
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    uncommittedFiles: git('status', '--porcelain').split('\n').filter(Boolean).length
  }
}

/** The selected toolchain from the page state, reduced to what the evidence records. */
// biome-ignore lint/suspicious/noExplicitAny: page state is untyped JSON
export function toolchainEvidence(selection: any) {
  const t = selection?.toolchain
  return {
    developerDir: t?.developerDir ?? '',
    label: t?.label ?? '',
    xcodeVersion: t?.xcodeVersion ?? '',
    xcodeBuild: t?.xcodeBuild ?? '',
    swiftVersion: t?.swiftVersion ?? '',
    sdkVersion: t?.sdkVersion ?? '',
    previewsMacros: t?.previewsMacros ?? '',
    reason: selection?.reason ?? '',
    preview: selection?.capability?.status ?? '',
    systemDefault: selection?.systemDefault ?? ''
  }
}

export interface FrameInfo {
  /** PNG size (2x the component's points). */
  width: number
  height: number
  bytes: number
  digest: string
  /** Strongly red pixels (r > 170, g and b < 110), counted on a canvas. */
  red: number
}

/** The Swift preview page in Trezi's WebKit view, read and driven through its own DOM. */
export function previewPage(host: NativeBridge, artifacts: string, prefix: string) {
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const state = () =>
    page(`(() => {
      const api = window.__treziSwiftPreview
      if (!api || !api.state) return null
      const img = document.getElementById('frame'), s = api.state
      return { status: s.status, generation: s.generation, builds: s.builds, stale: s.stale,
        message: s.message, durationMs: s.durationMs, shown: document.body.dataset.shown || '',
        loaded: img.complete && img.naturalWidth > 0, previews: s.previews.map((p) => p.id),
        manifest: s.manifest, catalog: s.catalog, toolchain: s.toolchain, build: s.build,
        plan: s.plan && { modules: s.plan.modules.map((m) => ({ module: m.module, entries: m.entries,
          sources: (m.sources || []).length })), blockers: s.plan.blockers, warnings: s.plan.warnings,
          dependencies: s.plan.dependencies, resources: s.plan.resources },
        diagnostics: s.diagnostics.filter((d) => d.severity === 'error').slice(0, 12),
        problems: [...document.querySelectorAll('#problem-list li')].map((li) => li.textContent) }
    })()`)
  const frame = (id: string): Promise<FrameInfo> =>
    page(`fetch('/frame?preview=' + encodeURIComponent(${JSON.stringify(id)}) + '&t=' + Date.now())
      .then((r) => r.blob()).then(async (blob) => {
        const buffer = await blob.arrayBuffer(), bytes = new Uint8Array(buffer), view = new DataView(buffer)
        let hash = 0x811c9dc5
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
        const image = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        const data = context.getImageData(0, 0, image.width, image.height).data
        let red = 0
        for (let i = 0; i < data.length; i += 4)
          if (data[i + 3] > 200 && data[i] > 170 && data[i + 1] < 110 && data[i + 2] < 110) red++
        return { width: view.getUint32(16), height: view.getUint32(20), bytes: bytes.length,
          digest: hash.toString(16), red }
      })`)
  /** Click the entry's button in the page's picker, then wait for its frame of `generation`. */
  const pick = async (id: string, generation: number) => {
    const clicked = await page(`(() => {
      const button = [...document.querySelectorAll('#picker button')].find((b) => b.dataset.preview === ${JSON.stringify(id)})
      if (!button) return false
      button.click()
      return true
    })()`)
    if (!clicked) throw new Error(`${id} has no button in the preview picker`)
    return shown(id, generation)
  }
  const shown = (id: string, generation: number) =>
    waitFor(
      async () => {
        const s = await state()
        return s?.shown === `${id}@${generation}` && s.loaded && s
      },
      `${id} frame of build ${generation}`,
      30_000
    )
  /** A click on the shown frame through the page's own mouse handlers (DOM events, no OS input). */
  const click = (x: number, y: number) =>
    page(`(() => {
      const stage = document.getElementById('stage'), box = document.getElementById('frame').getBoundingClientRect()
      const x = ${x} < 0 ? box.width + ${x} : ${x}, y = ${y} < 0 ? box.height / 2 : ${y}
      const at = { clientX: box.left + x, clientY: box.top + y, bubbles: true, button: 0, detail: 1 }
      stage.dispatchEvent(new MouseEvent('mousedown', at))
      window.dispatchEvent(new MouseEvent('mouseup', at))
      return { x, y, width: box.width, height: box.height }
    })()`)
  const capture = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const file = `${prefix}-${name}.png`
    writeFileSync(join(artifacts, file), Buffer.from(await host.request('captureShell'), 'base64'))
    return file
  }
  return { page, state, frame, pick, shown, click, capture }
}

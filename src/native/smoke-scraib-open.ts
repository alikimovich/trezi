import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeProjectInfo } from '../shared/api'
import type { NativeBridge } from './bridge'
import { hasScraibOpen, SCRAIB_OPEN } from './scraib-originals'
import {
  copyOriginal,
  digestTree,
  headOf,
  previewPage,
  toolchainEvidence,
  treziBuild,
  xcodeSelect
} from './smoke-scraib'
import { settled } from './smoke-scraib-xcode'
import { initRepo } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const FOLDER = '/Scraib Open Copy'
/** Not app sources: Git, agent config and build output (2 GB of `build/`, `.build/`). */
const LEFT_OUT = ['.git', '.claude', 'build', '.build', '.swiftpm', 'DerivedData']
/** Build output in the original: its stats are compared, its bytes are not read. */
const STAT_ONLY = ['build', '.build', 'DerivedData']
const BUILD_MS = 300_000

/**
 * LKM-277 (Stage 6): Scraib-open, whose app target depends on the local ScraibKit package
 * and the remote Sparkle and posthog-ios packages. Opens a disposable copy of the working
 * tree (build output left out), lets Trezi pick the target and build its dependencies, and
 * previews a view that uses ScraibKit when the build succeeds. When it does not, the
 * check records every blocker the page names (unsupported dependencies, plan blockers,
 * build errors, entries Trezi does not show and why) instead of failing: Stage 6 claims
 * a precise reason, not universal support. The original's digest and `xcode-select -p`
 * are compared before and after. Does nothing where the original is not on the machine.
 */
export async function checkScraibOpen(
  host: NativeBridge,
  invoke: (channel: string, ...args: any[]) => Promise<any>,
  fixture: string,
  root: string,
  artifacts: string
) {
  const evidencePath = join(artifacts, 'scraib-open.json')
  if (!hasScraibOpen()) {
    writeFileSync(evidencePath, JSON.stringify({ ran: false, original: SCRAIB_OPEN }, null, 2))
    console.log(`Scraib-open acceptance NOT RUN: ${SCRAIB_OPEN} is not on this machine.`)
    return
  }
  const evidence: Record<string, any> = { ran: true, trezi: treziBuild(root) }
  const xcodeSelectBefore = xcodeSelect()
  const originalBefore = digestTree(SCRAIB_OPEN, STAT_ONLY)
  evidence.original = { path: SCRAIB_OPEN, commit: headOf(SCRAIB_OPEN), before: originalBefore }
  const project = join(fixture, `..${FOLDER}`)
  const ui = previewPage(host, artifacts, 'scraib-open')
  const captures: string[] = []
  evidence.captures = captures
  try {
    rmSync(project, { recursive: true, force: true })
    copyOriginal(SCRAIB_OPEN, project, LEFT_OUT)
    const copied = digestTree(project)
    const source = digestTree(SCRAIB_OPEN, [], LEFT_OUT)
    assert.equal(copied.contentSha256, source.contentSha256, 'the copy is byte-identical')
    evidence.copy = {
      path: project,
      leftOut: LEFT_OUT,
      contentSha256: copied.contentSha256,
      files: copied.files
    }
    initRepo(project)
    const copyBefore = digestTree(project, [], ['.git', '.trezi'])

    await nativeWorkspace.command({ type: 'open', root: project })
    await waitFor(
      () => nativeWorkspace.active?.root === project,
      'the Scraib-open copy is open',
      30_000
    )
    await waitFor(() => nativeWorkspace.state.status.kind === 'running', 'driver running', 60_000)
    const started = Date.now()
    let state = await settled(ui, 0, 'the Scraib-open build', false, BUILD_MS).catch(() => null)
    if (!state) {
      // Still building at the end of the budget: say so, with what the page shows.
      state = await ui.state()
      evidence.timedOut = `the build had not finished after ${BUILD_MS / 1000} s`
    }
    evidence.durationMs = Date.now() - started
    evidence.toolchain = toolchainEvidence(state?.toolchain)
    assert.equal(evidence.toolchain.systemDefault || xcodeSelectBefore, xcodeSelectBefore)
    evidence.state = {
      status: state?.status,
      message: state?.message,
      generation: state?.generation,
      manifest: state?.manifest?.source,
      previews: state?.previews,
      plan: state?.plan,
      build: state?.build,
      diagnostics: state?.diagnostics,
      problems: state?.problems
    }
    const catalog = state?.catalog
    evidence.catalog = catalog && {
      target: catalog.target,
      chosenBy: catalog.chosenBy,
      entries: catalog.entries.map((e: any) => ({
        id: e.id,
        file: e.file,
        supported: e.supported,
        reason: e.reason,
        sample: e.sample
      }))
    }

    if (state?.status === 'ready') {
      // A view from a file that imports ScraibKit, compiled and linked against the package
      // build; the largest of them, so the capture shows something.
      const built: string[] = state.previews
      const viaKit = built.filter((id) => {
        const file = catalog?.entries.find((e: any) => e.id === id)?.file
        return !!file && /^import ScraibKit\b/m.test(readFileSync(join(project, file), 'utf8'))
      })
      assert.ok(built.length, 'a ready Scraib-open build has at least one preview')
      evidence.frames = {}
      for (const id of viaKit.length ? viaKit : built) {
        await ui.pick(id, state.generation)
        evidence.frames[id] = await ui.frame(id)
      }
      const area = (id: string) => evidence.frames[id].width * evidence.frames[id].height
      const pick = Object.keys(evidence.frames).sort((a, b) => area(b) - area(a))[0]
      evidence.preview = { id: pick, importsScraibKit: viaKit.includes(pick) }
      await ui.pick(pick, state.generation)
      evidence.frame = evidence.frames[pick]
      assert.ok(evidence.frame.width > 0 && evidence.frame.height > 0, `${pick} drew a frame`)
      captures.push(await ui.capture('component'))
    } else {
      // Not rendered: every reason Trezi gives must be on record, and there must be one.
      const blockers = [
        evidence.timedOut,
        state?.status !== 'building' && state?.message,
        ...(state?.plan?.blockers ?? []),
        ...(state?.plan?.dependencies?.unsupported ?? []).map(
          (d: any) => `${d.name ?? d.location ?? ''}: ${d.reason ?? ''}`
        ),
        ...(state?.problems ?? [])
      ].filter(Boolean)
      evidence.blockers = blockers
      assert.ok(blockers.length > 0, 'Scraib-open did not render and the page names why')
      captures.push(await ui.capture('blocked'))
    }
    await ui.page(`document.getElementById('unsupported').open = true`)
    evidence.notShown = await ui.page(
      `[...document.querySelectorAll('#unsupported-list li')].map((li) => li.innerText)`
    )
    captures.push(await ui.capture('catalog'))
    await ui.page(`document.getElementById('unsupported').open = false`)
    const info = (await invoke('project:native', project)) as NativeProjectInfo
    evidence.projectNative = { error: info.error, target: info.catalog?.target ?? '' }

    // Builds run in Trezi's cache and a shadow of each package: the copy is untouched.
    const copyAfter = digestTree(project, [], ['.git', '.trezi'])
    evidence.copy.unchanged =
      copyAfter.contentSha256 === copyBefore.contentSha256 &&
      copyAfter.statSha256 === copyBefore.statSha256
    assert.ok(evidence.copy.unchanged, 'nothing was written into the copy')
  } finally {
    const originalAfter = digestTree(SCRAIB_OPEN, STAT_ONLY)
    evidence.original.after = originalAfter
    evidence.original.unchanged =
      originalAfter.contentSha256 === originalBefore.contentSha256 &&
      originalAfter.statSha256 === originalBefore.statSha256
    evidence.xcodeSelect = { before: xcodeSelectBefore, after: xcodeSelect() }
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
  }
  assert.ok(evidence.original.unchanged, 'the Scraib-open original is unchanged')
  assert.equal(evidence.xcodeSelect.after, xcodeSelectBefore, 'xcode-select is unchanged')
  console.log(
    evidence.preview
      ? `Scraib-open acceptance: ${evidence.preview.id} rendered; original and xcode-select unchanged.`
      : `Scraib-open acceptance: not rendered, blockers recorded (${evidence.blockers.length}); original and xcode-select unchanged.`
  )
}

/** Back to the first fixture project, with the Scraib-open copy closed. */
export async function restoreScraibOpen(host: NativeBridge, firstProject: string) {
  const copy = nativeWorkspace.state.projects.find((p) => p.root.endsWith(FOLDER))
  if (firstProject && nativeWorkspace.active?.key !== firstProject) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${firstProject}` })
    await waitFor(() => nativeWorkspace.active?.key === firstProject, 'first project selected')
  }
  if (copy) await nativeWorkspace.command({ type: 'close', key: copy.key })
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

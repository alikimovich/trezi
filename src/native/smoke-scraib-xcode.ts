import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeProjectInfo } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { hasScraibXcode, SCRAIB_XCODE } from './scraib-originals'
import {
  copyOriginal,
  digestTree,
  headOf,
  previewPage,
  toolchainEvidence,
  treziBuild,
  xcodeSelect
} from './smoke-scraib'
import { type ChatTurn, initRepo, SwiftChatTurns } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const FOLDER = '/Scraib Xcode Copy'
const FILE = 'scraib/FloatingLoaderManager.swift'
const PREVIEW = 'preview:scraib/FloatingLoaderManager.swift#1'
const COMPONENT = 'component:scraib.FloatingLoaderView'
const RECORDER = 'component:scraib.ShortcutRecorderView'
/** Not app sources: Git (the copy gets a fresh repository for chat worktrees) and agent config. */
const LEFT_OUT = ['.git', '.claude']
/** The `#Preview`'s own call (`.loading("Rewriting...")` alone is first the manager's state). */
const EDIT = [
  'FloatingLoaderView(state: .loading("Rewriting..."), operationType',
  'FloatingLoaderView(state: .loading("Rewriting your selection..."), operationType'
] as const
const BREAK = ['width: widthForState(), height: 40', 'width: widthForStates(), height: 40'] as const
/** The provider stub of the run in flight; `restoreScraibXcode` always lifts it. */
let turns: SwiftChatTurns | undefined

/**
 * LKM-277 (Stage 6): Scraib-xcode's full `scraib` target in Trezi, unchanged. Hashes the
 * original (read only), opens a disposable copy of its working tree with all seven
 * `#Preview` blocks intact and no manifest, and previews `FloatingLoaderView`'s `#Preview`
 * from the picker. Then: interaction on Scraib's `ShortcutRecorderView` (a click starts
 * and stops recording), and three fixture-provider chat turns through the real pipeline
 * that edit the `#Preview` (rebuild), break `FloatingLoaderView` (error with the last good
 * build kept) and fix it (recovery). The original's digest and `xcode-select -p` are
 * compared before and after. Does nothing where the original is not on the machine.
 */
export async function checkScraibXcode(
  host: NativeBridge,
  invoke: (channel: string, ...args: any[]) => Promise<any>,
  fixture: string,
  root: string,
  artifacts: string,
  firstProject: string
) {
  const evidencePath = join(artifacts, 'scraib-xcode.json')
  if (!hasScraibXcode()) {
    writeFileSync(evidencePath, JSON.stringify({ ran: false, original: SCRAIB_XCODE }, null, 2))
    console.log(`Scraib-xcode acceptance NOT RUN: ${SCRAIB_XCODE} is not on this machine.`)
    return
  }
  const evidence: Record<string, any> = { ran: true, trezi: treziBuild(root) }
  const soft: string[] = []
  const xcodeSelectBefore = xcodeSelect()
  const originalBefore = digestTree(SCRAIB_XCODE)
  evidence.original = {
    path: SCRAIB_XCODE,
    commit: headOf(SCRAIB_XCODE),
    status: spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd: SCRAIB_XCODE,
      encoding: 'utf8'
    }).stdout.trim(),
    before: originalBefore
  }
  const project = join(fixture, `..${FOLDER}`)
  const ui = previewPage(host, artifacts, 'scraib-xcode')
  const captures: string[] = []
  evidence.captures = captures
  try {
    rmSync(project, { recursive: true, force: true })
    copyOriginal(SCRAIB_XCODE, project, LEFT_OUT)
    // Unchanged sources: the copy's bytes equal the original's, minus the left-out folders.
    const copied = digestTree(project)
    const source = digestTree(SCRAIB_XCODE, [], LEFT_OUT)
    assert.equal(copied.contentSha256, source.contentSha256, 'the copy is byte-identical')
    const blocksIn = (file: string) =>
      (readFileSync(file, 'utf8').match(/^[ \t]*#Preview\b/gm) ?? []).length
    const previews = swiftFiles(join(project, 'scraib')).filter((file) => blocksIn(file) > 0)
    assert.equal(
      previews.reduce((n, file) => n + blocksIn(file), 0),
      7,
      'all seven #Preview blocks are in the copy'
    )
    evidence.copy = {
      path: project,
      leftOut: LEFT_OUT,
      contentSha256: copied.contentSha256,
      files: copied.files,
      previewFiles: previews.map((file) => file.slice(project.length + 1))
    }
    initRepo(project)
    const ignored = () => gitLines(project, 'status', '--porcelain', '--ignored')
    const ignoredBefore = ignored()

    const firstChat = nativeChat.active
    await nativeWorkspace.command({ type: 'open', root: project })
    assert.notEqual(nativeWorkspace.active?.key ?? '', firstProject, 'the Scraib copy is open')
    const chatKey = await waitFor(
      () => nativeChat.active !== firstChat && nativeChat.active,
      'the Scraib copy chat',
      30_000
    )
    turns = new SwiftChatTurns(host, chatKey, project)
    await waitFor(() => nativeWorkspace.state.status.kind === 'running', 'driver running', 60_000)
    let first = await settled(ui, 0, 'the first full-target build')
    if (first.status === 'setup' && first.catalog?.choices?.length) {
      // Several previewable targets: choose scraib on the page, as a user would.
      evidence.targetChoice = await ui.page(`(() => {
        const button = [...document.querySelectorAll('#targets button')].find((b) => b.dataset.target === 'scraib')
        if (button) button.click()
        return button ? button.textContent : ''
      })()`)
      first = await settled(ui, 0, 'the full-target build after choosing scraib', true)
    }
    evidence.firstBuild = {
      ...brief(first),
      previews: first.previews,
      plan: first.plan,
      build: first.build,
      diagnostics: first.diagnostics
    }
    assert.equal(first.status, 'ready', `full-target build: ${first.status}: ${first.message}`)
    assert.equal(first.manifest.source, 'none', 'no manifest, no harness: generated previews')
    const catalog = first.catalog
    evidence.catalog = catalog
    assert.equal(catalog.target, 'scraib', 'the full scraib target')
    const blocks = catalog.entries.filter((e: any) => e.id.startsWith('preview:'))
    evidence.previewBlocks = blocks.map((e: any) => ({
      id: e.id,
      title: e.title,
      supported: e.supported,
      built: first.previews.includes(e.id),
      reason: e.reason
    }))
    assert.equal(blocks.length, 7, 'the catalog lists all seven #Preview blocks')
    assert.ok(first.previews.includes(PREVIEW), `FloatingLoaderView's #Preview is built`)
    evidence.toolchain = toolchainEvidence(first.toolchain)
    assert.equal(evidence.toolchain.preview, 'supported', 'the selected Xcode expands #Preview')
    assert.equal(evidence.toolchain.systemDefault, xcodeSelectBefore, 'xcode-select only read')

    // FloatingLoaderView from its own #Preview, chosen in the page's picker.
    evidence.preview = brief(await ui.pick(PREVIEW, first.generation))
    const loader = await ui.frame(PREVIEW)
    evidence.frames = { [PREVIEW]: loader }
    // `.loading("Rewriting...")`: 40 + 12 × 7 = 124 points wide, 40 high (drawn at 2x).
    assert.ok(loader.width >= 220 && loader.width <= 280, `loader width ${loader.width}`)
    assert.ok(loader.height >= 60 && loader.height <= 110, `loader height ${loader.height}`)
    captures.push(await ui.capture('floating-loader'))
    // The same view as a component, with Trezi's inferred sample.
    await attempt(soft, async () => {
      assert.ok(first.previews.includes(COMPONENT), `${COMPONENT} is built`)
      await ui.pick(COMPONENT, first.generation)
      const component = await ui.frame(COMPONENT)
      evidence.frames[COMPONENT] = component
      // The inferred sample is `.error`: a red triangle and red "Error, check Scraib".
      assert.ok(component.red >= 20, `the .error sample drew ${component.red} red pixels`)
      captures.push(await ui.capture('component'))
    })
    await ui.page(`document.getElementById('unsupported').open = true`)
    evidence.page = await ui.page(`({
      groups: [...document.querySelectorAll('#picker .group')].map((g) => g.textContent),
      buttons: document.querySelectorAll('#picker button').length,
      targets: document.getElementById('targets').innerText,
      notShown: [...document.querySelectorAll('#unsupported-list li')].map((li) => li.innerText)
    })`)
    captures.push(await ui.capture('catalog'))
    await ui.page(`document.getElementById('unsupported').open = false`)
    const info = (await invoke('project:native', project)) as NativeProjectInfo
    evidence.projectNative = { error: info.error, target: info.catalog?.target ?? '' }

    // Interaction: Scraib's shortcut recorder; a click starts recording (red), a second stops.
    await attempt(soft, async () => {
      assert.ok(first.previews.includes(RECORDER), `${RECORDER} is built`)
      await ui.pick(RECORDER, first.generation)
      const idle = await ui.frame(RECORDER)
      evidence.interaction = { component: RECORDER, idle }
      captures.push(await ui.capture('interaction-idle'))
      evidence.interaction.click = await ui.click(-40, -1)
      evidence.interaction.recording = await waitFor(
        async () => {
          const f = await ui.frame(RECORDER)
          return f.red > idle.red + 30 && f
        },
        'the recorder shows "Press shortcut..." in red after a click',
        10_000
      )
      captures.push(await ui.capture('interaction'))
      await ui.click(-40, -1)
      evidence.interaction.stopped = await waitFor(
        async () => {
          const f = await ui.frame(RECORDER)
          return f.red <= idle.red + 10 && f
        },
        'a second click stops recording',
        10_000
      )
    })

    // Edits arrive as chat turns: composer -> agent:send -> the chat worktree -> landing
    // commit -> rebuild. Only the model is a fixture (the provider stub).
    await ui.pick(PREVIEW, first.generation)
    await turns.attach()
    const edit = (from: string, to: string) => (_received: string, worktree: string) => {
      const file = join(worktree, FILE)
      const text = readFileSync(file, 'utf8')
      assert.ok(text.includes(from), `the worktree copy has ${from}`)
      writeFileSync(file, text.replace(from, to))
    }
    const landed: Record<string, ChatTurn> = {}
    const landing = (turn: ChatTurn, label: string) => {
      assert.ok(turn.liveUntouchedBeforeLanding, `${label}: live tree untouched before landing`)
      assert.match(turn.branch, /^trezi\/chat-/, `${label}: edited on the chat branch`)
      assert.equal(turn.commitsAdded, 1, `${label}: one landing commit`)
      assert.deepEqual(turn.commit.files, [FILE], `${label}: the landed file`)
    }

    // 1. The #Preview's message gets longer: a rebuild, and a wider loader on screen.
    landed.edit = await turns.turn(
      'Make the floating loader preview say "Rewriting your selection...".',
      edit(...EDIT)
    )
    landing(landed.edit, 'edit')
    const edited = await settled(ui, first.generation, 'the rebuild after the chat edit')
    assert.equal(edited.status, 'ready', `rebuild: ${edited.message}`)
    evidence.edited = brief(await ui.shown(PREVIEW, edited.generation))
    const wider = await ui.frame(PREVIEW)
    evidence.frames.edited = wider
    // 40 + 27 × 7 = 229 points.
    assert.ok(wider.width >= loader.width + 160, `the edit is on screen: ${wider.width}`)
    captures.push(await ui.capture('edited'))

    // 2. A landed edit that does not compile: the error next to the last good build.
    const line =
      readFileSync(join(project, FILE), 'utf8')
        .split('\n')
        .findIndex((text) => text.includes(BREAK[0])) + 1
    assert.ok(line > 0, `${BREAK[0]} is in ${FILE}`)
    landed.error = await turns.turn('Use the new width helper in the loader.', edit(...BREAK))
    landing(landed.error, 'error')
    const failed = await waitFor(
      async () => {
        const s = await ui.state()
        return s?.status === 'failed' && s.problems.length > 0 && s
      },
      'the compile error on the page',
      240_000
    )
    evidence.failed = { ...brief(failed), loaded: failed.loaded, diagnostics: failed.diagnostics }
    assert.match(
      failed.problems.join('\n'),
      new RegExp(`FloatingLoaderManager\\.swift:${line}:\\d+: .*widthForStates`)
    )
    assert.equal(failed.stale, true, 'the last good build stays')
    assert.equal(failed.shown, `${PREVIEW}@${edited.generation}`, 'the last good frame is shown')
    assert.ok(failed.loaded, 'the last good frame is loaded')
    captures.push(await ui.capture('error'))
    const row = await waitFor(
      () =>
        nativeChat
          .get(chatKey)
          .messages.find((m) => m.landingCheck?.errors.some((e) => /widthForStates/.test(e))),
      'the landing check row with the compile error',
      180_000
    )
    evidence.landingCheck = row.landingCheck

    // 3. The fix turn runs only if the agent was told the diagnostic; the build recovers.
    landed.fix = await turns.turn('Fix the build.', (received, worktree) => {
      assert.match(received, /preview check after your last landing found a problem/)
      assert.match(received, /FloatingLoaderManager\.swift:\d+: .*widthForStates/)
      edit(BREAK[1], BREAK[0])(received, worktree)
    })
    landing(landed.fix, 'fix')
    const recovered = await settled(ui, edited.generation, 'the rebuild after the fix', true)
    evidence.recovered = brief(await ui.shown(PREVIEW, recovered.generation))
    evidence.frames.recovered = await ui.frame(PREVIEW)
    assert.equal(evidence.frames.recovered.width, wider.width, 'the edited loader is back')
    captures.push(await ui.capture('recovered'))

    // The copy holds only the landed commits: no build output, nothing else written.
    assert.deepEqual(gitLines(project, 'status', '--porcelain'), [], 'the copy is committed')
    assert.deepEqual(ignored(), ignoredBefore, 'no ignored file appeared in the copy')
    evidence.provenance = {
      chatLanded: Object.fromEntries(
        Object.entries(landed).map(([step, turn]) => [
          step,
          {
            branch: turn.branch,
            liveUntouchedBeforeLanding: turn.liveUntouchedBeforeLanding,
            commit: turn.commit,
            diagnosticInPrompt: step === 'fix' ? /widthForStates/.test(turn.received) : undefined
          }
        ])
      ),
      syntheticDirectWrites: [],
      fixtures: [
        'The model is a fixture provider (stubAgentSendForSmoke) that applies a scripted edit to the chat worktree; no provider call is made.',
        'Previews are chosen with the picker buttons and clicks are DOM events on the preview page, not OS input.'
      ]
    }
  } finally {
    const originalAfter = digestTree(SCRAIB_XCODE)
    evidence.original.after = originalAfter
    evidence.original.unchanged =
      originalAfter.contentSha256 === originalBefore.contentSha256 &&
      originalAfter.statSha256 === originalBefore.statSha256
    evidence.xcodeSelect = { before: xcodeSelectBefore, after: xcodeSelect() }
    evidence.softFailures = soft
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2))
  }
  assert.ok(evidence.original.unchanged, 'the Scraib-xcode original is unchanged')
  assert.equal(evidence.xcodeSelect.after, xcodeSelectBefore, 'xcode-select is unchanged')
  assert.deepEqual(soft, [], 'every Scraib-xcode step passed')
  await restoreScraibXcode(host, firstProject)
  console.log(
    'Scraib-xcode acceptance: FloatingLoaderView from the unchanged full target, interaction, chat edit, error and recovery; original and xcode-select unchanged.'
  )
}

/**
 * Wait until a build after `generation` finished: a newer ready build, or (when the state
 * before was ready, so a failure is new) any other outcome. After a failed build pass
 * `onlyReady`, since the old failure stays on the page until the next build ends.
 */
export function settled(
  ui: ReturnType<typeof previewPage>,
  generation: number,
  label: string,
  onlyReady = false,
  timeout = 300_000
  // biome-ignore lint/suspicious/noExplicitAny: page state is untyped JSON
): Promise<any> {
  return waitFor(
    async () => {
      const s = await ui.state()
      if (!s || s.status === 'building') return false
      if (s.status === 'ready') return s.generation > generation && s
      return !onlyReady && s
    },
    label,
    timeout
  )
}

/** The page state without its catalog, toolchain candidates and build report. */
// biome-ignore lint/suspicious/noExplicitAny: page state is untyped JSON
const brief = (s: any) => ({
  status: s.status,
  generation: s.generation,
  stale: s.stale,
  shown: s.shown,
  message: s.message,
  durationMs: s.durationMs,
  problems: s.problems
})

/** Run a step whose failure is recorded and reported at the end, so later steps still run. */
async function attempt<T>(soft: string[], step: () => Promise<T>): Promise<T | null> {
  try {
    return await step()
  } catch (error) {
    soft.push(error instanceof Error ? error.message : String(error))
    return null
  }
}

const gitLines = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => line.trim() && !/^.. \.trezi\//.test(line))

function swiftFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? swiftFiles(path) : name.endsWith('.swift') ? [path] : []
  })
}

/** Back to the first fixture project, with the Scraib copy closed. */
export async function restoreScraibXcode(host: NativeBridge, firstProject: string) {
  turns?.restore()
  turns = undefined
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

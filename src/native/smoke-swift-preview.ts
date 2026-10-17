import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { type ChatTurn, initRepo, SwiftChatTurns } from './smoke-swift-chat'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const SEARCH = 'Sources/DemoComponents/SearchPanelController.swift'
/** The provider stub of the run in flight; `restoreSwiftPreview` always lifts it. */
let turns: SwiftChatTurns | undefined

/**
 * LKM-271: a native Swift project in Trezi. Opens a copy of
 * `test/fixtures/swift-components`, waits for the preview driver's first build, then
 * captures the SwiftUI and AppKit previews, clicks and types into them through the
 * page, and takes three chat turns from a fixture provider through the real pipeline
 * (composer, agent:send, the chat worktree, the landing commit): an edit that rebuilds, an
 * edit that does not compile (error shown with the last good build kept, and handed to
 * the chat by the landing check) and the fix that recovers.
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
  initRepo(project)
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

  const firstChat = nativeChat.active
  await nativeWorkspace.command({ type: 'open', root: project })
  const swiftKey = nativeWorkspace.active?.key ?? ''
  assert.notEqual(swiftKey, firstProject, 'the Swift project is open')
  const chatKey = await waitFor(
    () => nativeChat.active !== firstChat && nativeChat.active,
    'the Swift project chat',
    30_000
  )
  const chat = new SwiftChatTurns(host, chatKey, project)
  turns = chat
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

  // Source edits arrive the way a chat turn lands them: composer -> agent:send -> the
  // chat's worktree -> landing commit on the live tree -> rebuild. Only the model is a
  // fixture (the provider stub); the compile error is fed back through the landing check.
  await chat.attach()
  const source = join(project, SEARCH)
  const edit = (from: string, to: string) => (_received: string, worktree: string) => {
    const file = join(worktree, SEARCH)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes(from), `the worktree copy has ${from}`)
    writeFileSync(file, text.replace(from, to))
  }
  const landed: Record<string, ChatTurn> = {}
  const landing = (turn: ChatTurn, label: string) => {
    assert.ok(
      turn.liveUntouchedBeforeLanding,
      `${label}: the live tree was untouched before landing`
    )
    assert.match(turn.branch, /^trezi\/chat-/, `${label}: edited on the chat branch`)
    assert.ok(turn.worktree !== project, `${label}: edited in a worktree`)
    assert.equal(turn.commitsAdded, 1, `${label}: one landing commit`)
    assert.deepEqual(turn.commit.files, [SEARCH], `${label}: the landed file`)
    assert.match(turn.commit.chat, /^trezi\/chat-/, `${label}: commit names the chat`)
  }

  // 1. A chat edit lands and the new host shows it.
  landed.edit = await chat.turn(
    'Rename the search placeholder to Find components.',
    edit('"Search components"', '"Find components"')
  )
  landing(landed.edit, 'edit')
  assert.ok(readFileSync(source, 'utf8').includes('Find components'), 'landed in the live tree')
  await shown('search-panel', 2)
  assert.ok((await describe('search-panel')).includes('Find components'), 'the edit is on screen')
  evidence.edited = await state()
  await capture('edited')

  // 2. A chat edit that does not compile: the page shows it next to the last good build,
  // and the landing check hands the compiler's line to the chat.
  landed.error = await chat.turn(
    'Use the new search method.',
    edit('index.search(query)', 'index.serch(query)')
  )
  landing(landed.error, 'error')
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
  const row = await waitFor(
    () =>
      nativeChat
        .get(chatKey)
        .messages.find((m) => m.landingCheck?.errors.some((e) => /serch/.test(e))),
    'landing check row for the compile error',
    90_000
  )
  evidence.landingCheck = row.landingCheck
  assert.equal(row.landingCheck.problem, 'errors')
  assert.match(row.landingCheck.errors[0], /SearchPanelController\.swift:59: .*serch/)

  // 3. The fix turn only runs if the agent was told the diagnostic; it lands and recovers.
  landed.fix = await chat.turn('Fix the build.', (received, worktree) => {
    assert.match(received, /preview check after your last landing found a problem/)
    assert.match(received, /SearchPanelController\.swift:59: .*serch/)
    edit('index.serch(query)', 'index.search(query)')(received, worktree)
  })
  landing(landed.fix, 'fix')
  evidence.recovered = await shown('search-panel', 3)
  assert.equal((evidence.recovered as { status: string }).status, 'ready')
  await capture('recovered')
  evidence.provenance = {
    chatLanded: Object.fromEntries(
      Object.entries(landed).map(([step, turn]) => [
        step,
        {
          branch: turn.branch,
          liveUntouchedBeforeLanding: turn.liveUntouchedBeforeLanding,
          commit: turn.commit,
          diagnosticInPrompt: step === 'fix' ? /serch/.test(turn.received) : undefined
        }
      ])
    ),
    syntheticDirectWrites: [],
    fixtures: [
      'The model is a fixture provider (stubAgentSendForSmoke): it applies a scripted edit to the chat worktree. No provider call is made.',
      'Clicks and keys are DOM events on the preview page, not OS input.'
    ]
  }
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
  turns?.restore()
  turns = undefined
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

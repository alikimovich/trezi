import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { restoreSidebarFocus } from './smoke-sidebar'
import { nativeWorkspace } from './workspace-runtime'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const background = () => process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'

async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 30000,
  describe?: () => unknown | Promise<unknown>
) {
  for (const end = Date.now() + timeout; Date.now() < end; await pause(50))
    if (await check()) return
  let detail: unknown
  try {
    detail = await describe?.()
  } catch (error) {
    detail = `diagnostics unavailable: ${String(error)}`
  }
  throw new Error(
    `Chat gate: ${label} did not settle: ${JSON.stringify({ status: nativeWorkspace.state.status, loadedKey: nativeWorkspace.state.loadedKey, ...(detail === undefined ? {} : { detail }) })}`
  )
}

/** Foreground capture plus native geometry and visibility at each open phase. */
export async function captureChatGate(
  host: NativeBridge,
  artifacts: string,
  stage: string,
  chat: boolean,
  ready = chat,
  header: boolean | null = chat
) {
  if (!background()) await restoreSidebarFocus(host, `chat gate ${stage}`)
  const [layout, shell, view, composer] = await Promise.all(
    ['layoutInspect', 'shellInspect', 'chatInspect', 'composerInspect'].map((method) =>
      host.request(method)
    )
  )
  const state = {
    stage,
    status: nativeWorkspace.state.status.kind,
    project: nativeWorkspace.active?.name ?? null,
    chatReady: shell.chatReady,
    chatVisible: view.visible,
    composerVisible: composer.visible,
    sendEnabled: composer.enabled,
    draft: composer.text,
    messageCount: view.messageCount,
    messageIDs: view.messages.map((message: { id: string }) => message.id),
    visibleMessageIDs: view.visibleMessageIDs,
    chatSession: view.chat,
    chatTitle: shell.chatTitle,
    selected: shell.selected,
    chatFrame: view.frame,
    chatHeaderContentVisible: shell.chatHeaderContentVisible,
    chatColumnHidden: layout.chatColumnHidden,
    leading: layout.leading,
    preview: layout.preview,
    statusView: { frame: layout.status, hidden: layout.statusHidden, kind: layout.statusKind },
    previewHidden: layout.previewHidden,
    windowWidth: shell.sidebarWidth + shell.detailWidth,
    sidebarWidth: shell.sidebarWidth,
    detailLeading: shell.detailLeading,
    toolbar: shell.toolbar,
    capture: background()
      ? 'offscreen (TREZI_NATIVE_BACKGROUND_TEST=1: reduced coverage)'
      : 'foreground window'
  }
  assert.equal(shell.chatReady, ready, `Chat gate ${stage}: readiness: ${JSON.stringify(state)}`)
  for (const [name, value] of [
    ['chat view', view.visible],
    ['composer', composer.visible],
    ['chat column', !layout.chatColumnHidden]
  ] as const)
    assert.equal(
      value,
      chat,
      `Chat gate ${stage}: ${name} must be ${chat ? 'shown' : 'hidden'}: ${JSON.stringify(state)}`
    )
  if (header !== null)
    assert.equal(shell.chatHeaderContentVisible, header, `Chat gate ${stage}: chat header`)
  if (!ready) assert.equal(composer.enabled, false, `Chat gate ${stage}: Send stays disabled`)
  if (chat) {
    assert.equal(
      shell.selected,
      `chat:${view.chat}`,
      `Chat gate ${stage}: selected chat owns column`
    )
    assert.ok(shell.chatTitle.length > 0, `Chat gate ${stage}: selected title is present`)
  }
  if (nativeWorkspace.active && !ready) {
    assert.equal(
      layout.statusHidden,
      false,
      `Chat gate ${stage}: the loading/error state must show`
    )
    assert.ok(
      layout.status.startsWith(`{{${layout.leading}, 0}`),
      `Chat gate ${stage}: status belongs in the preview: ${layout.status}`
    )
    assert.equal(
      layout.previewHidden,
      true,
      `Chat gate ${stage}: the last project's page must not cover the status`
    )
  }
  if (stage === 'loaded' || stage === 'retry-ready')
    assert.equal(
      layout.previewHidden,
      false,
      `Chat gate ${stage}: a loaded project shows its preview`
    )
  let png: string
  if (background()) {
    console.log(
      `Reduced coverage: chat gate ${stage} captured offscreen (TREZI_NATIVE_BACKGROUND_TEST).`
    )
    png = await host.request('captureShell')
  } else png = (await host.request('captureVisibleWindow')).png
  writeFileSync(join(artifacts, `chat-gate-${stage}.png`), Buffer.from(png, 'base64'))
  writeFileSync(join(artifacts, `chat-gate-${stage}.json`), JSON.stringify(state, null, 2))
  return state
}

/** Loaded → opening another project → failed open → Retry → switch back. */
export async function checkChatGate(host: NativeBridge, fixture: string, artifacts: string) {
  const first = nativeWorkspace.active!
  // Start from a hidden, empty, unread-free Activity, whatever ran before this check.
  host.emit('activity-action', { action: 'reset' })
  await until(
    async () => {
      const activity = await host.request('activityInspect')
      return !activity.visible && activity.count === 0
    },
    'Activity reset',
    30000,
    async () => {
      const { text, ...activity } = await host.request('activityInspect')
      return { ...activity, tail: String(text).slice(-300) }
    }
  )
  assert.equal(nativeWorkspace.state.loadedKey, first.key, 'The opened project is the loaded one')
  const originalShell = await host.request('shellInspect')
  const originalWidth = Math.round(originalShell.sidebarWidth + originalShell.detailWidth)
  assert.ok(originalWidth >= 850 && originalWidth <= 2000, 'Original window can be restored')
  assert.equal(await host.request('shellPerform', { action: 'window-width', row: '1320' }), true)
  const loaded = await captureChatGate(host, artifacts, 'loaded', true)
  const normalWidth = 1320
  const root = join(fixture, '../Folder Gamma')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<h1 id="gamma-project">Gamma project</h1>')
  // A custom command that runs a while and then fails gives a deterministic opening then failed-open state.
  const opening = nativeWorkspace.command({ type: 'open', root, command: 'sleep 15; exit 1' })
  const settled = opening.then(
    () => null,
    (error: unknown) => error
  )
  await until(
    async () =>
      nativeWorkspace.state.status.kind === 'busy' &&
      nativeWorkspace.active?.key !== first.key &&
      (await host.request('layoutInspect')).statusKind === 'busy',
    'opening state'
  )
  const gamma = nativeWorkspace.active!
  await until(
    async () => (await host.request('chatInspect')).chat === gamma.activeSessionKey,
    'opening chat belongs to Gamma'
  )
  const gammaChat = nativeChat.get(gamma.activeSessionKey)
  await until(() => gammaChat.ready, 'selected chat initialized during opening')
  const transcriptID = 'chat-gate-existing-message'
  const transcriptText = 'An existing reply in this selected chat.'
  gammaChat.messages.push({
    id: transcriptID,
    role: 'assistant',
    at: Date.now(),
    text: transcriptText,
    statuses: [],
    segments: [{ kind: 'text', text: transcriptText }]
  })
  nativeChat.changed(gammaChat)
  await until(
    async () => (await host.request('chatInspect')).visibleMessageIDs.includes(transcriptID),
    'selected transcript row rendered during opening'
  )
  const previousMessages = gammaChat.messages.length
  assert.ok(previousMessages > 0, 'The opening chat has an existing transcript')
  await host.request('composerPerform', { text: 'Draft while opening' })
  await until(() => gammaChat.text === 'Draft while opening', 'opening draft reaches selected chat')
  const busy = await captureChatGate(host, artifacts, 'opening', true, false)
  assert.equal(busy.draft, 'Draft while opening', 'Opening keeps the selected draft')
  assert.equal(busy.messageCount, previousMessages, 'Opening keeps the native transcript count')
  assert.ok(busy.visibleMessageIDs.includes(transcriptID), 'Opening renders the selected reply')
  assert.equal(await host.request('shellPerform', { action: 'window-width', row: '900' }), true)
  const busyNarrow = await captureChatGate(host, artifacts, 'opening-narrow', true, false, null)
  assert.ok(
    busy.windowWidth - busyNarrow.windowWidth > 300,
    'Opening captures normal and narrow widths'
  )
  assert.equal(busyNarrow.messageCount, previousMessages, 'Narrow opening keeps the transcript')
  assert.ok(
    busyNarrow.visibleMessageIDs.includes(transcriptID),
    'Narrow opening renders the selected reply'
  )
  assert.equal(
    await host.request('shellPerform', { action: 'window-width', row: String(normalWidth) }),
    true
  )
  await host.request('composerPerform', { action: 'send' })
  await host.request('composerPerform', { key: 'Enter' })
  assert.equal(busy.statusView.kind, 'busy', 'The opening capture shows the loading state')
  assert.equal(
    await settled,
    null,
    'A failed open reports in the workspace, not as a thrown command'
  )
  await until(
    async () =>
      nativeWorkspace.state.status.kind === 'error' &&
      (await host.request('layoutInspect')).statusKind === 'error',
    'failed open'
  )
  const failed = await captureChatGate(host, artifacts, 'failed-open', true, false)
  assert.equal(
    failed.messageCount,
    previousMessages,
    'Opening error keeps the native transcript count'
  )
  assert.ok(
    failed.visibleMessageIDs.includes(transcriptID),
    'Opening error renders the selected reply'
  )
  assert.equal(gammaChat.messages.length, previousMessages, 'Disabled Send admits no early message')
  assert.equal(gammaChat.text, 'Draft while opening', 'Disabled Send keeps the draft')
  assert.equal(gammaChat.isRunning, false, 'Disabled Send starts no provider turn')
  assert.equal(failed.draft, busy.draft, 'Failed opening keeps the draft in the column')
  assert.equal(await host.request('shellPerform', { action: 'window-width', row: '900' }), true)
  const narrow = await captureChatGate(host, artifacts, 'failed-open-narrow', true, false, null)
  assert.ok(
    failed.windowWidth - narrow.windowWidth > 300,
    'Error captures normal and narrow widths'
  )
  assert.equal(narrow.messageCount, previousMessages, 'Narrow opening error keeps the transcript')
  assert.ok(
    narrow.visibleMessageIDs.includes(transcriptID),
    'Narrow column renders the selected reply'
  )
  assert.equal(
    await host.request('shellPerform', { action: 'window-width', row: String(normalWidth) }),
    true
  )
  assert.equal(await host.request('shellPerform', { action: 'expand' }), true)
  await until(
    async () => (await host.request('layoutInspect')).chatColumnHidden,
    'manual Hide collapses chat'
  )
  await captureChatGate(host, artifacts, 'manually-hidden', false)
  assert.equal(await host.request('shellPerform', { action: 'expand' }), true)
  await until(async () => {
    const layout = await host.request('layoutInspect')
    return !layout.chatColumnHidden && layout.fraction === 1
  }, 'manual Restore finishes showing chat')
  await captureChatGate(host, artifacts, 'restored-after-error', true, false)
  // The failure is recorded and marked unread without opening or focusing Activity.
  await until(
    async () => {
      const activity = await host.request('activityInspect')
      return !activity.visible && activity.unread > 0 && activity.unreadLevel === 'needs-action'
    },
    'failed open marks Activity unread',
    30000,
    async () => {
      const { text, ...activity } = await host.request('activityInspect')
      return {
        activity,
        textTail: String(text).slice(-300),
        status: nativeWorkspace.state.status
      }
    }
  )
  assert.equal(
    (await host.request('activityInspect')).key,
    false,
    'A failed open does not take the key window'
  )
  host.emit('menu', { action: 'activity' })
  await until(async () => {
    const activity = await host.request('activityInspect')
    return activity.visible && activity.text.includes('Could not open Folder Gamma')
  }, 'manual Activity menu shows the recorded failure')
  assert.equal((await host.request('activityInspect')).key, true, 'manual open focuses Activity')
  host.emit('activity-action', { action: 'hide' })
  for (const state of [busy, failed]) {
    assert.equal(state.chatSession, gamma.activeSessionKey, `${state.stage}: correct conversation`)
    assert.equal(state.chatFrame, loaded.chatFrame, `${state.stage}: chat frame stays fixed`)
    assert.equal(
      state.leading,
      loaded.leading,
      `Chat gate ${state.stage}: the chat column keeps its width`
    )
    assert.equal(
      state.preview,
      loaded.preview,
      `Chat gate ${state.stage}: the preview frame does not move`
    )
    assert.equal(
      state.detailLeading,
      loaded.detailLeading,
      `Chat gate ${state.stage}: the detail pane does not move`
    )
  }
  // Retry (the status view's "run" action) opens the project again; now it loads with its static site.
  // Retry only means something on the project that failed: a silent no-op in `restart`
  // (another project active) would otherwise show up as an unexplained timeout.
  assert.equal(
    nativeWorkspace.state.activeKey,
    gamma.key,
    'Retry runs on the project that failed to open'
  )
  await nativeWorkspace.command({ type: 'restart', key: gamma.key })
  await until(
    async () =>
      nativeWorkspace.state.loadedKey === gamma.key &&
      (await host.request('shellInspect')).chatReady,
    'retry loads the project',
    30000,
    async () => {
      const { text } = await host.request('activityInspect')
      return {
        activeKey: nativeWorkspace.state.activeKey,
        gamma: gamma.key,
        launchSpec: nativeWorkspace.active?.launchSpec ?? null,
        url: nativeWorkspace.active?.url ?? null,
        statusKind: (await host.request('layoutInspect')).statusKind,
        status: nativeWorkspace.state.status,
        loadedKey: nativeWorkspace.state.loadedKey,
        activityTail: String(text).slice(-400)
      }
    }
  )
  const ready = await captureChatGate(host, artifacts, 'retry-ready', true)
  assert.equal(ready.draft, 'Draft while opening', 'Ready chat keeps its unsent draft')
  assert.equal(ready.sendEnabled, true, 'Ready chat enables Send for the saved draft')
  // Switching back changes the chat identity before the preview is ready.
  const back = nativeWorkspace.command({ type: 'select', key: first.key })
  assert.notEqual(nativeWorkspace.state.loadedKey, first.key)
  await back
  await until(
    async () =>
      nativeWorkspace.state.loadedKey === first.key && (await host.request('chatInspect')).visible,
    'first project ready again'
  )
  await nativeWorkspace.command({ type: 'close', key: gamma.key })
  assert.equal(
    await host.request('shellPerform', { action: 'window-width', row: String(originalWidth) }),
    true
  )
  writeFileSync(
    join(artifacts, 'chat-gate.json'),
    JSON.stringify(
      {
        loaded,
        opening: busy,
        openingNarrow: busyNarrow,
        failedOpen: failed,
        failedOpenNarrow: narrow,
        retryReady: ready,
        switchedBack: true
      },
      null,
      2
    )
  )
}

/** Cleanup: leave only the original project open and selected. */
export async function restoreChatGate(firstKey: string, host: NativeBridge) {
  // The failed open's Activity line and window must not leak into the checks after this one.
  host.emit('activity-action', { action: 'reset' })
  for (const entry of [...nativeWorkspace.state.projects])
    if (entry.root.endsWith('/Folder Gamma'))
      await nativeWorkspace.command({ type: 'close', key: entry.key })
  if (firstKey && nativeWorkspace.state.activeKey !== firstKey)
    await nativeWorkspace.command({ type: 'select', key: firstKey })
}

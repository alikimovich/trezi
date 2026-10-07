import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTIVITY_AUTO_OPEN_KEY, activityAutoOpen } from './activity-controller'
import type { NativeBridge } from './bridge'
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

/** LKM-120 evidence for one state: a foreground window capture plus the host's
 *  layout/shell/chat state, asserting the chat is shown only for a loaded project. */
export async function captureChatGate(
  host: NativeBridge,
  artifacts: string,
  stage: string,
  chat: boolean
) {
  if (!background()) await restoreSidebarFocus(host, `chat gate ${stage}`)
  const [layout, shell, view] = await Promise.all(
    ['layoutInspect', 'shellInspect', 'chatInspect'].map((method) => host.request(method))
  )
  const state = {
    stage,
    status: nativeWorkspace.state.status.kind,
    project: nativeWorkspace.active?.name ?? null,
    chatReady: shell.chatReady,
    chatVisible: view.visible,
    chatHeaderContentVisible: shell.chatHeaderContentVisible,
    chatColumnHidden: layout.chatColumnHidden,
    leading: layout.leading,
    preview: layout.preview,
    statusView: { frame: layout.status, hidden: layout.statusHidden, kind: layout.statusKind },
    previewHidden: layout.previewHidden,
    sidebarWidth: shell.sidebarWidth,
    detailLeading: shell.detailLeading,
    toolbar: shell.toolbar,
    capture: background()
      ? 'offscreen (TREZI_NATIVE_BACKGROUND_TEST=1: reduced coverage)'
      : 'foreground window'
  }
  for (const [name, value] of [
    ['chatReady', shell.chatReady],
    ['chat view', view.visible],
    ['chat header', shell.chatHeaderContentVisible],
    ['chat column', !layout.chatColumnHidden]
  ] as const)
    assert.equal(
      value,
      chat,
      `Chat gate ${stage}: ${name} must be ${chat ? 'shown' : 'hidden'}: ${JSON.stringify(state)}`
    )
  if (!chat && nativeWorkspace.active) {
    assert.equal(
      layout.statusHidden,
      false,
      `Chat gate ${stage}: the loading/error state must show`
    )
    assert.ok(
      layout.status.startsWith('{{0, 0}'),
      `Chat gate ${stage}: the status must cover the empty chat column: ${layout.status}`
    )
    assert.equal(
      layout.previewHidden,
      true,
      `Chat gate ${stage}: the last project's page must not cover the status`
    )
  }
  if (chat)
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

/** Loaded → opening another project → failed open → Retry → switch back, with the
 *  chat hidden until each project has opened and no layout jump between them. */
export async function checkChatGate(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  preference: (key: string) => string | null
) {
  const first = nativeWorkspace.active!
  // LKM-152's automatic open happens once per event kind per process: start from a hidden,
  // empty, unread-free Activity that has not auto-opened yet, whatever ran before this check.
  host.emit('activity-action', { action: 'reset' })
  await until(async () => {
    const activity = await host.request('activityInspect')
    return !activity.visible && activity.count === 0
  }, 'Activity reset')
  assert.equal(nativeWorkspace.state.loadedKey, first.key, 'The opened project is the loaded one')
  const loaded = await captureChatGate(host, artifacts, 'loaded', true)
  const root = join(fixture, '../Folder Gamma')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<h1 id="gamma-project">Gamma project</h1>')
  // A custom command that runs a while and then fails gives a deterministic opening then failed-open state.
  const opening = nativeWorkspace.command({ type: 'open', root, command: 'sleep 8; exit 1' })
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
  const busy = await captureChatGate(host, artifacts, 'opening', false)
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
  const failed = await captureChatGate(host, artifacts, 'failed-open', false)
  // LKM-152: a failed open has no automatic recovery, so Activity comes to front by itself,
  // without taking the key window from the chat (the capture above needs it).
  await until(
    async () => {
      const activity = await host.request('activityInspect')
      return activity.visible && activity.text.includes('Could not open Folder Gamma')
    },
    'failed open shows Activity',
    30000,
    async () => {
      const { text, ...activity } = await host.request('activityInspect')
      return {
        activity,
        textTail: String(text).slice(-300),
        autoOpen: activityAutoOpen(preference(ACTIVITY_AUTO_OPEN_KEY))
      }
    }
  )
  assert.equal(
    (await host.request('activityInspect')).key,
    false,
    'An automatic Activity open does not take the key window'
  )
  host.emit('activity-action', { action: 'hide' })
  for (const state of [busy, failed]) {
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
  await nativeWorkspace.command({ type: 'restart', key: gamma.key })
  await until(
    async () =>
      nativeWorkspace.state.loadedKey === gamma.key &&
      (await host.request('shellInspect')).chatReady,
    'retry loads the project'
  )
  // Switching back hides the chat at once and shows it when that project is ready.
  const back = nativeWorkspace.command({ type: 'select', key: first.key })
  assert.notEqual(
    nativeWorkspace.state.loadedKey,
    first.key,
    'Switching projects hides the chat until the project is ready'
  )
  await back
  await until(
    async () =>
      nativeWorkspace.state.loadedKey === first.key && (await host.request('chatInspect')).visible,
    'first project ready again'
  )
  await nativeWorkspace.command({ type: 'close', key: gamma.key })
  writeFileSync(
    join(artifacts, 'chat-gate.json'),
    JSON.stringify(
      { loaded, opening: busy, failedOpen: failed, retried: true, switchedBack: true },
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

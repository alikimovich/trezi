import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { dispatchIPC, serviceEvents } from './platform'
import { checkNativeAlerts } from './smoke-alerts'
import { preparePreviewInput } from './smoke-input'
import { checkVisibleSettings } from './smoke-settings'
/** Cleanup for an aborted run (a focus-loss retry starts over on the same profile): closes any
 *  sheet and saves the new-profile Settings values the check changes, so the retry sees a new profile. */
export async function restoreNativeSheets(host: NativeBridge) {
  const settle = async (check: (state: any) => boolean) => {
    for (const end = Date.now() + 4000; Date.now() < end; ) {
      if (check(await host.request('sheetInspect'))) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Native sheet did not settle during cleanup')
  }
  if ((await host.request('sheetInspect')).visible) {
    await host.request('sheetPerform', { action: 'closeWindow' })
    await settle((state) => !state.visible)
  }
  host.emit('menu', { action: 'settings' })
  await settle((state) => state.visible && state.title === 'Settings')
  await host.request('sheetPerform', {
    action: 'change',
    values: {
      default: 'last-used',
      projectUi: 'false',
      engine: 'agent',
      claudePlugins: 'false',
      agentFileAccess: 'full',
      agentGitAccess: 'managed',
      agentMerge: 'true',
      activityAutoOpen: 'problems',
      quitDontAsk: 'false'
    }
  })
  await settle((state) => !state.busy)
  // Settings reopens on the last section; a new profile opens on General.
  await host.request('settingsVerification', { section: 'general' })
  await settle((state) => state.section === 'general')
  await host.request('sheetPerform', { action: 'closeWindow' })
  await settle((state) => !state.visible)
}
export async function checkNativeSheets(host: NativeBridge, key: string, artifacts: string) {
  // `timeoutMs` is 4 s unless a wait depends on a real process scan; a timeout names the
  // check that did not settle and the last sheet state instead of a bare message.
  const wait = async (check: (state: any) => boolean, timeoutMs = 4000) => {
    let state: any
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      state = await host.request('sheetInspect')
      if (check(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(
      `Native sheet did not reach expected state: ${String(check).replace(/\s+/g, ' ')} — last ${JSON.stringify(state)}`
    )
  }
  await checkNativeAlerts(host, artifacts)
  host.emit('menu', { action: 'servers' })
  // The lookup runs `lsof` and `ps` in the service, which a loaded machine can slow past 4 s.
  await wait((state) => state.visible && state.title === 'Running servers' && !state.busy, 20000)
  writeFileSync(
    join(artifacts, 'running-servers.png'),
    Buffer.from(await host.request('captureSheet'), 'base64')
  )
  await host.request('sheetPerform', { action: 'cancel' })
  await wait((state) => !state.visible)
  await host.request('shellPerform', { action: 'new-project' })
  const projectWindow = await wait((state) => state.visible && state.title === 'New project')
  if (projectWindow.attached || !projectWindow.closable || !projectWindow.resizable)
    throw new Error('Forms must use standalone native windows with window controls')
  await new Promise((resolve) => setTimeout(resolve, 250))
  writeFileSync(
    join(artifacts, 'new-project.png'),
    Buffer.from(await host.request('captureSheet'), 'base64')
  )
  await host.request('sheetPerform', { action: 'closeWindow' })
  await wait((state) => !state.visible)
  host.emit('shell-action', { action: 'memory', project: key })
  await wait((state) => state.visible && state.fields.includes('content'))
  await host.request('sheetPerform', {
    values: { content: '# Decisions\n\nUse native UI.' },
    action: 'change'
  })
  await wait((state) => !state.busy)
  let saved: any
  for (let i = 0; i < 80; i++) {
    saved = await dispatchIPC('main', {
      type: 'invoke',
      channel: 'project-memory:get',
      args: [key]
    })
    if (saved.content.includes('Use native UI.')) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!saved.content.includes('Use native UI.')) throw new Error('Native memory save failed')
  await new Promise((resolve) => setTimeout(resolve, 250))
  writeFileSync(
    join(artifacts, 'project-memory.png'),
    Buffer.from(await host.request('captureSheet'), 'base64')
  )
  await host.request('sheetPerform', { action: 'cancel' })
  await wait((state) => !state.visible)
  // The projects sidebar in the foreground, for side-by-side parity with the Settings captures.
  await preparePreviewInput(host, true)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const shell = await host.request('shellInspect')
  const projectsSidebar = await host.request('captureVisibleSidebar')
  writeFileSync(
    join(artifacts, 'settings-parity-projects-sidebar.png'),
    Buffer.from(projectsSidebar.png, 'base64')
  )
  writeFileSync(
    join(artifacts, 'settings-parity-projects-sidebar.json'),
    JSON.stringify(
      {
        sourceList: shell.sourceList,
        sidebarWidth: shell.sidebarWidth,
        imageWidth: projectsSidebar.width,
        imageHeight: projectsSidebar.height
      },
      null,
      2
    )
  )
  host.emit('menu', { action: 'settings' })
  await wait(
    (state) => state.visible && state.title === 'Settings' && state.windowTitle === 'General'
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  writeFileSync(
    join(artifacts, 'settings.png'),
    Buffer.from(await host.request('captureSheet'), 'base64')
  )
  await checkVisibleSettings(host, artifacts, shell.sourceList)
  await host.request('sheetPerform', {
    action: 'change',
    values: { default: 'last-used', projectUi: 'false', engine: 'agent' }
  })
  await wait((state) => !state.busy)
  // AI Providers is inline: its editor replaces the pane inside the same Settings window.
  await host.request('settingsVerification', { section: 'providers' })
  await wait(
    (state) =>
      state.section === 'providers' &&
      state.actions.includes('add') &&
      state.fields.includes('connections')
  )
  await host.request('sheetPerform', { action: 'add' })
  await wait(
    (state) =>
      state.title === 'Settings' &&
      state.section === 'providers' &&
      state.fields.includes('key') &&
      state.fields.includes('default')
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  writeFileSync(
    join(artifacts, 'settings-provider-editor.png'),
    Buffer.from(await host.request('captureSheet'), 'base64')
  )
  await host.request('sheetPerform', { action: 'back' })
  await wait((state) => state.fields.includes('connections') && !state.fields.includes('key'))
  await host.request('settingsVerification', { section: 'general' })
  await wait((state) => state.section === 'general')
  await host.request('sheetPerform', { action: 'cancel' })
  await wait((state) => !state.visible)
  host.emit('menu', { action: 'feedback' })
  await wait(
    (state) =>
      state.visible &&
      state.title === 'Send feedback' &&
      state.fields.includes('body') &&
      state.fields.includes('diagnostics')
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  writeFileSync(
    join(artifacts, 'feedback.png'),
    Buffer.from(await host.request('captureSheet'), 'base64')
  )
  await host.request('sheetPerform', { action: 'cancel' })
  await wait((state) => !state.visible)
  host.emit('menu', { action: 'diagnose' })
  await wait((state) => state.visible && state.title === 'Preview problem')
  await host.request('sheetPerform', { action: 'cancel' })
  await wait((state) => !state.visible)
  // LKM-152: dev-server output never opens Activity; a warning while it is hidden shows the
  // unread marker (sidebar dot, Window → Activity badge); Command-L opens it and clears the marker.
  host.emit('activity-action', { action: 'hide' })
  serviceEvents.emit('event', 'devserver:log', '  VITE v5.4.0  ready in 312 ms')
  host.emit('download-error', { message: 'Native activity unread fixture' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const unread = await host.request('activityInspect')
  if (unread.visible) throw new Error('Dev-server output or a warning opened Activity by itself')
  if (unread.unread < 1 || unread.unreadLevel === 'info' || !unread.indicatorVisible)
    throw new Error(
      `Unread Activity marker missing: ${JSON.stringify({ ...unread, text: undefined })}`
    )
  if (unread.menuParent !== 'Window' || unread.menuTitle !== 'Activity' || unread.menuKey !== 'l')
    throw new Error('Window → Activity (Command-L) missing')
  await preparePreviewInput(host, true)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const marked = await host.request('captureVisibleSidebar')
  writeFileSync(join(artifacts, 'activity-unread-sidebar.png'), Buffer.from(marked.png, 'base64'))
  if (!(await host.request('activityMenu')).handled)
    throw new Error('Command-L did not reach Window → Activity')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const activity = await host.request('activityInspect')
  writeFileSync(
    join(artifacts, 'activity-unread.json'),
    JSON.stringify(
      { unread: { ...unread, text: undefined }, opened: { ...activity, text: undefined } },
      null,
      2
    )
  )
  if (!activity.visible || activity.count < 2 || !activity.text.includes('VITE'))
    throw new Error('Native activity did not receive server logs')
  if (activity.unread !== 0 || activity.indicatorVisible || activity.menuBadge)
    throw new Error('Viewing Activity did not clear the unread marker')
  host.emit('activity-action', { action: 'clear' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  if ((await host.request('activityInspect')).count !== 0)
    throw new Error('Native activity clear failed')
  host.emit('activity-action', { action: 'hide' })
  console.log(
    'Native New Project and project-memory sheets: presentation, cancel and saved memory passed.'
  )
}

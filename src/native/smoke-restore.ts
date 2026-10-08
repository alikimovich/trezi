import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { dispatchIPC } from './platform'
import { preparePreviewInput } from './smoke-input'
import { restoreSidebarFocus } from './smoke-sidebar'
import { nativeWorkspace } from './workspace-runtime'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Per-check failure evidence: the shell capture plus the state the old single-failure path logged. */
export async function captureSmokeFailure(
  host: NativeBridge,
  artifacts: string,
  name: string
): Promise<string> {
  const path = join(artifacts, `failure-${name}.png`)
  try {
    console.error(`Native chat state after ${name}:`, await host.request('chatInspect'))
    console.error(`Native geometry after ${name}:`, await host.request('layoutInspect'))
  } catch {
    /* the capture below is the evidence that matters */
  }
  writeFileSync(path, Buffer.from(await host.request('captureShell'), 'base64'))
  return path
}

async function until(check: () => Promise<boolean> | boolean, label: string, timeout = 10000) {
  for (const end = Date.now() + timeout; Date.now() < end; await pause(80)) {
    try {
      if (await check()) return
    } catch {
      /* keep polling */
    }
  }
  throw new Error(`Restore timed out: ${label}`)
}

/** Return the app to the state a passing run leaves between checks, so one failure does
 *  not cascade: no menu/sheet/popover, key main window, the first fixture project active
 *  on its own page in desktop viewport, select mode off. Each step is attempted; the
 *  first failure is rethrown only after the rest ran (the runner logs it as a warning). */
export async function restoreSmokeState(host: NativeBridge, firstProject: string) {
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  let failure: unknown
  const step = async (body: () => Promise<unknown>) => {
    try {
      await body()
    } catch (error) {
      failure ??= error
    }
  }
  await step(async () => {
    const sheet = await host.request('sheetInspect')
    if (!sheet?.visible) return
    // Settings reopens on its remembered section and a passing run leaves it on General,
    // so a retried check reopening Settings must not find another section.
    if (sheet.title === 'Settings' && sheet.section && sheet.section !== 'general') {
      if (sheet.fields?.includes('key')) await host.request('sheetPerform', { action: 'back' })
      await host.request('settingsVerification', { section: 'general' })
      await until(
        async () => (await host.request('sheetInspect'))?.section === 'general',
        'Settings on General',
        4000
      )
    }
    await host.request('sheetPerform', { action: 'cancel' })
  })
  await step(() => restoreSidebarFocus(host, 'restore after failed check'))
  await step(() =>
    dispatchIPC('main', { type: 'invoke', channel: 'preview:set-select-mode', args: [false] })
  )
  if (firstProject && nativeWorkspace.state.projects.some((p) => p.key === firstProject)) {
    await step(async () => {
      for (const extra of nativeWorkspace.state.projects.filter((p) => p.key !== firstProject))
        await nativeWorkspace.command({ type: 'close', key: extra.key })
      if (nativeWorkspace.state.activeKey !== firstProject)
        await nativeWorkspace.command({ type: 'select', key: firstProject })
      await until(
        () => nativeWorkspace.state.status.kind === 'running',
        'first project running',
        30000
      )
    })
    await step(async () => {
      if (nativeWorkspace.active?.viewport === 'mobile')
        await host.request('shellPerform', { action: 'device' })
      await until(() => nativeWorkspace.active?.viewport === 'desktop', 'desktop viewport')
    })
    await step(async () => {
      if (!(await page('!!document.querySelector("#native-title")')))
        host.emit('menu', { action: 'reload' })
      await until(() => page('!!document.querySelector("#native-title")'), 'fixture page loaded')
    })
  }
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1') await step(() => preparePreviewInput(host))
  if (failure) throw failure
}

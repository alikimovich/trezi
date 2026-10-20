import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserSetupStatus } from '../main/browser-setup'
import type { NativeBridge } from './bridge'
import { BROWSER_SECTION, CHROMIUM_STATE_LABELS, nativeBrowserSetup } from './settings-browser'
import { SETTINGS_DEFAULT_SIZE } from './settings-verification'
import { FIXTURE_SECRET, installerArgv, writeBrowserFixture } from './smoke-browser-fixture'
import { inspectUntil, waitFor } from './smoke-wait'

/**
 * LOCAL-WEBKIT-4: Settings → Browser Checks in the compiled app. With a private HOME and a
 * scripted npm / npx / agent-browser / headless shell (`smoke-browser-fixture.ts`; the test
 * build's Swift installer uses only that folder), the pane is pressed through: missing,
 * Install agent-browser → partial, a slow shell install's progress and Cancel, a failed
 * install, a retry that checks itself through the packaged wrapper. Then, back on the real
 * HOME, Check Again launches the real CLI and headless shell: missing tools fail the smoke.
 * Built-in WebKit reads Available in every state. Copy and link rows are only inspected,
 * never pressed (they would write the clipboard or open a browser).
 */
const PACKAGED_WRAPPER = '/Contents/Resources/browser/bin/managed/agent-browser'

export async function checkBrowserSetup(host: NativeBridge, artifacts: string) {
  const setup = nativeBrowserSetup.current
  assert.ok(setup, 'Settings → Browser Checks model')
  const testDir = process.env.TREZI_NATIVE_TEST_DIR
  assert.ok(testDir, 'a disposable --test launch (the service installs only into it)')
  const home = join(testDir, 'browser-tools-home')
  const fx = writeBrowserFixture(join(testDir, 'browser-tools-fixture'))
  const report: Record<string, unknown>[] = []
  const save = () =>
    writeFileSync(join(artifacts, 'browser-setup-report.json'), JSON.stringify(report, null, 2))
  const inspect = () => host.request('settingsVerification')
  const settled = async (label: string, check: (s: BrowserSetupStatus) => boolean, ms = 60_000) => {
    const status = await waitFor(
      () => {
        if (setup.busy) return false
        const s = setup.status()
        return check(s) && s
      },
      `Browser Checks: ${label}`,
      ms,
      () => ({ busy: setup.busy, ...setup.status(), detection: undefined })
    )
    await nativeBrowserSetup.running
    return status as BrowserSetupStatus
  }
  /** Presses a footer button as the window does; the pane must offer it enabled. */
  const press = async (action: string) => {
    const state = await inspect()
    assert.ok(state.actions.includes(action), `${action} is offered: ${state.actions}`)
    assert.ok(!state.disabledActions.includes(action), `${action} is enabled`)
    await host.request('sheetPerform', { action })
  }
  const shoot = async (name: string, status: BrowserSetupStatus) => {
    const { width, height } = SETTINGS_DEFAULT_SIZE
    await host.request('settingsVerification', { prepare: true, width, height })
    const evidence = await waitFor(async () => {
      const s = await inspect()
      return s.section === BROWSER_SECTION && Math.abs(s.width - width) <= 1 && s
    }, `Browser Checks: ${name} in view`)
    let capture = 'foreground'
    let png: string
    try {
      png = (await host.request('captureVisibleSheet')).png
    } catch (error) {
      png = await host.request('captureSheet')
      capture = `cached display (${error instanceof Error ? error.message : String(error)})`
    }
    writeFileSync(join(artifacts, `browser-setup-${name}.png`), Buffer.from(png, 'base64'))
    // Built-in WebKit is listed and available whatever the Chromium state.
    assert.equal(status.webkit, 'available')
    for (const id of [
      'browserWebkit',
      'browserChromium',
      'browserCli',
      'browserShell',
      'browserNode'
    ])
      assert.ok(evidence.fields.includes(id), `${name}: ${id} row`)
    assert.ok(evidence.actions.includes('browser-check'), `${name}: Check Again`)
    const rows = evidence.rows.map((r: { action: string }) => r.action)
    for (const id of ['browser-copy-cli', 'browser-copy-shell', 'browser-link-agent-browser'])
      assert.ok(rows.includes(id), `${name}: ${id} row button`)
    const entry = {
      name,
      capture,
      state: status.state,
      label: CHROMIUM_STATE_LABELS[status.state],
      summary: status.summary,
      message: evidence.message,
      actions: evidence.actions,
      disabledActions: evidence.disabledActions,
      install: status.install && { ...status.install, lines: status.install.lines.slice(-5) },
      check: status.check,
      cli: status.detection.cli,
      shell: status.detection.shell,
      wrapper: status.wrapper
    }
    report.push(entry)
    writeFileSync(join(artifacts, `browser-setup-${name}.json`), JSON.stringify(entry, null, 2))
    save()
    return evidence
  }

  setup.setFixture({
    env: {
      HOME: home,
      PATH: `${fx.bin}:/usr/bin:/bin`,
      TREZI_BROWSER_TEST: '1',
      TREZI_BROWSER_TEST_ROOT: join(testDir, 'browser-sessions')
    },
    home
  })
  if ((await host.request('sheetInspect')).title !== 'Settings') {
    host.emit('menu', { action: 'settings' })
    await inspectUntil(
      (method) => host.request(method),
      'sheetInspect',
      (s) => s.visible && s.title === 'Settings'
    )
  }
  await host.request('settingsVerification', { section: BROWSER_SECTION })

  // Nothing installed: WebKit available, Chromium not installed, both Installs offered.
  const tools = join(home, 'Library/Caches/Trezi/browser-tools')
  const missing = await settled('missing', (s) => s.detection.tools === tools)
  assert.equal(missing.state, 'unavailable', missing.summary)
  assert.equal(missing.detection.prerequisites.npm, join(fx.bin, 'npm'))
  const shown = await shoot('missing', missing)
  assert.deepEqual(shown.disabledActions, [])
  assert.ok(
    shown.actions.includes('browser-install-cli') && shown.actions.includes('browser-install-shell')
  )
  assert.equal(
    missing.wrapper?.endsWith(PACKAGED_WRAPPER),
    true,
    `packaged wrapper: ${missing.wrapper}`
  )

  // Install agent-browser: the service's fixed npm run into Trezi's tools folder → partial.
  await press('browser-install-cli')
  const partial = await settled('partial', (s) => !!s.install && !s.install.running)
  assert.equal(partial.state, 'partial', partial.install?.error ?? partial.summary)
  assert.equal(partial.detection.cli?.source, 'trezi')
  assert.match(
    installerArgv(fx.dir, 'npm')[0] ?? '',
    /^install --prefix .* agent-browser@0\.26\.0$/
  )
  const shownPartial = await shoot('partial', partial)
  assert.ok(!shownPartial.actions.includes('browser-install-cli'))

  // A slow shell install: progress reaches the pane, then Cancel stops it.
  fx.mode('npx', 'slow')
  await press('browser-install-shell')
  const running = await waitFor(
    () =>
      setup.status().install?.lines.some((line) => line.startsWith('Downloading')) &&
      setup.status(),
    'Browser Checks: install progress',
    30_000
  )
  const shownRunning = await shoot('installing', running)
  assert.ok(shownRunning.actions.includes('browser-cancel'), 'Cancel Install offered')
  assert.ok(shownRunning.disabledActions.includes('browser-check'), 'no check while installing')
  await press('browser-cancel')
  const cancelled = await settled('cancelled', (s) => !!s.install?.cancelled)
  assert.equal(cancelled.state, 'partial')
  report.push({ name: 'cancelled', state: cancelled.state, error: cancelled.install?.error })

  // A failing install: its redacted error, still partial, never Ready.
  fx.mode('npx', 'fail')
  await press('browser-install-shell')
  const failed = await settled('failed', (s) => !!s.install?.error && !s.install.cancelled)
  assert.equal(failed.state, 'partial')
  assert.equal(failed.check, undefined)
  const shownFailed = await shoot('failed', failed)
  assert.match(shownFailed.message, /exited with status 1/)
  assert.ok(!JSON.stringify(failed).includes(FIXTURE_SECRET), 'no secret in the pane')

  // Retry: installed, then checked at once through the packaged wrapper (fake CLI, real ps).
  fx.mode('npx', 'ok')
  await press('browser-install-shell')
  const fixtureReady = await settled(
    'fixture ready',
    (s) => !!s.install?.done && s.state !== 'unchecked'
  )
  assert.equal(fixtureReady.state, 'ready', fixtureReady.check?.message ?? fixtureReady.summary)
  assert.equal(fixtureReady.check?.browser?.shell, fixtureReady.detection.shell?.path)
  await shoot('fixture-ready', fixtureReady)

  // The real tools on the real HOME: Check Again must reach Ready, or the smoke fails.
  setup.setFixture(null)
  const prior = nativeBrowserSetup.running
  await press('browser-check')
  await waitFor(() => nativeBrowserSetup.running !== prior, 'Browser Checks: Check Again started')
  const ready = await settled('real check', () => true, 120_000)
  await shoot('ready', ready)
  assert.equal(
    ready.state,
    'ready',
    `Real agent-browser and headless shell through Trezi's packaged wrapper: ${ready.check?.message ?? ready.summary}`
  )
  assert.match(ready.check?.browser?.shell ?? '', /\/chrome-headless-shell$/)
  assert.doesNotMatch(ready.check?.browser?.shell ?? '', /\.app\//, 'never Chrome.app')
  console.log(
    `Native Settings → Browser Checks: missing, partial, installing/cancel, failed, retry and real Ready (${ready.detection.cli?.version}, ${ready.detection.shell?.version}) passed.`
  )
}

/** Back to the app's own HOME, and Settings left on General as the other checks expect. */
export async function restoreBrowserSetup(host: NativeBridge) {
  const setup = nativeBrowserSetup.current
  if (setup?.busy) await setup.cancelInstall().catch(() => false)
  await nativeBrowserSetup.running
  setup?.setFixture(null)
  const sheet = await host.request('sheetInspect')
  if (sheet.visible && sheet.title === 'Settings') {
    await host.request('settingsVerification', { section: 'general' })
    await host.request('sheetPerform', { action: 'closeWindow' })
  }
}

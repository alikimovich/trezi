import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import {
  assertSectionEvidence,
  assertSettingsEvidence,
  assertSidebarParity,
  SETTINGS_DEFAULT_SIZE,
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SourceListEvidence,
  settingsVerificationWidths
} from './settings-verification'

/** Manager-owned foreground fixture, reached by the standard native suite. `projects`
 *  is the main window's sidebar (`shellInspect.sourceList`), for the parity check. */
export async function checkVisibleSettings(
  host: NativeBridge,
  artifacts: string,
  projects: SourceListEvidence
) {
  const wait = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    throw new Error('Settings foreground verification timed out')
  }
  const inspect = () => host.request('settingsVerification')
  const events: unknown[] = []
  const record = (event: unknown) => {
    events.push(event)
    writeFileSync(
      join(artifacts, 'settings-visible-interactions.json'),
      JSON.stringify(events, null, 2)
    )
  }
  const choose = async (field: string, value: string) => {
    await host.request('settingsVerification', { field, value })
    await wait(async () => (await inspect()).values[field] === value)
    record({ action: 'native-picker-target-action', field, value, state: await inspect() })
  }
  // Click the source-list row; the pane and the remembered section must follow.
  const select = async (section: SettingsSection) => {
    await host.request('settingsVerification', { section })
    const index = SETTINGS_SECTIONS.findIndex((s) => s.id === section)
    await wait(async () => {
      const state = await inspect()
      return state.section === section && state.sidebarSelected === index
    })
    record({ action: 'sidebar-select', section, state: await inspect() })
  }
  const reopen = async () => {
    const before = await inspect()
    await host.request('sheetPerform', { action: 'closeWindow' })
    await wait(async () => !(await host.request('sheetInspect')).visible)
    host.emit('menu', { action: 'settings' })
    await wait(async () => (await host.request('sheetInspect')).title === 'Settings')
    const after = await inspect()
    assert.notEqual(
      after.id,
      before.id,
      'Reopen creates a fresh Settings model from saved preferences'
    )
    assert.deepEqual(
      after.values,
      before.values,
      'Close must flush autosave and reopen saved choices'
    )
    assert.equal(after.section, before.section, 'Settings reopens on the last selected section')
    record({ action: 'close-reopen-autosave', before, after })
  }
  // The live minimum opens at the minimum height; the normal width at the default size.
  const heightFor = (width: number) =>
    width === minimumWidth
      ? minimumHeight
      : width === SETTINGS_DEFAULT_SIZE.width
        ? SETTINGS_DEFAULT_SIZE.height
        : Math.max(600, minimumHeight)
  const shoot = async (width: number, name: string) => {
    const height = heightFor(width)
    await host.request('settingsVerification', { prepare: true, width, height })
    await wait(async () => (await inspect()).foreground)
    await new Promise((resolve) => setTimeout(resolve, 350))
    const layout = await inspect()
    const image = await host.request('captureVisibleSettings')
    const stem = join(artifacts, `settings-visible-${width}-${name}`)
    writeFileSync(`${stem}.png`, Buffer.from(image.png, 'base64'))
    const evidence = {
      ...layout,
      text: image.text,
      captureWidth: image.width,
      captureHeight: image.height
    }
    writeFileSync(`${stem}.json`, JSON.stringify(evidence, null, 2))
    assert.ok(
      image.width >= width && image.height >= layout.height,
      'Nonempty foreground Settings pixels'
    )
    assert.ok(Math.abs(layout.height - height) <= 1, 'Requested Settings content height')
    assert.equal(
      layout.minimumWidth,
      minimumWidth,
      'Settings minimum must remain stable across state changes and reopen'
    )
    record({ action: 'capture', path: `${stem}.png` })
    return evidence
  }
  const capture = async (
    width: number,
    name: string,
    enabled: boolean,
    engine: 'agent' | 'jev'
  ) => {
    assertSettingsEvidence(await shoot(width, `experimental-${name}`), width, enabled, engine)
  }
  // Disposable native profile starts on General, Off/Chat model. Do not manufacture this state.
  const initial = await inspect()
  const minimumWidth = initial.minimumWidth
  const minimumHeight = initial.minimumHeight
  const widths = settingsVerificationWidths(minimumWidth)
  record({ action: 'width-plan', minimumWidth, minimumHeight, widths })
  assert.equal(initial.section, 'general', 'A new profile opens Settings on General')
  assert.equal(initial.values.projectUi, 'false')
  assert.equal(initial.values.engine, 'agent')
  assert.equal(
    initial.values.claudePlugins,
    'false',
    'Claude plugins are off in a new profile (LKM-138)'
  )
  assert.equal(
    initial.values.agentFileAccess,
    'full',
    'Agents have full file access in a new profile (LKM-163)'
  )
  assert.equal(initial.values.agentGitAccess, 'managed', 'Agent Git access defaults to Managed')
  assert.equal(initial.values.agentMerge, 'true', 'Agent PR merging defaults to on')
  assert.equal(initial.values.autoFixCI, 'ask', 'CI repair defaults to Ask')
  // LKM-143: General shows the version stamped into this build, as `trezi --version` prints it.
  assert.match(
    initial.values.version ?? '',
    /^Trezi \d+\.\d+\.\d+\S* \(build \d+, [0-9a-f]{7,}\)$/,
    'General shows the built version'
  )
  assertSidebarParity(initial.sourceList, projects)
  writeFileSync(
    join(artifacts, 'settings-sidebar-parity.json'),
    JSON.stringify({ settings: initial.sourceList, projects }, null, 2)
  )
  // Arrow keys in the focused outline move through the sections; the pane and title follow.
  record({ action: 'opened', sidebarFocused: initial.sidebarFocused })
  for (const [key, section] of [
    ['down', 'providers'],
    ['down', 'experimental'],
    ['up', 'providers'],
    ['up', 'general']
  ] as const) {
    await host.request('settingsVerification', { key })
    const label = SETTINGS_SECTIONS.find((s) => s.id === section)?.label
    await wait(async () => {
      const state = await inspect()
      return state.section === section && state.windowTitle === label
    })
    record({ action: 'arrow-key', key, section, state: await inspect() })
  }
  // General and AI Providers at the minimum and default sizes.
  for (const width of [minimumWidth, SETTINGS_DEFAULT_SIZE.width]) {
    for (const section of ['general', 'providers'] as const) {
      await select(section)
      assertSectionEvidence(await shoot(width, section), width, section)
    }
  }
  // LKM-138: the Claude plugins toggle autosaves and survives close/reopen, then goes back off.
  await select('general')
  await choose('claudePlugins', 'true')
  await reopen()
  assert.equal((await inspect()).values.claudePlugins, 'true')
  await choose('claudePlugins', 'false')
  await reopen()
  // LKM-163: Agent file access autosaves and survives close/reopen, then goes back to Full access.
  await choose('agentFileAccess', 'project')
  await reopen()
  assert.equal((await inspect()).values.agentFileAccess, 'project')
  await choose('agentFileAccess', 'full')
  await reopen()
  // Agent Git access autosaves and survives close/reopen, then returns to Managed.
  await choose('agentGitAccess', 'full')
  await reopen()
  assert.equal((await inspect()).values.agentGitAccess, 'full')
  await choose('agentGitAccess', 'managed')
  await reopen()
  await choose('agentMerge', 'false')
  await reopen()
  assert.equal((await inspect()).values.agentMerge, 'false')
  await choose('agentMerge', 'true')
  await reopen()
  // LKM-152: Show Activity automatically defaults to problems that need the user and persists.
  assert.equal(
    initial.values.activityAutoOpen,
    'problems',
    'Show Activity automatically defaults to For problems that need me'
  )
  await choose('activityAutoOpen', 'never')
  await reopen()
  assert.equal((await inspect()).values.activityAutoOpen, 'never')
  await choose('activityAutoOpen', 'problems')
  await reopen()
  // LKM-221: the quit alert's "Don't ask again" shows here, defaults to asking and persists.
  assert.equal(initial.values.quitDontAsk, 'false', 'Quit while agents work defaults to Ask first')
  await choose('quitDontAsk', 'true')
  await reopen()
  assert.equal((await inspect()).values.quitDontAsk, 'true')
  await choose('quitDontAsk', 'false')
  await reopen()
  await select('experimental')
  for (const width of widths) {
    await capture(width, 'off', false, 'agent')
    await choose('projectUi', 'true')
    await capture(width, 'on-chat', true, 'agent')
    await choose('engine', 'jev')
    await capture(width, 'on-jev', true, 'jev')
    await choose('projectUi', 'false')
    await capture(width, 'off-preserved-jev', false, 'jev')
    await reopen()
    await capture(width, 'reopened-off-jev', false, 'jev')
    await choose('projectUi', 'true')
    await capture(width, 'restored-on-jev', true, 'jev')
    await choose('engine', 'agent')
    // Close immediately after the control action: do not wait for a saved message.
    await reopen()
    await capture(width, 'reopened-on-chat', true, 'agent')
    await choose('projectUi', 'false')
    await reopen()
    await capture(width, 'reopened-off-chat', false, 'agent')
  }
  // Leave the next Settings open on General, as a new profile would.
  await select('general')
  console.log(
    `NATIVE SETTINGS PASS — sidebar sections General/AI Providers at ${minimumWidth}/${SETTINGS_DEFAULT_SIZE.width} and Experimental at ${widths.join('/')} point foreground captures with complete help OCR; native Off/On/Chat/Jev picker actions; hidden-engine preservation, remembered section and close/reopen autosave. Inspect settings-visible-*.png for visual acceptance.`
  )
}

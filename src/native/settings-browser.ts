import {
  BROWSER_TOOL_COMMANDS,
  BROWSER_TOOL_LINKS,
  CLI_VERSION,
  PLAYWRIGHT_NODE_MAJOR,
  PLAYWRIGHT_VERSION
} from '../../bin/trezi-browser-tools.mjs'
import {
  BROWSER_TOOL_NAMES,
  type BrowserSetup,
  type BrowserSetupStatus,
  type ChromiumState
} from '../main/browser-setup'
import type { BrowserToolStep } from '../main/platform-owner'
import type { NativeSheetField, NativeSheetState } from '../shared/native-sheet'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LOCAL-WEBKIT-4: Settings → Browser Checks. Built-in WebKit is always listed as available;
 * the cross-browser Chromium checks show their own state, the two tools they need (version,
 * path, what each enables), copyable Terminal commands, official links, and Install / Cancel
 * / Check Again buttons. Every install and check starts only from a press here and runs in
 * the background, so Cancel stays pressable; the pane redraws as progress arrives.
 */

type Sheet = NonNullable<NativeSheetController['current']>
type Action = NativeSheetState['actions'][number]
export const BROWSER_SECTION = 'browser'
const decorated = new WeakSet<Sheet>()

/** The app's setup model and its running install or check, for the native smoke. */
export const nativeBrowserSetup: { current: BrowserSetup | null; running: Promise<unknown> } = {
  current: null,
  running: Promise.resolve()
}

export const CHROMIUM_STATE_LABELS: Record<ChromiumState, string> = {
  unavailable: 'Not installed',
  partial: 'Partly installed',
  unsupported: 'Unsupported',
  unchecked: 'Not checked yet',
  checking: 'Checking…',
  installing: 'Installing…',
  ready: 'Ready',
  failed: 'Check failed'
}

const LINKS: Record<string, string> = {
  'browser-link-agent-browser': BROWSER_TOOL_LINKS.agentBrowser,
  'browser-link-playwright': BROWSER_TOOL_LINKS.playwrightBrowsers,
  'browser-link-registry': BROWSER_TOOL_LINKS.playwrightRegistry,
  'browser-link-npx': BROWSER_TOOL_LINKS.npx,
  'browser-link-node': BROWSER_TOOL_LINKS.node,
  'browser-link-homebrew': BROWSER_TOOL_LINKS.homebrew
}
const SOURCES: Record<string, string> = {
  trezi: 'Trezi’s tools folder',
  path: 'your PATH',
  playwright: 'Playwright’s cache',
  test: 'test fixture'
}

const tilde = (path: string) => {
  const home = process.env.HOME ?? ''
  return home.length > 1 && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** The Install buttons' blockers: the missing prerequisite, or null when the press can run. */
export function installBlocker(status: BrowserSetupStatus, step: BrowserToolStep): string | null {
  const { prerequisites, platform } = status.detection
  if (!platform.ok) return platform.reason ?? 'Unsupported Mac.'
  if (step === 'cli' && !prerequisites.npm) return 'npm was not found. Install Node.js first.'
  if (step === 'shell') {
    if (!prerequisites.npx) return 'npx was not found. Install Node.js first.'
    const major = prerequisites.node?.major ?? 0
    if (major && major < PLAYWRIGHT_NODE_MAJOR)
      return `Playwright ${PLAYWRIGHT_VERSION} needs Node.js ${PLAYWRIGHT_NODE_MAJOR} or later (found ${major}).`
  }
  return null
}

export function browserPane(status: BrowserSetupStatus) {
  const { cli, shell, prerequisites } = status.detection
  const fields: NativeSheetField[] = []
  const row = (field: Omit<NativeSheetField, 'kind' | 'section'>) =>
    fields.push({ kind: 'readonly', section: BROWSER_SECTION, ...field })
  const actions: Action[] = []
  const nav = (id: string, label: string, extra: Partial<Action> = {}) =>
    actions.push({ id, label, ...extra })

  row({
    id: 'browserWebkit',
    label: 'Built-in WebKit',
    help: 'Trezi’s preview and preview_verify engine "webkit" are built in and need nothing installed.',
    value: 'Available'
  })
  row({
    id: 'browserChromium',
    label: 'Cross-browser Chromium checks',
    help: `${status.summary} Only preview_verify engine "chromium" needs them; everything else keeps working.`,
    value: CHROMIUM_STATE_LABELS[status.state]
  })
  if (status.check?.ok && status.check.browser)
    row({
      id: 'browserChecked',
      label: 'Last check',
      help: `${tilde(status.check.browser.shell)} (process ${status.check.browser.pid}), started privately through Trezi’s managed wrapper.`,
      value: new Date(status.check.at).toLocaleTimeString()
    })
  const install = status.install
  if (install)
    row({
      id: 'browserInstall',
      label: install.running
        ? `Installing the ${BROWSER_TOOL_NAMES[install.step]}…`
        : `Last install: ${BROWSER_TOOL_NAMES[install.step]}`,
      help:
        (install.running ? install.lines.slice(-3).join('\n') : install.error || install.done) ||
        'Starting…',
      value: install.running
        ? 'Running'
        : install.cancelled
          ? 'Cancelled'
          : install.error
            ? 'Failed'
            : 'Finished'
    })

  row({
    id: 'browserCli',
    group: 'agent-browser CLI',
    label: 'agent-browser',
    help: cli
      ? `${tilde(cli.path)} (from ${SOURCES[cli.source] ?? cli.source}). Drives the private headless Chromium. Trezi is tested with ${CLI_VERSION}.`
      : `Drives the private headless Chromium for engine "chromium". Trezi is tested with ${CLI_VERSION}; newer releases are not supported yet.`,
    value: cli
      ? `${cli.version ?? 'unknown version'}${cli.tested ? '' : ' (unsupported)'}`
      : 'Not installed'
  })
  row({
    id: 'browserCliCommand',
    group: 'agent-browser CLI',
    label: 'Install in Terminal',
    help: BROWSER_TOOL_COMMANDS.cli,
    value: '',
    action: 'browser-copy-cli',
    actionLabel: 'Copy'
  })
  nav('browser-copy-cli', 'Copy the agent-browser command', { copy: BROWSER_TOOL_COMMANDS.cli })
  row({
    id: 'browserCliDocs',
    group: 'agent-browser CLI',
    label: 'Official installation guide',
    help: `${BROWSER_TOOL_LINKS.agentBrowser}. Its own “agent-browser install” downloads Chrome for Testing, which Trezi does not use.`,
    value: '',
    action: 'browser-link-agent-browser'
  })
  nav('browser-link-agent-browser', 'Open the agent-browser installation guide')

  row({
    id: 'browserShell',
    group: 'Chromium headless shell',
    label: 'chrome-headless-shell',
    help: shell
      ? `${tilde(shell.path)} (from ${SOURCES[shell.source] ?? shell.source}). The only browser Trezi’s wrapper launches; never your Chrome.`
      : 'The dedicated headless Chromium the checks run in, kept apart from your Chrome and its profile.',
    value: shell
      ? (shell.version ?? (shell.revision ? `build ${shell.revision}` : 'Installed'))
      : 'Not installed'
  })
  row({
    id: 'browserShellCommand',
    group: 'Chromium headless shell',
    label: 'Install in Terminal',
    help: BROWSER_TOOL_COMMANDS.shell,
    value: '',
    action: 'browser-copy-shell',
    actionLabel: 'Copy'
  })
  nav('browser-copy-shell', 'Copy the headless shell command', {
    copy: BROWSER_TOOL_COMMANDS.shell
  })
  row({
    id: 'browserShellDocs',
    group: 'Chromium headless shell',
    label: 'Playwright browsers guide',
    help: BROWSER_TOOL_LINKS.playwrightBrowsers,
    value: '',
    action: 'browser-link-playwright'
  })
  nav('browser-link-playwright', 'Open the Playwright browsers guide')
  row({
    id: 'browserShellRegistry',
    group: 'Chromium headless shell',
    label: 'Which build Playwright installs',
    help: 'Playwright’s browser registry, on GitHub.',
    value: '',
    action: 'browser-link-registry'
  })
  nav('browser-link-registry', 'Open Playwright’s browser registry')

  const node = prerequisites.node
  row({
    id: 'browserNode',
    group: 'Needed by the quick installs',
    label: 'Node.js',
    help: node
      ? `${tilde(node.path)}. Install uses its npm and npx; Playwright ${PLAYWRIGHT_VERSION} needs Node.js ${PLAYWRIGHT_NODE_MAJOR} or later.`
      : `Not found. Install Node.js (it includes npm and npx) from ${BROWSER_TOOL_LINKS.node}.`,
    value: node ? (node.version ?? 'unknown version') : 'Not found',
    action: 'browser-link-node'
  })
  nav('browser-link-node', 'Open the Node.js download page')
  row({
    id: 'browserNpm',
    group: 'Needed by the quick installs',
    label: 'npm and npx',
    help: [
      prerequisites.npm ? tilde(prerequisites.npm) : 'npm not found',
      prerequisites.npx ? tilde(prerequisites.npx) : 'npx not found'
    ].join(' · '),
    value: prerequisites.npm && prerequisites.npx ? 'Found' : 'Not found',
    action: 'browser-link-npx'
  })
  nav('browser-link-npx', 'Open the npx documentation')
  row({
    id: 'browserBrew',
    group: 'Needed by the quick installs',
    label: 'Homebrew (optional)',
    help: prerequisites.brew
      ? `${tilde(prerequisites.brew)}. “brew install agent-browser” installs the newest release, which Trezi may not support yet.`
      : 'Not needed by the quick installs.',
    value: prerequisites.brew ? 'Found' : 'Not found',
    action: 'browser-link-homebrew'
  })
  nav('browser-link-homebrew', 'Open brew.sh')

  const busy = status.state === 'installing' || status.state === 'checking'
  const footer = (id: string, label: string, extra: Partial<Action> = {}) =>
    actions.push({ id, label, section: BROWSER_SECTION, ...extra })
  if (install?.running) footer('browser-cancel', 'Cancel Install', { destructive: true })
  if (!cli || !cli.tested)
    footer('browser-install-cli', 'Install agent-browser', {
      disabled: busy || !!installBlocker(status, 'cli')
    })
  // A shell that is present but reports no version, or failed the last check, is repaired
  // by installing it again into Trezi’s own cache (the same fixed command).
  const brokenShell = !!shell && (!shell.version || (!!status.check && !status.check.ok))
  if (!shell || brokenShell)
    footer('browser-install-shell', shell ? 'Repair Headless Shell' : 'Install Headless Shell', {
      disabled: busy || !!installBlocker(status, 'shell')
    })
  footer('browser-check', 'Check Again', { primary: true, disabled: busy })
  return { fields, actions }
}

/** The pane's message: an install's or a check's outcome, or why Install is unavailable. */
function message(status: BrowserSetupStatus): string | undefined {
  const { install, check } = status
  if (install?.running) return undefined
  if (install?.error) return install.error
  if (check) return check.message
  if (install?.done) return install.done
  if (status.state === 'unavailable' || status.state === 'partial')
    return installBlocker(status, status.detection.cli ? 'shell' : 'cli') ?? undefined
  return undefined
}

function show(sheets: NativeSheetController, sheet: Sheet, status: BrowserSetupStatus) {
  const next = browserPane(status)
  sheet.state.fields = [
    ...sheet.state.fields.filter((f) => f.section !== BROWSER_SECTION),
    ...next.fields
  ]
  sheet.state.actions = [
    ...sheet.state.actions.filter((a) => !a.id.startsWith('browser-')),
    ...next.actions
  ]
  if (sheet.state.section === BROWSER_SECTION) sheet.state.message = message(status)
  if (sheets.current === sheet) sheets.refresh()
}

/** Settings → Browser Checks on top of the Settings window, like the Dreamer pane. */
export function withBrowserPane(
  settings: NativeSettingsController,
  setup: BrowserSetup,
  openLink: (url: string) => Promise<void>
) {
  nativeBrowserSetup.current = setup
  const open = settings.open.bind(settings)
  settings.open = async () => {
    await open()
    const sheets = settings.sheets,
      sheet = sheets.current
    if (
      !sheet ||
      decorated.has(sheet) ||
      !sheet.state.sections?.some((s) => s.id === BROWSER_SECTION)
    )
      return
    decorated.add(sheet)
    const redraw = () => {
      if (sheets.current === sheet) show(sheets, sheet, setup.status())
      else stop()
    }
    const stop = setup.onChange(redraw)
    const detect = () => {
      if (setup.busy) return
      nativeBrowserSetup.running = setup.refresh().then(redraw, redraw)
    }
    const background = (work: Promise<unknown>) => {
      nativeBrowserSetup.running = work
        .catch((error) => {
          if (sheets.current === sheet) sheet.state.message = String(error?.message ?? error)
        })
        .finally(redraw)
    }
    const handle = sheet.handle
    sheet.handle = async (action) => {
      const id = action.action
      if (!id.startsWith('browser-')) return handle(action)
      if (id in LINKS) return openLink(LINKS[id])
      if (id === 'browser-copy-cli' || id === 'browser-copy-shell') {
        sheet.state.message = 'Copied. Paste it into Terminal.'
        return
      }
      if (id === 'browser-cancel') {
        await setup.cancelInstall()
        return
      }
      if (id === 'browser-check') return background(setup.recheck())
      if (id === 'browser-install-cli' || id === 'browser-install-shell')
        return background(setup.installTool(id === 'browser-install-cli' ? 'cli' : 'shell'))
    }
    const select = sheet.select
    sheet.select = (section) => {
      select?.(section)
      if (section === BROWSER_SECTION) detect()
    }
    show(sheets, sheet, setup.status())
    detect()
  }
  return settings
}

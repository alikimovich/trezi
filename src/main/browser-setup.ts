import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  type BrowserToolsDetection,
  CLI_SERIES,
  CLI_VERSION,
  detectBrowserTools
} from '../../bin/trezi-browser-tools.mjs'
import { managedBrowserWrapper } from './backends/managed-browser-path'
import { cleanupNote, stopOwnedSession } from './browser-setup-cleanup'
import { cliDependency, cliScalar, parseCliJson, runManagedCli } from './managed-browser-cli'
import {
  type BrowserToolStep,
  PlatformError,
  type PlatformOwner,
  platformOwner
} from './platform-owner'

/**
 * LOCAL-WEBKIT-4: Settings → Browser Checks. Built-in WebKit checks need nothing external;
 * engine "chromium" needs the Vercel agent-browser CLI and the dedicated Chromium headless
 * shell, both run only through Trezi's managed wrapper. This tells the two apart:
 * - detection: what is installed, where, which versions, and what a quick install needs;
 * - installs: only when the user presses Install, run by the Swift platform owner;
 * - Ready: only after a real launch check of the tools found now (`checkBrowserTools`),
 *   in memory, and forgotten when any of them changes or an install starts.
 * Nothing here installs at startup or because an agent asked for a browser.
 */

export type ChromiumState =
  | 'unavailable'
  | 'partial'
  | 'unsupported'
  | 'unchecked'
  | 'checking'
  | 'installing'
  | 'ready'
  | 'failed'

export const BROWSER_TOOL_NAMES: Record<BrowserToolStep, string> = {
  cli: 'agent-browser CLI',
  shell: 'Chromium headless shell'
}

export interface BrowserCheck {
  ok: boolean
  message: string
  /** What the check launched: the wrapper's CLI and shell, and the fresh browser's pid. */
  browser?: { cli: string; shell: string; pid: number }
}

export interface BrowserInstall {
  step: BrowserToolStep
  running: boolean
  /** Redacted progress lines from the service, the last `MAX_LINES`. */
  lines: string[]
  error?: string
  cancelled?: boolean
  done?: string
}

export interface BrowserSetupStatus {
  webkit: 'available'
  state: ChromiumState
  summary: string
  detection: BrowserToolsDetection
  wrapper?: string
  check?: BrowserCheck & { at: number }
  install?: BrowserInstall
}

type Env = Record<string, string | undefined>
const MAX_LINES = 40
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** `home` (and its real path, e.g. /private/var/… for /var/…) as `~`, only where a path starts. */
export const shortenHome = (line: string, home: string) => {
  if (home.length <= 1) return line
  let real = home
  try {
    real = realpathSync(home)
  } catch {}
  for (const form of [...new Set([real, home])].sort((a, b) => b.length - a.length)) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    line = line.replace(new RegExp(`(^|[\\s('"])${escaped}(?=[/\\s)'"]|$)`, 'g'), '$1~')
  }
  return line
}
const clip = (text: string, home: string) =>
  shortenHome(text.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300), home)

/** Fresh processes of this user (`ps`), as pid and full command line. */
export function processList(): Promise<{ pid: number; command: string }[]> {
  return new Promise((done) =>
    execFile(
      '/bin/ps',
      ['-axww', '-o', 'pid=,command='],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) =>
        done(
          error
            ? []
            : stdout.split('\n').flatMap((line) => {
                const match = /^\s*(\d+)\s+(.*)$/.exec(line)
                return match ? [{ pid: Number(match[1]), command: match[2] }] : []
              })
        )
    )
  )
}

/** The wrapper's `setup:` line (only with TREZI_BROWSER_SETUP_REPORT=1, only for `open`). */
export function setupReport(stderr: string): { cli: string; shell: string; base: string } | null {
  const match = /Trezi agent-browser: setup: (\{[^\n]*\})/.exec(stderr)
  if (!match) return null
  try {
    const value = JSON.parse(match[1])
    return typeof value.cli === 'string' &&
      typeof value.shell === 'string' &&
      typeof value.base === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

/**
 * One real launch through the managed wrapper, in a new private session from a new folder:
 * `open about:blank`, confirm a headless shell process for exactly this session's private
 * folder is running from the shell found here (so an older daemon's browser never counts),
 * `get url`, then `close`. Passing is the only way to Ready.
 */
export async function checkBrowserTools(options: {
  wrapper: string
  cli: string
  shell: string
  env?: Env
  home?: string
  timeoutMs?: number
  ps?: typeof processList
}): Promise<BrowserCheck> {
  const { wrapper, cli, shell, env = process.env, home = homedir(), ps = processList } = options
  const timeoutMs = options.timeoutMs ?? 60_000
  const session = `trezi-setup-${randomBytes(6).toString('hex')}`
  const cwd = mkdtempSync(join(tmpdir(), 'trezi-setup-'))
  const run = (args: string[], timeout: number) =>
    runManagedCli(wrapper, session, cwd, args, timeout, {
      ...env,
      TREZI_BROWSER_SETUP_REPORT: '1'
    })
  const fail = (message: string): BrowserCheck => ({ ok: false, message })
  let launched = false
  let owned: { shell: string; base: string } | undefined
  const launch = async (): Promise<BrowserCheck> => {
    const open = await run(['open', 'about:blank'], timeoutMs)
    const missing = cliDependency(open)
    if (missing) return fail(missing.message)
    if (open.code === 2)
      return fail(`Trezi's managed wrapper refused the check: ${clip(open.stderr, home)}`)
    launched = true
    const report = setupReport(open.stderr)
    if (report) owned = { shell: report.shell, base: report.base }
    if (open.timedOut)
      return fail(`The private headless browser did not start within ${timeoutMs / 1000} seconds.`)
    const opened = parseCliJson(open.stdout)
    if (open.code !== 0 || !opened?.success)
      return fail(
        `agent-browser could not open a page (exit ${open.code ?? 'none'}): ${clip(opened?.error || open.stderr || open.stdout, home) || 'no output'}`
      )
    if (!report) return fail('Trezi’s managed wrapper did not report which browser it launched.')
    if (report.cli !== cli || report.shell !== shell)
      return fail(
        `The managed wrapper used ${clip(report.shell, home)} with ${clip(report.cli, home)}, not the tools found now. Check again.`
      )
    const fresh = (await ps()).find(
      (entry) =>
        entry.command.startsWith(`${report.shell} `) &&
        entry.command.includes(basename(report.base))
    )
    if (!fresh)
      return fail(
        'agent-browser answered, but no headless shell was started for this check. An older agent-browser daemon may still be running another browser; quit it (agent-browser close --all in Terminal) and check again.'
      )
    const url = await run(['get', 'url'], 20_000)
    // A nonzero exit or a timeout is a failure even when the output looks like success.
    if (url.timedOut || url.code !== 0)
      return fail(
        `The private browser started but its page request ${url.timedOut ? 'timed out' : `failed (exit ${url.code ?? 'none'})`}: ${clip(url.stderr || url.stdout, home) || 'no output'}`
      )
    const answer = parseCliJson(url.stdout)
    const value = answer?.success ? cliScalar(answer.data, ['url']) : undefined
    if (typeof value !== 'string' || !value.startsWith('about:blank'))
      return fail(
        `The private browser started but did not report its page: ${clip(answer?.error || url.stderr || url.stdout, home) || 'no answer'}`
      )
    return {
      ok: true,
      message: 'A private headless Chromium started through Trezi’s managed wrapper and answered.',
      browser: { cli: report.cli, shell: report.shell, pid: fresh.pid }
    }
  }
  let outcome: BrowserCheck
  try {
    outcome = await launch()
  } catch (error) {
    outcome = fail(describe(error))
  }
  if (launched) {
    const closed = await run(['close'], 20_000).catch(() => undefined)
    const closedOk =
      !!closed &&
      !closed.timedOut &&
      closed.code === 0 &&
      parseCliJson(closed.stdout)?.success !== false
    if (!closedOk) {
      // The private browser may still be running: stop what this check started and say
      // exactly what that did. A session that would not close is never Ready.
      const cleanup = await stopOwnedSession(owned, ps)
      const note = cleanupNote(cleanup, clip(owned?.base ?? '', home))
      const why = `closing it failed${closed?.timedOut ? ' (timed out)' : closed?.code ? ` (exit ${closed.code})` : ''}: ${clip(closed?.stderr || closed?.stdout || '', home) || 'no output'}`
      outcome = outcome.ok
        ? fail(`The private browser answered, but ${why}. ${note} Chromium checks are not Ready.`)
        : { ...outcome, message: `${outcome.message} Also ${why}. ${note}` }
    }
  }
  rmSync(cwd, { recursive: true, force: true })
  return outcome
}

/** dev, inode, size and times of the file a tool path resolves to: a replaced binary differs. */
export function toolIdentity(path: string | undefined): string {
  if (!path) return ''
  try {
    const stat = statSync(path)
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
  } catch {
    return 'missing'
  }
}

/** What a check is about: both tools' paths, versions and executable identity. */
const fingerprint = (d: BrowserToolsDetection) =>
  [
    d.cli?.path,
    d.cli?.version,
    toolIdentity(d.cli?.path),
    d.shell?.path,
    d.shell?.version,
    toolIdentity(d.shell?.path)
  ].join('|')

/** The state and its one-line summary; WebKit is never part of it. */
export function chromiumState(
  detection: BrowserToolsDetection,
  context: {
    wrapper?: string
    checking?: boolean
    install?: BrowserInstall
    check?: BrowserCheck & { fingerprint: string }
  }
): { state: ChromiumState; summary: string } {
  const { cli, shell, platform } = detection
  if (!platform.ok) return { state: 'unsupported', summary: platform.reason ?? 'Unsupported Mac.' }
  if (context.install?.running)
    return {
      state: 'installing',
      summary: `Installing the ${BROWSER_TOOL_NAMES[context.install.step]}…`
    }
  if (context.checking)
    return { state: 'checking', summary: 'Checking: starting a private headless Chromium…' }
  if (!cli && !shell)
    return {
      state: 'unavailable',
      summary:
        'Not installed. Chromium checks need the agent-browser CLI and the Chromium headless shell.'
    }
  if (!cli || !shell)
    return {
      state: 'partial',
      summary: `Partly installed: the ${!cli ? BROWSER_TOOL_NAMES.cli : BROWSER_TOOL_NAMES.shell} is missing.`
    }
  if (!cli.version)
    return {
      state: 'unsupported',
      summary: 'The agent-browser CLI found did not report its version.'
    }
  if (!cli.tested)
    return {
      state: 'unsupported',
      summary: `agent-browser ${cli.version} is not supported yet: Trezi is tested with ${CLI_SERIES}.x (${CLI_VERSION}).`
    }
  if (!shell.version)
    return {
      state: 'failed',
      summary:
        'The Chromium headless shell found did not report its version, so it looks broken or incomplete. Repair it to install it again.'
    }
  if (!context.wrapper)
    return {
      state: 'failed',
      summary: 'Trezi’s managed agent-browser wrapper is missing from this build. Rebuild Trezi.'
    }
  const check = context.check
  if (check && check.fingerprint === fingerprint(detection))
    return check.ok
      ? { state: 'ready', summary: 'Ready: the last check started a private headless Chromium.' }
      : {
          state: 'failed',
          summary: 'The last check did not pass, so Chromium checks are not Ready.'
        }
  return {
    state: 'unchecked',
    summary:
      'Both are installed but not checked yet. Check Again starts a private headless Chromium once.'
  }
}

/** Detection, installs and checks for Settings; one per app (`browserSetup`). */
export class BrowserSetup {
  private detection: BrowserToolsDetection | null = null
  private check?: BrowserCheck & { at: number; fingerprint: string }
  private install?: BrowserInstall
  private checking = false
  private subscribed: PlatformOwner | null = null
  private listeners = new Set<() => void>()
  /** A native smoke's private HOME and PATH (fake tools); never set by the app itself. */
  private fixture: { env: Env; home: string } | null = null

  constructor(
    private readonly options: {
      owner?: () => PlatformOwner
      wrapper?: () => string | undefined
      ps?: typeof processList
      timeoutMs?: number
    } = {}
  ) {}

  private get env(): Env {
    return this.fixture?.env ?? process.env
  }
  private get home() {
    return this.fixture?.home ?? homedir()
  }
  private wrapper() {
    return (this.options.wrapper ?? (() => managedBrowserWrapper(__dirname)))()
  }
  private owner() {
    return (this.options.owner ?? platformOwner)()
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }

  /** Test only: detect and check with this HOME and environment; null restores the app's. */
  setFixture(fixture: { env: Env; home: string } | null) {
    this.fixture = fixture
    this.check = undefined
    this.install = undefined
    this.detection = null
  }

  /** Detects again (bounded `--version` calls, nothing installed or launched). */
  async refresh(): Promise<BrowserSetupStatus> {
    const wrapper = this.wrapper()
    this.detection = await detectBrowserTools({
      env: this.env,
      home: this.home,
      skip: wrapper ? [dirname(wrapper)] : []
    })
    return this.status()
  }

  /** The last detection's status; `refresh` first when there is none. */
  status(): BrowserSetupStatus {
    const detection = this.detection ?? {
      tools: '',
      platform: { ok: true },
      prerequisites: {}
    }
    const wrapper = this.wrapper()
    const { state, summary } = chromiumState(detection, {
      wrapper,
      checking: this.checking,
      install: this.install,
      check: this.check
    })
    const check = this.check
    return {
      webkit: 'available',
      state,
      summary,
      detection,
      ...(wrapper ? { wrapper } : {}),
      ...(check && check.fingerprint === fingerprint(detection) ? { check } : {}),
      ...(this.install ? { install: this.install } : {})
    }
  }

  get busy() {
    return this.checking || !!this.install?.running
  }

  /** Check Again: detect, then one launch check of what was found. Never Ready on failure. */
  async recheck(): Promise<BrowserSetupStatus> {
    if (this.busy) throw new Error('Wait for the running install or check to finish.')
    this.checking = true
    this.check = undefined
    this.changed()
    try {
      const status = await this.refresh()
      const { cli, shell } = status.detection
      // Only found, tested tools are launched; otherwise the state already says why not.
      const launchable =
        chromiumState(status.detection, { wrapper: status.wrapper }).state === 'unchecked'
      if (launchable && cli && shell && status.wrapper) {
        // Identity is taken before the launch: the check is about these exact executables.
        const before = fingerprint(status.detection)
        let result = await checkBrowserTools({
          wrapper: status.wrapper,
          cli: cli.path,
          shell: shell.path,
          env: this.env,
          home: this.home,
          ps: this.options.ps,
          timeoutMs: this.options.timeoutMs
        })
        // A tool replaced while the check ran may not be the one that was launched.
        if (fingerprint(status.detection) !== before)
          result = {
            ok: false,
            message:
              'The agent-browser CLI or the headless shell changed while it was being checked, so the result does not describe it. Check again.'
          }
        // The check is about what was found before it ran; a change since is unchecked.
        this.check = { ...result, at: Date.now(), fingerprint: before }
        await this.refresh()
      }
    } finally {
      this.checking = false
      this.changed()
    }
    return this.status()
  }

  /**
   * Install (only on the user's press): the service runs the fixed command; the result is
   * then detected again and, when both tools are found, checked. A failed or cancelled
   * install never leaves Ready behind.
   */
  async installTool(step: BrowserToolStep): Promise<BrowserSetupStatus> {
    if (this.busy) throw new Error('Wait for the running install or check to finish.')
    const owner = this.owner()
    if (this.subscribed !== owner) {
      this.subscribed = owner
      owner.onBrowserToolsProgress((from, line) => {
        if (this.subscribed !== owner || !this.install?.running || this.install.step !== from)
          return
        this.install.lines = [...this.install.lines, line].slice(-MAX_LINES)
        this.changed()
      })
    }
    this.check = undefined
    const install: BrowserInstall = { step, running: true, lines: [] }
    this.install = install
    this.changed()
    try {
      const result = await owner.browserToolsInstall(step)
      install.done = `Installed the ${BROWSER_TOOL_NAMES[step]} in Trezi’s tools folder (${clip(result.path, this.home)}).`
    } catch (error) {
      install.cancelled = error instanceof PlatformError && error.code === 'cancelled'
      install.error = describe(error)
    }
    // Busy until the result is detected: a settled install never shows the old detection.
    try {
      await this.refresh()
    } finally {
      install.running = false
      this.changed()
    }
    const status = this.status()
    if (!install.error && status.state === 'unchecked') return this.recheck()
    return status
  }

  /** Stops the running install's process group (the service answers whether one ran). */
  async cancelInstall(): Promise<boolean> {
    if (!this.install?.running) return false
    return this.owner().browserToolsCancel()
  }
}

export const browserSetup = new BrowserSetup()

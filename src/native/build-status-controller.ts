import { compareWithMain, hasNetwork, setCurrentBuildStatus } from '../main/build-status'
import { productLog } from '../main/product-log'
import {
  type BuildStamp,
  type BuildStatus,
  buildDetails,
  deriveBuildStatus,
  UPDATE_STEPS
} from '../shared/build-status'
import { buildStamp } from './app-version'
import type { NativeBridge } from './bridge'
import type { NativePreferences } from './preferences'
import type { NativeSheetController } from './sheets-runtime'

/** Settings → General → "Check whether this build is on main": 'off' turns the check off. */
export const BUILD_CHECK_KEY = 'trezi:build-check:v1'
export const BUILD_CHECK_INTERVAL_MS = 30 * 60_000
/** The first check waits for startup to settle; it never blocks it. */
export const BUILD_CHECK_DELAY_MS = 3_000

/** The running controller, for the native smoke (like `nativeDreamer`). */
export const nativeBuildStatus: { current: NativeBuildStatusController | null } = { current: null }

export interface BuildStatusDeps {
  stamp?: BuildStamp | null
  online?: () => boolean
  compare?: typeof compareWithMain
  now?: () => number
}

/**
 * LKM-226: the build badge's state. Local facts (dirty, branch, the Settings switch,
 * offline) need no network; otherwise origin main is read in the background at launch
 * and every 30 minutes. Each result goes to the host (`buildStatus`: the sidebar badge
 * and About Trezi) and to Copy Logs / the feedback diagnostics (`currentBuildStatus`).
 * Clicking the badge opens its details with the update steps when behind.
 */
export class NativeBuildStatusController {
  status: BuildStatus
  private running: Promise<BuildStatus> | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private readonly stamp: BuildStamp | null
  constructor(
    readonly host: Pick<NativeBridge, 'send'>,
    readonly preferences: Pick<NativePreferences, 'get'>,
    readonly sheets: NativeSheetController,
    readonly root: string,
    readonly openUpdates: () => void,
    readonly deps: BuildStatusDeps = {}
  ) {
    this.stamp = deps.stamp === undefined ? buildStamp() : deps.stamp
    this.status = this.derive(null, null)
  }
  get enabled() {
    return this.preferences.get(BUILD_CHECK_KEY) !== 'off'
  }
  private derive(
    comparison: Parameters<typeof deriveBuildStatus>[1]['comparison'],
    checkedAt: number | null
  ) {
    return deriveBuildStatus(this.stamp, {
      enabled: this.enabled,
      online: (this.deps.online ?? hasNetwork)(),
      comparison,
      checkedAt
    })
  }
  /** Shows the local state now, checks after a short delay, then every 30 minutes. */
  start() {
    this.publish(this.status)
    const first = setTimeout(() => void this.check(), BUILD_CHECK_DELAY_MS)
    const every = setInterval(() => void this.check(), BUILD_CHECK_INTERVAL_MS)
    first.unref?.()
    every.unref?.()
    this.timers.push(first, every)
  }
  stop() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }
  /** One check; a check already running is shared. Never throws. */
  check(): Promise<BuildStatus> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }
  private async run() {
    const now = this.deps.now ?? Date.now
    const local = this.derive(null, null)
    // Only a clean main build, with the check on and a network, asks GitHub.
    if (local.state !== 'unknown' || local.reason !== 'pending') {
      this.publish({ ...local, checkedAt: now() })
      return this.status
    }
    const comparison = await (this.deps.compare ?? compareWithMain)(
      this.root,
      this.stamp!.sha || this.stamp!.commit
    ).catch(() => null)
    this.publish(this.derive(comparison, now()))
    return this.status
  }
  /** Sends a state to the host; tests and the native smoke use it to show each badge state. */
  publish(status: BuildStatus) {
    const changed = status.state !== this.status.state || status.behind !== this.status.behind
    this.status = status
    setCurrentBuildStatus(status)
    this.host.send('buildStatus', { ...status, details: buildDetails(status) })
    if (changed || status.checkedAt === null)
      productLog.info('build', 'Build status', {
        state: status.state,
        behind: status.behind ?? undefined,
        reason: status.reason ?? undefined,
        commit: status.commit,
        branch: status.branch
      })
  }
  /** The badge's click: version, build, commit (copyable), branch, tag, check time; update steps when behind. */
  open() {
    const status = this.status
    const behind = status.state === 'behind'
    this.sheets.present(
      {
        title: behind ? 'A newer Trezi is on main' : 'This build of Trezi',
        detail: [...buildDetails(status), ...(behind ? ['', UPDATE_STEPS] : [])].join('\n'),
        fields: [],
        actions: [
          { id: 'cancel', label: 'Close', cancel: true },
          ...(status.commit
            ? [{ id: 'copy-commit', label: 'Copy Commit', copy: status.commit }]
            : []),
          ...(status.state === 'unknown' && status.reason === 'off'
            ? []
            : [{ id: 'check', label: 'Check Now' }]),
          ...(behind ? [{ id: 'update', label: 'Update…', primary: true }] : [])
        ]
      },
      async (action) => {
        if (action.action === 'update') return this.openUpdates()
        if (action.action === 'check') {
          await this.check()
          return this.open()
        }
        // The host already put the commit on the pasteboard (the action's `copy`).
        if (action.action === 'copy-commit' && this.sheets.current)
          this.sheets.current.state.message = `Copied ${status.commit}.`
      }
    )
  }
}

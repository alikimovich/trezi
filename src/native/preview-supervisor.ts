import type {
  NativeProjectStatus,
  NativeWorkspaceCommand,
  NativeWorkspaceSnapshot
} from '../shared/native-workspace'
import { projectKey } from '../shared/projectKey'

export interface SupervisedWorkspace {
  state: NativeWorkspaceSnapshot
  changed(): void
  command(command: NativeWorkspaceCommand): Promise<void>
}
export interface SupervisorClock {
  now(): number
  set(run: () => void, ms: number): unknown
  clear(timer: unknown): void
}
/** A ready server ended without a stop or restart (`devserver:exit`). */
export interface ServerExit {
  root: string
  url: string
  reason: string
}

/** Waits before each automatic restart; after the last one the user restarts. */
export const RESTART_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000]
/** A server that stayed up this long starts the backoff over when it next ends. */
export const STABLE_AFTER = 60_000

const realClock: SupervisorClock = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}

/**
 * Keeps the active project's preview alive (LKM-146). When its ready dev server
 * exits or stops answering (the runtime owner stops a hung one), the preview shows
 * the reason and a Restart button instead of going dead, and the server is restarted
 * with backoff. A failed restart waits longer; after `RESTART_DELAYS` it stops trying
 * and leaves Restart to the user. Anything else changing the status (a manual
 * restart, another project, a landing) cancels the pending attempt.
 */
export class NativePreviewSupervisor {
  private attempts = 0
  private timer: unknown = null
  /** The status this supervisor showed; any other means someone else took over. */
  private shown: NativeProjectStatus | null = null
  private upSince = 0
  /** Bumped by `reset`: a restart already under way no longer schedules the next. */
  private epoch = 0

  /** `gaveUp` hears the crash loop the user has to resolve (LKM-152: it may open Activity). */
  constructor(
    private readonly workspace: SupervisedWorkspace,
    private readonly clock: SupervisorClock = realClock,
    private readonly gaveUp: (reason: string) => void = () => {}
  ) {}

  exited({ root, url, reason }: ServerExit) {
    const { state } = this.workspace,
      key = projectKey(root)
    if (state.activeKey !== key || state.status.kind !== 'running' || state.status.url !== url)
      return
    if (this.clock.now() - this.upSince >= STABLE_AFTER) this.attempts = 0
    this.schedule(key, reason)
  }

  /** The user's Restart: the automatic one is no longer pending and backoff starts over. */
  reset() {
    if (this.timer !== null) this.clock.clear(this.timer)
    this.timer = null
    this.shown = null
    this.attempts = 0
    this.epoch++
  }

  private schedule(key: string, reason: string) {
    if (this.timer !== null) this.clock.clear(this.timer)
    this.timer = null
    const delay = RESTART_DELAYS[this.attempts]
    const message =
      delay === undefined
        ? `${reason}\n\nTrezi restarted it ${RESTART_DELAYS.length} times without success. Use Restart to try again.`
        : `${reason}\n\nRestarting in ${delay / 1000} s…`
    this.show({ kind: 'error', message, restart: true })
    if (delay === undefined) {
      this.attempts = 0
      this.shown = null
      this.gaveUp(reason)
      return
    }
    this.attempts++
    this.timer = this.clock.set(() => {
      void this.restart(key)
    }, delay)
  }

  private show(status: NativeProjectStatus) {
    this.shown = status
    this.workspace.state.status = status
    this.workspace.changed()
  }

  private async restart(key: string) {
    this.timer = null
    const { state } = this.workspace
    if (state.activeKey !== key || state.status !== this.shown) return
    this.shown = null
    const epoch = this.epoch
    await this.workspace.command({ type: 'restart', key }).catch(() => {})
    const status = this.workspace.state.status
    if (this.epoch !== epoch || this.workspace.state.activeKey !== key || this.timer !== null)
      return
    if (status.kind === 'running') this.upSince = this.clock.now()
    else if (status.kind === 'error' && !status.restart) this.schedule(key, status.message)
  }
}

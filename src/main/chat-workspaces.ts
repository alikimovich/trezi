import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  chatWorkspaceKeys,
  handleReclaimed,
  hasParkRecord,
  liveChatWorktreeIds,
  reclaimIdleWorkspace
} from './chat-isolation'
import { pruneOrphans, removeLegacyFolder } from './worktrees'

const execFileP = promisify(execFile)

/**
 * Chat workspace cleanup (LKM-136). Every open chat on a Git repository has a private
 * checkout under the profile's `worktrees/` folder (`chat-isolation.ts`). These grow
 * with every chat, so:
 *  - an idle sweep removes the checkout of a chat with no turn for the configured
 *    period (`reclaimIdleWorkspace`); the chat's next turn recreates it;
 *  - "Clean up now" in Settings runs the same sweep with no idle period;
 *  - leftover worktree folders of the earlier app names are emptied through orphan
 *    recovery once, then removed when nothing else is left in them.
 * The safety rules are the same everywhere: a parked, resolving or running chat is
 * never touched, and a checkout with uncommitted work stays, its work copied to a
 * recovery ref. Closing (archiving) a chat already removes its clean checkout
 * (`releaseChat`); deleting its history afterwards has no checkout left to remove.
 */

/** Preference: days without a turn before a chat's checkout is removed, or `never`. */
export const CHAT_WORKSPACE_IDLE_KEY = 'trezi:chat-workspace-idle-days:v1'
export const CHAT_WORKSPACE_IDLE_CHOICES = ['1', '3', '7', '14', '30', 'never'] as const
const DEFAULT_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

/** The idle period in milliseconds for a stored preference value; null turns the sweep off. */
export function idlePeriod(value: string | null | undefined): number | null {
  if (value === 'never') return null
  const days = (CHAT_WORKSPACE_IDLE_CHOICES as readonly string[]).includes(value ?? '')
    ? Number(value)
    : DEFAULT_DAYS
  return days * DAY
}

interface Deps {
  worktreesDir: () => string
  /** True while a chat has a turn running or being prepared. */
  busy: (sessionKey: string) => boolean
  /** Worktree folders of the earlier app names (see `legacyWorkspaceDirs`). */
  legacyDirs: () => string[]
}

let deps: Deps | null = null

/** Wired once from `registerAgentIpc`, next to `initChatIsolation`. */
export function initChatWorkspaces(d: Deps): void {
  deps = d
}

/** `<support>/Praxis/praxis/worktrees`, `<support>/dsgn/dsgn/worktrees` and the crossed
 *  pairs, beside the profile. The profile's own store is never one of them. */
export function legacyWorkspaceDirs(profile: string): string[] {
  let real = profile
  try {
    real = realpathSync(profile)
  } catch {
    /* a profile that does not exist yet */
  }
  const support = dirname(real)
  return ['Praxis', 'dsgn'].flatMap((app) =>
    ['praxis', 'dsgn'].map((name) => join(support, app, name, 'worktrees'))
  )
}

export interface SweepResult {
  removed: number
  keptDirty: number
  skipped: number
}

/** Remove the checkout of every open chat with no turn in the last `idleMs`. Never throws. */
export async function sweepIdleWorkspaces(idleMs: number, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, keptDirty: 0, skipped: 0 }
  if (!deps) return result
  for (const key of chatWorkspaceKeys()) {
    const outcome = await reclaimIdleWorkspace(key, now - idleMs, deps.busy)
    if (outcome === 'removed') result.removed++
    else if (outcome === 'kept-dirty') result.keptDirty++
    else result.skipped++
  }
  return result
}

/** Disk used by the chat workspaces, old-name folders included. `du` counts linked
 *  `node_modules` as links, not as their targets. */
export async function workspaceUsage(): Promise<{ bytes: number; workspaces: number }> {
  if (!deps) return { bytes: 0, workspaces: 0 }
  let kilobytes = 0
  let workspaces = 0
  for (const dir of [deps.worktreesDir(), ...deps.legacyDirs()]) {
    const entries = await readdir(dir).catch(() => null)
    if (!entries) continue
    workspaces += entries.filter((name) => !name.startsWith('.')).length
    const out = await execFileP('du', ['-sk', dir], { timeout: 120_000 }).then(
      (r) => r.stdout,
      (error: { stdout?: string }) => error.stdout ?? ''
    )
    kilobytes += Number(out.trim().split(/\s/)[0]) || 0
  }
  return { bytes: kilobytes * 1024, workspaces }
}

/**
 * Empty the old-name worktree folders through orphan recovery (each checkout's work is
 * committed to its branch or a recovery ref first; a crashed chat gets a recovery
 * record), then have the service remove each folder, and its old-name parent, once
 * nothing but a `.DS_Store` is left. A folder that still holds anything else (an
 * unknown checkout, a moved-aside copy) stays. Never throws.
 */
export async function cleanLegacyWorkspaces(): Promise<{ removed: string[]; kept: string[] }> {
  const result = { removed: [] as string[], kept: [] as string[] }
  if (!deps) return result
  const live = await realpath(deps.worktreesDir()).catch(() => deps!.worktreesDir())
  for (const dir of deps.legacyDirs()) {
    const real = await realpath(dir).catch(() => null)
    if (!real || real === live) continue
    const repos = new Set<string>()
    for (const id of await readdir(real).catch(() => [] as string[])) {
      if (id.startsWith('.')) continue
      const common = await execFileP(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        {
          cwd: join(real, id),
          timeout: 15_000
        }
      ).then(
        (r) => r.stdout.trim(),
        () => ''
      )
      if (common) repos.add(dirname(common))
    }
    for (const repo of repos) {
      await handleReclaimed(
        await pruneOrphans(repo, real, new Set(liveChatWorktreeIds()), hasParkRecord)
      )
    }
    if (await removeLegacyFolder(real)) result.removed.push(dir)
    else result.kept.push(dir)
  }
  return result
}

/** Settings' "Clean up now": the idle sweep with no idle period, then the old-name
 *  folders, under the same safety rules. Returns what was done and the new usage. */
export async function cleanUpWorkspacesNow(): Promise<
  SweepResult & { legacyRemoved: number; usage: { bytes: number; workspaces: number } }
> {
  const swept = await sweepIdleWorkspaces(0)
  const legacy = await cleanLegacyWorkspaces()
  return { ...swept, legacyRemoved: legacy.removed.length, usage: await workspaceUsage() }
}

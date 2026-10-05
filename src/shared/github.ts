/**
 * Pure helpers for "Connect to GitHub" (the first-publish bridge). Kept in
 * shared/ so the renderer can sanitize the repo-name field as the user types and
 * the main process + unit tests can reuse the branch-planning logic — no
 * `child_process`/Electron imports here.
 */

/** State of the opened project's GitHub link, for the header + connect sheet. */
export interface GithubStatus {
  /** True once an `origin` remote exists. */
  connected: boolean
  /** The origin URL when connected. */
  remoteUrl?: string
  /** Whether the `gh` CLI is usable: installed + authenticated, or why not. */
  gh: 'ok' | 'missing' | 'unauthed'
  /** The authenticated gh login (personal account), when `gh: 'ok'`. */
  login?: string
  /** Orgs the login can create repos in, for the owner dropdown. */
  orgs?: string[]
  /** A GitHub-legal repo name derived from the folder, prefilled into the sheet. */
  suggestedName: string
}

export interface GithubConnectOptions {
  /** Repo name (already sanitized by the sheet, re-sanitized in main). */
  name: string
  /** Owner: the personal login or one of `orgs`. */
  owner: string
  /** Private by default; the sheet toggles this. */
  private: boolean
}

export interface GithubConnectResult {
  ok: boolean
  /** The created repo's URL on success. */
  url?: string
  error?: string
}

const TREZI_PREFIX = 'trezi/'

/**
 * Coerce a folder name into a valid GitHub repo name: lowercase, only
 * `[a-z0-9._-]`, no leading/trailing/repeated separators, capped at 100 chars.
 * Empty input (or input that sanitizes to nothing) falls back to `my-app`.
 */
export function sanitizeRepoName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 100)
    .replace(/[-._]+$/g, '')
  return name || 'my-app'
}

/** What `github:connect` should do with branches, given the current checkout. */
export interface ConnectPlan {
  /** The branch to push and set as GitHub's default. */
  defaultBranch: string
  /** Fast-forward `defaultBranch` to `current` before pushing (Option B: the
   *  repo's default branch reflects the built work, not the bare scaffold). */
  fastForwardBase: boolean
  /** Branches to `push -u origin`, in order; `defaultBranch` is always first. */
  pushBranches: string[]
}

/**
 * Decide the push plan for Connect. A trezi work branch (`trezi/main`) maps to
 * its clean base (`main`): when the base is an ancestor of the work branch (the
 * scaffold case), fast-forward the base up to the work and push both, so the
 * repo's default branch already shows what the user built. If the base has
 * diverged (an existing repo opened without a remote) we can't fast-forward, so
 * the work branch itself becomes the default. A non-work branch just publishes
 * itself.
 */
export function resolveConnectPlan(current: string, baseIsAncestor: boolean): ConnectPlan {
  if (!current.startsWith(TREZI_PREFIX) && !current.startsWith('praxis/')) {
    return { defaultBranch: current, fastForwardBase: false, pushBranches: [current] }
  }
  const base = current.replace(/^(trezi|praxis)\//, '') || 'main'
  if (baseIsAncestor) {
    return { defaultBranch: base, fastForwardBase: true, pushBranches: [base, current] }
  }
  return { defaultBranch: current, fastForwardBase: false, pushBranches: [current] }
}

/** Resolve the same legacy/current base before performing the ancestry probe. */
export async function planGitHubConnection(
  current: string,
  isAncestor: (base: string, branch: string) => Promise<boolean>
): Promise<ConnectPlan> {
  const base = /^(trezi|praxis)\//.test(current)
    ? current.replace(/^(trezi|praxis)\//, '') || 'main'
    : current
  const ancestor = base !== current && (await isAncestor(base, current))
  return resolveConnectPlan(current, ancestor)
}

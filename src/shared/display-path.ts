/**
 * The one formatter for paths shown to the user (chat tool rows, the live activity
 * label, chat cards, Activity and preview notifications). The collapsed form names a
 * file by its project-relative path, and an internal location by what it is; the
 * full text stays in expanded rows, Copy and tooltips. Logs and the ledger never
 * go through it. A path is shortened whole or not at all, never cut mid-path.
 */
export interface PathContext {
  /** Project roots (live checkouts), absolute. */
  projects: string[]
  /** Trezi profile roots, absolute: the profile, its physical target and older profiles. */
  profiles: string[]
}

export const CHAT_WORKSPACE = 'chat workspace'
export const TREZI_DATA = 'Trezi data'
export const TEMPORARY_PATCH = 'temporary patch'
export const RECOVERY_COPY = 'recovery copy'

// Inside a profile: the session store (current or earlier name) holds the chat worktrees.
const WORKTREE = /^(?:trezi|praxis|dsgn)\/worktrees\/[^/]+(?:\/(.*))?$/
const SCRATCH = /^service\/repository\/scratch(?:\/|$)/
// A path ends at whitespace, a quote or bracket, or list punctuation.
const END = /[\s"'`<>()[\]{},;]/
// Sentence punctuation after a ref is not part of it.
const RECOVERY = /refs\/(?:trezi|praxis)\/recovery\/(?:[^\s"'`<>()[\]{},;]*[^\s"'`<>()[\]{},;.:])?/g
const PATH_CHAR = /[\w./~-]/

interface Root {
  root: string
  kind: 'project' | 'profile'
}

function roots(ctx: PathContext): Root[] {
  const seen = new Set<string>()
  const list: Root[] = []
  // A profile wins over a project at the same path; longer roots win over their parents.
  for (const [kind, paths] of [
    ['profile', ctx.profiles],
    ['project', ctx.projects]
  ] as const)
    for (const raw of paths) {
      const root = raw.replace(/\/+$/, '')
      if (!root.startsWith('/') || seen.has(root)) continue
      seen.add(root)
      list.push({ root, kind })
    }
  return list.sort((a, b) => b.root.length - a.root.length)
}

function label({ root, kind }: Root, rest: string): string {
  if (kind === 'project') return rest || root.slice(root.lastIndexOf('/') + 1)
  const worktree = WORKTREE.exec(rest)
  if (worktree) return worktree[1] || CHAT_WORKSPACE
  if (SCRATCH.test(rest)) return TEMPORARY_PATCH
  return TREZI_DATA
}

/** One path: its collapsed form, or the path unchanged when it is not a known location. */
export function shortPath(path: string, ctx: PathContext): string {
  if (/^refs\/(?:trezi|praxis)\/recovery\//.test(path)) return RECOVERY_COPY
  for (const entry of roots(ctx)) {
    if (path === entry.root) return label(entry, '')
    if (path.startsWith(`${entry.root}/`))
      return label(entry, path.slice(entry.root.length + 1).replace(/\/+$/, ''))
  }
  return path
}

/** Free text: every known path and recovery ref in it collapsed; everything else unchanged. */
export function shortPaths(text: string, ctx: PathContext): string {
  if (!text) return text
  let out = text.replace(RECOVERY, RECOVERY_COPY)
  for (const entry of roots(ctx)) {
    const { root } = entry
    let at = out.indexOf(root)
    while (at >= 0) {
      const after = at + root.length
      const boundary =
        (at === 0 || !PATH_CHAR.test(out[at - 1])) &&
        (after === out.length ||
          out[after] === '/' ||
          END.test(out[after]) ||
          /[.:]/.test(out[after]))
      if (!boundary) {
        at = out.indexOf(root, at + 1)
        continue
      }
      let end = after
      if (out[end] === '/') while (end < out.length && !END.test(out[end])) end++
      // Sentence punctuation after a path is not part of it.
      while (end > after && /[.:]/.test(out[end - 1])) end--
      const rest = out.slice(after, end).replace(/^\/+|\/+$/g, '')
      const short = label(entry, rest)
      out = out.slice(0, at) + short + out.slice(end)
      at = out.indexOf(root, at + short.length)
    }
  }
  return out
}

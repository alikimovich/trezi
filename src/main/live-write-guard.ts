import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { realPath } from './agent-file-access'

// LKM-151: a chat that runs in its own worktree must never write the live checkout
// directly. An absolute path to the live tree (a picked element's source, an earlier
// turn's tool output) would bypass the worktree, so a stopped turn's half-done edit
// lands live where neither Stop nor Revert can reach it. The Claude adapter denies
// such an edit with a PreToolUse hook (which also runs in bypass and auto modes) and
// tells the agent the worktree path to use instead.
//
// LKM-156: the same hook covers Bash. A shell command cannot be classified as a read
// or a write reliably (`sed -i`, redirections, `tee`, `cp`/`mv` targets, `find -exec`,
// `xargs`, formatters, `git -C`, `cd … &&`), so any command that names the live root is
// denied, reads included. The worktree holds the same files, so nothing is lost.
// Codex has no such hook; its sandbox keeps it out instead (`codex-sandbox.ts`).
//
// LKM-163: this is a correctness rule, not a security sandbox, so it applies with
// either "Agent file access" setting; Full access adds no other path limit. Paths are
// compared as given and resolved: every chat worktree sits under the profile's symlink
// alias, and a project may sit under a symlinked folder, so the same file has two names.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BASH_TOOLS = new Set(['Bash'])

const inside = (path: string, dir: string): boolean => {
  const rel = relative(dir, path)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

const NOTE = 'Trezi lands your changes in the live project when the turn finishes.'

/** `path` as given and with symlinks resolved (one entry when they agree). */
const names = (path: string): string[] => [...new Set([normalize(path), realPath(path)])]
const sameDir = (a: string, b: string): boolean => names(a).some((x) => names(b).includes(x))

/**
 * The denial for a tool call that would touch the live checkout `liveRoot` while the
 * session runs in the worktree `root`; null when the call is allowed. Edit tools are
 * checked by their absolute target (relative targets resolve against `root`), Bash by
 * every mention of the live root in its command.
 */
export function liveCheckoutEdit(
  tool: string,
  input: unknown,
  root: string,
  liveRoot: string
): { reason: string; path: string } | null {
  if (!liveRoot || sameDir(root, liveRoot)) return null
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (BASH_TOOLS.has(tool))
    return typeof record.command === 'string'
      ? liveCheckoutCommand(record.command, root, liveRoot)
      : null
  if (!EDIT_TOOLS.has(tool)) return null
  const target =
    typeof record.file_path === 'string'
      ? record.file_path
      : typeof record.notebook_path === 'string'
        ? record.notebook_path
        : null
  if (!target || !isAbsolute(target)) return null
  const paths = names(target)
  // The worktree may live under the live tree (it does not today); its own paths are fine.
  if (paths.some((path) => names(root).some((dir) => inside(path, dir)))) return null
  let rest: string | null = null
  for (const path of paths)
    for (const dir of names(liveRoot))
      if (rest === null && inside(path, dir)) rest = relative(dir, path)
  if (rest === null) return null
  const equivalent = join(root, rest)
  return {
    path: equivalent,
    reason: `This chat edits its own copy of the project, not the live checkout. Edit ${equivalent} instead; ${NOTE}`
  }
}

// A character that can continue a path component; anything else ends the mention.
const NAME = /[\w.\-+@~#%]/
const STOP = /[\s'"`;|&<>()]/
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// `My App` is also written `My\ App` in a shell command.
const shellEscaped = (s: string): string => s.replace(/([ '"()&;|<>$`!*?[\]{}\\])/g, '\\$1')

/** Every spelling of `dir` a command may use: as given, resolved, escaped, `~`/`$HOME`. */
function spellings(dir: string): string[] {
  const out = new Set<string>()
  const add = (path: string): void => {
    const p = normalize(path).replace(/\/+$/, '') || '/'
    out.add(p)
    out.add(shellEscaped(p))
    const home = homedir()
    if (home && inside(p, home) && p !== home) {
      const rest = relative(home, p)
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own spelling
      for (const prefix of ['~/', '$HOME/', '${HOME}/']) out.add(prefix + rest)
    }
  }
  for (const name of names(dir)) add(name)
  // Longest first, so `/private/var/x` is not read as `/var/x` with a prefix.
  return [...out].sort((a, b) => b.length - a.length)
}

/** Where `spelling` occurs in `command` as a whole path (not a sibling or a suffix). */
function mentions(command: string, spelling: string): number[] {
  const at: number[] = []
  const re = new RegExp(escapeRe(spelling), 'g')
  for (let m = re.exec(command); m; m = re.exec(command)) {
    const before = command[m.index - 1]
    const after = command[m.index + spelling.length]
    const starts = before === undefined || !(NAME.test(before) || before === '/')
    const ends = after === undefined || after === '/' || !NAME.test(after)
    if (starts && ends) at.push(m.index)
  }
  return at
}

/**
 * The denial for a shell command that names the live root, with the worktree path of
 * the first live path it names; null when it does not. Mentions of the worktree itself
 * are fine even if it lies under the live root.
 */
export function liveCheckoutCommand(
  command: string,
  root: string,
  liveRoot: string
): { reason: string; path: string } | null {
  if (!liveRoot || sameDir(root, liveRoot)) return null
  // Blank out the worktree's own paths first, so they never read as live ones.
  let text = command
  for (const spelling of spellings(root)) {
    for (const index of mentions(text, spelling).reverse()) {
      text =
        text.slice(0, index) + ' '.repeat(spelling.length) + text.slice(index + spelling.length)
    }
  }
  let first: { index: number; spelling: string } | null = null
  for (const spelling of spellings(liveRoot)) {
    const index = mentions(text, spelling)[0]
    if (index !== undefined && (!first || index < first.index)) first = { index, spelling }
  }
  if (!first) return null
  // The rest of that path: to its closing quote, else to the next shell separator.
  const start = first.index + first.spelling.length
  const quote =
    command[first.index - 1] === '"' || command[first.index - 1] === "'"
      ? command[first.index - 1]
      : ''
  let end = quote ? command.indexOf(quote, start) : start
  if (end < 0) end = command.length
  while (!quote && end < command.length && (!STOP.test(command[end]) || command[end - 1] === '\\'))
    end++
  const tail = command.slice(start, end).replace(/^\/+/, '')
  const rest = quote ? tail : tail.replace(/\\(.)/g, '$1')
  const equivalent = rest ? join(root, rest) : root
  return {
    path: equivalent,
    reason:
      `This chat runs in its own copy of the project, not the live checkout, so a command may not use ${liveRoot}. ` +
      `Use ${equivalent} instead (or a path relative to ${root}), also for reads; ${NOTE}`
  }
}

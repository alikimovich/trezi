import { isAbsolute, normalize, relative } from 'node:path'
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import { type AgentFileAccess, realPath } from '../agent-file-access'

type CodexConfig = NonNullable<CodexOptions['config']>

const inside = (path: string, dir: string): boolean => {
  const rel = relative(dir, path)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}
// As given and resolved (`/tmp` is `/private/tmp`), in any combination.
const overlaps = (a: string, b: string): boolean =>
  [normalize(a), realPath(a)].some((x) =>
    [normalize(b), realPath(b)].some((y) => inside(x, y) || inside(y, x))
  )

/**
 * How a Codex session (the ChatGPT seat and every Responses connection share this
 * harness) is sandboxed, per Settings → "Agent file access" (LKM-163):
 *
 * - `full` (the default): `danger-full-access`, so the agent reads and writes anywhere
 *   the user can and has the network; there is no Seatbelt profile at all. It still
 *   works in the chat's worktree, and Trezi lands the result in the live checkout. Codex
 *   has no pre-tool hook (the Claude adapter's `live-write-guard.ts`), so a direct write
 *   to the live checkout is detected after the turn instead (`live-tree-watch.ts`).
 * - `project` (LKM-156): `workspace-write` with the chat's worktree as the working
 *   directory. That sandbox also keeps `/tmp`, `$TMPDIR` and any `writable_roots` from
 *   the user's `~/.codex/config.toml` writable; in a worktree session the user's extra
 *   roots are dropped and the temp roots are excluded when they overlap the live tree.
 *   `test/live-write-guard.mjs` drives the real CLI and shows that a write to the live
 *   tree, or its `.git`, fails while the worktree stays writable.
 *
 * `approvalPolicy: 'never'` in both: an escalation request is refused rather than asked,
 * and Codex never asks for, or causes, a macOS permission prompt of its own.
 *
 * The working directory is the worktree's real path. Codex's Seatbelt profile refuses a
 * writable root with a symlink component other than the top-level `/tmp`/`/var` aliases
 * ("symlinked writable roots are not supported"), and every chat worktree sits under one
 * (the profile's `Trezi Native` and `trezi` aliases to the earlier names, `ProfilePaths.swift`), so
 * a symlinked path stopped Codex before its first command. A project that is not a Git
 * repository runs in the live tree itself, with no extra config.
 */
export function codexSandbox(
  root: string,
  liveRoot: string,
  access: AgentFileAccess,
  env: NodeJS.ProcessEnv = process.env
): { thread: ThreadOptions; config: CodexConfig } {
  const thread: ThreadOptions = {
    workingDirectory: realPath(root),
    skipGitRepoCheck: true,
    sandboxMode: access === 'full' ? 'danger-full-access' : 'workspace-write',
    approvalPolicy: 'never'
  }
  if (access === 'full' || !liveRoot || realPath(root) === realPath(liveRoot))
    return { thread, config: {} }
  return {
    thread,
    config: {
      sandbox_workspace_write: {
        writable_roots: [],
        ...(overlaps(liveRoot, '/tmp') ? { exclude_slash_tmp: true } : {}),
        ...(env.TMPDIR && overlaps(liveRoot, env.TMPDIR) ? { exclude_tmpdir_env_var: true } : {})
      }
    }
  }
}

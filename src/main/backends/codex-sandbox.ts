import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, relative } from 'node:path'
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'

type CodexConfig = NonNullable<CodexOptions['config']>

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return normalize(path)
  }
}
const inside = (path: string, dir: string): boolean => {
  const rel = relative(dir, path)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}
// As given and resolved (`/tmp` is `/private/tmp`), in any combination.
const overlaps = (a: string, b: string): boolean =>
  [normalize(a), real(a)].some((x) =>
    [normalize(b), real(b)].some((y) => inside(x, y) || inside(y, x))
  )

/**
 * LKM-156: how a Codex session (the ChatGPT seat and every Responses connection share
 * this harness) is kept off the live checkout. Codex runs its own shell and patch tools
 * with no pre-tool hook to deny a call (the Claude adapter's `live-write-guard.ts`), so
 * its sandbox does it: `workspace-write` with the chat's worktree as the working
 * directory and `approvalPolicy: 'never'`, so an escalation request is refused rather
 * than asked. `test/live-write-guard.mjs` drives the real CLI and shows that a write
 * to the live tree, or its `.git`, fails while the worktree stays writable.
 *
 * That sandbox also keeps `/tmp`, `$TMPDIR` and any `writable_roots` from the user's
 * `~/.codex/config.toml` writable. In a worktree session the user's extra roots are
 * dropped and the temp roots are excluded when they overlap the live tree. A project
 * that is not a Git repository runs in the live tree itself and is unchanged.
 */
export function codexSandbox(
  root: string,
  liveRoot: string,
  env: NodeJS.ProcessEnv = process.env
): { thread: ThreadOptions; config: CodexConfig } {
  const thread: ThreadOptions = {
    workingDirectory: root,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never'
  }
  if (!liveRoot || normalize(root) === normalize(liveRoot)) return { thread, config: {} }
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

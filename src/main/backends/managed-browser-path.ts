/**
 * LKM-264: how provider helpers put Trezi's managed `agent-browser` wrapper first on the
 * PATH their agents' shell tools inherit. Login shells may reorder that PATH;
 * LKM-269 supplies an explicit managed route and refuses direct global launches.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { browserCommandRefusal } from '../../../bin/trezi-browser-policy.mjs'

/**
 * `<root>/bin/managed` for the bundled helper (`__dirname` is `out/native`, like
 * `claude.ts`' `../../agent-plugin`) and for a source-tree run (`src/main/backends`).
 */
export function managedBrowserDirectory(
  base: string,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  return [join(base, '../../bin/managed'), join(base, '../../../bin/managed')].find((dir) =>
    exists(join(dir, 'agent-browser'))
  )
}

/**
 * The wrapper's shebang is `env bun`, and a helper's launch PATH is only the system
 * directories: the managed directory goes first, the directory of the helper's own Bun
 * goes last, so the wrapper reports its honest blocker instead of "env: bun: not found".
 */
export function managedBrowserPath(
  dir: string,
  path: string | undefined,
  execPath: string
): string {
  const entries = [dir, ...(path ?? '').split(delimiter).filter(Boolean)]
  const interpreter = dirname(execPath)
  if (!entries.includes(interpreter)) entries.push(interpreter)
  return entries.join(delimiter)
}

const executableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * LKM-269: the absolute path of Trezi's managed wrapper, only when it exists and is an
 * executable file. PATH is not the route (a login shell rebuilds it); this path is.
 */
export function managedBrowserWrapper(
  base: string,
  exists: (path: string) => boolean = existsSync,
  executable: (path: string) => boolean = executableFile
): string | undefined {
  const dir = managedBrowserDirectory(base, exists)
  const wrapper = dir && join(dir, 'agent-browser')
  return wrapper && executable(wrapper) ? wrapper : undefined
}

/** The variable every provider shell gets with the managed wrapper's absolute path. */
export const MANAGED_BROWSER_VARIABLE = 'TREZI_AGENT_BROWSER'

/** `PATH` (managed first) and `TREZI_AGENT_BROWSER`, or `{}` when this install has no usable wrapper. */
export function managedBrowserEnv(
  base: string,
  path: string | undefined,
  execPath: string
): Record<string, string> {
  const wrapper = managedBrowserWrapper(base)
  if (!wrapper) return {}
  return {
    PATH: managedBrowserPath(dirname(wrapper), path, execPath),
    [MANAGED_BROWSER_VARIABLE]: wrapper
  }
}

/**
 * Codex config fragment (rebuilt for every turn, resume included): the shell tool's
 * environment carries the managed route, login shells are off so macOS path_helper and
 * the user's profile do not reorder PATH, and a PreToolUse hook refuses any other
 * agent-browser route. Without a usable wrapper only the refusing hook remains.
 */
export function managedBrowserCodexConfig(
  base: string,
  path: string | undefined = process.env.PATH,
  execPath: string = process.execPath
) {
  const wrapper = managedBrowserWrapper(base)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const guards = [join(base, '../../bin'), join(base, '../../../bin')].map((dir) =>
    join(dir, 'trezi-browser-guard.mjs')
  )
  const guard = guards.find((file) => existsSync(file))
  if (!guard)
    throw new Error(
      "Trezi's managed browser guard is missing from this install; provider execution is disabled. Rebuild Trezi; do not use a global agent-browser."
    )
  return {
    ...(wrapper
      ? {
          allow_login_shell: false,
          shell_environment_policy: { set: managedBrowserEnv(base, path, execPath) }
        }
      : {}),
    ...(guard
      ? {
          features: { hooks: true },
          hooks: {
            PreToolUse: [
              {
                matcher: '^Bash$',
                hooks: [
                  {
                    type: 'command',
                    command: `${quote(execPath)} ${quote(guard)} ${quote(wrapper ?? '')}`
                  }
                ]
              }
            ]
          }
        }
      : {})
  }
}

/**
 * Claude's Bash tool snapshots the user's shell and can reorder PATH, so its PreToolUse
 * hook (this) is the guarantee: a Bash call that reaches agent-browser outside the
 * managed wrapper, or with a flag the wrapper forbids, is refused with the way back.
 */
export function managedBrowserRefusal(
  base: string,
  tool: string,
  input: unknown,
  cwd?: string
): string | null {
  if (tool !== 'Bash') return null
  const command = (input as { command?: unknown } | null)?.command
  return typeof command === 'string'
    ? browserCommandRefusal(command, managedBrowserWrapper(base), cwd)
    : null
}

/**
 * LKM-264: how provider helpers put Trezi's managed `agent-browser` wrapper first on the
 * PATH their agents' shell tools inherit, so a bare `agent-browser` never resolves to
 * the global CLI (which can launch the user's Chrome and take focus).
 */
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

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

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { managedBrowserPath } from './backends/managed-browser-path'

/**
 * LOCAL-WEBKIT-2: how the host runs Trezi's managed `agent-browser` wrapper for
 * `preview_verify` engine "chromium". Only the wrapper is run (never the global CLI),
 * with the same PATH the provider helpers give it, from the checkout's root, with one
 * private `--session`; the wrapper refuses headed browsers, CDP attach, profiles and
 * system Chrome and keeps the session's HOME/profile private. Results come from stdout
 * JSON only: the CLI's own warnings on stderr (such as "startup options ignored" for a
 * warm daemon) are never page errors and never a success.
 */

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export const CLI_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT = 256 * 1024
/** After the deadline: SIGTERM, then SIGKILL this much later, then give up on the exit. */
export const CLI_KILL_AFTER_MS = 1000
export const CLI_ABANDON_AFTER_MS = 500

/**
 * One wrapper command in `session`; a null session runs `--version` (no browser). The
 * call settles within `timeoutMs` plus `CLI_KILL_AFTER_MS + CLI_ABANDON_AFTER_MS`, however
 * the child behaves: on the deadline the wrapper gets SIGTERM (it forwards it to its CLI),
 * then its whole process group SIGKILL. The wrapper runs in its own group, so only the
 * wrapper and the CLI client it started are signalled; a daemon the CLI detached into its
 * own session, and every unrelated process, is left alone.
 */
export function runManagedCli(
  wrapper: string,
  session: string | null,
  cwd: string,
  args: string[],
  timeoutMs = CLI_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env
): Promise<CliResult> {
  const argv = session ? [wrapper, '--session', session, ...args, '--json'] : [wrapper, ...args]
  if (!(timeoutMs > 0))
    return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: true })
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, argv, {
      cwd,
      env: { ...env, PATH: managedBrowserPath(dirname(wrapper), env.PATH, process.execPath) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const finish = (code: number | null, extra = '') => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      resolve({ code, stdout, stderr: `${stderr}${extra}`, timedOut })
    }
    const signal = (name: NodeJS.Signals, group: boolean) => {
      try {
        if (group && proc.pid) process.kill(-proc.pid, name)
        else proc.kill(name)
      } catch {
        // already gone
      }
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString()
    })
    timers.push(
      setTimeout(() => {
        timedOut = true
        signal('SIGTERM', false)
        timers.push(
          setTimeout(() => {
            signal('SIGKILL', true)
            timers.push(
              setTimeout(() => {
                // The child did not exit even then: stop waiting for it and its pipes.
                proc.stdout.destroy()
                proc.stderr.destroy()
                proc.unref()
                finish(null)
              }, CLI_ABANDON_AFTER_MS)
            )
          }, CLI_KILL_AFTER_MS)
        )
      }, timeoutMs)
    )
    proc.once('error', (error) => finish(null, error.message))
    proc.once('close', (code) => finish(code))
  })
}

/** The wrapper's exit 3: a dependency the user installs. Nothing was launched. */
export function cliDependency(result: CliResult): { kind: string; message: string } | null {
  if (result.code !== 3) return null
  const match = result.stderr.match(/dependency: ([a-z-]+): ([^\n]+)/)
  return match ? { kind: match[1], message: match[2].trim() } : null
}

/** The last stdout line that is the CLI's `{ success, data }` JSON, or null. */
export function parseCliJson(
  stdout: string
): { success: boolean; data: unknown; error?: string } | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  // One JSON line per answer; a pretty-printed answer is the whole output.
  const whole = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)
  for (const line of [...lines.reverse(), whole]) {
    if (!line.startsWith('{')) continue
    try {
      const value = JSON.parse(line) as { success?: unknown; data?: unknown; error?: unknown }
      if (typeof value.success === 'boolean')
        return {
          success: value.success,
          data: value.data,
          ...(typeof value.error === 'string' ? { error: value.error } : {})
        }
    } catch {}
  }
  return null
}

type Scalar = string | number | boolean | null
const isScalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

/**
 * The one value a `get`/`is` answer carries: the data itself, its first key from `keys`,
 * or its only scalar field. Anything else is undefined, so an unknown shape fails a check
 * instead of passing it.
 */
export function cliScalar(data: unknown, keys: string[]): Scalar | undefined {
  if (isScalar(data)) return data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  for (const key of keys) if (key in record && isScalar(record[key])) return record[key] as Scalar
  const scalars = Object.entries(record).filter(
    ([key, value]) => isScalar(value) && !['selector', 'ref', 'name', 'attribute'].includes(key)
  )
  return scalars.length === 1 ? (scalars[0][1] as Scalar) : undefined
}

/** The entries of a list answer (`errors`, `console`): the data or its only array field. */
export function cliEntries(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return undefined
  const arrays = Object.values(data as Record<string, unknown>).filter(Array.isArray)
  return arrays.length === 1 ? (arrays[0] as unknown[]) : undefined
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

/** A computed style property from a `get styles` answer, searched a few levels deep. */
export function cliStyle(data: unknown, property: string, depth = 0): string | undefined {
  if (!data || typeof data !== 'object' || depth > 3) return undefined
  if (Array.isArray(data))
    return data.length === 1 ? cliStyle(data[0], property, depth + 1) : undefined
  const record = data as Record<string, unknown>
  for (const key of [property, kebab(property), camel(property)])
    if (typeof record[key] === 'string') return record[key] as string
  for (const value of Object.values(record)) {
    const found = typeof value === 'object' ? cliStyle(value, property, depth + 1) : undefined
    if (found !== undefined) return found
  }
  return undefined
}

/** Width and height from a PNG's IHDR chunk, or null. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 24 ||
    bytes.readUInt32BE(0) !== 0x89504e47 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

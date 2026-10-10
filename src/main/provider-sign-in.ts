import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { homedir, tmpdir, userInfo } from 'node:os'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { shell } from '../native/platform'
import type { BuiltinProvider } from '../shared/provider-readiness'
import { bundledClaude } from './backends/claude-login'
import { seatLogin } from './provider-data'

export type SignInResult = {
  ok: boolean
  reason?: 'cancelled' | 'expired' | 'failed' | 'missing'
  detail?: string
}
type Process = ChildProcessWithoutNullStreams
type RpcResponse = { error?: unknown; result?: { loginId?: string; authUrl?: string } }
const execFileP = promisify(execFile)
const authEnvironment = (provider: BuiltinProvider): NodeJS.ProcessEnv => {
  const names = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY'
  ]
  names.push(
    ...(provider === 'claude' ? ['CLAUDE_CONFIG_DIR'] : ['CODEX_HOME', 'CODEX_CA_CERTIFICATE'])
  )
  const env = Object.fromEntries(
    names.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
  )
  env.HOME ||= homedir()
  env.USER ||= userInfo().username
  env.LOGNAME ||= env.USER
  env.PATH ||= '/usr/bin:/bin:/usr/sbin:/sbin'
  return env
}

async function codexBinary(): Promise<string> {
  const { Codex } = await import('@openai/codex-sdk')
  return (
    process.env.TREZI_CODEX_BIN ||
    (new Codex() as unknown as { exec: { executablePath: string } }).exec.executablePath
  )
}

export async function checkCodexLogin(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileP(await codexBinary(), ['login', 'status'], {
      timeout: 5000,
      maxBuffer: 4096,
      cwd: tmpdir(),
      env: authEnvironment('codex')
    })
    if (/not logged in/i.test(stdout)) return false
    if (/logged in/i.test(stdout)) return true
    return null
  } catch (error) {
    const output = String((error as { stdout?: string }).stdout ?? '')
    return /not logged in/i.test(output) ? false : null
  }
}

/** Only provider domains may receive an OAuth URL returned by app-server. */
export function codexAuthUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      ['auth.openai.com', 'chatgpt.com'].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? value
      : null
  } catch {
    return null
  }
}

/** Stdio JSON-RPC for Codex-managed ChatGPT auth. Output is parsed in memory only. */
export async function codexManagedLogin(
  bin: string,
  signal: AbortSignal,
  open: (url: string) => Promise<unknown> = (url) => shell.openExternal(url),
  launch: typeof spawn = spawn
): Promise<SignInResult> {
  let child: Process
  try {
    child = launch(bin, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      cwd: tmpdir(),
      env: authEnvironment('codex')
    })
  } catch {
    return { ok: false, reason: 'missing', detail: 'Codex is unavailable.' }
  }
  // Never relay stdout/stderr to product logs, cards, or the transcript.
  child.stderr.resume()
  const pending = new Map<number, (value: RpcResponse) => void>()
  let complete: ((value: SignInResult) => void) | undefined
  let loginId: string | undefined
  let stoppedReason: SignInResult | undefined
  const result = new Promise<SignInResult>((resolve) => {
    complete = resolve
  })
  const timeout = setTimeout(() => {
    complete?.({ ok: false, reason: 'expired', detail: 'Sign-in timed out. Try again.' })
    child.kill()
  }, 10 * 60_000)
  const rpc = (id: number, method: string, params: unknown): Promise<RpcResponse> =>
    new Promise((resolve) => {
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (typeof message.id === 'number' && pending.has(message.id)) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
      if (message.method === 'account/login/completed' && message.params?.loginId === loginId) {
        complete?.(
          message.params.success === true
            ? { ok: true }
            : /expired|timed out/i.test(String(message.params.error ?? ''))
              ? { ok: false, reason: 'expired', detail: 'Codex sign-in expired. Try again.' }
              : {
                  ok: false,
                  reason: 'failed',
                  detail: 'Codex sign-in did not complete. Try again.'
                }
        )
      }
    } catch {
      /* Ignore unrelated or malformed notifications. */
    }
  })
  const stopped = (value: SignInResult) => {
    stoppedReason = value
    for (const answer of pending.values()) answer({ error: true })
    pending.clear()
    complete?.(value)
  }
  child.on('error', () =>
    stopped({ ok: false, reason: 'missing', detail: 'Codex is unavailable.' })
  )
  child.on('exit', () =>
    stopped({
      ok: false,
      reason: signal.aborted ? 'cancelled' : 'failed',
      detail: 'Codex sign-in stopped.'
    })
  )
  signal.addEventListener(
    'abort',
    () => {
      if (loginId)
        child.stdin.write(
          `${JSON.stringify({ id: 3, method: 'account/login/cancel', params: { loginId } })}\n`
        )
      child.kill()
    },
    { once: true }
  )
  try {
    const init = await rpc(0, 'initialize', {
      clientInfo: { name: 'trezi', title: 'Trezi', version: '0.1.0' }
    })
    if (init.error)
      return (
        stoppedReason ?? {
          ok: false,
          reason: 'failed',
          detail: 'Codex could not initialize sign-in.'
        }
      )
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    const started = await rpc(1, 'account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'codex'
    })
    if (started.error)
      return (
        stoppedReason ?? { ok: false, reason: 'failed', detail: 'Codex could not start sign-in.' }
      )
    loginId = started.result?.loginId
    const url = codexAuthUrl(started.result?.authUrl)
    if (!loginId || !url)
      return { ok: false, reason: 'failed', detail: 'Codex did not provide a valid sign-in page.' }
    await open(url)
    return await result
  } catch {
    return {
      ok: false,
      reason: signal.aborted ? 'cancelled' : 'failed',
      detail: 'Unable to open Codex sign-in.'
    }
  } finally {
    clearTimeout(timeout)
    lines.close()
    child.kill()
  }
}

/** Claude Code owns its browser callback and credential store. No CLI output is retained. */
export async function claudeManagedLogin(
  executable: string,
  signal: AbortSignal,
  launch: typeof spawn = spawn,
  configDir?: string
): Promise<SignInResult> {
  return new Promise((resolve) => {
    const child = launch(executable, ['auth', 'login'], {
      stdio: 'ignore',
      signal,
      cwd: tmpdir(),
      env: { ...authEnvironment('claude'), ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) }
    })
    const timeout = setTimeout(() => {
      resolve({ ok: false, reason: 'expired', detail: 'Sign-in timed out. Try again.' })
      child.kill()
    }, 10 * 60_000)
    child.on('error', () => {
      clearTimeout(timeout)
      resolve({
        ok: false,
        reason: signal.aborted ? 'cancelled' : 'missing',
        detail: 'Claude Code is unavailable.'
      })
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      resolve(
        code === 0
          ? { ok: true }
          : {
              ok: false,
              reason: signal.aborted ? 'cancelled' : 'failed',
              detail: 'Claude sign-in did not complete. Try again.'
            }
      )
    })
  })
}

const running = new Map<BuiltinProvider, AbortController>()
export function cancelProviderSignIn(provider: BuiltinProvider): void {
  running.get(provider)?.abort()
}

export async function signInProvider(
  provider: BuiltinProvider,
  root: string
): Promise<SignInResult> {
  if (running.has(provider))
    return { ok: false, reason: 'failed', detail: 'Sign-in is already open.' }
  const abort = new AbortController()
  running.set(provider, abort)
  try {
    if (provider === 'claude') {
      const report = await seatLogin.check('claude', root)
      if (abort.signal.aborted) return { ok: false, reason: 'cancelled' }
      const path = report.executable ?? bundledClaude()
      if (!path) return { ok: false, reason: 'missing', detail: 'Claude Code is unavailable.' }
      const result = await claudeManagedLogin(path, abort.signal, spawn, report.configDir)
      if (!result.ok) return result
      const refreshed = await seatLogin.check('claude', root)
      return refreshed.loggedIn === true
        ? result
        : {
            ok: false,
            reason: 'expired',
            detail: 'Claude sign-in could not be confirmed. Retry sign-in.'
          }
    }
    const bin = await codexBinary()
    if (abort.signal.aborted) return { ok: false, reason: 'cancelled' }
    const result = await codexManagedLogin(bin, abort.signal)
    return result.ok && (await checkCodexLogin()) !== true
      ? {
          ok: false,
          reason: 'expired',
          detail: 'Codex sign-in could not be confirmed. Retry sign-in.'
        }
      : result
  } catch {
    return {
      ok: false,
      reason: abort.signal.aborted ? 'cancelled' : 'failed',
      detail: 'Sign-in could not start. Check your connection and retry.'
    }
  } finally {
    running.delete(provider)
  }
}

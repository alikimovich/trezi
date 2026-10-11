import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderLoginReport } from '../../shared/api'

/**
 * Claude seat login (LKM-119), inside the Claude provider helper.
 *
 * The helper runs the SDK's bundled Claude CLI. It reads the same credentials as an
 * installed `claude` (Keychain item "Claude Code-credentials" for account $USER, or
 * `~/.claude/.credentials.json`, or `CLAUDE_CODE_OAUTH_TOKEN`), but only what its
 * environment lets it find. So before the first query the helper asks the bundled CLI
 * `claude auth status --json`; when it is not logged in and an installed CLI is, the
 * session runs that one instead (`pathToClaudeCodeExecutable`). The probes use the
 * helper's own environment and cwd, exactly what the query will see. The owner caches
 * the choice for the app session and passes it to later helpers, which then skip the
 * probes; a sign-in failure drops it (LKM-135).
 */

export interface ClaudeAuth {
  loggedIn: boolean | null
  authMethod?: string
  error?: string
}

export interface ClaudeCli {
  /** The executable to pass as `pathToClaudeCodeExecutable`; undefined: the SDK's own. */
  executable?: string
  source: 'bundled' | 'installed'
  bundled: { path: string | null; auth: ClaudeAuth }
  installed: { path: string; auth: ClaudeAuth }[]
}

const PROBE_TIMEOUT = 4000

/** The SDK's native CLI, resolved the way the SDK resolves it. */
export function bundledClaude(): string | null {
  try {
    return require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`
    )
  } catch {
    return null
  }
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Installed `claude` executables: PATH first, then the installers' usual places. */
export function installedClaudes(
  env: NodeJS.ProcessEnv = process.env,
  bundled = bundledClaude()
): string[] {
  const home = env.HOME || homedir()
  const candidates = [
    ...(env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((dir) => join(dir, 'claude')),
    join(home, '.local/bin/claude'),
    join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
  const seen = new Set(bundled ? [real(bundled)] : [])
  const out: string[] = []
  for (const path of candidates) {
    if (!executable(path)) continue
    const target = real(path)
    // An npm-installed `claude` shim can resolve into this checkout's SDK package too.
    if (seen.has(target) || target.includes('/claude-agent-sdk')) continue
    seen.add(target)
    out.push(path)
  }
  return out
}

/** `claude auth status --json` (exit 1 when logged out, still with JSON). */
export function parseAuthStatus(stdout: string): ClaudeAuth | null {
  try {
    const value = JSON.parse(stdout.trim())
    if (!value || typeof value !== 'object' || typeof value.loggedIn !== 'boolean') return null
    return {
      loggedIn: value.loggedIn,
      ...(typeof value.authMethod === 'string' ? { authMethod: value.authMethod } : {})
    }
  } catch {
    return null
  }
}

export function claudeAuthStatus(path: string, timeout = PROBE_TIMEOUT): Promise<ClaudeAuth> {
  return new Promise((resolve) => {
    execFile(
      path,
      ['auth', 'status', '--json'],
      { timeout, maxBuffer: 64 * 1024, env: process.env },
      (error, stdout) => {
        const parsed = parseAuthStatus(String(stdout ?? ''))
        if (parsed) return resolve(parsed)
        const reason = error
          ? error.killed
            ? 'timed out'
            : error.message.split('\n')[0]
          : 'unreadable output'
        resolve({ loggedIn: null, error: reason.slice(0, 300) })
      }
    )
  })
}

/** Which executables to probe; the defaults are the SDK's and `installedClaudes()` (tests name stand-ins). */
export interface ClaudeCandidates {
  bundled?: string | null
  installed?: string[]
  /** The `security` tool; by default the first one on PATH, else `/usr/bin/security`. */
  security?: string
}

let cached: Promise<ClaudeCli> | null = null
let defaults: ClaudeCandidates = {}

/** The executables later probes use when none are named (a test helper's stand-in CLIs). */
export function setClaudeCandidates(candidates: ClaudeCandidates): void {
  defaults = candidates
  cached = null
}

/** After a sign-in failure the next session probes again (LKM-135). */
export function forgetClaudeCli(): void {
  cached = null
}

/**
 * Which CLI this helper's sessions run; probed once per helper unless `fresh`. The
 * bundled and installed CLIs are probed at the same time (LKM-135): each can take
 * seconds when cold, and the owner caches the choice for the rest of the app session.
 */
export function resolveClaudeCli(
  fresh = false,
  candidates: ClaudeCandidates = defaults
): Promise<ClaudeCli> {
  if (!fresh && cached) return cached
  const probe = (async (): Promise<ClaudeCli> => {
    const path = candidates.bundled !== undefined ? candidates.bundled : bundledClaude()
    const paths = candidates.installed ?? installedClaudes(process.env, path)
    const [auth, installed] = await Promise.all([
      path
        ? claudeAuthStatus(path)
        : Promise.resolve<ClaudeAuth>({ loggedIn: null, error: 'not found' }),
      Promise.all(paths.map(async (p) => ({ path: p, auth: await claudeAuthStatus(p) })))
    ])
    const bundled = { path, auth }
    if (auth.loggedIn === true) return { source: 'bundled', bundled, installed }
    const usable = installed.find((cli) => cli.auth.loggedIn === true)
    return usable
      ? { executable: usable.path, source: 'installed', bundled, installed }
      : { source: 'bundled', bundled, installed }
  })()
  if (!fresh) cached = probe
  return probe
}

/** The choice the owner may cache, and whether that CLI is logged in. */
export function claudeCliChoice(cli: ClaudeCli): {
  cli: { source: 'bundled' | 'installed'; executable?: string }
  loggedIn: boolean
} {
  const used = cli.installed.find((c) => c.path === cli.executable)
  return {
    cli: { source: cli.source, ...(cli.executable ? { executable: cli.executable } : {}) },
    loggedIn: (used?.auth ?? cli.bundled.auth).loggedIn === true
  }
}

/**
 * Where the Claude CLI keeps a login, as this helper's context sees it (LKM-124). On macOS
 * the CLI reads the login Keychain item below, then `<config dir>/.credentials.json`. A
 * helper started by the service can lose the user's security session, so the report shows
 * both: the `security` exit codes and the file's existence, readability and size. Nothing
 * here reads a secret: `find-generic-password` runs without `-w`/`-g` and with its output
 * discarded, and the credentials file is only stat'ed.
 */
const KEYCHAIN_ITEM = 'Claude Code-credentials'

export interface KeychainProbe {
  /** exit 0 of `security find-generic-password -s …`; null when `security` did not run. */
  readable: boolean | null
  exit: number | null
  /** `security list-keychains -d user` and `security default-keychain`, one line each. */
  list: string
  default: string
  /** Exit codes of those two (LKM-125); null: could not run. Non-zero: no user keychain here. */
  codes: { listKeychains: number | null; defaultKeychain: number | null }
  error?: string
}

export interface CredentialsProbe {
  path: string
  exists: boolean
  readable: boolean
  size: number | null
  /** Permission bits in octal, e.g. `600`. */
  mode?: string
}

interface ToolRun {
  code: number | null
  out: string
  error?: string
}

/** Runs a tool with a deadline; `capture` false discards its output. Never gets the seat token. */
function runTool(
  path: string,
  args: string[],
  capture: boolean,
  timeout = PROBE_TIMEOUT
): Promise<ToolRun> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (run: ToolRun) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(run)
    }
    const env = { ...process.env }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(path, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], env })
    } catch {
      return finish({ code: null, out, error: 'could not start' })
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, out, error: 'timed out' })
    }, timeout)
    child.stdout?.on('data', (chunk) => {
      if (out.length < 4096) out += String(chunk)
    })
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish({ code: null, out, error: error.code === 'ENOENT' ? 'not found' : 'could not start' })
    )
    child.once('close', (code) => finish({ code, out }))
  })
}

const oneLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 500)

/** Whether the login Keychain item can be found from this process, and which keychains it searches. */
export async function probeKeychain(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<KeychainProbe> {
  const security =
    explicit ??
    (env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((dir) => join(dir, 'security'))
      .find(executable) ??
    '/usr/bin/security'
  const [find, list, fallback] = await Promise.all([
    runTool(security, ['find-generic-password', '-s', KEYCHAIN_ITEM], false),
    runTool(security, ['list-keychains', '-d', 'user'], true),
    runTool(security, ['default-keychain'], true)
  ])
  const shown = (run: ToolRun): string =>
    run.code === 0 ? oneLine(run.out) || 'none' : `unavailable (${run.error ?? `exit ${run.code}`})`
  return {
    readable: find.code === null ? null : find.code === 0,
    exit: find.code,
    list: shown(list),
    default: shown(fallback),
    codes: { listKeychains: list.code, defaultKeychain: fallback.code },
    ...(find.error ? { error: find.error } : {})
  }
}

/** The credentials file through this helper's HOME (or CLAUDE_CONFIG_DIR): metadata only, never content. */
export function probeCredentials(env: NodeJS.ProcessEnv = process.env): CredentialsProbe {
  const path = join(
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude'),
    '.credentials.json'
  )
  try {
    const stat = statSync(path)
    let readable = true
    try {
      accessSync(path, constants.R_OK)
    } catch {
      readable = false
    }
    return { path, exists: true, readable, size: stat.size, mode: (stat.mode & 0o777).toString(8) }
  } catch {
    return { path, exists: false, readable: false, size: null }
  }
}

const describeKeychain = (probe: KeychainProbe): string =>
  probe.readable === true
    ? 'Keychain: readable from this context (the item was found; its secret was not read)'
    : probe.readable === false
      ? `Keychain: not readable from this context (security exit ${probe.exit})`
      : `Keychain: unknown (${probe.error ?? 'security did not run'})`

const describeCredentials = (probe: CredentialsProbe): string =>
  !probe.exists
    ? `Credentials file: ${probe.path} does not exist`
    : `Credentials file: ${probe.path} exists, ${probe.readable ? 'readable' : 'not readable'}, ${probe.size} bytes, mode ${probe.mode}`

const describe = (auth: ClaudeAuth): string =>
  auth.loggedIn === true
    ? `logged in${auth.authMethod ? ` (${auth.authMethod})` : ''}`
    : auth.loggedIn === false
      ? 'not logged in'
      : `unknown (${auth.error ?? 'no answer'})`

/** "Check provider login": what this helper sees. Names and paths only, never a secret. */
export async function checkClaudeLogin(
  candidates: ClaudeCandidates = defaults
): Promise<Omit<ProviderLoginReport, 'provider'>> {
  const [cli, keychain] = await Promise.all([
    resolveClaudeCli(true, candidates),
    probeKeychain(candidates.security)
  ])
  const credentials = probeCredentials()
  const exit = (code: number | null) => (code === null ? 'did not run' : `exit ${code}`)
  const used =
    cli.source === 'installed' ? cli.installed.find((c) => c.path === cli.executable) : undefined
  const auth = used?.auth ?? cli.bundled.auth
  const path = used?.path ?? cli.bundled.path
  const env = process.env
  const lines = [
    `Bundled Claude CLI${cli.bundled.path ? ` (${cli.bundled.path})` : ''}: ${describe(cli.bundled.auth)}`,
    ...cli.installed.map((c) => `Installed ${c.path}: ${describe(c.auth)}`),
    ...(cli.installed.length || cli.bundled.auth.loggedIn
      ? []
      : ['No installed claude CLI found.']),
    `Chats use: ${cli.source === 'installed' ? cli.executable : 'the bundled CLI'}`,
    describeKeychain(keychain),
    `Keychain in this helper: security list-keychains ${exit(keychain.codes.listKeychains)}; security default-keychain ${exit(keychain.codes.defaultKeychain)}${
      keychain.codes.listKeychains === 0 && keychain.codes.defaultKeychain === 0
        ? ''
        : ' (no user keychain: a login kept in the Keychain cannot be read here)'
    }`,
    `Keychains searched (security list-keychains -d user): ${keychain.list}`,
    `Default keychain (security default-keychain): ${keychain.default}`,
    describeCredentials(credentials),
    `Subscription token from Settings: ${env.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'not set'}`,
    `ANTHROPIC_API_KEY: ${env.ANTHROPIC_API_KEY ? 'set' : 'not set'}; CLAUDE_CONFIG_DIR: ${env.CLAUDE_CONFIG_DIR || 'default (~/.claude)'}`,
    `USER: ${env.USER || 'missing'}; HOME: ${env.HOME || 'missing'}; cwd: ${process.cwd()}`,
    `PATH: ${env.PATH || 'missing'}`
  ]
  return {
    loggedIn: auth.loggedIn,
    source: cli.source,
    ...(path ? { executable: path } : {}),
    ...(env.CLAUDE_CONFIG_DIR ? { configDir: env.CLAUDE_CONFIG_DIR } : {}),
    ...(auth.authMethod ? { authMethod: auth.authMethod } : {}),
    token: !!env.CLAUDE_CODE_OAUTH_TOKEN,
    keychain: keychain.codes,
    keychainItem: keychain.readable,
    keychainItemExit: keychain.exit,
    keychainList: keychain.list,
    keychainDefault: keychain.default,
    credentialsPath: credentials.path,
    credentialsExists: credentials.exists,
    credentialsReadable: credentials.readable,
    credentialsSize: credentials.size,
    detail: lines.join('\n').slice(0, 4000)
  }
}

/** A turn the CLI answered with its own "not signed in" message, not the model. */
export function isAuthFailure(message: {
  error?: unknown
  message?: { model?: unknown; content?: unknown }
}): boolean {
  if (message.error === 'authentication_failed' || message.error === 'oauth_org_not_allowed')
    return true
  if (message.message?.model !== '<synthetic>' || !Array.isArray(message.message.content))
    return false
  const text = message.message.content
    .map((block: { type?: string; text?: string }) =>
      block?.type === 'text' ? (block.text ?? '') : ''
    )
    .join(' ')
  return /not logged in|invalid api key|please run \/login|oauth token (has )?expired|authentication_error/i.test(
    text
  )
}

/** `/login` and `/logout` need Claude's interactive terminal UI, which the SDK does not have. */
export function isLoginCommand(text: string): boolean {
  return /^\/(login|logout)(\s|$)/i.test(text.trim())
}

export const LOGIN_COMMAND_MESSAGE =
  'Claude’s /login needs a terminal, so it cannot run inside a Trezi chat.'

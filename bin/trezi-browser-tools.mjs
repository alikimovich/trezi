/**
 * LOCAL-WEBKIT-4: where Trezi's managed browser finds its two external dependencies,
 * shared by the wrapper (`managed/agent-browser`), the Bun backend's Settings → Browser
 * Checks status and the Swift installer's layout (`src/service/BrowserTools.swift`).
 * Node builtins only: it ships inside Trezi.app beside the wrapper.
 *
 * - The Vercel agent-browser CLI: Trezi's own copy first (installed from Settings into
 *   `~/Library/Caches/Trezi/browser-tools/agent-browser`), then one on PATH outside the
 *   wrapper's folder.
 * - The dedicated Chromium headless shell: Trezi's own Playwright cache first
 *   (`browser-tools/ms-playwright`), then Playwright's default cache. Never Chrome.app.
 *
 * Built-in WebKit needs neither; nothing here installs anything.
 */
import { spawn } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'

/** The CLI release Trezi's wrapper is tested with, and the series it accepts as tested. */
export const CLI_VERSION = '0.26.0'
export const CLI_SERIES = '0.26'
/** The Playwright release whose installer the quick install runs (Node 20 or later). */
export const PLAYWRIGHT_VERSION = '1.64.1'
export const PLAYWRIGHT_NODE_MAJOR = 20

export const BROWSER_TOOL_LINKS = {
  agentBrowser: 'https://agent-browser.dev/installation',
  playwrightBrowsers: 'https://playwright.dev/docs/browsers',
  playwrightRegistry:
    'https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/index.ts',
  npx: 'https://docs.npmjs.com/cli/v11/commands/npx/',
  node: 'https://nodejs.org/en/download',
  homebrew: 'https://brew.sh'
}

/** What a user runs in Terminal instead of the quick install (global locations). */
export const BROWSER_TOOL_COMMANDS = {
  cli: `npm install -g agent-browser@${CLI_VERSION}`,
  shell: `npx --yes --package=playwright@${PLAYWRIGHT_VERSION} playwright install chromium-headless-shell --no-remove`
}

const testing = (env) => env.TREZI_BROWSER_TEST === '1'

/** Trezi's own tools folder; a test run may point it at a fixture. */
export function browserToolsDirectory(env = process.env, home = homedir()) {
  if (testing(env) && env.TREZI_BROWSER_TOOLS_DIR) return env.TREZI_BROWSER_TOOLS_DIR
  return join(home, 'Library/Caches/Trezi/browser-tools')
}

const macArch = (arch) => (arch === 'arm64' ? 'arm64' : 'x64')

/** The native CLI binary inside Trezi's npm prefix (the package ships one per platform). */
export function ownedCliPath(tools, arch = process.arch) {
  return join(tools, `agent-browser/node_modules/agent-browser/bin/agent-browser-darwin-${macArch(arch)}`)
}

const executable = (path) => {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * `{ path, source }` of the CLI, or undefined. `skip` holds folders whose `agent-browser`
 * is never the engine (the wrapper's own). A global `agent-browser` on PATH is only ever
 * the engine behind the wrapper, never a way around it.
 */
export function findCli({ env = process.env, home = homedir(), skip = [], arch = process.arch } = {}) {
  if (testing(env) && env.TREZI_BROWSER_TEST_CLI) {
    const path = env.TREZI_BROWSER_TEST_CLI
    return executable(path) ? { path, source: 'test' } : undefined
  }
  const owned = ownedCliPath(browserToolsDirectory(env, home), arch)
  if (executable(owned) && !isLink(owned)) return { path: owned, source: 'trezi' }
  const skipped = skip.map((dir) => resolve(dir))
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir.startsWith('/') || skipped.includes(resolve(dir)) || dir.includes('/node_modules/')) continue
    const path = join(dir, 'agent-browser')
    if (executable(path)) return { path: realpathSync(path), source: 'path' }
  }
  return undefined
}

/** `chromium_headless_shell-<revision>` folders of one Playwright cache, newest first. */
function shellIn(cache, arch) {
  let names
  try {
    names = readdirSync(cache)
  } catch {
    return undefined
  }
  const candidates = names
    .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))
  for (const name of candidates) {
    const path = join(cache, name, `chrome-headless-shell-mac-${macArch(arch)}/chrome-headless-shell`)
    let real
    try {
      real = realpathSync(path)
    } catch {
      continue
    }
    if (basename(real) === 'chrome-headless-shell' && !real.includes('.app/') && executable(real))
      return { path: real, revision: Number(name.split('-').at(-1)) }
  }
  return undefined
}

/** `{ path, source, revision }` of the dedicated headless shell, or undefined. */
export function findShell({ env = process.env, home = homedir(), arch = process.arch } = {}) {
  if (testing(env) && env.TREZI_BROWSER_TEST_SHELL) {
    const path = env.TREZI_BROWSER_TEST_SHELL
    return basename(path) === 'chrome-headless-shell' && executable(path)
      ? { path, source: 'test' }
      : undefined
  }
  const owned = shellIn(join(browserToolsDirectory(env, home), 'ms-playwright'), arch)
  if (owned) return { ...owned, source: 'trezi' }
  const shared = shellIn(join(home, 'Library/Caches/ms-playwright'), arch)
  return shared && { ...shared, source: 'playwright' }
}

export const cliVersionNumber = (text) => /(\d+\.\d+\.\d+[\w.-]*)/.exec(text ?? '')?.[1]
export const shellVersionNumber = (text) => /(\d+\.\d+\.\d+\.\d+)/.exec(text ?? '')?.[1]
export const testedCli = (version) => !!version && (version === CLI_SERIES || version.startsWith(`${CLI_SERIES}.`))

/**
 * A tool by name on PATH or in the usual Homebrew folders (a GUI launch may lack them);
 * a test run sees only its fixture PATH.
 */
export function findTool(name, env = process.env) {
  const extra = testing(env) ? [] : ['/opt/homebrew/bin', '/usr/local/bin']
  const dirs = [...(env.PATH ?? '').split(delimiter), ...extra]
  for (const dir of dirs) {
    if (!dir.startsWith('/')) continue
    const path = join(dir, name)
    if (executable(path)) return path
  }
  return undefined
}

const nodeMajor = (version) => Number(/^v?(\d+)\./.exec(version ?? '')?.[1] ?? 0)

/** Only macOS on Apple silicon or Intel has both a CLI binary and a headless shell. */
export function platformSupport(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') return { ok: false, reason: 'Chromium checks run only on macOS.' }
  if (arch !== 'arm64' && arch !== 'x64')
    return { ok: false, reason: `There is no agent-browser or headless shell build for this Mac (${arch}).` }
  return { ok: true }
}

/**
 * The first line of `<tool> --version`, without blocking the caller (the backend's event
 * loop). Always settles within `timeout`: at the limit the tool's whole process group is
 * killed with SIGKILL (a broken or partial tool may ignore TERM or hold its pipes open) and
 * the answer is undefined.
 */
export function toolVersionAsync(path, env = process.env, timeout = 8000) {
  return new Promise((done) => {
    let child
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(value)
    }
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    }
    const timer = setTimeout(() => {
      if (child) killGroup()
      finish(undefined)
    }, timeout)
    try {
      child = spawn(path, ['--version'], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return finish(undefined)
    }
    child.on('error', () => finish(undefined))
    child.stdout.on('data', (chunk) => {
      if (out.length < 64 * 1024) out += chunk
    })
    child.on('close', (code) =>
      finish(code === 0 ? out.trim().split('\n')[0]?.slice(0, 200) || undefined : undefined)
    )
  })
}

/** Everything Settings shows: found tools with versions, prerequisites and platform support. */
export async function detectBrowserTools({
  env = process.env,
  home = homedir(),
  skip = [],
  platform = process.platform,
  arch = process.arch,
  probeTimeout = 8000
} = {}) {
  const cliFound = findCli({ env, home, skip, arch })
  const shellFound = findShell({ env, home, arch })
  const node = findTool('node', env)
  const [cliText, shellText, nodeText] = await Promise.all([
    cliFound && toolVersionAsync(cliFound.path, env, probeTimeout),
    shellFound && toolVersionAsync(shellFound.path, env, probeTimeout),
    node && toolVersionAsync(node, env, Math.min(probeTimeout, 5000))
  ])
  const cliVersion = cliVersionNumber(cliText)
  return {
    tools: browserToolsDirectory(env, home),
    platform: platformSupport(platform, arch),
    cli: cliFound && { ...cliFound, version: cliVersion, tested: testedCli(cliVersion) },
    shell: shellFound && { ...shellFound, version: shellVersionNumber(shellText) },
    prerequisites: {
      node: node ? { path: node, version: nodeText, major: nodeMajor(nodeText) } : undefined,
      npm: findTool('npm', env),
      npx: findTool('npx', env),
      brew: findTool('brew', env)
    }
  }
}

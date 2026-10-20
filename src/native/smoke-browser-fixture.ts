import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCAL-WEBKIT-4: scripted stand-ins for Settings → Browser Checks (the unit tests and the
 * native smoke). Nothing here downloads or installs anything real:
 * - `node`, `npm` and `npx` in `<dir>/bin`, which "install" by copying the fake CLI and
 *   shell from `<dir>/payload` into the prefix / PLAYWRIGHT_BROWSERS_PATH they are given;
 * - a fake agent-browser 0.26.0 whose `open` starts `/bin/sleep` named like a headless
 *   shell with this session's profile (so the launch check can see a "fresh browser");
 * - mode files (`<dir>/mode-npm`, `mode-npx`, `mode-cli`) choose ok, fail or slow runs.
 * The fake npm prints a token-like value so the service's redaction is exercised.
 */

/** `url-fail`: `get url` prints success JSON but exits 1; `close-fail`: `close` fails and leaves the browser. */
export type FixtureMode =
  | 'ok'
  | 'fail'
  | 'slow'
  | 'no-browser'
  | 'url-fail'
  | 'close-fail'
  | 'both-fail'
export interface BrowserFixture {
  dir: string
  bin: string
  payload: { cli: string; shell: string }
  mode(tool: 'npm' | 'npx' | 'cli', mode: FixtureMode): void
  /** What the scripted `node --version` prints. */
  nodeVersion(version: string): void
}

export const FIXTURE_SHELL_VERSION = '149.0.7827.55'
export const FIXTURE_REVISION = 1228
/** Printed by the fake npm; the service must never forward it. */
export const FIXTURE_SECRET = 'npm_FixtureSecretToken1234567890'

const script = (path: string, text: string) => {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

export const fakeCliScript = (modeFile: string, version = '0.26.0') => `#!/bin/bash
if [ "$1" = "--version" ]; then echo "agent-browser ${version}"; exit 0; fi
mode=$(cat ${JSON.stringify(modeFile)} 2>/dev/null || echo ok)
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --session|--config|--headed) shift 2;;
    --executable-path) shell="$2"; shift 2;;
    --profile) profile="$2"; shift 2;;
    --json) shift;;
    *) args+=("$1"); shift;;
  esac
done
case "\${args[0]}" in
  open)
    if [ "$mode" = "fail" ]; then echo '{"success":false,"error":"Chromium exited during startup"}'; exit 1; fi
    if [ "$mode" != "no-browser" ]; then
      (exec -a "$shell --headless --user-data-dir=$profile" /bin/sleep 60) </dev/null >/dev/null 2>&1 &
      printf '%s\\t%s\\n' "$!" "$shell --headless --user-data-dir=$profile" > "$profile/launched"
    fi
    echo '{"success":true,"data":{"url":"about:blank"}}';;
  get)
    echo '{"success":true,"data":{"url":"about:blank"}}'
    if [ "$mode" = "url-fail" ] || [ "$mode" = "both-fail" ]; then exit 1; fi;;
  close)
    if [ "$mode" = "close-fail" ] || [ "$mode" = "both-fail" ]; then echo '{"success":false,"error":"daemon did not answer"}'; exit 1; fi
    if [ -f "$profile/launched" ]; then kill "$(cut -f1 "$profile/launched")" 2>/dev/null; fi
    echo '{"success":true,"data":null}';;
  *) echo '{"success":false,"error":"unsupported in the fixture"}'; exit 1;;
esac
`

export const fakeShellScript = () => `#!/bin/bash\necho "Chromium ${FIXTURE_SHELL_VERSION}"\n`

/** The scripted `npm install --prefix … agent-browser@<version>` and `npx … playwright install`. */
const fakeInstaller = (dir: string, tool: 'npm' | 'npx') => `#!/bin/bash
mode=$(cat ${JSON.stringify(join(dir, `mode-${tool}`))} 2>/dev/null || echo ok)
printf '%s\\n' "$*" >> ${JSON.stringify(join(dir, `${tool}-argv`))}
echo $$ > ${JSON.stringify(join(dir, `${tool}-pid`))}
env > ${JSON.stringify(join(dir, `${tool}-env`))}
echo "${tool} http fetch GET 200 https://registry.npmjs.org/agent-browser 31ms (authorization: Bearer ${FIXTURE_SECRET})"
if [ "$mode" = "slow" ]; then echo "Downloading Chromium Headless Shell ${FIXTURE_SHELL_VERSION}"; exec /bin/sleep 120; fi
if [ "$mode" = "fail" ]; then echo "npm error code ENOTFOUND" >&2; echo "npm error network request to https://registry.npmjs.org failed" >&2; exit 1; fi
${
  tool === 'npm'
    ? `prefix=""; while [ $# -gt 0 ]; do if [ "$1" = "--prefix" ]; then prefix="$2"; fi; shift; done
package="$prefix/node_modules/agent-browser"
mkdir -p "$package/bin"
printf '{"name":"agent-browser","version":"0.26.0"}\\n' > "$package/package.json"
for arch in arm64 x64; do cp ${JSON.stringify(join(dir, 'payload/agent-browser'))} "$package/bin/agent-browser-darwin-$arch"; chmod 644 "$package/bin/agent-browser-darwin-$arch"; done
echo "added 1 package in 1s"`
    : `for arch in arm64 x64; do
  target="$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-${FIXTURE_REVISION}/chrome-headless-shell-mac-$arch"
  mkdir -p "$target"; cp ${JSON.stringify(join(dir, 'payload/chrome-headless-shell'))} "$target/chrome-headless-shell"
  touch "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-${FIXTURE_REVISION}/INSTALLATION_COMPLETE"
done
echo "Chromium Headless Shell ${FIXTURE_SHELL_VERSION} downloaded to $PLAYWRIGHT_BROWSERS_PATH"`
}
`

/** The fixture folder: scripted tools in `bin` (when `npm` is true) and the payloads. */
export function writeBrowserFixture(dir: string, options: { npm?: boolean } = {}): BrowserFixture {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'payload'), { recursive: true })
  const payload = {
    cli: join(dir, 'payload/agent-browser'),
    shell: join(dir, 'payload/chrome-headless-shell')
  }
  script(payload.cli, fakeCliScript(join(dir, 'mode-cli')))
  script(payload.shell, fakeShellScript())
  const versionFile = join(dir, 'node-version')
  writeFileSync(versionFile, 'v22.11.0\n')
  if (options.npm !== false) {
    script(join(bin, 'node'), `#!/bin/bash\ncat ${JSON.stringify(versionFile)}\n`)
    script(join(bin, 'npm'), fakeInstaller(dir, 'npm'))
    script(join(bin, 'npx'), fakeInstaller(dir, 'npx'))
  }
  return {
    dir,
    bin,
    payload,
    mode: (tool, mode) => writeFileSync(join(dir, `mode-${tool}`), `${mode}\n`),
    nodeVersion: (version) => writeFileSync(versionFile, `${version}\n`)
  }
}

/** The argv lines a scripted installer was run with. */
export function installerArgv(dir: string, tool: 'npm' | 'npx'): string[] {
  const file = join(dir, `${tool}-argv`)
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

/** The last run's pid and environment (`KEY=value` lines), or undefined before any run. */
export function installerRun(dir: string, tool: 'npm' | 'npx') {
  const pid = join(dir, `${tool}-pid`)
  if (!existsSync(pid)) return undefined
  const env: Record<string, string> = {}
  for (const line of readFileSync(join(dir, `${tool}-env`), 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
  }
  return { pid: Number(readFileSync(pid, 'utf8').trim()), env }
}

/**
 * The fake CLI's launches under the wrapper's session root, as `ps` would list them
 * (pid and command), only while that process lives. For hosts where `ps` is unavailable.
 */
export function fixtureProcessList(root: string) {
  return async () => {
    const entries: { pid: number; command: string }[] = []
    let bases: string[] = []
    try {
      bases = readdirSync(root)
    } catch {}
    for (const base of bases) {
      const file = join(root, base, 'p/launched')
      if (!existsSync(file)) continue
      const [pid, command] = readFileSync(file, 'utf8').trim().split('\t')
      try {
        process.kill(Number(pid), 0)
        entries.push({ pid: Number(pid), command })
      } catch {}
    }
    return entries
  }
}

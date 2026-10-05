// S15/LKM-116 install, launch and update, end to end through the real `install.sh` and
// `bin/trezi` (with `bin/trezi.mjs` for updates) against a local origin. The installer
// runs as the one-liner does (`curl … | bash -s -- …`, the script on stdin) and as
// `./install.sh` inside a checkout. Stand-ins: Bun's `install`/`run build` (scripted, so
// nothing is downloaded or compiled), `curl` (serves a fake Bun installer; the real one
// never runs), `xcode-select` (scripted command-line tools; the real installer never
// runs), `git clone` (redirected to the local origin, so nothing leaves the machine),
// `claude` (a signed-out CLI), `open` and `lsregister` (recorded, so no app starts and
// LaunchServices is untouched) and the Applications folder (a scratch one).
// Covers a clean install on a Mac without Bun or the command-line tools, channels
// (default main, --channel candidate, TREZI_CHANNEL), in-checkout development installs
// (no clone, branch switch or pull without --update), installer re-runs, --no-open, the
// skipped setup-token offer, launches, updates, an interrupted update, a diverged
// checkout and lockfile drift. This proves the scripts, not a real Xcode build or a
// launched app.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostVersions, platformProblems } from '../scripts/requirements.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const problems = platformProblems({ ...hostVersions({ sdk: true }) })
if (problems.length) {
  console.log(
    `INSTALL-UPDATE SKIP — this machine cannot run the installer's own platform check: ${problems.join(' ')}`
  )
  process.exit(0)
}
assert.equal(
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.setup,
  'bash ./install.sh',
  '`bun run setup` is the installer'
)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-install-update-')))
const home = join(scratch, 'home'),
  shims = join(scratch, 'shims'),
  bunDir = join(scratch, 'bun-bin'),
  state = join(scratch, 'state')
for (const dir of [home, shims, bunDir, state]) mkdirSync(dir)
const trezi = join(home, '.trezi')
const REPO_URL = 'https://github.com/alikimovich/trezi.git'
const lines = (name) =>
  existsSync(join(state, name))
    ? readFileSync(join(state, name), 'utf8').trim().split('\n').filter(Boolean)
    : []
const log = () => lines('calls.log')
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const shim = (dir, name, body) => {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}
// Bun runs scripts and answers --version for real; install and build are recorded (and can be told to fail).
shim(
  bunDir,
  'bun',
  `[ -f "$1" ] && exec "${process.execPath}" "$@" # the launcher's shebang passes the symlink path
case "$1" in
  *.mjs|--version|-v) exec "${process.execPath}" "$@";;
  install) echo "install $(git rev-parse --short HEAD)" >> "$TEST_STATE/calls.log"; [ -f "$TEST_STATE/fail-install" ] && exit 1; exit 0;;
  run) echo "run $2 $(git rev-parse --short HEAD)" >> "$TEST_STATE/calls.log"
    if [ -f "$TEST_STATE/fail-build" ]; then echo "build failed (fixture)" >&2; exit 1; fi
    mkdir -p out/native/Trezi.app/Contents/MacOS out/native/Trezi.app/Contents/Helpers out/native/Trezi.app/Contents/Resources/backend && : > out/native/Trezi.app/Contents/Resources/backend/index.cjs && : > out/native/TreziService
    : > out/native/Trezi.app/Contents/MacOS/TreziHost && : > out/native/Trezi.app/Contents/Helpers/bun; exit 0;;
esac
exit 2`
)
// The only download the installer may make is Bun's installer; this one copies the shim above.
writeFileSync(
  join(state, 'bun-installer.sh'),
  `dest="\${BUN_INSTALL:-$HOME/.bun}/bin"; mkdir -p "$dest" && cp "${join(bunDir, 'bun')}" "$dest/bun"\n`
)
shim(
  shims,
  'curl',
  `case "$*" in
  *https://bun.sh/install*) echo bun.sh/install >> "$TEST_STATE/installers.log"; cat "$TEST_STATE/bun-installer.sh";;
  *) echo "curl is not allowed here: $*" >&2; exit 1;;
esac`
)
// Missing tools (clt-missing): --install starts the installer, which finishes one poll later.
shim(
  shims,
  'xcode-select',
  `case "$1" in
  -p) [ -f "$TEST_STATE/clt-missing" ] && exit 2
    if [ -f "$TEST_STATE/clt-installing" ]; then rm "$TEST_STATE/clt-installing"; echo wait >> "$TEST_STATE/xcode-select.log"; exit 2; fi
    echo /Library/Developer/CommandLineTools;;
  --install) echo --install >> "$TEST_STATE/xcode-select.log"; [ -f "$TEST_STATE/clt-missing" ] || exit 1; mv "$TEST_STATE/clt-missing" "$TEST_STATE/clt-installing";;
  *) exit 2;;
esac`
)
// Every git call is recorded; a clone of the GitHub URL is redirected to the local origin.
shim(
  shims,
  'git',
  `echo "$*" >> "$TEST_STATE/git.log"
if [ "$1" = clone ]; then for a; do shift; case $a in https://*) set -- "$@" "$TEST_ORIGIN";; *) set -- "$@" "$a";; esac; done; fi
exec "${realGit}" "$@"`
)
shim(
  shims,
  'claude',
  `echo "$*" >> "$TEST_STATE/claude.log"
case "$1 \${2-}" in
  "auth --help") echo "  status [options]  Show authentication status";;
  "auth status") [ -f "$TEST_STATE/claude-authorized" ] && exit 0; echo '{"loggedIn": false}'; exit 1;;
  *) exit 3;;
esac`
)
shim(shims, 'open', 'printf "%s\\n" "$@" > "$TEST_STATE/opened"')
shim(shims, 'lsregister', 'echo "$@" >> "$TEST_STATE/lsregister.log"')
shim(shims, 'agent-browser', 'exit 0') // the installer's optional step is skipped when it is present (no terminal prompt)
const applications = join(scratch, 'Applications')
mkdirSync(applications)
const system = '/usr/bin:/bin:/usr/sbin:/sbin'
const env = {
  HOME: home,
  PATH: `${shims}:${bunDir}:${system}`,
  SHELL: '/bin/zsh',
  TEST_STATE: state,
  TEST_ORIGIN: join(scratch, 'origin.git'),
  TREZI_APPLICATIONS: applications,
  TREZI_LSREGISTER: join(shims, 'lsregister'),
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com'
}

/** Runs a command in its own session (no controlling terminal), bounded. */
function exec(command, args, { cwd = scratch, extra = {}, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extra },
      detached: true,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    })
    if (input !== null) child.stdin.end(input)
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}
const installer = readFileSync(join(root, 'install.sh'), 'utf8')
/** `curl … | bash -s -- <args>`: the installer read from stdin, as the one-liner runs it. */
const piped = (args = [], extra = {}) =>
  exec('bash', ['-s', '--', ...args], { extra, input: installer })
const git = (cwd, ...args) =>
  execFileSync(realGit, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' }).trim()
/** The git calls since `from` that could move a checkout. */
const moves = (from) =>
  lines('git.log')
    .slice(from)
    .filter((line) => /(^|\s)(clone|pull|fetch|checkout|switch)(\s|$)/.test(line))

// The origin: a small Trezi with the real launcher, installer and requirements, and a
// candidate branch ahead of main.
const seed = join(scratch, 'seed')
git(scratch, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git')
git(scratch, 'init', '-q', '--initial-branch=main', 'seed')
for (const dir of ['bin', 'scripts']) mkdirSync(join(seed, dir))
for (const file of ['bin/trezi', 'bin/trezi.mjs', 'scripts/requirements.mjs', 'install.sh'])
  copyFileSync(join(root, file), join(seed, file))
for (const file of ['bin/trezi', 'install.sh']) chmodSync(join(seed, file), 0o755)
writeFileSync(
  join(seed, 'package.json'),
  JSON.stringify({ name: 'trezi', version: '1.0.0', scripts: { build: 'x' } })
)
writeFileSync(join(seed, 'bun.lock'), 'lock 1\n')
git(seed, 'add', '-A')
git(seed, 'commit', '-qm', 'one')
git(seed, 'remote', 'add', 'origin', env.TEST_ORIGIN)
git(seed, 'push', '-q', 'origin', 'main')
const release = (name, branch = 'main') => {
  git(seed, 'checkout', '-q', branch)
  writeFileSync(join(seed, `${name}.txt`), `${name}\n`)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-qm', name)
  git(seed, 'push', '-q', 'origin', branch)
  git(seed, 'checkout', '-q', 'main')
}
git(seed, 'branch', 'candidate')
release('candidate-one', 'candidate')
const tip = (branch) => git(seed, 'rev-parse', '--short', branch)
const app = join(trezi, 'out/native/Trezi.app')
const built = (checkout = trezi) =>
  [
    'out/native/Trezi.app/Contents/Resources/backend/index.cjs',
    'out/native/TreziService',
    'out/native/Trezi.app/Contents/MacOS/TreziHost',
    'out/native/Trezi.app/Contents/Helpers/bun'
  ].every((path) => existsSync(join(checkout, path)))
const step = (line) => (line.startsWith('run') ? 'run build' : 'install')
const head = (checkout = trezi) => git(checkout, 'rev-parse', '--short', 'HEAD')
const branch = (checkout = trezi) => git(checkout, 'branch', '--show-current')
/** What the command asked `open` for (and clears it). */
function opened() {
  const args = readFileSync(join(state, 'opened'), 'utf8').trim().split('\n')
  rmSync(join(state, 'opened'))
  return args
}

try {
  // Clean install through the one-liner on a Mac without Bun or the command-line tools:
  // both are installed first, then clone (main), platform check, install, build, links, open.
  writeFileSync(join(state, 'clt-missing'), '')
  // The retired pre-rename alias goes when it points at this checkout; another is kept.
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  symlinkSync(join(trezi, 'bin/trezi'), join(home, '.local/bin/praxis'))
  const install = await piped([], { PATH: `${shims}:${system}` })
  assert.equal(install.code, 0, `install.sh: ${install.stdout}\n${install.stderr}`)
  assert.deepEqual(
    lines('xcode-select.log'),
    ['--install', 'wait'],
    'the tools installer ran and the script waited for it'
  )
  assert.match(install.stdout, /A macOS window asks to install the command-line tools/)
  assert.match(install.stdout, /Command-line tools installed\./)
  assert.deepEqual(lines('installers.log'), ['bun.sh/install'], "Bun's official installer ran once")
  assert.ok(existsSync(join(home, '.bun/bin/bun')))
  assert.match(install.stdout, /Using Bun at .*\/\.bun\/bin\/bun/)
  assert.deepEqual(
    moves(0),
    [`clone --branch main ${REPO_URL} ${trezi}`],
    'the default channel is main'
  )
  assert.equal(branch(), 'main')
  assert.match(install.stdout, /Cloning Trezi \(main channel\) into/)
  assert.match(install.stdout, /Trezi installed to/)
  assert.deepEqual(log().map(step), ['install', 'run build'])
  assert.ok(built(), 'the build produced the host, the service and the Bun bundle')
  assert.ok(lstatSync(join(home, '.local/bin/trezi')).isSymbolicLink())
  assert.equal(readlinkSync(join(home, '.local/bin/trezi')), join(trezi, 'bin/trezi'))
  assert.throws(
    () => lstatSync(join(home, '.local/bin/praxis')),
    /ENOENT/,
    'the pre-rename alias is removed'
  )
  assert.match(
    install.stdout,
    new RegExp(`The trezi command and Trezi\\.app now point to this checkout: ${trezi}`)
  )
  // Applications gets a link to the built app, and LaunchServices is told about it.
  assert.ok(lstatSync(join(applications, 'Trezi.app')).isSymbolicLink())
  assert.equal(readlinkSync(join(applications, 'Trezi.app')), app)
  assert.equal(readFileSync(join(state, 'lsregister.log'), 'utf8'), `-f ${app}\n`)
  // Finish: the signed-out Claude CLI gets no setup-token run without a terminal; Trezi opens.
  assert.match(
    install.stdout,
    /Claude Code is not authorized yet\.\nSkipped \(no terminal\)\. Authorize later with: claude setup-token/
  )
  assert.deepEqual(lines('claude.log'), ['auth --help', 'auth status'])
  assert.deepEqual(opened(), ['-a', app], 'the installer opens Trezi')
  console.log(
    'install-update: one-liner clean install with Bun and the command-line tools installed, main channel, open'
  )

  // Launch through the installed command (`open -a`): with the build present nothing is rebuilt.
  const calls = log().length
  const first = await exec(join(home, '.local/bin/trezi'), [scratch])
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(opened(), ['-a', app, scratch])
  assert.equal(log().length, calls)
  assert.equal((await exec(join(home, '.local/bin/trezi'), ['.'], { cwd: seed })).code, 0)
  assert.deepEqual(opened(), ['-a', app, seed], 'trezi . opens the current folder')
  const file = await exec(join(home, '.local/bin/trezi'), [join(seed, 'package.json')])
  assert.equal(file.code, 1)
  assert.match(file.stderr, /Not a folder/)
  assert.ok(!existsSync(join(state, 'opened')))
  // With the build missing the command builds first, then opens.
  rmSync(join(trezi, 'out'), { recursive: true })
  assert.equal((await exec(join(home, '.local/bin/trezi'), [])).code, 0)
  assert.deepEqual(opened(), ['-a', app])
  assert.equal(step(log().at(-1)), 'run build')
  assert.ok(built())
  console.log('install-update: launch with and without a build')

  // Update: pull, install, build.
  release('two')
  const updated = await exec(join(home, '.local/bin/trezi'), ['--update'])
  assert.equal(updated.code, 0, updated.stderr)
  assert.match(updated.stdout, /Updated [0-9a-f]+ → [0-9a-f]+\./)
  assert.equal(head(), tip('main'))
  assert.deepEqual(log().slice(-2).map(step), ['install', 'run build'])

  // Interrupted at the build: the pull stays, the earlier build stays usable, the next run completes.
  release('three')
  writeFileSync(join(state, 'fail-build'), '')
  const broken = await exec(join(home, '.local/bin/trezi'), ['--update'])
  assert.notEqual(broken.code, 0)
  assert.match(broken.stderr, /Update failed while running `bun run build`/)
  assert.equal(head(), tip('main'), 'the pull was not undone or repeated')
  assert.ok(built(), 'a failed rebuild leaves the previous build in place')
  rmSync(join(state, 'fail-build'))
  const resumed = await exec(join(home, '.local/bin/trezi'), ['--update'])
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.match(resumed.stdout, /already up to date/)
  assert.equal(step(log().at(-1)), 'run build')
  assert.ok(built())
  console.log('install-update: update, interrupted update resumed')

  // A checkout that cannot fast-forward stops before installing or building, and keeps its own commit.
  writeFileSync(join(trezi, 'mine.txt'), 'local\n')
  git(trezi, 'add', '-A')
  git(trezi, 'commit', '-qm', 'local work')
  release('four')
  const before = { head: head(), calls: log().length }
  const diverged = await exec(join(home, '.local/bin/trezi'), ['--update'])
  assert.notEqual(diverged.code, 0)
  assert.match(diverged.stderr, /git pull --ff-only/)
  assert.match(diverged.stderr, /commit or stash/)
  assert.deepEqual({ head: head(), calls: log().length }, before)
  assert.ok(existsSync(join(trezi, 'mine.txt')))
  git(trezi, 'reset', '-q', '--hard', 'origin/main')

  // Regenerated lockfile drift never blocks an update, through `trezi --update` or the installer.
  release('five')
  writeFileSync(join(trezi, 'bun.lock'), 'lock drifted by an install\n')
  const drift = await exec(join(home, '.local/bin/trezi'), ['--update'])
  assert.equal(drift.code, 0, drift.stderr)
  assert.match(drift.stdout, /Discarding local bun\.lock changes/)
  assert.equal(readFileSync(join(trezi, 'bun.lock'), 'utf8'), 'lock 1\n')

  // Running the installer again updates in place and rebuilds; nothing is reinstalled and
  // --no-open opens nothing.
  release('six')
  writeFileSync(join(trezi, 'bun.lock'), 'lock drifted by an install\n')
  const rerunFrom = log().length
  const again = await piped(['--no-open'])
  assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`)
  assert.match(again.stdout, /Updating existing install/)
  assert.match(again.stdout, /Discarding local bun\.lock changes/)
  assert.match(again.stdout, /Channel: main/)
  assert.equal(head(), tip('main'))
  assert.equal(branch(), 'main')
  assert.ok(built())
  assert.deepEqual(log().slice(rerunFrom), [`install ${tip('main')}`, `run build ${tip('main')}`])
  assert.ok(!existsSync(join(state, 'opened')), '--no-open')
  assert.equal(lines('installers.log').length, 1, 'Bun is not reinstalled')
  assert.equal(lines('xcode-select.log').length, 2, 'nor are the tools')
  console.log(
    'install-update: diverged checkout refused, lockfile drift, idempotent installer re-run, --no-open'
  )

  // Channels. TREZI_CHANNEL switches an existing install; a re-run without a channel keeps
  // it; --channel=main switches back; a fresh --channel candidate install clones candidate.
  const toCandidate = await piped(['--no-open'], { TREZI_CHANNEL: 'candidate' })
  assert.equal(toCandidate.code, 0, `${toCandidate.stdout}\n${toCandidate.stderr}`)
  assert.match(toCandidate.stdout, /Switching to the candidate channel/)
  assert.equal(branch(), 'candidate')
  assert.equal(head(), tip('candidate'))
  assert.equal(log().at(-1), `run build ${tip('candidate')}`)
  release('candidate-two', 'candidate')
  const stays = await piped(['--no-open'])
  assert.equal(stays.code, 0, stays.stderr)
  assert.doesNotMatch(stays.stdout, /Switching/)
  assert.equal(branch(), 'candidate')
  assert.equal(head(), tip('candidate'), 'a re-run keeps and updates the installed channel')
  const back = await piped(['--no-open', '--channel=main'])
  assert.equal(back.code, 0, back.stderr)
  assert.equal(branch(), 'main')
  assert.equal(head(), tip('main'))
  const tester = join(scratch, 'tester')
  const cloneFrom = lines('git.log').length
  const fresh = await piped(['--no-open', '--channel', 'candidate'], { TREZI_HOME: tester })
  assert.equal(fresh.code, 0, `${fresh.stdout}\n${fresh.stderr}`)
  assert.deepEqual(moves(cloneFrom), [`clone --branch candidate ${REPO_URL} ${tester}`])
  assert.equal(branch(tester), 'candidate')
  assert.ok(built(tester))
  assert.equal(
    readlinkSync(join(home, '.local/bin/trezi')),
    join(tester, 'bin/trezi'),
    'the last install owns the links'
  )
  assert.equal(readlinkSync(join(applications, 'Trezi.app')), join(tester, 'out/native/Trezi.app'))
  assert.match(fresh.stdout, new RegExp(`They pointed to ${trezi} before`))
  // An unknown channel stops before anything runs.
  const refused = { calls: log().length, git: lines('git.log').length }
  const unknown = await piped(['--channel', 'beta'])
  assert.notEqual(unknown.code, 0)
  assert.match(unknown.stderr, /unknown channel 'beta'/)
  assert.deepEqual({ calls: log().length, git: lines('git.log').length }, refused)
  console.log(
    'install-update: channels (TREZI_CHANNEL, kept on re-run, --channel=main, fresh --channel candidate, unknown refused)'
  )

  // Development: ./install.sh inside a checkout on its own branch installs, builds and links
  // that checkout as it is — no clone, branch switch or pull, and ~/.trezi is untouched.
  const dev = join(scratch, 'dev')
  git(scratch, 'clone', '-q', env.TEST_ORIGIN, 'dev')
  git(dev, 'checkout', '-q', '-b', 'work', '--track', 'origin/main')
  release('seven') // origin moves on; the checkout follows only with --update
  const devHead = head(dev),
    treziHead = head(),
    gitFrom = lines('git.log').length,
    devFrom = log().length
  const local = await exec('./install.sh', ['--no-open', '--channel', 'candidate'], { cwd: dev })
  assert.equal(local.code, 0, `${local.stdout}\n${local.stderr}`)
  assert.match(local.stdout, new RegExp(`Using this checkout: ${dev} \\(branch work\\)`))
  assert.match(local.stdout, /Channel 'candidate' ignored/)
  assert.deepEqual(moves(gitFrom), [], 'no clone, fetch, pull or checkout')
  assert.equal(branch(dev), 'work')
  assert.equal(head(dev), devHead)
  assert.equal(head(), treziHead)
  assert.deepEqual(log().slice(devFrom), [`install ${devHead}`, `run build ${devHead}`])
  assert.ok(built(dev))
  assert.ok(!existsSync(join(state, 'opened')))
  assert.equal(readlinkSync(join(home, '.local/bin/trezi')), join(dev, 'bin/trezi'))
  assert.equal(readlinkSync(join(applications, 'Trezi.app')), join(dev, 'out/native/Trezi.app'))
  assert.match(local.stdout, new RegExp(`now point to this checkout: ${dev}`))
  assert.match(local.stdout, new RegExp(`They pointed to ${tester} before`))
  // --update pulls the checkout's own branch first.
  const pulled = await exec('./install.sh', ['--update', '--no-open'], { cwd: dev })
  assert.equal(pulled.code, 0, `${pulled.stdout}\n${pulled.stderr}`)
  assert.match(pulled.stdout, /Updating this checkout/)
  assert.deepEqual(moves(gitFrom), [`-C ${dev} pull --ff-only`])
  assert.equal(branch(dev), 'work')
  assert.equal(head(dev), tip('main'))
  assert.equal(log().at(-1), `run build ${tip('main')}`)
  assert.doesNotMatch(pulled.stdout, /They pointed to/, 'the links already pointed here')
  // Authorized Claude: no offer at all.
  writeFileSync(join(state, 'claude-authorized'), '')
  const signedIn = await exec('./install.sh', ['--no-open'], { cwd: dev })
  assert.equal(signedIn.code, 0, signedIn.stderr)
  assert.doesNotMatch(signedIn.stdout, /Claude Code is not authorized/)
  assert.ok(
    !lines('claude.log').some((line) => line.startsWith('setup-token')),
    'setup-token never runs unattended'
  )
  console.log(
    'install-update: ./install.sh in a checkout (no clone, branch switch or pull), --update, links follow the last install'
  )
  console.log(
    'INSTALL-UPDATE OK — one-liner install with Bun and command-line tools, channels, in-checkout dev install, idempotent re-run, --no-open, setup-token offer skipped unattended, launch, update and interrupted-update resume (build, clone and installers are scripted; no real Xcode build, installer run or app launch)'
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

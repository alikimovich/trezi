import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  assertCodexHookVersion,
  managedBrowserCodexConfig,
  managedBrowserDirectory,
  managedBrowserEnv,
  managedBrowserPath,
  managedBrowserRefusal,
  managedBrowserWrapper
} = await import('../src/main/backends/managed-browser-path.ts')
const { browserCommandRefusal } = await import('../bin/trezi-browser-policy.mjs')
for (const version of ['0.159.1', 'codex-cli 0.160.1\n'])
  assert.doesNotThrow(() => assertCodexHookVersion(version))
for (const version of [null, '', 'codex-cli 0.161.0', 'codex-cli 0.146.0', '0.160.1-preview'])
  assert.throws(() => assertCodexHookVersion(version), /Provider execution is disabled/)
const repo = join(import.meta.dir, '..')

// A checkout-shaped tree: <root>/bin/managed/agent-browser, bundle in out/native,
// source in src/main/backends.
const root = mkdtempSync(join(tmpdir(), 'trezi-managed-path-'))
const managed = join(root, 'bin/managed')
mkdirSync(managed, { recursive: true })
writeFileSync(join(managed, 'agent-browser'), '')
chmodSync(join(managed, 'agent-browser'), 0o755)
const bundle = join(root, 'out/native')
const source = join(root, 'src/main/backends')
mkdirSync(bundle, { recursive: true })
mkdirSync(source, { recursive: true })

assert.equal(managedBrowserDirectory(bundle), managed, 'bundled helper base (out/native)')
assert.equal(managedBrowserDirectory(source), managed, 'source-tree base (src/main/backends)')
const empty = mkdtempSync(join(tmpdir(), 'trezi-managed-path-empty-'))
assert.equal(
  managedBrowserDirectory(join(empty, 'out/native')),
  undefined,
  'no wrapper, no directory'
)
assert.equal(
  managedBrowserDirectory(join(root, 'out/native'), () => false),
  undefined,
  'an absent wrapper is never advertised'
)

// The managed directory wins over a global agent-browser; the helper's own Bun is reachable.
const path = managedBrowserPath(
  managed,
  '/opt/homebrew/bin:/usr/bin:/bin',
  '/Applications/Trezi.app/Contents/Helpers/bun'
)
const entries = path.split(':')
assert.equal(entries[0], managed)
assert.ok(entries.indexOf(managed) < entries.indexOf('/opt/homebrew/bin'))
assert.equal(entries.at(-1), '/Applications/Trezi.app/Contents/Helpers')
assert.equal(managedBrowserPath(managed, undefined, '/x/bun'), `${managed}:/x`)
assert.equal(
  managedBrowserPath(managed, '/usr/bin:/x', '/x/bun'),
  `${managed}:/usr/bin:/x`,
  'the interpreter directory is not duplicated'
)

// --- LKM-269: the route survives a real login shell -----------------------------------
// The wrapper is the stub `MANAGED`; a global CLI (`GLOBAL`) sits earlier on PATH like
// Homebrew's. A throwaway ZDOTDIR + HOME stand in for the login-shell profile (macOS
// path_helper / brew shellenv); nothing outside this temp dir is read or written.
const stub = (path, name) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho ${name} "$@"\n`)
  chmodSync(path, 0o755)
}
stub(join(managed, 'agent-browser'), 'MANAGED')
const globalBin = join(root, 'opt/homebrew/bin')
stub(join(globalBin, 'agent-browser'), 'GLOBAL')
const profile = join(root, 'zdotdir')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, '.zprofile'), `export PATH="${globalBin}:$PATH"\n`)
const inherited = `${globalBin}:/usr/bin:/bin`
const shell = (flags, script, env) => {
  const proc = Bun.spawnSync(['/bin/zsh', flags, script], {
    env: { ...env, ZDOTDIR: profile, HOME: root },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  assert.equal(proc.exitCode, 0, proc.stderr.toString())
  return proc.stdout.toString().trim()
}
// The Trezi-owned guard, installed beside the stub wrapper like a checkout's bin/.
mkdirSync(join(root, 'bin'), { recursive: true })
for (const file of ['trezi-browser-guard.mjs', 'trezi-browser-policy.mjs'])
  copyFileSync(join(repo, 'bin', file), join(root, 'bin', file))

for (const [name, base] of [
  ['bundle (out/native)', bundle],
  ['source (src/main/backends)', source]
]) {
  const wrapper = managedBrowserWrapper(base)
  assert.equal(wrapper, join(managed, 'agent-browser'), `${name}: verified absolute wrapper`)
  const env = managedBrowserEnv(base, inherited, process.execPath)
  assert.equal(env.TREZI_AGENT_BROWSER, wrapper, `${name}: TREZI_AGENT_BROWSER`)
  assert.equal(env.PATH.split(':')[0], managed, `${name}: managed first on PATH`)
  const bare = 'command -v agent-browser'
  assert.equal(shell('-c', bare, env), wrapper, `${name}: non-login shell resolves to the wrapper`)
  // The defect: a login shell rebuilds PATH and the global CLI wins over PATH alone.
  assert.equal(
    shell('-lc', bare, env),
    join(globalBin, 'agent-browser'),
    `${name}: fixture reproduces the login-shell PATH reorder`
  )
  for (const flags of ['-c', '-lc'])
    assert.equal(
      shell(flags, '"$TREZI_AGENT_BROWSER" open x', env),
      'MANAGED open x',
      `${name}: absolute wrapper wins in ${flags}`
    )

  // Codex dispatch boundary: its shell tool gets the fragment's environment, and with login
  // shells off (`allow_login_shell = false`) it runs `-c`, so even a bare name resolves.
  const config = managedBrowserCodexConfig(base, inherited, process.execPath)
  assert.equal(config.allow_login_shell, false, `${name}: Codex login shells off`)
  assert.deepEqual(config.shell_environment_policy.set, env, `${name}: Codex shell environment`)
  const codexShell = config.allow_login_shell === false ? '-c' : '-lc'
  const codexEnv = { ...config.shell_environment_policy.set }
  assert.equal(
    shell(codexShell, bare, codexEnv),
    wrapper,
    `${name}: Codex shell resolves the wrapper`
  )
  assert.equal(shell(codexShell, '"$TREZI_AGENT_BROWSER" ok', codexEnv), 'MANAGED ok')

  // The Codex PreToolUse hook command from the config, run for real.
  const [entry] = config.hooks.PreToolUse
  assert.equal(entry.matcher, '^Bash$')
  const hook = (command) => {
    const proc = Bun.spawnSync(['/bin/sh', '-c', entry.hooks[0].command], {
      stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', tool_input: { command } })),
      stdout: 'pipe',
      stderr: 'pipe'
    })
    assert.equal(proc.exitCode, 0, proc.stderr.toString())
    const out = proc.stdout.toString()
    return out ? JSON.parse(out).hookSpecificOutput : null
  }
  const refused = [
    'agent-browser open http://x --session trezi-a',
    'echo $(agent-browser open http://x --session trezi-a)',
    'echo $(/opt/homebrew/bin/agent-browser open http://x --session trezi-a)',
    'printf "%s" `agent-browser open http://x --session trezi-a`',
    'echo $("$TREZI_AGENT_BROWSER" snapshot --session trezi-a)',

    'command agent-browser open http://x --session trezi-a',
    'command command agent-browser open http://x --session trezi-a',
    'command -p agent-browser open http://x --session trezi-a',
    'command -p -- command -p -- agent-browser open http://x --session trezi-a',
    'builtin command agent-browser open http://x --session trezi-a',
    'env command agent-browser open http://x --session trezi-a',
    'command /opt/homebrew/bin/agent-browser open http://x --session trezi-a',
    'command -- /opt/homebrew/bin/agent-browser open http://x --session trezi-a',
    'cd app && agent-browser open http://x',
    '/opt/homebrew/bin/agent-browser open http://x --session trezi-a',
    `${managed}/../../node_modules/.bin/agent-browser open x`,
    '"$TREZI_AGENT_BROWSER" --headed open http://x --session trezi-a',
    `${wrapper} --executable-path "/Applications/Google Chrome.app" open x`,
    '"$TREZI_AGENT_BROWSER" --cdp 9222 snapshot --session trezi-a',
    '"$TREZI_AGENT_BROWSER" close --all --session trezi-a',
    'TREZI_AGENT_BROWSER=/opt/homebrew/bin/agent-browser "$TREZI_AGENT_BROWSER" open x',
    'export TREZI_AGENT_BROWSER=/x; "$TREZI_AGENT_BROWSER" open x',
    'PATH=/opt/homebrew/bin:$PATH agent-browser open x',
    "bash -lc 'agent-browser open x'",
    'npx agent-browser open x',
    'env agent-browser open x'
  ]
  for (const command of refused) {
    assert.ok(browserCommandRefusal(command, wrapper), `${name}: direct parser refuses ${command}`)
    const decision = hook(command)
    assert.equal(decision?.permissionDecision, 'deny', `${name}: hook refuses ${command}`)
    assert.match(decision.permissionDecisionReason, /TREZI_AGENT_BROWSER|unavailable|system Chrome/)
    assert.doesNotMatch(decision.permissionDecisionReason, /reinstall|preview_evaluate\s+instead/i)
    assert.equal(
      managedBrowserRefusal(base, 'Bash', { command }),
      decision.permissionDecisionReason,
      `${name}: Claude and Codex hooks agree on ${command}`
    )
  }
  const allowed = [
    '"$TREZI_AGENT_BROWSER" open http://x --session trezi-a',
    `${wrapper} snapshot --session trezi-a`,
    `"${wrapper}" screenshot /tmp/a.png --session trezi-a`,
    'command -v agent-browser',
    'command -V agent-browser',
    'command -p -v agent-browser',
    'command command -V agent-browser',
    `command -p -- command -- ${wrapper} snapshot --session trezi-a`,
    'which agent-browser',
    'git status',
    'echo agent-browser is managed'
  ]
  for (const command of allowed) {
    assert.equal(hook(command), null, `${name}: hook allows ${command}`)
    assert.equal(managedBrowserRefusal(base, 'Bash', { command }), null)
  }
  assert.equal(managedBrowserRefusal(base, 'Read', { command: 'agent-browser x' }), null)
}

// An unusable install never advertises a route, and does not blame the browser or the CLI.
const bare = mkdtempSync(join(tmpdir(), 'trezi-managed-path-bare-'))
const bareBase = join(bare, 'out/native')
mkdirSync(bareBase, { recursive: true })
assert.deepEqual(managedBrowserEnv(bareBase, '/usr/bin', '/x/bun'), {})
assert.throws(() => managedBrowserCodexConfig(bareBase), /managed browser guard is missing/)
mkdirSync(join(bare, 'bin'), { recursive: true })
for (const file of ['trezi-browser-guard.mjs', 'trezi-browser-policy.mjs'])
  copyFileSync(join(repo, 'bin', file), join(bare, 'bin', file))
assert.equal('shell_environment_policy' in managedBrowserCodexConfig(bareBase), false)
assert.match(
  browserCommandRefusal('agent-browser open x', undefined),
  /Trezi install problem, not a browser or CLI dependency/
)
assert.equal(browserCommandRefusal('command -v agent-browser', undefined), null)
// A wrapper that is not executable is not a route either.
mkdirSync(join(bare, 'bin/managed'), { recursive: true })
writeFileSync(join(bare, 'bin/managed/agent-browser'), '#!/bin/sh\n')
chmodSync(join(bare, 'bin/managed/agent-browser'), 0o644)
assert.ok(managedBrowserDirectory(bareBase), 'the directory resolves')
assert.equal(managedBrowserWrapper(bareBase), undefined, 'a non-executable wrapper is refused')
assert.deepEqual(managedBrowserEnv(bareBase, '/usr/bin', '/x/bun'), {})

// The real wrapper with a global CLI around: route/policy refusals (exit 2) and missing
// dependencies (exit 3) stay distinct, and a global CLI is never a managed-verification pass.
const realWrapper = join(repo, 'bin/managed/agent-browser')
const wrapperEnv = { PATH: `${globalBin}:/usr/bin:/bin`, HOME: root }
const wrap = (args, env = wrapperEnv) => {
  const proc = Bun.spawnSync([process.execPath, realWrapper, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}
for (const flag of [
  '--headed',
  '--executable-path',
  '--profile',
  '--config',
  '--auto-connect',
  '--cdp',
  '--provider',
  '-p',
  '--engine',
  '--args',
  '--extension',
  '--session-name',
  '--state',
  '--all'
]) {
  const result = wrap(['--session', 'trezi-a', flag, 'x', 'open'])
  assert.equal(result.code, 2, `wrapper refuses ${flag}`)
  assert.equal(result.out, '', 'no browser (or global CLI) ran')
  assert.equal(
    browserCommandRefusal(`"$TREZI_AGENT_BROWSER" ${flag} x open`, '/w/agent-browser') !== null,
    true,
    `hook and wrapper agree on ${flag}`
  )
}
assert.equal(wrap(['open', 'http://x']).code, 2, 'a missing session is a policy refusal')
const noCli = wrap(['--session', 'trezi-a', 'open', 'http://x'], {
  PATH: '/usr/bin:/bin',
  HOME: root
})
assert.equal(noCli.code, 3, 'a missing Vercel CLI is a dependency error')
assert.match(noCli.err, /dependency: vercel-cli/)
assert.doesNotMatch(noCli.err, /\bPATH\b|launch route|resolv/i)
const version = wrap(['--version'])
assert.match(
  version.out,
  /^GLOBAL --version/,
  'the global CLI is only the engine behind the wrapper'
)

console.log(
  'MANAGED BROWSER PATH OK — bundle and source bases, login and non-login shells, Codex/Claude hooks, dependency vs route errors'
)

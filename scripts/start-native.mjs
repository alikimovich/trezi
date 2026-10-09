import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../src/shared/rename-compat.ts'
import { finishSmokeRun, hostLogTail, SMOKE_EXIT_ENV } from '../src/native/smoke-report.ts'
import { spawnSync } from 'node:child_process'
import { requireSupportedPlatform } from './requirements.mjs'

/** The default profile, with the legacy-profile alias made by the service (`ProfilePaths.swift`). */
export function defaultProfile(out, support = join(homedir(), 'Library/Application Support')) {
  const result = spawnSync(join(out, 'TreziService'), ['--resolve-profile', support], { encoding: 'utf8' })
  if (result.error) throw new Error(`Could not run TreziService to find the profile (${result.error.message}); run bun run build.`)
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'TreziService could not resolve the profile.')
  return result.stdout.trim()
}

/** The Bun copied into Trezi.app by the build, else the one running this script. */
export function launchBun(out, fallback = process.execPath) {
  const bundled = join(out, 'Trezi.app/Contents/Helpers/bun')
  return existsSync(bundled) ? bundled : fallback
}

/**
 * The development and test launch: the host with the arguments `HostLaunch.swift`
 * derives itself under `open -a Trezi`, plus the test profile and `--test` fixture.
 */
export function nativeServiceLaunchSpec(root, args, env, bun, testDirectory = null) {
  const out = join(root, 'out/native')
  const profile = resolve(testDirectory ? join(testDirectory, 'profile') : env.TREZI_USER_DATA || defaultProfile(out))
  return {
    command: join(out, 'Trezi.app/Contents/MacOS/TreziHost'),
    args: [out, testDirectory ? 'ephemeral' : 'persistent', '--service', '--bun', bun, '--backend', join(out, 'Trezi.app/Contents/Resources/backend/index.cjs'), '--profile', profile, '--', ...args],
    // A test run logs into its disposable folder, never ~/Library/Logs/Trezi (LKM-168).
    env: { ...env, TREZI_USER_DATA: profile, ...(testDirectory ? { TREZI_NATIVE_TEST_DIR: testDirectory, TREZI_LOG_DIR: join(testDirectory, 'logs') } : {}) },
    profile
  }
}

/**
 * The smoke run's last lines (LKM-176): Bun's `SMOKE FAIL`/`SMOKE ENV` lines from
 * `smoke-result.json`, plus a host-exit line and the host's last log lines when the host
 * crashed or exited without a result. Returns 0, 1 (product) or 3 (environment only).
 */
export function reportSmokeExit(root, testDirectory, host) {
  let result
  try { result = JSON.parse(readFileSync(join(testDirectory, 'smoke-result.json'), 'utf8')) } catch {}
  let tail = [], artifact
  const logs = join(testDirectory, 'logs')
  const log = existsSync(logs) ? readdirSync(logs).filter(name => /^trezi-.*\.log$/.test(name)).sort().at(-1) : undefined
  if (log) {
    const text = readFileSync(join(logs, log), 'utf8')
    tail = hostLogTail(text)
    if (host.signal || host.code !== 0) {
      const artifacts = join(root, 'test/artifacts/native')
      mkdirSync(artifacts, { recursive: true })
      artifact = join(artifacts, 'host-exit.log')
      writeFileSync(artifact, text)
    }
  }
  const finished = finishSmokeRun(host, result, tail, artifact)
  if (finished.lines.length) console.error(finished.lines.join('\n'))
  if (finished.exitCode === SMOKE_EXIT_ENV) console.error(`Native smoke: environment failure only; exit ${SMOKE_EXIT_ENV}.`)
  return finished.exitCode
}

async function main() {
  requireSupportedPlatform()
  const args = process.argv.slice(2)
  if (args[0] === '--wait-for-owner') {
    const pid = Number(args[1])
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid prior owner PID')
    args.splice(0, 2)
    const deadline = Date.now() + 15_000
    while (true) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
      if (Date.now() >= deadline) throw new Error('Prior service did not stop; restart refused')
      await Bun.sleep(100)
    }
  }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const testDirectory = args.includes('--test') ? mkdtempSync(join(tmpdir(), 'trezi-native-')) : null
  try {
    const spec = nativeServiceLaunchSpec(root, args, process.env, launchBun(join(root, 'out/native')), testDirectory)
    mkdirSync(spec.profile, { recursive: true })
    const child = Bun.spawn([spec.command, ...spec.args], { cwd: root, env: spec.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
    process.exitCode = await child.exited
    if (testDirectory) process.exitCode = reportSmokeExit(root, testDirectory, { code: child.exitCode, signal: child.signalCode })
  } finally {
    if (testDirectory) {
      // A failed host must not remove stores while its XPC service still drains.
      const marker = join(testDirectory, 'service-stopped')
      const deadline = Date.now() + 10_000
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(100)
      if (existsSync(marker)) rmSync(testDirectory, { recursive: true, force: true })
      else console.error(`Retained test profile pending service shutdown: ${testDirectory}`)
    }
  }
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1 })

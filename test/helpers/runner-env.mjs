// The GitHub macOS runner is not a developer Mac (LKM-142): its HOME has no Git
// identity and no global Git config, `git init` may pick another default branch, and
// there is no login keychain. Tests that run Git or `security` install this environment
// so they pass under those conditions locally too, not only on the runner. Every path
// deliberately contains a space. Nothing outside `base` is read or written: no system
// setting, no keychain search list.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Identity and config sources a developer machine has and the runner does not.
const UNSET = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'EMAIL',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'XDG_CONFIG_HOME'
]

/**
 * Runner-like variables rooted under `base`: an empty HOME whose only Git config makes
 * Git refuse to guess an identity (`user.useConfigOnly`) and names the default branch
 * `defaultBranch` (never `main`, so a test cannot rely on it); no system Git config;
 * a TMPDIR of its own. A value of `undefined` means "unset".
 */
export function runnerEnv(base, { defaultBranch = 'trunk' } = {}) {
  const dir = join(base, 'runner env')
  const home = join(dir, 'home dir'),
    temp = join(dir, 'tmp dir')
  mkdirSync(home, { recursive: true })
  mkdirSync(temp, { recursive: true })
  writeFileSync(
    join(home, '.gitconfig'),
    `[init]\n\tdefaultBranch = ${defaultBranch}\n[user]\n\tuseConfigOnly = true\n`
  )
  const env = Object.fromEntries(UNSET.map((key) => [key, undefined]))
  return Object.assign(env, {
    HOME: realpathSync(home),
    TMPDIR: `${realpathSync(temp)}/`,
    GIT_CONFIG_NOSYSTEM: '1'
  })
}

/** Installs runnerEnv(base) into process.env (children and os.tmpdir() follow it). */
export function useRunnerEnv(base, options) {
  const env = runnerEnv(base, options)
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return env
}

/** `env` with runnerEnv applied, for a single child process. */
export function withRunnerEnv(env, base, options) {
  const merged = { ...env }
  for (const [key, value] of Object.entries(runnerEnv(base, options))) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

// A scripted package manager (installed as `bun` and `npm`) for the S13 workflow
// fixtures: records every call in $FAKE_PM_STATE and fails or stalls on demand
// (`fail: {install: n, build: n, skills: n}`, `sleep: {install: ms}`, `started: {install: fifo}`).
// No network, no packages.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const file = process.env.FAKE_PM_STATE
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
state.calls ??= []; state.fail ??= {}; state.sleep ??= {}
const args = process.argv.slice(2)
const step = args[0] === 'run' ? 'build' : args[0]
// Installed as `npx` too (S15): `npx skills add <repo> … [-g] [--skill n]…` drops skill folders where the CLI would.
if (basename(process.argv[1]) === 'npx' && args[0] === 'skills' && !(state.fail.skills > 0)) {
  const target = join(args.includes('-g') ? process.env.HOME : process.cwd(), '.claude', 'skills')
  const names = args.flatMap((arg, at) => (arg === '--skill' ? [args[at + 1]] : []))
  for (const name of names.length ? names : ['all-skill']) mkdirSync(join(target, name), { recursive: true })
}
state.calls.push([basename(process.argv[1]), ...args].join(' '))
writeFileSync(file, JSON.stringify(state, null, 2))
process.stdout.write(`${step}: resolving\n${step}: working in ${basename(process.cwd())}\n`)
// `started: {install: fifo}`: tells the test this step is running (the write waits for its reader).
if (state.started?.[step]) writeFileSync(state.started[step], `${step}\n`)
if (state.sleep[step]) await new Promise(resolve => setTimeout(resolve, state.sleep[step]))
if (state.fail[step] > 0) {
  state.fail[step] -= 1
  writeFileSync(file, JSON.stringify(state, null, 2))
  process.stderr.write(`error: ${step} failed (fixture)\n`)
  process.exit(1)
}
process.stdout.write(`${step}: done\n`)

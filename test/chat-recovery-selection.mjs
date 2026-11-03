// LKM-453: the opt-in --chat-recovery-acceptance selection and its flag guards. The
// selector lives in src/native/smoke-groups.ts; test/native-smoke-groups.mjs covers the
// shared group selection.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CHAT_RECOVERY_ACCEPTANCE_CHECK,
  CHAT_RECOVERY_ACCEPTANCE_FLAG,
  DREAMER_ACCEPTANCE_FLAG,
  parseSmokeGroups,
  SOURCE_POPOUT_ACCEPTANCE_FLAG,
  selectChatRecoveryAcceptance,
  selectDreamerAcceptance,
  selectSmokeChecks
} from '../src/native/smoke-groups.ts'

// The same scan as test/native-smoke-groups.mjs: smoke-core's always-pushed checks.
const source = readFileSync(
  fileURLToPath(new URL('../src/native/smoke-core.ts', import.meta.url)),
  'utf8'
)
const checkPattern = /^\s*\{\n\s*name: '([\w-]+)',(?:\n\s*dependsOn: \[([^\]]*)\],)?/gm
const names = [...source.matchAll(checkPattern)].map((m) => ({
  name: m[1],
  dependsOn: [...(m[2] ?? '').matchAll(/'([\w-]+)'/g)].map((d) => d[1])
}))
assert.ok(names.length >= 19, `Found smoke-core checks (${names.length})`)

// The check is pushed only under its flag, after the always-on list.
assert.match(
  source,
  /process\.argv\.includes\(CHAT_RECOVERY_ACCEPTANCE_FLAG\)\)\n\s*checks\.push\(\{\n\s*name: CHAT_RECOVERY_ACCEPTANCE_CHECK,/
)

// --chat-recovery-acceptance runs the prelude and its one opt-in check, nothing else.
const recoveryOptIn = [
  ...names,
  { name: CHAT_RECOVERY_ACCEPTANCE_CHECK, dependsOn: ['chat-ready'] }
]
const recoveryArgv = ['--test', '--only=chat', CHAT_RECOVERY_ACCEPTANCE_FLAG]
const recoveryNotices = []
assert.deepEqual(
  selectChatRecoveryAcceptance(
    selectSmokeChecks(recoveryOptIn, parseSmokeGroups(recoveryArgv), () => {}),
    recoveryArgv,
    (line) => recoveryNotices.push(line)
  ).map((c) => c.name),
  ['startup', 'open-project', 'chat-ready', 'final-shell', CHAT_RECOVERY_ACCEPTANCE_CHECK]
)
assert.match(recoveryNotices.join(), /^CHAT RECOVERY ACCEPTANCE .*not full-suite acceptance/)
assert.equal(
  selectChatRecoveryAcceptance(names, ['--test'], () => {}),
  names,
  'No flag: unchanged'
)
assert.equal(
  selectDreamerAcceptance(recoveryOptIn, recoveryArgv, () => {}),
  recoveryOptIn,
  'The Dreamer selection ignores the chat recovery flag'
)
assert.throws(
  () => parseSmokeGroups(['--only=settings', CHAT_RECOVERY_ACCEPTANCE_FLAG]),
  /--chat-recovery-acceptance needs the chat group/
)
assert.throws(
  () => selectChatRecoveryAcceptance(names, recoveryArgv, () => {}),
  /chat-recovery-flow-native check was not selected/
)
assert.throws(
  () => selectChatRecoveryAcceptance(recoveryOptIn, [...recoveryArgv, '--live'], () => {}),
  /cannot run with --live/
)
// It never combines with another opt-in acceptance: each would drop the other's check.
for (const other of [DREAMER_ACCEPTANCE_FLAG, SOURCE_POPOUT_ACCEPTANCE_FLAG, '--markup-acceptance'])
  assert.throws(
    () => selectChatRecoveryAcceptance(recoveryOptIn, [...recoveryArgv, other], () => {}),
    new RegExp(`cannot run with ${other}`)
  )
console.log(
  'Chat recovery acceptance selection: prelude plus chat-recovery-flow-native only; bad combinations fail.'
)

if (process.platform === 'darwin') {
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const dev = (...args) =>
    spawnSync(process.execPath, ['scripts/dev-native.mjs', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 20000
    })
  const withoutTest = dev(CHAT_RECOVERY_ACCEPTANCE_FLAG)
  assert.equal(withoutTest.status, 1)
  assert.match(withoutTest.stderr, /--chat-recovery-acceptance .*requires --test/)
  const wrongGroup = dev('--test', '--only=settings', CHAT_RECOVERY_ACCEPTANCE_FLAG)
  assert.equal(wrongGroup.status, 1)
  assert.match(wrongGroup.stderr, /needs the chat group/)
  assert.doesNotMatch(wrongGroup.stdout, /Building/)
  const help = dev('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--chat-recovery-acceptance/)
  console.log(
    'dev-native: the chat recovery flag requires --test and the chat group; --help lists it.'
  )
}

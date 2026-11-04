import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feedbackSteps, runFeedback } from '../scripts/check-feedback.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const selected = {
  mode: 'selected',
  base: 'origin/main',
  mergeBase: 'abc123',
  unit: ['lint', 'docs-links', 'legacy-names-audit'],
  reasons: [['docs-links', ['M docs/agent-guide/verification.md: reads or scans it']]],
  typecheck: false
}
const full = {
  mode: 'full',
  base: 'origin/main',
  mergeBase: 'abc123',
  reasons: ['M src/native/Shell.swift: no selection rule covers it'],
  typecheck: true
}

function captured(plan, exitAt) {
  const commands = []
  const output = []
  const oldWrite = process.stdout.write
  process.stdout.write = (value) => {
    output.push(String(value))
    return true
  }
  try {
    const status = runFeedback({
      args: ['--base=origin/main'],
      root,
      plan: () => plan,
      run: (binary, args) => {
        commands.push([binary, ...args])
        return { status: commands.length === exitAt ? 7 : 0 }
      }
    })
    const receipt = JSON.parse(output.join('').match(/FEEDBACK_RECEIPT (.+)/)[1])
    return { status, commands, receipt }
  } finally {
    process.stdout.write = oldWrite
  }
}

const focused = captured(selected)
assert.equal(focused.status, 0)
assert.deepEqual(focused.commands, [
  ['bun', 'run', 'lint'],
  ['bun', 'test/run.mjs', 'unit', '--filter=docs-links,legacy-names-audit']
])
assert.equal(focused.receipt.selection, 'selected')
assert.equal(focused.receipt.evidence, 'partial')
assert.equal(focused.receipt.checks.length, 2)

const broad = captured(full)
assert.equal(broad.status, 0)
assert.deepEqual(broad.commands, [
  ['bun', 'run', 'lint'],
  ['bun', 'run', 'typecheck']
])
assert.deepEqual(
  feedbackSteps(full, () => '{}').map(([, args]) => args),
  [
    ['run', 'lint'],
    ['run', 'typecheck'],
    ['run', 'typecheck:native']
  ],
  'unreadable config requires the separate native typecheck'
)
assert.equal(broad.receipt.selection, 'full')
assert.match(broad.receipt.selectionReasons[0], /Shell.swift/)
assert.match(broad.receipt.stillRequired[0], /full unit suite/)
assert.ok(broad.receipt.checks.every((check) => !check.command.includes('--changed=origin/main')))

const failed = captured(full, 2)
assert.equal(failed.status, 7)
assert.equal(failed.commands.length, 2, 'a failed typecheck prevents later checks')
assert.equal(failed.receipt.status, 'failed')
assert.equal(failed.receipt.failedCheck, 'typecheck')
assert.deepEqual(captured(selected, 1).commands, [['bun', 'run', 'lint']])
assert.equal(captured(selected, 2).receipt.failedCheck, 'selected unit')

let ran = false
assert.throws(
  () =>
    runFeedback({
      args: ['--base=bad'],
      root,
      plan: () => {
        throw new Error('base is not a commit here: bad')
      },
      run: () => {
        ran = true
      }
    }),
  /base is not a commit/
)
assert.equal(ran, false)
for (const args of [[], ['--base='], ['--base=main', '--extra']])
  assert.throws(() => runFeedback({ args, root, plan: () => selected }), /usage/)

const invalid = spawnSync('bun', ['scripts/check-feedback.mjs', '--base=does-not-exist'], {
  cwd: root,
  encoding: 'utf8'
})
assert.equal(invalid.status, 2)
assert.match(invalid.stderr, /base is not a commit/)
assert.doesNotMatch(invalid.stdout, /FEEDBACK_RECEIPT/)
const shellText = spawnSync(
  'bun',
  ['scripts/check-feedback.mjs', '--base=main; touch /tmp/trezi-feedback-injected'],
  {
    cwd: root,
    encoding: 'utf8'
  }
)
assert.equal(shellText.status, 2)
assert.match(shellText.stderr, /base is not a commit/)

// A representative mocked benchmark bounds the command's own planning/dispatch cost.
for (const [name, plan] of [
  ['selected', selected],
  ['partial', full]
]) {
  const start = performance.now()
  for (let i = 0; i < 10; i++) captured(plan)
  console.log(
    `${name} mock feedback mean dispatch: ${((performance.now() - start) / 10).toFixed(1)} ms`
  )
}
console.log('check-feedback PASS')

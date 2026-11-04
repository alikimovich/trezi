#!/usr/bin/env bun
// Fast, conservative local feedback. The audited plan remains the only selector;
// FULL means the local run stops at static checks and leaves the broad gate to CI.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planFromGit, repoContext, typecheckPlan } from '../test/helpers/test-plan.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function feedbackSteps(plan, read) {
  const steps = [['lint', ['run', 'lint']]]
  if (plan.typecheck)
    for (const name of typecheckPlan(read).run)
      steps.push([name, ['run', name === 'typecheck-native' ? 'typecheck:native' : name]])
  if (plan.mode === 'selected') {
    const unit = plan.unit.filter((name) => name !== 'lint')
    if (unit.length)
      steps.push(['selected unit', ['test/run.mjs', 'unit', `--filter=${unit.join(',')}`]])
  }
  return steps
}

export function runFeedback({ args, root = ROOT, run = defaultRun, plan = planFromGit }) {
  const input = args[0] === '--' ? args.slice(1) : args
  const baseArg = input.length === 1 && /^--base=.+$/.test(input[0]) ? input[0] : null
  if (!baseArg) throw new Error('usage: bun run check:feedback --base=<commit-ref>')
  const base = baseArg.slice('--base='.length)
  const selection = plan(root, base) // Invalid refs, merge bases and diffs fail before any command.
  if (!['selected', 'full'].includes(selection.mode)) throw new Error('unknown selection mode')
  if (selection.mode === 'selected' && !Array.isArray(selection.unit))
    throw new Error('selected plan has no unit list')
  const steps = feedbackSteps(selection, repoContext(root).read)
  const receipt = {
    kind: 'trezi-local-feedback',
    status: 'passed',
    evidence: 'partial',
    base: selection.base ?? base,
    mergeBase: selection.mergeBase ?? null,
    selection: selection.mode,
    selectionReasons: selection.reasons,
    checks: [],
    stillRequired: [
      'required CI unit and build checks on the PR head',
      'independent review and exact-head merge gate',
      'native acceptance or native-failure verification when applicable',
      'nightly native checks'
    ]
  }
  if (selection.mode === 'full')
    receipt.stillRequired.unshift(
      'full unit suite or CI selected unit gate; local FULL did not run it'
    )
  for (const [name, command] of steps) {
    const result = run('bun', command, root)
    const passed = result.status === 0 && !result.signal && !result.error
    receipt.checks.push({
      name,
      command: ['bun', ...command],
      status: passed ? 'passed' : 'failed'
    })
    if (!passed) {
      receipt.status = 'failed'
      receipt.failedCheck = name
      printReceipt(receipt)
      return result.status && result.status > 0 ? result.status : 1
    }
  }
  printReceipt(receipt)
  return 0
}

function defaultRun(binary, args, root) {
  return spawnSync(binary, args, { cwd: root, stdio: 'inherit', env: process.env })
}

function printReceipt(receipt) {
  process.stdout.write(`FEEDBACK_RECEIPT ${JSON.stringify(receipt)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = runFeedback({ args: process.argv.slice(2) })
  } catch (error) {
    console.error(`local feedback failed: ${error.message}`)
    process.exitCode = 2
  }
}

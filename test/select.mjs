#!/usr/bin/env node
// Prints the changed-file test plan without running anything (docs/TESTING.md,
// "Changed-file selection"). `node test/run.mjs unit --changed=<ref>` runs the same plan.
//
//   node test/select.mjs --base=<ref> [--json] [--github-output]
//   node test/select.mjs --path=<path> [--path=<path>…] [--json]   (existing files, as edited)
//
// --github-output appends mode, app_build and unit_count to $GITHUB_OUTPUT. Any
// failure exits 2 with no plan.
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePlan, planChanges, planFromGit, repoContext } from './helpers/test-plan.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let base = null
const paths = []
let json = false
let github = false
try {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--json') json = true
    else if (arg === '--github-output') github = true
    else if (arg.startsWith('--base=')) base = arg.slice('--base='.length)
    else if (arg.startsWith('--path=') && arg.length > '--path='.length)
      paths.push(arg.slice('--path='.length))
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!base === !paths.length) throw new Error('give either --base=<ref> or --path=<path>')
  if (github && !process.env.GITHUB_OUTPUT) throw new Error('--github-output needs $GITHUB_OUTPUT')
  let plan
  if (base) plan = planFromGit(ROOT, base)
  else {
    // A --path is planned as an edit, so it must be an existing tracked or untracked
    // file: a typo or a deleted file would otherwise get a confident, wrong plan.
    const ctx = repoContext(ROOT)
    const missing = paths.filter(
      (path) => !ctx.files.includes(path) || !existsSync(join(ROOT, path))
    )
    if (missing.length)
      throw new Error(`--path is not an existing tracked or untracked file: ${missing.join(', ')}`)
    plan = planChanges(
      paths.map((path) => ({ status: 'M', path })),
      ctx
    )
  }
  console.log(json ? JSON.stringify(plan, null, 2) : describePlan(plan))
  if (github)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `mode=${plan.mode}\napp_build=${plan.appBuild}\nunit_count=${plan.unit?.length ?? 'all'}\n`
    )
} catch (error) {
  console.error(`test selection failed: ${error.message}`)
  process.exit(2)
}

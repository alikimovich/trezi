/**
 * `bun run lint` (Biome over src and test) is part of the unit tier, so quick verification
 * fails on new lint debt. A disposable repo carrying this checkout's biome.json and lint
 * script proves the gate: a clean tree passes, a lint error or unformatted code fails, and
 * the intentional unused `SHADOW_*` constants under test/fixtures stay allowed.
 *
 * Run with: bun test/lint.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const env = {
  ...process.env,
  PATH: `${join(root, 'node_modules/.bin')}${delimiter}${process.env.PATH}`
}
const lint = (cwd) => {
  const result = spawnSync('bun', ['run', 'lint'], { cwd, env, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const repo = lint(root)
assert.equal(repo.status, 0, `bun run lint must pass on the checkout:\n${repo.output}`)

const probe = mkdtempSync(join(tmpdir(), 'trezi-lint-'))
try {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(probe, 'package.json'), JSON.stringify({ scripts: { lint: scripts.lint } }))
  copyFileSync(join(root, 'biome.json'), join(probe, 'biome.json'))
  // Biome reads .gitignore through the VCS root, as in the checkout.
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: probe }).status, 0)
  writeFileSync(join(probe, '.gitignore'), 'node_modules/\n')
  mkdirSync(join(probe, 'src'))
  mkdirSync(join(probe, 'test/fixtures/app'), { recursive: true })
  const put = (path, text) => writeFileSync(join(probe, path), text)

  put('src/ok.ts', 'export const ok = 1\n')
  const clean = lint(probe)
  assert.equal(clean.status, 0, `a clean probe passes:\n${clean.output}`)

  put('src/bad.ts', 'let a = 1\nif ((a = 2)) a++\nexport { a }\n')
  const error = lint(probe)
  assert.notEqual(error.status, 0, 'a new lint error fails')
  assert.match(error.output, /noAssignInExpressions/)
  rmSync(join(probe, 'src/bad.ts'))

  put('src/ugly.ts', 'export const ugly  =  { a: "b" };\n')
  const format = lint(probe)
  assert.notEqual(format.status, 0, 'unformatted code fails')
  assert.match(format.output, /format/)
  rmSync(join(probe, 'src/ugly.ts'))

  // The island reads these constants from source, so they are unused on purpose.
  put('test/fixtures/app/phone.js', "const SHADOW_A = '0 1px red'\nexport const x  =  1\n")
  const fixture = lint(probe)
  assert.equal(
    fixture.status,
    0,
    `fixtures keep their bytes and unused constants:\n${fixture.output}`
  )
} finally {
  rmSync(probe, { recursive: true, force: true })
}
console.log('PASS lint')

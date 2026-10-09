import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { versioningProblems } from './version.mjs'

/**
 * CI check (LKM-143): package.json `version` is SemVer and CHANGELOG.md has an
 * Unreleased section. `bun scripts/check-version.mjs [root]`; root defaults to this checkout.
 */
const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)))
let version
try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version } catch (error) { version = `unreadable (${error.message})` }
const changelogPath = join(root, 'CHANGELOG.md')
const problems = versioningProblems({ version, changelog: existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : null })
if (problems.length) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}
console.log(`Version ${version} is SemVer; CHANGELOG.md has an Unreleased section.`)

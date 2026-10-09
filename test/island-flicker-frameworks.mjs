import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const result = spawnSync('bun', ['test/helpers/island-flicker-frameworks.mjs'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  timeout: 300000
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1

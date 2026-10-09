import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The native tier runs Node launchers; the backend integration itself uses Bun.
const result = spawnSync('bun', ['test/helpers/native-next-hmr.mjs'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  timeout: 240000
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1

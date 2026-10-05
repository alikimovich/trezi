import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Forwards flags such as --require-build (used by `bun run test:native`).
const result = spawnSync('bun', ['test/helpers/native-chat-scroll.mjs', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  timeout: 360000
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1

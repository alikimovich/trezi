import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Forwards flags such as --require-build (used by `bun run test:native`). This never
// builds: it runs the host that native-runtime built just before (LKM-175).
const started = Date.now()
const result = spawnSync('bun', ['test/helpers/native-chat-scroll.mjs', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: 'inherit',
  timeout: 360000
})
if (result.error) throw result.error
console.log(`[timing] native-chat-scroll: ${((Date.now() - started) / 1000).toFixed(1)} s`)
process.exitCode = result.status ?? 1

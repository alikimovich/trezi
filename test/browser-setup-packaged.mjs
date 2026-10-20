import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Forwards flags such as --require-build (used by `bun run test:native`). This never
// builds: it copies the app native-runtime built just before (LOCAL-WEBKIT-4).
const result = spawnSync(
  'bun',
  ['test/helpers/browser-setup-packaged.mjs', ...process.argv.slice(2)],
  {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
    timeout: 180000
  }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1

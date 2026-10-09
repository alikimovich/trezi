// A scripted `idb` (and `pkill`) for the platform owner fixture. mode.json: `idb:false`
// makes `--help` fail (not installed); `stale:n` answers the next n `describe` calls
// the way a stale companion does (exit 0, the message on stderr). Calls go to calls.jsonl.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const dir = process.env.FAKE_SIM_DIR
const mode = existsSync(join(dir, 'mode.json')) ? JSON.parse(readFileSync(join(dir, 'mode.json'), 'utf8')) : {}
const args = process.argv.slice(2)
const tool = basename(process.argv[1]).startsWith('pkill') ? 'pkill' : 'idb'
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ tool, args, pid: process.pid })}\n`)
if (tool === 'pkill') process.exit(1)
if (args[0] === '--help') process.exit(mode.idb === false ? 1 : 0)
if (args[0] === 'describe') {
  const counter = join(dir, 'stale-count')
  const used = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  if (used < (mode.stale ?? 0)) {
    writeFileSync(counter, String(used + 1))
    process.stderr.write('Traceback...\nidb.common.types.IdbException: Failed to connect to companion at 127.0.0.1:10882\n')
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({ udid: args[2], state: 'Booted', screen_dimensions: { width: 1206, height: 2622, density: 3 } }))
} else if (args[0] === 'ui' && args[1] === 'describe-point') {
  process.stdout.write(JSON.stringify({ type: 'Button', AXLabel: 'Buy', AXUniqueId: 'trezi:src/App.tsx:12:4', frame: {} }))
} else if (args[0] === 'ui') {
  if (mode.uiFail) { process.stderr.write('idb: device went away\n'); process.exit(1) }
} else {
  process.stderr.write(`fake idb: unsupported ${args.join(' ')}\n`)
  process.exit(64)
}

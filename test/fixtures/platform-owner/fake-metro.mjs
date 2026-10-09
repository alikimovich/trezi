// Stands in for `npx expo run:ios`: records its pid and a child's (a descendant that
// must not outlive the group), then behaves per argv[2]:
// ready (the Expo markers), fail (a build error), exit (exits 3 first), silent.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const how = process.argv[2] ?? 'ready'
const child = spawn('/bin/sleep', ['120'], { stdio: 'ignore' })
writeFileSync(join(process.env.FAKE_SIM_DIR, `metro-${process.pid}.json`), JSON.stringify({ pid: process.pid, child: child.pid, how }))
const say = text => process.stdout.write(`${text}\n`)
if (how === 'ready') {
  say('\u001b[1mStarting Metro Bundler\u001b[22m')
  say('› Opening on iPhone 16 Pro (26.0)')
  say('Logs for your project will appear below.')
} else if (how === 'fail') {
  say('Explicit dependency on target Foo in project Bar')
  say('error: Build input file cannot be found: /x/y')
  say('** BUILD FAILED **')
} else if (how === 'exit') {
  say('Cannot find module expo')
  process.exit(3)
}
setTimeout(() => {}, 120_000)

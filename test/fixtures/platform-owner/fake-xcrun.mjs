// A scripted `xcrun` for the platform owner fixture (no Xcode, no simulator). Its
// behaviour is read from $FAKE_SIM_DIR/mode.json on every call, every call is appended
// to calls.jsonl, and a waiting `bootstatus` records its pid (and a child's) so the test
// can prove a Stop ended them.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_SIM_DIR
const mode = existsSync(join(dir, 'mode.json')) ? JSON.parse(readFileSync(join(dir, 'mode.json'), 'utf8')) : {}
const args = process.argv.slice(2)
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ tool: 'xcrun', args, pid: process.pid })}\n`)
const statePath = join(dir, 'booted.json')
const booted = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []
const fail = (text, code = 1) => { process.stderr.write(`${text}\n`); process.exit(code) }
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'
const DEVICES = [
  { udid: '11111111-1111-4111-8111-111111111111', name: 'iPhone 15', isAvailable: true, state: 'Shutdown' },
  { udid: '22222222-2222-4222-8222-222222222222', name: 'iPhone 16 Pro', isAvailable: true, state: 'Shutdown' },
  { udid: '33333333-3333-4333-8333-333333333333', name: 'Apple Watch', isAvailable: true, state: 'Shutdown' }
]
const key = args.join(' ')

if (key === 'simctl help') {
  if (mode.xcode === 'missing') fail('xcrun: error: unable to find utility "simctl", not a developer tool or in PATH', 72)
  if (mode.xcode === 'license') fail('You have not agreed to the Xcode license agreements. Please run \'sudo xcodebuild -license\'.', 69)
  process.stdout.write('usage: simctl [--set <path>] [--profiles <path>] <subcommand> ...\n')
} else if (key === 'simctl list runtimes -j') {
  if (mode.list === 'broken') fail('simctl list failed', 2)
  const runtimes = mode.runtimes ?? [{ name: 'iOS 26.0', identifier: runtime, version: '26.0', isAvailable: true },
    { name: 'watchOS 11.0', identifier: 'watch', version: '11.0', isAvailable: true }]
  process.stdout.write(JSON.stringify({ runtimes }))
} else if (key === 'simctl list devices available -j') {
  process.stdout.write(JSON.stringify({ devices: mode.devices ?? { [runtime]: DEVICES } }))
} else if (key === 'simctl list devices booted -j') {
  process.stdout.write(JSON.stringify({ devices: { [runtime]: DEVICES.filter(d => booted.includes(d.udid)).map(d => ({ ...d, state: 'Booted' })) } }))
} else if (key === '--sdk iphonesimulator --show-sdk-version') {
  process.stdout.write(`${mode.sdk ?? '26.0'}\n`)
} else if (args[0] === 'simctl' && args[1] === 'boot') {
  if (mode.bootFail) fail('An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405)')
  if (booted.includes(args[2])) fail('An error was encountered processing the command (domain=com.apple.CoreSimulatorService, code=164):\nUnable to boot device in current state: Booted', 149)
  writeFileSync(statePath, JSON.stringify([...booted, args[2]]))
} else if (args[0] === 'simctl' && args[1] === 'bootstatus') {
  if (mode.slowBoot) {
    const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    writeFileSync(join(dir, 'bootstatus.json'), JSON.stringify({ pid: process.pid, child: child.pid }))
    setTimeout(() => {}, 60_000)
  }
} else if (args[0] === 'simctl' && args[1] === 'io' && args[3] === 'screenshot') {
  if (mode.noFrames) fail('Error: screenshot failed: device is not ready')
  // A 1×1 JPEG, with the device in it so the test can tell mirrors apart.
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==', 'base64')
  writeFileSync(args[5], Buffer.concat([jpeg, Buffer.from(args[2])]))
} else {
  fail(`fake xcrun: unsupported ${key}`, 64)
}

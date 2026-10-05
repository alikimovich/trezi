import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const bridgePath = fileURLToPath(new URL('../src/native/bridge.ts', import.meta.url))
const child = spawn(
  process.execPath,
  [
    '-e',
    `
  import { NativeBridge } from ${JSON.stringify(bridgePath)}
  const bridge = new NativeBridge()
  if (bridge.child !== undefined) process.exit(3)
  // Startup holds host events while it awaits the service; service frames still flow.
  bridge.hold()
  const reply = new Promise(resolve => bridge.once('service-reply', resolve))
  bridge.sendService({ service: 'preferences', id: 1 })
  if ((await reply).id !== 1) process.exit(5)
  let ready = 0
  bridge.on('ready', () => ready++)
  await new Promise(resolve => setTimeout(resolve, 50))
  if (ready !== 0) process.exit(6)
  bridge.release()
  if (ready !== 1) process.exit(7)
  const received = []
  bridge.on('persist', event => received.push(event.value))
  bridge.on('closed', () => {
    if (received.join() !== 'final-state') process.exitCode = 4
  })
  const value = await bridge.request('fixture')
  bridge.send('completed', {value})
  await bridge.closed
`
  ],
  { env: { ...process.env, TREZI_SERVICE_SUPERVISED: '1' }, stdio: 'pipe' }
)
let stderr = ''
child.stderr.on('data', (data) => {
  stderr += data
})
const messages = []
const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  messages.push(message)
  // The host's first event arrives before the service's answer.
  if (message.service === 'preferences')
    child.stdin.write(
      `${JSON.stringify({ event: 'ready' })}\n${JSON.stringify({ event: 'service-reply', service: 'preferences', id: message.id })}\n`
    )
  if (message.method === 'fixture')
    child.stdin.write(
      `${JSON.stringify({ event: 'reply', id: message.id, value: 'acknowledged' })}\n`
    )
  if (message.method === 'completed')
    child.stdin.end(`${JSON.stringify({ event: 'persist', value: 'final-state' })}\n`)
})
try {
  const [code, signal] = await once(child, 'close')
  assert.equal(code, 0, `${stderr} signal=${signal}`)
  assert.equal(messages.length, 3)
  assert.equal(messages[0].service, 'preferences', 'service frames carry no method')
  assert.equal(messages[2].value, 'acknowledged')
} finally {
  clearTimeout(timer)
  if (child.exitCode === null) child.kill()
}
console.log(
  'NATIVE SUPERVISED BRIDGE PASS — service pipes, replies, held startup events and final-event drain'
)

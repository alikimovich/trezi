/**
 * Unit test for the dev-server networking helpers (no Electron / no real
 * sockets — findRunningServer takes an injectable probe). Run via bun so the
 * .ts import transpiles: bun run test:devnet
 */
import assert from 'node:assert'
import { createServer } from 'node:net'
import {
  BLOCKED_PORTS,
  defaultPorts,
  findFreePort,
  findRunningServer,
  hostVariants,
  isPortFree,
  normalizeUrl,
  stripAnsi
} from '../src/main/devserver-net.ts'

// findFreePort returns a bindable port at or above the base (the preview port).
const free = await findFreePort(7777)
assert.ok(free >= 7777 && free <= 65535, `free port ${free} should be >= 7777`)
assert.equal(await isPortFree(free), true, 'reported port is actually free')
// It skips browser-blocked ports (6666 etc.) — starting in the IRC range must
// never return a blocked port.
const fromIrc = await findFreePort(6665)
assert.equal(BLOCKED_PORTS.has(fromIrc), false, `findFreePort returned blocked port ${fromIrc}`)

// An occupied port is never "free" — for EITHER shape of occupant. On macOS a
// single bind test misses one of them (node sets SO_REUSEADDR, so a specific
// address still binds under a dual-stack wildcard, and a wildcard still binds
// over a lone 127.0.0.1), and a false "free" makes the preview attach to
// whatever stranger is already answering there.
const listen = (...args) =>
  new Promise((resolve) => {
    const s = createServer()
    s.listen(...args, () => resolve(s))
  })
const close = (s) => new Promise((resolve) => s.close(resolve))

const wildcard = await listen(0) // dual-stack, like `node server.mjs` with no host
const wildcardPort = wildcard.address().port
assert.equal(await isPortFree(wildcardPort), false, 'a dual-stack listener means occupied')
assert.equal(
  (await findFreePort(wildcardPort)) === wildcardPort,
  false,
  'findFreePort must skip it'
)
await close(wildcard)

const loopback = await listen(0, '127.0.0.1')
const loopbackPort = loopback.address().port
assert.equal(await isPortFree(loopbackPort), false, 'a 127.0.0.1-only listener means occupied')
await close(loopback)

// ANSI color codes around the port (Vite prints a bold port) must be stripped,
// or the parsed URL is garbage and readiness waits forever.
assert.equal(
  stripAnsi('  ➜  Local: http://localhost:\x1b[1m5173\x1b[22m/'),
  '  ➜  Local: http://localhost:5173/'
)
assert.equal(stripAnsi('plain http://127.0.0.1:3000/'), 'plain http://127.0.0.1:3000/')
// Don't eat legitimate brackets (e.g. Next.js [id] routes) — needs the ESC.
assert.equal(stripAnsi('/blog/[slug]/page'), '/blog/[slug]/page')

// hostVariants: localhost-ish URLs expand to concrete hosts, IPv4 first.
assert.deepEqual(hostVariants('http://localhost:5174/'), [
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'http://[::1]:5174'
])
assert.deepEqual(hostVariants('http://[::1]:5174'), [
  'http://127.0.0.1:5174',
  'http://localhost:5174',
  'http://[::1]:5174'
])
assert.deepEqual(hostVariants('http://127.0.0.1:5173/app'), [
  'http://127.0.0.1:5173/app',
  'http://localhost:5173/app',
  'http://[::1]:5173/app'
])
// Non-local hosts are left alone.
assert.deepEqual(hostVariants('http://example.com:3000'), ['http://example.com:3000'])

// defaultPorts: only known frameworks have a guess; unknown → none.
assert.deepEqual(defaultPorts('sveltekit'), [5173])
assert.deepEqual(defaultPorts('vite'), [5173])
assert.deepEqual(defaultPorts('next'), [3000])
assert.deepEqual(defaultPorts('cra'), [3000])
assert.deepEqual(defaultPorts('unknown'), [])
assert.deepEqual(defaultPorts(undefined), [])

assert.equal(normalizeUrl('http://0.0.0.0:5173/'), 'http://localhost:5173')

// Attach: prefer a healthy IPv4 server.
assert.equal(
  await findRunningServer('sveltekit', async (u) => (u === 'http://127.0.0.1:5173' ? 200 : null)),
  'http://127.0.0.1:5173'
)
// Fall back to IPv6 when only it answers (the bug that broke lkmv.ch).
assert.equal(
  await findRunningServer('sveltekit', async (u) => (u === 'http://[::1]:5173' ? 200 : null)),
  'http://[::1]:5173'
)
// Never attach to a broken (500) server — spawn instead.
assert.equal(await findRunningServer('sveltekit', async () => 500), null)
// Unknown framework: never probe or attach.
let probed = false
assert.equal(
  await findRunningServer('unknown', async () => {
    probed = true
    return 200
  }),
  null
)
assert.equal(probed, false, 'unknown framework must not probe')

console.log('DEVSERVER-NET OK — host variants, default ports, IPv4/IPv6 attach policy')

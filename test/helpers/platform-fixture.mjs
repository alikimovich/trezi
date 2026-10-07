// The real Swift PlatformOwner (S14) compiled into a line-driven fixture process, Bun's
// real client wired to it, and the scripted xcrun / idb / pkill / Metro it runs
// (test/fixtures/platform-owner/fake-*.mjs). Nothing here reaches Xcode, a simulator or
// the network beyond loopback.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { servicePlatform } from '../../src/native/platform-service.ts'
import { skipUnlessDarwin } from './darwin.mjs'
import { swiftBuild } from './swift-build.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
export const SOURCES = [
  'ServiceContract',
  'LedgerStore',
  'OperationLedger',
  'PreferencesFile',
  'PreferencesOwner',
  'WorkspaceFile',
  'WorkspaceOwner',
  'DomainChannel',
  'ManagedProcess',
  'RuntimeNet',
  'RuntimeDetect',
  'StaticSite',
  'StaticServer',
  'RepositoryGit',
  'GitMessages',
  'RepositoryJournal',
  'RepositoryEffects',
  'RepositoryLanding',
  'RepositoryAgentGit',
  'RepositoryBranches',
  'RepositoryCleanup',
  'RepositoryMerge',
  'RepositoryOwner',
  'SourcePaths',
  'PlatformTools',
  'PlatformOpen',
  'PlatformMedia',
  'SimulatorTools',
  'SimulatorBridge',
  'SimulatorOwner',
  'PlatformOwner'
].map((name) => `src/service/${name}.swift`)

/** Compiles the fixture once per source hash and compiler version; returns the binary path. */
export function compilePlatformFixture() {
  skipUnlessDarwin('the Swift platform owner')
  return swiftBuild('platform-owner', [...SOURCES, 'test/fixtures/platform-owner/main.swift'])
}

/** `xcrun`, `idb`, `pkill` stand-ins in `dir` (absolute shebang: the Bun running the test). */
export function installFakes(dir) {
  mkdirSync(dir, { recursive: true })
  const script = (name) =>
    `#!${process.execPath}\n${readFileSync(join(root, 'test/fixtures/platform-owner', name), 'utf8')}`
  for (const [name, source] of [
    ['xcrun', 'fake-xcrun.mjs'],
    ['idb', 'fake-idb.mjs'],
    ['pkill', 'fake-idb.mjs']
  ]) {
    writeFileSync(join(dir, name), script(source))
    chmodSync(join(dir, name), 0o755)
  }
  return {
    xcrun: join(dir, 'xcrun'),
    idb: join(dir, 'idb'),
    pkill: join(dir, 'pkill'),
    metro: (how) =>
      `${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, 'test/fixtures/platform-owner/fake-metro.mjs'))} ${how}`
  }
}

/** A fixture process on `profile`; `.owner()` is Bun's client for it. */
export async function startPlatformFixture(binary, profile, env = {}) {
  const child = spawn(binary, [profile], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const link = new EventEmitter()
  link.setMaxListeners(64)
  const lines = [],
    events = [],
    waiters = new Set()
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.event === 'service-reply') link.emit('service-reply', message)
    else if (message.event === 'service-event') {
      events.push(message)
      link.emit('service-event', message)
    } else lines.push(message)
    for (const wake of waiters) wake()
  })
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      status = { code, signal }
      resolve(status)
      for (const wake of waiters) wake()
    })
  )
  link.sendService = (frame) => {
    if (!status) child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  let raw = 0
  const fixture = {
    child,
    link,
    exited,
    events,
    get stderr() {
      return stderr
    },
    async next() {
      const deadline = Date.now() + 30_000
      while (!lines.length) {
        assert.ok(!status, `fixture exited ${JSON.stringify(status)}\n${stderr}`)
        assert.ok(Date.now() < deadline, `fixture timed out\n${stderr}`)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 50)
          waiters.add(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      return lines.shift()
    },
    cmd(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`)
      return this.next()
    },
    owner(options) {
      return servicePlatform(link, options)
    },
    /** One raw frame; resolves with the reply's result. */
    frame(method, body, extra = {}) {
      const id = 900_000 + ++raw
      return new Promise((resolve) => {
        const listener = (message) => {
          if (message.id === id) {
            link.off('service-reply', listener)
            resolve(message.reply.result)
          }
        }
        link.on('service-reply', listener)
        link.sendService({
          service: 'platform',
          id,
          request: {
            connection: crypto.randomUUID(),
            requestID: crypto.randomUUID(),
            operationID: crypto.randomUUID(),
            scope: {},
            mode: ['status', 'simulatorPreflight', 'mediaResolve', 'servers'].includes(method)
              ? 'read'
              : 'mutation',
            service: 'platform',
            method,
            body,
            ...extra
          }
        })
      })
    },
    async stop() {
      if (!status) {
        child.stdin.end()
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))])
      }
      if (!status) {
        child.kill('SIGKILL')
        await exited
      }
    }
  }
  const swept = await fixture.next()
  assert.ok(Array.isArray(swept.swept), JSON.stringify(swept))
  fixture.swept = swept.swept
  assert.deepEqual(await fixture.next(), { ready: true })
  return fixture
}

/** One HTTP/1.1 exchange over a raw socket (so `Host` can be anything). Resolves when the
 * peer closes, or once `until(text)` holds, with the status, head and body bytes. */
export function http(
  port,
  {
    method = 'GET',
    path = '/',
    host = `127.0.0.1:${port}`,
    body = null,
    until = null,
    timeout = 5000
  } = {}
) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let data = Buffer.alloc(0),
      done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      const text = data.toString('latin1'),
        end = text.indexOf('\r\n\r\n')
      const head = end >= 0 ? text.slice(0, end) : text
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0),
        head,
        body: end >= 0 ? data.subarray(end + 4) : Buffer.alloc(0)
      })
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        socket.destroy()
        reject(new Error(`http ${path}: timed out with ${data.length} bytes`))
      }
    }, timeout)
    socket.on('connect', () => {
      const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n${body == null ? '' : `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`}\r\n${payload}`
      )
    })
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (until && until(data.toString('latin1'))) finish()
    })
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('error', (error) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(error)
      }
    })
  })
}

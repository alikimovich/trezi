// The real Swift ProviderOwner (S10) compiled into a line-driven fixture process, with
// Bun's real client wired to it and the fake provider helper as its helper command.
// Used by test/provider-owner.mjs.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { serviceProvider } from '../../src/native/provider-service.ts'
import { skipUnlessDarwin } from './darwin.mjs'

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
  'PlatformTools',
  'ProviderPolicy',
  'ProviderStore',
  'ProviderHelper',
  'ProviderFrames',
  'ProviderData',
  'ProviderLaunch',
  'ProviderOwner'
].map((name) => `src/service/${name}.swift`)
export const FAKE_HELPER = join(root, 'test/fixtures/provider-owner/fake-helper.mjs')

/** Compiles the fixture once per source hash and compiler version; returns the binary path. */
export function compileProviderFixture() {
  skipUnlessDarwin('the Swift provider owner')
  const files = [...SOURCES, 'test/fixtures/provider-owner/main.swift']
  const compiler = spawnSync('xcrun', ['swiftc', '--version'], { encoding: 'utf8' })
  const key = createHash('sha256')
  key.update(`${compiler.stdout}${compiler.stderr}`)
  for (const file of files) key.update(`${file}\0`).update(readFileSync(join(root, file)))
  const cache = join(tmpdir(), 'trezi-provider-owner-cache')
  mkdirSync(cache, { recursive: true })
  const cached = join(cache, `fixture-${key.digest('hex').slice(0, 24)}`)
  if (!existsSync(cached)) {
    const building = `${cached}.${process.pid}.tmp`
    const result = spawnSync(
      'xcrun',
      ['swiftc', '-module-cache-path', join(cache, 'module-cache'), ...files, '-o', building],
      { cwd: root, encoding: 'utf8', timeout: 400_000 }
    )
    assert.equal(
      result.status,
      0,
      `swiftc: ${result.error || ''}\n${result.stdout}\n${result.stderr}`
    )
    renameSync(building, cached)
  }
  return cached
}

/** A fixture process on `profile` (its helper command is the fake provider helper). */
export async function startProviderFixture(binary, profile, env = {}) {
  const child = spawn(binary, [profile], {
    env: {
      ...process.env,
      PROVIDER_HELPER_EXEC: process.execPath,
      PROVIDER_HELPER_ARGS: FAKE_HELPER,
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const link = new EventEmitter()
  link.setMaxListeners(100)
  const lines = [],
    waiters = new Set(),
    events = []
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
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
  const sent = []
  link.sendService = (frame) => {
    sent.push(frame)
    if (!status) child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  let raw = 0
  const fixture = {
    child,
    link,
    exited,
    events,
    sent,
    get stderr() {
      return stderr
    },
    get status() {
      return status
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
    /** Bun's client, wired like src/native/index.ts. */
    owner(options = {}) {
      return serviceProvider(link, options)
    },
    /** One raw request frame; resolves with the reply's result. */
    frame(method, body, request = {}) {
      const id = 900_000 + ++raw
      return new Promise((resolve) => {
        const listener = (message) => {
          if (message.service === 'provider' && message.id === id) {
            link.off('service-reply', listener)
            resolve(message.reply.result)
          }
        }
        link.on('service-reply', listener)
        link.sendService({
          service: 'provider',
          id,
          request: {
            connection: crypto.randomUUID(),
            requestID: crypto.randomUUID(),
            operationID: crypto.randomUUID(),
            scope: {},
            mode: ['recover', 'snapshot', 'status'].includes(method) ? 'read' : 'mutation',
            service: 'provider',
            method,
            body,
            ...request
          }
        })
      })
    },
    async stop() {
      if (!status) child.stdin.end()
      await exited
    },
    async kill() {
      if (!status) child.kill('SIGKILL')
      await exited
    }
  }
  const ready = await fixture.next()
  assert.equal(ready.ready, true)
  fixture.swept = ready.swept
  return fixture
}

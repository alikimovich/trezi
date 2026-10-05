// The real Swift RepositoryOwner (S07) compiled into a line-driven fixture process,
// and Bun's real client wired to it. Shared by test/repository-owner.mjs and the
// parity preload that re-runs the legacy Git suites against the Swift owner.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { serviceRepository } from '../../src/native/repository-service.ts'
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
  'RepositoryGit',
  'GitMessages',
  'RepositoryJournal',
  'RepositoryEffects',
  'RepositoryLanding',
  'RepositoryCleanup',
  'RepositoryMerge',
  'RepositoryOwner'
].map((name) => `src/service/${name}.swift`)

/** Compiles the fixture once per source hash and compiler version; returns the binary path. */
export function compileRepositoryFixture() {
  skipUnlessDarwin('the Swift repository owner')
  const files = [...SOURCES, 'test/fixtures/repository-owner/main.swift']
  const compiler = spawnSync('xcrun', ['swiftc', '--version'], { encoding: 'utf8' })
  const key = createHash('sha256')
  key.update(`${compiler.stdout}${compiler.stderr}`)
  for (const file of files) key.update(`${file}\0`).update(readFileSync(join(root, file)))
  const cache = join(tmpdir(), 'trezi-repository-owner-cache')
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

/** A fixture process on `profile`, Bun's client over its stdin/stdout, and raw frame access. */
export async function startRepositoryFixture(binary, profile, env = {}) {
  const child = spawn(binary, [profile], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const link = new EventEmitter()
  const lines = [],
    waiters = new Set()
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.event === 'service-reply') link.emit('service-reply', message)
    else lines.push(message)
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
    owner(options) {
      return serviceRepository(link, options)
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
          service: 'repository',
          id,
          request: {
            connection: crypto.randomUUID(),
            requestID: crypto.randomUUID(),
            operationID: crypto.randomUUID(),
            scope: {},
            mode: method === 'status' ? 'read' : 'mutation',
            service: 'repository',
            method,
            body,
            ...extra
          }
        })
      })
    },
    async stop() {
      if (!status) child.stdin.end()
      await exited
    }
  }
  const ready = await fixture.next()
  assert.equal(ready.ready, true)
  return fixture
}

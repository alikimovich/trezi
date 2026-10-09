// The real Swift ConversationOwner (S11) compiled into a line-driven fixture process,
// with Bun's real client wired to it. Used by test/conversation-owner.mjs and the
// parity preload that re-runs legacy chat suites against the Swift owner.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { serviceConversation } from '../../src/native/conversation-service.ts'
import { serviceRepository } from '../../src/native/repository-service.ts'
import { serviceSource } from '../../src/native/source-service.ts'
import { skipUnlessDarwin } from './darwin.mjs'
import { SOURCES as SOURCE_SOURCES } from './source-fixture.mjs'
import { swiftBuild } from './swift-build.mjs'

export const SOURCES = [
  ...SOURCE_SOURCES,
  ...['MemoryFile', 'ConversationState', 'ConversationStore', 'ConversationOwner'].map(
    (name) => `src/service/${name}.swift`
  )
]

/** Compiles the fixture once per source hash and compiler version; returns the binary path. */
export function compileConversationFixture() {
  skipUnlessDarwin('the Swift conversation owner')
  return swiftBuild('conversation-owner', [
    ...SOURCES,
    'test/fixtures/conversation-owner/main.swift'
  ])
}

/** A fixture process on `profile`: Bun's conversation client, raw frames and commands. */
export async function startConversationFixture(binary, profile, env = {}) {
  const child = spawn(binary, [profile], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const link = new EventEmitter()
  const lines = [],
    waiters = new Set()
  // Requests sent and not yet answered, so a test can let background work settle.
  const outstanding = new Set()
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.event === 'service-reply') {
      outstanding.delete(`${message.service}:${message.id}`)
      link.emit('service-reply', message)
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
    if (!status) {
      outstanding.add(`${frame.service}:${frame.id}`)
      child.stdin.write(`${JSON.stringify(frame)}\n`)
    }
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
    /** Resolves once every request sent so far (and any they caused) has been answered. */
    async settled() {
      for (let quiet = 0; quiet < 5; ) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        quiet = outstanding.size ? 0 : quiet + 1
      }
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
      return serviceConversation(link, options)
    },
    /** All three clients (conversation, repository, source), wired like src/native/index.ts. */
    owners(options = {}) {
      const repository = serviceRepository(link, options)
      return {
        conversation: serviceConversation(link, options),
        repository,
        source: serviceSource(link, { ...options, leases: () => repository.heldLeases() })
      }
    },
    /** One raw frame; resolves with the reply's result. `request` overrides request fields. */
    frame(method, body, request = {}, top = {}) {
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
          service: 'conversation',
          id,
          request: {
            connection: crypto.randomUUID(),
            requestID: crypto.randomUUID(),
            operationID: crypto.randomUUID(),
            scope: {},
            mode: ['snapshot', 'status'].includes(method) ? 'read' : 'mutation',
            service: 'conversation',
            method,
            body,
            ...request
          },
          ...top
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
  return fixture
}

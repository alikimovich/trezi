// The real Swift WorkflowOwner (S13) compiled into a line-driven fixture process with the
// RepositoryOwner whose lanes it runs in, Bun's real client wired to it, and the scripted
// `gh` / package manager it runs (test/fixtures/workflow-owner/fake-*.mjs). Nothing here
// touches GitHub, the network or a real repository: remotes are bare repositories in a
// scratch directory.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serviceWorkflows } from '../../src/native/workflow-service.ts'
import { skipUnlessDarwin } from './darwin.mjs'
import { startRepositoryFixture } from './repository-fixture.mjs'
import { SOURCES as SOURCE_SOURCES } from './source-fixture.mjs'
import { swiftBuild } from './swift-build.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
export const SOURCES = [
  ...SOURCE_SOURCES,
  ...[
    'ProductLog',
    'WorkflowJournal',
    'WorkflowContext',
    'WorkflowOwner',
    'WorkflowPublish',
    'WorkflowRemote',
    'WorkflowSetup',
    'WorkflowTools'
  ].map((name) => `src/service/${name}.swift`)
]

/** Compiles the fixture once per source hash and compiler version; returns the binary path. */
export function compileWorkflowFixture() {
  skipUnlessDarwin('the Swift workflow owner')
  return swiftBuild('workflow-owner', [...SOURCES, 'test/fixtures/workflow-owner/main.swift'])
}

/** `gh`, `bun` and `npm` stand-ins in `dir` (absolute shebang: the Bun running the test). */
export function installFakes(dir) {
  mkdirSync(dir, { recursive: true })
  const script = (name) =>
    `#!${process.execPath}\n${readFileSync(join(root, 'test/fixtures/workflow-owner', name), 'utf8')}`
  for (const [name, source] of [
    ['gh', 'fake-gh.mjs'],
    ['bun', 'fake-pm.mjs'],
    ['npm', 'fake-pm.mjs'],
    ['npx', 'fake-pm.mjs']
  ]) {
    writeFileSync(join(dir, name), script(source))
    chmodSync(join(dir, name), 0o755)
  }
  return { gh: join(dir, 'gh'), bun: join(dir, 'bun') }
}

/**
 * Reply deadlines for Bun's client (its `deadline` option) that expire only when the
 * test calls `expire()`: a lost reply or a crash ends a request on that event, never
 * after a wall-clock wait (LKM-209).
 */
export function manualClock() {
  const armed = new Set()
  return {
    deadline: (expire) => {
      const entry = { expire }
      armed.add(entry)
      return () => armed.delete(entry)
    },
    expire() {
      assert.ok(armed.size, 'a reply deadline is armed')
      const due = [...armed]
      armed.clear()
      for (const entry of due) entry.expire()
    }
  }
}

/** A client whose deadline expires each time the fixture drops one of its replies. */
export function droppingClient(fixture, retries) {
  const clock = manualClock()
  fixture.link.on('workflow-dropped', () => clock.expire())
  return fixture.workflows({ deadline: clock.deadline, retries })
}

/**
 * `call(client)` on a fixture started with WORKFLOW_FAULT: the process SIGKILLs itself
 * at the fault point; only then does the request's deadline expire (deadlineExceeded).
 * A reply instead of the crash fails at once.
 */
export async function crashed(fixture, call) {
  const clock = manualClock()
  const request = call(fixture.workflows({ deadline: clock.deadline, retries: 0 }))
  const outcome = await Promise.race([
    fixture.exited.then((status) => ({ status })),
    request.then(
      (value) => ({ value }),
      (error) => ({ error: String(error) })
    )
  ])
  assert.ok(outcome.status, `answered instead of crashing: ${JSON.stringify(outcome)}`)
  assert.equal(outcome.status.signal, 'SIGKILL', fixture.stderr)
  clock.expire()
  await assert.rejects(request, (error) => error.code === 'deadlineExceeded')
}

/** A fixture process on `profile`; `workflows(options)` is Bun's client for it. */
export async function startWorkflowFixture(binary, profile, env = {}) {
  const fixture = await startRepositoryFixture(binary, profile, env)
  fixture.link.setMaxListeners(64)
  fixture.workflows = (options = {}) => serviceWorkflows(fixture.link, options)
  let raw = 0
  /** One raw workflow frame; resolves with the reply's result. */
  fixture.workflowFrame = (method, body, request = {}) => {
    const id = 700_000 + ++raw
    return new Promise((resolve) => {
      const listener = (message) => {
        if (message.service === 'workflow' && message.id === id) {
          fixture.link.off('service-reply', listener)
          resolve(message.reply.result)
        }
      }
      fixture.link.on('service-reply', listener)
      fixture.link.sendService({
        service: 'workflow',
        id,
        request: {
          connection: crypto.randomUUID(),
          requestID: crypto.randomUUID(),
          operationID: crypto.randomUUID(),
          scope: {},
          mode: ['workflows', 'diagnosis'].includes(method) ? 'read' : 'mutation',
          service: 'workflow',
          method,
          body,
          ...request
        }
      })
    })
  }
  return fixture
}

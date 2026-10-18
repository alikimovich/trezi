// The Skills registry fixture process (test/fixtures/skills-owner/main.swift): the real
// SkillsOwner + OperationLedger on a disposable profile, driven line by line, plus a
// pipe-shaped link for Bun's client (`serviceSkills`).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { skipUnlessDarwin } from './darwin.mjs'
import { swiftBuild } from './swift-build.mjs'

export const NOW = 1790000000000
const live = new Set()

export function compileSkills(binary) {
  skipUnlessDarwin('the Swift skills owner')
  const sources = [
    'ServiceContract',
    'LedgerStore',
    'OperationLedger',
    'PreferencesFile',
    'PreferencesOwner',
    'WorkspaceFile',
    'WorkspaceOwner',
    'DomainChannel',
    'SkillsPackage',
    'SkillsStore',
    'SkillsRequest',
    'SkillsPlan',
    'SkillsOwner',
    'SkillsHTTP',
    'SkillsArchive',
    'SkillsScope',
    'SkillsGitHub',
    'SkillsImport'
  ].map((name) => `src/service/${name}.swift`)
  swiftBuild('skills-owner', [...sources, 'test/fixtures/skills-owner/main.swift'], {
    out: binary
  })
}

export const killAll = () => {
  for (const child of live) child.kill('SIGKILL')
}

/** A scratch folder with the compiled fixture, fresh profiles and import folders. */
export function scratchSpace(prefix) {
  const scratch = mkdtempSync(join(tmpdir(), prefix))
  const binary = join(scratch, 'skills-fixture')
  let cases = 0
  const registry = (dir, ...parts) => join(dir, 'skills', ...parts)
  return {
    scratch,
    binary,
    registry,
    next: () => ++cases,
    start: (dir, env) => start(binary, dir, env),
    profile() {
      const dir = join(scratch, `profile-${++cases}`)
      mkdirSync(dir)
      return dir
    },
    manifest: (dir) =>
      existsSync(registry(dir, 'manifest.json'))
        ? readFileSync(registry(dir, 'manifest.json'))
        : null,
    /** A folder to import, from `{relative path: text}`. */
    folder(entries) {
      const dir = join(scratch, `import-${++cases}`)
      mkdirSync(dir)
      for (const [path, text] of Object.entries(entries)) {
        mkdirSync(join(dir, path, '..'), { recursive: true })
        writeFileSync(join(dir, path), text)
      }
      return dir
    },
    cleanup() {
      killAll()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

export async function start(binary, dir, env = {}) {
  const child = spawn(binary, [dir], {
    env: { ...process.env, SKILLS_NOW: String(NOW), ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  live.add(child)
  const lines = [],
    waiters = []
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve()
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(JSON.parse(line))
    wake()
  })
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      live.delete(child)
      status = { code, signal }
      resolve(status)
      wake()
    })
  )
  const connection = randomUUID()
  let id = 0
  const fx = {
    async next() {
      const deadline = Date.now() + 20_000
      while (!lines.length) {
        assert.ok(!status, `fixture exited ${JSON.stringify(status)}\n${stderr}`)
        assert.ok(Date.now() < deadline, `fixture timed out\n${stderr}`)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 50)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      return lines.shift()
    },
    raw(line) {
      child.stdin.write(`${line}\n`)
      return this.next()
    },
    frame(method, body = {}, expectedRevision, operationID = randomUUID(), extra = {}) {
      const read = ['list', 'read', 'reference', 'pins'].includes(method)
      return {
        service: 'skills',
        id: ++id,
        request: {
          connection,
          requestID: randomUUID(),
          operationID,
          scope: {},
          mode: read ? 'read' : 'mutation',
          ...(expectedRevision ? { expectedRevision } : {}),
          service: 'skills',
          method,
          body,
          ...extra
        }
      }
    },
    send(frame) {
      return this.raw(JSON.stringify(frame))
    },
    /** Writes a frame answered later (a GitHub import); read its reply with `next`/`replies`. */
    post(frame) {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      return frame
    },
    /** The next `count` lines, keyed by frame id (deferred replies arrive in any order). */
    async replies(count) {
      const out = new Map()
      for (let index = 0; index < count; index++) {
        const line = await this.next()
        out.set(line.id, line)
      }
      return out
    },
    call(method, body = {}) {
      return this.send(this.frame(method, body))
    },
    /** A ledger mutation on the current registry revision. */
    async mutate(method, body, operationID) {
      const { revision } = ok(await this.call('list'))
      return this.send(this.frame(method, body, revision, operationID))
    },
    command(value) {
      return this.raw(JSON.stringify(value))
    },
    async crash(frame) {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      const result = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 20_000))
      ])
      assert.equal(
        result?.signal,
        'SIGKILL',
        `expected SIGKILL, got ${JSON.stringify(result)}\n${stderr}`
      )
      assert.equal(lines.length, 0, 'no reply escaped before the crash')
    },
    async close() {
      child.stdin.end()
      assert.equal((await exited).code, 0, stderr)
    }
  }
  const ready = await fx.next()
  assert.equal(ready.ready, true, stderr)
  assert.equal(ready.ledger, true, stderr)
  return fx
}

export const ok = (reply) => {
  const result = reply.reply?.result ?? reply.result
  assert.equal(result.kind, 'succeeded', JSON.stringify(reply))
  return result.payload
}
export const code = (reply) => {
  const result = reply.reply?.result ?? reply.result
  assert.equal(result.kind, 'failed', JSON.stringify(reply))
  return result.payload.code
}

/** A pipe-shaped link to a fixture process for `serviceSkills`. */
export function link(binary, dir, env = {}) {
  const child = spawn(binary, [dir], {
    env: { ...process.env, SKILLS_NOW: String(NOW), ...env },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  live.add(child)
  child.on('exit', () => live.delete(child))
  const emitter = new EventEmitter(),
    held = [],
    results = []
  let holding = false,
    ready
  const started = new Promise((resolve) => {
    ready = resolve
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.ready) ready()
    else if (message.event) emitter.emit(message.event, message)
    else results.shift()?.(message)
  })
  const write = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`)
  return Object.assign(emitter, {
    started,
    sendService(frame) {
      holding ? held.push(frame) : write(frame)
    },
    /** A fixture command (e.g. the service-internal `install`), answered in order. */
    command(value) {
      return new Promise((resolve) => {
        results.push(resolve)
        write(value)
      })
    },
    hold() {
      holding = true
    },
    flush() {
      holding = false
      for (const frame of held.splice(0)) write(frame)
    },
    async close() {
      child.stdin.end()
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
}

/** Every file and link under `root` with its bytes' SHA-256 (or link target). */
export function tree(root) {
  const out = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = lstatSync(path),
        key = relative(root, path)
      if (stat.isSymbolicLink()) out[key] = 'link'
      else if (stat.isDirectory()) {
        out[`${key}/`] = 'dir'
        walk(path)
      } else out[key] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

export const skillMd = (name, description = `The ${name} skill.`, body = `# ${name}\n`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
export const files = (name, extra = {}, description, body) => [
  { path: 'SKILL.md', text: skillMd(name, description, body) },
  ...Object.entries(extra).map(([path, text]) => ({ path, text }))
]

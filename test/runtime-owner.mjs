// S06 managed project runtime: the real Swift RuntimeOwner (compiled into a fixture
// process, which is also its own group watchdog) driven through Bun's client.
// Detection/command/URL parity with the TS runner; process groups, descendants,
// repeated stops, failed readiness, restart, installs and their failures; crash
// recovery by watchdog and journal without touching unrelated processes; drain on
// close; the static site's HTTP layer, traversal, SSE and watcher over a socketpair;
// stamping through the JS helper. Sections that need a listening socket run only
// where local binding is allowed and otherwise make the whole test report SKIP.
import './helpers/with-repository-owner.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { hostVariants, normalizeUrl, stripAnsi, URL_RE } from '../src/main/devserver-net.ts'
import { registerServiceDevServer } from '../src/main/devserver-service.ts'
import {
  installProjectDependencies,
  setDependencyInstaller
} from '../src/main/project-dependencies.ts'
import { detectProject, interpretFailure, withPort } from '../src/main/project-detect.ts'
import { serviceRuntime } from '../src/native/runtime-service.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'trezi-runtime-owner-'))
const binary = join(scratch, 'runtime-fixture')
const live = new Set()
const strays = new Set()
const skipped = []
let cases = 0
const PORT = 47000 + (process.pid % 900)

/**
 * Compiles the fixture, or reuses a binary built from byte-identical sources. Cold,
 * this is a 16-file swiftc build that takes 30-45 s while other Swift-compiling
 * tests run beside it and it spends the shared 120 s budget. The cache key covers
 * every source and the compiler version, so an edited source always rebuilds; the
 * build goes to a private path and is renamed into place, so parallel runs never
 * see a half-written binary.
 */
function compile() {
  const sources = [
    'ServiceContract',
    'LedgerStore',
    'OperationLedger',
    'PreferencesFile',
    'PreferencesOwner',
    'WorkspaceFile',
    'WorkspaceOwner',
    'DomainChannel',
    'ProcessGuardian',
    'ManagedProcess',
    'RuntimeNet',
    'RuntimeDetect',
    'StaticSite',
    'StaticServer',
    'RuntimeServer',
    'RuntimeOwner'
  ].map((name) => `src/service/${name}.swift`)
  const files = [...sources, 'test/fixtures/runtime-owner/main.swift']
  const compiler = spawnSync('xcrun', ['swiftc', '--version'], { encoding: 'utf8' })
  const key = createHash('sha256')
  key.update(`${compiler.stdout}${compiler.stderr}`)
  for (const file of files) key.update(`${file}\0`).update(readFileSync(join(root, file)))
  const cache = join(tmpdir(), 'trezi-runtime-owner-cache')
  mkdirSync(cache, { recursive: true })
  const cached = join(cache, `fixture-${key.digest('hex').slice(0, 24)}`)
  if (!existsSync(cached)) {
    const building = `${cached}.${process.pid}.tmp`
    const result = spawnSync(
      'xcrun',
      [
        'swiftc',
        '-module-cache-path',
        join(cache, 'module-cache'),
        ...files,
        '-framework',
        'CoreServices',
        '-o',
        building
      ],
      { cwd: root, encoding: 'utf8', timeout: 400_000 }
    )
    assert.equal(
      result.status,
      0,
      `swiftc: ${result.error || ''}\n${result.stdout}\n${result.stderr}`
    )
    renameSync(building, cached)
  }
  // A private copy: the fixture is also its own watchdog, so it must not be replaced under a run.
  writeFileSync(binary, readFileSync(cached), { mode: 0o755 })
}

const dir = (name = `case-${++cases}`) => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}
const write = (path, content, mode) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (mode) chmodSync(path, mode)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
async function until(check, ms = 5000, label = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}
const pidIn = async (path, ms = 5000) =>
  Number(await until(() => existsSync(path) && readFileSync(path, 'utf8').trim(), ms, path))
const dead = (pid, ms = 5000) => until(() => !alive(pid), ms, `pid ${pid} to exit`)

/** The fixture plus Bun's real client over its stdin/stdout. */
async function start(profile, env = {}) {
  const child = spawn(binary, [profile], {
    env: { ...process.env, RUNTIME_PORT: String(PORT), ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  live.add(child)
  const link = new EventEmitter()
  const lines = [],
    waiters = new Set(),
    logs = []
  let stderr = '',
    status = null
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.event === 'service-reply' || message.event === 'service-event') {
      if (message.kind === 'log') logs.push(message.line)
      link.emit(message.event, message)
    } else lines.push(message)
    for (const wake of waiters) wake()
  })
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      live.delete(child)
      status = { code, signal }
      resolve(status)
      for (const wake of waiters) wake()
    })
  )
  link.sendService = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`)
  const fixture = {
    child,
    link,
    logs,
    exited,
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
    runtime(options) {
      return serviceRuntime(link, options)
    }
  }
  fixture.ready = await fixture.next()
  assert.equal(fixture.ready.ready, true)
  return fixture
}
async function stop(fixture) {
  fixture.child.stdin.end()
  await fixture.exited
}

async function section(name, run) {
  const outcome = await run()
  console.log(`RUNTIME-OWNER ${name} ${outcome === 'skip' ? 'skipped (environment)' : 'PASS'}`)
}

try {
  compile()

  await section('parity', async () => {
    const projects = []
    const project = (files) => {
      const path = dir()
      for (const [name, content] of Object.entries(files)) write(join(path, name), content)
      projects.push(path)
      return path
    }
    project({ 'index.html': '<h1>x</h1>' })
    project({ 'b.html': '', 'A.html': '', 'notes.txt': '' })
    project({})
    project({ '.gitignore': '', '.trezi/x': '' })
    project({ 'readme.md': '' })
    project({
      'package.json': JSON.stringify({
        name: 'vite-app',
        scripts: { dev: 'vite' },
        devDependencies: { vite: '5' }
      }),
      'bun.lock': ''
    })
    project({
      'package.json': JSON.stringify({
        scripts: { start: 'next start' },
        dependencies: { next: '14' }
      }),
      'pnpm-lock.yaml': ''
    })
    project({
      'package.json': JSON.stringify({
        packageManager: 'yarn@4.1.0',
        scripts: { dev: 'x' },
        dependencies: { '@sveltejs/kit': '2' }
      }),
      'package-lock.json': ''
    })
    project({
      'package.json': JSON.stringify({ dependencies: { expo: '50', 'react-native': '0.7' } })
    })
    project({
      'package.json': JSON.stringify({ dependencies: { 'react-native': '0.7' } }),
      'bun.lockb': ''
    })
    project({ 'package.json': JSON.stringify({ name: 'plain' }), 'index.html': '' })
    project({
      'package.json': JSON.stringify({ devDependencies: { vite: '5' } }),
      'index.html': ''
    })
    project({ 'package.json': '{not json' })
    project({ 'package.json': 'null' })
    project({ 'package.json': '[]', 'site.htm': '' })
    project({
      'package.json': JSON.stringify({
        dependencies: { next: '1' },
        devDependencies: { next: '' },
        scripts: { dev: 'x' }
      })
    })
    project({
      'package.json': JSON.stringify({
        name: 5,
        scripts: { dev: '', start: 'x' },
        dependencies: { 'react-scripts': '5' }
      }),
      'yarn.lock': ''
    })
    project({
      'package.json': JSON.stringify({ packageManager: '@bad', scripts: { dev: 'x' } }),
      'yarn.lock': ''
    })
    project({
      'package.json': '{"scripts":{"dev":"a"},"scripts":{"start":"b"},"dependencies":"vite"}'
    })
    projects.push(join(scratch, 'missing-root'))
    const fixture = await start(dir())
    const { results } = await fixture.cmd({ cmd: 'detect', roots: projects })
    for (const [index, path] of projects.entries()) {
      let expected
      try {
        expected = await detectProject(path)
      } catch (error) {
        expected = { error: error.message }
      }
      const actual = results[index]
      if ('error' in expected) {
        assert.ok(
          'error' in actual,
          `${path}: Swift detected ${JSON.stringify(actual)}, TS failed ${expected.error}`
        )
        if (/Enter a command/.test(expected.error)) assert.equal(actual.error, expected.error)
      } else assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)), path)
    }
    const commandCases = [
      ['npm run dev', 'vite'],
      ['bun run dev', 'sveltekit'],
      ['npm run dev', 'next'],
      ['npm run dev -- --turbo', 'next'],
      ['  npm   run-script dev', 'next'],
      ['npm runner', 'next'],
      ['bun run dev', 'next'],
      ['pnpm dev', 'next'],
      ['npm run dev', 'cra'],
      ['make serve', 'unknown'],
      ['npm run dev', 'next'],
      ['npm run dev --', 'next'],
      ['yarn dev', undefined]
    ].map(([command, framework]) => ({ command, ...(framework ? { framework } : {}) }))
    const failureCases = [
      { code: 1, tail: 'Error: listen EADDRINUSE: address already in use :::5173' },
      { code: 1, tail: 'Port 3000 is in use, trying another one' },
      { code: 2, tail: 'x'.repeat(900) + 'end' },
      { code: null, tail: '' },
      { code: 1, tail: 'Unable to acquire lock at .next/dev/lock' }
    ]
    const { commands, failures } = await fixture.cmd({
      cmd: 'commands',
      cases: [...commandCases, ...failureCases]
    })
    commandCases.forEach((item, index) => {
      assert.equal(
        commands[index],
        withPort(item.command, item.framework, 7777),
        JSON.stringify(item)
      )
    })
    failureCases.forEach((item, index) => {
      const actual = failures[commandCases.length + index]
      assert.equal(actual.message, interpretFailure(item.code, item.tail), JSON.stringify(item))
      assert.equal(actual.conflict, actual.message.startsWith('A dev server is already running'))
    })
    const texts = [
      '  VITE v5  ready\n  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m',
      'Server at http://0.0.0.0:3000.',
      'open (http://127.0.0.1:8080/app).',
      'HTTPS://LOCALHOST:443/x y',
      'nothing here',
      'http://example.com',
      '\t  padded 　﻿',
      'url http://localhost:3000 next'
    ]
    const raw = [
      'http://0.0.0.0:3000/',
      'http://localhost:5173/',
      'http://[::1]:4000/a/',
      'http://127.0.0.1',
      'http://example.com:80/',
      'https://localhost/x).,',
      'not a url'
    ]
    const net = await fixture.cmd({ cmd: 'net', texts, raw })
    texts.forEach((text, index) => {
      assert.equal(net.urls[index], text.match(URL_RE)?.[1] ?? null, `url ${JSON.stringify(text)}`)
      assert.equal(net.stripped[index], stripAnsi(text))
      assert.equal(net.trimmed[index], text.trim())
    })
    raw.forEach((value, index) => {
      assert.equal(net.normalized[index], normalizeUrl(value))
      assert.deepEqual(net.variants[index], hostVariants(value))
    })
    await stop(fixture)
  })

  await section('process lifecycle', async () => {
    const profile = dir()
    const fixture = await start(profile, { RUNTIME_READY_TIMEOUT: '1.5' })
    const runtime = fixture.runtime()
    const project = dir()
    const failing = (command, pattern, code = 'unavailable') =>
      assert.rejects(runtime.start({ root: project, command }), (error) => {
        assert.equal(error.code, code, error.message)
        assert.match(error.message, pattern)
        return true
      })
    await failing(
      'echo booting; exit 3',
      /^Dev server exited \(code 3\) before printing a URL\.\n[\s\S]*booting/
    )
    assert.ok(
      fixture.logs.includes(`Assigned free port ${PORT} (binding 127.0.0.1).`),
      'port assignment is logged'
    )
    assert.ok(fixture.logs.includes('booting'), 'server output is logged')
    await failing(
      'echo "Error: listen EADDRINUSE: address already in use 127.0.0.1:7777" >&2; exit 1',
      /^A dev server is already running for this project/,
      'conflict'
    )
    // Descendants never outlive a shell that exits on its own.
    await failing(`sleep 300 & echo $! > "${project}/orphan.pid"; exit 4`, /code 4/)
    await dead(await pidIn(join(project, 'orphan.pid')))
    // Failed readiness stops the whole group.
    await failing(
      `sleep 300 & echo $! > "${project}/slow.pid"; wait`,
      /^Timed out waiting for a localhost URL\./,
      'deadlineExceeded'
    )
    await dead(await pidIn(join(project, 'slow.pid')))
    assert.deepEqual(
      (await fixture.cmd({ cmd: 'journal' })).groups,
      [],
      'ended groups leave the journal'
    )
    // Repeated stops during readiness join one cleanup; TERM is ignored, so KILL after the grace.
    const stubborn = runtime.start({
      root: project + '/',
      command: `trap "" TERM; sleep 300 & echo $! > "${project}/stubborn.pid"; wait`
    })
    stubborn.catch(() => {})
    const stubbornPID = await pidIn(join(project, 'stubborn.pid'))
    const info = await runtime.info(project)
    assert.equal(info.running, true)
    assert.equal(info.server, undefined, 'not ready, so no server info')
    const began = Date.now()
    await Promise.all([runtime.stop(project), runtime.stop(project + '/'), runtime.stop(project)])
    assert.ok(Date.now() - began >= 900, 'the grace period was honored before KILL')
    await dead(stubbornPID, 1000)
    await assert.rejects(
      stubborn,
      (error) => error.code === 'cancelled' && error.message === 'Preview start was cancelled.'
    )
    assert.deepEqual(await runtime.info(project), { running: false })
    // Restart never overlaps the previous group.
    const first = runtime.start({
      root: project,
      command: `sleep 300 & echo $! > "${project}/first.pid"; wait`
    })
    first.catch(() => {})
    const firstPID = await pidIn(join(project, 'first.pid'))
    await assert.rejects(
      runtime.start({
        root: project,
        command: `kill -0 ${firstPID} 2>/dev/null && echo FIRST-ALIVE; echo second; exit 7`
      }),
      (error) =>
        /code 7/.test(error.message) &&
        !/FIRST-ALIVE/.test(error.message) &&
        /second/.test(error.message)
    )
    await assert.rejects(first, (error) => error.code === 'cancelled')
    await dead(firstPID, 1000)
    // Strict frames: unknown fields and relative roots are refused before anything runs.
    await assert.rejects(
      runtime.start({ root: 'relative', command: 'exit 0' }),
      (error) => error.code === 'invalidRequest'
    )
    fixture.link.sendService({
      service: 'runtime',
      id: 999,
      request: {
        connection: crypto.randomUUID(),
        requestID: crypto.randomUUID(),
        operationID: crypto.randomUUID(),
        scope: {},
        mode: 'mutation',
        service: 'runtime',
        method: 'start',
        body: { root: project, command: 'touch "' + project + '/ran"', extra: 1 }
      }
    })
    await sleep(300)
    assert.ok(!existsSync(join(project, 'ran')), 'an invalid frame runs nothing')
    await stop(fixture)
  })

  // LKM-146: a ready server that ends by itself, or stops answering, is reported with why.
  await section('exit and health', async () => {
    const up = join(dir(), 'up')
    write(up, '')
    const fixture = await start(dir(), {
      RUNTIME_PROBE_FILE: up,
      RUNTIME_HEALTH_INTERVAL: '0.1',
      RUNTIME_HEALTH_FAILURES: '3',
      RUNTIME_READY_TIMEOUT: '5'
    })
    const runtime = fixture.runtime()
    const exits = []
    runtime.onExit((root, url, reason) => exits.push({ root, url, reason }))
    const project = dir()
    const crashing = await runtime.start({
      root: project,
      command: `echo serving; while [ ! -f "${project}/crash" ]; do sleep 0.05; done; echo "Error: boom"; exit 2`
    })
    write(join(project, 'crash'), '')
    const crashed = await until(() => exits[0], 5000, 'the exit event')
    assert.deepEqual([crashed.root, crashed.url], [project, crashing.url])
    assert.match(crashed.reason, /^The dev server exited \(code 2\)\.\n[\s\S]*Error: boom/)
    assert.deepEqual(await runtime.info(project), { running: false })
    // Unanswered probes in a row stop the group; its exit says it stopped responding.
    const hung = await runtime.start({
      root: project,
      command: `echo $$ > "${project}/hung.pid"; while true; do sleep 0.05; done`
    })
    const pid = await pidIn(join(project, 'hung.pid'))
    await sleep(500)
    assert.ok(alive(pid) && exits.length === 1, 'a server that answers is left alone')
    rmSync(up)
    const stopped = await until(() => exits[1], 5000, 'the unresponsive exit')
    assert.deepEqual(stopped, {
      root: project,
      url: hung.url,
      reason: 'The dev server stopped responding.'
    })
    await dead(pid)
    assert.ok(
      fixture.logs.includes(`The dev server stopped responding at ${hung.url}; stopping it.`)
    )
    // A stop is not an exit the preview recovers from.
    write(up, '')
    await runtime.start({ root: project, command: 'while true; do sleep 0.05; done' })
    await runtime.stop(project)
    await sleep(300)
    assert.equal(exits.length, 2, 'a stop emits no exit event')
    await stop(fixture)
  })

  await section('installs', async () => {
    const bin = dir()
    write(
      join(bin, 'npm'),
      `#!/bin/sh
echo "npm $* in $PWD"
if [ -f fail ]; then echo "E404 broken" >&2; exit 3; fi
if [ -f spawn ]; then sleep 300 & echo $! > spawned.pid; fi
if [ -f hang ]; then sleep 300 & echo $! > hang.pid; wait; fi
exit 0
`,
      0o755
    )
    write(join(bin, 'bun'), '#!/bin/sh\necho "bun $* selected"\n', 0o755)
    const PATH = `${bin}:/usr/bin:/bin`
    const fixture = await start(dir(), { PATH })
    const runtime = fixture.runtime()
    const project = (files) => {
      const path = dir()
      for (const [name, content] of Object.entries(files)) write(join(path, name), content)
      return path
    }
    const plain = project({ 'package.json': '{}' })
    assert.equal(await runtime.install(plain), true)
    assert.ok(fixture.logs.includes('Installing project dependencies with npm…'))
    assert.ok(
      fixture.logs.some((line) => line.startsWith('npm install in ')),
      'the install ran in the project'
    )
    assert.equal(await runtime.install(project({ 'package.json': '{}', 'bun.lock': '' })), true)
    assert.ok(
      fixture.logs.includes('bun install selected'),
      "the project's own runtime (Bun) is used"
    )
    await assert.rejects(
      runtime.install(project({ 'package.json': '{"packageManager":"pnpm@9"}' })),
      /Could not install project dependencies with pnpm: pnpm was not found on PATH/
    )
    await assert.rejects(
      runtime.install(project({ 'package.json': '{}', fail: '' })),
      /Could not install project dependencies with npm: `npm install` exited with code 3\.\n[\s\S]*E404 broken/
    )
    const spawner = project({ 'package.json': '{}', spawn: '' })
    assert.equal(await runtime.install(spawner), true)
    await dead(await pidIn(join(spawner, 'spawned.pid')))
    assert.equal(await runtime.install(project({})), false, 'no package.json, nothing to install')
    // Bun's queue wrapper routes through the owner; the repository lease stays in Bun.
    setDependencyInstaller((path) => runtime.install(path))
    await installProjectDependencies(plain)
    setDependencyInstaller(null)
    await stop(fixture)
    const slow = await start(dir(), { PATH, RUNTIME_INSTALL_TIMEOUT: '1' })
    const hanging = project({ 'package.json': '{}', hang: '' })
    const slowRuntime = slow.runtime()
    const first = slowRuntime.install(hanging)
    first.catch(() => {})
    await assert.rejects(slowRuntime.install(hanging), (error) => error.code === 'busy')
    await assert.rejects(
      first,
      (error) =>
        error.code === 'deadlineExceeded' && /did not finish within 1 seconds/.test(error.message)
    )
    await dead(await pidIn(join(hanging, 'hang.pid')))
    await stop(slow)
  })

  await section('dev-server routes', async () => {
    const bin = dir()
    write(join(bin, 'npm'), '#!/bin/sh\necho installing; sleep 1; exit 0\n', 0o755)
    const fixture = await start(dir(), { PATH: `${bin}:/usr/bin:/bin`, RUNTIME_READY_TIMEOUT: '2' })
    const runtime = fixture.runtime()
    const handlers = new Map(),
      logs = []
    registerServiceDevServer({ handle: (name, fn) => handlers.set(name, fn) }, runtime, (line) =>
      logs.push(line)
    )
    setDependencyInstaller((path) => runtime.install(path))
    const project = dir()
    write(join(project, 'package.json'), '{}')
    // A stop during the start's install discards that start.
    const started = handlers.get('devserver:start')(
      {},
      { root: project, command: 'exit 0', installDependencies: true }
    )
    started.catch(() => {})
    await until(() => logs.includes('installing'), 5000, 'install output')
    await handlers.get('devserver:stop')({}, project)
    await assert.rejects(started, /Preview start was cancelled\./)
    // A landing's install runs on its own route, in the given checkout (LKM-146).
    logs.length = 0
    await handlers.get('devserver:install')({}, project)
    assert.ok(
      logs.includes('installing') &&
        logs.some((line) => line.startsWith('Installing project dependencies with npm'))
    )
    await assert.rejects(
      handlers.get('devserver:start')({}, { root: project, command: 'echo nope; exit 9' }),
      /code 9/
    )
    assert.deepEqual(await handlers.get('devserver:info')({}, project), { running: false })
    assert.equal(await handlers.get('devserver:running')({}, project), false)
    setDependencyInstaller(null)
    await stop(fixture)
  })

  await section('crash recovery', async () => {
    const project = dir()
    const command = (name) => `sleep 300 & echo $! > "${project}/${name}.pid"; wait`
    // The watchdog stops the group when the service dies.
    const watched = await start(dir())
    void watched
      .runtime()
      .start({ root: project, command: command('watched') })
      .catch(() => {})
    const watchedPID = await pidIn(join(project, 'watched.pid'))
    watched.child.kill('SIGKILL')
    await watched.exited
    await dead(watchedPID, 3000)
    // Without a watchdog, the journal sweep at the next launch stops it.
    const profile = dir()
    const unwatched = await start(profile, { RUNTIME_NO_WATCHDOG: '1' })
    void unwatched
      .runtime()
      .start({ root: project, command: command('journal') })
      .catch(() => {})
    const journalPID = await pidIn(join(project, 'journal.pid'))
    const [group] = await until(
      async () => {
        const { groups } = await unwatched.cmd({ cmd: 'journal' })
        return groups.length && groups
      },
      3000,
      'journal entry'
    )
    unwatched.child.kill('SIGKILL')
    await unwatched.exited
    await sleep(400)
    assert.ok(alive(journalPID), 'nothing but the journal would stop this orphan')
    const relaunch = await start(profile)
    assert.deepEqual(relaunch.ready.swept, [group])
    await dead(journalPID, 3000)
    assert.deepEqual((await relaunch.cmd({ cmd: 'journal' })).groups, [])
    // A recorded pid now held by an unrelated process is never signalled.
    const unrelated = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' })
    strays.add(unrelated.pid)
    const { started } = await relaunch.cmd({ cmd: 'identity', pid: unrelated.pid })
    await stop(relaunch)
    const journal = join(profile, 'service/runtime/processes.json')
    writeFileSync(
      journal,
      JSON.stringify({
        version: 1,
        groups: [
          { pgid: unrelated.pid, started: String(BigInt(started) + 1n) },
          { pgid: 999_999, started: '1' }
        ]
      })
    )
    const cautious = await start(profile)
    assert.deepEqual(cautious.ready.swept, [])
    assert.ok(alive(unrelated.pid), 'an unrelated process with a reused pid is left alone')
    await stop(cautious)
    writeFileSync(
      journal,
      JSON.stringify({ version: 1, groups: [{ pgid: unrelated.pid, started }] })
    )
    const exact = await start(profile)
    assert.deepEqual(exact.ready.swept, [unrelated.pid], 'the recorded group itself is stopped')
    await dead(unrelated.pid)
    await stop(exact)
    // A sweep with no journal creates none.
    assert.ok(!existsSync(join(dir(), 'service')))
  })

  await section('drain on close', async () => {
    const bin = dir()
    write(join(bin, 'npm'), '#!/bin/sh\nsleep 300 & echo $! > hang.pid; wait\n', 0o755)
    const fixture = await start(dir(), { PATH: `${bin}:/usr/bin:/bin` })
    const runtime = fixture.runtime()
    const one = dir(),
      two = dir(),
      three = dir()
    write(join(three, 'package.json'), '{}')
    const pending = [
      runtime.start({
        root: one,
        command: `trap "" TERM; sleep 300 & echo $! > "${one}/a.pid"; wait`
      }),
      runtime.start({ root: two, command: `sleep 300 & echo $! > "${two}/b.pid"; wait` }),
      runtime.install(three)
    ].map((promise) => promise.catch((error) => error))
    const pids = await Promise.all([
      pidIn(join(one, 'a.pid')),
      pidIn(join(two, 'b.pid')),
      pidIn(join(three, 'hang.pid'))
    ])
    const closed = await fixture.cmd({ cmd: 'close' })
    assert.deepEqual(closed, { closed: true, groups: [] })
    for (const pid of pids) await dead(pid, 1000)
    for (const error of await Promise.all(pending)) assert.equal(error.code, 'cancelled')
    await assert.rejects(
      runtime.start({ root: one, command: 'exit 0' }),
      (error) => error.code === 'unavailable' && /stopping/.test(error.message)
    )
    await stop(fixture)
  })

  await section('static http', async () => {
    const outside = dir()
    write(join(outside, 'secret.txt'), 'secret')
    const site = dir()
    write(join(site, 'index.html'), '<!doctype html><html><body><h1>Home</h1></body></html>')
    write(join(site, 'about.html'), '<h1>About</h1>')
    write(join(site, 'sub/index.html'), '<body><h1>Sub</h1></body>')
    write(join(site, 'style.css'), 'body{color:red}')
    write(join(site, 'data.bin'), Buffer.from([0, 1, 2, 255]))
    symlinkSync(join(outside, 'secret.txt'), join(site, 'leak.txt'))
    symlinkSync(outside, join(site, 'leakdir'))
    symlinkSync(join(site, 'style.css'), join(site, 'alias.css'))
    const fixture = await start(dir())
    const http = async (request, target = site) => {
      const { response } = await fixture.cmd({ cmd: 'http', root: target, request })
      const bytes = Buffer.from(response, 'base64')
      const split = bytes.indexOf('\r\n\r\n')
      const head = bytes.subarray(0, split).toString().split('\r\n')
      const headers = Object.fromEntries(
        head
          .slice(1)
          .map((line) => [
            line.slice(0, line.indexOf(':')).toLowerCase(),
            line.slice(line.indexOf(':') + 2)
          ])
      )
      return { status: Number(head[0].split(' ')[1]), headers, body: bytes.subarray(split + 4) }
    }
    const get = (path, method = 'GET') => http(`${method} ${path} HTTP/1.1\r\nHost: x\r\n\r\n`)
    const home = await get('/')
    assert.equal(home.status, 200)
    assert.equal(home.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(home.headers['cache-control'], 'no-cache')
    assert.equal(Number(home.headers['content-length']), home.body.length)
    assert.match(
      home.body.toString(),
      /<h1 data-stamped="index.html">Home<\/h1><script>\(function\(\)\{try\{var v="0",es=new EventSource\("\/__trezi_reload\?v="\+v\)/
    )
    assert.ok(
      home.body.toString().endsWith('</script></body></html>'),
      'snippet goes before </body>'
    )
    assert.ok(
      (await get('/about.html')).body.toString().endsWith('</script>'),
      'appended without </body>'
    )
    const head = await get('/', 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers['content-length'], home.headers['content-length'])
    assert.equal(
      (await get('/sub/')).body.toString().includes('data-stamped="sub/index.html"'),
      true
    )
    const css = await get('/style.css?x=1')
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')
    assert.equal(css.body.toString(), 'body{color:red}')
    assert.equal((await get('/data.bin')).headers['content-type'], 'application/octet-stream')
    assert.deepEqual([...(await get('/data.bin')).body], [0, 1, 2, 255])
    const missing = await get('/nope<b>.html')
    assert.equal(missing.status, 404)
    assert.match(missing.body.toString(), /Not found: \/nope&lt;b>\.html/)
    // Traversal: every escape resolves inside the root (404) or is refused (403).
    for (const path of [
      '/../../etc/passwd',
      '/%2e%2e/%2e%2e/secret.txt',
      '/..%2f..%2fsecret.txt',
      '/sub/../../secret.txt',
      '/..\\secret.txt'
    ]) {
      assert.equal((await get(path)).status, 404, path)
    }
    for (const path of [
      '/%zz',
      '/%C0%AF',
      '/a%00b',
      '/leak.txt',
      '/leakdir/secret.txt',
      '/%',
      '/%+f'
    ])
      assert.equal((await get(path)).status, 403, path)
    assert.equal((await get('/alias.css')).status, 200, 'a symlink inside the project is served')
    assert.equal((await get('/%2e%2e')).status, 200, '/.. clamps to the root')
    const post = await get('/', 'POST')
    assert.equal(post.status, 405)
    assert.equal(post.headers.allow, 'GET, HEAD')
    assert.equal((await http(`GET / HTTP/1.1\r\nX: ${'a'.repeat(20_000)}\r\n\r\n`)).status, 431)
    assert.equal((await http('garbage\r\n\r\n')).status, 400)
    // Live reload: level-triggered version, broadcast, and every stream ended on close.
    const opened = await fixture.cmd({
      cmd: 'open-stream',
      root: site,
      name: 'a',
      request: 'GET /__trezi_reload?v=0 HTTP/1.1\r\n\r\n'
    })
    const first = Buffer.from(opened.response, 'base64').toString()
    assert.match(
      first,
      /^HTTP\/1\.1 200 OK\r\nContent-Type: text\/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\nretry: 1000\n\n$/
    )
    assert.equal(opened.clients, 1)
    assert.equal((await fixture.cmd({ cmd: 'changed', root: site })).version, 1)
    assert.equal(
      (await fixture.cmd({ cmd: 'read-stream', name: 'a', until: 'data: 1' })).received,
      'data: 1\n\n'
    )
    const stale = await fixture.cmd({
      cmd: 'open-stream',
      root: site,
      name: 'b',
      request: 'GET /__trezi_reload?v=0 HTTP/1.1\r\n\r\n'
    })
    assert.ok(
      Buffer.from(stale.response, 'base64').toString().endsWith('retry: 1000\n\ndata: 1\n\n'),
      'a page that missed a change reloads on connect'
    )
    assert.equal((await fixture.cmd({ cmd: 'close-site', root: site })).closed, true)
    assert.equal(
      (await fixture.cmd({ cmd: 'read-stream', name: 'a', until: '\u0000' })).received,
      '',
      'stream ended'
    )
    assert.equal((await fixture.cmd({ cmd: 'state', root: site })).clients, 0)
    await stop(fixture)
  })

  await section('watcher', async () => {
    const site = dir()
    write(join(site, 'index.html'), '<h1>x</h1>')
    mkdirSync(join(site, '.git'))
    mkdirSync(join(site, 'node_modules'))
    const fixture = await start(dir())
    const state = () => fixture.cmd({ cmd: 'state', root: site })
    let watched = await fixture.cmd({ cmd: 'watch', root: site })
    if ('log' in watched) {
      // FSEvents refused (a sandbox): reported in the project's log, never fatal.
      assert.match(watched.log, /^Live reload unavailable: cannot watch /)
      watched = await fixture.next()
      assert.equal(watched.watching, false)
      assert.equal(
        (await fixture.cmd({ cmd: 'http', root: site, request: 'GET / HTTP/1.1\r\n\r\n' })).response
          .length > 0,
        true,
        'still serves'
      )
      skipped.push('watcher (FSEvents unavailable)')
      await stop(fixture)
      return 'skip'
    }
    assert.equal(watched.watching, true)
    await sleep(300)
    const base = (await state()).version
    writeFileSync(join(site, 'index.html'), '<h1>y</h1>')
    await until(async () => (await state()).version > base, 5000, 'a watched change')
    await sleep(400)
    const settled = (await state()).version
    writeFileSync(join(site, '.git/index'), 'x')
    writeFileSync(join(site, 'node_modules/dep.js'), 'x')
    await sleep(600)
    assert.equal((await state()).version, settled, '.git and node_modules never reload the preview')
    assert.equal((await fixture.cmd({ cmd: 'close-site', root: site })).watching, false)
    writeFileSync(join(site, 'index.html'), '<h1>z</h1>')
    await sleep(600)
    assert.equal((await state()).version, settled, 'a closed watcher reports nothing')
    await stop(fixture)
  })

  await section('stamping helper', async () => {
    const site = dir()
    write(join(site, 'index.html'), '<body><h1>Stamp</h1></body>')
    const fixture = await start(dir(), { RUNTIME_STAMP: 'owner', RUNTIME_STAMP_TIMEOUT: '0.5' })
    const request = { cmd: 'http', root: site, request: 'GET / HTTP/1.1\r\n\r\n' }
    const body = async () => Buffer.from((await fixture.cmd(request)).response, 'base64').toString()
    let mode = 'stamp'
    fixture.runtime({
      stamp: async (html, path) => {
        if (mode === 'hang') return new Promise(() => {})
        if (mode === 'throw') throw new Error('parse5 failed')
        if (mode === 'huge') return 'x'.repeat(9 * 1024 * 1024)
        return html.replace('<h1', `<h1 data-trezi-source="${path}:1:7"`)
      }
    })
    assert.match(await body(), /<h1 data-trezi-source="index.html:1:7">Stamp/)
    for (const next of ['throw', 'huge', 'hang']) {
      mode = next
      const began = Date.now()
      assert.match(await body(), /<body><h1>Stamp<\/h1><script>/, `${next}: served unstamped`)
      assert.ok(Date.now() - began < 3000, `${next}: bounded`)
    }
    await stop(fixture)
  })

  // --- Sections that need a listening socket ---------------------------------
  const probe = await start(dir())
  const bindable = (await probe.cmd({ cmd: 'bind' })).bind === 'free'
  await stop(probe)
  if (!bindable) {
    skipped.push('sockets (local port binding)')
  } else
    await section('sockets', async () => {
      // Real servers become ready in well under a second. A short readiness timeout makes a
      // start that never becomes reachable fail in seconds, not after the 90 s default.
      const fixture = await start(dir(), { RUNTIME_PORT: '', RUNTIME_READY_TIMEOUT: '12' })
      const runtime = fixture.runtime()
      const site = dir()
      write(join(site, 'index.html'), '<body><h1>Live</h1></body>')
      const served = await runtime.start({ root: site, command: '', framework: 'static' })
      assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/)
      assert.equal(served.attached, false)
      const page = await (await fetch(served.url)).text()
      assert.match(page, /EventSource/)
      assert.deepEqual((await runtime.info(site)).server, served)
      await runtime.stop(site)
      await assert.rejects(fetch(served.url), 'the site stops listening')
      // A real server on the assigned port.
      const app = dir()
      write(
        join(app, 'server.mjs'),
        `const s = Bun.serve({ port: Number(process.env.PORT), hostname: process.env.HOST, fetch: () => new Response('app') }); console.log('listening', s.port)`
      )
      const ready = await runtime.start({ root: app, command: `"${process.execPath}" server.mjs` })
      assert.equal(await (await fetch(ready.url)).text(), 'app')
      // Restart: the old port is released, the new one serves.
      const again = await runtime.start({ root: app, command: `"${process.execPath}" server.mjs` })
      assert.equal(await (await fetch(again.url)).text(), 'app')
      if (again.url !== ready.url) await assert.rejects(fetch(ready.url))
      // Printed-URL fallback for a server that ignores PORT.
      const own = dir()
      write(
        join(own, 'server.mjs'),
        `const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('own') }); console.log('  Local: http://localhost:' + s.port + '/')`
      )
      const printed = await runtime.start({
        root: own,
        command: `"${process.execPath}" server.mjs`
      })
      assert.equal(await (await fetch(printed.url)).text(), 'own')
      assert.ok(fixture.logs.includes(`Serving at ${printed.url}.`))
      // Port conflict: an occupied port is never assigned, and a server that cannot bind is a conflict.
      for (const hostname of ['127.0.0.1', '0.0.0.0', '::']) {
        const holder = Bun.serve({ port: 0, hostname, fetch: () => new Response('stranger') })
        assert.equal(
          (await fixture.cmd({ cmd: 'free', port: holder.port })).free,
          false,
          `a listener on ${hostname} occupies the port`
        )
        holder.stop(true)
      }
      // A server that cannot bind its port is a conflict. The holder listens on the exact
      // address the child binds, so the child's EADDRINUSE is guaranteed (a specific bind
      // beside a wildcard listener is not refused on macOS under SO_REUSEADDR). It prints
      // the error and exits, as the frameworks do.
      const holder = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: () => new Response('stranger')
      })
      try {
        const conflict = dir()
        write(
          join(conflict, 'server.mjs'),
          `import { createServer } from 'node:net'
const server = createServer()
server.on('error', error => { console.error('listen ' + error.code + ': address already in use 127.0.0.1:' + ${holder.port}); process.exit(1) })
server.listen(${holder.port}, '127.0.0.1', () => console.log('bound unexpectedly'))`
        )
        const began = Date.now()
        await assert.rejects(
          runtime.start({ root: conflict, command: `"${process.execPath}" server.mjs` }),
          (error) => {
            assert.equal(error.code, 'conflict', error.message)
            assert.match(error.message, /^A dev server is already running for this project/)
            return true
          }
        )
        assert.ok(
          Date.now() - began < 10_000,
          'a conflict fails on the child exit, not on the readiness timeout'
        )
        assert.deepEqual(await runtime.info(conflict), { running: false })
      } finally {
        holder.stop(true)
      }
      await runtime.stopAll()
      await assert.rejects(fetch(again.url))
      await assert.rejects(fetch(printed.url))
      await stop(fixture)
    })
} finally {
  for (const child of live) child.kill('SIGKILL')
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true })
}
if (skipped.length)
  console.log(
    `RUNTIME-OWNER SKIP — ${skipped.join(', ')}: unavailable in this environment; every other section passed`
  )
else
  console.log(
    'RUNTIME-OWNER PASS — parity, lifecycle, installs, routes, crash recovery, drain, static http, watcher, helper, sockets'
  )
// Requests to fixtures killed on purpose (crash sections) still hold client timers.
process.exit(0)

// S14 platform owner: the real Swift PlatformOwner (compiled into a fixture process)
// driven through Bun's real client, with a scripted xcrun / idb / pkill and a scripted
// Metro. No Xcode, simulator, device or network beyond loopback is used.
// - pure helpers and preflight give the answers the retired TS runner gave (modes: Xcode missing, license,
//   no runtimes, no devices, SDK/runtime mismatch, a failing list, available);
// - simulator: unavailable, a view-only and an interactive bridge (host/token/size/stream
//   limits, idb input, select picks, stale-companion recovery), restart, cancel during
//   boot and during Metro, a newer start superseding, build failure, early exit, no
//   frames, drain on close and a crashed owner's Metro group swept at the next launch;
// - media grants, attachments and server recovery (test/helpers/platform-checks.mjs);
// - schema and denied capabilities.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skipUnlessDarwin } from './helpers/darwin.mjs'
import {
  checkAttachments,
  checkMedia,
  checkOpen,
  checkServers
} from './helpers/platform-checks.mjs'
import {
  compilePlatformFixture,
  http,
  installFakes,
  startPlatformFixture
} from './helpers/platform-fixture.mjs'

skipUnlessDarwin('the Swift platform owner')

// Run under the scripted tools (xcrun, idb, pkill first on the PATH). The real ones are never reached.
if (!process.env.TREZI_PLATFORM_FAKES) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-platform-fakes-')))
  const sim = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-platform-sim-')))
  installFakes(bin)
  const child = spawnSync(
    process.execPath,
    ['--no-install', new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        TREZI_PLATFORM_FAKES: bin,
        FAKE_SIM_DIR: sim,
        PATH: `${bin}:${process.env.PATH}`
      }
    }
  )
  rmSync(bin, { recursive: true, force: true })
  rmSync(sim, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
const bin = process.env.TREZI_PLATFORM_FAKES,
  sim = process.env.FAKE_SIM_DIR
const fakes = installFakes(bin)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-platform-owner-')))
const binary = compilePlatformFixture()
const began = Date.now()
const log = (...args) => console.log(`[${((Date.now() - began) / 1000).toFixed(1)}s]`, ...args)
const fixtures = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
async function gone(pid, what, ms = 6000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50))
    if (!alive(pid)) return
  assert.fail(`${what} (pid ${pid}) is still running`)
}
async function until(test, what, ms = 8000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) {
    const value = await test()
    if (value) return value
  }
  assert.fail(`timed out waiting for ${what}`)
}
const mode = (value) => {
  writeFileSync(join(sim, 'mode.json'), JSON.stringify(value))
  rmSync(join(sim, 'stale-count'), { force: true })
}
const calls = () =>
  existsSync(join(sim, 'calls.jsonl'))
    ? readFileSync(join(sim, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const bootStatus = () => {
  try {
    return JSON.parse(readFileSync(join(sim, 'bootstatus.json'), 'utf8'))
  } catch (error) {
    // The simulator fixture writes this file while the parent polls it.
    if (error instanceof SyntaxError || error.code === 'ENOENT') return null
    throw error
  }
}
const metros = () =>
  readdirSync(sim)
    .filter((name) => name.startsWith('metro-'))
    .map((name) => JSON.parse(readFileSync(join(sim, name), 'utf8')))
/** Cleanup only: a record can be mid-write or gone by now (a killed or failed start), and
 *  that must not hide the test's own result or leave the other Metros running. */
const leftoverMetros = () => {
  try {
    return readdirSync(sim)
      .filter((name) => name.startsWith('metro-'))
      .flatMap((name) => {
        try {
          return [JSON.parse(readFileSync(join(sim, name), 'utf8'))]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
/** A start that is expected to be refused later: handled now, inspected by `rejects`. */
const pending = (promise) => {
  promise.catch(() => {})
  return promise
}
const rejects = async (promise, code, pattern) => {
  const error = await promise.then(
    () => null,
    (error) => error
  )
  assert.ok(error, `expected a ${code} refusal`)
  assert.equal(error.code, code, error.message)
  if (pattern) assert.match(error.message, pattern)
  return error
}
const env = {
  FAKE_SIM_DIR: sim,
  PLATFORM_XCRUN: fakes.xcrun,
  PLATFORM_PKILL: fakes.pkill,
  PLATFORM_IDB: fakes.idb,
  PLATFORM_IDB_STATE: join(scratch, 'idb-state'),
  PLATFORM_BRIDGE_BASE: '17800'
}
async function fixture(profile, extra = {}) {
  mkdirSync(profile, { recursive: true })
  const started = await startPlatformFixture(binary, profile, { ...env, ...extra })
  fixtures.push(started)
  return started
}

try {
  // A React Native project (as far as the owner can tell).
  const project = join(scratch, 'rn-app')
  mkdirSync(project)
  writeFileSync(
    join(project, 'app.json'),
    JSON.stringify({ expo: { name: 'app', ios: { bundleIdentifier: 'com.example.app' } } })
  )
  const profile = join(scratch, 'profile')
  const f = await fixture(profile)
  const owner = f.owner()
  const logs = []
  owner.onSimulatorLog((line) => logs.push(line))
  const picks = []
  owner.onSimulatorPick((pick) => picks.push(pick))

  // The answers below are the retired TS runner's (xcode.ts, simulator.ts, attachments.ts),
  // recorded when LKM-111 removed it.
  log('pure helpers: the answers of the retired TS runner')
  const NOT_SELECTED =
    'Xcode is not installed or not selected. Install the full Xcode app, then run `sudo xcode-select -s /Applications/Xcode.app` and `xcodebuild -runFirstLaunch`.'
  const LICENSE =
    'Xcode is installed, but its license has not been accepted. Run `sudo xcodebuild -license accept` in a terminal, then reopen the project.'
  const mismatch = (sdk, newest) =>
    `Xcode's iOS SDK is ${sdk}, but no matching simulator runtime is installed (newest installed is iOS ${newest}). Builds need a runtime ≥ the SDK version. Download it with \`xcodebuild -downloadPlatform iOS\` (or Xcode → Settings → Components → Get the iOS simulator), then reopen the project.`
  const buildLog =
    "Explicit dependency on target Foo\nCompiling\nerror: no such module 'React'\n  in App.swift\nnext\nlater\nPhaseScriptExecution failed with a nonzero exit code\n"
  const pure = (
    await f.cmd({ cmd: 'pure', log: buildLog, sdk: '26.5', runtimes: ['26.0', '26.1'] })
  ).pure
  assert.equal(
    pure.extract,
    "error: no such module 'React'\n  in App.swift\nnext\nPhaseScriptExecution failed with a nonzero exit code"
  )
  assert.equal(pure.destination, mismatch('26.5', '26.1'))
  assert.equal(
    (await f.cmd({ cmd: 'pure', sdk: '26.0', runtimes: ['26.0'] })).pure.destination,
    null
  )
  assert.equal((await f.cmd({ cmd: 'pure', sdk: 'unknown', runtimes: [] })).pure.destination, null)
  for (const [id, source] of [
    ['trezi:src/App.tsx:12:4', 'src/App.tsx:12:4'],
    ['praxis:a/b.tsx:3', 'a/b.tsx:3'],
    ['trezi:../x', null],
    ['trezi:src/a b.tsx:1', null],
    ['button', null],
    ['trezi:src/App.tsx', null]
  ])
    assert.equal((await f.cmd({ cmd: 'pure', testID: id })).pure.source, source, id)
  const node = {
    type: 'View',
    children: [{ AXLabel: 'x' }, { nested: [{ AXUniqueId: 'trezi:src/A.tsx:1:2' }] }]
  }
  assert.equal((await f.cmd({ cmd: 'pure', node })).pure.stamp, 'trezi:src/A.tsx:1:2')
  const ui = (...args) => ['ui', args[0], '--udid', 'U', ...args.slice(1)]
  for (const [control, args] of [
    [{ type: 'tap', x: 0.5, y: 0.5 }, ui('tap', '201', '437')],
    [{ type: 'tap', x: -1, y: 2 }, ui('tap', '0', '874')],
    [
      { type: 'swipe', x: 0.1, y: 0.2, x2: 0.3, y2: 0.4, duration: 0.1 },
      ui('swipe', '40', '175', '121', '350', '--duration', '0.1')
    ],
    [
      { type: 'swipe', x: 0, y: 0, x2: 1, y2: 1 },
      ui('swipe', '0', '0', '402', '874', '--duration', '0.25')
    ],
    [{ type: 'text', text: 'é'.repeat(600) }, ui('text', 'é'.repeat(500))],
    [{ type: 'tap', x: 'a', y: 1 }, null],
    [{ type: 'pinch' }, null]
  ])
    assert.deepEqual(
      (await f.cmd({ cmd: 'pure', control })).pure.args,
      args,
      JSON.stringify(control).slice(0, 80)
    )
  for (const [name, fileName] of [
    ['Screen Shot 2026-09-29 at 10.00.00.png', '1-Screen-Shot-2026-09-29-at-10.00.00.jpg'],
    ['../../etc/passwd', '1-passwd.jpg'],
    ['.hidden', '1-hidden.jpg'],
    [`${'a'.repeat(80)}.jpg`, `1-${'a'.repeat(40)}.jpg`],
    ['émoji 😀 name.gif', '1-moji-name.jpg'],
    ['x.tar.gz', '1-x.tar.jpg'],
    ['---', '1-pasted-image.jpg'],
    ['', '1-pasted-image.jpg']
  ])
    assert.equal(
      (await f.cmd({ cmd: 'pure', attachment: name, mediaType: 'image/JPEG' })).pure.fileName,
      fileName,
      name
    )
  for (const [message, stderr, missing, reason] of [
    ['Command failed: xcrun simctl help', 'unable to find utility "simctl"', false, NOT_SELECTED],
    ['x', 'You have not agreed to the Xcode license agreements', false, LICENSE],
    ['spawn xcrun ENOENT', '', true, NOT_SELECTED],
    ['boom', 'other', false, 'Could not run the iOS simulator tools: boom']
  ]) {
    assert.equal(
      (await f.cmd({ cmd: 'pure', xcodeMessage: message, stderr, missing })).pure.reason,
      reason,
      message
    )
  }

  log("preflight: the retired TS runner's answer in every mode")
  const devices = [
    {
      udid: '11111111-1111-4111-8111-111111111111',
      name: 'iPhone 15',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'
    },
    {
      udid: '22222222-2222-4222-8222-222222222222',
      name: 'iPhone 16 Pro',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'
    }
  ]
  const answer = (ok, tools, runtimes, listed, reason) => ({
    ok,
    isMac: true,
    hasXcode: tools,
    hasIdb: tools,
    runtimes,
    devices: listed,
    ...(reason ? { reason } : {})
  })
  for (const [value, expected] of [
    [{ xcode: 'missing' }, answer(false, false, [], [], NOT_SELECTED)],
    [{ xcode: 'license' }, answer(false, false, [], [], LICENSE)],
    [
      { runtimes: [] },
      answer(
        false,
        true,
        [],
        devices,
        'No iOS runtimes installed. Add one in Xcode → Settings → Platforms.'
      )
    ],
    [
      { devices: {} },
      answer(
        false,
        true,
        ['iOS 26.0'],
        [],
        'No iPhone/iPad simulators found. Create one in Xcode → Settings → Platforms.'
      )
    ],
    [{ sdk: '27.0' }, answer(false, true, ['iOS 26.0'], devices, mismatch('27.0', '26.0'))],
    [
      { list: 'broken' },
      answer(
        false,
        true,
        [],
        [],
        "Couldn't list simulators: Command failed: xcrun simctl list runtimes -j\nsimctl list failed\n"
      )
    ],
    [{}, answer(true, true, ['iOS 26.0'], devices)]
  ]) {
    mode(value)
    assert.deepEqual(await owner.simulatorPreflight(), expected, JSON.stringify(value))
  }
  assert.equal((await owner.simulatorPreflight()).ok, true)
  assert.deepEqual(
    (await owner.simulatorPreflight()).devices.map((d) => d.name),
    ['iPhone 15', 'iPhone 16 Pro']
  )

  log('simulator unavailable: refused before anything runs')
  mode({ xcode: 'missing' })
  await rejects(
    owner.simulatorStart({ root: project, command: fakes.metro('ready') }),
    'unavailable',
    /^Xcode is not installed or not selected/
  )
  mode({ xcode: 'license' })
  await rejects(
    owner.simulatorStart({ root: project, command: fakes.metro('ready') }),
    'unavailable',
    /license has not been accepted/
  )
  mode({ sdk: '27.0' })
  await rejects(
    owner.simulatorStart({ root: project, command: fakes.metro('ready') }),
    'unavailable',
    /no matching simulator runtime/
  )
  assert.deepEqual(metros(), [], 'no launch command ran')
  assert.ok(!calls().some((c) => c.args[1] === 'boot'), 'nothing was booted')

  log('view-only bridge (no idb): page, host, token, stream, control, limits')
  mode({})
  const viewOnly = await fixture(join(scratch, 'profile-view-only'), { PLATFORM_IDB: '' })
  const viewer = viewOnly.owner()
  viewer.onSimulatorLog((line) => logs.push(line))
  const first = await viewer.simulatorStart({ root: project, command: fakes.metro('ready') })
  assert.deepEqual(
    { ...first, url: '', pid: 0 },
    {
      url: '',
      pid: 0,
      udid: '22222222-2222-4222-8222-222222222222',
      bundleId: 'com.example.app',
      previewKind: 'simulator'
    }
  )
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)\/\?treziSim=1$/.exec(first.url)?.[1])
  assert.ok(port >= 17800, first.url)
  for (const line of [
    'Using iPhone 16 Pro · com.apple.CoreSimulator.SimRuntime.iOS-26-0',
    'Booting simulator 22222222-2222-4222-8222-222222222222…',
    `Launching app: ${fakes.metro('ready')}`,
    'Starting Metro Bundler',
    'idb not found — preview is view-only (install idb to interact).',
    `Simulator preview ready at ${first.url}`
  ])
    assert.ok(logs.includes(line), `log: ${line}\n${logs.join('\n')}`)
  const page = await http(port, { path: '/?treziSim=1' })
  assert.equal(page.status, 200)
  const token = /var TOKEN = "([0-9a-f]{32})"/.exec(page.body.toString())?.[1]
  assert.ok(
    token &&
      page.body.includes(`/stream?token=${token}`) &&
      page.body.includes('data:image/png;base64,') &&
      page.body.includes('<div id="hint">')
  )
  assert.equal(
    (await http(port, { host: `evil.example:${port}` })).status,
    403,
    'DNS rebinding: a foreign Host is refused'
  )
  assert.equal((await http(port, { path: '/stream' })).status, 403)
  assert.equal((await http(port, { path: '/stream?token=bad' })).status, 403)
  assert.equal((await http(port, { path: `/control?token=${token}`, method: 'GET' })).status, 404)
  const frame = await http(port, {
    path: `/stream?token=${token}`,
    until: (text) => text.includes('22222222-2222-4222-8222-222222222222')
  })
  assert.equal(frame.status, 200)
  assert.match(frame.head, /multipart\/x-mixed-replace; boundary=treziframe/)
  assert.match(
    frame.body.toString('latin1'),
    /^--treziframe\r\nContent-Type: image\/jpeg\r\nContent-Length: \d+\r\n\r\n\xff\xd8/
  )
  const degraded = await http(port, {
    path: `/control?token=${token}`,
    method: 'POST',
    body: { type: 'tap', x: 0.5, y: 0.5 }
  })
  assert.deepEqual(JSON.parse(degraded.body.toString()), { degraded: true })
  assert.equal(
    (await http(port, { path: '/control', method: 'POST', body: { type: 'tap', x: 0.5, y: 0.5 } }))
      .status,
    403
  )
  const { connect } = await import('node:net')
  const viewers = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((resolve, reject) => {
          const socket = connect(port, '127.0.0.1', () =>
            socket.write(`GET /stream?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
          )
          socket.once('data', () => resolve(socket))
          socket.once('error', reject)
        })
    )
  )
  assert.equal((await viewer.status()).simulator.streams, 8)
  assert.equal(
    (await http(port, { path: `/stream?token=${token}` })).status,
    503,
    'at most eight viewers'
  )
  for (const socket of viewers) socket.destroy()
  await until(async () => (await viewer.status()).simulator.streams === 0, 'viewers to be dropped')
  const [viewMetro] = metros()
  assert.ok(alive(viewMetro.pid) && alive(viewMetro.child))
  assert.deepEqual(
    (await viewOnly.cmd({ cmd: 'journal' })).journal.length,
    1,
    'the Metro group is journaled'
  )
  await viewer.simulatorStop()
  await gone(viewMetro.pid, 'Metro after Stop')
  await gone(viewMetro.child, 'its descendant')
  await assert.rejects(http(port, {}), /ECONNREFUSED/, 'the bridge is closed by Stop')
  assert.deepEqual((await viewOnly.cmd({ cmd: 'journal' })).journal, [])
  await viewOnly.stop()

  log('restart with idb: no overlap, stale companion recovered, input and element picks')
  const initial = await owner.simulatorStart({ root: project, command: fakes.metro('ready') })
  const firstMetro = metros().find((m) => m.pid === initial.pid)
  const initialPort = Number(/:(\d+)\//.exec(initial.url)[1])
  mkdirSync(join(scratch, 'idb-state'), { recursive: true })
  mode({ stale: 1 })
  logs.length = 0
  const second = await owner.simulatorStart({ root: project, command: fakes.metro('ready') })
  await gone(firstMetro.pid, 'the previous Metro')
  await gone(firstMetro.child, 'the previous Metro descendant')
  if (Number(/:(\d+)\//.exec(second.url)[1]) !== initialPort)
    await assert.rejects(http(initialPort, {}), /ECONNREFUSED/, 'the previous bridge is closed')
  assert.ok(
    logs.includes('idb companion looks stale — restarting it…') &&
      logs.includes('idb detected — tap / scroll / type + element-select enabled.'),
    logs.join('\n')
  )
  assert.ok(calls().some((c) => c.tool === 'pkill' && c.args.join(' ') === '-f idb_companion'))
  assert.ok(!existsSync(join(scratch, 'idb-state')), 'idb state folder cleared')
  const port2 = Number(/:(\d+)\//.exec(second.url)[1])
  const token2 = /var TOKEN = "([0-9a-f]{32})"/.exec((await http(port2, {})).body.toString())[1]
  assert.notEqual(token2, token)
  const control = (body) =>
    http(port2, { path: `/control?token=${token2}`, method: 'POST', body }).then((r) => ({
      status: r.status,
      body: r.body.length ? JSON.parse(r.body.toString()) : null
    }))
  const uiCalls = () =>
    calls()
      .filter((c) => c.tool === 'idb' && c.args[0] === 'ui')
      .map((c) => c.args)
  assert.deepEqual(await control({ type: 'tap', x: 0.5, y: 0.5 }), {
    status: 200,
    body: { ok: true }
  })
  assert.deepEqual(await control({ type: 'swipe', x: 0, y: 0, x2: 1, y2: 1 }), {
    status: 200,
    body: { ok: true }
  })
  assert.deepEqual(await control({ type: 'text', text: 'a'.repeat(600) }), {
    status: 200,
    body: { ok: true }
  })
  assert.deepEqual(uiCalls().slice(-3), [
    ['ui', 'tap', '--udid', second.udid, '201', '437'],
    ['ui', 'swipe', '--udid', second.udid, '0', '0', '402', '874', '--duration', '0.25'],
    ['ui', 'text', '--udid', second.udid, 'a'.repeat(500)]
  ])
  assert.equal((await control({ type: 'pinch' })).status, 400)
  assert.equal(
    (
      await http(port2, {
        path: `/control?token=${token2}`,
        method: 'POST',
        body: JSON.stringify({ type: 'text', text: 'x'.repeat(5000) })
      })
    ).status,
    413
  )
  mode({ uiFail: true })
  const failed = await control({ type: 'tap', x: 0.1, y: 0.1 })
  assert.equal(failed.body.ok, false)
  assert.match(failed.body.error, /device went away/)
  mode({})
  await owner.simulatorSelect(true)
  assert.deepEqual(await control({ type: 'tap', x: 0.25, y: 0.75 }), {
    status: 200,
    body: { selected: true }
  })
  await until(() => picks.length === 1, 'the element pick')
  assert.deepEqual(picks[0], { source: 'src/App.tsx:12:4', tag: 'Button' })
  assert.ok(
    calls().some(
      (c) =>
        c.tool === 'idb' &&
        c.args.join(' ') === `ui describe-point --udid ${second.udid} --json 101 656`
    )
  )
  await owner.simulatorSelect(false)
  assert.equal((await owner.status()).simulator.selectMode, false)

  log('cancel during boot: the waiting xcrun group is stopped, nothing launches')
  const secondMetro = metros().find((m) => m.pid === second.pid)
  rmSync(join(sim, 'booted.json'), { force: true })
  mode({ slowBoot: true })
  const booting = pending(owner.simulatorStart({ root: project, command: fakes.metro('ready') }))
  const status = await until(bootStatus, 'bootstatus')
  await gone(secondMetro.pid, 'the running preview replaced by the new start')
  const stopAt = Date.now()
  await owner.simulatorStop()
  await rejects(booting, 'cancelled', /^Simulator start was cancelled\.$/)
  assert.ok(Date.now() - stopAt < 3000, 'Stop reaches a boot still waiting')
  await gone(status.pid, 'bootstatus')
  await gone(status.child, 'bootstatus descendant')
  assert.equal(metros().length, 3, 'no launch command ran')
  rmSync(join(sim, 'bootstatus.json'))

  log('a newer start supersedes one still booting')
  const older = pending(owner.simulatorStart({ root: project, command: fakes.metro('ready') }))
  const waiting = await until(bootStatus, 'bootstatus')
  mode({})
  const newer = owner.simulatorStart({ root: project, command: fakes.metro('ready') })
  await rejects(older, 'cancelled')
  await gone(waiting.pid, 'the superseded bootstatus')
  const third = await newer
  assert.equal(third.previewKind, 'simulator')
  const thirdMetro = metros().find((m) => m.pid === third.pid)
  assert.ok(thirdMetro && alive(thirdMetro.child))

  log('cancel while waiting for Metro; build failure; early exit; no frames')
  const quiet = pending(owner.simulatorStart({ root: project, command: fakes.metro('silent') }))
  await gone(thirdMetro.pid, 'the running Metro replaced by the new start')
  const silent = await until(() => metros().find((m) => m.how === 'silent'), 'the silent Metro')
  await owner.simulatorStop()
  await rejects(quiet, 'cancelled')
  await gone(silent.pid, 'Metro')
  await gone(silent.child, 'Metro descendant')
  const failure = await rejects(
    owner.simulatorStart({ root: project, command: fakes.metro('fail') }),
    'unavailable',
    /^The app failed to build\/launch\.\nerror: Build input file cannot be found/
  )
  assert.doesNotMatch(failure.message, /Explicit dependency/)
  const failedMetro = metros().find((m) => m.how === 'fail')
  await gone(failedMetro.pid, 'the failed Metro')
  await gone(failedMetro.child, 'the failed Metro descendant')
  await rejects(
    owner.simulatorStart({ root: project, command: fakes.metro('exit') }),
    'unavailable',
    /^Dev process exited \(code 3\) before launching\.\nCannot find module expo/
  )
  mode({ noFrames: true })
  await rejects(
    owner.simulatorStart({ root: project, command: fakes.metro('ready') }),
    'unavailable',
    /^Command failed: xcrun simctl io 22222222-2222-4222-8222-222222222222 screenshot --type=jpeg .*\nError: screenshot failed/
  )
  const blind = metros()
    .filter((m) => m.how === 'ready')
    .at(-1)
  await gone(blind.pid, 'Metro after no frame')
  await gone(blind.child, 'its descendant')
  mode({})
  assert.deepEqual(
    (await f.cmd({ cmd: 'journal' })).journal,
    [],
    'every failed group left the journal'
  )
  assert.deepEqual((await owner.status()).simulator, {
    running: false,
    starting: false,
    selectMode: false,
    streams: 0
  })

  log('drain on close: the preview and its Metro group end before the lock is released')
  const running = await owner.simulatorStart({ root: project, command: fakes.metro('ready') })
  const runningMetro = metros().find((m) => m.pid === running.pid)
  assert.deepEqual(await f.cmd({ cmd: 'close' }), { closed: true })
  await gone(runningMetro.pid, 'Metro at close')
  await gone(runningMetro.child, 'Metro descendant at close')
  await assert.rejects(http(Number(/:(\d+)\//.exec(running.url)[1]), {}), /ECONNREFUSED/)
  await rejects(owner.status(), 'unavailable', /stopping/)
  await f.stop()

  log('crash: a Metro group a killed owner left is stopped at the next launch')
  const crashing = await fixture(profile)
  const crashed = await crashing
    .owner()
    .simulatorStart({ root: project, command: fakes.metro('ready') })
  const orphan = metros().find((m) => m.pid === crashed.pid)
  crashing.child.kill('SIGKILL')
  await crashing.exited
  await sleep(300)
  assert.ok(
    alive(orphan.pid) && alive(orphan.child),
    'nothing stopped it yet (the fixture has no watchdog)'
  )
  const relaunched = await fixture(profile)
  assert.ok(relaunched.swept.includes(crashed.pid), `swept ${JSON.stringify(relaunched.swept)}`)
  await gone(orphan.pid, 'the orphaned Metro')
  await gone(orphan.child, 'the orphaned descendant')
  assert.deepEqual((await relaunched.cmd({ cmd: 'journal' })).journal, [])

  log('schema and denied capabilities')
  const refused = async (method, body, code = 'invalidRequest', extra = {}) => {
    const result = await relaunched.frame(method, body, extra)
    assert.equal(result.kind, 'failed', `${method} ${JSON.stringify(body)}`)
    assert.equal(result.payload.code, code, `${method}: ${result.payload.message}`)
  }
  const asset = {
    uri: 'data:image/png;base64,AAAA',
    inset: { left: 1, top: 1, right: 1, bottom: 1 },
    aspect: 0.5
  }
  await refused('nope', {})
  await refused('status', {}, 'unauthorized', { scope: { project: 'x' } })
  await refused('status', {}, 'invalidRequest', { mode: 'mutation' })
  await refused('simulatorStart', { root: project, frame: asset })
  await refused('simulatorStart', { root: 'relative', frame: asset, intent: 'start' })
  await refused('simulatorStart', {
    root: project,
    frame: asset,
    intent: 'start',
    udid: 'not-a-udid'
  })
  await refused('simulatorStart', {
    root: project,
    frame: asset,
    intent: 'start',
    command: 'a\u0000b'
  })
  await refused('simulatorStart', {
    root: project,
    frame: { ...asset, uri: 'data:text/html,<script>alert(1)</script>' },
    intent: 'start'
  })
  await refused('simulatorStart', {
    root: project,
    frame: { ...asset, uri: 'data:image/png;base64,AA"onerror="x' },
    intent: 'start'
  })
  await refused(
    'simulatorStart',
    { root: join(scratch, 'missing'), frame: asset, intent: 'start' },
    'notFound'
  )
  await refused('simulatorStop', {})
  await refused('simulatorSelect', { active: 'yes' })
  await refused('serverStop', { server: { pid: 1, root: '/' } })
  await refused('serverStop', { server: { pid: 1, root: '/' }, intent: 'stop' }, 'conflict')
  await refused(
    'serverStop',
    { server: { pid: relaunched.child.pid, root: scratch }, intent: 'stop' },
    'conflict'
  )
  await refused('mediaGrant', { root: project, path: 'a.png', view: 'source', extra: 1 })

  await checkMedia({ fixture, scratch, log, rejects, sleep })
  await checkAttachments({ fixture, scratch, log, rejects, profile })
  await checkServers({ owner: relaunched.owner(), scratch, log, rejects, gone })
  await checkOpen({ fixture, scratch, log, rejects })
  console.log(
    `Platform owner: parity, simulator lifecycle (unavailable, bridge limits, idb, restart, cancel, supersede, failures, drain, crash), media, attachments, server recovery, opening and schema passed in ${((Date.now() - began) / 1000).toFixed(1)}s`
  )
} finally {
  for (const started of fixtures) await started.stop().catch(() => {})
  for (const metro of leftoverMetros())
    for (const pid of [metro.pid, metro.child]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  rmSync(scratch, { recursive: true, force: true })
}

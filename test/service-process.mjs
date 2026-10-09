// Foundation-only real processes: no AppKit window, provider call or user profile.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { swiftBuild } from './helpers/swift-build.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'trezi-service-'))
const processes = new Set()
const groups = new Set()
const version = { major: 1, minor: 0 }
const capabilities = [
  { name: 'legacy.ui', version: 1 },
  { name: 'supervision', version: 1 }
]
const bun = process.versions.bun
  ? process.execPath
  : spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim()
const backend = join(root, 'test/fixtures/service-process/legacy.mjs')
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180_000
  })
  assert.equal(
    result.status,
    0,
    `${command}: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`
  )
  return result.stdout
}
function processFixture(binary, args = [], env = {}) {
  const child = spawn(binary, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  processes.add(child)
  const lines = [],
    waiters = []
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += data
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line)
    for (const wake of waiters.splice(0)) wake()
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
  const done = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      processes.delete(child)
      resolve({ code, signal, stderr })
    })
  )
  return {
    child,
    done,
    lines,
    get stderr() {
      return stderr
    },
    send(value) {
      child.stdin.write(
        `${typeof value === 'string' ? value : Buffer.from(JSON.stringify(value)).toString('base64')}\n`
      )
    },
    async line(predicate, timeout = 10_000) {
      // Captured synchronously so a timeout names the waiting step.
      const caller = new Error('waiting step').stack
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const index = lines.findIndex(predicate)
        if (index >= 0) return lines.splice(index, 1)[0]
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 50)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      throw new Error(
        `Timed out waiting for fixture output: ${lines.join('\n')}\n${stderr}\n${caller}`
      )
    },
    async reply(request) {
      this.send(request)
      const line = await this.line(
        (line) =>
          line.startsWith('REPLY ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).requestID === request.requestID
      )
      return JSON.parse(Buffer.from(line.slice(6), 'base64'))
    }
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A pid file can exist before its digits are written. Number('') is 0, and the
// cleanup's kill(-0) is kill(0): SIGKILL to this test's own process group.
async function pidFile(path, timeout = 2000) {
  for (const deadline = Date.now() + timeout; ; await pause(20)) {
    const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
    if (/^\d+$/.test(text) && Number(text) > 1) return Number(text)
    assert.ok(Date.now() < deadline, `no complete pid in ${path}: ${JSON.stringify(text)}`)
  }
}
function killGroup(pid) {
  if (Number.isSafeInteger(pid) && pid > 1)
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
}
async function dead(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid fixture pid ${pid}`)
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
    }
    await pause(20)
  }
  assert.fail(`fixture process ${pid} survived cleanup`)
}
function control(connection, kind, extra = {}) {
  return { version, connection, requestID: randomUUID(), kind, ...extra }
}
function hello(connection, launch, extra = {}) {
  return control(connection, 'hello', {
    hello: {
      connection,
      role: 'ui',
      versions: [version],
      schemaHash: 'trezi-supervision-1',
      capabilities,
      ...extra
    },
    launch
  })
}
function plist(path, value) {
  writeFileSync(
    path,
    `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${value}</dict></plist>`
  )
}
try {
  // Regression: a created-but-unwritten pid file once became group 0 and the
  // cleanup SIGKILLed this test after its final PASS under parallel load.
  const unwritten = join(scratch, 'unwritten.pid')
  writeFileSync(unwritten, '')
  await assert.rejects(
    pidFile(unwritten, 100),
    /no complete pid/,
    'empty pid file is never read as 0'
  )
  writeFileSync(unwritten, '0')
  await assert.rejects(pidFile(unwritten, 100), /no complete pid/, 'pid 0 names the caller group')
  // Must be no-ops; a regression here SIGKILLs this test (never test 1: kill(-1) is everyone).
  killGroup(0)
  killGroup(-0)
  killGroup(Number.NaN)
  if (process.platform !== 'darwin') {
    console.log('SERVICE-PROCESS SKIP — macOS XPC and process supervision require Darwin')
  } else {
    // Private copies: the bundle binaries are codesigned in place below.
    const compile = (name, sources, output) => swiftBuild(name, sources, { out: output })
    const crashFixture = join(scratch, 'guardian-fixture')
    compile(
      'guardian-fixture',
      [
        'src/service/BackendSupervisor.swift',
        'src/service/ProcessGuardian.swift',
        'test/fixtures/backend-supervisor/main.swift'
      ],
      crashFixture
    )
    console.log(run(crashFixture, [], { TREZI_TEST_BUN: bun }).trim())
    const supervisor = join(scratch, 'supervisor')
    compile(
      'supervisor-fixture',
      [
        'src/service/BackendSupervisor.swift',
        'test/fixtures/service-process/SupervisorFixture.swift'
      ],
      supervisor
    )
    const profile = join(scratch, 'profile')
    mkdirSync(profile)
    const state = join(profile, 'drafts.json')
    writeFileSync(state, '{"newer":"retained"}')
    const owner = processFixture(supervisor, ['lock', profile])
    await owner.line((line) => line === 'LOCKED')
    const contender = processFixture(supervisor, ['lock', profile])
    const rejected = await contender.done
    assert.notEqual(rejected.code, 0, 'second profile owner rejected')
    owner.send('release')
    assert.equal((await owner.done).code, 0)
    run(supervisor, ['startup-failure', profile])
    // Profile recovery after a crash: the holder is SIGKILLed (no release, no cleanup), the
    // kernel drops its lock, the next owner acquires the same profile and finds the data.
    {
      const crashing = processFixture(supervisor, ['lock', profile])
      await crashing.line((line) => line === 'LOCKED')
      assert.notEqual(
        (await processFixture(supervisor, ['lock', profile]).done).code,
        0,
        'a live holder still excludes'
      )
      writeFileSync(state, '{"newer":"written-before-crash"}')
      crashing.child.kill('SIGKILL')
      assert.equal((await crashing.done).signal, 'SIGKILL')
      const recovered = processFixture(supervisor, ['lock', profile])
      await recovered.line((line) => line === 'LOCKED')
      assert.equal(
        readFileSync(state, 'utf8'),
        '{"newer":"written-before-crash"}',
        'the recovering owner sees the crashed owner’s data'
      )
      recovered.send('release')
      assert.equal((await recovered.done).code, 0)
      writeFileSync(state, '{"newer":"retained"}')
    }
    for (const mode of ['shutdown', 'child-death']) {
      const descendant = join(scratch, `${mode}.pid`)
      const instance = processFixture(supervisor, [mode, profile, bun, backend], {
        FIXTURE_DESCENDANT: descendant
      })
      const pid = Number((await instance.line((line) => line.startsWith('CHILD '))).slice(6))
      groups.add(pid)
      const descendantPID = await pidFile(descendant)
      instance.send('stop')
      assert.equal((await instance.done).code, 0)
      await dead(pid)
      await dead(descendantPID)
      groups.delete(pid)
    }
    assert.equal(
      readFileSync(state, 'utf8'),
      '{"newer":"retained"}',
      'shutdown and reacquisition preserve latest data'
    )
    console.log(
      'SERVICE-PROCESS supervision: profile contention, startup failure, child death, repeated shutdown, descendant cleanup PASS'
    )

    const app = join(scratch, 'Fixture.app/Contents')
    const service = join(app, 'XPCServices/dev.trezi.service.xpc/Contents')
    mkdirSync(join(app, 'MacOS'), { recursive: true })
    mkdirSync(join(service, 'MacOS'), { recursive: true })
    const host = join(app, 'MacOS/TreziHost')
    const executable = join(service, 'MacOS/TreziService')
    compile(
      'xpc-service',
      [
        'src/service/ServiceContract.swift',
        'src/service/ServiceXPC.swift',
        'src/service/ProductLog.swift',
        'src/service/LedgerStore.swift',
        'src/service/OperationLedger.swift',
        'src/service/PreferencesFile.swift',
        'src/service/PreferencesOwner.swift',
        'src/service/WorkspaceFile.swift',
        'src/service/WorkspaceOwner.swift',
        'src/service/MemoryFile.swift',
        'src/service/MemoryOwner.swift',
        'src/service/DomainChannel.swift',
        'src/service/BackendSupervisor.swift',
        'src/service/ManagedProcess.swift',
        'src/service/RuntimeNet.swift',
        'src/service/RuntimeDetect.swift',
        'src/service/StaticSite.swift',
        'src/service/StaticServer.swift',
        'src/service/RuntimeServer.swift',
        'src/service/RuntimeOwner.swift',
        'src/service/RepositoryGit.swift',
        'src/service/GitMessages.swift',
        'src/service/RepositoryJournal.swift',
        'src/service/RepositoryEffects.swift',
        'src/service/RepositoryLanding.swift',
        'src/service/RepositoryAgentGit.swift',
        'src/service/RepositoryBranches.swift',
        'src/service/RepositoryCleanup.swift',
        'src/service/RepositoryMerge.swift',
        'src/service/RepositoryOwner.swift',
        'src/service/SourcePaths.swift',
        'src/service/SourceJournal.swift',
        'src/service/SourceHistory.swift',
        'src/service/SourceStore.swift',
        'src/service/SourceDrafts.swift',
        'src/service/SourceOwner.swift',
        'src/service/ConversationState.swift',
        'src/service/ConversationStore.swift',
        'src/service/ConversationOwner.swift',
        'src/service/ProviderPolicy.swift',
        'src/service/ProviderStore.swift',
        'src/service/ProviderHelper.swift',
        'src/service/ProviderFrames.swift',
        'src/service/ProviderData.swift',
        'src/service/ProviderLaunch.swift',
        'src/service/ProviderOwner.swift',
        'src/service/EditingIslands.swift',
        'src/service/EditingStores.swift',
        'src/service/EditingProject.swift',
        'src/service/EditingLegacyNames.swift',
        'src/service/EditingOwner.swift',
        'src/service/WorkflowJournal.swift',
        'src/service/WorkflowContext.swift',
        'src/service/WorkflowOwner.swift',
        'src/service/WorkflowPublish.swift',
        'src/service/WorkflowRemote.swift',
        'src/service/WorkflowSetup.swift',
        'src/service/WorkflowTools.swift',
        'src/service/PlatformTools.swift',
        'src/service/PlatformOpen.swift',
        'src/service/PlatformMedia.swift',
        'src/service/SimulatorTools.swift',
        'src/service/SimulatorBridge.swift',
        'src/service/SimulatorOwner.swift',
        'src/service/PlatformOwner.swift',
        'src/service/ServiceRuntime.swift',
        'src/service/ProcessGuardian.swift',
        'src/service/ProfilePaths.swift',
        'src/service/ServiceMain.swift'
      ],
      executable
    )
    compile(
      'xpc-host',
      [
        'src/service/ServiceContract.swift',
        'src/service/ServiceXPC.swift',
        'src/service/ProductLog.swift',
        'src/native/ServiceClient.swift',
        'test/fixtures/service-process/XPCFixture.swift'
      ],
      host
    )
    plist(
      join(app, 'Info.plist'),
      '<key>CFBundleIdentifier</key><string>dev.trezi.fixture</string><key>CFBundleExecutable</key><string>TreziHost</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/>'
    )
    plist(
      join(service, 'Info.plist'),
      '<key>CFBundleIdentifier</key><string>dev.trezi.service</string><key>CFBundleExecutable</key><string>TreziService</string><key>CFBundlePackageType</key><string>XPC!</string><key>XPCService</key><dict><key>ServiceType</key><string>Application</string><key>RunLoopType</key><string>dispatch_main</string></dict>'
    )
    console.log(run(host, ['--codec']).trim())
    const intruder = join(app, 'MacOS/Intruder')
    compile(
      'xpc-intruder',
      [
        '-D',
        'INTRUDER',
        'src/service/ServiceContract.swift',
        'src/service/ServiceXPC.swift',
        'src/service/ProductLog.swift',
        'src/native/ServiceClient.swift',
        'test/fixtures/service-process/XPCFixture.swift'
      ],
      intruder
    )
    run('codesign', ['--force', '--sign', '-', intruder])
    run('codesign', ['--force', '--sign', '-', join(service, '..')])
    run('codesign', ['--force', '--sign', '-', join(app, '..')])
    writeFileSync(state, '{"newer":"retained-across-xpc"}')
    if (process.argv.includes('--supervision-only')) {
      console.log('SERVICE-PROCESS supervision-only PASS — XPC coverage requires the full fixture')
    } else {
      const backendPID = join(scratch, 'xpc-child.pid')
      const launch = {
        bun,
        backend,
        profile,
        arguments: [],
        environment: { FIXTURE_PID: backendPID }
      }
      const rejectedPeer = processFixture(intruder)
      rejectedPeer.send(hello(randomUUID(), launch))
      const peerError = await rejectedPeer.line((line) => line.startsWith('ERROR '))
      assert.ok(
        !/lookup|Sandbox restriction/.test(peerError),
        `service lookup must succeed so rejection is the signing check: ${peerError}`
      )
      assert.ok(
        !rejectedPeer.lines.some((line) => line.startsWith('REPLY ')),
        'different executable cannot handshake'
      )
      rejectedPeer.child.stdin.end()
      assert.equal((await rejectedPeer.done).code, 0)
      const client = processFixture(host)
      const connection = randomUUID()
      assert.equal(
        (
          await client.reply(
            control(connection, 'legacy', {
              payload: Buffer.from('{"event":"fixtureEcho"}').toString('base64')
            })
          )
        ).failure,
        'unauthorized',
        'unnegotiated data cannot reach Bun'
      )
      client.send({ ...hello(connection, launch), version: { major: 99, minor: 0 } })
      const badVersion = await client.line(
        (line) =>
          line.startsWith('REPLY ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).failure === 'unsupportedVersion'
      )
      assert.equal(
        JSON.parse(Buffer.from(badVersion.slice(6), 'base64')).failure,
        'unsupportedVersion'
      )
      assert.equal(
        (await client.reply(hello(connection, launch, { versions: [{ major: 99, minor: 0 }] })))
          .failure,
        'unsupportedVersion'
      )
      assert.equal(
        (await client.reply(hello(connection, launch, { capabilities: [] }))).failure,
        'unsupportedCapability'
      )
      assert.equal(
        (await client.reply(hello(connection, launch, { role: 'parser' }))).failure,
        'unauthorized'
      )
      assert.equal(
        (await client.reply(hello(connection, { ...launch, bun: '/nonexistent/trezi-bun' })))
          .failure,
        'unavailable',
        'startup failure returned over XPC'
      )
      assert.equal(
        (await client.reply({ ...hello(connection, launch), resume: randomUUID() })).failure,
        'recoveryRequired',
        'a fresh service never launches Bun for a stale client'
      )
      assert.ok(!existsSync(backendPID), 'refused reattach started no backend')
      const ready = await client.reply(hello(connection, launch))
      assert.ok(ready.hello, 'real XPC handshake')
      // The service opens (and recovers) its operation ledger under the profile lock.
      const ledgerSnapshot = join(profile, 'service/ledger/snapshot.json')
      const ledgerEpoch = () => JSON.parse(readFileSync(ledgerSnapshot, 'utf8').slice(65)).epoch
      assert.ok(existsSync(ledgerSnapshot), 'service opened its operation ledger')
      const firstLedgerEpoch = ledgerEpoch()
      assert.equal(ready.hello.connection, connection)
      const firstBackend = await pidFile(backendPID)
      groups.add(firstBackend)
      const bridge = { event: 'fixtureEcho', value: '猫' }
      assert.equal(
        (
          await client.reply(
            control(connection, 'legacy', {
              payload: Buffer.from(JSON.stringify(bridge)).toString('base64')
            })
          )
        ).failure,
        undefined
      )
      const echoed = await client.line(
        (line) =>
          line.startsWith('EVENT ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).method === 'fixtureEcho'
      )
      assert.equal(
        JSON.parse(Buffer.from(echoed.slice(6), 'base64')).value,
        '猫',
        'legacy frame crosses XPC and private child pipes'
      )
      const wait = control(connection, 'wait')
      client.send(wait)
      assert.equal(
        (await client.reply(control(connection, 'cancel', { target: wait.requestID }))).failure,
        undefined
      )
      const cancelled = await client.line(
        (line) =>
          line.startsWith('REPLY ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).requestID === wait.requestID
      )
      assert.equal(JSON.parse(Buffer.from(cancelled.slice(6), 'base64')).failure, 'cancelled')
      client.send('reconnect')
      await client.line((line) => line === 'RECONNECTED')
      await pause(200) // Give invalidation delivery a bounded turn before the next hello.
      const reconnected = randomUUID()
      assert.equal(
        (await client.reply(hello(reconnected, launch))).failure,
        'recoveryRequired',
        'second first-launch hello refused'
      )
      assert.equal(
        (await client.reply({ ...hello(reconnected, launch), resume: randomUUID() })).failure,
        'recoveryRequired',
        'wrong epoch refused'
      )
      const resumed = await client.reply({
        ...hello(reconnected, launch),
        resume: ready.hello.serviceEpoch
      })
      assert.equal(
        resumed.hello?.serviceEpoch,
        ready.hello.serviceEpoch,
        'same peer reattaches to the same epoch'
      )
      await client.reply(control(reconnected, 'shutdown'))
      client.child.stdin.end()
      assert.equal((await client.done).code, 0)
      await dead(firstBackend)
      groups.delete(firstBackend)
      assert.equal(readFileSync(state, 'utf8'), '{"newer":"retained-across-xpc"}')
      await pause(300)
      const launchFile = join(scratch, 'launch.json')
      writeFileSync(launchFile, JSON.stringify(launch))
      rmSync(backendPID, { force: true })
      // Production service: restart with epoch resume and stale-resume refusal.
      {
        const boot = processFixture(host, ['production', launchFile, executable])
        await boot.line((line) => line === 'READY')
        const bootBackend = await pidFile(backendPID)
        groups.add(bootBackend)
        const staleClient = processFixture(host)
        const staleConnection = randomUUID()
        assert.equal(
          (await staleClient.reply({ ...hello(staleConnection, launch), resume: randomUUID() }))
            .failure,
          'recoveryRequired',
          'a fresh service refuses a stale client epoch'
        )
        staleClient.child.stdin.end()
        await staleClient.done
        boot.send('shutdown')
        assert.equal((await boot.done).code, 0)
        await dead(bootBackend)
        groups.delete(bootBackend)
        rmSync(backendPID, { force: true })
        await pause(300)
        // Production shutdown drained the service; a new XPC client can first-launch again.
        const restarted = processFixture(host)
        const restartedConnection = randomUUID()
        const restartedReady = await restarted.reply(hello(restartedConnection, launch))
        assert.ok(
          restartedReady.hello?.serviceEpoch,
          'handshake after production shutdown returns service epoch'
        )
        restarted.send('reconnect')
        await restarted.line((line) => line === 'RECONNECTED')
        await pause(200)
        const resumedConnection = randomUUID()
        const epochResumed = await restarted.reply({
          ...hello(resumedConnection, launch),
          resume: restartedReady.hello.serviceEpoch
        })
        assert.equal(
          epochResumed.hello?.serviceEpoch,
          restartedReady.hello.serviceEpoch,
          'resume after service restart keeps the epoch'
        )
        await restarted.reply(control(resumedConnection, 'shutdown'))
        restarted.child.stdin.end()
        await restarted.done
      }
      // Written by an older Trezi build (before the service owned these files): imported at launch.
      writeFileSync(
        join(profile, 'preferences.json'),
        JSON.stringify({ version: 1, values: { 'trezi:chat-hidden': '1', 'trezi:future': null } })
      )
      writeFileSync(
        join(profile, 'workspace.json'),
        JSON.stringify({
          projects: [
            { root: '/legacy-project', key: '/legacy-project', name: 'legacy', touchedAt: 1 }
          ],
          activeKey: '/legacy-project',
          recents: []
        })
      )
      const production = processFixture(host, ['production', launchFile, executable])
      await production.line((line) => line === 'READY')
      assert.equal(ledgerEpoch(), firstLedgerEpoch, 'the ledger survives a service restart')
      const productionBackend = await pidFile(backendPID)
      groups.add(productionBackend)
      const nativeLock = join(profile, 'native.lock')
      if (existsSync(nativeLock)) {
        const lockPid = Number(readFileSync(nativeLock, 'utf8'))
        assert.notEqual(
          lockPid,
          productionBackend,
          'the supervised Bun backend must not own native.lock'
        )
      }
      production.send({ event: 'fixtureEcho', value: 'production-client', stderr: true })
      await production.line(
        (line) =>
          line.startsWith('EVENT ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).value === 'production-client'
      )
      // The XPC service's own stderr is discarded; Bun's must reach the host's.
      for (
        let i = 0;
        i < 100 && !production.stderr.includes('FIXTURE-STDERR production-client');
        i++
      )
        await pause(20)
      assert.ok(
        production.stderr.includes('FIXTURE-STDERR production-client'),
        'backend diagnostics reach the host stderr'
      )
      // S03 preferences: Bun's client → private pipe → the Swift owner → preferences.json.
      production.send({ event: 'fixturePreferences', key: 'trezi:native-chat-width', value: '512' })
      const preferenceLine = await production.line(
        (line) =>
          line.startsWith('EVENT ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).method === 'fixturePreferences'
      )
      const preferenceResult = JSON.parse(Buffer.from(preferenceLine.slice(6), 'base64'))
      assert.deepEqual(
        preferenceResult,
        { method: 'fixturePreferences', before: null, after: '512' },
        JSON.stringify(preferenceResult)
      )
      assert.equal(
        readFileSync(join(profile, 'preferences.json'), 'utf8'),
        '{"version":1,"values":{"trezi:chat-hidden":"1","trezi:future":null,"trezi:native-chat-width":"512"}}',
        'the service imported the legacy v1 file and wrote the same format'
      )
      // S04 workspace: Bun's client → private pipe → the Swift owner → workspace.json.
      production.send({ event: 'fixtureWorkspace', root: '/second-project/' })
      const workspaceLine = await production.line(
        (line) =>
          line.startsWith('EVENT ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).method === 'fixtureWorkspace'
      )
      const workspaceResult = JSON.parse(Buffer.from(workspaceLine.slice(6), 'base64'))
      assert.deepEqual(
        workspaceResult,
        {
          method: 'fixtureWorkspace',
          before: ['/legacy-project'],
          after: ['/legacy-project', '/second-project'],
          activeKey: '/second-project'
        },
        JSON.stringify(workspaceResult)
      )
      const savedWorkspace = JSON.parse(readFileSync(join(profile, 'workspace.json'), 'utf8'))
      assert.deepEqual(
        [savedWorkspace.projects.map((p) => p.key), savedWorkspace.activeKey],
        [['/legacy-project', '/second-project'], '/second-project'],
        'the service imported the legacy workspace and wrote the same format'
      )
      assert.ok(
        !production.lines.some(
          (line) =>
            line.startsWith('EVENT ') && JSON.parse(Buffer.from(line.slice(6), 'base64')).service
        ),
        'service frames never reach the host'
      )
      production.send('reconnect')
      production.send({ event: 'fixtureEcho', value: 'during-reconnect' })
      await production.line((line) => line === 'RECONNECTED')
      await production.line(
        (line) =>
          line.startsWith('EVENT ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).value === 'during-reconnect'
      )
      production.send({ event: 'fixtureEcho', value: 'after-reconnect' })
      await production.line(
        (line) =>
          line.startsWith('EVENT ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).value === 'after-reconnect'
      )
      production.send('shutdown')
      assert.equal(
        (await production.done).code,
        0,
        'production client reconnects and joins repeated shutdown'
      )
      await dead(productionBackend)
      groups.delete(productionBackend)
      await pause(300)
      // Backend death reaches the host with its failure status; nothing relaunches Bun.
      rmSync(backendPID, { force: true })
      const crashing = processFixture(host, ['production', launchFile, executable])
      await crashing.line((line) => line === 'READY')
      const crashedPID = await pidFile(backendPID)
      groups.add(crashedPID)
      rmSync(backendPID)
      crashing.send({ event: 'fixtureExit' })
      const stopped = await crashing.line(
        (line) =>
          line.startsWith('EVENT ') &&
          JSON.parse(Buffer.from(line.slice(6), 'base64')).method === 'serviceStopped'
      )
      assert.equal(
        JSON.parse(Buffer.from(stopped.slice(6), 'base64')).status,
        1,
        'backend failure status reaches the host'
      )
      // serviceStopped is final: no reconnect (launchd would throttle a respawn) and
      // repeated shutdown completes locally, promptly.
      crashing.send('shutdown')
      await crashing.line((line) => line === 'STOPPED', 3_000)
      assert.equal(
        (await crashing.done).code,
        0,
        'shutdown after serviceStopped completes without the service'
      )
      assert.ok(
        !crashing.lines.some((line) => line.startsWith('FAILURE ')),
        'announced stop is not an uncertain failure'
      )
      await dead(crashedPID)
      groups.delete(crashedPID)
      assert.ok(!existsSync(backendPID), 'no replacement backend was launched for the stale client')
      console.log(
        'SERVICE-PROCESS PASS — real XPC handshake, peer rejection, closed negotiation, cancellation, reconnection, backend death and process cleanup'
      )
    }
  }
} finally {
  for (const child of processes) {
    child.stdin.destroy()
    child.kill('SIGKILL')
  }
  for (const pid of groups) killGroup(pid)
  rmSync(scratch, { recursive: true, force: true })
}

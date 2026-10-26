// LKM-347: a service that dies is restarted (new epoch, new Bun) and the host keeps
// going; a service that cannot be restarted is reported, never a silent exit; every
// unexpected loss leaves its cause in the product log. Run by test/service-process.mjs.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const decode = (line) => JSON.parse(Buffer.from(line.slice(6), 'base64'))
const echoed = (value) => (line) => line.startsWith('EVENT ') && decode(line).value === value
const servicePid = async (fixture) =>
  Number((await fixture.line((line) => line.startsWith('SERVICE '), 30_000)).slice(8))

export async function restartCases({ host, executable, launch, backendPID, scratch, logs, processFixture, pidFile, dead, groups }) {
  const logText = () =>
    readdirSync(logs)
      .filter((name) => name.endsWith('.log'))
      .map((name) => readFileSync(join(logs, name), 'utf8'))
      .join('')
  const launchFile = join(scratch, 'restart-launch.json')
  writeFileSync(launchFile, JSON.stringify(launch))
  const start = async (file) => {
    rmSync(backendPID, { force: true })
    const fixture = processFixture(host, ['production', file, executable])
    await fixture.line((line) => line === 'READY')
    const service = await servicePid(fixture)
    const backend = await pidFile(backendPID)
    groups.add(backend)
    rmSync(backendPID)
    return { fixture, service, backend }
  }
  const finish = async (fixture, backend) => {
    fixture.send('shutdown')
    assert.equal((await fixture.done).code, 0, 'shutdown after a restart')
    await dead(backend)
    groups.delete(backend)
  }

  // The service is killed mid-session (as macOS does under memory pressure).
  {
    const { fixture, service, backend } = await start(launchFile)
    process.kill(service, 'SIGKILL')
    const restarting = await fixture.line((line) => line.startsWith('RESTARTING '), 30_000)
    assert.match(restarting, /stopped unexpectedly/)
    await fixture.line((line) => line === 'RESTARTED', 40_000)
    const replacement = await servicePid(fixture)
    assert.notEqual(replacement, service, 'a fresh service instance')
    const second = await pidFile(backendPID, 5_000)
    groups.add(second)
    assert.notEqual(second, backend, 'a fresh backend')
    await dead(backend)
    groups.delete(backend)
    fixture.send({ event: 'fixtureEcho', value: 'after-restart' })
    await fixture.line(echoed('after-restart'))
    assert.ok(!fixture.lines.some((line) => line.startsWith('FAILURE ')), 'no failure after a restart')
    await finish(fixture, second)
    const log = logText()
    assert.match(
      log,
      new RegExp(
        ` error app xpc Service lost without a stop announcement pid=${service} exited=yes footprint=(\\d+MB|unknown) .*lastServiceLines: `
      ),
      'the unexpected loss and its observations reach the product log'
    )
    assert.match(log, / warn app xpc Restarting the service: The background service stopped unexpectedly/)
    assert.match(log, / info app xpc Service restarted pid=\d+ after \d tries/)
    assert.match(log, / info service lifecycle Service stopping backendStatus=1 reason=the app quit/)
  }

  // Bun exits on its own: the host asks for a restart after `serviceStopped`.
  {
    const { fixture, backend } = await start(launchFile)
    fixture.send({ event: 'fixtureExit' })
    const stopped = await fixture.line((line) => line.startsWith('EVENT ') && decode(line).method === 'serviceStopped')
    assert.equal(decode(stopped).status, 1)
    await dead(backend)
    groups.delete(backend)
    fixture.send('restart')
    await fixture.line((line) => line === 'RESTARTED', 40_000)
    const second = await pidFile(backendPID, 5_000)
    groups.add(second)
    fixture.send({ event: 'fixtureEcho', value: 'after-stopped-restart' })
    await fixture.line(echoed('after-stopped-restart'))
    await finish(fixture, second)
    const log = logText()
    assert.match(log, / error service backend Backend exited code=17 /, 'how Bun ended')
    assert.match(log, / info service lifecycle Service stopping backendStatus=1 reason=backend exited code=17/)
  }

  // The replacement cannot start (Bun is gone): three tries, then a reported failure.
  {
    const bunLink = join(scratch, 'bun-link')
    symlinkSync(launch.bun, bunLink)
    const failingFile = join(scratch, 'failing-launch.json')
    writeFileSync(failingFile, JSON.stringify({ ...launch, bun: bunLink }))
    const { fixture, service, backend } = await start(failingFile)
    rmSync(bunLink)
    process.kill(service, 'SIGKILL')
    await fixture.line((line) => line.startsWith('RESTARTING '), 30_000)
    const failure = await fixture.line((line) => line.startsWith('FAILURE '), 40_000)
    assert.match(failure, /could not restart it after 3 tries \(unavailable\)/, failure)
    assert.equal((await fixture.done).code, 3, 'the failure reached the host (which shows the alert)')
    await dead(backend)
    groups.delete(backend)
    assert.match(logText(), / error app xpc .*could not restart it after 3 tries/)
  }
}

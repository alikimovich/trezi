// One build per cached Swift binary (LOCAL-TEST-CLEANUP-V2): while another live process
// holds a binary's build lock, swiftBuild waits and uses that build instead of running
// swiftc again; a dead or failed builder's lock does not block the next build.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { skipUnlessSwift } from './helpers/darwin.mjs'

skipUnlessSwift('the Swift build cache lock')
const temp = mkdtempSync(join(tmpdir(), 'trezi-swift-lock-'))
// The shared cache keeps the module cache warm; this run's own source makes its binary
// path unique, and the binary is removed at the end.
const { swiftBinary } = await import('./helpers/swift-build.mjs')
const helper = new URL('./helpers/swift-build.mjs', import.meta.url).href
let binary
try {
  const source = join(temp, 'main.swift')
  writeFileSync(source, `print("built by swiftc") // ${temp}\n`)
  binary = swiftBinary('lock-check', [source])
  const lock = `${binary}.lock`
  // A worker process: build (or wait for) the binary, print what it got.
  const worker = () => {
    const code = `const { swiftBuild } = await import(${JSON.stringify(helper)})
const { readFileSync } = await import('node:fs')
process.stdout.write(readFileSync(swiftBuild('lock-check', [${JSON.stringify(source)}]), 'latin1').slice(0, 64))`
    const child = spawn(
      process.execPath,
      process.versions.bun ? ['-e', code] : ['--input-type=module', '-e', code],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    child.stdout.on('data', (data) => (out += data))
    child.stderr.on('data', (data) => (out += data))
    const done = new Promise((resolve) => child.on('close', (status) => resolve({ status, out })))
    return { child, done }
  }
  const exited = (child) => child.exitCode !== null || child.signalCode !== null

  // A live builder holds the lock: the worker waits, then takes its binary unchanged.
  mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(lock, `${process.pid}\n`)
  const waiting = worker()
  await delay(1500)
  assert.equal(exited(waiting.child), false, 'the worker waits for the live builder')
  writeFileSync(binary, 'BUILT BY THE OTHER PROCESS')
  rmSync(lock)
  const reused = await waiting.done
  assert.equal(reused.status, 0, reused.out)
  assert.equal(reused.out, 'BUILT BY THE OTHER PROCESS', 'no second swiftc run')

  // A builder that failed released the lock without a binary: the waiter builds.
  rmSync(binary)
  writeFileSync(lock, `${process.pid}\n`)
  const retry = worker()
  await delay(500)
  assert.equal(exited(retry.child), false)
  rmSync(lock)
  const rebuilt = await retry.done
  assert.equal(rebuilt.status, 0, rebuilt.out)
  assert.notEqual(rebuilt.out, 'BUILT BY THE OTHER PROCESS')
  assert.equal(spawnSync(binary, { encoding: 'utf8' }).stdout, 'built by swiftc\n')

  // A dead builder's lock is taken over.
  rmSync(binary)
  const dead = spawnSync(process.execPath, ['-e', 'process.pid'], { stdio: 'ignore' }).pid
  writeFileSync(lock, `${dead}\n`)
  const takeover = await worker().done
  assert.equal(takeover.status, 0, takeover.out)
  assert.equal(spawnSync(binary, { encoding: 'utf8' }).stdout, 'built by swiftc\n')
  assert.throws(() => readFileSync(lock), /ENOENT/, 'the build lock is released')
  console.log('SWIFT-BUILD-LOCK OK — waits for a live build, rebuilds after a failed or dead one')
} finally {
  if (binary) for (const path of [binary, `${binary}.lock`]) rmSync(path, { force: true })
  rmSync(temp, { recursive: true, force: true })
}

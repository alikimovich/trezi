// Unit tests that compile the Swift service owners (or other Darwin-only Swift) cannot
// run off macOS. There they end the test with the runner's SKIP line and exit 0, so
// test/run.mjs reports SKIP (never PASS) and a Linux unit run stays green. On macOS a
// missing or broken toolchain still fails: the macOS CI job must not skip silently.
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

function skip(reason) {
  const label = basename(process.argv[1] || 'test', '.mjs').toUpperCase()
  console.log(`${label} SKIP — ${reason}`)
  process.exit(0)
}

/** Call before compiling Swift that needs macOS frameworks (the service owners). */
export function skipUnlessDarwin(what) {
  if (process.platform !== 'darwin')
    skip(`${what} needs macOS and the Xcode toolchain (this is ${process.platform})`)
}

/** For Swift that also builds with swift-corelibs-foundation: off macOS it runs when
 *  `swiftc` is on PATH and otherwise skips. */
export function skipUnlessSwift(what) {
  if (process.platform === 'darwin') return
  const found = spawnSync('swiftc', ['--version'], { stdio: 'ignore' })
  if (found.error || found.status !== 0)
    skip(`${what} needs a Swift toolchain (no swiftc on ${process.platform})`)
}

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sign } from './signing.mjs'

/**
 * Copies the Bun that runs the build into `Trezi.app/Contents/Helpers/bun`, the runtime
 * `open -a Trezi` starts the backend and the provider helpers with (`HostLaunch.swift`),
 * so no installed Bun is needed once Trezi is built. An identical copy is left alone
 * (an update rebuilds with the bundled Bun itself); a new one replaces the old by
 * rename, never in place, because a running Trezi may be executing it.
 *
 * Bun's own Developer ID signature is already stable across rebuilds and carries the
 * hardened-runtime entitlements its JIT needs, so it is kept. A copy that is unsigned,
 * invalid or ad hoc is signed with the build's identity (`signing.mjs`, LKM-137).
 */
export function bundleBun(contents, { signer = { kind: 'adhoc' }, source = process.execPath } = {}) {
  const target = join(contents, 'Helpers/bun')
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) && statSync(target).size === statSync(source).size &&
      Bun.hash(readFileSync(target)) === Bun.hash(readFileSync(source))) return { path: target, copied: false }
  const temporary = `${target}.${process.pid}.tmp`
  try {
    copyFileSync(source, temporary)
    chmodSync(temporary, 0o755)
    const vendor = spawnSync('codesign', ['--verify', temporary]).status === 0 &&
      !/Signature=adhoc/.test(spawnSync('codesign', ['-dv', temporary], { encoding: 'utf8' }).stderr ?? '')
    if (!vendor) {
      try { sign(signer, temporary, 'dev.trezi.bun') } catch (error) { throw new Error(`Could not sign the bundled Bun: ${error.message}`) }
    }
    renameSync(temporary, target)
  } finally { rmSync(temporary, { force: true }) }
  return { path: target, copied: true }
}

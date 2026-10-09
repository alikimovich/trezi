import { spawn } from 'node:child_process'
import { NativeBridge } from '../../src/native/bridge.ts'

/**
 * A bare `TreziHost <directory> <ephemeral|persistent>` (no service, no Bun backend)
 * driven over its stdio, for UI fixtures. Trezi itself never launches the host this
 * way: its bridge is the service's private pipe.
 */
export function spawnHostBridge(executable, directory, profile = 'ephemeral') {
  const child = spawn(executable, [directory, profile], { stdio: 'pipe' })
  child.stderr.pipe(process.stderr)
  return new NativeBridge({ input: child.stdout, output: child.stdin, child })
}

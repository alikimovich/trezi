import { rmSync } from 'node:fs'
import { basename } from 'node:path'

/** What stopping a check's session that would not close actually did (LOCAL-WEBKIT-4). */
export type Cleanup = {
  /** The wrapper reported this check's private folder, so its processes could be matched. */
  identified: boolean
  /** Headless shells of exactly that folder that were sent SIGKILL. */
  stopped: number
  /** Such a process was still listed afterwards, so the folder was kept. */
  remaining: boolean
  removed: boolean
}

type Processes = () => Promise<{ pid: number; command: string }[]>

/**
 * Kills the headless shells of exactly this check's private folder and removes the folder
 * only once none is left listed. The agent-browser daemon that owns the session cannot be
 * matched by its command line, so it is never killed or confirmed gone here, and no other
 * process is touched.
 */
export async function stopOwnedSession(
  session: { shell: string; base: string } | undefined,
  ps: Processes
): Promise<Cleanup> {
  if (!session || !basename(session.base).startsWith('tzab-'))
    return { identified: false, stopped: 0, remaining: false, removed: false }
  const mine = async () =>
    (await ps().catch(() => [])).filter(
      (entry) =>
        entry.command.startsWith(`${session.shell} `) && entry.command.includes(session.base)
    )
  let stopped = 0
  for (const entry of await mine()) {
    try {
      process.kill(entry.pid, 'SIGKILL')
      stopped++
    } catch {}
  }
  let remaining = (await mine()).length > 0
  for (let wait = 0; remaining && wait < 10; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    remaining = (await mine()).length > 0
  }
  if (!remaining) rmSync(session.base, { recursive: true, force: true })
  return { identified: true, stopped, remaining, removed: !remaining }
}

/** The honest sentence about the cleanup; `where` is the folder as the user should read it. */
export function cleanupNote(cleanup: Cleanup, where: string): string {
  const daemon =
    'The agent-browser daemon for this check could not be confirmed stopped; it exits after its idle timeout, or run agent-browser close --all in Terminal.'
  if (!cleanup.identified)
    return `Trezi could not tell which browser this check started, so nothing was stopped or removed. ${daemon}`
  if (cleanup.remaining)
    return `A headless browser of this check is still running, so Trezi kept its private folder (${where}). ${daemon}`
  const shells = cleanup.stopped
    ? `Trezi stopped ${cleanup.stopped} headless browser process${cleanup.stopped === 1 ? '' : 'es'} of this check and removed its private folder.`
    : 'Trezi found no running headless browser of this check and removed its private folder.'
  return `${shells} ${daemon}`
}

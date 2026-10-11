import { statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { IncidentClass } from './catalog'
import { clearStaleGitLock } from './git-lock'

export interface Diagnosis {
  cause: string
  /** The safe fix the doctor applied itself, or null when it only diagnosed. */
  fixApplied: string | null
  /** The one exact thing left for the user (or Trezi) to do. */
  nextStep: string
}

/** Where a diagnosis may look. Each probe is read-only; tests replace them. */
export interface DoctorContext {
  root?: string
  freeBytes?: (path: string) => Promise<number>
  clearLock?: (root: string) => Promise<{ removed: boolean; reason?: string } | null>
}

const MIN_FREE_BYTES = 200 * 1024 * 1024

const freeBytesOf = async (path: string): Promise<number> => {
  const stats = await statfs(path)
  return stats.bavail * stats.bsize
}

const fixed: Record<IncidentClass, Pick<Diagnosis, 'cause' | 'nextStep'>> = {
  'provider-network': {
    cause:
      'The provider could not be reached after Trezi retried and the other provider was unavailable.',
    nextStep: 'Check the network, proxy or VPN, then send the message again.'
  },
  'provider-auth': {
    cause: 'The provider rejected the saved sign-in.',
    nextStep: 'Sign in again from the chat card or Settings.'
  },
  'provider-limit': {
    cause: 'The provider reports a usage or rate limit.',
    nextStep: 'Wait for the limit to reset or choose another provider or model.'
  },
  'model-unavailable': {
    cause: 'The selected model is not available on this account.',
    nextStep: 'Choose another model from the model picker.'
  },
  'helper-crash': {
    cause: 'The provider helper stopped and did not recover after restarts.',
    nextStep: 'Send the message again; if it repeats, update the provider CLI.'
  },
  'dev-server': {
    cause: 'The dev server stopped or its port is taken.',
    nextStep: 'Restart the preview from the preview toolbar; free the port if it stays busy.'
  },
  'dependency-install': {
    cause: 'Installing the project dependencies failed.',
    nextStep: 'Open the dependency details, fix the reported package, then retry the install.'
  },
  conflict: {
    cause: 'The live checkout changed in the same files as this turn.',
    nextStep: 'Use Resolve on the held changes, or Discard them.'
  },
  landing: {
    cause: 'The turn’s changes could not be applied to the live checkout.',
    nextStep: 'Use Retry on the card, or Resolve if the files changed.'
  },
  'git-lock': {
    cause: 'A Git index lock blocked the operation.',
    nextStep: 'Wait for the running Git command to finish, then try again.'
  },
  'disk-full': {
    cause: 'The disk has no space left.',
    nextStep: 'Free disk space (empty the Trash, remove old build output), then try again.'
  },
  'stale-preview': {
    cause: 'The preview shows an older revision.',
    nextStep: 'Reload the preview.'
  },
  unknown: {
    cause: 'The error is not one Trezi recognizes.',
    nextStep: 'Read the error details, then send the message again or start a new chat.'
  }
}

/**
 * LKM-225: the deterministic doctor. For an incident class that no automatic recovery
 * settled, it reads safe facts (free disk space, a stale Git lock through the Swift
 * owner) and returns the cause, any fix it applied and one next step. It runs no model,
 * shell command or write of its own; the agent-driven `trezi-doctor` skill remains the
 * place for deeper investigation.
 */
export async function diagnose(code: IncidentClass, ctx: DoctorContext = {}): Promise<Diagnosis> {
  const base = fixed[code]
  if (code === 'git-lock' && ctx.root) {
    const result = await (ctx.clearLock ?? clearStaleGitLock)(ctx.root)
    if (result?.removed)
      return {
        cause: 'A stale Git index lock blocked the operation.',
        fixApplied: 'Removed the stale lock; no Git process was using it.',
        nextStep: 'Try again.'
      }
  }
  if (code === 'disk-full') {
    try {
      const free = await (ctx.freeBytes ?? freeBytesOf)(ctx.root ?? tmpdir())
      if (free >= MIN_FREE_BYTES)
        return {
          cause: 'A write hit a full disk, but space is available now.',
          fixApplied: null,
          nextStep: 'Try again.'
        }
    } catch {}
  }
  return { ...base, fixApplied: null }
}

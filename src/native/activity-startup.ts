import type { ConversationRecovery } from '../main/conversation-owner'
import type { RepositoryStatus } from '../main/repository-owner'
import type { SourceRecovery } from '../main/source-owner'
import {
  type ActivityKind,
  type ActivityOptions,
  RESTORED_CHATS,
  ROLLED_BACK_SOURCE
} from './activity-controller'
import { recoveryNotices } from './repository-recovery'

type Log = { append(text: string, kind?: ActivityKind, options?: ActivityOptions): void }
const recoveryKind = (kind: 'info' | 'warning' | 'error'): ActivityKind =>
  kind === 'error' ? 'needs-action' : kind === 'warning' ? 'warning' : 'notice'

/**
 * The launch reports of the service owners (LKM-152). They are gray `notice` lines that
 * never open Activity: nothing was lost. Repeated ones collapse into one summary line.
 * Only a damaged journal, which blocks every later change, needs the user.
 */
export function reportRepositoryRecovery(log: Log, status: RepositoryStatus) {
  // Work a previous service could not finish stays at its recovery refs; nothing is
  // replayed or reset. The service closes each interrupted entry at the launch that
  // finds it, so this reports it once (LKM-134).
  for (const notice of recoveryNotices(status))
    log.append(
      notice.text,
      recoveryKind(notice.kind),
      notice.kind === 'error' ? { event: 'repository-journal' } : {}
    )
}

/** A chat a crash cut off was saved from its checkpoint at launch (never over a newer
 *  record, which is kept, with the checkpoint copied beside it). */
export function reportConversationRecovery(log: Log, recovered: ConversationRecovery[]) {
  for (const entry of recovered) {
    if (entry.outcome === 'damaged')
      log.append(
        `A damaged chat checkpoint was moved aside${entry.copy ? ` to ${entry.copy}` : ''}.`,
        'warning'
      )
    else
      log.append(
        `A chat was cut off${entry.interrupted ? ' mid-turn' : ''} when Trezi last stopped; ${entry.outcome === 'restored' ? 'its conversation was restored' : `a newer copy was kept and the checkpoint saved to ${entry.copy}`}.`,
        'notice',
        entry.outcome === 'restored' ? { group: RESTORED_CHATS } : {}
      )
  }
}

/** A transaction a crash cut short was rolled back at launch where its own bytes were
 *  still there; a file changed since was kept, with the pre-image beside the report. */
export function reportSourceRecovery(
  log: Log,
  { interrupted, journal }: { interrupted: SourceRecovery[]; journal?: string }
) {
  if (journal) log.append(`Source journal: ${journal}`, 'needs-action', { event: 'source-journal' })
  for (const entry of interrupted)
    log.append(
      `An earlier source ${entry.kind} in ${entry.root} was interrupted and rolled back${entry.kept.length ? `; ${entry.kept.length} file(s) changed since were kept, with their previous content under ${entry.copies[0]?.replace(/\/files\/[^/]+$/, '')}` : ''}.`,
      'notice',
      entry.kept.length ? {} : { group: ROLLED_BACK_SOURCE }
    )
}

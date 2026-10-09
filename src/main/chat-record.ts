import type { ChatRecordLookup } from '../shared/chat-islands'

/** What the lookup reads of the chat registry (agent.ts supplies it). */
export interface ChatRecordSources {
  /** Awaits a pending chat's preparation, either way. */
  settled: (chat: string) => Promise<void>
  /** Whether the chat is still being prepared, or failed (and why); null when not pending. */
  pending: (chat: string) => { failed: boolean; error?: string } | null
  /** The chat's live session: its record, project root and checkout. */
  session: (chat: string) => { recordId: string; root: string; worktree: string } | undefined
  isRepo: (root: string) => Promise<boolean>
  /** The project folder a pending chat was created for. */
  pendingRoot: (chat: string) => string | undefined
}

/**
 * LKM-199: a chat's owner record for its island session, or why it has none. With
 * `wait` a pending workspace is awaited; without it a pending one is `workspace_pending`
 * at once. A failed preparation is `preparation_failed`, or `not_git` when the project
 * folder is not a Git repository (the usual reason there is no workspace); a chat that is
 * neither pending nor live is `closed`.
 */
export async function chatRecordLookup(
  chat: string,
  wait: boolean,
  src: ChatRecordSources
): Promise<ChatRecordLookup> {
  const preparing = src.pending(chat)
  if (preparing && !preparing.failed && !wait) return { ready: false, code: 'workspace_pending' }
  await src.settled(chat)
  const failed = src.pending(chat)
  if (failed?.failed) {
    const root = src.pendingRoot(chat)
    const code = root && !(await src.isRepo(root)) ? 'not_git' : 'preparation_failed'
    return { ready: false, code, ...(failed.error ? { detail: failed.error } : {}) }
  }
  const live = src.session(chat)
  if (live?.recordId) return { ready: true, ...live }
  // A live session whose record is not stored yet, versus a chat that is gone.
  return { ready: false, code: live ? 'no_session' : 'closed' }
}

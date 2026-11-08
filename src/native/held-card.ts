import type { NativeChatCard } from '../shared/native-chat'
import type { Chat } from './chat-state'

/**
 * LKM-590: the held-changes card (`id: 'conflict'`), state-aware. One recommended action
 * from structured state, never from error prose:
 *  - Trezi owns the hold (a request, a check, a resolution turn): progress only, no row.
 *  - The landing failed (`landingError`): "Try applying again" (`agent:retry-landing`:
 *    brings the work up to date with the project when it moved, checks it, applies it).
 *  - The backend staged overlapping edits (`conflicts`): "Fix conflicts" (`agent:resolve-
 *    conflict`: the agent combines both versions in a turn, then Trezi lands the result).
 *  - Otherwise the project moved under the work: "Combine with project edits" (the same
 *    Resolve: merges with the newer edits, lands when clean, the agent fixes any overlap).
 * The other recovery, the support report and Discard sit in the card's More menu; Discard
 * asks first. The actions keep their owners in `chat-actions.ts`.
 */

export const RETRY_LABEL = 'Try applying again'
export const FIX_LABEL = 'Fix conflicts'
export const COMBINE_LABEL = 'Combine with project edits'
export const DISCARD_ASK_LABEL = 'Discard held changes…'
/** A request that ended with the work still held and no reason of its own. */
export const STILL_HELD = 'The changes are still held.'

type Action = NativeChatCard['actions'][number]
type MenuItem = NonNullable<NativeChatCard['menu']>[number]

const retry: Action = { label: RETRY_LABEL, action: 'landing-retry' }
const discardAsk: MenuItem = { label: DISCARD_ASK_LABEL, action: 'discard-ask' }
const report = (chat: Chat): MenuItem[] =>
  chat.recoveryReport ? [{ label: 'Copy support report', action: 'recovery-report' }] : []

/** A request, Keep or turn holds the chat: no recovery can start now. */
export const recoveryBlocked = (chat: Chat) =>
  chat.isRunning || chat.sending || !!chat.recovery || !!chat.keepingStopped

/** Discard's own step: what is deleted, and a way back. Shown in place of the card. */
export function discardConfirmCard(chat: Chat, branch?: string): NativeChatCard {
  return {
    id: 'conflict',
    title: 'Discard held changes?',
    detail: [
      branch
        ? `Trezi deletes this chat’s held changes and their branch ${branch}.`
        : 'Trezi deletes this chat’s held changes.',
      'The project keeps its current files. This can’t be undone.',
      ...(chat.isolationFiles ?? [])
    ].join('\n'),
    actions: [
      { label: 'Keep changes', action: 'discard-cancel' },
      { label: 'Discard changes', action: 'discard', role: 'destructive' }
    ]
  }
}

/** What Trezi is doing while it owns the hold. */
function workingTitle(chat: Chat): string {
  if (chat.recovery === 'retry') return 'Trying to apply again…'
  if (chat.recovery === 'discard') return 'Discarding held changes…'
  if (chat.recovery === 'resolve') return 'Combining with project edits…'
  if (chat.isRunning && chat.operation === 'resolving') return 'Fixing conflicts…'
  if (chat.isRunning && chat.phase !== 'applying') return 'Working on held changes…'
  return 'Checking changes…'
}

export function heldCard(chat: Chat): NativeChatCard {
  // A running turn, check, or live recovery request still owns this park. Once that
  // operation ends, the same card exposes its actual reason and report.
  const owned =
    (!!chat.recovery && !chat.recoveryTimedOut) ||
    !!chat.keepingStopped ||
    (chat.isRunning &&
      !chat.stopping &&
      (chat.operation === 'resolving' ||
        !chat.landingError ||
        (chat.phase === 'applying' && chat.operation === 'parking')))
  const busy = (!!chat.recovery && !chat.recoveryTimedOut) || !!chat.keepingStopped
  if (owned)
    return {
      id: 'conflict',
      title: workingTitle(chat),
      detail: 'Trezi is working on the held changes. Nothing is needed from you yet.',
      busy,
      actions: [],
      ...(report(chat).length ? { menu: report(chat) } : {})
    }
  if (chat.confirmingDiscard && !recoveryBlocked(chat)) return discardConfirmCard(chat)
  const files = chat.isolationFiles ?? []
  // Staged overlaps come first: a failed landing over conflict markers only lands once
  // they are fixed, which Resolve (Fix conflicts) does; Retry stays in More there.
  const kind = chat.conflicts?.length ? 'conflict' : chat.landingError ? 'failed' : 'moved'
  const reason =
    kind === 'failed'
      ? `Trezi couldn’t apply them to the project: ${chat.landingError}`
      : kind === 'conflict'
        ? `This chat and the project changed the same lines, so Trezi held these changes.${chat.landingError ? ` The last attempt to apply them failed: ${chat.landingError}` : ''}`
        : 'The project changed under them, so Trezi held them instead of overwriting.'
  const title =
    kind === 'failed'
      ? 'Changes couldn’t be applied'
      : kind === 'conflict'
        ? 'Changes overlap with project edits'
        : 'This turn’s changes didn’t land'
  const resolve: Action = {
    label: kind === 'conflict' ? FIX_LABEL : COMBINE_LABEL,
    action: 'resolve'
  }
  const primary = kind === 'failed' ? retry : resolve
  const hint =
    kind === 'failed'
      ? `${RETRY_LABEL} checks the held changes again and applies them if the check passes.`
      : kind === 'conflict'
        ? `${FIX_LABEL} asks the agent to combine both versions; Trezi then applies the result.`
        : `${COMBINE_LABEL} merges them with the newer edits and applies the result; overlapping lines go to the agent.`
  // The other recovery is a real alternative only where it can do something different:
  // a failed landing can still be combined with the project; a moved project can be
  // retried. A staged overlap is only fixed by Resolve, so Retry is offered there only when
  // a landing also failed (as before, it then lands the work again).
  const alternative: MenuItem[] =
    kind === 'failed'
      ? [{ label: COMBINE_LABEL, action: 'resolve' }]
      : kind === 'moved' || chat.landingError
        ? [retry]
        : []
  // A timed-out request still owns the work until its IPC settles: say so, offer nothing.
  const waiting = !!chat.recovery || !!chat.keepingStopped
  const blocked = recoveryBlocked(chat)
  // A request that failed says Problem with its own words; one that ended with the work
  // still held says so in one line with the reason, the files in the full text.
  const problem = chat.recoveryProblem
  const failedRequest = !!problem?.startsWith('Problem:')
  return {
    id: 'conflict',
    title: failedRequest ? 'Problem' : title,
    detail: failedRequest
      ? problem
      : problem === STILL_HELD
        ? `${STILL_HELD} ${reason}`
        : problem
          ? `Still held: ${problem}`
          : [reason, ...files].join('\n'),
    ...(problem && files.length ? { fullDetail: files.join('\n') } : {}),
    hint: waiting
      ? 'The earlier request is still finishing. Recovery returns when it ends.'
      : blocked
        ? 'Recovery returns when the current turn finishes.'
        : hint,
    busy,
    actions: blocked ? [] : [{ ...primary, role: 'primary' }],
    menu: [...report(chat), ...(blocked ? [] : [...alternative, discardAsk])]
  }
}

/** The decision card's More menu: Discard asks first, as on the held card. */
export const decisionMenu = (chat: Chat): MenuItem[] => (recoveryBlocked(chat) ? [] : [discardAsk])

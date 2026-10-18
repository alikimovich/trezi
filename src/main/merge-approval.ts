import { randomUUID } from 'node:crypto'
import type { QuestionAnswers, QuestionSpec } from '../shared/api'

/**
 * LKM-281: an agent merges a pull request only after the user approved that merge in a
 * card Trezi shows itself. The approval names one repository, one PR and one exact
 * head commit, lives only here in the host (never in the model's arguments), is used at
 * most once and expires. A dismissed or declined card, or any other head, approves
 * nothing. Like ask_user, the tool call returns at once and the user's answer arrives as
 * their next message: a tool call cannot wait for a person.
 */

/** What the user approves: one pull request of one repository at one exact head. */
export interface MergeTarget {
  /** `host/owner/name` of the PR's (base) repository, lower case. */
  repo: string
  number: number
  head: string
}

interface Approval {
  chat: string
  liveRoot: string
  target: MergeTarget
  question: QuestionSpec
  approved: boolean
  at: number
}

export const MERGE_APPROVAL_TTL_MS = 15 * 60_000
export const MERGE_OPTION = 'Merge'
export const KEEP_OPTION = "Don't merge"

const approvals = new Map<string, Approval>()
let now = (): number => Date.now()

/** Tests move the clock to check expiry. */
export function setMergeApprovalClock(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now())
}

const same = (a: MergeTarget, b: MergeTarget): boolean =>
  a.repo === b.repo && a.number === b.number && a.head === b.head

/** The target GitHub reports for a PR: its URL names the repository; null when unclear. */
export function mergeTarget(url: unknown, number: unknown, head: unknown): MergeTarget | null {
  const match =
    typeof url === 'string'
      ? /^https:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(
          url
        )
      : null
  if (!match || typeof number !== 'number' || Number(match[4]) !== number) return null
  if (typeof head !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return null
  return { repo: `${match[1]}/${match[2]}/${match[3]}`.toLowerCase(), number, head }
}

const resolved = (notify: Notify, chat: string, id: string): void =>
  notify('agent:event', { type: 'question-resolved', id, projectKey: chat })

type Notify = (channel: string, payload: unknown) => void

/** Drops every approval (asked or given) of a chat, and its card. */
export function revokeMergeApprovals(chat: string, notify?: Notify): void {
  for (const [id, approval] of approvals)
    if (approval.chat === chat) {
      approvals.delete(id)
      if (notify && !approval.approved) resolved(notify, chat, id)
    }
}

/**
 * Shows the confirmation card for `target` in `chat` and replaces any earlier approval
 * of that chat (asked or given). Returns the card's id.
 */
export function requestMergeApproval(
  chat: string,
  liveRoot: string,
  target: MergeTarget,
  notify: Notify
): string {
  revokeMergeApprovals(chat, notify)
  const id = `merge-approval:${randomUUID()}`
  const short = target.head.slice(0, 12)
  const question: QuestionSpec = {
    header: 'Merge PR',
    question: `Merge pull request #${target.number} in ${target.repo} at commit ${short}?`,
    options: [
      {
        label: MERGE_OPTION,
        description: `Squash-merge exactly ${short}. If the branch changes first, Trezi asks again.`
      },
      { label: KEEP_OPTION, description: 'Leave the pull request open.' }
    ],
    multiSelect: false
  }
  approvals.set(id, { chat, liveRoot, target, question, approved: false, at: now() })
  notify('agent:event', {
    type: 'question-request',
    request: { id, questions: [question], sessionKey: chat },
    projectKey: chat
  })
  return id
}

/**
 * The user's answer to a merge card, as their next message; undefined when `id` is not
 * a merge card. Only the card's own Merge option approves; anything else declines.
 */
export function answerMergeApproval(
  id: string,
  answers: QuestionAnswers | null
): { message?: string } | undefined {
  const approval = approvals.get(id)
  if (!approval) return undefined
  const { number, repo } = approval.target
  if (approval.approved) return {}
  if (answers?.[approval.question.question] === MERGE_OPTION) {
    approval.approved = true
    approval.at = now()
    return {
      message: `I approved merging pull request #${number} in ${repo} at commit ${approval.target.head.slice(0, 12)}. Call publish_merge once to merge it.`
    }
  }
  approvals.delete(id)
  return answers
    ? { message: `Do not merge pull request #${number} in ${repo}. Leave it open.` }
    : {}
}

export type ApprovalCheck = 'approved' | 'none' | 'changed' | 'expired'

/**
 * Spends the chat's approval when it names exactly `target`: an approval is used once.
 * A different repository, PR or head drops it (`changed`); so does age (`expired`).
 */
export function takeMergeApproval(
  chat: string,
  liveRoot: string,
  target: MergeTarget
): ApprovalCheck {
  for (const [id, approval] of approvals) {
    if (approval.chat !== chat || !approval.approved) continue
    approvals.delete(id)
    if (now() - approval.at > MERGE_APPROVAL_TTL_MS) return 'expired'
    if (approval.liveRoot !== liveRoot || !same(approval.target, target)) return 'changed'
    return 'approved'
  }
  return 'none'
}

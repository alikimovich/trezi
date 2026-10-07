import type { PublishResult } from './api'

/**
 * Publish progress (LKM-187): the steps the Swift workflow owner reports for a
 * publish, the toolbar label for each, and the result toast and failure sheet text.
 * The owner reports `step`/`stepSince` on an open publish in `workflows`
 * (`WorkflowOwner.phase`); `step` on a failed result names where it stopped.
 */

export const PUBLISH_STEPS: Record<string, string> = {
  commit: 'Committing',
  sync: 'Syncing with GitHub',
  push: 'Pushing',
  describe: 'Writing description',
  pr: 'Creating pull request',
  merge: 'Merging',
  cleanup: 'Cleaning up'
}

/** Steps before the pull request exists: the owner stops before its next effect. */
const CANCELLABLE = new Set(['commit', 'sync', 'push', 'describe'])

/** A step's elapsed time shows once it has taken longer than this. */
export const PUBLISH_ELAPSED_AFTER_MS = 3000

export interface PublishProgress {
  /** The workflow record, once the owner has opened one. */
  id?: string
  /** running · describe while open; the final state otherwise. */
  state: string
  step?: string
  /** Epoch ms the step started. */
  since?: number
  result?: PublishResult | null
}

/** The fields of a workflow summary this module reads (`WorkflowSummary`). */
interface Summary {
  id: string
  kind: string
  root: string
  state: string
  steps: { name: string; state: string }[]
  result: unknown
  started: string
  step?: string
  stepSince?: string
}

const OPEN = new Set(['running', 'describe'])

/** The newest publish workflow on `root`, or null when there is none. */
export function publishProgress(workflows: Summary[], root: string): PublishProgress | null {
  const record = workflows
    .filter((w) => w.kind === 'publish' && w.root === root)
    .sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0))
    .at(-1)
  if (!record) return null
  const open = OPEN.has(record.state)
  // Without the owner's live step (a relaunched service), the journal's last open step.
  const step =
    record.step ??
    (open
      ? record.state === 'describe'
        ? 'describe'
        : [...record.steps].reverse().find((s) => s.state === 'intent')?.name
      : undefined)
  const since = record.stepSince ? Date.parse(record.stepSince) : undefined
  return {
    id: record.id,
    state: record.state,
    ...(step && PUBLISH_STEPS[step] ? { step } : {}),
    ...(since !== undefined && !Number.isNaN(since) ? { since } : {}),
    result: open ? null : ((record.result as PublishResult | null) ?? null)
  }
}

export function publishCancellable(step: string | undefined): boolean {
  return !step || CANCELLABLE.has(step)
}

/** The Publish button's label while a publish runs. */
export function publishLabel(
  mode: 'merge' | 'pr',
  progress: { step?: string; since?: number; cancelling?: boolean },
  now = Date.now()
): string {
  if (progress.cancelling) return 'Cancelling…'
  const label = progress.step ? PUBLISH_STEPS[progress.step] : undefined
  if (!label) return mode === 'pr' ? 'Creating PR…' : 'Publishing…'
  const elapsed = progress.since === undefined ? 0 : now - progress.since
  return elapsed > PUBLISH_ELAPSED_AFTER_MS
    ? `${label}… ${Math.floor(elapsed / 1000)}s`
    : `${label}…`
}

function pullNumber(url: string | undefined): string | null {
  return url?.match(/\/pull\/(\d+)/)?.[1] ?? null
}

/** The success toast: "Published — PR #5 merged". */
export function publishedMessage(mode: 'merge' | 'pr', result: PublishResult): string {
  const number = pullNumber(result.url)
  if (mode === 'pr') return number ? `Pull request #${number} opened` : 'Pull request opened'
  return number ? `Published — PR #${number} merged` : 'Published'
}

/** What kind of failure this is, for the sheet's explanation. */
function reason(result: PublishResult): string | null {
  const error = result.error ?? ''
  if (result.conflictFiles?.length)
    return 'Your changes and the changes on GitHub edit the same lines. Resolve and stage each file, commit the merge, then publish again.'
  if (
    /gh auth login|authentication|could not read username|permission denied|\b40[13]\b/i.test(error)
  )
    return 'GitHub refused the request. Run gh auth login in your terminal, then retry.'
  if (/could not resolve host|network|timed out|timeout|connection (refused|reset)/i.test(error))
    return 'GitHub could not be reached. Check your connection, then retry.'
  return null
}

/** The failure sheet: the step, the reason and the full text to copy. */
export function publishFailure(
  mode: 'merge' | 'pr',
  result: PublishResult
): { title: string; detail: string; details: string } {
  const step = result.step ? PUBLISH_STEPS[result.step] : undefined
  const error = (result.error ?? 'Publish failed.').trim()
  const files = result.conflictFiles ?? []
  const detail = [
    step ? `Stopped at: ${step}.` : null,
    reason(result),
    files.length ? `Conflicting files:\n${files.join('\n')}` : error
  ]
    .filter(Boolean)
    .join('\n\n')
  const details = [
    `${mode === 'pr' ? 'Create PR' : 'Publish'} failed${step ? ` at: ${step}` : ''}`,
    error,
    files.length ? `Conflicting files:\n${files.join('\n')}` : null,
    result.recoveryRefs?.length ? `Recovery refs: ${result.recoveryRefs.join(', ')}` : null
  ]
    .filter(Boolean)
    .join('\n')
  return {
    title: mode === 'pr' ? 'Couldn’t create the pull request' : 'Couldn’t publish',
    detail,
    details
  }
}

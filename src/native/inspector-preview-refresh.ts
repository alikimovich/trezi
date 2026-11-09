// LKM-600: before an inspector Apply starts its agent, the app (not the agent) makes sure
// the draft's element came from a current preview document.
//
// "Stale" here is the preview identity's flag (`src/main/preview-identity.ts`): the shown
// document started navigating at an older live HEAD than the checkout has now. Hot reload
// usually applied the newer source, so a stale document alone proves nothing. It matters
// to a draft only when one of the draft's files changed between those two revisions: then
// the selection's source stamp may describe older code. In that case the app reloads the
// preview once, waits (bounded) for the same element to resolve uniquely again, and only
// then lets Apply continue; the caller re-reads the source hashes afterwards. Nothing here
// retries, navigates elsewhere or picks a different element.
import { execFile } from 'node:child_process'
import { previewPage } from '../main/preview-page'
import type { LayersSnapshot, SelectedElement } from '../shared/api'
import type { NativeBridge } from './bridge'
import type { NativeInspectorController } from './inspector-controller'
import { serviceEvents } from './platform'
import type { NativeWorkspaceController } from './workspace-controller'

export type PreviewFreshness = 'current' | 'stale'
export type PreviewRefreshOutcome = 'ok' | 'moved' | 'missing' | 'ambiguous' | 'timeout'

/** How long one refresh may take, reload through re-resolution. */
export const REFRESH_BUDGET_MS = 10_000
const POLL_MS = 150
/** A loaded page without the element is given this long to hydrate it (as the restore path). */
export const MISSING_GRACE_MS = 1200

/**
 * Whether any of `files` (project-relative) differs between the two revisions. Unknown
 * (a Git error, a revision that is gone) counts as changed: one bounded refresh is the
 * safe answer, never a skipped check.
 */
export function changedBetween(
  root: string,
  from: string,
  to: string,
  files: string[]
): Promise<boolean> {
  if (!files.length) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(
      'git',
      ['diff', '--quiet', from, to, '--', ...files],
      { cwd: root, timeout: 3000 },
      (error) => resolve(!!error)
    )
  })
}

/** The draft's preview needs a refresh only when the stale document predates its files. */
export async function previewFreshness(
  identity: { stale: boolean; servedRevision: string | null; liveRevision: string | null },
  changed: (from: string, to: string) => Promise<boolean>
): Promise<PreviewFreshness> {
  if (!identity.stale || !identity.servedRevision || !identity.liveRevision) return 'current'
  return (await changed(identity.servedRevision, identity.liveRevision)) ? 'stale' : 'current'
}

export interface PreviewRefreshDeps {
  /** Same project active and previewed, same selection: false ends the refresh as `moved`. */
  still(): boolean
  /** Reloads the user's preview once (the toolbar's ordinary reload). */
  reload(): void
  /** Resolves true when a document that started at or after `since` reports ready. */
  ready(since: number, ms: number): Promise<boolean>
  layers(): Promise<LayersSnapshot | null>
  /** The page holds a selection again (the element was re-picked after the reload). */
  alive(): Promise<boolean>
  /** Re-picks the unique match (the runtime's same-page reattach). */
  reattach(): Promise<void>
  wait(ms: number): Promise<void>
  now(): number
}

const same = (
  node: LayersSnapshot['nodes'][number],
  element: Pick<SelectedElement, 'tag' | 'source' | 'id'>
) =>
  node.tag === element.tag &&
  node.source === element.source &&
  (node.id ?? null) === (element.id ?? null)

/**
 * One reload, then the original element must resolve exactly once (tag, source stamp and
 * id) and be selected again within the budget. Ambiguity ends at once; absence is only
 * decided at the deadline (a page may hydrate late).
 */
export async function refreshForApply(
  deps: PreviewRefreshDeps,
  element: Pick<SelectedElement, 'tag' | 'source' | 'id'>,
  budget = REFRESH_BUDGET_MS
): Promise<PreviewRefreshOutcome> {
  if (!deps.still()) return 'moved'
  const since = deps.now()
  const deadline = since + budget
  deps.reload()
  if (!(await deps.ready(since, budget))) return deps.still() ? 'timeout' : 'moved'
  let found = false
  let reattached = false
  let absentSince: number | null = null
  while (deps.now() < deadline) {
    if (!deps.still()) return 'moved'
    const snapshot = await deps.layers()
    const matches = snapshot?.nodes.filter((node) => same(node, element)) ?? []
    if (!deps.still()) return 'moved'
    if (matches.length > 1) return 'ambiguous'
    // A complete, non-empty tree without the element: absent once the grace has passed,
    // instead of holding the footer busy until the deadline.
    if (!matches.length && snapshot && !snapshot.truncated && snapshot.nodes.length) {
      absentSince ??= deps.now()
      if (deps.now() - absentSince >= MISSING_GRACE_MS) return 'missing'
    } else absentSince = null
    if (matches.length === 1) {
      found = true
      if (await deps.alive()) return deps.still() ? 'ok' : 'moved'
      if (!reattached) {
        reattached = true
        await deps.reattach()
        continue
      }
    }
    await deps.wait(POLL_MS)
  }
  return found ? 'timeout' : 'missing'
}

/** The inspector's concise outcome for a refresh that did not end `ok`. */
export function refreshRefusal(outcome: Exclude<PreviewRefreshOutcome, 'ok'>): string {
  const pending = ' The draft is still pending.'
  if (outcome === 'moved')
    return `The project or selection changed while the preview refreshed.${pending}`
  if (outcome === 'missing')
    return `After refreshing the preview, the selected element is no longer on the page. Reselect it, then Apply.${pending}`
  if (outcome === 'ambiguous')
    return `After refreshing the preview, more than one element matches the selection. Reselect it, then Apply.${pending}`
  return `The preview did not finish refreshing. Refresh it, then Apply again.${pending}`
}

/**
 * Wires the inspector's two seams to the real preview: the identity read every preview
 * tool uses, the ordinary reload, the page's readiness event, Layers and the runtime's
 * same-page reattach. Only the active project's running preview is ever touched.
 */
export function wireApplyRefresh(
  controller: NativeInspectorController,
  workspace: NativeWorkspaceController,
  host: NativeBridge,
  reattach: (root: string) => Promise<void>
): void {
  const previewing = (root: string) =>
    workspace.active?.root === root &&
    workspace.state.status.kind === 'running' &&
    workspace.active.previewKind !== 'simulator'
  controller.previewFreshness = async (root, files) => {
    if (!previewing(root)) return 'current'
    const { identity, refusal } = await previewPage(root)
    // Another server's page: the selection is not this project's, handled elsewhere.
    if (refusal) return 'current'
    return previewFreshness(identity, (from, to) => changedBetween(root, from, to, files))
  }
  controller.refreshPreview = (root, element, still) =>
    refreshForApply(
      {
        still: () => previewing(root) && controller.state.root === root && still(),
        reload: () => host.send('reload', { view: 'preview' }),
        ready: (since, ms) =>
          new Promise((resolve) => {
            const done = (value: boolean) => {
              clearTimeout(timer)
              serviceEvents.off('event', listen)
              resolve(value)
            }
            const listen = (channel: string, value: { documentStartedAt?: unknown }) => {
              if (
                channel === 'preview:readiness' &&
                typeof value?.documentStartedAt === 'number' &&
                value.documentStartedAt >= since
              )
                done(true)
            }
            const timer = setTimeout(() => done(false), ms)
            serviceEvents.on('event', listen)
          }),
        layers: () => workspace.services.invoke('layers:read'),
        alive: async () =>
          !!(await workspace.services.invoke('styles:read', ['display']).catch(() => null))?.values,
        reattach: () => reattach(root),
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now()
      },
      element
    )
}

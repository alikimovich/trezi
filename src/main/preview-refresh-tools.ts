import { projectKey } from '../shared/projectKey'
import { previewServers } from './preview-evidence'
import { previewFreshness } from './preview-freshness'
import { pathOf, previewLoads } from './preview-loads'
import { getPreviewUrl } from './preview-state'
import { probeDevServer, RESTART, reportLoad } from './preview-tools'

/** One `reload_preview` / `restart_dev_server` call, sent to the native host. */
export interface PreviewRefreshRequest {
  root: string
  key: string
  id: number
  action: 'reload' | 'restart'
  /** reload: bypass WebKit's caches; restart: drop the dependency caches first. */
  hard: boolean
}

/** What the native host did with a refresh request; a restart answers 'restarting' at
 *  once and its result when the server is up (or failed). */
export type PreviewRefreshAnswer =
  | { state: 'reloading' | 'restarting' }
  | { state: 'restarted'; url: string }
  | { state: 'elsewhere' | 'no-server' | 'busy' }
  | { state: 'failed'; error: string }

/** How long `reload_preview` waits for the page (the MCP bridge allows 30 s per call). */
export const RELOAD_BUDGET_MS = 10_000
/** A restart (stop, clean, start, load) under the bridge's 30 s. */
export const RESTART_BUDGET_MS = 25_000
const ACK_MS = 2000

const NOT_DONE: Record<'elsewhere' | 'no-server' | 'busy', string> = {
  elsewhere: 'The user is viewing another chat or project, so the preview was not touched.',
  'no-server': `The project's dev server is stopped, so there is no page to reload. ${RESTART}`,
  busy: 'The preview is already opening or restarting the project; call open_preview shortly.'
}

let ids = 0
const pending = new Map<number, { answers: PreviewRefreshAnswer[]; wake: () => void }>()

/** The native host's answer to request `id` (an unknown id is ignored). */
export function answerPreviewRefresh(id: unknown, answer: PreviewRefreshAnswer): void {
  const request = typeof id === 'number' ? pending.get(id) : undefined
  if (!request) return
  request.answers.push(answer)
  request.wake()
}

/** Sends one request; `next` takes its next answer (null after `timeoutMs`). */
function ask(
  notify: (channel: string, payload: unknown) => void,
  request: Omit<PreviewRefreshRequest, 'id'>
) {
  const id = ++ids
  const entry = { answers: [] as PreviewRefreshAnswer[], wake: () => {} }
  pending.set(id, entry)
  notify('preview:refresh', { ...request, id } satisfies PreviewRefreshRequest)
  return {
    next: (timeoutMs: number) =>
      new Promise<PreviewRefreshAnswer | null>((resolve) => {
        const take = () => {
          clearTimeout(timer)
          entry.wake = () => {}
          resolve(entry.answers.shift() ?? null)
        }
        const timer = setTimeout(take, timeoutMs)
        timer.unref?.()
        if (entry.answers.length) take()
        else entry.wake = take
      }),
    done: () => pending.delete(id)
  }
}

const hardOf = (raw: unknown, field: 'hard' | 'cleanCache') =>
  (raw as Record<string, unknown> | null)?.[field] === true

/**
 * `reload_preview` (LKM-197): reloads the page the preview shows, with `hard: true`
 * past WebKit's caches (the route and scroll stay), and reports the load plus whether
 * its CSS/JS now matches what the dev server serves.
 */
export async function reloadAgentPreview(
  root: string,
  key: string,
  raw: unknown,
  notify: (channel: string, payload: unknown) => void,
  background = false
): Promise<unknown> {
  if (background) return { error: 'Background edits cannot reload the user preview.' }
  const hard = hardOf(raw, 'hard')
  const deadline = Date.now() + RELOAD_BUDGET_MS
  const left = () => Math.max(0, deadline - Date.now())
  const server = previewServers.get(projectKey(root))
  const shown = getPreviewUrl()
  if (!server)
    return { reloaded: false, hard, devServer: { running: false }, message: NOT_DONE['no-server'] }
  const load = previewLoads.nextLoad(null, left())
  const asked = ask(notify, { root, key, action: 'reload', hard })
  const answer = await asked.next(ACK_MS)
  asked.done()
  if (answer?.state !== 'reloading') {
    load.cancel()
    return {
      reloaded: false,
      hard,
      message:
        answer && answer.state in NOT_DONE
          ? NOT_DONE[answer.state as keyof typeof NOT_DONE]
          : answer?.state === 'failed'
            ? answer.error
            : 'The preview did not confirm the reload.'
    }
  }
  const outcome = await load.done
  const target = outcome?.finalUrl ?? shown ?? server.url
  return {
    reloaded: !!outcome,
    hard,
    ...((await reportLoad(
      key,
      pathOf(target),
      target,
      outcome,
      devServer(server.url),
      left
    )) as object)
  }
}

/**
 * `restart_dev_server` (LKM-197): restarts the project's dev server the way the
 * preview's Restart does, with `cleanCache: true` dropping its dependency caches
 * (Vite `node_modules/.vite`, Next `.next/cache`) and reloading the preview past
 * WebKit's caches on the same route. Reports the new server and the page it loaded.
 */
export async function restartAgentDevServer(
  root: string,
  key: string,
  raw: unknown,
  notify: (channel: string, payload: unknown) => void,
  background = false
): Promise<unknown> {
  if (background) return { error: 'Background edits cannot restart the dev server.' }
  const cleanCache = hardOf(raw, 'cleanCache')
  const deadline = Date.now() + RESTART_BUDGET_MS
  const left = () => Math.max(0, deadline - Date.now())
  const load = previewLoads.nextLoad(null, left())
  const asked = ask(notify, { root, key, action: 'restart', hard: cleanCache })
  const ack = await asked.next(ACK_MS)
  const answer = ack?.state === 'restarting' ? await asked.next(left()) : ack
  asked.done()
  if (answer?.state !== 'restarted') {
    load.cancel()
    return {
      restarted: false,
      cleanCache,
      message: !answer
        ? ack
          ? `The dev server is still restarting after ${RESTART_BUDGET_MS / 1000} s (an install can take longer); call open_preview shortly to check the page.`
          : 'The preview did not confirm the restart.'
        : answer.state === 'failed'
          ? `The dev server did not start: ${answer.error} Read the dev-server output before changing anything.`
          : answer.state in NOT_DONE
            ? NOT_DONE[answer.state as keyof typeof NOT_DONE]
            : 'The preview did not restart the dev server.'
    }
  }
  const outcome = await load.done
  const target = outcome?.finalUrl ?? getPreviewUrl() ?? answer.url
  const report = outcome
    ? await reportLoad(key, pathOf(target), target, outcome, devServer(answer.url), left)
    : {
        loaded: false,
        devServer: { ...devServer(answer.url), ...(await probeDevServer(answer.url, 2000)) },
        assets: await previewFreshness(answer.url, Math.min(2000, left())),
        message: 'The dev server restarted, but the preview did not report its page load in time.'
      }
  return { restarted: true, cleanCache, url: answer.url, ...(report as object) }
}

const devServer = (url: string) => ({ running: true, url })

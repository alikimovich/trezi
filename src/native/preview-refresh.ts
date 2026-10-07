import {
  answerPreviewRefresh,
  type PreviewRefreshAnswer,
  type PreviewRefreshRequest
} from '../main/preview-refresh-tools'
import type { NativeBridge } from './bridge'
import { DependencyWatch } from './dependency-watch'
import { serviceEvents } from './platform'
import type { NativeWorkspaceController } from './workspace-controller'

/**
 * The preview's clean-refresh paths (LKM-197): the toolbar "…" menu's Reload Without
 * Cache and Restart Dev Server (clean cache), the agent's `reload_preview` /
 * `restart_dev_server`, and the dependency watch.
 */
export function installPreviewRefresh(
  host: NativeBridge,
  workspace: NativeWorkspaceController,
  report: (error: unknown) => void
): DependencyWatch {
  const running = () => {
    const entry = workspace.active
    return entry && workspace.state.status.kind === 'running' && entry.previewKind !== 'simulator'
      ? entry
      : null
  }
  const reload = (hard: boolean) =>
    host.send('reload', { view: 'preview', ...(hard ? { hard } : {}) })
  const restart = (key: string, clean: boolean) =>
    workspace.command({ type: 'restart', key, ...(clean ? { cleanCache: true } : {}) })

  host.on('shell-action', ({ action }: { action?: unknown }) => {
    const entry = workspace.active
    if (action === 'reload-hard' && running()) reload(true)
    else if (action === 'restart-clean' && entry && workspace.state.status.kind !== 'busy')
      void restart(entry.key, true).catch(report)
  })

  const refresh = async (
    request: PreviewRefreshRequest,
    answer: (value: PreviewRefreshAnswer) => void
  ): Promise<PreviewRefreshAnswer> => {
    const entry = workspace.active
    if (!entry || entry.root !== request.root || entry.activeSessionKey !== request.key)
      return { state: 'elsewhere' }
    if (workspace.state.status.kind === 'busy') return { state: 'busy' }
    if (request.action === 'reload') {
      if (!running()) return { state: 'no-server' }
      reload(request.hard)
      return { state: 'reloading' }
    }
    answer({ state: 'restarting' })
    await restart(entry.key, request.hard)
    const status = workspace.state.status
    if (status.kind === 'running') return { state: 'restarted', url: status.url }
    return {
      state: 'failed',
      error: status.kind === 'error' ? status.message : 'Another open replaced the restart.'
    }
  }
  serviceEvents.on('event', (channel: string, value: PreviewRefreshRequest) => {
    if (channel !== 'preview:refresh') return
    const answer = (result: PreviewRefreshAnswer) => answerPreviewRefresh(value?.id, result)
    void refresh(value, answer).then(answer, (error) => {
      answer({ state: 'failed', error: String(error) })
      report(error)
    })
  })

  const watch = new DependencyWatch(
    () => {
      const entry = running()
      return entry ? { key: entry.key, root: entry.root } : null
    },
    (key) => void workspace.refreshEnvironment(key, undefined, true).catch(report)
  )
  watch.start()
  return watch
}

import { refreshChatIslands } from '../main/chat-islands'
import { previewFreshness, reloadPreviewStyles } from '../main/preview-freshness'
import { noteSourceChange, onSourceChange } from '../main/source-changes'
import { invalidateTokenMemo } from '../main/style-tokens'
import type { NativeBridge } from './bridge'
import { EditorFreshness } from './editor-freshness'
import type { NativeInspectorController } from './inspector-controller'
import { LiveTreeWatch } from './live-tree-watch'
import { serviceEvents } from './platform'
import type { NativeWorkspaceController } from './workspace-controller'

/** Agent events after which the live checkout holds new source. */
const LANDINGS = new Set(['done', 'landing-finished', 'spawn-finished', 'isolation'])

/** The running hub, for the native smoke check (LKM-216). */
export const nativeFreshness: { hub: EditorFreshness | null; watch: LiveTreeWatch | null } = {
  hub: null,
  watch: null
}

/**
 * LKM-216: connects the editor-freshness hub to its signals: Trezi's own source writes
 * (`observedSourceOwner`), the live-tree watch, the dependency watch (through
 * `noteSourceChange`), agent landings, the page's CSS updates and new documents.
 */
export function installEditorFreshness(
  host: NativeBridge,
  workspace: NativeWorkspaceController,
  inspector: NativeInspectorController,
  layers: { refresh(): Promise<unknown> },
  report: (error: unknown) => void
): EditorFreshness {
  const hub = new EditorFreshness({
    active: () => {
      const entry = workspace.active
      if (!entry) return null
      // The entry's own dev-server URL: the status can read busy or error for unrelated reasons.
      return { root: entry.root, url: entry.previewKind === 'simulator' ? null : entry.url }
    },
    inspector: () => inspector.invalidated(),
    layers: () => layers.refresh().then(() => {}),
    islands: refreshChatIslands,
    tokens: invalidateTokenMemo,
    check: (url) => previewFreshness(url, 1500),
    reloadStyles: (paths) => reloadPreviewStyles(paths),
    hardReload: () => host.send('reload', { view: 'preview', hard: true }),
    report
  })
  onSourceChange(({ root, files, reason }) => hub.invalidate(root, reason, files))
  const watch = new LiveTreeWatch((root, files) => noteSourceChange(root, files, 'file-change'))
  const render = workspace.services.render
  workspace.services.render = (state) => {
    render(state)
    watch.target(workspace.active?.root ?? '')
  }
  watch.target(workspace.active?.root ?? '')
  serviceEvents.on('event', (channel, value) => {
    const root = workspace.active?.root
    if (!root) return
    if (channel === 'preview:styles-updated') hub.invalidate(root, 'hmr')
    else if (channel === 'preview:url-changed') hub.invalidate(root, 'document')
    else if (channel === 'agent:event' && LANDINGS.has(value?.type)) {
      if (value.type === 'isolation' && value.state !== 'merged') return
      const entry = workspace.state.projects.find(
        (p) => p.key === value.projectKey || p.sessionKeys.includes(value.projectKey)
      )
      // An event Trezi cannot place (a chat turn's `done`) re-reads the active project.
      hub.invalidate(entry?.root ?? root, 'landing', Array.isArray(value.files) ? value.files : [])
    }
  })
  nativeFreshness.hub = hub
  nativeFreshness.watch = watch
  return hub
}

import { sourceOwner } from '../main/source-owner'
import type { NativeActivityController } from './activity-controller'
import type { NativeBridge } from './bridge'
import { turnBoundaries } from './chat-runtime'
import type { NativeGitController } from './git-controller'
import { type NativeView, serviceEvents } from './platform'
import type { NativeSheetController } from './sheets-runtime'
import { NativeStatesController, type StatesAction } from './states-controller'
import type { NativeWorkspaceController } from './workspace-controller'

/** The running app's states workbench controller (the native smoke drives it). */
export let nativeStates: NativeStatesController | null = null

/**
 * LKM-207: the host's States island and the preview … menu's Workbenches send
 * `states-action`; H in a workbench page arrives as `preview:states-key`; every preview
 * URL change re-syncs; Publish asks first while a workbench exists.
 */
export function installStatesWorkbench(options: {
  host: NativeBridge
  preview: NativeView
  workspace: NativeWorkspaceController
  sheets: NativeSheetController
  log: NativeActivityController
  git: NativeGitController
}) {
  const { host, workspace, log } = options
  const report = (error: unknown) => log.append(String(error), 'error')
  const states = new NativeStatesController({
    send: (command, payload) => host.send(command, payload as Record<string, unknown>),
    preview: (channel, payload) => options.preview.webContents.send(channel, payload),
    active: () => workspace.active ?? null,
    load: (url) => workspace.services.invoke('preview:load', url),
    sheets: options.sheets,
    log: (text, kind) => log.append(text, kind),
    remove: (root, folder, seams) => sourceOwner().removeWorkbench(root, folder, seams)
  })
  nativeStates = states
  options.git.beforePublish = (root) => states.beforePublish(root)
  serviceEvents.on('event', (channel: string, value: unknown) => {
    if (channel === 'preview:url-changed') states.url(typeof value === 'string' ? value : null)
    else if (channel === 'preview:states-key') void states.action({ action: 'hide' }).catch(report)
  })
  // A landed turn may have written a workbench into any project, open or not: rescan its
  // root so the island and the Publish guard see it without a path change.
  turnBoundaries.add((key, kind) => {
    const root = workspace.state.projects.find((p) => p.key === key)?.root
    if (kind === 'landed' && root) states.landed(root)
  })
  host.on('states-action', (action: StatesAction) => {
    if (action && typeof action.action === 'string') void states.action(action).catch(report)
  })
  return states
}

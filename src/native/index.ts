import '../shared/rename-compat'
import { isAbsolute, join, resolve } from 'node:path'
import {
  conversationsClosed,
  onProjectMemoryUpdated,
  projectHasRunningAgents,
  registerAgentIpc,
  setProjectMemoryOwner,
  undoProjectMemoryUpdate
} from '../main/agent'
import { AGENT_FILE_ACCESS_KEY, setAgentFileAccessSource } from '../main/agent-file-access'
import { AGENT_GIT_ACCESS_KEY, setAgentGitAccessSource } from '../main/agent-git-access'
import { registerAnnotationsIpc } from '../main/annotations'
import {
  CLAUDE_USER_PLUGINS_KEY,
  setClaudeUserPluginsSource
} from '../main/backends/claude-isolation'
import {
  CHAT_WORKSPACE_IDLE_KEY,
  cleanLegacyWorkspaces,
  idlePeriod,
  sweepIdleWorkspaces
} from '../main/chat-workspaces'
import { registerControlsIpc } from '../main/control-panels'
import { type ConversationOwner, setConversationOwner } from '../main/conversation-owner'
import { registerDevServerIpc } from '../main/devserver'
import { registerDiagnoseIpc } from '../main/diagnose'
import { setEditingOwner } from '../main/editing-owner'
import { registerFeedbackIpc } from '../main/feedback'
import { createProjectFile, deleteProjectFile, renameProjectFile } from '../main/file-ops'
import { listProjectFiles } from '../main/file-tree'
import { checkoutBranch, ensureBranch, listBranches, switchBranch } from '../main/git'
import { registerGitRemoteIpc } from '../main/git-remote'
import { registerGithubIpc } from '../main/github'
import { type PlatformOwner, setPlatformOwner } from '../main/platform-owner'
import { type PreviewState, registerPreviewIpc } from '../main/preview-ipc'
import { initProductLog, productLog } from '../main/product-log'
import { setDependencyInstaller } from '../main/project-dependencies'
import { readProjectIcon } from '../main/project-icon'
import { registerPropsIpc } from '../main/props'
import { setProviderDataOwner } from '../main/provider-data'
import { setProviderOwner } from '../main/provider-owner'
import { type RepositoryOwner, setRepositoryOwner } from '../main/repository-owner'
import { createProject } from '../main/scaffold'
import { registerSetupIpc } from '../main/setup'
import { registerSimulatorIpc } from '../main/simulator'
import { type SourceOwner, setSourceOwner } from '../main/source-owner'
import { registerStylesIpc } from '../main/styles'
import { registerTokensIpc } from '../main/tokens'
import { setWorkflowOwner, workflowOwner } from '../main/workflow-owner'
import { agentOptionsFor } from '../shared/chat-settings'
import { environmentChanges } from '../shared/environment-changes'
import { parsePreferredModelState, resolvePreferredSettings } from '../shared/preferred-model'
import * as channels from '../shared/preview-channels'
import { projectKey } from '../shared/projectKey'
import {
  ACTIVITY_AUTO_OPEN_KEY,
  activityAutoOpen,
  NativeActivityController
} from './activity-controller'
import {
  reportConversationRecovery,
  reportRepositoryRecovery,
  reportSourceRecovery
} from './activity-startup'
import { appVersion } from './app-version'
import { NativeBridge, setBridge } from './bridge'
import { agentAttention } from './chat-agent-card'
import { installNativeChat } from './chat-runtime'
import { NativeContextController } from './context-controller'
import { serviceConversation } from './conversation-service'
import { displayText, setDisplayProfile } from './display-paths'
import { serviceEditing } from './editing-service'
import { NativeEditorController } from './editor-controller'
import { NativeGitController } from './git-controller'
import { installNativeInspector } from './inspector-runtime'
import { NativeLayersController } from './layers-controller'
import { NativeLegacyNames } from './legacy-names'
import { installLogSupport, notePreviewMessage } from './log-support'
import { showProjectMemoryNote } from './memory-note'
import { networkVolumeNote } from './network-volume-note'
import { app, dispatchIPC, ipcMain, NativeView, serviceEvents, shell, views } from './platform'
import { servicePlatform } from './platform-service'
import { servicePreferences } from './preferences-service'
import { installPreviewLoads, loadErrorStatus } from './preview-load-runtime'
import { NativePreviewRecovery } from './preview-recovery'
import { installPreviewRefresh } from './preview-refresh'
import { NativePreviewSupervisor } from './preview-supervisor'
import { serviceProjectMemory } from './project-memory-service'
import { serviceProvider } from './provider-service'
import { NativeRecoveryRefs } from './repository-recovery'
import { serviceRepository } from './repository-service'
import { NativeReviewController } from './review-controller'
import { type ProjectRuntime, serviceRuntime } from './runtime-service'
import { withClaudePane } from './settings-claude'
import { NativeSettingsController } from './settings-controller'
import { NativeSheetController } from './sheets-runtime'
import { NativeShellController } from './shell-controller'
import { installShutdown } from './shutdown'
import { runNativeCoreSmoke } from './smoke-core'
import {
  removeSmokeDirectory,
  saveSmokeFailure,
  smokeDirectory,
  writeSmokeProject,
  writeSmokeResult
} from './smoke-fixture'
import {
  describeFailure,
  formatFailureLine,
  SMOKE_EXIT_PRODUCT,
  SmokeRunFailure
} from './smoke-report'
import { serviceSource } from './source-service'
import { strandedLandingsNotice } from './stranded-landings'
import { NativeSupportSheets } from './support-sheets'
import { SyntaxController } from './syntax-controller'
import { NativeUpdateController } from './update-controller'
import { serviceWorkflows } from './workflow-service'
import { installNativeWorkspace } from './workspace-runtime'
import { serviceWorkspace } from './workspace-service'

async function main() {
  // The Swift service supervises this process and holds the profile lock
  // (`service.lock`, and the `native.lock` reservation older builds check). A Bun
  // started any other way could share a profile with a running Trezi, so it refuses
  // and writes nothing.
  if (process.env.TREZI_SERVICE_LOCKED !== '1' || process.env.TREZI_SERVICE_SUPERVISED !== '1')
    throw new Error(
      'Trezi must be started by its service (open -a Trezi, trezi, or bun run dev), which holds the profile lock. Nothing was changed.'
    )
  // stdout is the service's frame pipe: logs go to stderr.
  console.log = console.info = console.debug = (...args) => console.error(...args)
  initProductLog('backend')
  productLog.info('lifecycle', 'Backend started', { version: appVersion(), pid: process.pid })
  const testing = process.argv.includes('--test')
  const testDir = testing ? smokeDirectory() : null
  if (testDir) process.env.TREZI_USER_DATA = join(testDir, 'profile')
  const profile = app.getPath('userData')
  setDisplayProfile(profile)
  const projectIndex = process.argv.indexOf('--project')
  const requestedProject = projectIndex >= 0 ? process.argv[projectIndex + 1] : null
  if (projectIndex >= 0 && !requestedProject) throw new Error('--project requires a folder')
  const fixture = testDir ? writeSmokeProject(testDir) : null
  let pickedRoot = fixture || (requestedProject ? resolve(requestedProject) : null)
  const root = resolve(__dirname, '../..')
  let host: NativeBridge | undefined
  /** The host's pid from its ready event, for the feedback diagnostics' `sample`. */
  let hostPid: number | null = null
  let runtime: ProjectRuntime | undefined
  let cleaning: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    if (cleaning) return cleaning
    // Publish the promise before emitting quit: the host can close during cleanup.
    cleaning = Promise.resolve().then(async () => {
      app.emit('before-quit')
      // Chats are saved by the conversation owner; bounded, and a chat cut short keeps
      // its checkpoint for the next launch.
      await Promise.race([
        conversationsClosed().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000).unref?.())
      ])
      // The service-mode host exits with this status; the launcher reports it.
      host?.send('quit', { status: typeof process.exitCode === 'number' ? process.exitCode : 0 })
      // Keep the native profile separate from retired Electron installations.
      // Test profiles are disposable.
      // The service stops its groups (and again if Bun dies first).
      await runtime?.stopAll().catch(() => {})
      if (testDir) {
        await host?.closed
        removeSmokeDirectory(testDir)
      }
    })
    return cleaning
  }
  installShutdown(cleanup)
  host = new NativeBridge()
  setBridge(host)
  // Hold host events while the preference snapshot is awaited; released below,
  // once every handler (including 'ready' and 'closed') is registered.
  host.hold()
  const mainView = new NativeView('main')
  // The Swift service owns every domain; there is no local fallback write, ever.
  const preferences = await servicePreferences(host).catch((error) => {
    throw new Error(`Trezi could not read preferences from its service: ${error.message}`)
  })
  setClaudeUserPluginsSource(() => preferences.get(CLAUDE_USER_PLUGINS_KEY))
  setAgentFileAccessSource(() => preferences.get(AGENT_FILE_ACCESS_KEY))
  setAgentGitAccessSource(() => preferences.get(AGENT_GIT_ACCESS_KEY))
  const workspace = await serviceWorkspace(host).catch((error) => {
    throw new Error(`Trezi could not read the workspace from its service: ${error.message}`)
  })
  // Project memory (S05): read on demand, so there is no startup snapshot to await.
  const memory = serviceProjectMemory(host)
  setProjectMemoryOwner(() => memory)
  // Managed project runtimes (S06): the service runs servers, installs and static sites.
  const runtimeOwner = serviceRuntime(host)
  runtime = runtimeOwner
  setDependencyInstaller((root) => runtimeOwner.install(root))
  // Repository coordination (S07): every Trezi Git effect and repository lease goes
  // through the service's per-repository lane, journal and recovery refs.
  const repository: RepositoryOwner = serviceRepository(host)
  setRepositoryOwner(repository)
  const leases = { leases: () => repository.heldLeases() }
  // Source transactions (S08/S09): parsers propose, the service commits hash-bound
  // transactions in the repository's lane (inside the leases this chain holds) and
  // owns Undo, file operations and saved drafts.
  const source: SourceOwner = serviceSource(host, leases)
  setSourceOwner(source)
  // Conversation state (S11): the service owns chat records and History, live-chat
  // checkpoints, turn transitions, titles, model handoff, approvals and spawn admission.
  const conversation: ConversationOwner = serviceConversation(host)
  setConversationOwner(conversation)
  // Provider sessions (S10): the service holds each session's grant, answers its
  // permission requests and tool calls, owns Stop's deadline and persists resume ids,
  // and supervises the provider helpers every built-in adapter runs in (LKM-111).
  // It also writes the provider data: connections and their keys, the model catalog.
  const provider = serviceProvider(host)
  setProviderOwner(provider)
  setProviderDataOwner(provider.data)
  // Editing workflows (S12): island history and activation, the controls sidecars
  // (hash-bound, in the repository lane) and deferred navigation.
  setEditingOwner(serviceEditing(host, leases))
  // Side-effecting workflows (S13): publication, remote Git actions, project setup,
  // Trezi's update and the diagnosis memory, journaled with receipts in the service.
  setWorkflowOwner(serviceWorkflows(host, leases))
  // Platform services (S14): the Simulator preview and its Metro group, scoped media
  // grants for the source editor, pasted attachments and the running-servers recovery.
  const platform: PlatformOwner = servicePlatform(host)
  setPlatformOwner(platform)
  const refreshPreferences = () => {
    const values = preferences.snapshot()
    let preferred: unknown
    try {
      preferred = JSON.parse(values['trezi:preferred-model'] ?? 'null')
    } catch {}
    workspaceController.preferred = resolvePreferredSettings(parsePreferredModelState(preferred))
    for (const chat of chatController.chats.values())
      if (chat.context)
        chat.context.turn = {
          ...chat.context.turn,
          projectUi: values['trezi:project-ui:v1'] === 'true',
          projectUiEngine: values['trezi:project-ui-engine:v1'] === 'jev' ? 'jev' : 'agent'
        }
    host!.send('preferences', { values })
    host!.send('layoutWidth', { width: Number(values['trezi:native-chat-width']) || 440 })
  }
  const previewView = new NativeView('preview')
  const window = mainView
  const send = (channel: string, ...args: unknown[]) => mainView.webContents.send(channel, ...args)
  const state: PreviewState = {
    url: null,
    retries: 0,
    bounds: { x: 0, y: 0, width: 0, height: 0, radius: 0 },
    selectMode: false,
    commentMode: null,
    frameMode: false,
    layersWatch: false,
    statusText: null,
    pins: []
  }
  registerPreviewIpc({
    state,
    ensurePreviewView: () => previewView,
    getPreviewView: () => previewView,
    getMainWindow: () => window,
    sendToMain: send,
    placeholderUrl: 'about:blank',
    isLocalPreviewUrl: (raw) => {
      try {
        const u = new URL(raw)
        return (
          ['http:', 'https:'].includes(u.protocol) &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
        )
      } catch {
        return false
      }
    }
  })
  registerDevServerIpc(() => window, ipcMain, runtimeOwner)
  registerAgentIpc(() => window)
  // LKM-136: old-name worktree folders once, then idle chat checkouts every hour.
  const sweepWorkspaces = () => {
    const idle = idlePeriod(preferences.get(CHAT_WORKSPACE_IDLE_KEY))
    if (idle !== null) void sweepIdleWorkspaces(idle)
  }
  setTimeout(() => void cleanLegacyWorkspaces().finally(sweepWorkspaces), 60_000).unref?.()
  setInterval(sweepWorkspaces, 60 * 60_000).unref?.()
  registerPropsIpc()
  registerStylesIpc()
  registerControlsIpc()
  registerAnnotationsIpc()
  registerGithubIpc()
  registerTokensIpc()
  registerSetupIpc()
  registerDiagnoseIpc()
  registerSimulatorIpc(() => window)
  registerFeedbackIpc(
    () => window,
    () => (host ? { pid: hostPid, ping: () => host!.request('webViews', {}, 2000) } : null)
  )
  registerGitRemoteIpc(ipcMain, projectHasRunningAgents)
  ipcMain.handle('project:pick', () => {
    if (pickedRoot) {
      const first = pickedRoot
      if (!testing) pickedRoot = null
      return first
    }
    return host!.request('pick', {}, 0x7fffffff)
  })
  ipcMain.handle('project:pick-new', () => host!.request('pickNew', {}, 0x7fffffff))
  ipcMain.handle('project:create', (_e, path, options) => createProject(path, options))
  ipcMain.handle('project:icon', (_e, path) => readProjectIcon(path))
  ipcMain.handle('git:ensure', (_e, path) => ensureBranch(path))
  ipcMain.handle('git:set', (_e, path, name) => switchBranch(path, name))
  ipcMain.handle('git:list', (_e, path) => listBranches(path))
  ipcMain.handle('git:checkout', (_e, path, name) => checkoutBranch(path, name))
  ipcMain.handle('source:tree', (_e, path) => listProjectFiles(path))
  ipcMain.handle('source:create-file', (_e, path, file) => createProjectFile(path, file))
  ipcMain.handle('source:rename-file', (_e, path, from, to) => renameProjectFile(path, from, to))
  ipcMain.handle('source:delete-file', (_e, path, file) => deleteProjectFile(path, file))
  ipcMain.handle('window:is-fullscreen', () => host!.request('fullscreen'))
  ipcMain.on('menu:native-edit', (_e, action) => host!.send('nativeEdit', { action }))
  ipcMain.on('menu:set-recents', (_e, recents) => host!.send('recents', { recents }))
  host.on('ipc', async ({ view, message }) => {
    const trace =
      view === 'preview' && message.channel === channels.PREVIEW_PICKED ? message.trace : undefined
    if (trace) trace.bunAt = Date.now()
    try {
      const value = await dispatchIPC(view, message)
      if (view === 'preview') notePreviewMessage(message.channel)
      if (trace) {
        trace.bunDoneAt = Date.now()
        host!.send('deliver', {
          view,
          message: { type: 'event', channel: channels.PREVIEW_TIMING_ACK, args: [trace] }
        })
      }
      if (message.type === 'invoke')
        host!.send('deliver', {
          view,
          message: {
            type: 'reply',
            id: message.id,
            document: message.document,
            value: value ?? null
          }
        })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (view === 'preview') notePreviewMessage(message?.channel, true)
      if (message?.type === 'invoke')
        host!.send('deliver', {
          view,
          message: { type: 'reply', id: message.id, document: message.document, error: text }
        })
      else console.error(`Native ${view} IPC rejected: ${text}`)
    }
  })

  let shellController: NativeShellController | undefined
  const renderShell = () => shellController?.render()
  // LKM-152: the window opens by itself only as Settings → Show Activity automatically allows.
  const activityController = new NativeActivityController(
    (method, data) => host!.send(method, data),
    (text) => displayText(text),
    () => activityAutoOpen(preferences.get(ACTIVITY_AUTO_OPEN_KEY))
  )
  host.on('activity-action', ({ action }) => activityController.action(action))
  host.on('menu', ({ action }) => {
    if (action === 'logs') activityController.action('toggle')
    else if (action === 'activity') activityController.action('show')
  })
  serviceEvents.on('event', (channel, line) => {
    if (channel === 'devserver:log' || channel === 'simulator:log')
      activityController.append(line, 'server')
  })
  // Startup recovery reports are gray notices that never open the window (`activity-startup.ts`).
  void repository.status().then(
    (status) => reportRepositoryRecovery(activityController, status),
    () => {}
  )
  void conversation.status().then(
    ({ recovered }) => reportConversationRecovery(activityController, recovered),
    () => {}
  )
  void source.status().then(
    (status) => reportSourceRecovery(activityController, status),
    () => {}
  )
  const reportPreferences = (error: unknown) =>
    activityController.append(
      `Could not save a preference: ${error instanceof Error ? error.message : String(error)}`,
      'error'
    )
  host.on('native-layout-width', ({ width }) => {
    if (!Number.isFinite(width) || width < 320 || width > 760) return
    void preferences.set('trezi:native-chat-width', String(width)).catch(reportPreferences)
  })
  host.on('native-layout-sizes', (sizes) => {
    // `layers` was the docked panel's height; it is now the Layers island's (LKM-179),
    // with its width and, once dragged, its offset from the preview's nearest corner
    // (LKM-180: `layersCorner`, absent for top-right). A dragged editing island keeps
    // `inspectorX` from its side (`inspectorCorner`).
    const finite = (key: string) => Number.isFinite(sizes[key])
    const corner = (key: string) => (finite(key) ? { [key]: sizes[key] } : {})
    if (['source', 'layers', 'layersWidth', 'inspector'].every(finite))
      void preferences
        .set(
          'trezi:native-panel-sizes',
          JSON.stringify({
            source: sizes.source,
            layers: sizes.layers,
            layersWidth: sizes.layersWidth,
            inspector: sizes.inspector,
            ...(finite('layersX') && finite('layersY')
              ? { layersX: sizes.layersX, layersY: sizes.layersY, ...corner('layersCorner') }
              : {}),
            ...(finite('inspectorX')
              ? { inspectorX: sizes.inspectorX, ...corner('inspectorCorner') }
              : {})
          })
        )
        .catch(reportPreferences)
  })
  host.on('native-layout-frame', ({ frame }) => {
    void dispatchIPC('main', { type: 'send', channel: 'preview:set-bounds', args: [frame] })
  })
  // LKM-173: viewport rects native views cover; the preview shields them. Re-sent on load.
  let previewCover: unknown[] = []
  host.on('native-cover', ({ rects }) => {
    previewCover = Array.isArray(rects) ? rects : []
    previewView.webContents.send(channels.PREVIEW_COVERED, previewCover)
  })
  const chatController = installNativeChat(
    host!,
    mainView,
    networkVolumeNote(preferences, reportPreferences),
    !testing
  )
  // LKM-151: a compile/parse error in a file the last turn touched gets Trezi's own recovery card.
  runtimeOwner.onLog((root, line) => chatController.devServerLog(root, line))
  const workspaceController = installNativeWorkspace(
    host!,
    mainView,
    workspace,
    chatController,
    preferences
  )
  // A failed open has no automatic recovery: only Retry or a fix by the user (LKM-152).
  workspaceController.openFailed = (name, message) =>
    activityController.append(`Could not open ${name}: ${message}`, 'needs-action', {
      event: 'project-open-failed'
    })
  const contextController = new NativeContextController(
    workspaceController,
    chatController,
    () => ({
      projectUi: preferences.get('trezi:project-ui:v1') === 'true',
      projectUiEngine: preferences.get('trezi:project-ui-engine:v1') === 'jev' ? 'jev' : 'agent'
    }),
    (channel, ...args) => dispatchIPC('main', { type: 'send', channel, args })
  )
  // LKM-153: a `[trezi-source]` warning is the reason a verified setup found no stamps.
  runtimeOwner.onLog((root, line) => contextController.devServerLog(root, line))
  // LKM-157: a connected project whose restarted preview stays unstamped is offered Reconnect.
  workspaceController.restarted = (root) => contextController.restarted(root)
  const visualEdit = async (root: string, prompt: string) => {
    const entry = workspaceController.state.projects.find((p) => p.root === root)
    if (!entry || !prompt.trim()) return
    const chat = chatController.chats.get(entry.activeSessionKey)
    const result = await workspaceController.services
      .invoke(
        'agent:spawn-comment',
        root,
        prompt,
        entry.activeSessionKey,
        chat ? agentOptionsFor(chat.settings) : {},
        'text-edit'
      )
      .catch(() => null)
    if (!result?.ok) {
      await chatController.command({ type: 'seed', chat: entry.activeSessionKey, text: prompt })
      activityController.append(
        'Could not start the visual edit in the background; the instruction is in the composer.',
        'error'
      )
    }
  }
  const layersController = new NativeLayersController(
    workspaceController.services.invoke,
    (channel, ...args) => dispatchIPC('main', { type: 'send', channel, args }),
    (state) => host!.send('layersState', { state }),
    visualEdit
  )
  host.on('layers-action', (action) => {
    void layersController
      .action(action)
      .catch((error) => activityController.append(String(error), 'error'))
  })
  host.on('shell-action', (action) => {
    if (action.action === 'layers') void layersController.toggle()
  })
  serviceEvents.on('event', (channel, value) => {
    if (channel === 'layers:changed' || channel === 'preview:url-changed')
      void layersController.refresh()
    if (channel === 'layers:move-request')
      void layersController
        .move(value)
        .catch((error) => activityController.append(String(error), 'error'))
  })
  // A media document is shown by path: the platform owner's
  // grant for the source editor (re-issued when it expired or the file changed). Only
  // the newest state is delivered when a resolution is outstanding.
  let sourceStates = 0
  // Grammar highlighting (LKM-183): results follow the state they were computed for.
  const syntax = new SyntaxController(
    (message) => host!.send('sourceHighlight', message),
    undefined,
    (message) => productLog.warn('editor', message)
  )
  const editorController = new NativeEditorController(
    workspaceController.services.invoke,
    (state) => {
      const media = state.document?.media,
        sequence = ++sourceStates
      const deliver = (mediaPath?: string) => {
        if (sequence !== sourceStates) return
        host!.send('sourceState', { state: { ...state, mediaPath } })
        syntax.document(
          state.root,
          state.source,
          state.text,
          state.revision,
          state.visible && !!state.document && !state.document.binary && !media
        )
      }
      if (!media) deliver()
      else
        void platform
          .mediaPath(media.url, state.root, join(state.root, state.document!.file))
          .then(deliver, () => deliver())
      if (shellController && workspaceController.active?.root === state.root) {
        shellController.codeOpen = state.visible
        shellController.schedule()
      }
    },
    preferences
  )
  const openSource = (source?: string, popped?: boolean) => {
    const root = workspaceController.active?.root
    if (root) void editorController.open(root, source, popped)
  }
  const editorAction = (action: any) => {
    if (!workspaceController.state.projects.some((p) => p.root === action.root)) return
    if (action.action === 'highlight') syntax.report(action.root, action)
    else void editorController.action(action)
  }
  host.on('source-action', editorAction)
  ipcMain.handle('source:popout', (_event, root, source) =>
    editorController.open(root, source, true)
  )
  ipcMain.handle('source:close-window', () => {
    const root = workspaceController.active?.root
    if (root) return editorController.action({ root, action: 'hide' })
  })
  host.on('shell-action', (action) => {
    if (action.action !== 'code') return
    const root = workspaceController.active?.root
    if (!root) return
    if (editorController.session(root).state.visible) editorAction({ root, action: 'hide' })
    else openSource(contextController.projects.get(root)?.selection?.bubble.source ?? undefined)
  })
  serviceEvents.on('event', (channel, value) => {
    if (channel === 'source:reveal' && value.root === workspaceController.active?.root)
      openSource(`${value.source}:${value.startLine}`)
  })
  // LKM-185: chat changes an older publish left on another branch, once per project.
  const strandedNotice = strandedLandingsNotice({
    sheets: {
      toast: (message, actions, seconds) => sheetController.toast(message, actions, seconds)
    },
    owner: () => repository,
    preferences,
    log: (text, kind) => activityController.append(text, kind),
    restored: async (root, files) => {
      await gitController.refresh(root)
      const entry = workspaceController.state.projects.find((p) => p.root === root)
      if (entry && files.length) await workspaceController.refreshEnvironment(entry.key, files)
    }
  })
  workspaceController.services.activate = async (entry) => {
    void strandedNotice(entry?.root).catch((error) =>
      activityController.append(String(error), 'error')
    )
    host!.send('sourceActive', { root: entry?.root ?? '' })
    void layersController.activate(entry?.root ?? '')
    if (shellController) {
      shellController.codeOpen = entry ? editorController.session(entry.root).state.visible : false
      shellController.schedule()
    }
    await contextController.activate(entry)
  }
  const projectEffect = chatController.services.effect
  chatController.services.effect = (effect) => {
    void contextController.effect(effect).catch((error) => workspaceController.reportError(error))
    if (effect.type === 'layers') void layersController.toggle()
    else if (effect.type === 'source') openSource(effect.source)
    else projectEffect(effect)
  }
  serviceEvents.on('event', (channel, value) => {
    if (channel === 'preview:element-picked') contextController.selection(value)
    else if (channel === 'preview:readiness') contextController.readiness(value)
    else if (channel === 'agent:event') {
      // LKM-193: a background agent waiting for an answer is the attention-worthy event.
      const attention = agentAttention(value)
      if (attention)
        activityController.append(attention, 'needs-action', { event: 'background-question' })
      const files =
        value.type === 'isolation' && value.state === 'merged'
          ? value.files
          : value.type === 'spawn-finished' && value.outcome === 'applied'
            ? value.files
            : undefined
      const entry = workspaceController.state.projects.find(
        (p) => p.key === value.projectKey || p.sessionKeys.includes(value.projectKey)
      )
      if (files && entry && (environmentChanges(files).restart || !entry.url))
        void workspaceController
          .refreshEnvironment(entry.key, files)
          .catch((error) => activityController.append(String(error), 'error'))
    }
  })
  serviceEvents.on('command', (channel, args, result) => {
    if (channel === 'agent:spawn-comment' && result?.ok)
      // The whole request: the card collapses it at a word and expands on click (LKM-193).
      contextController.queued(args[2], result.spawnId, String(args[1]), !!result.queued)
    if (channel === 'annotations:add' || channel === 'annotations:remove')
      void contextController.notes(args[0]).catch((error) => workspaceController.reportError(error))
    if (channel === 'agent:close-project') contextController.projects.delete(args[0])
  })
  const { inspector: inspectorController } = installNativeInspector(
    host!,
    workspaceController,
    chatController,
    contextController,
    visualEdit,
    openSource,
    (error) => activityController.append(String(error), 'error')
  )
  // LKM-179: the Layers tree selects and reveals whatever the preview has selected.
  inspectorController.onElement = (element) => layersController.selected(element)
  const sheetController = new NativeSheetController(host!, workspaceController, chatController)
  const gitController = new NativeGitController(
    sheetController,
    activityController,
    preferences,
    renderShell,
    (url) => shell.openExternal(url),
    chatController
  )
  shellController = new NativeShellController(
    workspaceController,
    chatController,
    gitController,
    preferences,
    (state) => host!.send('shellState', { state }),
    ({ viewport }) => {
      previewView.webContents.send(channels.PREVIEW_HIDE_SCROLLBARS, viewport === 'mobile')
    }
  )
  installPreviewLoads(host, workspaceController, shellController)
  installPreviewRefresh(host, workspaceController, (error) =>
    activityController.append(String(error), 'error')
  )
  const renderWorkspace = workspaceController.services.render
  workspaceController.services.render = (state) => {
    renderWorkspace(state)
    shellController!.schedule()
    host!.send('recents', { recents: state.recents })
  }
  installLogSupport(
    host,
    (text, kind) => activityController.append(text, kind),
    () => workspaceController.active?.root ?? null
  )
  host.on('menu', ({ action }) => {
    const root = workspaceController.active?.root
    if (action === 'toggle-chat') void shellController!.action({ action: 'expand' })
    else if (action === 'reload' && workspaceController.active?.url)
      host!.send('reload', { view: 'preview' })
    else if (['undo', 'redo'].includes(action) && root)
      void workspaceController.services
        .invoke(`edit:${action}`, root)
        .then((result) => {
          if (result.conflict)
            activityController.append(
              'The file changed on disk; undo/redo refused to overwrite it.',
              'error'
            )
          void inspectorController.refresh()
        })
        .catch((error) => activityController.append(String(error), 'error'))
  })
  const renderChatEffect = chatController.services.effect
  chatController.services.effect = (effect) => {
    renderChatEffect(effect)
    if (effect.type === 'mirror') shellController!.schedule()
  }
  host.on('shell-action', (action) => {
    if (['expand', 'device', 'select-object', 'address', 'home'].includes(action.action))
      void shellController!
        .action(action)
        .catch((error) => activityController.append(String(error), 'error'))
  })
  serviceEvents.on('event', (channel, value) => {
    if (channel === 'preview:url-changed') {
      shellController!.location = value
      shellController!.schedule()
    }
    if (channel === 'preview:toggle-select')
      void shellController!
        .action({ action: 'select-object' })
        .catch((error) => activityController.append(String(error), 'error'))
    if (channel === 'preview:select-cancelled') {
      shellController!.selecting = false
      shellController!.schedule()
    }
  })
  serviceEvents.on('command', (channel, args) => {
    if (channel === 'preview:set-select-mode') {
      shellController!.selecting = !!args[0]
      shellController!.schedule()
    }
  })
  const activateContext = workspaceController.services.activate
  const legacyNames = new NativeLegacyNames(
    sheetController,
    (channel, ...args) => workspaceController.services.invoke(channel, ...args),
    (text, kind) => activityController.append(text, kind)
  )
  const recoveryRefs = new NativeRecoveryRefs(
    sheetController,
    repository,
    () => workspaceController.state.projects.map((p) => p.root),
    (text, kind) => activityController.append(text, kind)
  )
  host.on('activity-action', ({ action }) => {
    if (action === 'recovery')
      void recoveryRefs
        .open()
        .catch((error) =>
          activityController.append(
            `Could not list recovery refs: ${error instanceof Error ? error.message : String(error)}`,
            'error'
          )
        )
  })
  workspaceController.services.activate = async (entry) => {
    await activateContext(entry)
    if (!entry) return
    void gitController
      .refresh(entry.root)
      .catch((error) => activityController.append(String(error), 'error'))
    void legacyNames
      .check(entry.key, entry.root)
      .catch((error) => activityController.append(String(error), 'error'))
  }
  host.on('shell-action', (action) => {
    const key = action.project ?? workspaceController.state.activeKey
    if (action.action === 'publish-mode') {
      void gitController.setMode(action.value).then(refreshPreferences, reportPreferences)
      return
    }
    if (!key) return
    const operation =
      action.action === 'branch'
        ? gitController.branch(key, action.value ?? '')
        : action.action === 'new-branch'
          ? gitController.branch(key, action.value ?? '', true)
          : action.action === 'publish'
            ? gitController.publish(key)
            : action.action === 'publish-cancel'
              ? gitController.cancel(key)
              : action.action === 'git-updates'
                ? gitController.updates(key)
                : null
    void operation?.catch((error) => activityController.append(String(error), 'error'))
  })
  // The service drains before it relaunches Trezi (with the active project).
  const updates = new NativeUpdateController(
    sheetController,
    root,
    () => {
      host!.send('serviceRestart', { project: workspaceController.active?.root })
    },
    workflowOwner(),
    () =>
      [...chatController.chats.values()].some(
        (chat) => chat.isRunning || chat.text || chat.attachments.length
      )
        ? 'Finish running chats and send or clear your drafts before restarting.'
        : [...editorController.sessions.values()].some((session) =>
              [...session.documents.values()].some((doc) => doc.text !== doc.baseline)
            )
          ? 'Save source editor drafts before restarting.'
          : null
  )
  host.on('menu', ({ action }) => {
    if (action === 'updates')
      void updates.open().catch((error) => activityController.append(String(error), 'error'))
  })
  host.on('download-error', ({ message }) =>
    activityController.append(`Download failed: ${message}`, 'error')
  )
  host.on('download-finished', () => activityController.append('Download finished.', 'success'))
  const supportSheets = new NativeSupportSheets(
    sheetController,
    () => host!.request('captureFeedback'),
    (url) => shell.openExternal(url)
  )
  const previewRecovery = new NativePreviewRecovery(
    sheetController,
    (root) => platform.findServers(root),
    (server) => platform.stopServer(server)
  )
  host.on('menu', ({ action }) => {
    if (action === 'servers' && workspaceController.state.activeKey)
      previewRecovery.open(workspaceController.state.activeKey)
  })
  const reviewController = new NativeReviewController(sheetController, (url) =>
    shell.openExternal(url)
  )
  const settingsController = withClaudePane(
    new NativeSettingsController(sheetController, preferences, refreshPreferences)
  )
  // An external edit adopted by the service reaches the controllers and the host.
  preferences.subscribe(() => {
    refreshPreferences()
    shellController?.render()
  })
  host.on('sheet-action', (action) => {
    void sheetController.action(action)
  })
  host.on('toast-action', (action) => {
    void sheetController.toastAction(action).catch(console.error)
  })
  const openSheet = (kind: string, key?: string) => {
    if (sheetController.current?.state.busy) return
    if (kind === 'settings')
      void settingsController.open().catch((error) => workspaceController.reportError(error))
    else if (kind === 'feedback')
      void supportSheets
        .feedback()
        .catch((error) => activityController.append(String(error), 'error'))
    else if (kind === 'diagnose' && workspaceController.state.activeKey)
      supportSheets.diagnose(workspaceController.state.activeKey)
    else if (kind === 'review' && key)
      void reviewController.open(key).catch((error) => workspaceController.reportError(error))
    else if (kind === 'new-project') sheetController.newProject()
    else if (kind === 'memory' && key)
      void sheetController.memory(key).catch((error) => workspaceController.reportError(error))
  }
  // LKM-177: every automatic memory update or cleanup shows a note with View and Undo.
  onProjectMemoryUpdated((update) =>
    showProjectMemoryNote(sheetController, update, {
      view: (root) =>
        openSheet(
          'memory',
          workspaceController.state.projects.find((p) => projectKey(p.root) === projectKey(root))
            ?.key
        ),
      undo: undoProjectMemoryUpdate
    })
  )
  host.on('menu', ({ action }) => {
    if (['new-project', 'settings', 'feedback', 'diagnose'].includes(action)) openSheet(action)
  })
  host.on('shell-action', (action) => {
    if (action.action === 'rename-chat' && action.id && workspaceController.state.activeKey)
      sheetController.renameChat(action.id, workspaceController.state.activeKey)
    if (action.action === 'select' && action.id?.startsWith('history:'))
      openSheet('review', action.id.slice(8))
    if (action.action === 'memory')
      openSheet('memory', action.project ?? workspaceController.state.activeKey ?? undefined)
  })
  // After the last automatic restart the crash loop needs the user.
  const previewSupervisor = new NativePreviewSupervisor(workspaceController, undefined, (reason) =>
    activityController.append(
      `The dev server kept stopping and Trezi gave up restarting it: ${reason}`,
      'needs-action',
      { event: 'devserver-crash-loop' }
    )
  )
  serviceEvents.on('event', (channel, value) => {
    if (channel !== 'devserver:exit') return
    activityController.append(value.reason, 'error')
    previewSupervisor.exited(value)
  })
  host.on('native-preview-action', (action) => {
    if (workspaceController.state.activeKey !== action.project) return
    if (action.action === 'logs') activityController.action('show')
    else if (action.action === 'servers') previewRecovery.open(action.project)
    else if (action.action === 'diagnose') openSheet('diagnose')
    else if (action.action === 'run') {
      previewSupervisor.reset()
      void workspaceController
        .command({
          type: 'restart',
          key: action.project,
          ...(action.command?.trim() ? { command: action.command.trim() } : {})
        })
        .catch((error) => activityController.append(String(error), 'error'))
    }
  })

  host.on('view-closed', ({ view }) => {
    const v = views.get(view)
    if (v) v.destroyed = true
    views.delete(view)
  })
  host.on('url', ({ view, url }) => {
    const current = views.get(view)
    if (current) current.url = url
    if (view === 'preview' && /^https?:/.test(url)) send('preview:url-changed', url)
  })
  host.on('fullscreen', ({ value }) => send('window:fullscreen', value))
  host.on('external', ({ url }) => {
    void shell.openExternal(url).catch(console.error)
  })
  host.on('load-error', (message) => {
    activityController.append(message.message, 'error')
    if (message.view === 'preview' && workspaceController.active) {
      workspaceController.state.status = loadErrorStatus(message)
      workspaceController.changed()
    }
  })
  host.on('loaded', ({ view, url }) => {
    const current = views.get(view)
    if (current) current.url = url
    if (view !== 'preview') return
    previewView.webContents.send(channels.PREVIEW_SET_MODE, state.selectMode)
    previewView.webContents.send(channels.PREVIEW_SET_COMMENT_MODE, state.commentMode)
    previewView.webContents.send(channels.PREVIEW_SET_FRAME, state.frameMode)
    previewView.webContents.send(
      channels.PREVIEW_HIDE_SCROLLBARS,
      workspaceController.active?.viewport === 'mobile'
    )
    previewView.webContents.send(channels.PREVIEW_SET_PINS, state.pins)
    previewView.webContents.send(channels.PREVIEW_SET_STATUS, state.statusText)
    previewView.webContents.send(channels.LAYERS_SET_WATCH, state.layersWatch)
    previewView.webContents.send(channels.PREVIEW_COVERED, previewCover)
    if (url !== 'about:blank') send('preview:url-changed', url)
  })
  host.on('closed', async () => {
    if (cleaning) return
    if (testing) {
      console.error('Native host closed before the smoke suite completed')
      process.exitCode = 1
    }
    await cleanup()
    if (!testing) process.exit(0)
  })
  host.on('host-error', async (error) => {
    console.error(error)
    await cleanup()
    process.exit(1)
  })
  // Folders LaunchServices hands the host (`open -a Trezi <folder>`, `trezi <folder>`,
  // a folder dropped on the Dock icon): opened once the workspace is attached.
  let attached = false
  const openRequests: string[] = []
  const openRequested = (root: string) =>
    workspaceController.command({ type: 'open', root }).catch((error) =>
      activityController.append(`Could not open ${root}: ${String(error)}`, 'needs-action', {
        event: 'project-open-failed'
      })
    )
  host.on('open-project', ({ root }) => {
    if (typeof root !== 'string' || !isAbsolute(root) || testing) return
    if (attached) void openRequested(root)
    else openRequests.push(root)
  })
  host.once('ready', async (message?: { pid?: unknown }) => {
    if (typeof message?.pid === 'number') hostPid = message.pid
    host!.send('preferences', { values: preferences.snapshot() })
    host!.send('layoutWidth', { width: Number(preferences.get('trezi:native-chat-width')) || 440 })
    try {
      host!.send('layoutSizes', {
        sizes: JSON.parse(preferences.get('trezi:native-panel-sizes') ?? '{}')
      })
    } catch {}
    shellController!.render()
    let preferred: unknown
    try {
      preferred = JSON.parse(preferences.get('trezi:preferred-model') ?? 'null')
    } catch {}
    await workspaceController.command({
      type: 'attach',
      preferred: resolvePreferredSettings(parsePreferredModelState(preferred))
    })
    await chatController.command({ type: 'attach' })
    if (requestedProject && !testing)
      await workspaceController.command({ type: 'open', root: resolve(requestedProject) })
    attached = true
    for (const root of openRequests.splice(0)) await openRequested(root)
    console.log('Trezi is running on Bun + system WebKit. ')
    if (testing) {
      try {
        await runNativeCoreSmoke(
          host!,
          fixture!,
          root,
          (key) => preferences.get(key),
          contextController,
          inspectorController,
          gitController
        )
        process.exitCode = 0
        writeSmokeResult(testDir!, { exitCode: 0, lines: [] })
        await cleanup()
      } catch (error) {
        process.exitCode = 1
        console.error(error)
        let artifact: string | undefined
        try {
          saveSmokeFailure(root, await host!.request('captureShell'))
          artifact = join(root, 'test/artifacts/native/failure.png')
          console.error('Native chat state:', await host!.request('chatInspect'))
          console.error('Native geometry:', await host!.request('layoutInspect'))
        } catch {
          /* preserve original failure */
        }
        // A failure outside any named check (setup, selection) still ends in one fixed line.
        const result =
          error instanceof SmokeRunFailure
            ? { exitCode: error.exitCode, lines: error.lines }
            : {
                exitCode: SMOKE_EXIT_PRODUCT,
                lines: [
                  formatFailureLine({
                    group: 'run',
                    check: 'setup',
                    ...describeFailure(error),
                    artifact
                  })
                ]
              }
        if (!(error instanceof SmokeRunFailure)) console.error(result.lines.join('\n'))
        try {
          writeSmokeResult(testDir!, result)
        } catch {
          /* the launcher then reports the host exit itself */
        }
        await cleanup()
        // The host and service exit 1 for any failure; the launcher maps the result's 3.
        process.exitCode = 1
      } finally {
        setTimeout(() => process.exit(process.exitCode || 0), 1000)
      }
    }
  })
  host.release()
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})

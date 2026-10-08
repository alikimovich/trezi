import { productLog } from '../main/product-log'
import type { WorkspaceSnapshot } from '../shared/api'
import {
  agentOptionsFor,
  chatAgentSettingsFromOptions,
  defaultChatAgentSettings,
  resumeChatSettings
} from '../shared/chat-settings'
import { environmentChanges } from '../shared/environment-changes'
import type { NativeWorkspaceCommand, NativeWorkspaceSnapshot } from '../shared/native-workspace'
import { projectKey } from '../shared/projectKey'
import type { ProjectEntry } from '../shared/workspace'
import type { WorkspaceStore } from './workspace'
import {
  MAX_PATCHES,
  METADATA_FIELDS,
  projectName,
  type WorkspaceEntryRecord,
  type WorkspacePatch
} from './workspace-model'

export interface WorkspaceServices {
  invoke(channel: string, ...args: any[]): Promise<any>
  /** The workspace owner: the Swift service. */
  store: WorkspaceStore
  render(state: NativeWorkspaceSnapshot): void
  activate(entry: ProjectEntry | null): Promise<void>
  closeChat(key: string): void
  reusableChat(key: string): boolean
  /** Put keyboard focus in the active chat's composer (after New chat). */
  focusComposer?(): void
}
/** A working entry from a stored record. Gaps in old records get the defaults the
 *  pre-S04 controller created entries with; unknown fields are carried along. */
function entryFrom(record: WorkspaceEntryRecord): ProjectEntry {
  const entry = structuredClone(record) as Record<string, any>
  const key = record.key
  if (typeof entry.name !== 'string') entry.name = projectName(record.root)
  if (!(entry.url === null || typeof entry.url === 'string')) entry.url = null
  if (entry.previewKind !== 'web' && entry.previewKind !== 'simulator') entry.previewKind = 'web'
  if (!(entry.branch === null || typeof entry.branch === 'string')) entry.branch = null
  if (!(entry.launchSpec === null || METADATA_FIELDS.launchSpec(entry.launchSpec)))
    entry.launchSpec = null
  if (typeof entry.touchedAt !== 'number') entry.touchedAt = 0
  if (!METADATA_FIELDS.sessionKeys(entry.sessionKeys)) entry.sessionKeys = [key]
  if (!entry.sessionKeys.includes(entry.activeSessionKey))
    entry.activeSessionKey = entry.sessionKeys[0]
  return entry as ProjectEntry
}
const metadataOf = (record: object) =>
  new Map(
    Object.keys(METADATA_FIELDS)
      .filter((name) => (record as any)[name] !== undefined)
      .map((name) => [name, JSON.stringify((record as any)[name])])
  )

/**
 * Owns project/session lifetime. Renderers receive projections, never navigation callbacks.
 *
 * Project identity (root → key), membership, order, the selected project, recents
 * and `touchedAt` belong to the workspace store (S04): they change only through its
 * operations and are read back from its acknowledged snapshot. Each is persisted
 * before anything that depends on it (a session, a server) starts. The rest of an
 * entry is the legacy-owned metadata slice (sessions, servers, Git, display): this
 * controller decides it and `changed()` hands the differences to the store's typed
 * `update` adapter. Status, history and errors are display state and never stored.
 */
export class NativeWorkspaceController {
  state: NativeWorkspaceSnapshot = {
    revision: 0,
    projects: [],
    activeKey: null,
    status: { kind: 'idle' },
    history: {},
    recents: []
  }
  preferred = defaultChatAgentSettings()
  private boot?: Promise<void>
  private intent = 0
  /** The newest project pick (LKM-204): the active project from the click on, until the
   *  store acknowledges this very pick. Generations only grow, so an older pick's
   *  acknowledgement or an external snapshot cannot bring the previous project back. */
  private chosen?: { key: string; generation: number }
  private selections = 0
  private jobs = new Map<string, Promise<void>>()
  private closing = new Set<string>()
  private closes = new Map<string, Promise<void>>()
  /** Per project: the metadata last handed to the store (as JSON), so only changes are sent. */
  private sent = new Map<string, Map<string, string>>()
  constructor(readonly services: WorkspaceServices) {
    // An adopted external edit: take identity/order/selection, re-send our metadata.
    services.store.subscribe(() => {
      this.adopt(true)
      this.changed()
    })
  }
  /** Hears a project open that failed with no automatic recovery (the Activity log). */
  openFailed?: (name: string, message: string) => void
  /** Hears the active project's dev server being restarted (LKM-157 re-checks its stamps). */
  restarted?: (root: string) => void
  /** Hears a switch to another project start, before "Opening …" renders (LKM-172 drops
   *  the element selection, the editing island and the page's selection overlays). */
  switching?: (key: string) => void
  /** Rendered only: a failing store must not be retried by its own error report. */
  reportError(error: unknown) {
    this.state.error = String(error)
    this.publish()
  }
  get active() {
    return this.state.projects.find((p) => p.key === this.state.activeKey) ?? null
  }
  changed() {
    this.persist()
    this.publish()
  }
  private publish() {
    this.state.revision++
    this.services.render(structuredClone(this.state))
  }
  /** Takes the store's acknowledged identity, order, selection, recents and touchedAt.
   *  Existing entries keep Bun's metadata; an external adoption re-baselines it. */
  private adopt(external = false) {
    const view = this.services.store.snapshot()
    const known = new Map(this.state.projects.map((entry) => [entry.key, entry]))
    this.state.projects = view.projects.map((record) => {
      const entry = known.get(record.key)
      if (!entry || external) this.sent.set(record.key, metadataOf(record))
      if (!entry) return entryFrom(record)
      if (typeof record.touchedAt === 'number') entry.touchedAt = record.touchedAt
      return entry
    })
    for (const key of [...this.sent.keys()])
      if (!view.projects.some((record) => record.key === key)) this.sent.delete(key)
    const chosen = this.chosen
    if (
      chosen &&
      (this.closing.has(chosen.key) || !view.projects.some((record) => record.key === chosen.key))
    )
      this.chosen = undefined
    this.state.activeKey = this.chosen?.key ?? view.activeKey
    this.state.recents = view.recents.map(({ root, name, at }) => ({
      root,
      name,
      at: typeof at === 'number' ? at : 0
    }))
  }
  /** Sends changed metadata through the typed adapter; a failure is reported and re-sent with the next change. */
  private persist() {
    const patches: WorkspacePatch[] = []
    for (const entry of this.state.projects) {
      if (this.closing.has(entry.key)) continue
      const sent = this.sent.get(entry.key) ?? new Map<string, string>()
      this.sent.set(entry.key, sent)
      const fields: Record<string, unknown> = {}
      for (const [name, valid] of Object.entries(METADATA_FIELDS)) {
        const raw = (entry as any)[name]
        if (raw === undefined) continue
        const json = JSON.stringify(raw),
          value = JSON.parse(json)
        // Values the store would refuse (e.g. an over-long name) are not persisted.
        if (sent.get(name) === json || !valid(value)) continue
        fields[name] = value
        sent.set(name, json)
      }
      if (Object.keys(fields).length) patches.push({ key: entry.key, fields })
    }
    for (let index = 0; index < patches.length; index += MAX_PATCHES) {
      const batch = patches.slice(index, index + MAX_PATCHES)
      this.services.store.update(batch).catch((error) => {
        for (const patch of batch)
          for (const name of Object.keys(patch.fields)) this.sent.get(patch.key)?.delete(name)
        this.reportError(error)
      })
    }
  }
  async reorderProject(key: string, before: string | null) {
    const projects = this.state.projects
    const from = projects.findIndex((project) => project.key === key)
    if (
      from < 0 ||
      before === key ||
      (before !== null && !projects.some((project) => project.key === before))
    )
      return
    const next = projects.filter((project) => project.key !== key)
    const to = before === null ? next.length : next.findIndex((project) => project.key === before)
    next.splice(to, 0, projects[from])
    if (next.every((project, index) => project === projects[index])) return
    await this.services.store.reorder(key, before)
    this.adopt()
    this.changed()
  }
  private find(key: string) {
    const entry = this.state.projects.find((p) => p.key === key)
    if (!entry || this.closing.has(key)) throw new Error('Project is no longer open')
    return entry
  }
  private settings(entry: ProjectEntry) {
    return entry.chatSettings?.[entry.activeSessionKey] ?? this.preferred
  }
  private async serialize(key: string, work: () => Promise<void>) {
    const prior = this.jobs.get(key)
    const job = (prior ?? Promise.resolve()).catch(() => {}).then(work)
    this.jobs.set(key, job)
    try {
      await job
    } finally {
      if (this.jobs.get(key) === job) this.jobs.delete(key)
    }
  }
  async transact(key: string, work: (entry: ProjectEntry) => Promise<void>) {
    await this.serialize(key, async () => {
      const entry = this.find(key)
      await work(entry)
    })
  }
  /** `installed`: the dependencies already changed on disk (an install ran), so the
   *  restart only cleans the caches (LKM-197). */
  async refreshEnvironment(key: string, files?: string[], installed = false) {
    const entry = this.state.projects.find((p) => p.key === key)
    if (!entry) return
    const changes = files ? environmentChanges(files) : { restart: true, install: !installed }
    entry.environmentRevision = (entry.environmentRevision ?? 0) + 1
    entry.dependenciesPending = entry.dependenciesPending || changes.install
    this.changed()
    const clean = changes.install || installed
    if (this.active?.key === key)
      await this.command({ type: 'restart', key, ...(clean ? { cleanCache: 'dependencies' } : {}) })
  }
  async command(command: NativeWorkspaceCommand) {
    if (command.type === 'attach') {
      if (command.preferred) this.preferred = command.preferred
      // A reattaching UI gets the current projection; restore runs once.
      this.boot ??= this.restore()
      await this.boot
      this.services.render(structuredClone(this.state))
      return
    }
    if (command.type === 'open') {
      const root = command.root ?? (await this.services.invoke('project:pick'))
      if (root) await this.open(root, command.command)
      return
    }
    if (command.type === 'select') {
      // Echoed to the host even when the pick is refused, so its highlight follows the state.
      if (command.generation !== undefined) this.state.selection = command.generation
      return this.select(command.key)
    }
    if (command.type === 'close') return this.close(command.key)
    if (command.type === 'restart') {
      const entry = this.find(command.key),
        intent = this.intent
      if (this.active?.key !== entry.key) return
      // A project that never finished opening retries the whole open, so its chat can appear.
      if (
        entry.url &&
        !entry.launchSpec &&
        !command.command &&
        !command.cleanCache &&
        this.state.loadedKey === entry.key
      ) {
        await this.services.invoke('preview:load', entry.url)
        return
      }
      this.restarted?.(entry.root)
      await this.serialize(entry.key, async () => {
        await this.services.invoke(
          entry.previewKind === 'simulator' ? 'simulator:stop' : 'devserver:stop',
          entry.root
        )
      })
      if (this.intent !== intent || this.closing.has(entry.key)) return
      const clean =
        command.cleanCache === 'dependencies'
          ? 'Dependencies changed — restarting preview…'
          : command.cleanCache && 'Restarting ' + entry.name + ' with a clean cache…'
      return this.select(entry.key, command.command, true, clean || undefined)
    }
    const entry = this.find(command.key),
      intent = ++this.intent
    // LKM-182: each step from the New chat action to a focused composer, in ms.
    const started = Date.now(),
      steps: Record<string, number> = {}
    const step = (name: string) => {
      steps[name] = Date.now() - started
    }
    if (command.type === 'close-chat' && entry.sessionKeys.length === 1)
      return this.close(entry.key)
    await this.serialize(entry.key, async () => {
      if (this.closing.has(entry.key)) return
      if (command.type === 'chat') {
        if (!entry.sessionKeys.includes(command.session)) throw new Error('Unknown chat')
        entry.activeSessionKey = command.session
      } else if (command.type === 'new-chat' || command.type === 'resume') {
        const live: WorkspaceSnapshot = await this.services.invoke('agent:workspace-snapshot')
        step('snapshot')
        const sessions = live.projects.find((p) => p.projectKey === entry.key)?.chats ?? []
        const empty =
          command.type === 'new-chat' &&
          sessions.find(
            (c) =>
              !c.isRunning &&
              c.record.transcript.length === 0 &&
              this.services.reusableChat(c.sessionKey)
          )
        let key = empty ? empty.sessionKey : ''
        const settings =
          command.type === 'resume'
            ? resumeChatSettings(this.settings(entry))
            : this.settings(entry)
        if (!key) {
          const result =
            command.type === 'resume'
              ? await this.services.invoke(
                  'agent:resume-session',
                  entry.root,
                  command.record,
                  agentOptionsFor(settings)
                )
              : await this.services.invoke('agent:new-chat', entry.root, agentOptionsFor(settings))
          if (!result.ok || !result.sessionKey)
            throw new Error(result.error || 'Unable to start chat')
          key = result.sessionKey
          step('created')
        }
        if (!entry.sessionKeys.includes(key)) entry.sessionKeys.push(key)
        entry.activeSessionKey = key
        entry.chatSettings = { ...entry.chatSettings, [key]: settings }
      } else if (command.type === 'close-chat') {
        if (!entry.sessionKeys.includes(command.session)) return
        if (entry.sessionKeys.length === 1)
          throw new Error('Close the project to close its last chat')
        const result = await this.services.invoke('agent:close-chat', entry.root, command.session)
        if (!result.ok) throw new Error(result.error || 'Unable to close chat')
        entry.sessionKeys = entry.sessionKeys.filter((key) => key !== command.session)
        delete entry.chatSettings?.[command.session]
        this.services.closeChat(command.session)
        if (entry.activeSessionKey === command.session)
          entry.activeSessionKey = result.activeSessionKey ?? entry.sessionKeys[0]
      }
      if (this.closing.has(entry.key)) return
      this.changed()
      step('listed')
    })
    if (
      this.intent !== intent ||
      this.closing.has(entry.key) ||
      !this.state.projects.includes(entry)
    )
      return
    if (this.state.activeKey === entry.key) {
      await this.services.invoke('agent:set-active', entry.root, entry.activeSessionKey)
      step('active')
      if (this.intent === intent) await this.services.activate(entry)
    } else await this.select(entry.key)
    if (command.type !== 'new-chat' || this.intent !== intent) return
    step('shown')
    this.services.focusComposer?.()
    productLog.info('chat', 'New chat composer ready', {
      chat: entry.activeSessionKey,
      ms: Date.now() - started,
      ...steps
    })
  }
  private async restore() {
    this.adopt()
    // The pre-S04 rule: no stored selection restores the last project.
    const restored = this.state.activeKey ?? this.state.projects.at(-1)?.key ?? null
    const live: WorkspaceSnapshot = await this.services.invoke('agent:workspace-snapshot')
    for (const project of live.projects) {
      let entry = this.state.projects.find((p) => p.key === project.projectKey)
      if (!entry) {
        const { key } = await this.services.store.open(project.root, { ...this.preferred })
        this.adopt()
        // Another path to a stored project: that entry keeps its own sessions.
        if (key !== project.projectKey) continue
        entry = this.state.projects.find((p) => p.key === key)
        if (!entry) continue
      }
      entry.sessionKeys = project.chats.map((c) => c.sessionKey)
      entry.activeSessionKey = project.activeSessionKey ?? entry.sessionKeys[0]
      entry.chatSettings = Object.fromEntries(
        project.chats.map((c) => [c.sessionKey, chatAgentSettingsFromOptions(c.options)])
      )
    }
    this.changed()
    if (restored && this.state.projects.some((p) => p.key === restored)) await this.select(restored)
  }
  async open(root: string, command?: string) {
    if (!root.startsWith('/')) throw new Error('Project requires an absolute path')
    const requested = projectKey(root)
    const prior = this.jobs.get(requested)
    await this.closes.get(requested)?.catch(() => {})
    if (this.closing.has(requested) && prior) await prior.catch(() => {})
    // The identity is persisted before any session or server is started for it.
    const { key } = await this.services.store.open(root, { ...this.preferred })
    this.adopt()
    await this.select(key, command)
  }
  /** `clean` (LKM-197): the busy label of a restart that drops the dependency caches and
   *  reloads the preview past WebKit's, on the route it showed. */
  async select(key: string, command?: string, restart = false, clean?: string) {
    const entry = this.find(key),
      intent = ++this.intent,
      chosen = { key, generation: ++this.selections }
    // The window switches before the store has saved the pick or any server starts: the
    // first state already names this project, showing its own "Opening …" (LKM-204).
    this.chosen = chosen
    this.state.activeKey = key
    this.state.status = { kind: 'busy', label: clean ?? 'Opening ' + entry.name + '…' }
    // Another project hides the chat until it has opened; a restart of this one keeps it.
    if (this.state.loadedKey !== key) {
      this.state.loadedKey = null
      this.switching?.(key)
    }
    this.changed()
    const current = () =>
      this.intent === intent && !this.closing.has(key) && this.state.projects.includes(entry)
    try {
      // The selection is persisted before the project's session or server starts.
      await this.services.store.select(key)
    } catch (error) {
      // An unsaved pick falls back to the stored selection, unless a newer pick replaced it.
      if (this.chosen?.generation === chosen.generation) this.chosen = undefined
      this.adopt()
      if (current()) {
        this.state.status = { kind: 'error', message: String(error) }
        this.state.loadedKey = null
        this.changed()
      }
      return
    }
    if (this.chosen?.generation === chosen.generation) this.chosen = undefined
    this.adopt()
    try {
      await this.serialize(key, async () => {
        if (this.closing.has(key)) return
        const branch = await this.services
          .invoke(entry.branch ? 'git:list' : 'git:ensure', entry.root)
          .catch(() => null)
        if (branch) entry.branch = branch.current ?? branch.branch ?? null
        let live: WorkspaceSnapshot = await this.services.invoke('agent:workspace-snapshot')
        if (!live.projects.some((p) => p.projectKey === key)) {
          await this.services.invoke(
            'agent:open-project',
            entry.root,
            agentOptionsFor(this.settings(entry))
          )
          entry.sessionKeys = [key]
          entry.activeSessionKey = key
          live = await this.services.invoke('agent:workspace-snapshot')
        }
        const project = live.projects.find((p) => p.projectKey === key)
        if (project) {
          entry.sessionKeys = project.chats.map((c) => c.sessionKey)
          if (!entry.sessionKeys.includes(entry.activeSessionKey))
            entry.activeSessionKey = project.activeSessionKey ?? entry.sessionKeys[0]
          entry.chatSettings = Object.fromEntries(
            project.chats.map((c) => [c.sessionKey, chatAgentSettingsFromOptions(c.options)])
          )
        }
        if (this.closing.has(key)) return
        const detected = await this.services.invoke('project:detect', entry.root)
        entry.name = detected.name
        entry.previewKind = command ? 'web' : detected.previewKind
        if (detected.setupRequired && !command) {
          entry.url = null
          entry.launchSpec = null
        } else {
          const spec = {
            root: entry.root,
            command:
              command ??
              (entry.launchSpec?.customCommand ? entry.launchSpec.command : detected.devCommand),
            framework: detected.framework,
            previewKind: entry.previewKind,
            customCommand: !!command || !!entry.launchSpec?.customCommand
          }
          // The simulator is shared; a stale project must never take it from the active one.
          if (entry.previewKind === 'simulator' && !current()) return
          const info =
            entry.previewKind === 'simulator'
              ? null
              : await this.services.invoke('devserver:info', entry.root)
          if ((restart || entry.environmentRevision) && info?.running)
            await this.services.invoke('devserver:stop', entry.root)
          const reuse = !restart && !entry.environmentRevision && !command && info?.running
          // Landed manifest changes install in the live checkout with the server stopped,
          // under their own label, before it starts again (LKM-146).
          if (!reuse && entry.previewKind !== 'simulator' && entry.dependenciesPending) {
            if (current()) {
              this.state.status = { kind: 'busy', label: 'Installing dependencies…' }
              this.changed()
            }
            await this.services.invoke('devserver:install', entry.root)
            entry.dependenciesPending = false
            if (current()) {
              this.state.status = { kind: 'busy', label: clean ?? 'Starting ' + entry.name + '…' }
              this.changed()
            }
          }
          const server = reuse
            ? info.server
            : entry.previewKind === 'simulator'
              ? await this.services.invoke('simulator:start', {
                  root: entry.root,
                  ...(spec.customCommand ? { command: spec.command } : {})
                })
              : await this.services.invoke('devserver:start', {
                  ...spec,
                  ...(clean ? { cleanCache: true } : {})
                })
          entry.url = server.url
          entry.launchSpec = server.attached ? null : spec
          entry.environmentRevision = 0
          entry.dependenciesPending = false
        }
        this.state.history[key] = await this.services.invoke('sessions:list', entry.root)
        await this.services.store.recent(entry.root, entry.name).then(
          () => this.adopt(),
          (error) => this.reportError(error)
        )
      })
      if (!current()) {
        this.changed()
        return
      }
      await this.services.invoke('agent:set-active', entry.root, entry.activeSessionKey)
      if (!current()) return
      await this.services.invoke('preview:set-select-mode', false)
      if (!current()) return
      await this.services.invoke(
        entry.url ? 'preview:load' : 'preview:reset',
        ...(entry.url ? [entry.url, ...(clean ? [{ hard: true, keepPath: true }] : [])] : [])
      )
      if (!current()) return
      this.state.status = entry.url
        ? { kind: 'running', name: entry.name, url: entry.url }
        : { kind: 'setup', name: entry.name }
      this.state.loadedKey = key
      this.changed()
      await this.services.activate(entry)
      await this.evictWarm()
    } catch (error) {
      if (!current()) return
      this.state.status = { kind: 'error', message: String(error) }
      this.state.loadedKey = null
      this.changed()
      this.openFailed?.(entry.name, String(error))
      // A failed open shows the error and Retry, not the chat (`loadedKey` stays unset);
      // the agent stays attached so "Draft fix in chat" can reveal it.
      await this.services.activate(entry)
    }
  }

  private async evictWarm() {
    const old = [...this.state.projects].sort((a, b) => b.touchedAt - a.touchedAt).slice(3)
    for (const entry of old) {
      if (
        entry.key === this.state.activeKey ||
        entry.previewKind === 'simulator' ||
        this.closing.has(entry.key) ||
        this.jobs.has(entry.key)
      )
        continue
      await this.serialize(entry.key, async () => {
        const snapshot: WorkspaceSnapshot = await this.services.invoke('agent:workspace-snapshot')
        const live = snapshot.projects.find((p) => p.projectKey === entry.key)
        if (
          entry.key === this.state.activeKey ||
          this.closing.has(entry.key) ||
          live?.chats.some((c) => c.isRunning)
        )
          return
        await Promise.all([
          this.services.invoke('devserver:stop', entry.root),
          this.services.invoke('agent:close-project', entry.root)
        ])
      })
    }
  }
  async close(key: string) {
    const entry = this.find(key)
    this.closing.add(key)
    const wasActive = this.state.activeKey === key
    if (wasActive) ++this.intent
    const done = (async () => {
      try {
        // Removed from the store before its session and server are torn down.
        await this.services.store.close(key)
        this.adopt()
        this.changed()
        await this.serialize(key, async () => {
          await this.services.invoke('devserver:stop', entry.root)
          if (entry.previewKind === 'simulator') await this.services.invoke('simulator:stop')
          await this.services.invoke('agent:close-project', entry.root)
          for (const session of entry.sessionKeys) this.services.closeChat(session)
        })
      } finally {
        this.closing.delete(key)
      }
    })()
    this.closes.set(key, done)
    try {
      await done
    } finally {
      if (this.closes.get(key) === done) this.closes.delete(key)
    }
    if (wasActive && this.state.activeKey === null) {
      const next = this.state.projects.at(-1)
      if (next) await this.select(next.key)
      else {
        await this.services.invoke('preview:reset')
        this.state.status = { kind: 'idle' }
        this.state.loadedKey = null
        this.changed()
        await this.services.activate(null)
      }
    }
  }
}

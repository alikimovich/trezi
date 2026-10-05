import type { AgentEvent, Annotation, SelectedElement, SourceSetupState } from '../shared/api'
import type { NativeChatContext, NativeChatEffect } from '../shared/native-chat-controller'
import { describeSelectionForPrompt, selectionForBubble } from '../shared/selection-context'
import type { ProjectEntry } from '../shared/workspace'
import type { NativeChatController } from './chat-controller'
import type { NativeWorkspaceController } from './workspace-controller'

interface ProjectContext {
  selection: NativeChatContext['selection']
  setup: NativeChatContext['setup']
  tokens: NativeChatContext['tokens']
  notes: NativeChatContext['notes']
  pins: { id: string; selector: string }[]
  /** The newest notes read issued; an older response is stale and dropped. */
  notesRead: number
  canInstrument?: boolean
  stamps?: number
  verifyingAfter?: number
  verifyFailure?: ReturnType<typeof setTimeout>
  /** Why the landed setup turn may not have wired anything (it changed no file). */
  verifyHint?: string
  /** LKM-157: when a connected project's dev server restarted; its next page must show stamps. */
  restartedAt?: number
  lostCheck?: ReturnType<typeof setTimeout>
  loading?: Promise<void>
}
export class NativeContextController {
  readonly projects = new Map<string, ProjectContext>()
  /** How long a restarted preview may take to show its first stamp before setup fails. */
  verifyGraceMs = 3500
  private readonly treziLog = new Map<string, string>()
  readonly spawns = new Map<string, NativeChatContext['spawns']>()
  private readonly finishedSpawns = new Set<string>()
  constructor(
    readonly workspace: NativeWorkspaceController,
    readonly chat: NativeChatController,
    readonly turn: () => NativeChatContext['turn'],
    readonly send: (channel: string, ...args: any[]) => Promise<any> = workspace.services.invoke
  ) {}
  private get invoke() {
    return this.workspace.services.invoke
  }
  private project(root: string) {
    let state = this.projects.get(root)
    if (!state) {
      state = {
        selection: null,
        setup: { needed: false, dismissed: false, status: null },
        tokens: { needed: false, dismissed: false },
        notes: [],
        pins: [],
        notesRead: 0
      }
      this.projects.set(root, state)
    }
    return state
  }
  private context(root: string | null, key: string): NativeChatContext {
    const state = this.project(root ?? '')
    return {
      chat: key,
      root,
      selection: state.selection,
      setup: { ...state.setup },
      tokens: { ...state.tokens },
      notes: state.notes,
      spawns: this.spawns.get(key) ?? [],
      turn: this.turn()
    }
  }
  private changed(root: string) {
    for (const value of this.chat.chats.values())
      if (value.context?.root === root) {
        value.context = this.context(root, value.chat)
        this.chat.changed(value)
      }
  }
  async activate(entry: ProjectEntry | null) {
    const old = this.chat.chats.get(this.chat.active)?.context?.root
    if (old !== entry?.root && entry) this.project(entry.root).selection = null
    await this.chat.command({
      type: 'context',
      context: this.context(entry?.root ?? null, entry?.activeSessionKey ?? '')
    })
    if (!entry) return
    const state = this.project(entry.root)
    if (!state.loading) state.loading = this.load(entry.root)
    await state.loading
    if (this.workspace.active?.root === entry.root)
      await this.send('preview:set-annotations', state.pins)
  }
  private async load(root: string) {
    const state = this.project(root),
      read = ++state.notesRead
    const saved = this.remembered(root)
    if (saved?.state === 'declined') state.setup.dismissed = true
    if (saved?.state === 'unstamped') state.setup.lost = true
    if (saved?.state === 'failed' && !state.setup.failed) this.showFailure(state, saved.reason)
    const results = await Promise.allSettled([
      this.invoke('setup:detect', root),
      this.invoke('tokens:detect', root),
      this.invoke('annotations:list', root)
    ])
    if (this.projects.get(root) !== state) return
    if (results[0].status === 'fulfilled') state.canInstrument = results[0].value.canInstrument
    if (results[1].status === 'fulfilled') state.tokens.needed = results[1].value.source === 'none'
    if (results[2].status === 'fulfilled' && read === state.notesRead)
      this.setNotes(state, results[2].value)
    if (state.stamps === 0 && this.offer(root, state)) state.setup.needed = true
    this.changed(root)
  }
  /** LKM-153: the project's Connect to Trezi outcome, kept in its workspace entry so a
   *  relaunch remembers "Not now", a stamped project and the last failure. */
  private remembered(root: string) {
    return this.workspace.state.projects.find((p) => p.root === root)?.sourceSetup
  }
  private remember(root: string, value: SourceSetupState['state'], reason?: string) {
    const entry = this.workspace.state.projects.find((p) => p.root === root)
    if (!entry || (entry.sourceSetup?.state === value && entry.sourceSetup.reason === reason))
      return
    entry.sourceSetup = {
      state: value,
      ...(reason ? { reason: reason.slice(0, 4000) } : {}),
      at: Date.now()
    }
    this.workspace.changed()
  }
  /** Offer setup only where stamping is possible, missing and not declined or already seen. */
  private offer(root: string, state: ProjectContext) {
    return (
      !!state.canInstrument && !state.setup.dismissed && this.remembered(root)?.state !== 'done'
    )
  }
  private showFailure(state: ProjectContext, reason = 'Setup did not finish.') {
    state.setup.failed = true
    state.setup.status = `Setup failed: ${reason}`
  }
  private fail(root: string, state: ProjectContext, reason: string) {
    this.showFailure(state, reason)
    this.remember(root, 'failed', reason)
  }
  /** LKM-157: a connected project's dev server restarted. If its restarted page shows no
   *  stamp for a full `verifyGraceMs`, the wiring was lost and Reconnect is offered. A page
   *  without elements is never judged without a restart; a landed setup has its own check. */
  restarted(root: string) {
    const state = this.project(root)
    if (state.verifyingAfter || this.remembered(root)?.state !== 'done') return
    clearTimeout(state.lostCheck)
    state.lostCheck = undefined
    state.restartedAt = Date.now()
  }
  private checkLost(root: string, state: ProjectContext) {
    if (!state.restartedAt || state.verifyingAfter || state.lostCheck) return
    state.lostCheck = setTimeout(() => {
      state.lostCheck = undefined
      if (!state.restartedAt || (state.stamps ?? 0) > 0) return
      state.restartedAt = undefined
      // Only a page watched for the whole grace period is proof.
      if (this.workspace.active?.root !== root || this.remembered(root)?.state !== 'done') return
      state.setup.lost = true
      state.setup.failed = false
      state.setup.status = null
      this.remember(root, 'unstamped')
      if (this.offer(root, state)) state.setup.needed = true
      this.changed(root)
    }, this.verifyGraceMs)
  }
  /** A dev-server line from Trezi's Vite plugin (`[trezi-source] …`) names why nothing got stamped. */
  devServerLog(root: string, output: string) {
    const line = output
      .split('\n')
      .reverse()
      .find((text) => text.includes('[trezi-source]'))
    if (line) this.treziLog.set(root, line.slice(line.indexOf('[trezi-source]') + 14).trim())
  }
  selection(element: SelectedElement | null) {
    const root = this.workspace.active?.root
    if (!root) return
    const group = element ? (element.selectionGroup ?? [element]) : []
    this.project(root).selection =
      element && group.length
        ? {
            label: group.length > 1 ? `${group.length} objects` : element.tag,
            prompt: group.map((item) => describeSelectionForPrompt(item, root)).join('\n'),
            bubble:
              group.length > 1
                ? { tag: `${group.length} objects`, ident: '', source: null }
                : selectionForBubble(element)
          }
        : null
    this.changed(root)
  }
  /** LKM-172: a selection belongs to one project and page; a project switch drops every
   *  project's chip, so returning to a project restores none. */
  clearSelections() {
    for (const [root, state] of this.projects)
      if (state.selection) {
        state.selection = null
        this.changed(root)
      }
  }
  readiness(info: { stamps: number; documentStartedAt?: number }) {
    const root = this.workspace.active?.root
    if (!root) return
    const state = this.project(root)
    // A page from before the restart proves nothing about the restarted dev server.
    const after = state.verifyingAfter ?? state.restartedAt
    if (after && info.documentStartedAt !== undefined && info.documentStartedAt < after) return
    state.stamps = info.stamps
    if (info.stamps > 0) {
      // Stamps in the preview are the proof, whatever was remembered before. A later loss
      // of them is a new question, so an earlier Not now does not hide Reconnect.
      state.setup.needed = false
      state.setup.failed = false
      state.setup.lost = false
      state.setup.dismissed = false
      state.restartedAt = undefined
      clearTimeout(state.lostCheck)
      state.lostCheck = undefined
      state.setup.status = state.verifyingAfter
        ? `Setup verified — ${info.stamps} element(s) now mapped to source.`
        : null
      state.verifyingAfter = undefined
      this.remember(root, 'done')
      clearTimeout(state.verifyFailure)
      state.verifyFailure = undefined
    } else {
      // The preview re-samples a slow first render, so a zero only fails setup once
      // no later sample of the restarted page found stamps.
      if (state.verifyingAfter && !state.verifyFailure)
        state.verifyFailure = setTimeout(() => {
          state.verifyFailure = undefined
          if (!state.verifyingAfter || (state.stamps ?? 0) > 0) return
          state.verifyingAfter = undefined
          const log = this.treziLog.get(root)
          this.fail(
            root,
            state,
            log
              ? `the dev server reported: ${log}`
              : (state.verifyHint ??
                  'the restarted preview has no element mapped to source. Check that the config change landed and that the dev server loads the Trezi plugin.')
          )
          if (this.offer(root, state)) state.setup.needed = true
          this.changed(root)
        }, this.verifyGraceMs)
      this.checkLost(root, state)
      if (this.offer(root, state)) state.setup.needed = true
    }
    this.changed(root)
  }
  async effect(effect: NativeChatEffect) {
    if (effect.type === 'selection-clear') {
      const root = this.chat.chats.get(effect.chat)?.context?.root
      if (root && this.project(root).selection?.prompt === effect.prompt) {
        this.project(root).selection = null
        this.changed(root)
        if (this.workspace.active?.root === root) await this.send('preview:clear-selected')
      }
    } else if (effect.type === 'setup') {
      const root = this.chat.chats.get(effect.chat)?.context?.root
      if (!root) return
      const state = this.project(root)
      if (effect.phase === 'dismissed') {
        state.setup.dismissed = true
        state.setup.needed = false
        this.remember(root, 'declined')
      }
      if (effect.phase === 'configuring') {
        state.setup.failed = false
        state.setup.status = effect.status ?? null
      }
      if (effect.phase === 'failed')
        this.fail(root, state, effect.status ?? 'the setup turn did not finish.')
      if (effect.phase === 'landed') {
        state.verifyingAfter = Date.now()
        state.verifyHint = effect.status
        this.treziLog.delete(root)
        clearTimeout(state.verifyFailure)
        state.verifyFailure = undefined
        state.restartedAt = undefined
        clearTimeout(state.lostCheck)
        state.lostCheck = undefined
        state.setup.failed = false
        state.setup.status = 'Setup landed. Restarting the preview to check for stamps…'
        const entry = this.workspace.state.projects.find((p) => p.root === root)
        if (entry && this.workspace.active?.key === entry.key)
          await this.workspace.command({ type: 'restart', key: entry.key })
        else state.setup.status = 'Setup applied. Reopen the project to restart its preview.'
      }
      this.changed(root)
    } else if (effect.type === 'tokens') {
      const state = this.project(effect.root),
        value = this.chat.chats.get(this.chat.active)?.context
      if (value?.root === effect.root && value.tokens.dismissed) state.tokens.dismissed = true
      const result = await this.invoke('tokens:detect', effect.root)
      state.tokens.needed = result.source === 'none'
      this.changed(effect.root)
    } else if (effect.type === 'notes') await this.notes(effect.root)
    else if (effect.type === 'history') {
      await Promise.all(
        this.workspace.state.projects.map(async (entry) => {
          const records = await this.invoke('sessions:list', entry.root)
          if (this.workspace.state.projects.includes(entry))
            this.workspace.state.history[entry.key] = records
        })
      )
      this.workspace.changed()
    } else if (effect.type === 'spawn') this.spawn(effect.event)
  }
  /** Re-reads after an add/remove. Reads can finish out of order; only the newest applies. */
  async notes(root: string) {
    const state = this.project(root),
      read = ++state.notesRead
    const notes = await this.invoke('annotations:list', root)
    if (this.projects.get(root) !== state || read !== state.notesRead) return
    this.setNotes(state, notes)
    this.changed(root)
    if (this.workspace.active?.root === root) await this.send('preview:set-annotations', state.pins)
  }
  private setNotes(state: ProjectContext, notes: Annotation[]) {
    state.notes = notes.map((n) => ({ id: n.id, text: n.text }))
    state.pins = notes.map((n) => ({ id: n.id, selector: n.selector }))
  }
  queued(key: string, id: string, label: string, queued: boolean) {
    if (this.finishedSpawns.has(id)) return
    const list = this.spawns.get(key) ?? []
    if (!list.some((s) => s.id === id))
      this.spawns.set(key, [...list, { id, label, status: queued ? 'queued' : 'running' }])
    const root = this.chat.chats.get(key)?.context?.root
    if (root) this.changed(root)
  }
  private spawn(event: AgentEvent) {
    if (!event.projectKey || !event.sessionId) return
    if (event.type === 'spawn-finished') this.finishedSpawns.add(event.sessionId)
    else if (this.finishedSpawns.has(event.sessionId)) return
    let list = this.spawns.get(event.projectKey) ?? []
    if (event.type === 'spawn-started')
      list = [
        ...list.filter((s) => s.id !== event.sessionId),
        {
          id: event.sessionId,
          label: list.find((s) => s.id === event.sessionId)?.label ?? event.branch,
          status: 'running'
        }
      ]
    else if (event.type === 'spawn-finished') list = list.filter((s) => s.id !== event.sessionId)
    else if (event.type === 'status' || event.type === 'error')
      list = list.map((s) =>
        s.id === event.sessionId
          ? { ...s, activity: event.type === 'status' ? event.text : event.message }
          : s
      )
    this.spawns.set(event.projectKey, list)
    const root = this.chat.chats.get(event.projectKey)?.context?.root
    if (root) this.changed(root)
  }
}

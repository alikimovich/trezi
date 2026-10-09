import type { GithubStatus, GitRemoteStatus, PublishResult } from '../shared/api'
import { versionConflict } from '../shared/dependency-issue'
import { sanitizeRepoName } from '../shared/github'
import type { NativeShellState } from '../shared/native-shell'
import {
  type PublishProgress,
  publishCancellable,
  publishedMessage,
  publishFailure,
  publishLabel
} from '../shared/publish-progress'
import type { NativeActivityController } from './activity-controller'
import type { NativeChatController } from './chat-controller'
import type { NativePreferences } from './preferences'
import type { NativeSheetController } from './sheets-runtime'

/** A publish the toolbar shows for one project (LKM-187), kept per root across switches. */
interface PublishRun {
  mode: 'merge' | 'pr'
  /** The owner's step and when it started (epoch ms). */
  step?: string
  since?: number
  /** The workflow record, once the owner reports it open. */
  id?: string
  cancelling?: boolean
  /** `publish:ship` is in flight, so a cancel goes to the owner. */
  shipping?: boolean
  timer?: ReturnType<typeof setTimeout>
}

const OPEN = new Set(['running', 'describe'])

export class NativeGitController {
  readonly branches = new Map<string, string[]>()
  readonly connections = new Map<string, GithubStatus | null>()
  private readonly revisions = new Map<string, number>()
  /** Publishes under way, by root: the toolbar follows the active project's. */
  readonly runs = new Map<string, PublishRun>()
  /** How often a running publish's step is read (it also ticks the elapsed time). */
  pollInterval = 400
  /** Asked before a publish starts; false stops it (the states workbench guard). */
  beforePublish?: (root: string) => boolean | Promise<boolean>
  constructor(
    readonly sheets: NativeSheetController,
    readonly log: NativeActivityController,
    readonly preferences: NativePreferences,
    readonly render: () => void,
    readonly openExternal: (url: string) => unknown = () => {},
    readonly chat?: NativeChatController
  ) {}
  private get workspace() {
    return this.sheets.workspace
  }
  private get invoke() {
    return this.sheets.invoke
  }
  /** Whether Publish can run (the native smoke stands in a connected remote). */
  githubStatus(root: string): Promise<GithubStatus> {
    return this.invoke('github:status', root)
  }
  get mode() {
    return this.preferences.get('trezi:publish-mode') === 'pr' ? 'pr' : 'merge'
  }
  async setMode(value: string) {
    if (value === 'pr' || value === 'merge') {
      await this.preferences.set('trezi:publish-mode', value)
      this.render()
    }
  }
  decorate(state: NativeShellState): NativeShellState {
    const entry = this.workspace.active,
      root = entry?.root ?? '',
      run = this.runs.get(root)
    const connection = this.connections.get(root)
    return {
      ...state,
      branch: entry?.branch ?? null,
      branches: this.branches.get(root) ?? [],
      publishing: !!run,
      publishCancellable: !!run && !run.cancelling && publishCancellable(run.step),
      publishMode: this.mode,
      publishLabel: run
        ? publishLabel(run.mode, run)
        : connection && !connection.connected
          ? 'Connect to GitHub'
          : this.mode === 'pr'
            ? 'Create PR'
            : 'Publish'
    }
  }
  async refresh(root: string) {
    const revision = (this.revisions.get(root) ?? 0) + 1
    this.revisions.set(root, revision)
    const git = await this.invoke('git:list', root)
    if (this.revisions.get(root) !== revision) return
    const entry = this.workspace.state.projects.find((p) => p.root === root)
    if (!entry) return
    entry.branch = git.current ?? null
    this.branches.set(root, git.branches)
    this.workspace.changed()
    this.render()
    const status =
      git.current || git.branches.length ? await this.invoke('github:status', root) : null
    if (!this.workspace.state.projects.includes(entry) || this.revisions.get(root) !== revision)
      return
    this.connections.set(root, status)
    this.render()
    if (!this.runs.has(root)) await this.adopt(root)
  }
  async branch(key: string, name: string, create = false) {
    if (!name.trim()) return
    let files: string[] | undefined
    await this.workspace.transact(key, async (entry) => {
      const result = await this.invoke(create ? 'git:set' : 'git:checkout', entry.root, name.trim())
      if (result.error) throw new Error(result.error)
      entry.branch = result.branch
      files = result.files
      await this.invoke('agent:tag-session', entry.root, { branch: result.branch })
      await this.refresh(entry.root)
      this.log.append(`Switched to ${result.branch}`, 'success')
    })
    await this.workspace.refreshEnvironment(key, files)
  }
  /**
   * Publish (LKM-187): the button shows progress at once, then the owner's step
   * (`publish:progress`); success is a toast, failure a sheet with Retry.
   */
  async publish(key: string) {
    let entry = this.workspace.state.projects.find((p) => p.key === key)
    if (!entry || this.runs.has(entry.root)) return
    // LKM-207: a states workbench left in the project is confirmed (or removed) first;
    // without one the answer is synchronous, so progress still shows on the click.
    const go = this.beforePublish?.(entry.root) ?? true
    if (go !== true) {
      if (!(await go)) return
      entry = this.workspace.state.projects.find((p) => p.key === key)
      if (!entry || this.runs.has(entry.root)) return
    }
    const root = entry.root,
      mode = this.mode,
      generation = this.sheets.generation,
      run: PublishRun = { mode }
    this.runs.set(root, run)
    this.render()
    let result: PublishResult | null = null
    try {
      const status = await this.githubStatus(root)
      this.connections.set(root, status)
      if (!status.connected) {
        if (this.sheets.generation === generation) await this.connect(key, status)
        return
      }
      if (run.cancelling) {
        result = { ok: false, cancelled: true, error: 'Cancelled before anything changed.' }
        return
      }
      await this.workspace.transact(key, async () => {
        // transact queues behind other work on the project: a Cancel that arrived while
        // waiting must still stop the publish before anything changes.
        if (run.cancelling) {
          result = { ok: false, cancelled: true, error: 'Cancelled before anything changed.' }
          return
        }
        this.log.append(
          mode === 'pr' ? 'Creating pull request…' : 'Publishing and merging changes…'
        )
        run.shipping = true
        this.follow(root, run)
        result = await this.invoke('publish:ship', root, undefined, mode)
        run.shipping = false
        if (!result?.ok) return
        // Tagging the chat is bookkeeping: its failure doesn't fail the publish.
        try {
          if (result.branch) await this.invoke('agent:tag-session', root, { branch: result.branch })
          if (result.url) await this.invoke('agent:tag-session', root, { prUrl: result.url })
        } catch (error) {
          this.log.append(String(error), 'error')
        }
      })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.stop(root, run)
      await this.refresh(root).catch((error) => this.log.append(String(error), 'error'))
      this.render()
    }
    if (result) await this.finished(key, mode, result, run.cancelling)
  }
  /** Asks the owner to stop the active publish before its next step. */
  async cancel(key: string) {
    const entry = this.workspace.state.projects.find((p) => p.key === key)
    const run = entry && this.runs.get(entry.root)
    if (!entry || !run || run.cancelling || !publishCancellable(run.step)) return
    run.cancelling = true
    this.render()
    // Before the ship request starts, publish() stops by itself.
    if (!run.shipping) return
    const stopped = await this.invoke('publish:cancel', entry.root).catch(() => false)
    if (stopped || this.runs.get(entry.root) !== run) return
    run.cancelling = false
    this.log.append('Publishing could not be cancelled at this step.', 'warning')
    this.render()
  }
  /** Reads the owner's step for `run` until it stops; every read re-renders the label. */
  private follow(root: string, run: PublishRun, closed?: (progress: PublishProgress) => void) {
    const tick = async () => {
      if (this.runs.get(root) !== run) return
      const progress: PublishProgress | null = await this.invoke('publish:progress', root).catch(
        () => null
      )
      if (this.runs.get(root) !== run) return
      // An adopted run stops at `describe`: its describer was the process that reloaded.
      const open =
        progress && OPEN.has(progress.state) && !(closed && progress.state === 'describe')
      if (progress && open && (!run.id || run.id === progress.id)) {
        run.id = progress.id
        if (progress.step && progress.step !== run.step) {
          run.step = progress.step
          run.since = progress.since ?? Date.now()
        }
      } else if (closed && progress?.id === run.id) {
        closed(progress!)
        return
      }
      this.render()
      run.timer = setTimeout(tick, this.pollInterval)
    }
    void tick()
  }
  private stop(root: string, run: PublishRun) {
    clearTimeout(run.timer)
    if (this.runs.get(root) === run) this.runs.delete(root)
  }
  /**
   * A publish this process didn't start (Trezi reloaded mid-publish): show it on the
   * toolbar until the owner closes the record, then report its result.
   */
  private async adopt(root: string) {
    const progress: PublishProgress | null = await this.invoke('publish:progress', root).catch(
      () => null
    )
    if (progress?.state !== 'running' || !progress.id || this.runs.has(root)) return
    const run: PublishRun = {
      mode: this.mode,
      id: progress.id,
      step: progress.step,
      since: progress.since ?? Date.now(),
      shipping: true
    }
    this.runs.set(root, run)
    this.render()
    this.follow(root, run, (last) => {
      this.stop(root, run)
      this.render()
      const key = this.workspace.state.projects.find((p) => p.root === root)?.key
      // Waiting for a description nobody will write: a new Publish resumes it.
      if (key && last.result && last.state !== 'describe')
        void this.finished(key, run.mode, last.result, false).catch((error) =>
          this.log.append(String(error), 'error')
        )
      void this.refresh(root).catch((error) => this.log.append(String(error), 'error'))
    })
  }
  /** The result: a toast on success, the failure sheet otherwise. */
  private async finished(
    key: string,
    mode: 'merge' | 'pr',
    result: PublishResult,
    cancelling?: boolean
  ) {
    if (result.ok) {
      if (mode === 'pr' && result.url && this.chat) {
        const root = this.workspace.state.projects.find((entry) => entry.key === key)?.root
        if (root) {
          const pr = await this.invoke('publish:pr-status', root).catch((error) => ({
            error: String(error)
          }))
          // GitHub reports UNKNOWN while it recomputes after the push; the local
          // merge-tree result against the fetched base is still authoritative.
          if (
            pr.mergeable === 'CONFLICTING' ||
            (pr.mergeable === 'UNKNOWN' && pr.conflictingFiles?.length > 0)
          ) {
            this.resolveWithAgent(key, {
              error: `Pull request #${pr.number ?? '?'} conflicts with ${pr.baseRefName ?? 'its base branch'}.`,
              conflictFiles: pr.conflictingFiles,
              branch: pr.headRefName ?? result.branch,
              url: pr.url ?? result.url,
              base: pr.baseRefName
            })
            return
          }
          if (pr.error) this.log.append(pr.error, 'warning')
        }
      }
      const message = publishedMessage(mode, result)
      this.log.append(`${message}${result.url ? ': ' + result.url : ''}`, 'success')
      if (result.notice) this.log.append(result.notice, 'warning')
      const url = result.url
      this.sheets.toast(
        message,
        url ? { label: 'View on GitHub', run: async () => this.openExternal(url) } : undefined
      )
      return
    }
    if (result.cancelled || cancelling) {
      this.log.append(result.error ?? 'Publishing was cancelled.', 'warning')
      this.sheets.toast('Publish cancelled')
      return
    }
    // LKM-194: the reconcile aborted its merge, so the checkout is clean and both tips are
    // on recovery refs; the agent merges the remote branch in its own worktree.
    if (result.conflictFiles?.length && result.recoveryRefs?.length && result.branch) {
      this.log.append(publishFailure(mode, result).details, 'error')
      this.resolveWithAgent(key, { ...result, sync: `origin/${result.branch}` })
      return
    }
    const failure = publishFailure(mode, result)
    this.log.append(failure.details, 'error')
    this.sheets.present(
      {
        title: failure.title,
        detail: failure.detail,
        fields: [],
        actions: [
          { id: 'copy', label: 'Copy details', copy: failure.details },
          { id: 'cancel', label: 'Close' },
          { id: 'retry', label: 'Retry', primary: true }
        ]
      },
      async (action) => {
        const sheet = this.sheets.current
        if (action.action === 'copy') {
          if (sheet?.state.id === action.id)
            sheet.state.message = 'Details copied to the clipboard.'
          return
        }
        if (sheet?.state.id === action.id) this.sheets.close()
        void this.publish(key)
      }
    )
  }
  private resolveWithAgent(
    key: string,
    result: {
      error?: string
      conflictFiles?: string[]
      recoveryRefs?: string[]
      branch?: string
      url?: string
      base?: string
      /** The publish reconcile's remote branch (`origin/<branch>`), merged instead of the base. */
      sync?: string
      versionConflict?: { local: string; remote: string }
    }
  ) {
    const files = result.conflictFiles ?? []
    const remote = result.versionConflict
    const version = remote && versionConflict(remote.local, remote.remote)
    const versionLine = version
      ? `Both sides changed the version in package.json (${version.ours} here, ${version.theirs} on GitHub): keep ${version.keep}, the higher one.`
      : ''
    this.sheets.present(
      {
        title: 'Publish has merge conflicts',
        alert: false,
        detail: [
          result.error ?? 'The pull request cannot merge.',
          `Conflicting files: ${files.join(', ')}.`,
          versionLine
        ]
          .filter(Boolean)
          .join('\n'),
        fields: [],
        actions: [
          { id: 'cancel', label: 'Later' },
          { id: 'resolve', label: 'Resolve with agent', primary: true }
        ]
      },
      async (action) => {
        if (action.action !== 'resolve' || !this.chat) return
        const project = this.workspace.state.projects.find((entry) => entry.key === key)
        if (!project) throw new Error('The published project is no longer open.')
        await this.workspace.command({ type: 'select', key })
        let selected = this.workspace.state.projects.find((entry) => entry.key === key)
        if (!selected?.activeSessionKey) await this.workspace.command({ type: 'new-chat', key })
        selected = this.workspace.state.projects.find((entry) => entry.key === key)
        if (!selected?.activeSessionKey) throw new Error('Could not open a chat for this project.')
        const active = this.chat.get(selected.activeSessionKey)
        if (!active.ready) await this.chat.initialize(active)
        if (active.root !== project.root)
          throw new Error('The selected chat does not belong to the published project.')
        const facts = [
          result.sync
            ? `Resolve the conflict between this work branch and ${result.sync} that stopped Publish, in this chat worktree. The project itself has no conflict markers.`
            : 'Resolve this pull request’s conflict with its base in this chat worktree.',
          `Publish reported: ${result.error ?? 'pull request is not mergeable'}`,
          `Conflicting files: ${files.join(', ')}`,
          version
            ? `package.json "version": ${version.ours} here, ${version.theirs} on ${result.sync ?? 'the base'}. Both sides bumped it; keep ${version.keep} (the higher SemVer).`
            : '',
          result.branch ? `Work branch: ${result.branch}` : '',
          result.base ? `Base branch: origin/${result.base}` : '',
          result.url ? `Pull request: ${result.url}` : '',
          result.recoveryRefs?.length ? `Recovery refs: ${result.recoveryRefs.join(', ')}` : '',
          result.sync
            ? `Call git_sync_base with ref ${result.sync}, resolve the conflict markers, then git_merge_continue. When the turn has landed, call publish_update if the branch has a pull request; otherwise tell the user to Publish again.`
            : 'Call pr_status and git_sync_base, resolve the conflict markers, then git_merge_continue and publish_update. Keep the chosen version consistent with the user’s changes.'
        ]
          .filter(Boolean)
          .join('\n')
        this.sheets.close()
        await this.chat.submit(active, facts)
      }
    )
  }
  async connect(key: string, status?: GithubStatus) {
    const entry = this.workspace.state.projects.find((p) => p.key === key)
    if (!entry) return
    const generation = this.sheets.generation
    status ??= await this.invoke('github:status', entry.root)
    if (generation !== this.sheets.generation) return
    const ready = status!.gh === 'ok',
      owners = [status!.login, ...(status!.orgs ?? [])].filter((x): x is string => !!x)
    this.sheets.present(
      {
        title: 'Connect to GitHub',
        detail: ready
          ? 'Create a GitHub repository and upload this project. Choose who owns it and who can see it.'
          : status!.gh === 'missing'
            ? 'Install the GitHub CLI (gh), then check again.'
            : 'Run gh auth login in your terminal, then check again.',
        fields: ready
          ? [
              { id: 'name', label: 'Repository name', kind: 'text', value: status!.suggestedName },
              {
                id: 'owner',
                label: 'Account or organization',
                kind: 'choice',
                value: owners[0] ?? '',
                choices: owners.map((value) => ({ value, label: value }))
              },
              {
                id: 'visibility',
                label: 'Visibility',
                kind: 'choice',
                value: 'private',
                choices: [
                  { value: 'private', label: 'Private' },
                  { value: 'public', label: 'Public' }
                ]
              }
            ]
          : [],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          {
            id: ready ? 'connect' : 'refresh',
            label: ready ? 'Create repository' : 'Check again',
            primary: true
          }
        ]
      },
      async (action) => {
        if (action.action === 'refresh') {
          await this.connect(key)
          return
        }
        if (
          !owners.includes(action.values.owner) ||
          !['private', 'public'].includes(action.values.visibility)
        )
          throw new Error('Choose an owner and visibility.')
        await this.workspace.transact(key, async () => {
          const result = await this.invoke('github:connect', entry.root, {
            name: sanitizeRepoName(action.values.name),
            owner: action.values.owner,
            private: action.values.visibility === 'private'
          })
          if (!result.ok) throw new Error(result.error ?? 'Could not connect.')
          this.log.append('Connected to GitHub: ' + result.url, 'success')
        })
        await this.refresh(entry.root)
        if (this.sheets.current?.state.id === action.id) this.sheets.close()
      }
    )
  }
  async updates(key: string, fetch = false) {
    const entry = this.workspace.state.projects.find((p) => p.key === key)
    if (!entry) return
    const generation = this.sheets.generation
    const status: GitRemoteStatus = await this.invoke('git:remote-status', entry.root, fetch)
    if (generation !== this.sheets.generation) return
    this.sheets.present(
      {
        title: 'Git updates',
        // A tool window whether or not the project has remotes, not an alert.
        alert: false,
        detail: `Current branch: ${status.current ?? 'No branch selected'}. ${status.remotes.length ? 'Choose a remote branch. Pull merges it into your current branch; switching opens that branch instead.' : 'Connect this project to a Git remote to get updates.'}`,
        fields: status.remotes.length
          ? [
              {
                id: 'ref',
                label: 'Remote branch',
                kind: 'choice',
                value: status.upstream ?? status.branches[0]?.ref ?? '',
                choices: status.branches.map((b) => ({ value: b.ref, label: b.label }))
              }
            ]
          : [],
        actions: [
          { id: 'cancel', label: 'Close' },
          { id: 'fetch', label: 'Fetch updates' },
          ...(status.current && status.branches.length
            ? [
                { id: 'pull', label: 'Pull into current branch' },
                { id: 'checkout', label: 'Switch to branch' }
              ]
            : [])
        ]
      },
      async (action) => {
        if (action.action === 'fetch') {
          await this.updates(key, true)
          return
        }
        if (!status.branches.some((b) => b.ref === action.values.ref))
          throw new Error('Choose an available remote branch.')
        let files: string[] = []
        await this.workspace.transact(key, async () => {
          const result = await this.invoke('git:remote-update', entry.root, {
            action: action.action,
            ref: action.values.ref,
            expectedBranch: status.current
          })
          if (!result.ok) throw new Error(result.message)
          files = result.files
          this.log.append(result.message, 'success')
          await this.refresh(entry.root)
        })
        await this.workspace.refreshEnvironment(key, files)
        if (this.sheets.current?.state.id === action.id) await this.updates(key)
      }
    )
  }
}

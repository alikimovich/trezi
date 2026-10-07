import type { GithubStatus, GitRemoteStatus } from '../shared/api'
import { sanitizeRepoName } from '../shared/github'
import type { NativeShellState } from '../shared/native-shell'
import type { NativeActivityController } from './activity-controller'
import type { NativeChatController } from './chat-controller'
import type { NativePreferences } from './preferences'
import type { NativeSheetController } from './sheets-runtime'
export class NativeGitController {
  readonly branches = new Map<string, string[]>()
  readonly connections = new Map<string, GithubStatus | null>()
  private readonly revisions = new Map<string, number>()
  readonly publishing = new Set<string>()
  constructor(
    readonly sheets: NativeSheetController,
    readonly log: NativeActivityController,
    readonly preferences: NativePreferences,
    readonly render: () => void,
    readonly chat?: NativeChatController
  ) {}
  private get workspace() {
    return this.sheets.workspace
  }
  private get invoke() {
    return this.sheets.invoke
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
      publishing = this.publishing.has(root)
    const connection = this.connections.get(root)
    return {
      ...state,
      branch: entry?.branch ?? null,
      branches: this.branches.get(root) ?? [],
      publishing,
      publishMode: this.mode,
      publishLabel:
        connection && !connection.connected
          ? 'Connect to GitHub'
          : publishing
            ? this.mode === 'pr'
              ? 'Creating PR…'
              : 'Publishing…'
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
  async publish(key: string) {
    const entry = this.workspace.state.projects.find((p) => p.key === key)
    if (!entry || this.publishing.has(entry.root)) return
    const root = entry.root,
      mode = this.mode,
      generation = this.sheets.generation
    this.publishing.add(root)
    this.render()
    try {
      const status: GithubStatus = await this.invoke('github:status', root)
      this.connections.set(root, status)
      if (!status.connected) {
        if (this.sheets.generation === generation) await this.connect(key, status)
        return
      }
      await this.workspace.transact(key, async () => {
        this.log.append(
          mode === 'pr' ? 'Creating pull request…' : 'Publishing and merging changes…'
        )
        const result = await this.invoke('publish:ship', root, undefined, mode)
        if (!result.ok) {
          if (result.conflictFiles?.length && this.chat) {
            this.resolveWithAgent(key, result)
            return
          }
          const recovery = result.conflictFiles?.length
            ? `\nConflicting files:\n${result.conflictFiles.join('\n')}\nResolve and stage each file, commit the merge, then Publish again.\nRecovery refs: ${(result.recoveryRefs ?? []).join(', ')}`
            : ''
          throw new Error((result.error ?? 'Publish failed') + recovery)
        }
        if (result.branch) await this.invoke('agent:tag-session', root, { branch: result.branch })
        if (result.url) await this.invoke('agent:tag-session', root, { prUrl: result.url })
        this.log.append(
          `${mode === 'pr' ? 'PR ready' : 'Published'}${result.url ? ': ' + result.url : ''}`,
          'success'
        )
        if (result.notice) this.log.append(result.notice, 'warning')
      })
    } catch (error) {
      this.log.append(String(error), 'error')
    } finally {
      this.publishing.delete(root)
      await this.refresh(root).catch((error) => this.log.append(String(error), 'error'))
      this.render()
    }
  }
  private resolveWithAgent(
    key: string,
    result: {
      error?: string
      conflictFiles?: string[]
      recoveryRefs?: string[]
      branch?: string
      url?: string
    }
  ) {
    const files = result.conflictFiles ?? []
    this.sheets.present(
      {
        title: 'Publish has merge conflicts',
        alert: false,
        detail: `${result.error ?? 'The pull request cannot merge.'}\nConflicting files: ${files.join(', ')}.`,
        fields: [],
        actions: [
          { id: 'cancel', label: 'Later' },
          { id: 'resolve', label: 'Resolve with agent', primary: true }
        ]
      },
      async (action) => {
        if (action.action !== 'resolve' || !this.chat) return
        const active = this.chat.get(this.chat.active || key)
        const facts = [
          'Resolve the Publish merge conflict in this chat worktree.',
          `Publish reported: ${result.error ?? 'pull request is not mergeable'}`,
          `Conflicting files: ${files.join(', ')}`,
          result.branch ? `Work branch: ${result.branch}` : '',
          result.url ? `Pull request: ${result.url}` : '',
          result.recoveryRefs?.length ? `Recovery refs: ${result.recoveryRefs.join(', ')}` : '',
          'Call pr_status and git_sync_base, resolve the conflict markers, then git_merge_continue and publish_update. Keep the chosen version consistent with the user’s changes.'
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

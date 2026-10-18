import { execFileSync } from 'node:child_process'
import { stubAgentSendForSmoke } from '../main/agent'
import { isolatedCwd } from '../main/chat-isolation'
import type { AgentEvent } from '../shared/api'
import type { ProviderReadinessMap } from '../shared/provider-readiness'
import type { NativeBridge } from './bridge'
import { landingChecks, nativeChat } from './chat-runtime'
import { serviceEvents } from './platform'
import { waitFor } from './smoke-wait'

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Make the project copy its own Git repository, so its chats get per-chat worktrees. */
export function initRepo(project: string) {
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'add', '-A')
  git(project, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@local', 'commit', '-qm', 'Fixture')
}

/** What one chat turn did, read back from the real pipeline. */
export interface ChatTurn {
  /** The prompt the provider received: the user's text plus any landing-check context. */
  received: string
  worktree: string
  branch: string
  /** The live checkout still matched HEAD when the turn's edit sat in the worktree. */
  liveUntouchedBeforeLanding: boolean
  /** The landing commit on the live checkout. */
  commit: { subject: string; files: string[]; chat: string }
  commitsAdded: number
}

/**
 * LKM-271: deterministic fixture-provider chat turns for a project. The real composer,
 * `agent:send`, per-chat worktree, landing and live commit all run; only the provider's
 * `send` is stubbed (`stubAgentSendForSmoke`, which also skips every other provider
 * one-shot), so no model is called. The stub applies `edit` to the chat's worktree
 * (never the live tree) and reports `done`.
 */
export class SwiftChatTurns {
  private provider: ReturnType<typeof stubAgentSendForSmoke> | undefined
  private next: ((prompt: string, worktree: string) => void) | null = null
  private failure: unknown
  private landing: ((channel: string, event: AgentEvent) => void) | undefined
  private saved:
    | { invoke: typeof nativeChat.services.invoke; readiness: ProviderReadinessMap }
    | undefined
  private seen: { received: string; worktree: string; branch: string; clean: boolean } | null = null

  constructor(
    private readonly host: NativeBridge,
    private readonly chat: string,
    private readonly project: string
  ) {}

  /** Stub the chat's provider once its session exists. */
  async attach() {
    // The composer stays disabled until a provider reads as signed in; the disposable
    // profile has none, so answer the sign-in probe only (nothing else is faked).
    const invoke = nativeChat.services.invoke
    this.saved = { invoke, readiness: structuredClone(nativeChat.readiness) }
    nativeChat.services.invoke = async (channel, ...args) =>
      channel === 'providers:check-login' ? { loggedIn: true } : invoke(channel, ...args)
    nativeChat.checkReadiness()
    await nativeChat.refreshReadiness()
    // The suite turns the post-landing check off (its other landings are fixtures), so
    // drive the real one exactly as the production hook in chat-runtime.ts does: when
    // the turn's merge reaches the live checkout, check the real preview.
    this.landing = (channel, event) => {
      if (channel !== 'agent:event' || event.projectKey !== this.chat) return
      if (event.sessionId || event.type !== 'isolation' || event.state !== 'merged') return
      const chat = nativeChat.chats.get(this.chat)
      if (chat)
        void landingChecks
          .landed(this.chat, chat.root, event.files ?? [], chat.messages.at(-1)?.id)
          .catch(() => {})
    }
    serviceEvents.on('event', this.landing)
    await waitFor(
      () => {
        try {
          this.provider = stubAgentSendForSmoke(this.chat, (text) => this.run(text))
          return true
        } catch {
          return false
        }
      },
      'chat provider session',
      60_000
    )
  }

  private edited() {
    if (!this.seen) throw new Error('The scripted turn did not run.')
    return this.seen
  }

  restore() {
    this.provider?.restore()
    this.provider = undefined
    if (this.landing) serviceEvents.off('event', this.landing)
    this.landing = undefined
    if (this.saved) {
      nativeChat.services.invoke = this.saved.invoke
      Object.assign(nativeChat.readiness, this.saved.readiness)
      this.saved = undefined
    }
  }

  private run(text: string) {
    const edit = this.next
    this.next = null
    void (async () => {
      try {
        if (!edit) throw new Error('The provider received a send no scripted turn expects.')
        const worktree = await isolatedCwd(this.project, this.chat)
        if (worktree === this.project) throw new Error('The chat has no worktree of its own.')
        const branch = git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')
        edit(text, worktree)
        const clean = git(this.project, 'diff', 'HEAD', '--stat') === ''
        this.seen = { received: text, worktree, branch, clean }
        this.provider?.emit({ type: 'done' })
      } catch (error) {
        this.failure = error
        this.provider?.emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })()
  }

  /** Send `prompt` through the composer; `edit` plays the model. Resolves once it landed. */
  async turn(
    prompt: string,
    edit: (received: string, worktree: string) => void
  ): Promise<ChatTurn> {
    if (!this.provider) throw new Error('Attach the provider stub first.')
    const commits = () => Number(git(this.project, 'rev-list', '--count', 'HEAD'))
    const before = commits()
    this.next = edit
    this.seen = null
    this.failure = undefined
    await this.host.request('composerPerform', { text: prompt })
    // Send is enabled only for a non-empty draft, so wait on it after typing.
    await waitFor(
      async () => {
        const composer = await this.host.request('composerInspect')
        return composer.text === prompt && composer.enabled
      },
      'the prompt in the composer with Send enabled',
      20_000
    )
    await this.host.request('composerPerform', { action: 'send' })
    // A failed scripted turn ends the wait at once (waitFor would swallow a throw).
    await waitFor(
      () => this.failure || this.seen,
      'the provider stub edited the chat worktree',
      60_000
    )
    if (this.failure) throw this.failure
    const seen = this.edited()
    await waitFor(
      () => this.failure || commits() > before,
      'the turn landed on the live checkout',
      60_000
    )
    if (this.failure) throw this.failure
    return {
      received: seen.received,
      worktree: seen.worktree,
      branch: seen.branch,
      liveUntouchedBeforeLanding: seen.clean,
      commit: {
        subject: git(this.project, 'log', '-1', '--format=%s'),
        files: git(this.project, 'show', '--name-only', '--format=', 'HEAD').split('\n'),
        chat: git(this.project, 'log', '-1', '--format=%(trailers:key=Trezi-Chat,valueonly)')
      },
      commitsAdded: commits() - before
    }
  }
}

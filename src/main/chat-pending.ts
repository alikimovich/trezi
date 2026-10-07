import type { AgentOptions } from '../shared/api'
import { productLog, truncate } from './product-log'

/**
 * LKM-182: chats shown before they are ready. "New chat" returns its session key at
 * once; the chat's worktree, provider session and owner record are prepared in the
 * background (`agent.ts`). Until then the chat is listed here, the workspace snapshot
 * shows it empty and idle, and its first send waits for whatever is still missing.
 * A failed preparation is retried by the next send; closing the chat (or its project)
 * marks it `closed` so the preparation tears down what it made.
 */
export interface PendingChat {
  readonly sessionKey: string
  readonly projectKey: string
  readonly root: string
  readonly options: AgentOptions
  readonly createdAt: number
  closed: boolean
}

interface Entry {
  chat: PendingChat
  run: Promise<void>
  failed: boolean
}

export class PendingChats {
  private entries = new Map<string, Entry>()

  constructor(private prepare: (chat: PendingChat) => Promise<void>) {}

  begin(sessionKey: string, projectKey: string, root: string, options: AgentOptions): PendingChat {
    const chat: PendingChat = {
      sessionKey,
      projectKey,
      root,
      options,
      createdAt: Date.now(),
      closed: false
    }
    this.entries.set(sessionKey, this.start(chat))
    return chat
  }

  private start(chat: PendingChat): Entry {
    const entry: Entry = { chat, run: Promise.resolve(), failed: false }
    entry.run = this.prepare(chat).then(
      () => {
        if (this.entries.get(chat.sessionKey) === entry) this.entries.delete(chat.sessionKey)
      },
      (error) => {
        entry.failed = true
        const message = error instanceof Error ? error.message : String(error)
        productLog.warn('chat', 'New chat preparation failed', {
          chat: chat.sessionKey,
          ms: Date.now() - chat.createdAt,
          error: truncate(message, 300)
        })
        throw error
      }
    )
    // A failure is reported to the send that waits for it, never as an unhandled rejection.
    entry.run.catch(() => {})
    return entry
  }

  has(sessionKey: string): boolean {
    return this.entries.has(sessionKey)
  }

  /** Every chat still being prepared. */
  list(): PendingChat[] {
    return [...this.entries.values()].map((entry) => entry.chat)
  }

  /** Resolves once the chat is ready (at once when it is not pending). Retries a failed
   *  preparation, and rejects when that fails too. */
  async wait(sessionKey: string): Promise<void> {
    let entry = this.entries.get(sessionKey)
    if (!entry) return
    if (entry.failed) {
      entry = this.start(entry.chat)
      this.entries.set(sessionKey, entry)
    }
    await entry.run
  }

  /** Close a pending chat; its preparation tears down what it made. */
  cancel(sessionKey: string): boolean {
    const entry = this.entries.get(sessionKey)
    if (!entry) return false
    entry.chat.closed = true
    this.entries.delete(sessionKey)
    return true
  }

  /** Close every pending chat of a project, or all of them. */
  cancelAll(projectKey?: string): void {
    for (const chat of this.list())
      if (projectKey === undefined || chat.projectKey === projectKey) this.cancel(chat.sessionKey)
  }
}

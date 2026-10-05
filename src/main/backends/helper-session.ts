import { randomUUID } from 'node:crypto'
import type { NativeView } from '../../native/platform'
import type { AgentEvent, AgentOptions } from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import { currentAgentFileAccess } from '../agent-file-access'
import { type HelperHandlers, providerOwner } from '../provider-owner'
import { runTreziTool, type SessionTool } from '../session-tools'
import { claudeProvider } from './claude'
import { claudeUserPluginsAllowed } from './claude-isolation'
import { codexProvider } from './codex'
import { geminiProvider } from './gemini'
import { createRecordCapture } from './record'
import { withSkillMenu } from './skill-menu'
import { sendToRenderer } from './tools'
import type {
  ModelProvider,
  PendingPrompt,
  PendingQuestion,
  ProviderSession,
  SpawnContext
} from './types'

const ignore = (): void => {}

const builtIn: Record<string, ModelProvider> = {
  claude: claudeProvider,
  codex: withSkillMenu(codexProvider),
  gemini: withSkillMenu(geminiProvider)
}

/**
 * A provider whose sessions run in a provider helper (S10): a separate process the
 * Swift owner spawns, supervises and holds to its grant (`ProviderHelper.swift`).
 * Bun sees an ordinary `ProviderSession`; every command goes through the owner and
 * every event, record delta and tool call comes back from it already validated.
 * Trezi's tools run here, in Bun, after the owner authorized them.
 */
export function helperProvider(id: string): ModelProvider {
  const adapter = builtIn[id]
  return {
    id,
    host: 'helper',
    supportsSpawn: adapter?.supportsSpawn ?? true,
    generateTitle: adapter?.generateTitle,
    updateProjectMemory: adapter?.updateProjectMemory,
    startSession: (root, options, getWindow, ctx) =>
      startHelperSession(id, root, options, getWindow, ctx)
  }
}

async function startHelperSession(
  provider: string,
  root: string,
  options: AgentOptions,
  getWindow: () => NativeView | null,
  ctx?: SpawnContext
): Promise<ProviderSession> {
  const owner = providerOwner()
  let session = randomUUID()
  const key = projectKey(root)
  const emitKey = ctx?.emitKey ?? key
  const cap = createRecordCapture(root, key)
  const record = cap.record
  const pending = new Map<string, PendingPrompt>()
  const pendingQuestions = new Map<string, PendingQuestion>()
  let disposed = false
  let gone: string | null = null
  let reportedResume: string | undefined

  const emit = (event: AgentEvent): void => {
    if (disposed) return
    const tagged = {
      ...event,
      projectKey: emitKey,
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {})
    }
    ctx?.onEvent?.(tagged)
    sendToRenderer(getWindow, 'agent:event', tagged)
  }
  const scope = {
    root,
    liveRoot: ctx?.liveRoot ?? root,
    emitKey,
    background: !!ctx?.sessionId,
    connectionId: options.connectionId,
    notify: (channel: string, payload: unknown): void => sendToRenderer(getWindow, channel, payload)
  }

  const handlers: HelperHandlers = {
    event: (event) => {
      if (event.type === 'permission-request') {
        const id = event.request.id
        pending.set(id, {
          toolName: event.request.toolName,
          settle: (behavior) => {
            pending.delete(id)
            void owner.answer(session, id, 'permission', behavior).catch(ignore)
          }
        })
      } else if (event.type === 'question-request') {
        const id = event.request.id
        pendingQuestions.set(id, {
          settle: (answers) => {
            pendingQuestions.delete(id)
            void owner.answer(session, id, 'question', answers).catch(ignore)
          }
        })
      } else if (event.type === 'permission-resolved') pending.delete(event.id)
      else if (event.type === 'question-resolved') pendingQuestions.delete(event.id)
      emit(event)
    },
    record: (delta) => {
      record.transcript.push(...delta.entries)
      if (delta.filesTouched)
        record.filesTouched = [...new Set([...record.filesTouched, ...delta.filesTouched])]
      if (delta.sdkSessionId && delta.sdkSessionId !== reportedResume) {
        reportedResume = delta.sdkSessionId
        record.sdkSessionId = delta.sdkSessionId
        void owner.resume(session, delta.sdkSessionId, record.id).catch(ignore)
      }
    },
    // Already authorized by the owner against this helper's grant (LKM-131: the helper's
    // adapters send every tool that needs main's state here).
    tool: (tool, args) => runTreziTool(tool as SessionTool, args, scope),
    exit: (reason) => {
      gone = reason
    }
  }

  const open = (resume: string | undefined): Promise<unknown> =>
    owner.openHelper(
      {
        session,
        chat: emitKey,
        provider,
        root,
        liveRoot: ctx?.liveRoot ?? root,
        background: !!ctx?.sessionId
      },
      {
        options: {
          ...options,
          ...(provider === 'claude' ? { claudeUserPlugins: claudeUserPluginsAllowed() } : {}),
          agentFileAccess: currentAgentFileAccess()
        },
        context: {
          emitKey,
          ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(resume ? { resumeSessionId: resume } : {}),
          ...(ctx?.liveRoot ? { liveRoot: ctx.liveRoot } : {}),
          ...(ctx?.projectMemory ? { projectMemory: ctx.projectMemory } : {})
        }
      },
      handlers
    )
  await open(ctx?.resumeSessionId)

  /** A turn the helper can no longer take still ends: one `error`, one `done`. */
  const refuse = (message: string): void => {
    emit({ type: 'error', message })
    emit({ type: 'done' })
  }

  // After its helper stopped (a crash, or the owner ending a turn that never answered,
  // LKM-119), an interactive chat's next message starts a new helper on the same
  // conversation. A helper that broke its grant, or a background run's, is not restarted.
  let reopening: Promise<void> | null = null
  const reopen = (): Promise<void> => {
    reopening ??= (async () => {
      void owner.close(session).catch(ignore)
      session = randomUUID()
      gone = null
      await open(reportedResume ?? ctx?.resumeSessionId)
    })().finally(() => {
      reopening = null
    })
    return reopening
  }

  return {
    key,
    root,
    options,
    send: (text, images) => {
      if (gone && (gone === 'violation' || ctx?.sessionId)) {
        return refuse(`The provider helper is not running (${gone}). Start a new chat to continue.`)
      }
      void (gone || reopening ? reopen() : Promise.resolve())
        .then(() => owner.send(session, text, images))
        .catch((error) => refuse(error instanceof Error ? error.message : String(error)))
    },
    pending,
    pendingQuestions,
    emit,
    record,
    // Assistant text is flushed into the record by the helper, before each terminal event.
    finalize: () => {},
    dispose: () => {
      disposed = true
    },
    shutdown: () => {
      void owner.close(session).catch(ignore)
    },
    setModel: async (model) => {
      await owner.configure(session, { model })
    },
    setPermissionMode: async (mode) => {
      await owner.configure(session, { mode })
    },
    // The owner holds the deadline and kills the helper itself; it has then already
    // ended the turn (an `error`, one `done`), so the chat only needs rebuilding.
    interrupt: async () => {
      const { escalate } = await owner.cancel(session).catch(() => ({ escalate: false }))
      return escalate ? { hardStopped: true } : undefined
    }
  }
}

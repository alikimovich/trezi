import { randomUUID } from 'node:crypto'
import type { NativeView } from '../../native/platform'
import type { AgentEvent, AgentOptions } from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import { currentAgentFileAccess } from '../agent-file-access'
import { currentAgentGitAccess } from '../agent-git-access'
import { type HelperHandlers, providerOwner } from '../provider-owner'
import { fallbackCandidate, fallbackOptions, fallbackProvider } from '../self-heal/fallback'
import { fallbackNote } from '../self-heal/status'
import { runTreziTool, type SessionTool } from '../session-tools'
import { claudeProvider } from './claude'
import { claudeUserPluginsAllowed } from './claude-isolation'
import { resumeSummary } from './claude-resume'
import { codexProvider } from './codex'
import { handoffPrompt } from './conversation-handoff'
import { geminiProvider } from './gemini'
import { createRecordCapture } from './record'
import { withSkillMenu } from './skill-menu'
import { sendToRenderer } from './tools'
import { createTurnRecovery } from './turn-recovery'
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
    complete: adapter?.complete,
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
  // LKM-225: a turn the original provider could not connect for runs on the other one; the
  // chat keeps its own provider and returns to it on the next message.
  let active = provider
  let activeOptions = options
  const onFallback = (): boolean => active !== provider
  const exitWaiters: Array<() => void> = []
  let recovery: ReturnType<typeof createTurnRecovery> | null = null

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
      if (!recovery?.event(event)) emit(event)
    },
    record: (delta) => {
      record.transcript.push(...delta.entries)
      if (delta.filesTouched)
        record.filesTouched = [...new Set([...record.filesTouched, ...delta.filesTouched])]
      // A fallback provider's own session id is not the chat's resumable one.
      if (!onFallback() && delta.sdkSessionId && delta.sdkSessionId !== reportedResume) {
        reportedResume = delta.sdkSessionId
        record.sdkSessionId = delta.sdkSessionId
        if (delta.sdkCwd) record.sdkCwd = delta.sdkCwd
        void owner.resume(session, delta.sdkSessionId, record.id).catch(ignore)
      }
    },
    // Already authorized by the owner against this helper's grant (LKM-131: the helper's
    // adapters send every tool that needs main's state here).
    tool: (tool, args) => runTreziTool(tool as SessionTool, args, scope),
    exit: (reason) => {
      gone = reason
      for (const wake of exitWaiters.splice(0)) wake()
    }
  }

  const open = (resume: string | undefined, summary = ctx?.resumeSummary): Promise<unknown> =>
    owner.openHelper(
      {
        session,
        chat: emitKey,
        provider: active,
        root,
        liveRoot: ctx?.liveRoot ?? root,
        background: !!ctx?.sessionId
      },
      {
        options: {
          ...activeOptions,
          ...(active === 'claude' ? { claudeUserPlugins: claudeUserPluginsAllowed() } : {}),
          agentFileAccess: currentAgentFileAccess(),
          agentGitAccess: currentAgentGitAccess()
        },
        context: {
          emitKey,
          ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(resume ? { resumeSessionId: resume } : {}),
          ...(resume && summary ? { resumeSummary: summary } : {}),
          ...(resume && (record.sdkCwd ?? ctx?.resumeCwd)
            ? { resumeCwd: record.sdkCwd ?? ctx?.resumeCwd }
            : {}),
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
      // A resume that fails starts from what the chat showed so far (LKM-165).
      await open(reportedResume ?? ctx?.resumeSessionId, resumeSummary(record))
    })().finally(() => {
      reopening = null
    })
    return reopening
  }

  /** The recorded conversation (without the message being sent) ahead of `text`. */
  const withHistory = (text: string): string => {
    const turns = record.transcript
    return handoffPrompt(turns.at(-1)?.role === 'user' ? turns.slice(0, -1) : turns, text)
  }

  recovery = createTurnRecovery({
    emit,
    interactive: !ctx?.sessionId,
    canFallback: () => !onFallback() && fallbackCandidate(provider, options) !== null,
    exited: () =>
      gone
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000)
            timer.unref?.()
            exitWaiters.push(() => {
              clearTimeout(timer)
              resolve()
            })
          }),
    canRestart: () => gone !== 'violation' && !onFallback(),
    restart: async (text, images) => {
      await reopen()
      await owner.send(session, text, images)
    },
    fallback: async (text, images) => {
      const to = await fallbackProvider(provider, options, root)
      if (!to) return false
      void owner.close(session).catch(ignore)
      session = randomUUID()
      gone = null
      active = to
      activeOptions = fallbackOptions(options, to)
      try {
        await open(undefined, undefined)
      } catch (error) {
        active = provider
        activeOptions = options
        throw error
      }
      emit({ type: 'status', text: fallbackNote(provider, to) })
      await owner.send(session, withHistory(text), images)
      return true
    }
  })

  return {
    key,
    root,
    options,
    send: (text, images) => {
      if (gone && (gone === 'violation' || ctx?.sessionId)) {
        return refuse(`The provider helper is not running (${gone}). Start a new chat to continue.`)
      }
      recovery?.begin(text, images)
      // After a fallback turn the chat goes back to its own provider, which has not seen that
      // turn: it gets the recorded conversation once, like after a model switch.
      const back = onFallback()
      if (back) {
        active = provider
        activeOptions = options
      }
      void (back || gone || reopening ? reopen() : Promise.resolve())
        .then(() => owner.send(session, back ? withHistory(text) : text, images))
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
      recovery?.stop()
      const { escalate } = await owner.cancel(session).catch(() => ({ escalate: false }))
      return escalate ? { hardStopped: true } : undefined
    }
  }
}

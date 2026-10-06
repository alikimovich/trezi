import { projectKey } from '../shared/projectKey'
import type { Revision } from '../shared/service-contract/types'
import { withoutProvenance } from './project-memory-format'

/** Project memory is intentionally small: it is injected into model context. */
export const MAX_PROJECT_MEMORY_CHARS = 16_000

export interface ProjectMemory {
  content: string
  updatedAt: number
  /** SHA-256 of the file's bytes, or `absent`: the version this snapshot is. */
  digest: string
  /** The owner's revision for this project. */
  revision?: Revision
}

/**
 * The owner of project memory: the Swift service (S05, `project-memory-service.ts`),
 * the only writer since LKM-111 (the file format is `MemoryFile.swift`). `save` is the
 * editor's manual save, the user's final override. `propose` is a generated
 * evaluation: it commits only if memory is still the `base` it was evaluated
 * against, and answers `null` (stale) otherwise, so it can never overwrite a
 * manual save made while the model was running. `restore` is Undo of an automatic
 * update: it writes `content` (which may be empty) only while memory is still the
 * `after` that update committed, and answers `null` when anything changed since.
 */
export interface ProjectMemoryStore {
  get: (root: string) => Promise<ProjectMemory>
  save: (root: string, content: string) => Promise<ProjectMemory>
  propose: (root: string, base: ProjectMemory, content: string) => Promise<ProjectMemory | null>
  restore: (root: string, after: ProjectMemory, content: string) => Promise<ProjectMemory | null>
}

/** An automatic update the owner committed: what memory was, and what it is now. */
export interface ProjectMemoryUpdate {
  root: string
  before: ProjectMemory
  after: ProjectMemory
}

export interface ProjectMemoryUpdateQueue {
  enqueue: (
    root: string,
    evaluate: (currentMemory: string) => Promise<string | null>
  ) => Promise<void>
}

export class ProjectMemoryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** The editor's value as stored: trimmed, then bounded. */
export const normalizeProjectMemory = (content: string): string =>
  content.trim().slice(0, MAX_PROJECT_MEMORY_CHARS)

/**
 * Serialize automatic memory evaluations per project. Each evaluator reads the
 * latest merged memory when its turn starts, so two peer chats cannot overwrite
 * one another. The owner refuses a proposal whose base is no longer current, which
 * protects a manual editor save made while a model call is in flight; the
 * evaluation retries against that new authoritative value instead of clobbering it.
 * `updated` hears each committed change (the "Project memory updated" note).
 */
export function createProjectMemoryUpdateQueue(
  store: ProjectMemoryStore,
  updated?: (update: ProjectMemoryUpdate) => void
): ProjectMemoryUpdateQueue {
  const chains = new Map<string, Promise<void>>()

  const enqueue = (
    root: string,
    evaluate: (currentMemory: string) => Promise<string | null>
  ): Promise<void> => {
    const key = projectKey(root)
    const prior = chains.get(key) ?? Promise.resolve()
    const run = prior
      .catch(() => {})
      .then(async () => {
        // One retry is enough to preserve a concurrent manual edit without
        // allowing a busy editor to trigger an unbounded series of model calls.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const before = await store.get(root)
          const next = await evaluate(before.content)
          if (next === null || next.trim() === before.content.trim()) return
          const after = await store.propose(root, before, next)
          if (!after) continue
          if (after.content.trim() !== before.content.trim()) {
            try {
              updated?.({ root, before, after })
            } catch {
              /* a note is never worth failing the update for */
            }
          }
          return
        }
      })
      .catch(() => {
        /* best-effort: chat completion must never fail because memory did */
      })

    chains.set(key, run)
    void run.finally(() => {
      if (chains.get(key) === run) chains.delete(key)
    })
    return run
  }

  return { enqueue }
}

/**
 * Which memory version each live provider session already carries. Memory is part
 * of a session's initial instructions; if it changes while the session stays open,
 * the new version is injected once, on its next turn. Unreadable memory (damaged
 * file, owner unavailable) is no memory: it never fails a chat, and the session
 * records no version, so memory is injected as soon as it can be read. The map is
 * chat state (S11); the versions are the owner's digests.
 */
export function createProjectMemoryInjection(store: () => ProjectMemoryStore) {
  const known = new Map<string, string>()
  const read = (root: string) =>
    store()
      .get(root)
      .catch(() => null)
  return {
    /** Memory for a new session's instructions. */
    async context(root: string, session: string | null): Promise<string> {
      const memory = await read(root)
      if (session) {
        if (memory) known.set(session, memory.digest)
        else known.delete(session)
      }
      return memory?.content ?? ''
    },
    /** The turn's prompt, carrying memory only if it changed since the session saw it. */
    async prompt(root: string, session: string | undefined, text: string): Promise<string> {
      const memory = await read(root)
      if (!memory) return text
      const changed = !session || memory.digest !== known.get(session)
      if (session) known.set(session, memory.digest)
      return changed ? projectMemoryUpdate(memory.content, text) : text
    },
    forget: (session: string) => known.delete(session),
    clear: () => known.clear()
  }
}

/**
 * A bounded, clearly-delimited rules section shared by every provider. Source tags
 * stay in the stored memory; a chat sees only the rules.
 */
export function projectMemoryRules(content: string): string[] {
  const memory = withoutProvenance(content.trim().slice(0, MAX_PROJECT_MEMORY_CHARS)).trim()
  if (!memory) return []
  return [
    '',
    '## Project memory',
    'Trezi stores the following durable project rules separately from this chat.',
    'Treat them as standing context. If a current user request contradicts them, follow',
    'the current request and call out that the saved memory may need updating.',
    'A rule here is not a change to the code: if it describes something the code does',
    'not do yet, make the change rather than assume it is done.',
    '',
    '<project-memory>',
    memory,
    '</project-memory>'
  ]
}

/** One-time update injected when memory changed after a live session started. */
export function projectMemoryUpdate(content: string, prompt: string): string {
  const lines = projectMemoryRules(content)
  const update = lines.length
    ? lines.join('\n')
    : [
        '## Project memory update',
        'Trezi project memory is now empty. Do not treat earlier saved memory as standing context.'
      ].join('\n')
  return `${update}\n\n---\n\n${prompt}`
}

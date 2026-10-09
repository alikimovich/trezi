import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Annotation, AnnotationInput } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import type { SidecarCommit } from './editing-owner'
import { editingOwner } from './editing-owner'
import { contentHash } from './source-owner'

/**
 * Annotation storage (S05), separate from publication (`annotations.ts`, S13).
 * Reviewer notes are pinned to elements in `<repo>/.trezi/annotations.json`, a
 * sidecar the agent may not write. This module reads the file and renders the next
 * list; it runs no Git and publishes nothing. Since S15 it no longer writes: the
 * editing owner commits the new text only if the file still holds the bytes read
 * here, in the repository lane (the Swift service, the only writer since LKM-111). See
 * docs/SWIFT-BACKEND-RETIREMENT.md.
 */

export const MAX_ANNOTATION_TEXT = 2000

export class AnnotationStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface AnnotationStore {
  /** The notes as stored. A damaged file rejects instead of reading as empty. */
  list: (root: string) => Promise<Annotation[]>
  add: (root: string, input: AnnotationInput) => Promise<Annotation[]>
  remove: (root: string, id: string) => Promise<Annotation[]>
}

const file = (root: string): string => join(root, '.trezi', 'annotations.json')
const isNote = (value: unknown): value is Annotation =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Annotation).id === 'string' &&
  typeof (value as Annotation).text === 'string'

type Commit = (root: string, expectedHash: string | null, content: string) => Promise<SidecarCommit>

/** A hand edit between read and commit is re-read and the change re-applied, this often. */
const ATTEMPTS = 3

export function createAnnotationStore(
  options: { now?: () => Date; newId?: () => string; commit?: Commit } = {}
): AnnotationStore {
  let counter = 0
  const now = options.now ?? (() => new Date())
  const newId =
    options.newId ?? ((): string => `a${Date.now().toString(36)}${(counter++).toString(36)}`)
  const commit: Commit =
    options.commit ??
    ((root, expectedHash, content) =>
      editingOwner().sidecar(root, 'annotations.json', expectedHash, content))

  /**
   * Every entry exactly as stored, so a write never drops what it does not
   * understand. Absent is empty; anything but a JSON array is damaged and is
   * never replaced (the pre-S05 reader read it as empty and the next note
   * overwrote every earlier one).
   */
  const read = async (root: string): Promise<{ list: unknown[]; hash: string | null }> => {
    let raw: Buffer
    try {
      raw = await readFile(file(root))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { list: [], hash: null }
      throw new AnnotationStoreError('ioFailure', `Notes could not be read (${String(error)}).`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      parsed = null
    }
    if (!Array.isArray(parsed)) {
      throw new AnnotationStoreError(
        'recoveryRequired',
        '.trezi/annotations.json is not a valid notes file. It was left untouched; fix or remove it, then try again.'
      )
    }
    return { list: parsed, hash: contentHash(raw) }
  }

  /**
   * Read, apply `change` and commit against the bytes read (the owner writes
   * atomically). `change` returns null when nothing changes, so nothing is written.
   * A file edited in between is read again, never overwritten.
   */
  const update = async (
    root: string,
    change: (list: unknown[]) => unknown[] | null
  ): Promise<unknown[]> => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { list, hash } = await read(root)
      const next = change(list)
      if (!next) return list
      const result = await commit(root, hash, `${JSON.stringify(next, null, 2)}\n`)
      if (result.ok) return next
    }
    throw new AnnotationStoreError(
      'conflict',
      '.trezi/annotations.json kept changing while saving; nothing was written. Try again.'
    )
  }

  // Two IPC calls can interleave at their awaits. Serialize each project's
  // operations, reads included, so read-modify-write is atomic and a read issued
  // after a write sees it.
  const chains = new Map<string, Promise<unknown>>()
  const serialize = <T>(root: string, task: () => Promise<T>): Promise<T> => {
    const key = projectKey(root)
    const run = (chains.get(key) ?? Promise.resolve()).then(task, task)
    const settled = run.catch(() => undefined)
    chains.set(key, settled)
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key)
    })
    return run
  }
  const notes = (list: unknown[]): Annotation[] => list.filter(isNote)

  return {
    list: (root) => serialize(root, async () => notes((await read(root)).list)),
    add: (root, input) =>
      serialize(root, async () => {
        const text = typeof input?.text === 'string' ? input.text.trim() : ''
        if (!text) return notes((await read(root)).list)
        const annotation: Annotation = {
          id: newId(),
          source: input.source,
          selector: input.selector,
          tag: input.tag,
          text: text.slice(0, MAX_ANNOTATION_TEXT),
          createdAt: now().toISOString()
        }
        return notes(await update(root, (list) => [...list, annotation]))
      }),
    remove: (root, id) =>
      serialize(root, async () =>
        notes(
          await update(root, (list) => {
            const next = list.filter((entry) => !(isNote(entry) && entry.id === id))
            return next.length === list.length ? null : next
          })
        )
      )
  }
}

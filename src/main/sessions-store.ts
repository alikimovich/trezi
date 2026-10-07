import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRecord } from '../shared/api'
import { migrateChatTitle } from '../shared/chat-title'
import { type ConversationOwner, swiftConversationOwner } from './conversation-owner'

/**
 * On-disk store for agent-session history (v5-D "previous agents"). One JSON
 * file per record under `<baseDir>/sessions/`, so writes are incremental and a
 * corrupt record can't take the index down. Records are keyed by `id`; listing a
 * project reads the dir and filters by `projectKey`.
 *
 * `baseDir` is injected (the app passes its profile's session directory); tests
 * point it at the conversation fixture's profile.
 *
 * The service's conversation coordinator (S11) is the only writer of this directory
 * (LKM-111 removed Bun's direct writes): `save`/`saveCurrent`/`remove` hand the
 * record to it (it caps History at 50 per project and replaces the current slot) and
 * reads come from disk, which it writes atomically. Until a write is acknowledged it
 * is kept in an overlay, so a synchronous read right after it (park records,
 * `current`) sees it. A write the service refuses is logged and dropped — History is
 * non-critical, as before. With no service, writes throw.
 */
export interface SessionStore {
  save: (rec: SessionRecord) => void
  /** Persist this as the project's last-active chat, replacing the previous
   *  current slot so a relaunch restores one conversation rather than stacking them. */
  saveCurrent: (rec: SessionRecord) => void
  list: (projectKey: string) => SessionRecord[]
  /** Current record for a project, including the legacy `slot: 'main'` shape. */
  current: (projectKey: string) => SessionRecord | null
  get: (id: string) => SessionRecord | null
  /** Every saved record of every project (LKM-202: the Dreamer's digest). */
  all: () => SessionRecord[]
  remove: (id: string) => void
  /** Settles once every write so far is acknowledged (on disk). */
  flush: () => Promise<void>
}

// Reject absurd ids defensively — the id becomes a filename.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const isCurrent = (rec: SessionRecord): boolean => rec.slot === 'current' || rec.slot === 'main'
const writer = (): ConversationOwner => {
  const owner = swiftConversationOwner()
  if (!owner) throw new Error('Trezi’s service is not running, so chat history cannot be saved.')
  return owner
}

export function createSessionStore(baseDir: string): SessionStore {
  const dir = join(baseDir, 'sessions')
  // id → the record (or null: removed) a Swift write has not acknowledged yet.
  const overlay = new Map<string, { value: SessionRecord | null; version: number }>()
  const writes = new Set<Promise<void>>()
  let versions = 0
  const pend = (id: string, value: SessionRecord | null, write: Promise<void>): void => {
    const version = ++versions
    overlay.set(id, { value: value && structuredClone(value), version })
    const settled = write
      .catch((error) =>
        console.error(
          `Trezi could not save chat history (${id}):`,
          error instanceof Error ? error.message : error
        )
      )
      .finally(() => {
        if (overlay.get(id)?.version === version) overlay.delete(id)
        writes.delete(settled)
      })
    writes.add(settled)
  }
  const fileFor = (id: string): string => join(dir, `${id}.json`)
  // LKM-120: a title that came from an error or sign-in prompt is renamed to the
  // neutral one when the record is loaded. Without a service it is only shown neutral.
  const migrate = (rec: SessionRecord): SessionRecord => {
    const title = migrateChatTitle(rec.title)
    if (!title || title === rec.title || !SAFE_ID.test(rec.id)) return rec
    rec.title = title
    try {
      pend(
        rec.id,
        rec,
        writer()
          .rename(rec.id, title)
          .then(() => {})
      )
    } catch {}
    return rec
  }

  const readAll = (): SessionRecord[] => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      names = []
    }
    const out: SessionRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      if (overlay.has(name.slice(0, -5))) continue
      try {
        const rec = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SessionRecord
        // A renamed record now sits in the overlay, which is added below.
        if (rec && typeof rec.id === 'string' && !overlay.has(migrate(rec).id)) out.push(rec)
      } catch {
        // Skip an unreadable/partial record rather than failing the whole list.
      }
    }
    for (const { value } of overlay.values()) if (value) out.push(structuredClone(value))
    return out
  }

  const save = (rec: SessionRecord): void => {
    if (!SAFE_ID.test(rec.id)) throw new Error(`unsafe session id: ${rec.id}`)
    pend(rec.id, rec, writer().save(rec))
  }

  const saveCurrent = (rec: SessionRecord): void => {
    rec.slot = 'current'
    if (!SAFE_ID.test(rec.id)) throw new Error(`unsafe session id: ${rec.id}`)
    // The service replaces the other current record itself, in the same write.
    const write = writer().save(rec, true)
    for (const old of readAll().filter(
      (r) => r.projectKey === rec.projectKey && isCurrent(r) && r.id !== rec.id
    ))
      pend(old.id, null, write)
    pend(rec.id, rec, write)
  }

  const list = (projectKey: string): SessionRecord[] =>
    readAll()
      .filter((r) => r.projectKey === projectKey)
      .sort((a, b) => b.startedAt - a.startedAt)

  const current = (projectKey: string): SessionRecord | null =>
    list(projectKey).find(isCurrent) ?? null

  const get = (id: string): SessionRecord | null => {
    if (!SAFE_ID.test(id)) return null
    const pending = overlay.get(id)
    if (pending) return pending.value && structuredClone(pending.value)
    try {
      const rec = JSON.parse(readFileSync(fileFor(id), 'utf8')) as SessionRecord
      return rec && typeof rec.id === 'string' ? migrate(rec) : rec
    } catch {
      return null
    }
  }

  const remove = (id: string): void => {
    if (!SAFE_ID.test(id)) return
    pend(id, null, writer().remove(id))
  }

  const flush = async (): Promise<void> => {
    await Promise.all([...writes])
  }

  return { save, saveCurrent, list, current, get, all: readAll, remove, flush }
}

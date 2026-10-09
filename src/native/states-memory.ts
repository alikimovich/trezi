import {
  normalizeRecords,
  pruneRecords,
  sourceFile,
  storeRecords,
  type WorkbenchOrigin,
  type WorkbenchRecord,
  type WorkbenchRecords
} from '../shared/states-records'
import type { Workbench } from '../shared/states-workbench'

/** The preference holding every project's records (`STATES_RECORDS_PREFERENCE`). */
export interface WorkbenchRecordStore {
  read(): string | null
  write(update: (raw: string | null) => string | null): Promise<void>
}

/** How long a Show states request waits for its workbench to land. */
const PENDING_MS = 60 * 60 * 1000

/**
 * LKM-220: the per-project workbench records (origin page, last state, chat). Reads are
 * synchronous from a mirror of the preference; every change is written through, so the
 * records survive a restart. `reconcile` runs after each scan: it prunes the records of
 * folders that are gone and gives a newly found workbench the page Show states was asked
 * on.
 */
export class WorkbenchMemory {
  private mirror: WorkbenchRecords | null = null
  private readonly pending = new Map<
    string,
    { origin: WorkbenchOrigin; chat?: string; at: number }
  >()
  private readonly pages = new Map<string, string>()
  constructor(
    readonly store: WorkbenchRecordStore | undefined,
    readonly report: (error: unknown) => void,
    readonly now: () => number = Date.now
  ) {}

  private get records(): WorkbenchRecords {
    this.mirror ??= normalizeRecords(this.store?.read() ?? null)
    return this.mirror
  }
  all(root: string): Record<string, WorkbenchRecord> {
    return this.records[root] ?? {}
  }
  get(root: string, folder: string): WorkbenchRecord | undefined {
    return this.all(root)[folder]
  }
  /** Forgets the mirror: the next read takes the stored preference again (a reopened project). */
  reload() {
    this.mirror = null
  }

  private save(root: string, next: Record<string, WorkbenchRecord>) {
    if (JSON.stringify(next) === JSON.stringify(this.all(root))) return
    this.mirror = storeRecords(this.records, root, next)
    void this.store
      ?.write((raw) => {
        const stored = storeRecords(normalizeRecords(raw), root, next)
        return Object.keys(stored).length ? JSON.stringify(stored) : null
      })
      .catch(this.report)
  }

  update(root: string, folder: string, patch: Partial<WorkbenchRecord>) {
    const current = this.get(root, folder) ?? {}
    const merged = { ...current, ...patch }
    for (const key of Object.keys(merged) as (keyof WorkbenchRecord)[])
      if (merged[key] === undefined) delete merged[key]
    this.save(root, { ...this.all(root), [folder]: merged })
  }

  /** Show states asked the agent for a workbench from this page: the next new one gets it. */
  expect(root: string, origin: WorkbenchOrigin, chat?: string) {
    this.pending.set(root, { origin, ...(chat ? { chat } : {}), at: this.now() })
  }

  /** The page the preview showed before the current one, outside any workbench. */
  page(root: string, url: string) {
    this.pages.set(root, url)
  }
  lastPage(root: string): string | undefined {
    return this.pages.get(root)
  }

  /**
   * After a scan of `root`: records of deleted folders go, and a workbench that was not
   * in the previous list (or whose component source the request named) takes the
   * pending Show states origin and its chat.
   */
  reconcile(root: string, benches: readonly Workbench[], before: readonly Workbench[] | null) {
    let next = pruneRecords(this.all(root), benches)
    const pending = this.pending.get(root)
    if (pending && this.now() - pending.at > PENDING_MS) this.pending.delete(root)
    const wanted = this.pending.get(root)
    if (wanted) {
      const files = [wanted.origin.selection?.source, wanted.origin.selection?.componentSource]
        .map((source) => sourceFile(source, root))
        .filter(Boolean)
      const fresh = benches.filter((bench) => !next[bench.folder]?.origin)
      const bench =
        fresh.find((b) => files.includes(sourceFile(b.source, root))) ??
        (before ? fresh.find((b) => !before.some((old) => old.folder === b.folder)) : undefined)
      if (bench) {
        this.pending.delete(root)
        const chat = wanted.chat ?? bench.chat
        next = {
          ...next,
          [bench.folder]: {
            ...next[bench.folder],
            origin: wanted.origin,
            ...(chat ? { chat } : {})
          }
        }
      }
    }
    this.save(root, next)
  }
}

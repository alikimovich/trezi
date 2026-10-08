import { findLeftovers, scanWorkbenches } from '../main/states-workbench'
import type { FileOpResult } from '../shared/api'
import type { NativeSheetAction, NativeSheetState } from '../shared/native-sheet'
import { PREVIEW_STATES, PREVIEW_STATES_SWITCH } from '../shared/preview-channels'
import {
  ALL_STATES,
  matchWorkbench,
  STATE_PARAM,
  type StatesView,
  stateUrl,
  stepState,
  type Workbench
} from '../shared/states-workbench'

export interface StatesServices {
  send: (command: 'statesState' | 'workbenches', payload: unknown) => void
  preview: (channel: string, payload: unknown) => void
  active: () => { root: string; url?: string | null } | null
  load: (url: string) => Promise<unknown>
  sheets: {
    present(
      state: Omit<NativeSheetState, 'id' | 'busy'>,
      handle: (action: NativeSheetAction) => Promise<void>
    ): void
    close(): void
  }
  log: (text: string, kind?: 'error') => void
  remove: (root: string, folder: string, seams: string[]) => Promise<FileOpResult>
  scan?: (root: string) => Promise<Workbench[]>
  now?: () => number
  leftovers?: (root: string, workbench: Workbench) => Promise<string[]>
}

/** Minimum gap between same-path rescans triggered by preview loads. */
const RESCAN_MS = 1500

export interface StatesAction {
  action: string
  id?: string
}

/**
 * The states workbench (LKM-207). The preview URL decides everything: on a recorded
 * workbench route the host shows the switcher island and the preload takes ←/→, 1-9
 * and H. Switching is a replaceState in the page (`states-switch.ts`); the URL change
 * that follows re-syncs the island. Workbenches are only removed by a user action.
 */
export class NativeStatesController {
  readonly lists = new Map<string, Workbench[]>()
  view: StatesView | null = null
  hidden = false
  private location: string | null = null
  private path: string | null = null
  private sent = ''
  private ids = ''
  private scannedAt = 0
  constructor(readonly services: StatesServices) {}

  workbenches(root = this.services.active()?.root): Workbench[] {
    return (root && this.lists.get(root)) || []
  }

  async refresh(root = this.services.active()?.root): Promise<Workbench[]> {
    if (!root) return []
    this.scannedAt = (this.services.now ?? Date.now)()
    const list = await (this.services.scan ?? scanWorkbenches)(root)
    this.lists.set(root, list)
    this.sync()
    return list
  }

  /** A turn landed files in `root`: a workbench may have appeared, even in a background project. */
  landed(root: string) {
    void this.refresh(root).catch((error) => this.services.log(String(error), 'error'))
  }

  /** The preview's URL changed (a load, or a replaceState from switching). */
  url(url: string | null) {
    this.location = url
    let path: string | null = null
    try {
      path = url ? new URL(url).pathname : null
    } catch {}
    // A new route may be a workbench that just landed. State switches only change the query;
    // a same-path reload (files landing under the open route) rescans while no recorded
    // workbench matches, at most once per RESCAN_MS.
    const known = !!url && !!matchWorkbench(url, this.workbenches())
    const stale = (this.services.now ?? Date.now)() - this.scannedAt > RESCAN_MS
    if (path !== this.path || (!known && stale)) {
      this.path = path
      void this.refresh().catch((error) => this.services.log(String(error), 'error'))
    }
    // A load replaces the page's preload, which forgets the state ids: tell it again.
    this.sync(true)
  }

  sync(page = false) {
    const list = this.workbenches()
    const match = this.location ? matchWorkbench(this.location, list) : null
    if (!match) this.hidden = false
    this.view = match
      ? {
          folder: match.workbench.folder,
          component: match.workbench.component,
          states: match.workbench.states,
          missing: match.workbench.missing,
          current: match.current,
          hidden: this.hidden
        }
      : null
    const items = list.map(({ folder, component, route }) => ({ folder, component, route }))
    const next = JSON.stringify([this.view, items])
    if (next !== this.sent) {
      this.sent = next
      this.services.send('statesState', { state: this.view })
      this.services.send('workbenches', { items })
    }
    const ids = this.view ? { ids: this.view.states.map((s) => s.id) } : null
    if (!page && JSON.stringify(ids) === this.ids) return
    this.ids = JSON.stringify(ids)
    this.services.preview(PREVIEW_STATES, ids)
  }

  async action({ action, id }: StatesAction) {
    const view = this.view
    if (action === 'select' && view && id) return this.switch(id)
    if (action === 'all' && view)
      return this.switch(view.current === ALL_STATES ? view.states[0].id : ALL_STATES)
    if ((action === 'next' || action === 'prev') && view)
      return this.switch(stepState(view, action === 'next' ? 1 : -1))
    if (action === 'hide') {
      this.hidden = !this.hidden && !!view
      this.sync()
      return
    }
    const entry = this.services.active()
    const bench = this.workbenches().find((b) => b.folder === id)
    if (!entry || !bench) return
    if (action === 'open' && entry.url)
      await this.services.load(
        `${new URL(bench.route, entry.url).href}?${STATE_PARAM}=${encodeURIComponent(bench.states[0].id)}`
      )
    if (action === 'remove') this.confirmRemove(entry.root, bench)
  }

  private switch(id: string) {
    if (!this.view || (id !== ALL_STATES && !this.view.states.some((s) => s.id === id))) return
    this.services.preview(PREVIEW_STATES_SWITCH, id)
    // The island answers at once; the page's own URL change confirms it.
    if (this.location) this.location = stateUrl(this.location, id)
    this.sync()
  }

  /** Never automatic: a sheet names what goes, and only Remove deletes. */
  confirmRemove(root: string, bench: Workbench) {
    const seams = bench.seams.length
      ? ` and ${bench.seams.length} file${bench.seams.length > 1 ? 's' : ''} made for it (${bench.seams.join(', ')})`
      : ''
    this.services.sheets.present(
      {
        title: `Remove the ${bench.component} states workbench?`,
        detail: `${bench.folder}${seams} will be moved to the Trash, then Trezi searches the project for leftover references to ${bench.route}.`,
        fields: [],
        actions: [
          { id: 'keep', label: 'Cancel', cancel: true },
          { id: 'remove', label: 'Remove Workbench', primary: true, destructive: true }
        ]
      },
      async ({ action }) => {
        this.services.sheets.close()
        if (action === 'remove') await this.remove(root, [bench])
      }
    )
  }

  /** Removes each workbench in one owner step, then reports leftovers. */
  async remove(root: string, benches: Workbench[]): Promise<boolean> {
    let ok = true
    for (const bench of benches) {
      const result = await this.services.remove(root, bench.folder, bench.seams)
      if (!result.ok) {
        ok = false
        this.services.log(
          `Could not remove ${bench.folder}: ${result.error ?? 'unknown error'}`,
          'error'
        )
        continue
      }
      const leftovers = await (this.services.leftovers ?? findLeftovers)(root, bench)
      this.services.log(
        leftovers.length
          ? `Removed the ${bench.component} workbench. Still referenced in: ${leftovers.join('; ')}`
          : `Removed the ${bench.component} workbench; no references remain.`
      )
      const entry = this.services.active()
      if (entry?.root === root && entry.url && this.view?.folder === bench.folder)
        await this.services.load(entry.url)
    }
    await this.refresh(root)
    return ok
  }

  /**
   * Publish with a workbench present asks first (LKM-207): Remove and Publish, Publish
   * Anyway or Cancel. Resolves whether the publish goes ahead.
   */
  beforePublish(root: string): boolean | Promise<boolean> {
    // The list kept fresh by navigation keeps the Publish click instant; scan only cold.
    if (!this.lists.has(root))
      return this.refresh(root).then(
        (list) => !list.length || this.warnPublish(root, list),
        () => true
      )
    const list = this.workbenches(root)
    return !list.length || this.warnPublish(root, list)
  }

  private warnPublish(root: string, list: Workbench[]): Promise<boolean> {
    const names = list.map((b) => `${b.component} (${b.folder})`).join(', ')
    return new Promise((resolve) => {
      this.services.sheets.present(
        {
          title:
            list.length > 1
              ? 'States workbenches are still in the project'
              : 'A states workbench is still in the project',
          detail: `${names} would be published with your changes. Workbenches are scratch pages for design review.`,
          fields: [],
          actions: [
            { id: 'keep', label: 'Cancel', cancel: true },
            { id: 'publish', label: 'Publish Anyway' },
            { id: 'remove', label: 'Remove and Publish', primary: true }
          ]
        },
        async ({ action }) => {
          this.services.sheets.close()
          if (action === 'publish') resolve(true)
          else if (action === 'remove') resolve(await this.remove(root, list))
          else resolve(false)
        }
      )
    })
  }
}

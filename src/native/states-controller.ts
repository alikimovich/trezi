import { findLeftovers, scanWorkbenches } from '../main/states-workbench'
import type { FileOpResult, LayersSnapshot, SelectedElement } from '../shared/api'
import type { NativeSheetAction, NativeSheetState } from '../shared/native-sheet'
import { PREVIEW_STATES, PREVIEW_STATES_SWITCH } from '../shared/preview-channels'
import {
  benchForSelection,
  pageLabel,
  rebaseUrl,
  sameDocument,
  type WorkbenchOrigin,
  type WorkbenchSelection
} from '../shared/states-records'
import {
  ALL_STATES,
  matchWorkbench,
  normalizeRoute,
  rebuildStatesText,
  STATE_PARAM,
  type StatesView,
  stateUrl,
  stepState,
  type Workbench,
  type WorkbenchItem
} from '../shared/states-workbench'
import { WorkbenchMemory, type WorkbenchRecordStore } from './states-memory'

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
  // LKM-220: going back to the page and returning to the workbench.
  /** The preference the records live in (none: they last for the session). */
  records?: WorkbenchRecordStore
  /** The shown page's address, title and scroll offset. */
  page?: () => Promise<{ href: string; title: string; x: number; y: number } | null>
  scrollTo?: (x: number, y: number) => Promise<unknown>
  /** One preview history step back when that entry is `url`; false when it is not. */
  back?: (url: string) => Promise<boolean>
  layers?: () => Promise<LayersSnapshot | null>
  pick?: (path: number[], fingerprint: { tag: string; source: string | null }) => void
  /** Focuses `chat` when it is still open in `root`'s project. */
  focusChat?: (root: string, chat: string) => Promise<boolean>
  /** A new chat in `root`'s project with the workbench as a context chip. */
  newChat?: (root: string, bench: Workbench) => Promise<void>
  /** Sends `text` in `chat` (focused first) or the project's active chat. */
  submit?: (root: string, text: string, chat?: string) => Promise<void>
  chatTitle?: (chat: string) => string | undefined
}

/** Minimum gap between same-path rescans triggered by preview loads. */
const RESCAN_MS = 1500
/** How long the page Back returns to may take to show the selected instance again. */
const RESTORE_MS = 6000

export interface StatesAction {
  action: string
  id?: string
}

const selectionOf = (element: SelectedElement): WorkbenchSelection => ({
  tag: element.tag,
  id: element.id,
  source: element.source,
  componentSource: element.componentSource,
  path: element.layerPath ?? null
})

/**
 * The states workbench (LKM-207). The preview URL decides everything: on a recorded
 * workbench route the host shows the switcher island and the preload takes ←/→, 1-9
 * and H. Switching is a replaceState in the page (`states-switch.ts`); the URL change
 * that follows re-syncs the island. Workbenches are only removed by a user action.
 * LKM-220: each workbench remembers the page it was opened from (Back returns there and
 * selects the instance), its last state and its chat (`states-memory.ts`).
 */
export class NativeStatesController {
  readonly lists = new Map<string, Workbench[]>()
  readonly memory: WorkbenchMemory
  view: StatesView | null = null
  hidden = false
  private location: string | null = null
  private path: string | null = null
  private sent = ''
  private ids = ''
  private scannedAt = 0
  private returning: {
    origin: WorkbenchOrigin
    history: boolean
    until: number
    token: number
  } | null = null
  private restoring = 0
  constructor(readonly services: StatesServices) {
    this.memory = new WorkbenchMemory(
      services.records,
      (error) => services.log(String(error), 'error'),
      () => this.now()
    )
  }
  private now() {
    return (this.services.now ?? Date.now)()
  }

  workbenches(root = this.services.active()?.root): Workbench[] {
    return (root && this.lists.get(root)) || []
  }

  async refresh(root = this.services.active()?.root): Promise<Workbench[]> {
    if (!root) return []
    this.scannedAt = this.now()
    const before = this.lists.get(root) ?? null
    const list = await (this.services.scan ?? scanWorkbenches)(root)
    this.lists.set(root, list)
    this.memory.reconcile(root, list, before)
    this.sync()
    return list
  }

  /** A turn landed files in `root`: a workbench may have appeared, even in a background project. */
  landed(root: string) {
    void this.refresh(root).catch((error) => this.services.log(String(error), 'error'))
  }

  /** The preview's URL changed (a load, or a replaceState from switching). */
  url(url: string | null) {
    const root = this.services.active()?.root
    let path: string | null = null
    try {
      path = url ? new URL(url).pathname : null
    } catch {}
    // The page left for another route, outside any workbench: where a workbench opened next came from.
    if (
      root &&
      path !== this.path &&
      this.location &&
      !matchWorkbench(this.location, this.workbenches())
    )
      this.memory.page(root, this.location)
    this.location = url
    // A new route may be a workbench that just landed. State switches only change the query;
    // a same-path reload (files landing under the open route) rescans while no recorded
    // workbench matches, at most once per RESCAN_MS.
    const known = !!url && !!matchWorkbench(url, this.workbenches())
    const stale = this.now() - this.scannedAt > RESCAN_MS
    if (path !== this.path || (!known && stale)) {
      this.path = path
      void this.refresh().catch((error) => this.services.log(String(error), 'error'))
    }
    // A load replaces the page's preload, which forgets the state ids: tell it again.
    this.sync(true)
    if (this.returning && url && sameDocument(url, this.returning.origin.url))
      void this.restore().catch((error) => this.services.log(String(error), 'error'))
  }

  sync(page = false) {
    const root = this.services.active()?.root
    const list = this.workbenches()
    const match = this.location ? matchWorkbench(this.location, list) : null
    if (!match) this.hidden = false
    if (root && match) this.remember(root, match.workbench, match.current)
    const origin = match && root ? this.origin(root, match.workbench) : undefined
    this.view = match
      ? {
          folder: match.workbench.folder,
          component: match.workbench.component,
          states: match.workbench.states,
          missing: match.workbench.missing,
          current: match.current,
          hidden: this.hidden,
          back: origin ? `Back to ${pageLabel(origin)}` : null
        }
      : null
    const items = root ? list.map((bench) => this.item(root, bench)) : []
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

  /** The state last viewed, and the page it came from when nothing recorded one. */
  private remember(root: string, bench: Workbench, current: string) {
    const record = this.memory.get(root, bench.folder)
    const previous = this.memory.lastPage(root)
    let fallback: WorkbenchOrigin | undefined
    try {
      if (!record?.origin && previous && normalizeRoute(new URL(previous).pathname) !== bench.route)
        fallback = { url: previous }
    } catch {}
    const last = current === ALL_STATES ? record?.last : current
    const chat = record?.chat ?? bench.chat
    if (fallback || last !== record?.last || chat !== record?.chat)
      this.memory.update(root, bench.folder, {
        ...(fallback ? { origin: fallback } : {}),
        last,
        chat
      })
  }

  /** The recorded origin on the preview's current origin: the stored port may be stale. */
  private origin(root: string, bench: Workbench): WorkbenchOrigin | undefined {
    const origin = this.memory.get(root, bench.folder)?.origin
    if (!origin) return undefined
    const url = rebaseUrl(origin.url, this.location ?? this.services.active()?.url)
    return url === origin.url ? origin : { ...origin, url }
  }

  private item(root: string, bench: Workbench): WorkbenchItem {
    const record = this.memory.get(root, bench.folder)
    const chat = record?.chat ?? bench.chat
    return {
      folder: bench.folder,
      component: bench.component,
      route: bench.route,
      from: record?.origin ? pageLabel(record.origin) : null,
      chat: (chat && this.services.chatTitle?.(chat)) || null,
      last: bench.states.find((state) => state.id === record?.last)?.label ?? null
    }
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
    if (action === 'back') return this.back()
    const entry = this.services.active()
    const bench = this.workbenches().find((b) => b.folder === (id || view?.folder))
    if (!entry || !bench) return
    if (action === 'open') await this.open(entry.root, bench)
    if (action === 'grid') await this.open(entry.root, bench, ALL_STATES)
    if (action === 'continue') await this.continueInChat(entry.root, bench)
    if (action === 'rebuild') {
      const chat = this.memory.get(entry.root, bench.folder)?.chat ?? bench.chat
      await this.services.submit?.(entry.root, rebuildStatesText(bench), chat)
    }
    if (action === 'remove') this.confirmRemove(entry.root, bench)
  }

  /** Opens `bench` at `state`, else the state last viewed, else its first. */
  async open(root: string, bench: Workbench, state?: string) {
    const entry = this.services.active()
    const base = this.location ?? entry?.url
    if (!base || entry?.root !== root) return
    const last = this.memory.get(root, bench.folder)?.last
    const id = state ?? (bench.states.some((s) => s.id === last) ? last : bench.states[0].id)
    await this.services.load(
      `${new URL(bench.route, base).href}?${STATE_PARAM}=${encodeURIComponent(id ?? bench.states[0].id)}`
    )
  }

  /** The page now shown, as the place a workbench was opened from. */
  private async here(picked?: WorkbenchSelection): Promise<WorkbenchOrigin | undefined> {
    const page = await this.services.page?.().catch(() => null)
    const url = page?.href || this.location
    if (!url || !/^https?:/.test(url)) return undefined
    return {
      url,
      ...(page?.title ? { title: page.title.slice(0, 120) } : {}),
      ...(page ? { x: Math.max(0, Math.round(page.x)), y: Math.max(0, Math.round(page.y)) } : {}),
      ...(picked ? { selection: picked } : {})
    }
  }

  /**
   * Show states on a selected element (toolbar or … menu). When its component already
   * has a workbench, that workbench opens at the state last viewed and true is returned;
   * otherwise the page is remembered for the workbench the agent is about to build.
   */
  async show(root: string, element: SelectedElement, chat?: string): Promise<boolean> {
    const cached = this.lists.has(root)
    const picked = selectionOf(element)
    const origin = await this.here(picked)
    const find = (benches: Workbench[]) =>
      benchForSelection(picked, benches, this.memory.all(root), root)
    // A cached list may predate a workbench written since the last (throttled) scan.
    let bench = find(cached ? this.workbenches(root) : await this.refresh(root))
    if (!bench && cached) bench = find(await this.refresh(root))
    if (!bench) {
      if (origin) this.memory.expect(root, origin, chat)
      return false
    }
    if (origin) this.memory.update(root, bench.folder, { origin })
    await this.open(root, bench)
    return true
  }

  /** "← Back to <page>": the history entry when it is that page, else a load; then the instance is selected. */
  async back() {
    const root = this.services.active()?.root
    const bench = this.view && this.workbenches(root).find((b) => b.folder === this.view?.folder)
    const origin = root && bench ? this.origin(root, bench) : undefined
    if (!origin) return
    const returning = {
      origin,
      history: false,
      until: this.now() + RESTORE_MS,
      token: ++this.restoring
    }
    this.returning = returning
    returning.history = (await this.services.back?.(origin.url).catch(() => false)) === true
    if (!returning.history) await this.services.load(origin.url)
  }

  /** On the page Back went to: its scroll (after a load) and the selected instance. */
  private async restore() {
    const returning = this.returning
    if (!returning || returning.token !== this.restoring) return
    const { origin } = returning
    const wanted = origin.selection
    while (this.returning === returning && this.now() < returning.until) {
      const page = await this.services.page?.().catch(() => null)
      if (this.returning !== returning) return
      const ready = !this.services.page || (!!page && sameDocument(page.href, origin.url))
      const snapshot = ready && wanted ? await this.services.layers?.().catch(() => null) : null
      if (this.returning !== returning) return
      const nodes = snapshot?.nodes ?? []
      const same = (node: (typeof nodes)[number]) =>
        node.tag === wanted?.tag && (node.source ?? null) === (wanted?.source ?? null)
      // A pick's source falls back to an ancestor's stamp; a Layers node only has its own.
      const atPath = (n: (typeof nodes)[number]) =>
        !!wanted?.path &&
        n.path.join('.') === wanted.path.join('.') &&
        n.tag === wanted.tag &&
        (n.source == null || n.source === wanted.source)
      const node =
        nodes.find(atPath) ??
        (nodes.filter((n) => same(n) && (n.id ?? null) === (wanted?.id ?? null)).length === 1
          ? nodes.find((n) => same(n) && (n.id ?? null) === (wanted?.id ?? null))
          : undefined)
      if (ready && (!wanted || node || !this.services.layers)) {
        this.returning = null
        if (!returning.history && origin.y !== undefined)
          await this.services.scrollTo?.(origin.x ?? 0, origin.y).catch(() => null)
        if (node) this.services.pick?.(node.path, { tag: node.tag, source: node.source })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (this.returning === returning) this.returning = null
  }

  /** The chat that built the workbench when it is still open, else a new one with its chip. */
  async continueInChat(root: string, bench: Workbench) {
    const chat = this.memory.get(root, bench.folder)?.chat ?? bench.chat
    if (chat && (await this.services.focusChat?.(root, chat))) return
    await this.services.newChat?.(root, bench)
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
        await this.services.load(this.origin(root, bench)?.url ?? entry.url)
    }
    await this.refresh(root)
    return ok
  }

  /**
   * Publish with a workbench present asks first (LKM-207): Remove and Publish, Publish
   * Anyway, Open Workbench (LKM-220: back to it, no publish) or Cancel. Resolves whether
   * the publish goes ahead.
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
            { id: 'open', label: 'Open Workbench' },
            { id: 'publish', label: 'Publish Anyway' },
            { id: 'remove', label: 'Remove and Publish', primary: true }
          ]
        },
        async ({ action }) => {
          this.services.sheets.close()
          if (action === 'publish') resolve(true)
          else if (action === 'remove') resolve(await this.remove(root, list))
          else {
            resolve(false)
            if (action === 'open') await this.open(root, list[0])
          }
        }
      )
    })
  }
}

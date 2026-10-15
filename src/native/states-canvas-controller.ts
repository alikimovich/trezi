import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { buildStates, type StatesBuild } from '../main/states-build'
import type { SelectedElement } from '../shared/api'
import type { NativeSheetAction, NativeSheetState } from '../shared/native-sheet'
import { PREVIEW_CANVAS } from '../shared/preview-channels'
import {
  CANVAS_ALL,
  CANVAS_PREFIX,
  type CanvasRecipe,
  canvasIdFor,
  parseCanvasRecipe,
  readCanvasRecipes,
  STATES_CANVAS_PREFERENCE,
  type StatesViewCommand,
  writeCanvasRecipes
} from '../shared/states-canvas'
import type { NativePreferences } from './preferences'
import { discoverSubject, recipeSubject, type StatesSubject } from './states-subject'
import { StatesWatch } from './states-watch'

type View = {
  root: string
  subject: StatesSubject
  session: string
  state: string
  status: string
  reason: string
  /** The document the view sits on: another URL ends it, a reload of it draws it again. */
  url: string
  bundle: Extract<StatesBuild, { ok: true }> | null
  /** Bumped by every rebuild, so a slower earlier build never replaces a newer one. */
  ticket: number
}

/** Actions whose id is a state of the open view; every other id names a recipe. */
const STATE_ACTIONS = new Set(['select', 'all', 'next', 'prev'])

/** Show states: an isolated view of real component variants, built by Trezi from the project's
 * sources (src/main/states-build.ts) and drawn in sandboxed frames over the preview. Recipes are
 * app data; nothing is written to the project. */
export class StatesCanvasController {
  view: View | null = null
  hidden = false
  private readonly pending = new Map<string, SelectedElement>()
  private readonly last = new Map<string, string>()
  private readonly inputs = new StatesWatch()
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined
  private rediscover = false
  private drawn = 0
  constructor(
    readonly services: {
      preferences: NativePreferences
      active: () => { root: string; url?: string | null } | null
      pageUrl: () => string
      preview: (channel: string, payload: unknown) => void
      /** Evaluates in the page world (React's fibers live there); the result is untrusted. */
      probe: (code: string) => Promise<unknown>
      send: (command: 'statesState' | 'workbenches', payload: unknown) => void
      legacyItems: (root: string) => unknown[]
      chatTitle: (chat: string) => string | undefined
      submit: (root: string, text: string, chat?: string) => Promise<void>
      focusChat: (root: string, chat: string) => Promise<boolean>
      sheets: {
        present(
          state: Omit<NativeSheetState, 'id' | 'busy'>,
          handle: (action: NativeSheetAction) => Promise<void>
        ): void
        close(): void
      }
      report: (error: unknown) => void
      build?: typeof buildStates
    }
  ) {}

  recipes(root: string): CanvasRecipe[] {
    return readCanvasRecipes(this.services.preferences.get(STATES_CANVAS_PREFERENCE), root)
  }
  expect(root: string, element: SelectedElement) {
    this.pending.set(root, element)
  }
  /** A recipe registered for exactly this selection reopens (with discovery merged in). */
  openForSelection(root: string, element: SelectedElement): boolean {
    const source = element.componentSource ?? element.source
    const path = element.layerPath
    if (!source || !path) return false
    const matches = this.recipes(root).filter(
      (recipe) =>
        recipe.selection.source === source &&
        recipe.selection.tag === element.tag &&
        recipe.selection.path.join('.') === path.join('.')
    )
    if (matches.length !== 1) return false
    void this.show(root, element).catch(this.services.report)
    return true
  }
  /** Show states for a selected element: discover its component and states, then draw them. */
  async show(root: string, element: SelectedElement): Promise<boolean> {
    if (this.services.active()?.root !== root) return false
    this.expect(root, element)
    const subject = await discoverSubject(root, element, this.recipes(root), this.services.probe)
    await this.present(root, subject)
    return true
  }
  /** The real path of a project file, or '' when it is missing or outside the project. */
  private sourceFile(root: string, path: string): string {
    try {
      const base = realpathSync(root)
      const file = realpathSync(resolve(root, path))
      return file.startsWith(base + sep) && statSync(file).isFile() ? file : ''
    } catch {
      return ''
    }
  }
  private sourceExists(root: string, path: string): boolean {
    return !!this.sourceFile(root, path)
  }
  /** Why a recipe can no longer be trusted: its component or provider file is gone. */
  stale(root: string, recipe: Pick<CanvasRecipe, 'source' | 'provider'>): string {
    if (!this.sourceExists(root, recipe.source))
      return `${recipe.source} no longer exists. Rebuild these states.`
    if (recipe.provider && !this.sourceExists(root, recipe.provider.source))
      return `${recipe.provider.source} no longer exists. Rebuild these states.`
    return ''
  }
  async register(
    root: string,
    chat: string,
    raw: unknown
  ): Promise<{ id?: string; error?: string }> {
    const pending = this.pending.get(root)
    const given = (raw as { id?: unknown } | null)?.id
    const named = typeof given === 'string' && given.startsWith(CANVAS_PREFIX) ? given : ''
    const body = raw as { source?: unknown; exportName?: unknown } | null
    // Without an id the recipe is the one for this source file and export: registering the same
    // component again updates it (keeping revision and last state); another export is a new one.
    const previous =
      named ||
      (typeof body?.source === 'string' && typeof body.exportName === 'string'
        ? canvasIdFor(body.source, body.exportName)
        : '')
    const current = this.recipes(root).find((item) => item.id === previous)
    if (!pending && !current)
      return { error: 'Select the component in the visible preview before registering states.' }
    const picked =
      pending?.layerPath && (pending.componentSource ?? pending.source)
        ? {
            tag: pending.tag,
            source: (pending.componentSource ?? pending.source) as string,
            path: pending.layerPath
          }
        : current?.selection
    if (!picked) return { error: 'The selected component has no source or Layers path.' }
    const input = {
      ...(raw as object),
      selection: picked,
      last: (raw as { last?: unknown } | null)?.last ?? current?.last
    }
    const recipe = parseCanvasRecipe(input, chat, (current?.revision ?? 0) + 1)
    if (!recipe)
      return {
        error:
          'Invalid states recipe. Check source, exportName, states (props, actions, route) and fixture bounds.'
      }
    if (this.stale(root, recipe))
      return { error: 'The component or provider source is not a regular file in this project.' }
    const recipes = this.recipes(root)
    if (recipes.length >= 64 && !current) return { error: 'The project already has 64 recipes.' }
    const next = [...recipes.filter((item) => item.id !== recipe.id), recipe]
    await this.services.preferences.apply((values) => [
      [STATES_CANVAS_PREFERENCE, writeCanvasRecipes(values[STATES_CANVAS_PREFERENCE], root, next)]
    ])
    this.pending.delete(root)
    this.publishMenu(root)
    const view = this.view
    if (
      view?.root === root &&
      view.subject.source === recipe.source &&
      view.subject.exportName === recipe.exportName
    ) {
      if (view.subject.element) await this.show(root, view.subject.element)
      else this.open(root, recipe.id, view.state === CANVAS_ALL ? CANVAS_ALL : undefined)
    }
    return { id: recipe.id }
  }
  private publishMenu(root: string) {
    if (this.services.active()?.root !== root) return
    const items = this.recipes(root).map((recipe) => ({
      folder: recipe.id,
      component: recipe.component,
      route: '',
      from: this.stale(root, recipe) ? 'States — source missing' : 'States',
      chat: this.services.chatTitle(recipe.chat) ?? null,
      last:
        recipe.states.find((state) => state.id === (this.last.get(recipe.id) ?? recipe.last))
          ?.label ?? null
    }))
    this.services.send('workbenches', { items: [...items, ...this.services.legacyItems(root)] })
  }
  sync(root = this.services.active()?.root) {
    if (root) this.publishMenu(root)
  }
  /** Open a registered recipe (the States menu, the agent's open tool). */
  open(root: string, id: string, state?: string): { error?: string; id?: string } {
    if (this.services.active()?.root !== root) return { error: 'The project is not visible.' }
    const recipe = this.recipes(root).find((item) => item.id === id)
    if (!recipe) return { error: 'States recipe is missing.' }
    const selected = state ?? this.last.get(id) ?? recipe.last ?? recipe.states[0]?.id ?? CANVAS_ALL
    if (selected !== CANVAS_ALL && !recipe.states.some((item) => item.id === selected))
      return { error: 'State is missing or unsupported.' }
    const subject = recipeSubject(recipe)
    const reason = this.stale(root, recipe)
    if (reason) subject.unavailable = reason
    void this.present(root, subject, selected, reason ? 'stale' : undefined).catch(
      this.services.report
    )
    return { id }
  }
  private async present(root: string, subject: StatesSubject, state?: string, status?: 'stale') {
    const same = this.view?.root === root && this.view.subject.key === subject.key
    const previous = same ? this.view?.state : undefined
    this.close()
    this.hidden = false
    const ids = subject.states.map((item) => item.id)
    const wanted = state ?? previous ?? this.last.get(subject.key) ?? subject.recipe?.last
    const selected =
      wanted && (wanted === CANVAS_ALL || ids.includes(wanted))
        ? wanted
        : ids.length > 1
          ? CANVAS_ALL
          : (ids[0] ?? CANVAS_ALL)
    this.view = {
      root,
      subject,
      session: randomUUID(),
      state: selected,
      status: status ?? (subject.unavailable ? 'error' : 'loading'),
      reason: subject.unavailable ?? '',
      url: this.services.pageUrl(),
      bundle: null,
      ticket: 0
    }
    this.publishView()
    this.draw()
    if (!subject.unavailable) await this.rebuild()
  }
  /** Build the component bundle and draw it; watch its inputs so an edit draws it again. */
  private async rebuild() {
    const view = this.view
    if (!view || view.subject.unavailable) return
    const ticket = ++view.ticket
    const built = await (this.services.build ?? buildStates)({
      root: view.root,
      source: view.subject.source,
      exportName: view.subject.exportName,
      provider: view.subject.provider ?? null
    })
    if (this.view !== view || view.ticket !== ticket) return
    this.inputs.watch(built.inputs, (file) => this.changed(view, file))
    if (!built.ok) {
      view.bundle = null
      view.status = 'error'
      view.reason = built.reason
    } else {
      view.bundle = built
      view.status = 'loading'
      view.reason = ''
    }
    view.session = randomUUID()
    this.publishView()
    this.draw()
  }
  /** A source the bundle was built from changed: build again. Only an edit to the component
   * itself can change its states, so only that one discovers again; any edit also live-reloads
   * the page, which a discovery would have to probe mid-reload. */
  private changed(view: View, file: string) {
    const own = this.sourceFile(view.root, view.subject.source) === file
    this.rediscover ||= own
    clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      const rediscover = this.rediscover
      this.rediscover = false
      if (this.view !== view) return
      if (!rediscover) return void this.rebuild().catch(this.services.report)
      const { element, recipe } = view.subject
      if (element) void this.show(view.root, element).catch(this.services.report)
      else if (recipe) this.open(view.root, recipe.id, view.state)
    }, 250)
  }
  private draw() {
    const view = this.view
    if (!view) return
    this.drawn = Date.now()
    const { subject } = view
    const command: StatesViewCommand = {
      command: 'open',
      session: view.session,
      component: subject.component,
      source: subject.source,
      ...(subject.width ? { width: subject.width } : {}),
      states: subject.states.map(({ id, label, props, actions, route, note }) => ({
        id,
        label,
        props,
        ...(actions ? { actions } : {}),
        ...(route ? { route } : {}),
        ...(note ? { note } : {})
      })),
      state: view.state,
      notes: [...subject.notes, ...(view.bundle?.notes ?? [])],
      ...(view.bundle ? { bundle: { code: view.bundle.code, css: view.bundle.css } } : {}),
      ...(!view.bundle && view.reason ? { unavailable: view.reason } : {})
    }
    this.services.preview(PREVIEW_CANVAS, command)
  }
  /** Draw the open view again, after a reload or a page style update. */
  refresh() {
    if (!this.view) return
    this.view.session = randomUUID()
    if (this.view.bundle) this.view.status = 'loading'
    this.publishView()
    this.draw()
  }
  /** The page's stylesheets changed in place (HMR): the frames copy them, so draw again.
   * Drawing may itself inject styles (CSS-in-JS), so signals right after a draw are ours. */
  stylesUpdated(now = Date.now()) {
    if (!this.view?.bundle || now - this.drawn < 1500) return
    this.refresh()
  }
  /** The preview reported a load: the same URL is a reload and keeps the view; any other URL
   * is a navigation and ends it. */
  pageLoaded(url: string) {
    if (!this.view) return
    if (url.split('#')[0] === this.view.url.split('#')[0]) this.refresh()
    else this.close()
  }
  close() {
    clearTimeout(this.rebuildTimer)
    this.rediscover = false
    this.inputs.close()
    if (!this.view) return
    this.services.preview(PREVIEW_CANVAS, { command: 'close', session: this.view.session })
    this.view = null
    this.hidden = false
    this.services.send('statesState', { state: null })
  }
  private publishView() {
    const view = this.view
    if (!view) return
    this.services.send('statesState', {
      state: {
        folder: view.subject.key,
        component: view.subject.component,
        states: view.subject.states.map(({ id, label }) => ({ id, label })),
        missing: view.subject.missing,
        current: view.state,
        back: 'Back to page',
        status: view.status,
        reason: view.reason,
        hidden: this.hidden
      }
    })
  }
  result(value: unknown) {
    const raw = value as { session?: unknown; status?: unknown; reason?: unknown } | null
    const view = this.view
    if (
      !view?.bundle ||
      raw?.session !== view.session ||
      !['loading', 'ready', 'error'].includes(String(raw.status))
    )
      return
    view.status = String(raw.status)
    view.reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 240) : ''
    this.publishView()
  }
  async action(action: string, id?: string): Promise<boolean> {
    const root = this.services.active()?.root
    if (!root) return false
    const view = this.view
    if (action === 'back' && view) {
      this.close()
      return true
    }
    if (action === 'hide' && view) {
      this.hidden = !this.hidden
      this.publishView()
      return true
    }
    // State actions carry a state id and act on the open view. Any other id names a recipe or
    // the open discovered view; an id that is neither is a legacy workbench folder: not ours.
    const named = STATE_ACTIONS.has(action) ? '' : (id ?? '')
    const ours = !named || named.startsWith(CANVAS_PREFIX) || named === view?.subject.key
    if (!ours) return false
    const recipe = (named || view?.subject.key)?.startsWith(CANVAS_PREFIX)
      ? this.recipes(root).find((item) => item.id === (named || view?.subject.key))
      : undefined
    if (action === 'open' || action === 'grid') {
      if (recipe) this.open(root, recipe.id, action === 'grid' ? CANVAS_ALL : undefined)
      else if (view) {
        view.state = action === 'grid' ? CANVAS_ALL : view.state
        this.refresh()
      } else return false
      return true
    }
    if (STATE_ACTIONS.has(action)) {
      if (!view) return false
      const ids = view.subject.states.map((state) => state.id)
      const at = ids.indexOf(view.state)
      const state =
        action === 'select'
          ? id
          : action === 'all'
            ? CANVAS_ALL
            : ids[(Math.max(0, at) + (action === 'next' ? 1 : ids.length - 1)) % ids.length]
      if (!state || (state !== CANVAS_ALL && !ids.includes(state))) return true
      view.state = state
      if (state !== CANVAS_ALL) this.last.set(view.subject.key, state)
      if (state !== CANVAS_ALL && recipe?.states.some((item) => item.id === state))
        await this.remember(root, recipe.id, state)
      if (this.view !== view) return true
      view.session = randomUUID()
      if (view.bundle) view.status = 'loading'
      this.publishView()
      this.draw()
      return true
    }
    if (action === 'continue') {
      if (recipe) await this.services.focusChat(root, recipe.chat)
      else if (view && !view.subject.unavailable)
        await this.services.submit(root, this.fixturesPrompt(view.subject))
      return !!(recipe || view)
    }
    if (action === 'rebuild') {
      const subject = recipe ? recipeSubject(recipe) : view?.subject
      if (!subject) return false
      await this.services.submit(root, this.fixturesPrompt(subject), recipe?.chat)
      return true
    }
    if (action === 'remove' && recipe) {
      this.confirmRemove(root, recipe)
      return true
    }
    return false
  }
  private fixturesPrompt(subject: StatesSubject): string {
    const missing = subject.missing.map((item) => item.label).join(', ')
    return `/states Register a states recipe with Trezi for ${subject.component} (${subject.source}, export ${subject.exportName})${missing ? ` covering ${missing}` : ''}. Use fixtures, a provider and actions where props alone cannot reach a state; do not write files to the project.`
  }
  private async remember(root: string, id: string, state: string) {
    await this.services.preferences.apply((values) => [
      [
        STATES_CANVAS_PREFERENCE,
        writeCanvasRecipes(
          values[STATES_CANVAS_PREFERENCE],
          root,
          readCanvasRecipes(values[STATES_CANVAS_PREFERENCE], root).map((item) =>
            item.id === id ? { ...item, last: state } : item
          )
        )
      ]
    ])
  }
  /** The menu item ends in an ellipsis: a sheet names what goes, and only Remove deletes. The
   * recipe is app data; nothing in the project is touched. */
  confirmRemove(root: string, recipe: CanvasRecipe) {
    this.services.sheets.present(
      {
        title: `Remove the ${recipe.component} states recipe?`,
        detail: `Trezi forgets this recipe and its ${recipe.states.length} states. No file in the project changes.`,
        fields: [],
        actions: [
          { id: 'keep', label: 'Cancel', cancel: true },
          { id: 'remove', label: 'Remove Recipe', primary: true, destructive: true }
        ]
      },
      async ({ action }) => {
        this.services.sheets.close()
        if (action === 'remove') await this.remove(root, recipe.id)
      }
    )
  }
  async remove(root: string, id: string) {
    if (this.view?.subject.recipe?.id === id) this.close()
    this.last.delete(id)
    await this.services.preferences.apply((values) => [
      [
        STATES_CANVAS_PREFERENCE,
        writeCanvasRecipes(
          values[STATES_CANVAS_PREFERENCE],
          root,
          readCanvasRecipes(values[STATES_CANVAS_PREFERENCE], root).filter((item) => item.id !== id)
        )
      ]
    ])
    this.publishMenu(root)
  }
}

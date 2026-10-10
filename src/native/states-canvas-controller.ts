import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
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
  writeCanvasRecipes
} from '../shared/states-canvas'
import type { NativePreferences } from './preferences'

type View = {
  root: string
  recipe: CanvasRecipe
  session: string
  state: string
  status: string
  reason: string
  /** The document the canvas sits on: another URL, or a reload of it, ends or re-renders it. */
  url: string
}

/** Actions whose id is a state of the open canvas; every other id names a recipe. */
const STATE_ACTIONS = new Set(['select', 'all', 'next', 'prev'])

/** App-managed recipes are separate from route-based legacy workbenches. */
export class StatesCanvasController {
  view: View | null = null
  hidden = false
  private readonly pending = new Map<string, SelectedElement>()
  private readonly last = new Map<string, string>()
  private drawn = 0
  constructor(
    readonly services: {
      preferences: NativePreferences
      active: () => { root: string; url?: string | null } | null
      pageUrl: () => string
      preview: (channel: string, payload: unknown) => void
      send: (command: 'statesState' | 'workbenches', payload: unknown) => void
      legacyItems: (root: string) => unknown[]
      chatTitle: (chat: string) => string | undefined
      submit: (root: string, text: string, chat: string) => Promise<void>
      focusChat: (root: string, chat: string) => Promise<boolean>
      sheets: {
        present(
          state: Omit<NativeSheetState, 'id' | 'busy'>,
          handle: (action: NativeSheetAction) => Promise<void>
        ): void
        close(): void
      }
      report: (error: unknown) => void
    }
  ) {}

  recipes(root: string): CanvasRecipe[] {
    return readCanvasRecipes(this.services.preferences.get(STATES_CANVAS_PREFERENCE), root)
  }
  expect(root: string, element: SelectedElement) {
    this.pending.set(root, element)
  }
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
    return !!this.open(root, matches[0].id).id
  }
  private sourceExists(root: string, path: string): boolean {
    try {
      const base = realpathSync(root)
      const file = realpathSync(resolve(root, path))
      return file.startsWith(base + sep) && statSync(file).isFile()
    } catch {
      return false
    }
  }
  /** Why a recipe can no longer be trusted: its component or provider file is gone. */
  stale(root: string, recipe: CanvasRecipe): string {
    if (!this.sourceExists(root, recipe.source))
      return `${recipe.source} no longer exists. Rebuild this canvas.`
    if (recipe.provider && !this.sourceExists(root, recipe.provider.source))
      return `${recipe.provider.source} no longer exists. Rebuild this canvas.`
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
    // Without an id the canvas is the one for this source file and export: registering the same
    // component again updates it (keeping revision and last state); another export is a new canvas.
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
        error: 'Invalid canvas recipe. Check source, module URLs, states and fixture bounds.'
      }
    if (
      !this.sourceExists(root, recipe.source) ||
      (recipe.provider && !this.sourceExists(root, recipe.provider.source))
    )
      return { error: 'The component or provider source is not a regular file in this project.' }
    const recipes = this.recipes(root)
    if (recipes.length >= 64 && !current) return { error: 'The project already has 64 canvases.' }
    const next = [...recipes.filter((item) => item.id !== recipe.id), recipe]
    await this.services.preferences.apply((values) => [
      [STATES_CANVAS_PREFERENCE, writeCanvasRecipes(values[STATES_CANVAS_PREFERENCE], root, next)]
    ])
    this.pending.delete(root)
    this.publishMenu(root)
    if (this.view?.root === root && this.view.recipe.id === recipe.id)
      this.open(root, recipe.id, this.view.state === CANVAS_ALL ? CANVAS_ALL : undefined)
    return { id: recipe.id }
  }
  private publishMenu(root: string) {
    if (this.services.active()?.root !== root) return
    const items = this.recipes(root).map((recipe) => ({
      folder: recipe.id,
      component: recipe.component,
      route: '',
      from: this.stale(root, recipe) ? 'Canvas — source missing' : 'Canvas',
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
  open(root: string, id: string, state?: string): { error?: string; id?: string } {
    if (this.services.active()?.root !== root) return { error: 'The project is not visible.' }
    const recipe = this.recipes(root).find((item) => item.id === id)
    if (!recipe) return { error: 'Canvas recipe is missing.' }
    const selected = state ?? this.last.get(id) ?? recipe.last ?? recipe.states[0].id
    if (selected !== CANVAS_ALL && !recipe.states.some((item) => item.id === selected))
      return { error: 'State is missing or unsupported.' }
    this.close()
    this.hidden = false
    const reason = this.stale(root, recipe)
    this.view = {
      root,
      recipe,
      session: randomUUID(),
      state: selected,
      status: reason ? 'stale' : 'loading',
      reason,
      url: this.services.pageUrl()
    }
    this.publishView()
    this.services.preview(PREVIEW_CANVAS, {
      command: 'open',
      session: this.view.session,
      recipe,
      state: selected,
      ...(reason ? { unavailable: reason } : {})
    })
    return { id }
  }
  /** Draws the open canvas again from the current sources, after a reload or a style update. */
  refresh() {
    const view = this.view
    if (!view || view.status === 'stale') return
    const recipe = this.recipes(view.root).find((item) => item.id === view.recipe.id)
    if (!recipe) {
      this.close()
      return
    }
    const reason = this.stale(view.root, recipe)
    view.recipe = recipe
    view.status = reason ? 'stale' : 'loading'
    view.reason = reason
    this.publishView()
    // `open`, not `select`: after a reload the page has no session to select within.
    this.services.preview(PREVIEW_CANVAS, {
      command: 'open',
      session: view.session,
      recipe,
      state: view.state,
      refresh: true,
      ...(reason ? { unavailable: reason } : {})
    })
  }
  /** The preview's existing "stylesheets changed in place" signal (an HMR update applied).
   * Drawing may itself inject styles (CSS-in-JS), so signals right after a draw are ours. */
  stylesUpdated(now = Date.now()) {
    if (!this.view || now - this.drawn < 1500) return
    this.refresh()
  }
  /** The preview reported a load: the same URL is a reload (HMR full reload, dev restart) and
   * keeps the canvas; any other URL is a navigation and disposes it. */
  pageLoaded(url: string) {
    if (!this.view) return
    if (url.split('#')[0] === this.view.url.split('#')[0]) this.refresh()
    else this.close()
  }
  close() {
    if (!this.view) return
    this.services.preview(PREVIEW_CANVAS, { command: 'close', session: this.view.session })
    this.view = null
    this.hidden = false
    this.services.send('statesState', { state: null })
  }
  private publishView() {
    const view = this.view
    if (!view) return
    this.drawn = Date.now()
    this.services.send('statesState', {
      state: {
        folder: view.recipe.id,
        component: view.recipe.component,
        states: view.recipe.states.map(({ id, label }) => ({ id, label })),
        missing: view.recipe.missing,
        current: view.state,
        back: `Close canvas`,
        status: view.status,
        reason: view.reason,
        hidden: this.hidden
      }
    })
  }
  result(value: unknown) {
    const raw = value as { session?: unknown; status?: unknown; reason?: unknown } | null
    if (
      !this.view ||
      raw?.session !== this.view.session ||
      this.view.status === 'stale' ||
      !['loading', 'ready', 'error'].includes(String(raw.status))
    )
      return
    this.view.status = String(raw.status)
    this.view.reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 240) : ''
    this.publishView()
  }
  async action(action: string, id?: string): Promise<boolean> {
    const root = this.services.active()?.root
    if (!root) return false
    if (action === 'back' && this.view) {
      this.close()
      return true
    }
    if (action === 'hide' && this.view) {
      this.hidden = !this.hidden
      this.publishView()
      return true
    }
    // State actions carry a state id and act on the open canvas. Any other id names a
    // recipe, and an id that is not a canvas id is a legacy workbench folder: it is not ours.
    const named = STATE_ACTIONS.has(action) ? '' : (id ?? '')
    if (named && !named.startsWith(CANVAS_PREFIX)) return false
    const target = named || this.view?.recipe.id
    const recipe = target ? this.recipes(root).find((item) => item.id === target) : undefined
    if (!recipe) return false
    if (action === 'open' || action === 'grid') {
      this.open(root, recipe.id, action === 'grid' ? CANVAS_ALL : undefined)
      return true
    }
    if (action === 'select' || action === 'all' || action === 'next' || action === 'prev') {
      if (!this.view || this.view.recipe.id !== recipe.id) return false
      const ids = recipe.states.map((state) => state.id)
      const at = ids.indexOf(this.view.state)
      const state =
        action === 'select'
          ? id
          : action === 'all'
            ? CANVAS_ALL
            : ids[(Math.max(0, at) + (action === 'next' ? 1 : ids.length - 1)) % ids.length]
      if (!state || (state !== CANVAS_ALL && !ids.includes(state))) return true
      this.view.state = state
      if (state !== CANVAS_ALL) this.last.set(recipe.id, state)
      if (state !== CANVAS_ALL) {
        await this.services.preferences.apply((values) => [
          [
            STATES_CANVAS_PREFERENCE,
            writeCanvasRecipes(
              values[STATES_CANVAS_PREFERENCE],
              root,
              readCanvasRecipes(values[STATES_CANVAS_PREFERENCE], root).map((item) =>
                item.id === recipe.id ? { ...item, last: state } : item
              )
            )
          ]
        ])
      }
      const reason = this.stale(root, recipe)
      this.view.status = reason ? 'stale' : 'loading'
      this.view.reason = reason
      this.publishView()
      this.services.preview(PREVIEW_CANVAS, {
        command: 'select',
        session: this.view.session,
        recipe,
        state,
        ...(reason ? { unavailable: reason } : {})
      })
      return true
    }
    if (action === 'continue') {
      await this.services.focusChat(root, recipe.chat)
      return true
    }
    if (action === 'rebuild') {
      await this.services.submit(
        root,
        `/states Rebuild the ${recipe.component} canvas recipe ${recipe.id} from ${recipe.source}. Register updated fixtures with Trezi; do not write workbench files.`,
        recipe.chat
      )
      return true
    }
    if (action === 'remove') {
      this.confirmRemove(root, recipe)
      return true
    }
    return false
  }
  /** The menu item ends in an ellipsis: a sheet names what goes, and only Remove deletes. The
   * recipe is app data; nothing in the project is touched. */
  confirmRemove(root: string, recipe: CanvasRecipe) {
    this.services.sheets.present(
      {
        title: `Remove the ${recipe.component} states canvas?`,
        detail: `Trezi forgets this canvas recipe and its ${recipe.states.length} states. No file in the project changes.`,
        fields: [],
        actions: [
          { id: 'keep', label: 'Cancel', cancel: true },
          { id: 'remove', label: 'Remove Canvas', primary: true, destructive: true }
        ]
      },
      async ({ action }) => {
        this.services.sheets.close()
        if (action === 'remove') await this.remove(root, recipe.id)
      }
    )
  }
  async remove(root: string, id: string) {
    if (this.view?.recipe.id === id) this.close()
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

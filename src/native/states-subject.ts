import { relative } from 'node:path'
import { statesPackage } from '../main/states-build'
import { conventionalProvider, locateComponent } from '../main/states-locate'
import { proposeStates } from '../main/states-propose'
import type { SelectedElement } from '../shared/api'
import {
  type CanvasRecipe,
  type CanvasState,
  canvasIdFor,
  DISCOVERED_PREFIX
} from '../shared/states-canvas'
import { probeScript, readProbe } from './states-probe'

const PROBE_TIMEOUT = 3000

/** What the states view draws: a registered recipe, discovery from a selection, or both. */
export interface StatesSubject {
  /** A recipe id (`canvas:…`) or `discovered:…` for a component with no recipe. */
  key: string
  component: string
  source: string
  exportName: string
  provider?: { source: string; exportName: string }
  width?: number
  states: CanvasState[]
  missing: CanvasRecipe['missing']
  notes: string[]
  recipe?: CanvasRecipe
  /** The selection it came from, so a reload or an edit can discover it again. */
  element?: SelectedElement
  /** Why the component cannot render at all; the view says so instead of drawing frames. */
  unavailable?: string
}

export function recipeSubject(recipe: CanvasRecipe): StatesSubject {
  return {
    key: recipe.id,
    component: recipe.component,
    source: recipe.source,
    exportName: recipe.exportName,
    ...(recipe.provider ? { provider: recipe.provider } : {}),
    ...(recipe.width ? { width: recipe.width } : {}),
    states: recipe.states,
    missing: recipe.missing,
    notes: [],
    recipe
  }
}

/** Recipe states first (they are the explicit fixtures), then discovered ones not already
 * covered by an id or identical props. */
function merge(recipe: CanvasState[], found: CanvasState[]): CanvasState[] {
  const ids = new Set(recipe.map((state) => state.id))
  const props = new Set(recipe.map((state) => JSON.stringify(state.props)))
  const out = [...recipe]
  for (const state of found) {
    if (out.length >= 24) break
    if (ids.has(state.id) || props.has(JSON.stringify(state.props))) continue
    ids.add(state.id)
    out.push(state)
  }
  return out
}

/**
 * Find the selected element's component, read its live props from the page and propose its
 * states, merged with a registered recipe for the same export. Never writes to the project.
 */
export async function discoverSubject(
  root: string,
  element: SelectedElement,
  recipes: CanvasRecipe[],
  probe: (code: string) => Promise<unknown>
): Promise<StatesSubject> {
  const located = locateComponent(root, element)
  const name = element.tag ? `<${element.tag}>` : 'this element'
  if ('error' in located)
    return {
      key: `${DISCOVERED_PREFIX}${element.componentSource ?? element.source ?? 'unknown'}`,
      component: name,
      source: '',
      exportName: '',
      states: [],
      missing: [],
      notes: [],
      element,
      unavailable: located.error
    }
  const recipe = recipes.find(
    (item) => item.source === located.source && item.exportName === located.exportName
  )
  const key =
    recipe?.id ?? `${DISCOVERED_PREFIX}${canvasIdFor(located.source, located.exportName).slice(7)}`
  if (located.server)
    return {
      key,
      component: located.component,
      source: located.source,
      exportName: located.exportName,
      states: [],
      missing: [],
      notes: [],
      element,
      ...(recipe ? { recipe } : {}),
      unavailable: located.server
    }
  const live =
    element.layerPath && element.tag
      ? readProbe(
          // A page that is reloading may never answer; sample data is the fallback.
          await Promise.race([
            probe(
              probeScript({
                path: element.layerPath,
                tag: element.tag,
                callSite: located.callSite,
                component: located.component
              })
            ).catch(() => null),
            new Promise((done) => setTimeout(() => done(null), PROBE_TIMEOUT))
          ])
        )
      : { props: null, width: 0 }
  const proposed = proposeStates(located, live.props)
  const app = relative(root, statesPackage(root, located.source).dir)
  const provider =
    recipe?.provider ?? conventionalProvider(root, app.startsWith('..') ? '' : app) ?? undefined
  const notes: string[] = []
  if (provider && !recipe?.provider) notes.push(`Rendered inside ${provider.source}.`)
  if (!live.props)
    notes.push('The page did not expose this instance’s props, so the states use sample data.')
  const missing = [...(recipe?.missing ?? [])]
  for (const item of proposed.missing)
    if (!missing.some((m) => m.id === item.id)) missing.push(item)
  return {
    key,
    component: located.component,
    source: located.source,
    exportName: located.exportName,
    ...(provider ? { provider } : {}),
    width: recipe?.width ?? (live.width || Math.round(element.rect?.width ?? 0) || undefined),
    states: merge(recipe?.states ?? [], proposed.states),
    missing: missing.slice(0, 24),
    notes,
    element,
    ...(recipe ? { recipe } : {})
  }
}

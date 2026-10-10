import {
  ANIMATION_REPLAY,
  ISLAND_OVERRIDE,
  ISLAND_OVERRIDE_REPLY
} from '../shared/preview-channels'
import { islandOverride } from './island-override'
import { sourceSelector, sourceStamp } from './source-stamp'
import './agent-console'
import './agent-inspect'
import './agent-interact'
/**
 * Preview preload — injected into the previewed app's native WebContentsView.
 *
 * This is what makes trezi's differentiator possible: a click-to-select overlay
 * laid over the *real running repo*. When "select mode" is on it highlights the
 * hovered element and, on click, captures that element's identity (tag, a
 * best-effort CSS selector, its `data-trezi-source` stamp if the repo opts in,
 * and a few key computed styles) and ships it to the main process, which relays
 * it to the chat renderer.
 *
 * Runs sandboxed + contextIsolated, so it only uses `ipcRenderer` (no Node, no
 * contextBridge — it exposes nothing to the page). The overlay lives in a
 * shadow root with `pointer-events:none` so it can never clash with or swallow
 * events from the previewed app.
 */
import { ipcRenderer } from '../native/preview-transport'
import type { SelectedElement, ThreeDAction, ThreeDState } from '../shared/api'
import { CONTROL_OVERLAY_SELECTOR } from '../shared/control-overlay'
import { isScopeClass } from '../shared/display-classes'
import { FRAME_DATA_URI, FRAME_INSET } from '../shared/iphone-frame'
// Channels (preview ⇄ main). The strings live in shared/preview-channels.ts —
// main imports the very same constants, so the two ends can no longer drift.
// Aliased here to the short names this file has always used.
import {
  PREVIEW_CANCELLED as CANCELLED,
  PREVIEW_CLEAR_SELECTED as CLEAR_SELECTED,
  PREVIEW_COMMENT as COMMENT,
  PREVIEW_COMMENT_MODE as COMMENT_MODE,
  LAYERS_CHANGED,
  LAYERS_HOVER,
  LAYERS_READ,
  LAYERS_READ_REPLY,
  LAYERS_SELECT,
  LAYERS_SET_WATCH,
  PREVIEW_PICKED as PICKED,
  PREVIEW_PIN_CLICK as PIN_CLICK,
  PREVIEW_COVERED,
  PREVIEW_HIDE_SCROLLBARS,
  PREVIEW_MOVE_NODE,
  PREVIEW_OVERLAY_GEOMETRY,
  PREVIEW_OVERLAY_LINES,
  PREVIEW_THREE_D_ACTION,
  PREVIEW_THREE_D_STATE,
  PREVIEW_READINESS as READINESS,
  PREVIEW_SELECTION_LOST as SELECTION_LOST,
  PREVIEW_SET_COMMENT_MODE as SET_COMMENT_MODE,
  PREVIEW_SET_FRAME as SET_FRAME,
  PREVIEW_SET_MODE as SET_MODE,
  PREVIEW_SET_PINS as SET_PINS,
  PREVIEW_SET_SPEED as SET_SPEED,
  PREVIEW_SET_STATUS as SET_STATUS,
  STYLES_CLEAR_PREVIEW,
  STYLES_PREVIEW,
  STYLES_READ,
  STYLES_READ_REPLY,
  STYLES_REPLAY,
  PREVIEW_STYLES_UPDATED as STYLES_UPDATED,
  PREVIEW_TEXT_EDIT as TEXT_EDIT,
  PREVIEW_TOGGLE_SELECT as TOGGLE_SELECT,
  PREVIEW_TOOLBAR_ACTION as TOOLBAR_ACTION
} from '../shared/preview-channels'
import { coalesceHover } from './coalesce-hover'
import { installDragReorder } from './drag-reorder'
import { installHistoryKeys } from './history-keys'
import { latinKey } from './latin-key'
import {
  buildLayersSnapshot,
  type LayerFingerprint,
  layerPathOf,
  resolveLayerElement
} from './layers'
import { formatDistance, type MeasureLine, type MeasureRect, measureRects } from './measure'
import { createNativeCover } from './native-cover'
import { createOverlayGuides } from './overlay-guides'
import { sendPageSpeed } from './speed-control'
import { installStatesCanvas } from './states-canvas'
import { installStatesSwitch } from './states-switch'
import { specifiedValues, varRefName } from './style-provenance'
import { watchStyles } from './style-watch'
import { createThreeDInspector } from './three-d'
import { createViewportReadout } from './viewport-readout'

type CommentMode = 'comment' | 'annotate' | null

// The simulator preview loads trezi's own sim-bridge page (an MJPEG <img> of the
// booted device), flagged with `?treziSim=1`. There's no previewed-app DOM there
// to highlight/stamp/inspect, so the entire web overlay below is skipped. The
// query param (not a page global) is the signal because the preload runs in an
// isolated world and can't see the page's `window`, but `location` is shared.
// Phase 2/3 add the simulator-specific overlay separately.
const IS_SIM_BRIDGE = typeof location !== 'undefined' && /[?&]treziSim=1\b/.test(location.search)
// Opt-in timing for a real preview session; the Performance timeline can be
// inspected in WebContent without filling it during normal pointer movement.
const previewTimings = {
  enabled: typeof location !== 'undefined' && /[?&]treziPerf=1\b/.test(location.search),
  hover: [] as number[],
  hoverWork: [] as number[],
  hoverPaintUpperBound: [] as number[],
  select: [] as number[],
  roundTrip: [] as number[],
  hops: [] as Array<Record<string, number>>
}
;(
  globalThis as typeof globalThis & { __treziPreviewTimings: typeof previewTimings }
).__treziPreviewTimings = previewTimings

/** Computed styles worth surfacing in the inspector + Styles panel: the v1
 *  longhand set (curated, not the whole CSSOM). Longhands, not shorthands, so
 *  each maps 1:1 to a panel control and to a `styles:preview` override. */
const TRACKED_STYLES = [
  // Layout
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
  // Appearance
  'color',
  'background-color',
  'border-radius',
  'opacity',
  // Typography
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'font-family',
  'display',
  // Transition
  'transition-property',
  'transition-duration',
  'transition-delay',
  'transition-timing-function'
] as const

let active = false
let overlayHost: HTMLDivElement | null = null
// The page under native views floating over the preview (LKM-173).
const nativeCover = createNativeCover()
// The page's scroll, viewport and selection extent for the native rulers, and the
// hover distances to their guides and grid lines (LKM-205).
const overlayGuides = createOverlayGuides({
  send: (geometry) => ipcRenderer.send(PREVIEW_OVERLAY_GEOMETRY, geometry),
  selection: () => selEls.find((el) => el.isConnected) ?? null,
  layer: () => guideLayer,
  draw: { line: (s) => measureLine(s, false), label: measureLabel }
})
let overlayBox: HTMLDivElement | null = null
let overlayLabel: HTMLDivElement | null = null
let pinsLayer: HTMLDivElement | null = null
// `label` marks a comment whose background agent waits for an answer ("?", LKM-193).
let annotationPins: { id: string; selector: string; label?: string }[] = []

// Inline-comment state. `commentMode` is the armed whole-page mode (armed from
// the renderer via setCommentMode). `commenting` is the element the OPEN inline
// input is frozen onto (the click froze it); `inputKind` is what that open input
// submits as (null while the pill shows its icon row). `inputFromMode` marks an
// input opened by a whole-page mode click with no prior pick — Escape then hides
// the pill entirely instead of collapsing back to icons.
let commentMode: CommentMode = null
let commenting: Element | null = null
let inputKind: CommentMode = null
let inputFromMode = false

// Selection toolbar — ONE dark pill anchored to the picked element that morphs in
// place between an icon row (State A) and an inline comment/annotate input
// (State B), Figma-Make-style. These are its interactive parts + the width-morph
// timer.
let toolbarEl: HTMLDivElement | null = null
let selectedEl: Element | null = null
let inputWrapEl: HTMLDivElement | null = null
let inputEl: HTMLTextAreaElement | null = null
let submitEl: HTMLButtonElement | null = null
// Trailing actions hidden while the inline input is open (props/delete + the
// divider that isolates delete): commenting doesn't need destructive/prop UI.
let separatorEl: HTMLDivElement | null = null
let hintEl: HTMLDivElement | null = null
let widthTimer: ReturnType<typeof setTimeout> | null = null

// Launch-status pill (bottom center) — dev-server progress while a project
// starts, shown INSIDE the preview instead of a window-top banner.
let statusEl: HTMLDivElement | null = null

function setStatusPill(text: string | null): void {
  if (!text) {
    statusEl?.remove()
    statusEl = null
    return
  }
  if (!statusEl) {
    const el = document.createElement('div')
    el.setAttribute('data-trezi-status', '')
    el.style.cssText =
      'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483646;' +
      'max-width:82%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'pointer-events:none;font:500 11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#555;background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.08);' +
      'border-radius:999px;padding:4px 12px;box-shadow:0 2px 10px rgba(0,0,0,0.08);'
    document.documentElement.appendChild(el)
    statusEl = el
  }
  statusEl.textContent = text
}

// Persistent selection highlight — outlines that STAY while the mouse hovers
// other elements (the hover box is separate). When the picked element resolves
// to a source stamp, every element with the same stamp is outlined too (a
// component rendered in a loop), with an "h3 × 4" count badge on the pick. The
// badge also carries the pick's rendered size (see makeChip).
let selLayer: HTMLDivElement | null = null
let selEls: Element[] = []

// Alt/Option spacing measurement — with something selected, holding Option and
// hovering another element draws the distances between the two, Figma-style.
// `measureTarget` is the hovered element the current drawing measures to;
// `measureKey` is the geometry it was drawn from, so a mousemove that doesn't
// move either rect doesn't rebuild the nodes.
let measureLayer: HTMLDivElement | null = null
// Hover distances to the native guides and layout grid (LKM-205, `overlay-guides.ts`).
let guideLayer: HTMLDivElement | null = null
let measureTarget: Element | null = null
let measureKey = ''
let altHeld = false
let lastHovered: Element | null = null

/** Lazily build the shadow-DOM overlay (highlight box + label chip + pins layer). */
function ensureOverlay(): void {
  if (overlayHost) return
  const host = document.createElement('div')
  host.setAttribute('data-trezi-overlay', '')
  // Host itself never paints or intercepts; the shadow tree draws the box.
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
  const shadow = host.attachShadow({ mode: 'open' })

  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;pointer-events:none;box-sizing:border-box;' +
    'border:2px solid #2563eb;border-radius:3px;background:rgba(37,99,235,0.08);' +
    'transition:all 60ms ease-out;display:none;'
  // The hover box; the island pointer verification reads it.
  box.setAttribute('data-trezi-hover', '')

  const label = makeChip()

  const pins = document.createElement('div')
  pins.style.cssText = 'position:fixed;inset:0;pointer-events:none;'

  // Persistent selection outlines (behind the hover box + composer).
  const sel = document.createElement('div')
  sel.style.cssText = 'position:fixed;inset:0;pointer-events:none;'

  // Alt/Option spacing measurements (rebuilt per hover — see drawMeasure).
  const meas = document.createElement('div')
  meas.setAttribute('data-trezi-measure', '')
  meas.style.cssText = 'position:fixed;inset:0;pointer-events:none;'
  const guideMeas = document.createElement('div')
  guideMeas.style.cssText = 'position:fixed;inset:0;pointer-events:none;'

  // Whole-page mode hint chip (top-center) while C/Y is armed.
  const hint = document.createElement('div')
  hint.style.cssText =
    'position:fixed;pointer-events:none;font:600 11px/1.4 system-ui,sans-serif;color:#fff;' +
    'background:#111;opacity:0.82;padding:3px 8px;border-radius:5px;white-space:nowrap;display:none;'

  // The single morphing pill — element-scoped actions anchored to the picked
  // element. It's the only interactive part of the overlay (pointer-events:auto),
  // so a hostile page can't reach it and our own clicks on it are ignored via
  // isOverlay(). One DOM node hosts BOTH visual states: an icon row (State A) and
  // an inline comment/annotate input (State B); enterInputState/collapseInput
  // morph between them in place.
  const toolbar = document.createElement('div')
  toolbar.setAttribute('data-trezi-toolbar', '')
  toolbar.style.cssText =
    'position:fixed;pointer-events:auto;display:none;box-sizing:border-box;align-items:center;gap:2px;' +
    'padding:4px;background:#1f1f1f;border:1px solid rgba(255,255,255,0.08);border-radius:10px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,0.35);z-index:2;transition:width 160ms ease;'

  // ::placeholder can't be set via inline cssText — style it (and hide the
  // textarea's scrollbar) from a <style> scoped inside the shadow root.
  const style = document.createElement('style')
  style.textContent =
    '[data-trezi-toolbar] textarea::placeholder{color:#8a8a8a}' +
    '[data-trezi-toolbar] textarea{scrollbar-width:none}' +
    '[data-trezi-toolbar] textarea::-webkit-scrollbar{display:none}' +
    // Squircle the injected overlay UI's rounded corners (toolbar pill, icon
    // buttons, badges) to match the app — matches styles.css's global rule.
    ':host *{corner-shape:squircle}'

  // Keep pill mouse events from bubbling out to the previewed page. Bubble phase
  // (not capture) so a button's own click handler still fires first; the overlay's
  // window-level capture handlers already ignore overlay targets.
  const swallow = (e: Event): void => e.stopPropagation()
  toolbar.addEventListener('mousedown', swallow)
  toolbar.addEventListener('click', swallow)

  const ICONS: Record<string, { title: string; svg: string }> = {
    edit: {
      title: 'Edit text in place',
      svg: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>'
    },
    'three-d': {
      title: 'Inspect in 3D',
      // An isometric cube (Lucide "box"): stacked layers stay the Layers tool's glyph.
      svg: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'
    },
    props: {
      title: 'Edit props',
      svg: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>'
    },
    comment: {
      title: 'Comment on this element — runs a parallel agent',
      svg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'
    },
    code: {
      title: 'Show the source in the editor',
      svg: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'
    },
    states: {
      title: 'Show states — every state of this component side by side',
      // A component with its variants stacked behind it, like the States switcher's
      // square.stack; a grid would read as the layout grid overlay.
      svg: '<rect x="3" y="10" width="18" height="11" rx="2"/><path d="M5 6.5h14"/><path d="M8 3h8"/>'
    },
    delete: {
      title: 'Ask Trezi to delete this element',
      svg: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
    }
  }
  // 26×26 icon button. Comment is the leading mode toggle (tracks a pressed
  // bg via data-pressed); props/code/delete are trailing action icons.
  const makeIcon = (kind: keyof typeof ICONS): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.kind = kind
    b.title = ICONS[kind].title
    b.setAttribute('aria-label', kind === 'three-d' ? 'Inspect in 3D' : kind)
    b.style.cssText =
      'flex:0 0 auto;width:26px;height:26px;border:none;border-radius:7px;background:transparent;' +
      'display:flex;align-items:center;justify-content:center;cursor:default;color:#d4d4d4;'
    b.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind].svg}</svg>`
    b.addEventListener('mouseenter', () => {
      b.style.background =
        b.dataset.pressed === '1' ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)'
    })
    b.addEventListener('mouseleave', () => {
      b.style.background = b.dataset.pressed === '1' ? 'rgba(255,255,255,0.16)' : 'transparent'
    })
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onToolbarButton(kind)
    })
    return b
  }

  const commentBtn = makeIcon('comment')

  // Inline input group (State B) — hidden in the icon row, faded/grown in on morph.
  const inputWrap = document.createElement('div')
  inputWrap.style.cssText =
    'display:none;align-items:center;gap:4px;flex:0 0 auto;opacity:0;transition:opacity 120ms ease;'
  const input = document.createElement('textarea')
  input.rows = 1
  // Single line sits at the icon-button height (26px) so State B doesn't grow
  // taller than State A: 18px line + 4px top + 4px bottom = 26px. It still grows
  // (up to max-height) when the user types multiple lines.
  input.style.cssText =
    'box-sizing:border-box;border:none;outline:none;resize:none;background:transparent;color:#eee;' +
    'font:400 13px/18px system-ui,-apple-system,Segoe UI,sans-serif;width:260px;max-width:60vw;' +
    'max-height:66px;padding:4px 6px;'
  const send = document.createElement('button')
  send.type = 'button'
  send.setAttribute('aria-label', 'Submit')
  send.textContent = '↑'
  send.style.cssText =
    'flex:0 0 auto;width:26px;height:26px;border:none;border-radius:50%;cursor:default;' +
    'background:#2563eb;color:#fff;font:600 15px/1 system-ui;display:flex;' +
    'align-items:center;justify-content:center;'
  input.addEventListener('keydown', onInputKey, true)
  input.addEventListener('input', autoGrow)
  send.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    submitInput()
  })
  inputWrap.append(input, send)

  // Thin separator isolating the destructive Delete from the rest of the actions.
  const separator = document.createElement('div')
  separator.style.cssText =
    'flex:0 0 auto;width:1px;height:16px;background:rgba(255,255,255,0.10);margin:0 2px;'

  const editBtn = makeIcon('edit')
  const propsBtn = makeIcon('props')
  const threeDBtn = makeIcon('three-d')
  const codeBtn = makeIcon('code')
  const statesBtn = makeIcon('states')
  const deleteBtn = makeIcon('delete')

  // DOM order: comment, [input], edit, props, 3D, code, states | delete. The divider
  // sits before Delete only; the button[data-kind] order stays comment, edit, props,
  // three-d, code, states, delete (the separator has no data-kind).
  // `edit` only renders for plain-text stamped leaves (setEditAction) — the
  // discoverable form of the double-click-to-edit gesture.
  toolbar.append(
    commentBtn,
    inputWrap,
    editBtn,
    propsBtn,
    threeDBtn,
    codeBtn,
    statesBtn,
    separator,
    deleteBtn
  )

  shadow.append(sel, box, guideMeas, meas, label, pins, hint, toolbar, style)
  document.documentElement.appendChild(host)
  overlayHost = host
  overlayBox = box
  overlayLabel = label
  pinsLayer = pins
  selLayer = sel
  measureLayer = meas
  guideLayer = guideMeas
  hintEl = hint
  toolbarEl = toolbar
  inputWrapEl = inputWrap
  inputEl = input
  submitEl = send
  separatorEl = separator
}

/** Show/hide the props + delete actions (and delete's divider). Hidden while the
 *  inline comment/annotate input is open — those actions don't apply there. */
function setTrailingActions(show: boolean): void {
  const disp = show ? 'flex' : 'none'
  toolbarEl
    ?.querySelector<HTMLButtonElement>('[data-kind="three-d"]')
    ?.style.setProperty('display', disp)
  toolbarEl
    ?.querySelector<HTMLButtonElement>('[data-kind="props"]')
    ?.style.setProperty('display', disp)
  toolbarEl
    ?.querySelector<HTMLButtonElement>('[data-kind="delete"]')
    ?.style.setProperty('display', disp)
  if (separatorEl) separatorEl.style.display = show ? 'block' : 'none'
  // Edit re-derives from the current selection's editability when shown.
  if (show) setEditAction()
  else
    toolbarEl
      ?.querySelector<HTMLButtonElement>('[data-kind="edit"]')
      ?.style.setProperty('display', 'none')
}

// Void/replaced elements have no editable text child even with 0 children.
const NON_TEXT_TAGS = new Set([
  'input',
  'textarea',
  'select',
  'img',
  'br',
  'hr',
  'svg',
  'canvas',
  'video',
  'iframe',
  'audio',
  'embed',
  'object',
  'picture',
  'source'
])

/**
 * True when an element can be edited in place: a directly-stamped element whose
 * only content is plain text (no child elements) — so its `data-trezi-source`
 * maps to exactly this element's text child. Matches the onDblClick guard so the
 * toolbar's Edit button and the double-click gesture agree on "when it's possible".
 */
function isTextEditable(el: Element): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.childElementCount === 0 &&
    sourceStamp(el) !== null &&
    !NON_TEXT_TAGS.has(el.tagName.toLowerCase())
  )
}

/** Reveal the Edit-text action only for the current selection when it's a
 *  plain-text stamped leaf; hide it otherwise. */
function setEditAction(): void {
  const b = toolbarEl?.querySelector<HTMLButtonElement>('[data-kind="edit"]')
  if (!b) return
  b.style.display = selectedEl && isTextEditable(selectedEl) ? 'flex' : 'none'
}

/**
 * Outline the picked element persistently. Stamped elements highlight every
 * sibling with the same data-trezi-source (the same component/loop instance
 * set), Figma-style; the badge on the pick reads "h3 × 4" then.
 */
let pickedElements: Element[] = []

function setSelectionHighlight(el: Element | null, group?: Element[]): void {
  pickedElements = group ?? (el ? [el] : [])
  ensureOverlay()
  if (!selLayer) return
  selLayer.textContent = ''
  selEls = []
  // The native rulers show the selection's extent; reported on the next frame.
  overlayGuides.report()
  if (!el) return
  const src = findSource(el)
  let els: Element[] = [el]
  if (group) els = group
  if (src && !group) {
    try {
      // The stamp may live on el itself or an ancestor; the stamped elements ARE
      // the component instances — outline those (all of them).
      const same = Array.from(document.querySelectorAll(sourceSelector(src)))
      if (same.length) els = same
    } catch {
      /* malformed stamp for a selector — outline just the pick */
    }
  }
  selEls = els
  for (let i = 0; i < els.length; i++) {
    const b = document.createElement('div')
    b.setAttribute('data-trezi-selbox', '')
    // Thinner than the 2px hover box — selected-but-not-hovered reads calmer.
    b.style.cssText =
      'position:fixed;pointer-events:none;box-sizing:border-box;display:none;' +
      'border:1px solid #2563eb;border-radius:3px;'
    selLayer.appendChild(b)
  }
  const badge = makeChip()
  badge.setAttribute('data-trezi-selbadge', '')
  const tag = (els[0] ?? el).tagName.toLowerCase()
  chipName(
    badge,
    group && els.length > 1
      ? `${els.length} objects`
      : els.length > 1
        ? `${tag} × ${els.length}`
        : shortLabel(el)
  )
  // Size comes from positionSelection — it holds the anchor's live rect, and
  // re-runs on every scroll/resize/mutation, so the numbers track the layout.
  selLayer.appendChild(badge)
  positionSelection()
}

/** Track the selection outlines to their elements' current rects. */
function positionSelection(): void {
  if (!selLayer || !selEls.length) return
  const nodes = selLayer.children
  let anchor: DOMRect | null = null
  selEls.forEach((e, i) => {
    const b = nodes[i] as HTMLElement | undefined
    if (!b) return
    if (!e.isConnected) {
      b.style.display = 'none'
      return
    }
    const r = e.getBoundingClientRect()
    if (!anchor) anchor = r
    b.style.display = 'block'
    b.style.left = `${r.left}px`
    b.style.top = `${r.top}px`
    b.style.width = `${r.width}px`
    b.style.height = `${r.height}px`
  })
  const badge = nodes[selEls.length] as HTMLElement | undefined
  if (badge) {
    if (anchor) {
      const a = anchor as DOMRect
      badge.style.display = 'block'
      badge.style.left = `${a.left}px`
      badge.style.top = `${Math.max(a.top - 2, 12)}px`
      chipSize(badge, a)
    } else {
      badge.style.display = 'none'
    }
  }
  overlayGuides.report()
}

/**
 * LKM-172: a selection whose elements all left the page, with no element carrying
 * the same source stamp (HMR swaps nodes), is dropped here and main clears the chat
 * chip and the editing island. It takes two misses in a row on the 600 ms cadence,
 * so a re-render that removes a node and adds it back keeps the selection.
 */
let selectionMisses = 0

function checkSelectionGone(): void {
  const alive = (el: Element): boolean => {
    if (el.isConnected) return true
    const src = findSource(el) // attributes survive on detached nodes
    if (!src) return false
    try {
      return !!document.querySelector(sourceSelector(src))
    } catch {
      return false
    }
  }
  if (
    !pickedElements.length ||
    editing ||
    commenting ||
    threeD.active() ||
    pickedElements.some(alive)
  ) {
    selectionMisses = 0
    return
  }
  if (++selectionMisses < 2) return
  selectionMisses = 0
  selectedEl = null
  hideToolbar()
  setSelectionHighlight(null)
  clearMeasure()
  ipcRenderer.send(SELECTION_LOST)
}

/** Anchor the toolbar just under the selected element (above if no room). */
function positionToolbar(): void {
  if (!toolbarEl || !selectedEl) return
  const r = selectedEl.getBoundingClientRect()
  const w = toolbarEl.offsetWidth || 128
  const h = toolbarEl.offsetHeight || 36
  const left = Math.min(Math.max(r.left, 8), Math.max(window.innerWidth - w - 8, 8))
  let top = r.bottom + 8
  if (top + h > window.innerHeight - 8) top = r.top - h - 8
  toolbarEl.style.left = `${left}px`
  toolbarEl.style.top = `${Math.max(top, 8)}px`
}

function showToolbar(el: Element): void {
  ensureOverlay()
  if (!toolbarEl) return
  selectedEl = el
  // The code action needs a source stamp to open a file — hide it otherwise.
  const codeBtn = toolbarEl.querySelector<HTMLButtonElement>('[data-kind="code"]')
  if (codeBtn) codeBtn.style.display = findSource(el) ? 'flex' : 'none'
  // Edit-text only applies to plain-text stamped leaves.
  setEditAction()
  toolbarEl.style.display = 'flex'
  positionToolbar()
}

function hideToolbar(): void {
  resetInput()
  if (toolbarEl) toolbarEl.style.display = 'none'
}

// Dot nodes are built once per pin (on SET_PINS) and only repositioned on
// scroll/resize/tick — no per-frame teardown or listener churn.
const pinDots = new Map<string, { selector: string; dot: HTMLDivElement }>()

/** Rebuild the pin nodes from the current annotation list. */
function buildPins(): void {
  // Don't materialize the overlay host just to hold an empty pins layer. An idle
  // preview (no annotations, select/comment off) must leave the previewed app's
  // DOM untouched — otherwise a stray, empty `data-trezi-overlay` div is injected
  // into every page on load, which shows up when inspecting the app.
  if (!annotationPins.length) {
    pinDots.clear()
    if (pinsLayer) pinsLayer.textContent = ''
    return
  }
  ensureOverlay()
  if (!pinsLayer) return
  pinsLayer.textContent = ''
  pinDots.clear()
  let note = 0
  for (const pin of annotationPins) {
    const asking = typeof pin.label === 'string'
    const dot = document.createElement('div')
    dot.style.cssText =
      'position:fixed;pointer-events:auto;cursor:default;width:18px;height:18px;' +
      'display:none;align-items:center;justify-content:center;border-radius:50%;' +
      `background:${asking ? '#0a84ff' : '#f59e0b'};color:#fff;font:700 10px/1 ui-monospace,Menlo,sans-serif;` +
      'box-shadow:0 1px 3px rgba(0,0,0,0.3);transform:translate(-50%,-50%);'
    dot.textContent = asking ? String(pin.label).slice(0, 2) : String(++note)
    if (asking) dot.title = 'A background agent needs your answer in the chat'
    dot.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      ipcRenderer.send(PIN_CLICK, pin.id)
    })
    pinsLayer!.appendChild(dot)
    pinDots.set(pin.id, { selector: pin.selector, dot })
  }
  positionPins()
}

/** Move each existing pin dot to its element's current position (or hide it). */
function positionPins(): void {
  for (const { selector, dot } of pinDots.values()) {
    let el: Element | null = null
    try {
      el = document.querySelector(selector)
    } catch {
      el = null
    }
    if (!el || isOverlay(el)) {
      dot.style.display = 'none'
      continue
    }
    const r = el.getBoundingClientRect()
    dot.style.display = 'flex'
    dot.style.left = `${Math.max(r.right, 10)}px`
    dot.style.top = `${Math.max(r.top, 10)}px`
  }
}

function hideOverlay(): void {
  if (overlayBox) overlayBox.style.display = 'none'
  if (overlayLabel) overlayLabel.style.display = 'none'
  overlayGuides.hover(null)
}

/** Keep our overlay and project-owned tuning panels outside element selection. */
function isOverlay(el: Element | null): boolean {
  return (
    !!el &&
    (!!el.closest(CONTROL_OVERLAY_SELECTOR) ||
      nativeCover.contains(el) ||
      (!!overlayHost && (el === overlayHost || overlayHost.contains(el))))
  )
}

// The blue chip that names the element — both the hover label and the selection
// badge are one. It holds two spans: the name (`div.card`, or `h3 × 4` for a
// multi-instance pick) and a dimmed `w × h` size read off the element's box.
const CHIP_CSS =
  'position:fixed;pointer-events:none;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
  'color:#fff;background:#2563eb;padding:2px 6px;border-radius:4px;white-space:nowrap;' +
  'transform:translateY(-100%);display:none;'

function makeChip(): HTMLDivElement {
  const chip = document.createElement('div')
  chip.style.cssText = CHIP_CSS
  const name = document.createElement('span')
  const size = document.createElement('span')
  size.setAttribute('data-trezi-size', '')
  size.style.cssText = 'margin-left:6px;font-weight:500;opacity:0.72;'
  chip.append(name, size)
  return chip
}

function chipName(chip: HTMLElement, text: string): void {
  setText(chip.firstElementChild, text)
}

/** Rounded to whole px — sub-pixel rects are layout noise at this size. */
function chipSize(chip: HTMLElement, r: DOMRect): void {
  setText(chip.lastElementChild, `${Math.round(r.width)} × ${Math.round(r.height)}`)
}

/** Both chips are rewritten on every hover move and scroll frame; skip the
 *  no-op writes so the overlay doesn't churn the DOM while nothing changed. */
function setText(el: Element | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text
}

/** Authored classes suitable for human-facing selection labels. Compiler scope
 *  markers use selector internals, not identity, so omit them before the cap. */
function displayClasses(el: Element, limit: number): string[] {
  return typeof el.className === 'string' && el.className.trim()
    ? el.className
        .trim()
        .split(/\s+/)
        .filter((cls) => !isScopeClass(cls))
        .slice(0, limit)
    : []
}

function shortLabel(el: Element): string {
  const id = el.id ? `#${el.id}` : ''
  const classes = displayClasses(el, 2)
  const cls = classes.length ? `.${classes.join('.')}` : ''
  return `${el.tagName.toLowerCase()}${id}${cls}`
}

function drawOverlay(el: Element): void {
  ensureOverlay()
  if (!overlayBox || !overlayLabel) return
  const r = el.getBoundingClientRect()
  overlayBox.style.display = 'block'
  overlayBox.style.left = `${r.left}px`
  overlayBox.style.top = `${r.top}px`
  overlayBox.style.width = `${r.width}px`
  overlayBox.style.height = `${r.height}px`
  overlayLabel.style.display = 'block'
  overlayLabel.style.left = `${r.left}px`
  overlayLabel.style.top = `${Math.max(r.top - 2, 12)}px`
  chipName(overlayLabel, shortLabel(el))
  chipSize(overlayLabel, r)
}

// Hover has no host/Bun/XPC hop. Coalesce WebContent's layout reads and writes.
const hover = coalesceHover(({ el, at }: { el: Element; at: number }) => {
  if (!el.isConnected || (!active && !commentMode) || editing || commenting) return
  const start = performance.now()
  drawOverlay(el)
  drawMeasure(el)
  overlayGuides.hover(el)
  if (previewTimings.enabled) {
    const end = performance.now()
    previewTimings.hover.push(end - at)
    previewTimings.hoverWork.push(end - start)
    performance.measure('trezi.preview.hover', { start: at, end })
    // WebKit paints after this callback and before the next animation frame.
    // The latter timestamp bounds pointer-to-paint without claiming an exact
    // compositor timestamp that JavaScript cannot observe.
    requestAnimationFrame(() => previewTimings.hoverPaintUpperBound.push(performance.now() - at))
  }
})

// ---- Alt/Option spacing measurement ----------------------------------------

// Figma's measurement red. Deliberately not the blue of select/hover — the
// numbers must read as a separate layer over both outlines.
const MEASURE_COLOR = '#f24822'
/** Half-length of the perpendicular tick capping each measured span. */
const CAP = 3.5

function rectOf(el: Element): MeasureRect {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

/** One axis-aligned hairline. `dashed` marks a guide (an extended edge) rather
 *  than a measured span. */
function measureLine(l: MeasureLine, dashed: boolean): HTMLDivElement {
  const d = document.createElement('div')
  const w = Math.abs(l.x2 - l.x1)
  const h = Math.abs(l.y2 - l.y1)
  const vertical = h >= w
  const fill = dashed
    ? `background:repeating-linear-gradient(${vertical ? 'to bottom' : 'to right'},` +
      `${MEASURE_COLOR} 0 3px,transparent 3px 6px);opacity:0.6;`
    : `background:${MEASURE_COLOR};`
  d.style.cssText =
    `position:fixed;pointer-events:none;left:${Math.min(l.x1, l.x2)}px;` +
    `top:${Math.min(l.y1, l.y2)}px;width:${vertical ? 1 : w}px;` +
    `height:${vertical ? h : 1}px;${fill}`
  return d
}

/** The tick that closes off a measured span's end. */
function measureCap(x: number, y: number, axis: 'x' | 'y'): HTMLDivElement {
  const d = document.createElement('div')
  const vertical = axis === 'x' // an x-axis span is capped by vertical ticks
  d.style.cssText =
    `position:fixed;pointer-events:none;background:${MEASURE_COLOR};` +
    `left:${vertical ? x : x - CAP}px;top:${vertical ? y - CAP : y}px;` +
    `width:${vertical ? 1 : CAP * 2}px;height:${vertical ? CAP * 2 : 1}px;`
  return d
}

function measureLabel(text: string, x: number, y: number): HTMLDivElement {
  const d = document.createElement('div')
  d.setAttribute('data-trezi-measure-label', '')
  d.textContent = text
  d.style.cssText =
    `position:fixed;pointer-events:none;left:${x}px;top:${y}px;` +
    'transform:translate(-50%,-50%);white-space:nowrap;' +
    'font:700 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;' +
    `background:${MEASURE_COLOR};padding:2px 6px;border-radius:5px;`
  return d
}

function clearMeasure(): void {
  if (!measureTarget && !measureKey) return // nothing drawn — don't touch the DOM
  measureTarget = null
  measureKey = ''
  if (measureLayer) measureLayer.textContent = ''
}

/**
 * Draw the distances from the selection to `target` — or clear them when the
 * gesture no longer applies (Option released, nothing selected, the pointer is
 * over the selection itself or over our own overlay, a composer is open).
 *
 * Re-run on every mousemove while Option is down, plus on scroll/resize, so the
 * numbers track live layout; the geometry key makes the repeat calls cheap.
 */
function drawMeasure(target: Element | null): void {
  const anchor = selectedEl
  if (
    !altHeld ||
    editing ||
    commenting ||
    !anchor ||
    !anchor.isConnected ||
    !target ||
    !target.isConnected ||
    target === anchor ||
    isOverlay(target)
  ) {
    clearMeasure()
    return
  }
  ensureOverlay()
  if (!measureLayer) return
  const a = rectOf(anchor)
  const b = rectOf(target)
  const key = [a.left, a.top, a.right, a.bottom, b.left, b.top, b.right, b.bottom]
    .map((n) => Math.round(n))
    .join(',')
  if (target === measureTarget && key === measureKey) return
  measureTarget = target
  measureKey = key
  measureLayer.textContent = ''
  const { segments, guides } = measureRects(a, b)
  for (const g of guides) measureLayer.appendChild(measureLine(g, true))
  for (const s of segments) {
    measureLayer.appendChild(measureLine(s, false))
    measureLayer.appendChild(measureCap(s.x1, s.y1, s.axis))
    measureLayer.appendChild(measureCap(s.x2, s.y2, s.axis))
    measureLayer.appendChild(
      measureLabel(formatDistance(s.distance), (s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2)
    )
  }
}

/** Re-derive the measurement from the current Option state + hovered element.
 *  Called from the key handlers and from scroll/resize. */
function refreshMeasure(): void {
  drawMeasure(altHeld ? (measureTarget ?? lastHovered) : null)
}

/** A short, reasonably-stable CSS selector path (id wins; else tag:nth-of-type). */
function cssPath(el: Element): string {
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && parts.length < 5) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`)
      break
    }
    const tag = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
    const part = sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag
    parts.unshift(part)
    node = parent
  }
  return parts.join(' > ')
}

/**
 * The source stamp the opened repo opts into (see DESIGN.md): a
 * `data-trezi-source="path/to/File.tsx:line"` attribute. We walk up to the
 * nearest stamped ancestor so a click on a deep text node still resolves to the
 * component that owns it.
 */
function findSource(el: Element): string | null {
  let node: Element | null = el
  while (node) {
    const stamp = sourceStamp(node)
    if (stamp) return stamp
    node = node.parentElement
  }
  return null
}

/**
 * The nearest COMPONENT-instance call site (v8 F3a): `data-trezi-component-source`,
 * which the stamp plugin forwards through `{...props}` so the authored
 * `<Component …/>` wins over the innermost host's `data-trezi-source`. Walk up the
 * same way so a click on a deep child still resolves to its owning instance.
 */
function findComponentSource(el: Element): string | null {
  let node: Element | null = el
  while (node) {
    const stamp = sourceStamp(node, true)
    if (stamp) return stamp
    node = node.parentElement
  }
  return null
}

function describe(el: Element): SelectedElement {
  const cs = getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const prop of TRACKED_STYLES) {
    const v = cs.getPropertyValue(prop)
    if (v) styles[prop] = v.trim()
  }
  const r = el.getBoundingClientRect()
  const rawText = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const classes = displayClasses(el, 20)
  // The previewed page is only semi-trusted; cap every page-controlled field so
  // a pathological/hostile attribute can't bloat the IPC payload, store, or prompt.
  return {
    tag: el.tagName.toLowerCase().slice(0, 50),
    id: (el.id || '').slice(0, 100) || null,
    classes,
    selector: cssPath(el).slice(0, 300),
    source: (findSource(el) ?? '').slice(0, 256) || null,
    componentSource: (findComponentSource(el) ?? '').slice(0, 256) || null,
    text: rawText ? rawText.slice(0, 120) : null,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    styles,
    layerPath: layerPathOf(el)
  }
}

// ---- Layers panel: bulk tree read, panel-driven select/hover, DOM watch -----

function isValidFingerprint(fp: unknown): fp is LayerFingerprint {
  const f = fp as LayerFingerprint | null | undefined
  return !!f && typeof f.tag === 'string' && (f.source === null || typeof f.source === 'string')
}

/**
 * A Layers row click. Reuses the exact same functions the real in-page click
 * handler uses (`describe`/`showToolbar`/`setSelectionHighlight`), so the
 * resulting SelectedElement carries a real rect/styles/selector and the normal
 * persistent outline draws — no separate selection path to keep in sync.
 * Ignored while an inline edit/comment composer is open, same guard `onMove`
 * uses for HMR self-healing, so a Layers pick can't step on it.
 */
function layersSelect(path: number[], fingerprint: LayerFingerprint): void {
  if (editing || commenting) return
  threeD.close()
  const el = resolveLayerElement(path, fingerprint)
  if (!el) return
  ipcRenderer.send(PICKED, describe(el))
  resetInput()
  showToolbar(el)
  setSelectionHighlight(el)
}

/** A Layers row hover — the transient hover box, not the persistent selection. */
function layersHover(path: number[] | null, fingerprint: LayerFingerprint | null): void {
  if (!path || !fingerprint) {
    hideOverlay()
    return
  }
  const el = resolveLayerElement(path, fingerprint)
  if (el) drawOverlay(el)
  else hideOverlay()
}

let layersObserver: MutationObserver | null = null
let layersDebounceTimer: ReturnType<typeof setTimeout> | null = null
let layersFirstMutationAt = 0
const LAYERS_DEBOUNCE_MS = 400
// Hard ceiling so a page that never stops mutating can't starve the debounce
// indefinitely — force-emit once this much time has passed since the first
// unflushed mutation in the current burst.
const LAYERS_MAX_WAIT_MS = 2000

function emitLayersChanged(): void {
  if (layersDebounceTimer) {
    clearTimeout(layersDebounceTimer)
    layersDebounceTimer = null
  }
  layersFirstMutationAt = 0
  ipcRenderer.send(LAYERS_CHANGED)
}

function onLayersMutation(): void {
  const now = Date.now()
  if (!layersFirstMutationAt) layersFirstMutationAt = now
  if (now - layersFirstMutationAt >= LAYERS_MAX_WAIT_MS) {
    emitLayersChanged()
    return
  }
  if (layersDebounceTimer) clearTimeout(layersDebounceTimer)
  layersDebounceTimer = setTimeout(emitLayersChanged, LAYERS_DEBOUNCE_MS)
}

/**
 * Arm/disarm a debounced structural watch, gated to "panel open" so it costs
 * nothing otherwise. `childList`-only, no `attributes`/`characterData`: class
 * or text churn doesn't invalidate a child-index PATH, only a row's cosmetic
 * label (a manual refresh covers that) — watching them would multiply
 * mutation-callback volume on a busy page for nothing structural.
 */
function setLayersWatch(on: boolean): void {
  if (on) {
    if (layersObserver || !document.body) return
    layersObserver = new MutationObserver(onLayersMutation)
    layersObserver.observe(document.body, { childList: true, subtree: true })
  } else {
    layersObserver?.disconnect()
    layersObserver = null
    if (layersDebounceTimer) {
      clearTimeout(layersDebounceTimer)
      layersDebounceTimer = null
    }
    layersFirstMutationAt = 0
  }
}

// ---- Styles panel: live injection, exact revert, reads, transition replay ---

// Original inline values, stashed on FIRST touch per property so clear-preview
// restores the element exactly ('' = the property was absent → removeProperty).
// The stash is bound to the element it was taken from (styleStashEl): restores
// always target THAT element — never whatever happens to be selected when a
// deferred clear-preview finally arrives — and previewing a different element
// first reverts the old one and resets the stash, so a stale entry can neither
// leak an override nor be replayed onto the wrong element.
// Navigation wipes this whole isolated world, which is the correct lifetime: a
// fresh page has no overrides left to revert.
const styleOriginals = new Map<string, string>()
let styleStashEl: HTMLElement | null = null

/**
 * The element style ops target: the current selection, re-resolved through its
 * `data-trezi-source` stamp when HMR swapped the node out from under us.
 */
function resolveStyleTarget(): HTMLElement | null {
  if (threeD.active()) {
    const target = threeD.selected()
    selectedEl = target
    return target instanceof HTMLElement ? target : null
  }
  let el: Element | null = selectedEl
  if (el && !el.isConnected) {
    const src = findSource(el) // attributes survive on detached nodes
    el = null
    if (src) {
      try {
        el = document.querySelector(sourceSelector(src))
      } catch {
        el = null
      }
    }
    if (el) selectedEl = el // heal the selection for subsequent ops
  }
  return el instanceof HTMLElement && el.isConnected ? el : null
}

/** Point the stash at `el`, reverting any overrides left on a previous target. */
function retargetStash(el: HTMLElement): void {
  if (styleStashEl === el) return
  if (styleStashEl?.isConnected) {
    for (const [prop, orig] of styleOriginals) {
      if (orig) styleStashEl.style.setProperty(prop, orig)
      else styleStashEl.style.removeProperty(prop)
    }
  }
  styleOriginals.clear()
  styleStashEl = el
}

function stashOriginal(el: HTMLElement, prop: string): void {
  retargetStash(el)
  if (!styleOriginals.has(prop)) styleOriginals.set(prop, el.style.getPropertyValue(prop))
}

/** Restore one stashed inline value exactly (removeProperty when it was absent)
 *  onto the element the stash was taken from. A disconnected stash element means
 *  HMR replaced the node — the override died with it, so only the entry drops. */
function restoreOriginal(prop: string): void {
  if (!styleOriginals.has(prop)) return
  const orig = styleOriginals.get(prop) ?? ''
  styleOriginals.delete(prop)
  const el = styleStashEl
  if (!styleOriginals.size) styleStashEl = null
  if (!el?.isConnected) return
  if (orig) el.style.setProperty(prop, orig)
  else el.style.removeProperty(prop)
}

/** Live scrub override: stash the original inline value, then inject. */
function previewStyle(prop: string, value: string): void {
  const el = resolveStyleTarget()
  if (!el) return
  stashOriginal(el, prop)
  el.style.setProperty(prop, value)
}

function clearStylePreview(prop?: string): void {
  if (prop) restoreOriginal(prop)
  else for (const p of Array.from(styleOriginals.keys())) restoreOriginal(p)
}

/**
 * Fresh computed values for the panel (pick-time snapshots go stale).
 *
 * `props` may include CUSTOM properties (`--color-text`): the Styles panel asks
 * for the project's design tokens by name so it can resolve each one AGAINST
 * THIS ELEMENT. That's what makes token naming correct under a
 * `@media (prefers-color-scheme: dark)` override or a `var()` alias chain,
 * where the value recorded in the token file is not.
 *
 * `declaredVars` is the proof half: for each EDITABLE longhand (never the
 * `--var` names above — those are read for their own value, not to prove some
 * other property references them), the exact `--name` its SPECIFIED
 * declaration references, via `style-provenance.ts`, or null when it's a
 * literal. `computed`'s value-equality was always a guess (`var()` never
 * survives `getComputedStyle`); this is what lets the panel tell "IS this
 * token" from "happens to equal it" instead.
 */
function readStyles(id: unknown, props: string[]): void {
  const el = resolveStyleTarget()
  if (!el) {
    ipcRenderer.send(STYLES_READ_REPLY, { id, values: null, declaredVars: null, specified: null })
    return
  }
  const cs = getComputedStyle(el)
  const values: Record<string, string> = {}
  // Same cap discipline as describe(): the page is only semi-trusted, so bound
  // every string that crosses the IPC boundary. Generous enough for the ~20
  // editable longhands plus a real project's token set.
  const bounded: string[] = []
  for (const prop of props.slice(0, 240)) {
    if (typeof prop !== 'string') continue
    const p = prop.slice(0, 64)
    bounded.push(p)
    values[p] = cs.getPropertyValue(p).trim().slice(0, 256)
  }
  // One stylesheet walk yields BOTH proof halves: `declaredVars` (the var name
  // a design token must match to be NAMED) and `specified` (the AUTHORED css
  // text — `1.5rem`, not the `24px` computed style collapses it to;
  // getComputedStyle always serializes lengths as used px, so the authored
  // unit only survives here). Same boundary caps as `values`: all of it is
  // page-controlled CSS. An absurd var name just fails the proof match —
  // fails safe to the raw value.
  const spec = specifiedValues(
    el,
    bounded.filter((b) => !b.startsWith('--'))
  )
  const declaredVars: Record<string, string | null> = {}
  const specified: Record<string, string> = {}
  for (const [p, text] of Object.entries(spec)) {
    const name = varRefName(text)
    declaredVars[p] = name ? name.slice(0, 128) : null
    specified[p] = text.trim().slice(0, 256)
  }
  ipcRenderer.send(STYLES_READ_REPLY, { id, values, declaredVars, specified })
}

// One pending replay at a time (there's only one selection); starting another
// finalizes the previous immediately so its timer can't restore stale values.
let replayDone: (() => void) | null = null

/** Worst-case transition time for the element, bounding the replay cleanup. */
function replayTimeoutMs(cs: CSSStyleDeclaration): number {
  const maxMs = (list: string): number => {
    let max = 0
    for (const part of list.split(',')) {
      const n = parseFloat(part)
      if (Number.isFinite(n)) max = Math.max(max, /ms\s*$/.test(part.trim()) ? n : n * 1000)
    }
    return max
  }
  return Math.min(maxMs(cs.transitionDuration) + maxMs(cs.transitionDelay) + 150, 5000)
}

/**
 * Replay a transition: jump to `from` with transitions disabled, force reflow so
 * that becomes the committed start state, re-enable, then set `to` — the browser
 * sees a discrete change and runs the transition again. After transitionend (or
 * a computed-duration timeout) the temporary inline values are reverted.
 *
 * Replay keeps its OWN snapshot of the inline values it touches — never the
 * preview stash: a live scrub override (say `transition-duration: 500ms`
 * mid-tune) must survive the replay, drive its timing, and still be revertable
 * by a later clear-preview; completion restores the values that were current
 * when the replay STARTED, not the pre-scrub originals. Transitions are
 * disabled via the `transition-property` LONGHAND only: the shorthand
 * serializes to '' when just some longhands are inline, and setting/removing
 * it would clobber every transition-* override on the element.
 */
function replayStyle(prop: string, from: string, to: string): void {
  const el = resolveStyleTarget()
  if (!el) return
  replayDone?.()
  const snap = new Map<string, string>()
  const save = (p: string): void => {
    if (!snap.has(p)) snap.set(p, el.style.getPropertyValue(p))
  }
  const restore = (p: string): void => {
    const v = snap.get(p) ?? ''
    if (v) el.style.setProperty(p, v)
    else el.style.removeProperty(p)
  }
  save('transition-property')
  save(prop)
  el.style.setProperty('transition-property', 'none')
  el.style.setProperty(prop, from)
  void el.offsetWidth // force reflow — commit `from` before transitions return
  restore('transition-property')
  el.style.setProperty(prop, to)
  let timer: ReturnType<typeof setTimeout> | null = null
  const done = (): void => {
    if (timer) clearTimeout(timer)
    el.removeEventListener('transitionend', onEnd)
    replayDone = null
    if (el.isConnected) restore(prop)
  }
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === el && e.propertyName === prop) done()
  }
  el.addEventListener('transitionend', onEnd)
  timer = setTimeout(done, replayTimeoutMs(getComputedStyle(el)))
  replayDone = done
}

function onMove(e: MouseEvent): void {
  if (threeD.active()) return
  if (previewDrag?.active()) return
  // Self-heal: if the frozen node was swapped out (HMR) without a blur, clear it
  // so a mode isn't stranded anchored to a detached element.
  if (editing && !editing.isConnected) endEdit()
  if (commenting && !commenting.isConnected) {
    // The frozen (input-open) element was swapped out (HMR) — tear the pill down.
    hideToolbar()
    selectedEl = null
    setSelectionHighlight(null)
    setCommentMode(null)
  }
  // The selected element was swapped out (HMR) — the toolbar has nothing to
  // anchor to anymore. (Selection outlines self-hide per-box in
  // positionSelection, since loop siblings can re-render independently.)
  if (selectedEl && !selectedEl.isConnected) {
    selectedEl = null
    hideToolbar()
  }
  if (editing || commenting) return // frozen while editing / composing
  if (!active && !commentMode) return
  const altChanged = altHeld !== e.altKey
  altHeld = e.altKey
  const el = e.target as Element | null
  if (!el || isOverlay(el)) {
    // Over our own UI (toolbar, composer, pins): drop the hover highlight —
    // leaving the last-crossed element lit under the toolbar reads as if IT
    // were selected. The persistent selection outlines are a separate layer.
    lastHovered = null
    hover.clear()
    hideOverlay()
    clearMeasure()
    return
  }
  if (el === lastHovered && !altChanged) return
  lastHovered = el
  hover.move({ el, at: performance.now() })
}

function onClick(e: MouseEvent): void {
  const selectStart = previewTimings.enabled ? performance.now() : 0
  if (threeD.active()) return
  if (editing) return
  // Only genuine user input acts — a hostile page can dispatch synthetic clicks
  // while a mode is armed; isTrusted is false for those.
  if (!e.isTrusted) return
  const el = e.target as Element | null
  if (!el || isOverlay(el)) return
  if (active) {
    // Swallow the click so the previewed app doesn't also act on it.
    e.preventDefault()
    e.stopPropagation()
    lastHovered = null
    hover.clear()
    hideOverlay()
    clearMeasure()
    const group = e.shiftKey
      ? pickedElements.includes(el)
        ? pickedElements.filter((item) => item !== el && item.isConnected)
        : [...pickedElements.filter((item) => item.isConnected), el]
      : [el]
    const target = group.at(-1)
    if (!target) {
      ipcRenderer.send(PICKED, { ...describe(el), selectionGroup: [] })
      selectedEl = null
      hideToolbar()
      setSelectionHighlight(null)
      return
    }
    ipcRenderer.send(PICKED, { ...describe(target), selectionGroup: group.map(describe) })
    // A fresh pick resets element-scoped surfaces: clear any open input from the
    // previous selection, then show the toolbar (State A) + persistent outlines.
    resetInput()
    showToolbar(target)
    setSelectionHighlight(target, e.shiftKey ? group : undefined)
    if (previewTimings.enabled) {
      const end = performance.now()
      previewTimings.select.push(end - selectStart)
      performance.measure('trezi.preview.select', { start: selectStart, end })
    }
  } else if (commentMode) {
    e.preventDefault()
    e.stopPropagation()
    // Whole-page C/Y flow: anchor the pill to this element and morph straight to
    // the inline input (no prior pick — Escape hides the pill entirely).
    showToolbar(el)
    enterInputState(commentMode, el, true)
  }
}

// ---- Inline text editing: double-click a stamped, text-only element ---------
let editing: HTMLElement | null = null
let editOriginal = ''

function onDblClick(e: MouseEvent): void {
  if (threeD.active()) return
  if (!active || editing || !e.isTrusted) return
  const el = e.target as HTMLElement | null
  // Only a directly-stamped element with plain text (no child elements) — so the
  // source maps to exactly this element's text child.
  if (!el || isOverlay(el) || !isTextEditable(el)) return
  e.preventDefault()
  e.stopPropagation()
  startTextEdit(el)
}

/** Enter the inline contentEditable edit on a plain-text stamped leaf. Shared by
 *  the double-click gesture and the toolbar's Edit-text button. */
function startTextEdit(el: HTMLElement): void {
  if (editing) return
  editing = el
  editOriginal = el.textContent ?? ''
  hideOverlay()
  el.setAttribute('contenteditable', 'plaintext-only')
  el.style.outline = '2px solid #2563eb'
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  el.addEventListener('blur', commitEdit, { once: true })
  el.addEventListener('keydown', onEditKey, true)
}

function endEdit(): HTMLElement | null {
  const el = editing
  if (!el) return null
  el.removeEventListener('keydown', onEditKey, true)
  el.removeAttribute('contenteditable')
  el.style.outline = ''
  editing = null
  return el
}

function commitEdit(): void {
  const el = endEdit()
  if (!el) return
  const text = el.textContent ?? ''
  const source = sourceStamp(el)
  if (source && text.trim() !== editOriginal.trim()) {
    ipcRenderer.send(TEXT_EDIT, { source: source.slice(0, 256), text: text.slice(0, 2000) })
  }
}

function onEditKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    ;(editing as HTMLElement | null)?.blur() // triggers commitEdit (once)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    const el = endEdit()
    if (el) {
      el.textContent = editOriginal // restore
      el.blur()
    }
    setActive(false)
    ipcRenderer.send(CANCELLED)
  }
}

// ---- Inline commenting: C → comment-to-agent, Y → annotation ----------------

function autoGrow(): void {
  const t = inputEl
  if (!t) return
  t.style.height = 'auto'
  t.style.height = `${Math.min(t.scrollHeight, 66)}px`
}

/** Paint the comment/annotate toggles to reflect the open input's kind. */
function paintToggles(): void {
  if (!toolbarEl) return
  for (const k of ['comment', 'annotate'] as const) {
    const b = toolbarEl.querySelector<HTMLButtonElement>(`[data-kind="${k}"]`)
    if (!b) continue
    const on = inputKind === k
    b.dataset.pressed = on ? '1' : '0'
    b.style.background = on ? 'rgba(255,255,255,0.16)' : 'transparent'
    b.style.color = on ? '#fff' : '#d4d4d4'
  }
}

/**
 * Morph the pill's width around a content change: measure the old width, mutate,
 * measure the new (auto) width, then transition between them and clear to auto on
 * transitionend (with a timeout fallback if it never fires). Reposition throughout
 * so the viewport clamping in positionToolbar() stays correct.
 */
function animatePill(mutate: () => void): void {
  const pill = toolbarEl
  if (!pill) {
    mutate()
    return
  }
  const from = pill.offsetWidth
  mutate()
  pill.style.width = 'auto'
  const to = pill.offsetWidth
  if (from === to) {
    pill.style.width = ''
    positionToolbar()
    return
  }
  pill.style.width = `${from}px`
  void pill.offsetWidth // force reflow so the next assignment transitions
  pill.style.width = `${to}px`
  positionToolbar()
  if (widthTimer) clearTimeout(widthTimer)
  const finish = (): void => {
    if (widthTimer) {
      clearTimeout(widthTimer)
      widthTimer = null
    }
    pill.style.width = ''
    positionToolbar()
    pill.removeEventListener('transitionend', onEnd)
  }
  const onEnd = (e: TransitionEvent): void => {
    if (e.propertyName === 'width') finish()
  }
  pill.addEventListener('transitionend', onEnd)
  widthTimer = setTimeout(finish, 260)
}

/** Instantly clear input state back to the icon row (no animation). */
function resetInput(): void {
  commenting = null
  inputKind = null
  inputFromMode = false
  if (toolbarEl) toolbarEl.removeAttribute('data-trezi-composer')
  if (inputEl) inputEl.value = ''
  if (inputWrapEl) {
    inputWrapEl.style.opacity = '0'
    inputWrapEl.style.display = 'none'
  }
  setTrailingActions(true)
  paintToggles()
}

/** Morph the pill into State B — inline comment/annotate input for `el`. */
function enterInputState(kind: CommentMode, el: Element, fromMode: boolean): void {
  ensureOverlay()
  if (!toolbarEl || !inputWrapEl || !inputEl || !submitEl) return
  selectedEl = el
  commenting = el
  inputKind = kind
  inputFromMode = fromMode
  drawOverlay(el)
  if (hintEl) hintEl.style.display = 'none'
  inputEl.value = ''
  inputEl.placeholder = kind === 'annotate' ? 'Add a note…' : 'Ask for changes…'
  submitEl.style.background = kind === 'annotate' ? '#f59e0b' : '#2563eb'
  toolbarEl.setAttribute('data-trezi-composer', '')
  setTrailingActions(false)
  paintToggles()
  animatePill(() => {
    inputWrapEl!.style.display = 'flex'
    requestAnimationFrame(() => {
      if (inputWrapEl) inputWrapEl.style.opacity = '1'
    })
  })
  autoGrow()
  inputEl.focus()
}

/** Swap the open input's kind (the other toggle was clicked) without collapsing. */
function switchInputKind(kind: CommentMode): void {
  if (!inputEl || !submitEl) return
  inputKind = kind
  inputEl.placeholder = kind === 'annotate' ? 'Add a note…' : 'Ask for changes…'
  submitEl.style.background = kind === 'annotate' ? '#f59e0b' : '#2563eb'
  paintToggles()
  inputEl.focus()
}

/** Morph the pill back to State A (icon row), keeping the selection + toolbar. */
function collapseInput(): void {
  if (!inputKind) return
  animatePill(() => resetInput())
}

/** Leading toggles open/switch/collapse the input; trailing icons relay an action. */
function onToolbarButton(kind: string): void {
  const el = selectedEl
  if (!el) return
  if (kind === 'comment' || kind === 'annotate') {
    if (inputKind === kind) collapseInput()
    else if (inputKind) switchInputKind(kind)
    else enterInputState(kind, el, false)
  } else if (kind === 'three-d') {
    hideToolbar()
    hideOverlay()
    clearMeasure()
    setSelectionHighlight(null)
    threeD.open(el)
  } else if (kind === 'edit') {
    // Same in-place edit as double-click, but discoverable from the toolbar.
    if (isTextEditable(el)) startTextEdit(el)
  } else {
    ipcRenderer.send(TOOLBAR_ACTION, kind)
  }
}

function submitInput(): void {
  const text = (inputEl?.value ?? '').replace(/\s+/g, ' ').trim()
  const el = commenting
  const kind = inputKind
  if (el && kind && text) {
    ipcRenderer.send(COMMENT, { kind, el: describe(el), text: text.slice(0, 2000) })
  }
  collapseInput()
  setCommentMode(null) // one comment per arming, like Figma
}

function onInputKey(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitInput()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    if (inputFromMode) {
      // Opened via a whole-page C/Y click with no prior pick — hide the pill.
      hideToolbar()
      selectedEl = null
      setSelectionHighlight(null)
      setCommentMode(null)
    } else {
      collapseInput()
    }
  }
}

function showModeHint(): void {
  if (!hintEl) return
  if (!commentMode) {
    hintEl.style.display = 'none'
    return
  }
  hintEl.textContent =
    commentMode === 'annotate'
      ? 'Annotate: click an element to pin a note'
      : 'Comment: click an element to ask the agent'
  hintEl.style.display = 'block'
  hintEl.style.left = '50%'
  hintEl.style.top = '12px'
  hintEl.style.transform = 'translateX(-50%)'
}

/** True for the previewed app's own editable fields — don't hijack their keys. */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function setCommentMode(next: CommentMode, fromRenderer = false): void {
  if (commentMode === next) return // idempotent — don't disturb an open composer
  // Comment/annotate and select are mutually exclusive.
  if (next && active) {
    setActive(false)
    ipcRenderer.send(CANCELLED) // clear the renderer's select toggle
  }
  resetInput()
  commentMode = next
  if (commentMode) {
    ensureOverlay()
    // Arming a whole-page mode supersedes the element-scoped toolbar (the
    // renderer clears its selection too).
    hideToolbar()
    setSelectionHighlight(null)
    clearMeasure()
    selectedEl = null
    document.documentElement.style.cursor = 'crosshair'
    showModeHint()
  } else {
    if (!active) document.documentElement.style.cursor = ''
    hideOverlay()
    if (hintEl) hintEl.style.display = 'none'
  }
  // Echo keyboard/internal changes so the renderer toolbar can mirror them
  // (renderer-initiated changes already know their own state — avoid a loop).
  if (!fromRenderer) ipcRenderer.send(COMMENT_MODE, commentMode)
}

function onKey(e: KeyboardEvent): void {
  if (threeD.active()) {
    threeD.key(e)
    return
  }
  // Stop page shortcuts at window capture, but retain the browser's editing
  // defaults (caret movement, selection, typing, clipboard and IME).
  if (blockPageInput(e)) {
    if (inputEl && e.composedPath().includes(inputEl)) {
      if (e.isTrusted) onInputKey(e)
      return
    }
    if (editing) {
      if (e.isTrusted) onEditKey(e)
      return
    }
  }
  if (!e.isTrusted || editing) return
  if (commenting) return // the open composer owns keys (its handler manages them)
  if (e.key === 'Escape') {
    if (active) {
      e.preventDefault()
      setActive(false)
      ipcRenderer.send(CANCELLED)
    } else if (commentMode) {
      e.preventDefault()
      setCommentMode(null)
    }
    return
  }
  // Option/Alt down over an already-hovered element: measure to it without
  // waiting for the pointer to move again.
  if (e.key === 'Alt') {
    if (!altHeld) {
      altHeld = true
      refreshMeasure()
    }
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) return
  if (latinKey(e) === 's') {
    // S must work with the preview focused too. The renderer owns the toggle
    // (store + web/simulator routing) — relay instead of flipping locally.
    e.preventDefault()
    ipcRenderer.send(TOGGLE_SELECT)
  }
}

/** Releasing Option (or losing the key entirely on window blur) ends the
 *  measurement — nothing else in the overlay is keyed to it. */
function onKeyUp(e: KeyboardEvent): void {
  if (threeD.active()) {
    e.stopImmediatePropagation()
    return
  }
  blockPageInput(e)
  if (!altHeld) return
  if (e.key === 'Alt' || !e.altKey) {
    altHeld = false
    clearMeasure()
  }
}

/** Run after our gesture handlers, before the preview application's handlers. */
function blockPageInput(e: Event): boolean {
  if (threeD.active()) {
    if (e.type === 'keypress') e.stopImmediatePropagation()
    return e.type === 'keypress'
  }
  if (!active && !editing) return false
  const target = e.target instanceof Element ? e.target : null
  const overlayKey = target === overlayHost && e instanceof KeyboardEvent
  if (isOverlay(target) && !overlayKey) return false
  const inEditor = !!editing && !!target && editing.contains(target)
  e.stopImmediatePropagation()
  // Scrolling remains useful for inspecting a long page. Inside the inline
  // editor only propagation is blocked, so native text editing still works.
  if (!inEditor && !overlayKey && e.type !== 'wheel') e.preventDefault()
  return true
}

function setActive(next: boolean): void {
  active = next
  if (active) {
    ensureOverlay()
    document.documentElement.style.cursor = 'crosshair'
  } else {
    hover.clear()
    lastHovered = null
    // Disarming mid-edit (toolbar toggle / project re-open): discard the edit so
    // it can't strand the element or commit against a stale source.
    if (editing) endEdit()
    hideOverlay()
    hideToolbar()
    setSelectionHighlight(null)
    clearMeasure()
    selectedEl = null
    document.documentElement.style.cursor = ''
  }
}

// ── Mobile bezel overlay ────────────────────────────────────────────────────
// Draw the iPhone frame INSIDE the previewed page so its opaque inner edge masks
// the app's screen corners, sitting visually *over* the content. It's a fixed,
// pointer-events:none image, so every click and element-selection passes straight
// through to the app beneath it. The viewport here equals the native view = the
// frame's screen cutout, so we upscale the frame image and offset it by the
// cutout insets to line the screen hole up with the viewport edges.
let frameHost: HTMLDivElement | null = null

function positionFrame(): void {
  if (!frameHost) return
  const img = frameHost.firstElementChild as HTMLImageElement | null
  if (!img) return
  const wv = window.innerWidth
  const hv = window.innerHeight
  const wf = wv / (1 - (FRAME_INSET.left + FRAME_INSET.right) / 100)
  const hf = hv / (1 - (FRAME_INSET.top + FRAME_INSET.bottom) / 100)
  // !important: the previewed app's own stylesheets apply to these injected
  // elements too — e.g. Tailwind preflight's `img { max-width: 100% }` clamps
  // the upscaled bezel back into the viewport, drawing a second, misaligned
  // phone over the app instead of just the frame's inner edges.
  img.style.setProperty('width', `${wf}px`, 'important')
  img.style.setProperty('height', `${hf}px`, 'important')
  img.style.setProperty('left', `${-(wf * FRAME_INSET.left) / 100}px`, 'important')
  img.style.setProperty('top', `${-(hf * FRAME_INSET.top) / 100}px`, 'important')
}

let frameStyle: HTMLStyleElement | null = null

function hideScrollbars(on: boolean): void {
  // Phones don't show persistent scrollbars — hide them inside the bezel (the
  // desktop-style bar drew right over the frame's edge otherwise).
  if (on && !frameStyle) {
    frameStyle = document.createElement('style')
    frameStyle.setAttribute('data-trezi-frame-style', '')
    frameStyle.textContent =
      '::-webkit-scrollbar{display:none !important;width:0 !important;height:0 !important}' +
      '*,*::before,*::after{scrollbar-width:none !important}'
    document.documentElement.appendChild(frameStyle)
  } else if (!on && frameStyle) {
    frameStyle.remove()
    frameStyle = null
  }
}

function setFrame(on: boolean): void {
  hideScrollbars(on)
  if (!on) {
    frameHost?.remove()
    frameHost = null
    return
  }
  if (frameHost) {
    positionFrame()
    return
  }
  const host = document.createElement('div')
  host.setAttribute('data-trezi-frame', '')
  host.style.cssText =
    'position:fixed !important;inset:0 !important;overflow:hidden !important;' +
    'pointer-events:none !important;z-index:2147483646 !important'
  const img = document.createElement('img')
  img.src = FRAME_DATA_URI
  img.draggable = false
  // max/min-width/height MUST be pinned: a page reset like Tailwind preflight's
  // `img { max-width: 100% }` otherwise clamps the bezel (see positionFrame).
  img.style.cssText =
    'position:absolute !important;pointer-events:none !important;user-select:none;' +
    'max-width:none !important;max-height:none !important;' +
    'min-width:0 !important;min-height:0 !important;' +
    'margin:0 !important;padding:0 !important;border:0 !important;' +
    'transform:none !important;display:block !important'
  host.appendChild(img)
  document.documentElement.appendChild(host)
  frameHost = host
  positionFrame()
}

const threeD = createThreeDInspector({
  publish: (state: ThreeDState | null) => ipcRenderer.send(PREVIEW_THREE_D_STATE, state),
  hasSource: (el) => !!findSource(el),
  code: (el) => {
    selectedEl = el
    ipcRenderer.send(PICKED, describe(el))
    ipcRenderer.send(TOOLBAR_ACTION, 'code')
  },
  select: (el, open) => {
    clearStylePreview()
    selectedEl = el
    ipcRenderer.send(PICKED, describe(el))
    if (open) ipcRenderer.send(TOOLBAR_ACTION, 'props')
  },
  lost: () => {
    selectedEl = null
    ipcRenderer.send(CANCELLED)
  },
  close: () => {
    if (selectedEl?.isConnected) {
      showToolbar(selectedEl)
      setSelectionHighlight(selectedEl)
    }
  }
})

const previewDrag = IS_SIM_BRIDGE
  ? null
  : installDragReorder({
      selection: () => selectedEl,
      blocked: () => threeD.active() || !!(editing || commenting || commentMode),
      overlay: () => {
        ensureOverlay()
        return overlayHost!.shadowRoot!
      },
      clearHover: () => {
        hideOverlay()
        clearMeasure()
      },
      move: (request) => ipcRenderer.send(PREVIEW_MOVE_NODE, request)
    })

// Capture-phase so we see events before the page and can suppress the click.
if (!IS_SIM_BRIDGE) {
  const installReadout = (): void => {
    const readout = createViewportReadout(document.documentElement, true)
    // Use the page's CSS viewport, including scrollbar space, just like DevTools.
    const update = (): void => readout.update(window.innerWidth, window.innerHeight)
    update()
    window.addEventListener('resize', update)
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installReadout, { once: true })
  } else installReadout()
  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('click', onClick, true)
  window.addEventListener('dblclick', onDblClick, true)
  const busy = () => active || !!editing || !!commenting || !!commentMode || threeD.active()
  installHistoryKeys(busy, threeD.active)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKeyUp, true)
  installStatesSwitch(busy)
  installStatesCanvas(busy)
  if (location.protocol.startsWith('http')) watchStyles(() => ipcRenderer.send(STYLES_UPDATED))
  for (const type of [
    'keypress',
    'pointerdown',
    'pointerup',
    'pointermove',
    'mousedown',
    'mouseup',
    'mousemove',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'dragstart',
    'touchstart',
    'touchmove',
    'touchend',
    'wheel',
    'beforeinput',
    'input',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'paste',
    'cut',
    'copy'
  ]) {
    window.addEventListener(type, blockPageInput, { capture: true, passive: false })
  }
  // A window switch (Cmd+Tab) swallows the Option keyup — drop the measurement
  // rather than leave it stuck on when focus comes back.
  window.addEventListener('blur', () => {
    altHeld = false
    hover.clear()
    lastHovered = null
    hideOverlay()
    clearMeasure()
  })
  window.addEventListener(
    'scroll',
    () => {
      hover.clear()
      lastHovered = null
      if (commenting) {
        drawOverlay(commenting) // keep the highlight tracking the frozen el
      } else if (active || commentMode) {
        hideOverlay()
        clearMeasure() // the hover it was measured from is gone too
      }
      if (selectedEl) positionToolbar() // the pill tracks the selection in both states
      if (selEls.length) positionSelection()
      if (pinDots.size) positionPins()
    },
    true
  )
  window.addEventListener('resize', () => {
    if (commenting) drawOverlay(commenting)
    if (selectedEl) positionToolbar()
    if (selEls.length) positionSelection()
    if (pinDots.size) positionPins()
    if (measureTarget) refreshMeasure()
    positionFrame()
  })
  // Cursor left the preview entirely (relatedTarget null) — drop the HOVER
  // highlight so it doesn't stick to the last element; the persistent selection
  // outlines are a separate layer and stay.
  window.addEventListener(
    'mouseout',
    (e: MouseEvent) => {
      if (e.relatedTarget || commenting) return
      lastHovered = null
      hover.clear()
      hideOverlay()
      clearMeasure()
    },
    true
  )
  // After the listeners above, which see the shield as overlay and drop the hover box.
  nativeCover.install()
  ipcRenderer.on(PREVIEW_THREE_D_ACTION, (_e, action: ThreeDAction) => threeD.action(action))
  // The host paints atlas pages here and snapshots only when this answers true (LKM-227).
  // A global of the isolated world: the page cannot reach it.
  ;(globalThis as { __treziThreeDAction?: (action: unknown) => boolean }).__treziThreeDAction = (
    action
  ) => threeD.action(action as ThreeDAction)
  // Main sends them on every load and whenever the host's layout changes them.
  ipcRenderer.on(PREVIEW_COVERED, (_e, rects: unknown) => nativeCover.set(rects))
  ipcRenderer.on(PREVIEW_OVERLAY_LINES, (_e, lines: unknown) => overlayGuides.set(lines))
  // Pins track layout changes (hot-reload, async content) on a light cadence.
  const pinTimer = setInterval(() => {
    if (pinDots.size) positionPins()
    // Selection outlines track layout changes (async content, HMR) the same way.
    if (selEls.length) positionSelection()
    checkSelectionGone()
    if (measureTarget) refreshMeasure()
  }, 600)
  window.addEventListener('pagehide', () => {
    clearInterval(pinTimer)
    if (editing) endEdit()
  })

  // Report whether the previewed app is "trezi-ready" — i.e. its elements carry
  // data-trezi-source stamps — so the app can offer to set up an unprepared project.
  // Re-sampled a few times so a slow-rendering SPA (stamps appear after `load`)
  // isn't falsely flagged; the renderer retracts the offer on any stamps>0 report.
  function reportReadiness(): number {
    if (!location.protocol.startsWith('http')) return -1 // skip the placeholder
    const stamps = document.querySelectorAll(sourceSelector()).length
    ipcRenderer.send(READINESS, {
      stamps,
      url: location.href,
      documentStartedAt: performance.timeOrigin
    })
    return stamps
  }
  window.addEventListener('load', () => {
    const delays = [600, 1500, 3000]
    const tick = (i: number): void => {
      if (i >= delays.length) return
      setTimeout(() => {
        if (reportReadiness() <= 0) tick(i + 1) // keep checking until stamps appear
      }, delays[i])
    }
    tick(0)
  })

  ipcRenderer.on(SET_MODE, (_e, next: boolean) => {
    if (next && commentMode) setCommentMode(null) // exclusivity
    setActive(next)
  })
  ipcRenderer.on(SET_COMMENT_MODE, (_e, m: CommentMode) => setCommentMode(m, true))
  ipcRenderer.on(SET_PINS, (_e, pins: typeof annotationPins) => {
    annotationPins = Array.isArray(pins) ? pins : []
    buildPins()
  })
  ipcRenderer.on(SET_FRAME, (_e, on: boolean) => setFrame(on))
  ipcRenderer.on(PREVIEW_HIDE_SCROLLBARS, (_e, on: boolean) => hideScrollbars(on))
  // The renderer cleared the selection (pill ×, message sent, delete) — drop the
  // element-scoped toolbar + persistent outlines with it.
  ipcRenderer.on(CLEAR_SELECTED, () => {
    selectedEl = null
    threeD.close()
    hideToolbar()
    setSelectionHighlight(null)
    clearMeasure()
  })
  ipcRenderer.on(SET_STATUS, (_e, text: string | null) => setStatusPill(text))
  // Styles panel (relayed from the island by main): payloads originate in our
  // own renderer but are validated anyway — this file runs inside the preview.
  ipcRenderer.on(STYLES_PREVIEW, (_e, p: { prop?: unknown; value?: unknown }) => {
    if (typeof p?.prop === 'string' && typeof p?.value === 'string') previewStyle(p.prop, p.value)
  })
  ipcRenderer.on(STYLES_CLEAR_PREVIEW, (_e, p: { prop?: unknown } | undefined) => {
    clearStylePreview(typeof p?.prop === 'string' ? p.prop : undefined)
  })
  ipcRenderer.on(STYLES_READ, (_e, p: { id?: unknown; props?: unknown }) => {
    readStyles(p?.id, Array.isArray(p?.props) ? (p.props as string[]) : [])
  })
  // A Shadow island gesture shown without source writes (LKM-140, see island-override.ts).
  ipcRenderer.on(ISLAND_OVERRIDE, (_e, p: { id?: unknown } | undefined) => {
    ipcRenderer.send(ISLAND_OVERRIDE_REPLY, { id: p?.id, value: islandOverride(p) })
  })
  ipcRenderer.on(ANIMATION_REPLAY, (_e, component: unknown) => {
    if (typeof component === 'string' && component.length <= 80)
      window.dispatchEvent(new CustomEvent('trezi:animation-replay', { detail: component }))
    window.dispatchEvent(new CustomEvent('praxis:animation-replay', { detail: component }))
  })
  ipcRenderer.on(STYLES_REPLAY, (_e, p: { prop?: unknown; from?: unknown; to?: unknown }) => {
    if (typeof p?.prop === 'string' && typeof p?.from === 'string' && typeof p?.to === 'string')
      replayStyle(p.prop, p.from, p.to)
  })
  ipcRenderer.on(LAYERS_READ, (_e, p: { id?: unknown }) => {
    if (typeof p?.id !== 'number') return
    ipcRenderer.send(LAYERS_READ_REPLY, { id: p.id, snapshot: buildLayersSnapshot() })
  })
  ipcRenderer.on(LAYERS_SELECT, (_e, p: { path?: unknown; fingerprint?: unknown }) => {
    if (!Array.isArray(p?.path) || !isValidFingerprint(p?.fingerprint)) return
    layersSelect(p.path as number[], p.fingerprint)
  })
  ipcRenderer.on(LAYERS_HOVER, (_e, p: { path?: unknown; fingerprint?: unknown } | null) => {
    if (!p || !Array.isArray(p.path) || !isValidFingerprint(p.fingerprint)) {
      layersHover(null, null)
      return
    }
    layersHover(p.path as number[], p.fingerprint)
  })
  ipcRenderer.on(LAYERS_SET_WATCH, (_e, on: boolean) => setLayersWatch(!!on))
  ipcRenderer.on(SET_SPEED, (_e, change: unknown) => sendPageSpeed(change))
}

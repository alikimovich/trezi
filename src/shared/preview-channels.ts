/**
 * Channel names for the main ⇄ preview-preload conversation.
 *
 * These are the ONLY IPC channels that don't go through `shared/api.ts`'s typed
 * application service bridge: the preview preload is sandboxed (bare `ipcRenderer`, no
 * contextBridge), so main and `src/preview/preload.ts` talk in raw channel
 * strings. Both sides used to hand-declare their own copy of every string —
 * twenty-odd literals mirrored by eye, where a single typo silently disables a
 * feature rather than failing anything. Declare them once, here, so a rename is
 * a compile-time concern on both sides.
 *
 * Direction is noted per constant: "→ preload" = main sends, "→ main" = the
 * preload sends (and main re-checks `e.sender` before trusting it — the
 * previewed page is untrusted content).
 */

// ── Element selection / overlay ────────────────────────────────────────────
export const PREVIEW_SET_MODE = 'trezi:preview:set-select-mode' // → preload (boolean)
export const PREVIEW_PICKED = 'trezi:preview:element-picked' // → main (SelectedElement)
export const PREVIEW_CANCELLED = 'trezi:preview:select-cancelled' // → main
export const PREVIEW_TOGGLE_SELECT = 'trezi:preview:toggle-select' // → main (S pressed)
export const PREVIEW_TOOLBAR_ACTION = 'trezi:preview:toolbar-action' // → main (code/delete/props)
export const PREVIEW_CLEAR_SELECTED = 'trezi:preview:clear-selected' // → preload (pill ×, send)
export const PREVIEW_READINESS = 'trezi:preview:readiness' // → main ({stamps})
export const PREVIEW_TEXT_EDIT = 'trezi:preview:text-edit' // → main ({source, text})

// ── Annotation pins ────────────────────────────────────────────────────────
export const PREVIEW_SET_PINS = 'trezi:preview:set-annotations' // → preload (pin list)
export const PREVIEW_PIN_CLICK = 'trezi:preview:pin-click' // → main (pin id)

// ── Inline commenting (C / Y) ──────────────────────────────────────────────
export const PREVIEW_SET_COMMENT_MODE = 'trezi:preview:set-comment-mode' // → preload
export const PREVIEW_COMMENT_MODE = 'trezi:preview:comment-mode' // → main (keyboard-initiated)
export const PREVIEW_COMMENT = 'trezi:preview:comment' // → main (submitted)

// ── Chrome drawn inside the preview ────────────────────────────────────────
export const PREVIEW_HIDE_SCROLLBARS = 'trezi:preview:hide-scrollbars' // → preload (native mobile preview)
export const PREVIEW_SET_FRAME = 'trezi:preview:set-frame' // → preload (mobile bezel)
export const PREVIEW_SET_STATUS = 'trezi:preview:set-status' // → preload (launch pill)
// Viewport rects native views float over (LKM-173): the host reports them on layout
// (`native-cover`), main forwards them and re-sends them after every load.
export const PREVIEW_COVERED = 'trezi:preview:covered' // → preload ({x,y,width,height}[])

// ── Styles tab ─────────────────────────────────────────────────────────────
export const STYLES_PREVIEW = 'styles:preview' // → preload ({prop, value})
export const STYLES_CLEAR_PREVIEW = 'styles:clear-preview' // → preload ({prop?})
export const STYLES_REPLAY = 'styles:replay' // → preload ({prop, from, to})
export const STYLES_READ = 'styles:read' // → preload ({id, props})
export const STYLES_READ_REPLY = 'styles:read-reply' // → main ({id, values|null, …})

// ── Layers panel ───────────────────────────────────────────────────────────
export const LAYERS_READ = 'layers:read' // → preload ({id})
export const LAYERS_READ_REPLY = 'layers:read-reply' // → main ({id, snapshot})
export const LAYERS_CHANGED = 'layers:changed' // → main (debounced mutation ping)
export const LAYERS_SELECT = 'layers:select' // → preload ({path, fingerprint})
export const LAYERS_HOVER = 'layers:hover' // → preload ({path, fingerprint} | null)
export const LAYERS_SET_WATCH = 'layers:set-watch' // → preload (boolean)

export const PREVIEW_MOVE_NODE = 'trezi:preview:move-node' // → main (MoveNodeRequest)

export const ANIMATION_REPLAY = 'trezi:preview:animation-replay' // → preload (component name)

// ── Chat island gestures (LKM-140) ─────────────────────────────────────────
export const ISLAND_OVERRIDE = 'trezi:preview:island-override' // → preload (IslandOverrideRequest)
export const ISLAND_OVERRIDE_REPLY = 'trezi:preview:island-override-reply' // → main ({id, value})

/**
 * The wire format of an ISLAND_OVERRIDE request, one per op of `src/preview/island-override.ts`.
 * The preview still validates every field: the page shares its process and is untrusted.
 */
export type IslandOverrideMessage =
  | { op: 'apply'; key: string; from: string; css: string }
  | { op: 'settle'; key: string; css: string }
  | { op: 'clear'; key: string }
  | { op: 'clearAll' }
/** A message as sent: the id is echoed on ISLAND_OVERRIDE_REPLY. */
export type IslandOverrideRequest = IslandOverrideMessage & { id: number }

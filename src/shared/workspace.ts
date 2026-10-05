import type { Framework, PreviewKind, SourceSetupState } from './api'
import type { ChatAgentSettings } from './chat-settings'

type Viewport = 'desktop' | 'mobile'

export interface LaunchSpec {
  /** Preserve user-entered commands; auto-detected launches are re-detected. */
  customCommand?: boolean
  root: string
  command: string
  framework?: Framework
  previewKind: PreviewKind
}

export interface ProjectEntry {
  environmentRevision?: number
  dependenciesPending?: boolean
  /** Absolute repo root as opened. */
  root: string
  /** Canonical key (`projectKey(root)`) — the dedupe + map identity. */
  key: string
  /** Display name (folder basename, overridable). */
  name: string
  // Per-project display snapshot, restored on switch (chat lives in useChat byKey;
  // tokens/annotations are re-detected on switch).
  url: string | null
  previewKind: PreviewKind
  branch: string | null
  launchSpec: LaunchSpec | null
  /** Preview viewport for THIS project — each remembers its own; restored on
   *  switch (a global viewport leaked one project's Mobile into the next). */
  viewport?: Viewport
  /** Rail: hide this project's chat list. The rail is an ACCORDION — at most one
   *  project's chats are unfolded at a time. Project headers toggle only the
   *  list; selecting a chat activates its project. `activate`/`openOrActivate`
   *  and both header buttons unfold exclusively (see `foldOthers`). Folding
   *  still doesn't deactivate a project — its dev server/preview stay live either
   *  way, only the list is hidden. Persisted with the entry, so a relaunch
   *  restores the same single open project.
   *  Defaults to expanded (undefined = false). */
  chatsCollapsed?: boolean
  /** Monotonic recency stamp (bumped on activate) — drives LRU warm-server eviction. */
  touchedAt: number
  /**
   * v9 resume/multi-chat — this project's live `sessionKey`s (mirrors `agent.ts`'s
   * map): `key` itself for the default chat, plus `` `${key}#…` `` for any
   * additional (`agent:new-chat`) or resumed (`agent:resume-session`) ones.
   * Defaults to just `[key]` — untouched by projects that never open a second chat.
   */
  sessionKeys: string[]
  /** Which of `sessionKeys` is the one currently shown (mirrors `agent.ts`'s
   *  per-project `activeSessionKeyByProject`, kept in sync by whoever switches/
   *  creates/resumes a chat while this project is active). Defaults to `key`. */
  activeSessionKey: string
  /** Model/backend choices for each live chat. Missing entries are legacy
   * workspace data and safely use the defaults. */
  chatSettings?: Record<string, ChatAgentSettings>
  /** Connect to Trezi outcome (LKM-153): stamps seen, "Not now", or the failure. */
  sourceSetup?: SourceSetupState
}

import assert from 'node:assert/strict'

export interface SettingsEvidence {
  foreground: boolean
  width: number
  height: number
  minimumWidth: number
  values: Record<string, string>
  section: string
  sections: { id: string; label: string; symbol: string }[]
  sidebarRows: number
  sidebarSelected: number
  /** The window title, which names the selected section. */
  windowTitle: string
  /** `SourceList.inspect` of the Settings outline and its split item. */
  sourceList: SourceListEvidence
  fullSizeContent: boolean
  trafficLightsOverSidebar: boolean
  sidebarFullHeight: boolean
  controls: {
    id: string
    selected: string
    enabled: boolean
    contained: boolean
    hitTarget: boolean
  }[]
  text: string[]
}
/** The shared source-list setup as `SourceList.inspect` reports it, for either sidebar. */
export interface SourceListEvidence {
  style: string
  behavior: string
  fullHeight?: boolean
  rowHeight?: number
  row?: Record<string, number>
  [key: string]: unknown
}
/** The Settings window's content size when it opens (`SectionedSheetContent.defaultSize`). */
export const SETTINGS_DEFAULT_SIZE = { width: 780, height: 760 }
export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', symbol: 'gearshape' },
  { id: 'providers', label: 'AI Providers', symbol: 'sparkles' },
  { id: 'experimental', label: 'Experimental', symbol: 'testtube.2' },
  { id: 'dreamer', label: 'Dreamer', symbol: 'moon.stars' }
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

/** Always exercise the live minimum plus the normal and wider window widths. */
export function settingsVerificationWidths(minimumWidth: number): number[] {
  assert.ok(
    Number.isFinite(minimumWidth) &&
      minimumWidth > 0 &&
      minimumWidth <= SETTINGS_DEFAULT_SIZE.width,
    `Settings minimum must be valid and no wider than its normal ${SETTINGS_DEFAULT_SIZE.width}-point window`
  )
  return [...new Set([minimumWidth, SETTINGS_DEFAULT_SIZE.width, 960])]
}

/** The source list shows every section, with the requested one selected, shown and titled. */
function assertSidebar(evidence: SettingsEvidence, section: SettingsSection) {
  assert.deepEqual(
    evidence.sections,
    SETTINGS_SECTIONS.map((s) => ({ ...s })),
    'Settings sidebar sections and symbols'
  )
  assert.equal(evidence.sidebarRows, SETTINGS_SECTIONS.length, 'Rendered source-list rows')
  assert.equal(evidence.section, section, 'Selected Settings section')
  assert.equal(
    evidence.sidebarSelected,
    SETTINGS_SECTIONS.findIndex((s) => s.id === section),
    'Rendered source-list selection'
  )
  assert.equal(
    evidence.windowTitle,
    SETTINGS_SECTIONS.find((s) => s.id === section)?.label,
    'Window title names the selected section'
  )
  // A native split-view sidebar (NSSplitViewItem .sidebar, NSOutlineView .sourceList) under the traffic lights.
  assert.equal(evidence.sourceList?.style, 'sourceList', 'Settings outline style')
  assert.equal(evidence.sourceList?.behavior, 'sidebar', 'Settings split item behavior')
  assert.ok(
    evidence.fullSizeContent && evidence.trafficLightsOverSidebar && evidence.sidebarFullHeight,
    'Full-height sidebar under the traffic lights'
  )
}

/** Both sidebars come from the same source-list setup: equal configuration and row geometry. */
export function assertSidebarParity(settings: SourceListEvidence, projects: SourceListEvidence) {
  assert.ok(settings.row && projects.row, 'Both sidebars report a rendered row')
  assert.deepEqual(
    settings,
    projects,
    'Settings and projects sidebars share the source-list configuration'
  )
}

function assertUsable(evidence: SettingsEvidence, width: number) {
  assert.equal(evidence.foreground, true, 'Settings must own foreground focus')
  assert.ok(Math.abs(evidence.width - width) <= 1, 'Requested Settings content width')
  assert.ok(evidence.width >= evidence.minimumWidth)
  for (const control of evidence.controls) {
    assert.ok(
      control.enabled && control.contained && control.hitTarget,
      `Usable, unclipped picker: ${control.id}`
    )
  }
}

/** General and AI Providers panes: titled, with their own rows and every sidebar label readable. */
export function assertSectionEvidence(
  evidence: SettingsEvidence,
  width: number,
  section: Exclude<SettingsSection, 'experimental'>
) {
  assertUsable(evidence, width)
  assertSidebar(evidence, section)
  const ids = evidence.controls.map((c) => c.id).sort()
  if (section === 'general')
    assert.deepEqual(
      ids,
      [
        'activityAutoOpen',
        'agentFileAccess',
        'agentGitAccess',
        'agentMerge',
        'buildCheck',
        'claudePlugins',
        'default',
        'quitDontAsk',
        'workspaceIdle'
      ],
      'General shows the default model, Claude plugins, agent file and Git access, PR merging, workspace cleanup, Activity, quit and build check pickers'
    )
  else
    assert.ok(
      ids.every((id) => id === 'connection' || id === 'providerFallback'),
      'AI Providers shows only its provider picker and the provider fallback picker'
    )
  const lines = evidence.text.map(words)
  for (const required of [
    ...SETTINGS_SECTIONS.map((s) => s.label),
    ...(section === 'general'
      ? ['Default model', 'New chats start with this model.']
      : ['Claude and Codex use your existing sign-ins.'])
  ])
    assert.ok(rendersText(lines, words(required)), `Missing complete foreground text: ${required}`)
}

/** Experimental pane: fail closed on missing pixels, clipped help, stale choices or hidden controls. */
export function assertSettingsEvidence(
  evidence: SettingsEvidence,
  width: number,
  enabled: boolean,
  engine: 'agent' | 'jev'
) {
  assertUsable(evidence, width)
  assertSidebar(evidence, 'experimental')
  assert.equal(evidence.values.projectUi, String(enabled))
  assert.equal(evidence.values.engine, engine, 'Preserve saved engine even while Off')
  const ids = evidence.controls.map((c) => c.id).sort()
  assert.deepEqual(
    ids,
    (enabled ? ['projectUi', 'engine'] : ['projectUi']).sort(),
    'Rendered picker visibility'
  )
  assert.equal(
    evidence.controls.find((c) => c.id === 'projectUi')?.selected,
    enabled ? 'On' : 'Off'
  )
  if (enabled)
    assert.equal(
      evidence.controls.find((c) => c.id === 'engine')?.selected,
      engine === 'agent' ? 'Chat model' : 'Jev layout engine'
    )
  const lines = evidence.text.map(words)
  for (const required of [
    'Experimental',
    'Gen UI',
    'Generate UI using your project’s existing components and styles. Experimental; supports React and Svelte.',
    ...(enabled
      ? [
          'UI layout method',
          'Chat model uses your selected chat model to arrange components. Jev uses a separate layout model and requires an AI Gateway API key.'
        ]
      : [])
  ])
    assert.ok(rendersText(lines, words(required)), `Missing complete foreground text: ${required}`)
  if (!enabled) {
    assert.ok(!rendersText(lines, words('UI layout method')), 'Off hides engine label')
    assert.ok(!rendersText(lines, words('requires an AI Gateway API key')), 'Off hides engine help')
  }
}

// Normalize typography only; every word is still required, in order.
// SF Pro draws capital I and lowercase l as the same glyph, so Vision reads the
// rendered "UI"/"AI" as "Ul"/"Al". Fold only that pair before lowercasing; a
// dotted lowercase i stays distinct. Vision also reads the rendered "Default model"
// as "Detault model" (f as t), so fold f to t after lowercasing. Before a word that
// starts with l, "UI"/"AI" is a run of identical strokes and Vision can drop the space
// ("UI layout" read as "Ullayout"), so that one space is folded away too. Both sides fold the
// same way, so no word can be dropped or reordered. Every comparison goes through words().
function words(text: string): string[] {
  return text
    .replace(/I/g, 'l')
    .toLowerCase()
    .replace(/\b([ua]l)\s+(?=l)/g, '$1')
    .replace(/f/g, 't')
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const startsWith = (line: string[], part: string[], at = 0) =>
  part.length <= line.length - at && part.every((word, i) => line[at + i] === word)

/**
 * Whether `sentence` appears in OCR observations, one per visual line. Vision
 * returns a wrapped sentence's lines in no guaranteed order (the continuation
 * can come first), and the capture carries no boxes to sort by. So chain the
 * sentence across lines anchored at line edges: it starts at the END of one
 * line, passes through whole lines, and finishes at the START of another. The
 * pieces must concatenate to exactly the sentence — no dropped or reordered
 * words — only the observation order is free.
 */
function rendersText(lines: string[][], sentence: string[]): boolean {
  if (!sentence.length) return false
  if (lines.some((line) => line.some((_, at) => startsWith(line, sentence, at)))) return true
  const rest = (remaining: string[], used: Set<number>): boolean =>
    lines.some((line, i) => {
      if (used.has(i) || !line.length) return false
      if (startsWith(line, remaining)) return true
      return (
        line.length < remaining.length &&
        startsWith(remaining, line) &&
        rest(remaining.slice(line.length), new Set([...used, i]))
      )
    })
  return lines.some((line, i) => {
    for (let k = 1; k < sentence.length && k <= line.length; k++)
      if (
        startsWith(line, sentence.slice(0, k), line.length - k) &&
        rest(sentence.slice(k), new Set([i]))
      )
        return true
    return false
  })
}

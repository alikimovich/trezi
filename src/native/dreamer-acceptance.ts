import type { DreamerFile } from '../shared/dreamer'

/**
 * LKM-447: what the opt-in Dreamer acceptance (`bun run acceptance:dreamer`, docs/DREAMER.md)
 * requires of the shipping review window and its export. Pure, so the unit tier runs every
 * rule against GREEN and RED inputs; `smoke-dreamer-acceptance.ts` applies them to the real
 * window, NSSavePanel and archive.
 */

/** The Overview's actions in footer order: the others, then the primary Export… (LKM-443). */
export const DREAMER_OVERVIEW_ACTIONS = ['select-all', 'select-none', 'copy-json', 'export']
/** The review window's ordinary width and its minimum (`SectionedSheetContent`). */
export const DREAMER_WIDTHS = { ordinary: 780, minimum: 680 } as const
/** A whole title keeps 20–25 pt of the button's padding; a cut one keeps far less (LKM-447 probe). */
export const LABEL_MARGIN = 16
/** RED runs the shipping check against a deliberately broken path: Export… with a stubbed save panel. */
export const DREAMER_ACCEPTANCE_RED_MODES = ['stub-save-panel'] as const

/** Planted in the selected proposal; the export must redact every one. */
export const PLANTED = {
  token: 'acceptance-secret-447',
  email: 'dreamer-447@example.com',
  home: '/Users/acceptance-447'
} as const
/** Planted in the proposal that is not selected; the export must not contain it. */
export const UNSELECTED_MARKER = 'UNSELECTED-PROPOSAL-447'

/** The smoke fixture with secrets in its selected proposal and a marker in the other. */
export function acceptanceFixture(base: DreamerFile, selected = 'speed-bash'): DreamerFile {
  const file = structuredClone(base)
  for (const p of file.proposals)
    if (p.id === selected) {
      p.problem = `${p.problem} Seen with token=${PLANTED.token} for ${PLANTED.email}.`
      p.proposal = `${p.proposal} The cache lives in ${PLANTED.home}/dev/app.`
    } else p.problem = `${p.problem} ${UNSELECTED_MARKER}`
  return file
}

export interface FooterButton {
  id: string
  label: string
  primary: boolean
  /** x, y, width, height in the window's content coordinates (origin bottom left). */
  frame: [number, number, number, number]
  labelWidth: number
  visible: boolean
  hitPane: boolean
}
interface AxDefault {
  label: string
  title: string
}
/** The host's `dreamerAcceptance` measure (src/native/DreamerAcceptance.swift). */
export interface FooterMeasure {
  foreground: boolean
  width: number
  height: number
  minimumWidth: number
  section: string
  actions: string[]
  proxies: number
  buttons: FooterButton[]
  defaultButtonCell: string | null
  axDefault: AxDefault | null
}

const overlap = (a: FooterButton['frame'], b: FooterButton['frame']) =>
  Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > 0.5 &&
  Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > 0.5

/** Every way the Overview's footer at `width` fails LKM-443's layout; empty when it passes. */
export function footerProblems(m: FooterMeasure, width: number): string[] {
  const problems: string[] = []
  if (!m.foreground) problems.push('the Dreamer window is not the key window of the active app')
  if (Math.abs(m.width - width) > 1) problems.push(`the window is ${m.width} pt wide, not ${width}`)
  if (m.minimumWidth !== DREAMER_WIDTHS.minimum)
    problems.push(`the minimum width is ${m.minimumWidth} pt, not ${DREAMER_WIDTHS.minimum}`)
  if (m.section !== 'overview')
    problems.push(`the shown pane is ${m.section || 'none'}, not Overview`)
  if (m.actions.join() !== DREAMER_OVERVIEW_ACTIONS.join())
    problems.push(`the footer's actions are ${m.actions.join(', ')}`)
  if (m.buttons.length !== m.actions.length || m.proxies !== m.actions.length)
    problems.push(`${m.proxies} rendered buttons for ${m.actions.length} actions`)
  const primary = m.buttons.filter((b) => b.primary).map((b) => b.id)
  if (primary.join() !== 'export')
    problems.push(`the primary actions are ${primary.join(', ') || 'none'}`)
  const exported = m.buttons.find((b) => b.id === 'export')
  if (exported && m.buttons.some((b) => b !== exported && b.frame[0] >= exported.frame[0]))
    problems.push('Export… is not the rightmost button')
  const rows = new Set(m.buttons.map((b) => Math.round(b.frame[1] + b.frame[3] / 2)))
  if (m.buttons.length && Math.max(...rows) - Math.min(...rows) > 1)
    problems.push('the footer buttons are not on one row')
  for (const b of m.buttons) {
    if (!b.visible) problems.push(`${b.label} is outside the visible window`)
    if (!b.hitPane) problems.push(`${b.label} is covered: a click at its centre misses the pane`)
    if (b.frame[2] < b.labelWidth + LABEL_MARGIN)
      problems.push(`${b.label} is clipped: ${b.frame[2]} pt for a ${b.labelWidth} pt title`)
    if (/Agent OS|\bSend\b/i.test(b.label)) problems.push(`Agent OS copy on a button: ${b.label}`)
  }
  for (let i = 0; i < m.buttons.length; i++)
    for (const other of m.buttons.slice(i + 1))
      if (overlap(m.buttons[i].frame, other.frame))
        problems.push(`${m.buttons[i].label} overlaps ${other.label}`)
  if (m.defaultButtonCell !== null && m.defaultButtonCell !== 'Export…')
    problems.push(`AppKit's default button is ${m.defaultButtonCell}`)
  if (m.axDefault && ![m.axDefault.label, m.axDefault.title].includes('Export…'))
    problems.push(`the accessibility default button is ${m.axDefault.title || m.axDefault.label}`)
  return problems
}

/** An unzipped export: the top level, the report folder and its files' text. */
export interface ExportedArchive {
  root: string[]
  entries: string[]
  files: Record<string, string>
}

/** Every way an exported archive fails LKM-443's export: wrong files, wrong proposals, or unredacted. */
export function archiveProblems(archive: ExportedArchive, selected: string[]): string[] {
  const problems: string[] = []
  if (archive.root.join() !== 'Dreamer Report')
    problems.push(`the archive holds ${archive.root.join(', ')}, not Dreamer Report`)
  const expected = ['evidence.json', 'proposals.json', 'report.md']
  if (archive.entries.join() !== expected.join())
    problems.push(`Dreamer Report holds ${archive.entries.join(', ')}`)
  try {
    const ids = (JSON.parse(archive.files['proposals.json'] ?? '') as DreamerFile).proposals.map(
      (p) => p.id
    )
    if (ids.join() !== selected.join())
      problems.push(`proposals.json holds ${ids.join(', ') || 'nothing'}`)
  } catch {
    problems.push('proposals.json is not a Dreamer file')
  }
  try {
    JSON.parse(archive.files['evidence.json'] ?? '')
  } catch {
    problems.push('evidence.json is not JSON')
  }
  for (const [name, text] of Object.entries(archive.files)) {
    for (const [kind, value] of Object.entries(PLANTED))
      if (text.includes(value)) problems.push(`${name} leaks the planted ${kind}`)
    if (text.includes(UNSELECTED_MARKER))
      problems.push(`${name} holds a proposal that is not selected`)
  }
  const proposals = archive.files['proposals.json'] ?? ''
  for (const marker of ['token=[redacted]', '[email]', '~/dev/app'])
    if (!proposals.includes(marker)) problems.push(`proposals.json lacks the redaction ${marker}`)
  return problems
}

/** One entry of evidence.json's `steps`: what a step did or saw, and when. */
export interface StepEntry {
  step: string
  at: string
  [field: string]: unknown
}

/**
 * LKM-452: the acceptance's step log. `note` appends and writes at once. `wait` notes the
 * wait before it starts, and when the wait fails notes the error with the host's `state`
 * taken then (before any cleanup dismisses the panel), then rethrows. So evidence.json
 * holds the last input and what the panel showed even when the run times out.
 */
export function stepLog(write: (steps: StepEntry[]) => void, now = () => new Date().toISOString()) {
  const steps: StepEntry[] = []
  const note = (step: string, fields: Record<string, unknown> = {}) => {
    steps.push({ step, at: now(), ...fields })
    write(steps)
  }
  const wait = async <T>(
    label: string,
    run: () => Promise<T>,
    state: () => Promise<unknown>
  ): Promise<T> => {
    note(`wait: ${label}`)
    try {
      return await run()
    } catch (error) {
      let seen: unknown
      try {
        seen = await state()
      } catch (failure) {
        seen = `state unavailable: ${String(failure)}`
      }
      note(`failed: ${label}`, {
        error: error instanceof Error ? error.message : String(error),
        state: seen
      })
      throw error
    }
  }
  return { steps, note, wait }
}

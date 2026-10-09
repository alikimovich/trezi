import type { DreamerEstimate, DreamerRun } from '../main/dreamer'
import { productLog } from '../main/product-log'
import { type DreamerFile, type DreamerScope, evidenceSession } from '../shared/dreamer'
import type { NativeSheetAction, NativeSheetField } from '../shared/native-sheet'
import {
  type AgentOsTarget,
  DEFAULT_AGENT_OS_URL,
  DREAMER_PROJECT_KEY,
  DREAMER_START_KEY,
  DREAMER_TOKEN_KEY,
  DREAMER_URL_KEY,
  exportDreamerReport,
  redactDeep,
  sendToAgentOs
} from './dreamer-export'
import {
  applyReviewValues,
  type DreamerResult,
  OVERVIEW,
  reviewActions,
  reviewFields,
  reviewSections,
  selectedFile
} from './dreamer-review'
import type { NativePreferences } from './preferences'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LKM-202: Trezi → Run Dreamer…, Dreamer Proposals…, Export Dreamer Report… and the
 * optional weekly run. The run itself is `dreamer:run` in the backend (`src/main/dreamer.ts`);
 * this keeps the last result (with the user's edits) in preferences and owns the windows.
 */

export const DREAMER_LAST_KEY = 'trezi:dreamer:last'
export const DREAMER_LAST_RUN_KEY = 'trezi:dreamer:last-run'
export const DREAMER_SCHEDULE_KEY = 'trezi:dreamer:schedule'
const DAY = 24 * 60 * 60_000
const WEEK = 7 * DAY
export const DREAMER_DAYS = [7, 14, 30, 60, 90]
const DEFAULT_DAYS = 14
/** The saved result stays well under a preference's 2,000,000 characters. */
const RESULT_CHARS = 1_000_000

export interface DreamerHost {
  /** The save panel; null when the user cancels. */
  pickExport(name: string): Promise<string | null>
  copyText(text: string): Promise<unknown>
  openChat(session: string): void
  /** A chat is running or sending: the weekly run waits. */
  busy(): boolean
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

const tokens = (n: number) => (n >= 1000 ? `about ${Math.round(n / 1000)}k` : `about ${n}`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The app's controller, for the native smoke (`smoke-dreamer.ts`). */
export const nativeDreamer: { current: NativeDreamerController | null } = { current: null }

export class NativeDreamerController {
  result: DreamerResult | null = null
  private running = false
  private filter = 'all'
  private epoch = 0
  constructor(
    readonly sheets: NativeSheetController,
    readonly preferences: NativePreferences,
    readonly host: DreamerHost
  ) {}

  /** The last result: this session's, else the one saved by an earlier launch. */
  last(): DreamerResult | null {
    if (this.result) return this.result
    try {
      const saved = JSON.parse(
        this.preferences.get(DREAMER_LAST_KEY) ?? 'null'
      ) as DreamerResult | null
      if (saved?.file?.version === 1 && Array.isArray(saved.file.proposals)) this.result = saved
    } catch {}
    return this.result
  }
  private persist() {
    if (!this.result) return
    let text = JSON.stringify(this.result)
    if (text.length > RESULT_CHARS) text = JSON.stringify({ ...this.result, digest: null })
    if (text.length > RESULT_CHARS) return
    void this.preferences.set(DREAMER_LAST_KEY, text).catch(() => {})
  }
  target(): AgentOsTarget {
    return {
      url: this.preferences.get(DREAMER_URL_KEY) || DEFAULT_AGENT_OS_URL,
      project: this.preferences.get(DREAMER_PROJECT_KEY) ?? '',
      token: this.preferences.get(DREAMER_TOKEN_KEY) ?? undefined,
      start: this.preferences.get(DREAMER_START_KEY) === 'on'
    }
  }
  private targetText() {
    const target = this.target()
    return target.project
      ? `${target.url} · project ${target.project}${target.start ? ' · starts the tasks' : ''}`
      : `${target.url} · set the project ID in Settings → Dreamer`
  }

  /** Trezi → Run Dreamer…: scope, time range and the estimated size, then the run. */
  async run() {
    if (this.running) return this.sheets.toast('The Dreamer is already running.')
    const projects = this.sheets.workspace.state.projects
    const scopes: DreamerScope[] = [null, ...projects.map((p) => p.key)].flatMap((project) =>
      DREAMER_DAYS.map((days) => ({ project, days }))
    )
    const generation = this.sheets.generation
    const estimates: DreamerEstimate[] = await this.sheets.invoke('dreamer:estimates', scopes)
    if (generation !== this.sheets.generation) return
    const estimateFields: NativeSheetField[] = ['all', ...projects.map((p) => p.key)].map(
      (key, i) => ({
        id: `estimate:${i}`,
        label: 'Estimated size',
        kind: 'readonly',
        visibleWhen: { field: 'scope', value: key },
        value: DREAMER_DAYS.map((days, n) => {
          const e = estimates[i * DREAMER_DAYS.length + n]
          return `Last ${days} days: ${plural(e.sessions, 'chat')}, ${plural(e.turns, 'turn')}, ${tokens(e.tokens)} tokens`
        }).join('\n')
      })
    )
    const model = estimates[0]?.model
    this.sheets.present(
      {
        title: 'Run Dreamer',
        detail:
          'The Dreamer reads your saved chats and Trezi’s log on this Mac, sends a redacted summary to your selected model (it never edits code) and proposes improvements. Nothing leaves this Mac until you export or send it.',
        fields: [
          {
            id: 'scope',
            label: 'Chats from',
            kind: 'choice',
            value: 'all',
            choices: [
              { value: 'all', label: 'All projects' },
              ...projects.map((p) => ({ value: p.key, label: p.name }))
            ]
          },
          {
            id: 'days',
            label: 'Time range',
            kind: 'choice',
            value: String(DEFAULT_DAYS),
            choices: DREAMER_DAYS.map((d) => ({ value: String(d), label: `Last ${d} days` }))
          },
          ...estimateFields,
          {
            id: 'model',
            label: 'Model',
            kind: 'readonly',
            value: model ?? 'No model available: the proposals come from the summary alone.'
          }
        ],
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'run', label: 'Run Dreamer', primary: true }
        ]
      },
      async (action) => {
        const project = projects.find((p) => p.key === action.values.scope)
        const days = Number(action.values.days)
        const scope: DreamerScope = {
          project: project?.key ?? null,
          ...(project ? { projectName: project.name } : {}),
          days: DREAMER_DAYS.includes(days) ? days : DEFAULT_DAYS
        }
        const result = await this.start(scope)
        if (this.sheets.current?.state.id === action.id) this.review()
        else this.found(result)
      }
    )
  }
  /** One run; the result replaces the last one, every proposal selected. */
  async start(scope: DreamerScope): Promise<DreamerResult> {
    if (this.running) throw new Error('The Dreamer is already running.')
    this.running = true
    void this.preferences.set(DREAMER_LAST_RUN_KEY, String(Date.now())).catch(() => {})
    try {
      const run: DreamerRun = await this.sheets.invoke('dreamer:run', scope)
      this.result = {
        file: run.file,
        digest: run.digest,
        selected: run.file.proposals.map((p) => p.id),
        model: run.model,
        ...(run.fallback ? { fallback: run.fallback } : {})
      }
      this.filter = 'all'
      this.persist()
      return this.result
    } finally {
      this.running = false
    }
  }
  private found(result: DreamerResult) {
    const n = result.file.proposals.length
    this.sheets.toast(
      `The Dreamer found ${plural(n, 'proposal')}.`,
      n ? { label: 'Review', run: async () => this.review() } : undefined
    )
  }

  /** Trezi → Dreamer Proposals…: the last run's proposals. */
  review(section = OVERVIEW) {
    const result = this.last()
    if (!result)
      return this.sheets.toast('The Dreamer has not run yet.', {
        label: 'Run Dreamer…',
        run: () => this.run()
      })
    this.sheets.present(
      {
        title: 'Dreamer Proposals',
        detail: '',
        sections: reviewSections(result, this.filter),
        section,
        fields: reviewFields(result, this.filter, this.targetText(), this.epoch),
        actions: reviewActions(result),
        autosave: true
      },
      (action) => this.handle(result, action)
    )
  }
  private rerender(result: DreamerResult) {
    const sheet = this.sheets.current
    if (!sheet) return
    sheet.state.sections = reviewSections(result, this.filter)
    sheet.state.fields = reviewFields(result, this.filter, this.targetText(), this.epoch)
    this.sheets.refresh()
  }
  private async handle(result: DreamerResult, action: NativeSheetAction) {
    const current = () => this.sheets.current?.state.id === action.id
    const say = (message: string) => {
      if (current()) this.sheets.current!.state.message = message
    }
    if (action.action === 'save') {
      this.filter = applyReviewValues(result, action.values, this.epoch)
      this.persist()
      if (current()) this.rerender(result)
      return
    }
    if (action.action === 'select-all' || action.action === 'select-none') {
      result.selected = action.action === 'select-all' ? result.file.proposals.map((p) => p.id) : []
      this.epoch++
      this.persist()
      return this.rerender(result)
    }
    if (action.action.startsWith('open:')) {
      const [, id, n] = /^open:(.+):(\d+)$/.exec(action.action) ?? []
      const item = result.file.proposals.find((p) => p.id === id)?.evidence[Number(n)]
      const session = item === undefined ? undefined : evidenceSession(item)
      if (session) this.host.openChat(session)
      return
    }
    if (action.action === 'copy-json') {
      const file = selectedFile(result)
      await this.host.copyText(`${JSON.stringify(redactDeep(file), null, 2)}\n`)
      return say(`Copied ${plural(file.proposals.length, 'proposal')} as JSON.`)
    }
    if (action.action === 'export') {
      const dest = await this.save(selectedFile(result), result)
      return say(dest ? `Exported the report to ${dest}.` : '')
    }
    if (action.action === 'send') {
      if (!result.selected.length) throw new Error('Select at least one proposal to send.')
      const file = selectedFile(result)
      const sent = await sendToAgentOs(this.target(), file, this.host.fetch)
      productLog.info('dreamer', sent.ok ? 'Proposals sent' : 'Proposals not sent', {
        proposals: file.proposals.length,
        tasks: sent.tasks.length
      })
      if (sent.ok) {
        result.sent = { at: new Date().toISOString(), tasks: sent.tasks }
        this.persist()
        if (current()) this.rerender(result)
        return say(
          `Sent ${plural(file.proposals.length, 'proposal')} to Agent OS.${sent.tasks.length ? ` Created ${sent.tasks.join(', ')}.` : ''}`
        )
      }
      // A failed send keeps the work: the report is saved instead.
      say(`Not sent: ${sent.error} Choose where to save the report instead.`)
      this.sheets.refresh()
      const dest = await this.save(file, result)
      return say(
        `Not sent: ${sent.error} ${dest ? `Exported the report to ${dest} instead.` : 'Export cancelled.'}`
      )
    }
  }
  private async save(file: DreamerFile, result: DreamerResult) {
    const day = new Date().toISOString().slice(0, 10)
    const dest = await this.host.pickExport(`Dreamer Report ${day}.zip`)
    if (!dest) return null
    await exportDreamerReport(dest, file, result.digest)
    productLog.info('dreamer', 'Report exported', { proposals: file.proposals.length })
    return dest
  }
  /** Trezi → Export Dreamer Report…: the last run's selected (else every) proposal. */
  async exportReport() {
    const result = this.last()
    if (!result?.file.proposals.length)
      return this.sheets.toast('Run the Dreamer first: there is no report to export.', {
        label: 'Run Dreamer…',
        run: () => this.run()
      })
    const file = selectedFile(result)
    const dest = await this.save(file, result)
    if (dest) this.sheets.toast(`Exported ${plural(file.proposals.length, 'proposal')} to ${dest}.`)
  }

  /** The weekly run (Settings → Dreamer, off by default) while no chat or window is busy. */
  async tick(now = Date.now()) {
    if (this.preferences.get(DREAMER_SCHEDULE_KEY) !== 'weekly') return false
    if (this.running || this.host.busy() || this.sheets.current) return false
    if (now - Number(this.preferences.get(DREAMER_LAST_RUN_KEY) ?? 0) < WEEK) return false
    try {
      this.found(await this.start({ project: null, days: DEFAULT_DAYS }))
    } catch (error) {
      productLog.warn('dreamer', 'Weekly run failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return true
  }
  schedule(every = 60 * 60_000) {
    setInterval(() => void this.tick(), every).unref?.()
  }
}

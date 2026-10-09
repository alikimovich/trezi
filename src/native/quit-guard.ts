/** LKM-221: Settings → General and the quit alert's checkbox; 'true' quits without asking. */
export const QUIT_DONT_ASK_KEY = 'trezi:quit-dont-ask:v1'
export const QUIT_DONT_ASK_CHOICES = [
  { value: 'false', label: 'Ask first' },
  { value: 'true', label: 'Don’t ask' }
]
/** How long a quit waits for a landing or publish to reach a safe point, and for stopped
 *  agents to settle, before it quits anyway. */
export const QUIT_SAFE_POINT_MS = 15_000
export const QUIT_TITLE = 'Agents are still working'

/** One piece of running work; `project` is the project's display name. A states
 *  workbench build is a chat turn (`/states`), so it counts as a chat. */
export interface QuitWork {
  kind: 'chat' | 'background' | 'landing' | 'publish' | 'dreamer'
  project?: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
export function joinList(parts: string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "2 chats in lkmv.ch", "1 background agent in swiftly-demos", "the Dreamer". */
function agentParts(work: QuitWork[]): string[] {
  const counts = new Map<string, { kind: string; project: string; n: number }>()
  for (const item of work) {
    if (item.kind !== 'chat' && item.kind !== 'background') continue
    const project = item.project || 'another project'
    const key = `${project}\0${item.kind}`
    const entry = counts.get(key) ?? { kind: item.kind, project, n: 0 }
    entry.n++
    counts.set(key, entry)
  }
  const parts = [...counts.values()]
    .sort((a, b) => a.project.localeCompare(b.project) || a.kind.localeCompare(b.kind))
    .map(
      ({ kind, project, n }) =>
        `${plural(n, kind === 'chat' ? 'chat' : 'background agent')} in ${project}`
    )
  if (work.some((w) => w.kind === 'dreamer')) parts.push('the Dreamer')
  return parts
}
/** "a landing", "2 landings", "a publish": work that always reaches a safe point first. */
function safePointParts(work: QuitWork[]): string[] {
  const landings = work.filter((w) => w.kind === 'landing').length
  const publishes = work.filter((w) => w.kind === 'publish').length
  return [
    ...(landings ? [landings === 1 ? 'a landing' : plural(landings, 'landing')] : []),
    ...(publishes ? [publishes === 1 ? 'a publish' : `${publishes} publishes`] : [])
  ]
}

/** The alert's text: what runs, then what Quit Anyway does with it. */
export function quitDetail(work: QuitWork[]): string {
  const parts = agentParts(work)
  const sentences: string[] = []
  if (parts.length) {
    const one = parts.length === 1 && (parts[0].startsWith('1 ') || parts[0] === 'the Dreamer')
    sentences.push(`${capital(joinList(parts))} ${one ? 'is' : 'are'} still running.`)
  }
  const safe = safePointParts(work)
  if (safe.length) {
    const one = safe.length === 1 && safe[0].startsWith('a ')
    sentences.push(`${capital(joinList(safe))} ${one ? 'is' : 'are'} in progress.`)
  }
  const advice = [
    'Quit Anyway stops the agents and keeps their work in each chat’s copy.',
    ...(safe.length ? ['A landing or publish finishes first.'] : [])
  ]
  return `${sentences.join(' ')}\n\n${advice.join(' ')}`
}
/** Wait and Quit's note. */
export function waitingNote(work: QuitWork[]): string {
  return `Waiting for ${joinList([...agentParts(work), ...safePointParts(work)])} to finish. Trezi quits when the work ends.`
}
/** Quit Anyway's note while stopped agents settle and a landing or publish finishes. */
export function stoppingNote(work: QuitWork[]): string {
  const safe = safePointParts(work)
  return safe.length ? `Finishing ${joinList(safe)} before quitting…` : 'Stopping agents…'
}

export interface QuitGuardServices {
  work(): QuitWork[]
  /** Stops chats and background agents the way Stop does; landings and publishes go on. */
  stop(): Promise<void>
  dontAsk(): boolean
  setDontAsk(): Promise<void>
  send(command: 'quitAsk' | 'quitNote' | 'quitProceed', payload: Record<string, unknown>): void
  wait?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  safePointMs?: number
}

/**
 * The host asks on every user quit (⌘Q, Quit, the last window, logout); the host shows
 * the alert and the note, this decides. Nothing running: proceed at once. "Don't ask
 * again": Quit Anyway without the alert. A landing or publish always gets its bounded
 * safe-point wait, and the Dreamer (read-only) is never waited for after a stop.
 */
export class QuitGuard {
  phase: 'idle' | 'asking' | 'waiting' | 'stopping' = 'idle'
  private run = 0
  private note = ''
  constructor(readonly services: QuitGuardServices) {}
  private wait(ms: number) {
    return (this.services.wait ?? ((n) => new Promise<void>((r) => setTimeout(r, n))))(ms)
  }
  private get poll() {
    return this.services.pollMs ?? 250
  }
  request() {
    // A repeated request while one is open re-shows nothing: the host joins the first.
    if (this.phase !== 'idle') return
    const work = this.services.work()
    if (!work.length) return this.proceed()
    if (this.services.dontAsk()) return void this.stopAndQuit()
    this.phase = 'asking'
    this.services.send('quitAsk', { title: QUIT_TITLE, detail: quitDetail(work) })
  }
  async answer(choice: string, dontAsk = false) {
    if (choice === 'cancel') return this.cancel()
    if (this.phase !== 'asking') return
    if (dontAsk) await this.services.setDontAsk().catch(() => {})
    if (choice === 'wait') return this.waitAndQuit()
    if (choice === 'stop') return this.stopAndQuit()
    this.cancel()
  }
  /** Cancel in the alert or the Wait and Quit note: the work keeps running. */
  cancel() {
    if (this.phase === 'stopping') return
    this.run++
    this.phase = 'idle'
    this.note = ''
  }
  private show(text: string, cancellable: boolean) {
    if (text === this.note) return
    this.note = text
    this.services.send('quitNote', { text, cancellable })
  }
  private proceed() {
    this.phase = 'idle'
    this.note = ''
    this.services.send('quitProceed', {})
  }
  private async waitAndQuit() {
    const run = ++this.run
    this.phase = 'waiting'
    for (;;) {
      const work = this.services.work()
      if (!work.length) return this.proceed()
      this.show(waitingNote(work), true)
      await this.wait(this.poll)
      if (this.run !== run) return
    }
  }
  private async stopAndQuit() {
    const run = ++this.run
    this.phase = 'stopping'
    const now = this.services.now ?? Date.now
    const limit = this.services.safePointMs ?? QUIT_SAFE_POINT_MS
    const deadline = now() + limit
    const left = () => this.services.work().filter((w) => w.kind !== 'dreamer')
    const first = left()
    if (first.length) this.show(stoppingNote(first), false)
    await Promise.race([this.services.stop().catch(() => {}), this.wait(limit)])
    for (let work = left(); work.length && now() < deadline; work = left()) {
      this.show(stoppingNote(work), false)
      await this.wait(this.poll)
    }
    if (this.run === run) this.proceed()
  }
}

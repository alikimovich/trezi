/** LKM-152: how much attention a line asks for. Only `needs-action` may open the window
 *  by itself (once per event kind per app session); everything else is logged. */
export type ActivitySeverity = 'info' | 'warning' | 'needs-action'
/** The line's style. `notice` (gray) is a startup recovery report: nothing was lost. */
export type ActivityKind =
  | 'info'
  | 'notice'
  | 'server'
  | 'success'
  | 'warning'
  | 'error'
  | 'needs-action'
/** Settings → General → Show Activity automatically. */
export type ActivityAutoOpen = 'never' | 'problems' | 'always'
export const ACTIVITY_AUTO_OPEN_KEY = 'trezi:activity-auto-open:v1'
export const ACTIVITY_AUTO_OPEN_CHOICES: { value: ActivityAutoOpen; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'problems', label: 'For problems that need me' },
  { value: 'always', label: 'Always' }
]
export const activityAutoOpen = (value: string | null | undefined): ActivityAutoOpen =>
  value === 'never' || value === 'always' ? value : 'problems'
export interface ActivityLine {
  id: number
  time: string
  text: string
  kind: string
  severity: ActivitySeverity
  group?: string
  count?: number
  summary?: string
}
export interface ActivityOptions {
  /** The event kind a `needs-action` line opens the window for at most once per session. */
  event?: string
  /** Repeated lines of one group collapse into one line that reads `summary(count)`. */
  group?: { key: string; summary: (count: number) => string }
}
/** Startup recovery notices of one kind collapse into one summary line. */
export const RESTORED_CHATS = {
  key: 'restored-chats',
  summary: (count: number) => `Restored ${count} interrupted chats.`
}
export const ROLLED_BACK_SOURCE = {
  key: 'rolled-back-source',
  summary: (count: number) => `Rolled back ${count} interrupted source changes.`
}
export const severityOf = (kind: string): ActivitySeverity =>
  kind === 'needs-action'
    ? 'needs-action'
    : kind === 'error' || kind === 'warning'
      ? 'warning'
      : 'info'
const rank: Record<ActivitySeverity, number> = { info: 0, warning: 1, 'needs-action': 2 }
/** Bounded both by entries and characters; a single server write can be huge. The
 *  window shows each line's collapsed paths (`display`); tooltips and Copy All keep `text`. */
export class NativeActivityController {
  lines: ActivityLine[] = []
  visible = false
  /** Warnings and needs-action lines added while the window was hidden. */
  unread = 0
  unreadLevel: ActivitySeverity = 'info'
  /** Event kinds that already opened the window this session. */
  readonly opened = new Set<string>()
  private sequence = 0
  private repaint?: ReturnType<typeof setTimeout>
  /** An automatic open orders the window front without taking the key window. */
  private raise = false
  constructor(
    readonly send: (method: string, value: any) => void,
    readonly display: (text: string) => string = (text) => text,
    readonly autoOpen: () => ActivityAutoOpen = () => 'problems'
  ) {}
  append(text: string, kind: ActivityKind | string = 'info', options: ActivityOptions = {}) {
    if (typeof text !== 'string' || !text) return
    const severity = severityOf(kind),
      time = new Date().toTimeString().slice(0, 8)
    const { group } = options
    const grouped = group && this.lines.find((line) => line.group === group.key)
    if (group && grouped) {
      grouped.count = (grouped.count ?? 1) + 1
      grouped.text = `${grouped.text}\n${text}`.slice(-16000)
      grouped.summary = group.summary(grouped.count)
      grouped.time = time
    } else
      this.lines.push({
        id: ++this.sequence,
        time,
        text: text.slice(-16000),
        kind,
        severity,
        ...(group ? { group: group.key, count: 1 } : {})
      })
    let size = this.lines.reduce((n, line) => n + line.text.length, 0)
    while (this.lines.length > 500 || size > 500000) size -= this.lines.shift()!.text.length
    if (this.shouldOpen(kind, severity, options.event ?? text)) {
      this.visible = true
      this.raise = true
      if (this.unread) {
        this.unread = 0
        this.unreadLevel = 'info'
        this.badge()
      }
    } else if (!this.visible && severity !== 'info') {
      this.unread++
      if (rank[severity] > rank[this.unreadLevel]) this.unreadLevel = severity
      this.badge()
    }
    if (this.visible && !this.repaint)
      this.repaint = setTimeout(() => {
        this.repaint = undefined
        if (this.visible) this.render()
      }, 50)
  }
  /** Never: nothing opens. Always: a hidden window opens for every error, as before
   *  LKM-152. Problems (default): a needs-action event brings the window to front once
   *  per event kind. Recovery notices and server output never open it. */
  private shouldOpen(kind: string, severity: ActivitySeverity, event: string) {
    const mode = this.autoOpen()
    if (mode === 'never' || severity === 'info') return false
    if (mode === 'always') return !this.visible && (kind === 'error' || severity === 'needs-action')
    if (severity !== 'needs-action' || this.opened.has(event)) return false
    this.opened.add(event)
    return true
  }
  private badge() {
    this.send('activityUnread', { count: this.unread, level: this.unreadLevel })
  }
  render(focus = false) {
    const raise = this.raise
    this.raise = false
    this.send('activityState', {
      lines: this.lines.map((line) => ({
        ...line,
        display: this.display(
          line.count && line.count > 1 && line.summary ? line.summary : line.text
        )
      })),
      visible: this.visible,
      ...(raise ? { raise: true } : {}),
      ...(focus ? { focus: true } : {})
    })
  }
  action(action: string) {
    // Verification only: a known starting state (nothing shown, read or already auto-opened).
    if (action === 'reset') {
      this.lines = []
      this.visible = false
      this.opened.clear()
      this.unread = 0
      this.unreadLevel = 'info'
      this.badge()
    } else if (action === 'clear') this.lines = []
    else if (action === 'show') this.visible = true
    else if (action === 'hide') this.visible = false
    else if (action === 'toggle') this.visible = !this.visible
    else return
    // Showing the window is viewing it: the unread marker clears.
    if (this.visible && this.unread) {
      this.unread = 0
      this.unreadLevel = 'info'
      this.badge()
    }
    this.render(this.visible && (action === 'show' || action === 'toggle'))
  }
}

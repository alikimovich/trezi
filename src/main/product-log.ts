import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * LKM-168: Trezi's product log. Every process appends structured lines to one folder,
 * `~/Library/Logs/Trezi/` (`TREZI_LOG_DIR` overrides it; the native test run points it
 * into its disposable folder), one file per UTC day: `trezi-YYYY-MM-DD.log`. Files older
 * than 7 days are removed and a day's file stops growing at 20 MB. The Swift host and
 * service write the same format (`src/service/ProductLog.swift`).
 *
 * A line: `<ISO time> <level> <process> <area> [chat=<id>] [turn=<id>] <message>`.
 * Only lifecycle facts are logged: never prompt or file contents. Every line passes
 * through `redact` (token shapes, `key=value` secrets, URL credentials, private keys)
 * and the home folder is shortened to `~`.
 */

export const LOG_KEEP_DAYS = 7
export const LOG_DAY_BYTES = 20 * 1024 * 1024
/** The longest message kept; a dev server line is shorter (`DEVSERVER_LINE`). */
export const LOG_MESSAGE_LIMIT = 1000
export const DEVSERVER_LINE = 300
const DAY = 24 * 60 * 60_000
const FILE = /^trezi-(\d{4}-\d{2}-\d{2})\.log$/
/** A line starts with its ISO time, e.g. `2026-10-05T21:52:43.463Z`. */
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
/** `chat` and `turn` lead the line; every other field follows the message as `key=value`. */
export type LogFields = Record<string, string | number | boolean | null | undefined>

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[redacted]@'],
  [
    /((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|credential|cookie)[A-Za-z_-]*["']?\s*[:=]\s*["']?(?:(?:bearer|basic)\s+)?)[^\s"',;&]+/gi,
    '$1[redacted]'
  ]
]

/** Removes secrets and shortens the home folder to `~`. */
export function redact(text: string, home = homedir()) {
  let out = text
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  if (home && home !== '/') out = out.split(home).join('~')
  return out
}

/** `text` cut to `limit` characters, with "…" when cut. */
export const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

/** `TREZI_LOG_DIR` when it is absolute, else `~/Library/Logs/Trezi`. */
export function logDirectory(
  env: Record<string, string | undefined> = process.env,
  home = homedir()
) {
  const override = env.TREZI_LOG_DIR
  return override && isAbsolute(override) ? override : join(home, 'Library/Logs/Trezi')
}

/** The file a moment is written to (UTC day). */
export const logFileName = (at: number) => `trezi-${new Date(at).toISOString().slice(0, 10)}.log`

const token = (text: string) => text.replace(/[^A-Za-z0-9_.:-]/g, '-') || '-'
const value = (raw: string | number | boolean) => {
  const text = String(raw)
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text)
}
const oneLine = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  text.replace(/\r?\n/g, ' ⏎ ').replace(/[\u0000-\u001f\u007f]/g, ' ')

export interface LogEntry {
  at: number
  level: LogLevel
  process: string
  area: string
  message: string
  fields?: LogFields
}

/** One redacted line, without its newline. The message is cut at `limit` after redaction. */
export function formatLogLine(entry: LogEntry, home = homedir(), limit = LOG_MESSAGE_LIMIT) {
  const { chat, turn, ...rest } = entry.fields ?? {}
  const head = [
    new Date(entry.at).toISOString(),
    entry.level,
    token(entry.process),
    token(entry.area)
  ]
  if (chat != null && chat !== '') head.push(`chat=${value(chat)}`)
  if (turn != null && turn !== '') head.push(`turn=${value(turn)}`)
  let text = entry.message
  for (const [key, raw] of Object.entries(rest))
    if (raw != null && raw !== '') text += ` ${token(key)}=${value(raw)}`
  text = truncate(redact(oneLine(text), home), limit)
  return redact(`${head.join(' ')} ${text}`, home)
}

/** Removes day files older than `keepDays` (today counts as one); returns their names. */
export function pruneLogs(dir: string, now = Date.now(), keepDays = LOG_KEEP_DAYS) {
  const oldest = new Date(now - (keepDays - 1) * DAY).toISOString().slice(0, 10)
  const removed: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return removed
  }
  for (const name of names) {
    const day = FILE.exec(name)?.[1]
    if (!day || day >= oldest) continue
    try {
      unlinkSync(join(dir, name))
      removed.push(name)
    } catch {}
  }
  return removed
}

export interface LogWriterOptions {
  dir: string
  process: string
  now?: () => number
  maxBytes?: number
  keepDays?: number
  home?: string
}

/**
 * Appends one process's lines. Every process opens the day's file with O_APPEND, so
 * lines from different processes never tear; the size check reads the shared file, so
 * the 20 MB cap holds across them. A write that fails is dropped: logging never throws.
 */
export class LogWriter {
  private fd = -1
  private day = ''
  constructor(readonly options: LogWriterOptions) {}

  get dir() {
    return this.options.dir
  }

  write(level: LogLevel, area: string, message: string, fields?: LogFields) {
    try {
      const at = (this.options.now ?? Date.now)()
      const name = logFileName(at)
      if (name !== this.day) this.open(name, at)
      if (this.fd < 0) return
      const max = this.options.maxBytes ?? LOG_DAY_BYTES
      const size = fstatSync(this.fd).size
      if (size >= max) return
      const line = this.format({ at, level, process: this.options.process, area, message, fields })
      writeSync(this.fd, line)
      if (size + Buffer.byteLength(line) >= max)
        writeSync(
          this.fd,
          this.format({
            at,
            level: 'warn',
            process: this.options.process,
            area: 'log',
            message: `Daily log limit reached (${max} bytes); later lines today are dropped.`
          })
        )
    } catch {}
  }

  close() {
    if (this.fd >= 0)
      try {
        closeSync(this.fd)
      } catch {}
    this.fd = -1
    this.day = ''
  }

  private format(entry: LogEntry) {
    return `${formatLogLine(entry, this.options.home)}\n`
  }

  private open(name: string, at: number) {
    this.close()
    this.day = name
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 })
    this.fd = openSync(join(this.options.dir, name), 'a', 0o600)
    pruneLogs(this.options.dir, at, this.options.keepDays)
  }
}

/** The lines written in `[now - since, now]`, oldest first, from every process. */
export function readLogs(dir: string, since: number, now = Date.now()) {
  const from = now - since
  const first = new Date(from).toISOString().slice(0, 10)
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const lines: string[] = []
  for (const name of names.filter((n) => (FILE.exec(n)?.[1] ?? '') >= first).sort()) {
    let text = ''
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const stamp = STAMP.exec(line)?.[1]
      if (!stamp) continue
      const at = Date.parse(stamp)
      if (at >= from && at <= now) lines.push(line)
    }
  }
  // Processes append independently; the ISO prefix orders them (a stable sort).
  return lines.sort((a, b) =>
    a.slice(0, 24) < b.slice(0, 24) ? -1 : a.slice(0, 24) > b.slice(0, 24) ? 1 : 0
  )
}

/** `30m`, `2h`, `1d`, `45s` or a bare number of minutes, in milliseconds. */
export function parseSince(text: string) {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(text.trim())
  if (!match) throw new Error(`Not a duration: ${text} (use 30m, 2h, 1d or 45s)`)
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: DAY }[match[2] || 'm'] ?? 60_000
  return Number(match[1]) * unit
}

let writer: LogWriter | null = null
/** Lines this process writes on behalf of another (`preview`, `devserver`). */
const relayed = new Map<string, LogWriter>()

/** Starts this process's log (`backend`, `helper`); until then every call is a no-op. */
export function initProductLog(tag: string, env: Record<string, string | undefined> = process.env) {
  writer?.close()
  for (const other of relayed.values()) other.close()
  relayed.clear()
  writer = new LogWriter({ dir: logDirectory(env), process: tag })
  return writer
}

/** The folder this process writes to (the default one before `initProductLog`). */
export const productLogDirectory = () => writer?.dir ?? logDirectory()

const emit =
  (level: LogLevel) => (area: string, message: string, fields?: LogFields, as?: string) => {
    if (!writer) return
    let target = writer
    if (as && as !== writer.options.process) {
      target = relayed.get(as) ?? new LogWriter({ ...writer.options, process: as })
      relayed.set(as, target)
    }
    target.write(level, area, message, fields)
  }

/** The process log: `productLog.info('chat', 'Turn started', { chat, turn, provider })`. */
export const productLog = {
  debug: emit('debug'),
  info: emit('info'),
  warn: emit('warn'),
  error: emit('error')
}

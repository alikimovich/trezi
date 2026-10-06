// LKM-168: the product log. Lines are redacted (token shapes, key=value secrets, URL
// credentials, private keys; home shortened to `~`) the same way by the Bun writer and
// the Swift host/service writer; day files rotate, stop at their size cap and are
// pruned after 7 days; `trezi logs` reads and follows them; Copy Logs for Support and
// Export Logs build their text and zip from the same lines. Everything writes into a
// temporary folder: nothing touches ~/Library/Logs/Trezi.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { followLogs, logs } from '../bin/trezi.mjs'
import {
  formatLogLine,
  initProductLog,
  LogWriter,
  logDirectory,
  logFileName,
  parseSince,
  productLog,
  productLogDirectory,
  pruneLogs,
  readLogs,
  redact
} from '../src/main/product-log.ts'
import { logTurnEvent, logTurnStart } from '../src/main/turn-log.ts'
import {
  exportLogs,
  flushPreviewSummary,
  notePreviewMessage,
  supportText
} from '../src/native/log-support.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

const HOME = '/Users/someone'
const SECRETS = [
  'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
  'ghp_abcdefghijklmnopqrstuvwxyz0123',
  'github_pat_11ABCDEFG0123456789_abcdefghij',
  'xoxb-1234567890-abcdefghij',
  'AKIAABCDEFGHIJKLMNOP',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
  'opaque-bearer-value-123',
  'hunter2-password',
  'client-secret-value',
  'url-password',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
]
const TEXTS = [
  `ANTHROPIC_API_KEY=${SECRETS[0]} in ${HOME}/dev/app`,
  `token ${SECRETS[1]} and ${SECRETS[2]}`,
  `slack ${SECRETS[3]} aws ${SECRETS[4]}`,
  `jwt ${SECRETS[5]}`,
  `Authorization: Bearer ${SECRETS[6]}`,
  `password=${SECRETS[7]} client_secret: "${SECRETS[8]}"`,
  `remote https://user:${SECRETS[9]}@example.com/repo.git`,
  `-----BEGIN PRIVATE KEY-----\n${SECRETS[10]}\n-----END PRIVATE KEY-----`,
  `plain ${HOME}/Library/Logs/Trezi stays readable`
]

const temp = mkdtempSync(join(tmpdir(), 'trezi-product-log-'))
const DAY = 24 * 60 * 60_000
// 2025-10-05T21:52:43.500Z
const AT = 1_759_701_163_500

try {
  // Redaction: no secret survives, the home folder becomes ~ and plain text stays.
  const redacted = TEXTS.map((text) => redact(text, HOME))
  for (const secret of SECRETS)
    assert.ok(!redacted.join('\n').includes(secret), `redact left ${secret}`)
  assert.ok(!redacted.join('\n').includes(HOME))
  assert.equal(redacted[0], 'ANTHROPIC_API_KEY=[redacted] in ~/dev/app')
  assert.equal(redacted.at(-1), 'plain ~/Library/Logs/Trezi stays readable')

  // A line: ISO time, level, process, area, chat and turn first, fields after the message.
  const entry = {
    at: AT,
    level: 'info',
    process: 'app',
    area: 'chat',
    message: `Turn started\nby ${HOME}/dev/app token=abc123`,
    fields: { chat: 'chat 1', turn: 't-1' }
  }
  const line = formatLogLine(entry, HOME)
  assert.equal(
    line,
    '2025-10-05T21:52:43.500Z info app chat chat="chat 1" turn=t-1 Turn started ⏎ by ~/dev/app token=[redacted]'
  )
  assert.equal(
    formatLogLine(
      {
        ...entry,
        message: 'Turn ended',
        fields: { chat: 'c', provider: 'claude', ms: 12, skip: undefined }
      },
      HOME
    ),
    '2025-10-05T21:52:43.500Z info app chat chat=c Turn ended provider=claude ms=12'
  )
  const long = formatLogLine({ ...entry, message: 'x'.repeat(5000), fields: {} }, HOME)
  assert.ok(long.endsWith('…') && long.length < 1100, 'long messages are cut')

  // The Swift writer (host and service) formats and redacts identically.
  const fixture = swiftBuild('product-log', [
    'src/service/ProductLog.swift',
    'test/fixtures/product-log/main.swift'
  ])
  const swift = JSON.parse(runFixture(fixture, ['redact', HOME, ...TEXTS]))
  assert.deepEqual(swift.texts, redacted)
  assert.equal(swift.line, line)

  // Swift writes into TREZI_LOG_DIR, stops at its cap with one marker line, never a secret.
  const swiftDir = join(temp, 'swift')
  assert.equal(runFixture(fixture, ['write', swiftDir, '200']).trim(), swiftDir)
  const [swiftFile] = readdirSync(swiftDir)
  assert.match(swiftFile, /^trezi-\d{4}-\d{2}-\d{2}\.log$/)
  const swiftText = readFileSync(join(swiftDir, swiftFile), 'utf8')
  assert.ok(statSync(join(swiftDir, swiftFile)).size < 4096 + 400)
  assert.match(swiftText, / warn service log Daily log limit reached/)
  assert.ok(!swiftText.includes('sk-ant-'))
  assert.ok(!swiftText.includes(homedir()))
  assert.match(
    swiftText,
    / info service provider Helper started 0 in ~\/dev\/app with key=\[redacted\]/
  )
  assert.equal((statSync(join(swiftDir, swiftFile)).mode & 0o777).toString(8), '600')

  // Folder: TREZI_LOG_DIR when absolute, else ~/Library/Logs/Trezi.
  assert.equal(logDirectory({}, HOME), `${HOME}/Library/Logs/Trezi`)
  assert.equal(logDirectory({ TREZI_LOG_DIR: 'relative' }, HOME), `${HOME}/Library/Logs/Trezi`)
  assert.equal(logDirectory({ TREZI_LOG_DIR: '/tmp/x' }, HOME), '/tmp/x')
  assert.equal(logFileName(AT), 'trezi-2025-10-05.log')

  // Rotation: a new UTC day opens a new file and prunes files older than 7 days.
  const dir = join(temp, 'bun')
  mkdirSync(dir)
  for (const day of ['2025-09-20', '2025-09-28', '2025-09-29', '2025-10-04'])
    writeFileSync(join(dir, `trezi-${day}.log`), '')
  writeFileSync(join(dir, 'notes.txt'), '')
  let clock = AT
  const writer = new LogWriter({
    dir,
    process: 'backend',
    now: () => clock,
    home: HOME,
    maxBytes: 1500
  })
  writer.write('info', 'lifecycle', 'Backend started', { pid: 1 })
  assert.deepEqual(readdirSync(dir).sort(), [
    'notes.txt',
    'trezi-2025-09-29.log',
    'trezi-2025-10-04.log',
    'trezi-2025-10-05.log'
  ])
  clock = AT + DAY
  writer.write('info', 'lifecycle', 'Next day')
  assert.ok(existsSync(join(dir, 'trezi-2025-10-06.log')))
  assert.ok(!existsSync(join(dir, 'trezi-2025-09-29.log')), 'the 8th day back is pruned')
  assert.deepEqual(pruneLogs(dir, AT + 30 * DAY).sort(), [
    'trezi-2025-10-04.log',
    'trezi-2025-10-05.log',
    'trezi-2025-10-06.log'
  ])
  assert.deepEqual(readdirSync(dir), ['notes.txt'])

  // The daily cap: lines stop at maxBytes with one marker; the next day starts fresh.
  clock = AT
  for (let i = 0; i < 50; i++) writer.write('info', 'chat', `line ${i} ${'y'.repeat(40)}`)
  const capped = readFileSync(join(dir, 'trezi-2025-10-05.log'), 'utf8')
  assert.ok(Buffer.byteLength(capped) < 1500 + 300)
  assert.equal(capped.match(/Daily log limit reached/g)?.length, 1)
  writer.close()

  // Reading: the window across day files, every process, sorted by time.
  const read = join(temp, 'read')
  mkdirSync(read)
  const at = (ms) => new Date(AT + ms).toISOString()
  writeFileSync(
    join(read, 'trezi-2025-10-05.log'),
    [
      `${at(-40 * 60_000)} info app chat too old`,
      `${at(-10 * 60_000)} info service xpc second`,
      `${at(-20 * 60_000)} info app chat first`,
      'not a log line',
      `${at(60_000)} info app chat future`
    ].join('\n')
  )
  assert.deepEqual(
    readLogs(read, 30 * 60_000, AT).map((l) => l.split(' ').at(-1)),
    ['first', 'second']
  )
  assert.deepEqual(readLogs(join(temp, 'missing'), DAY, AT), [])
  assert.equal(parseSince('30m'), 30 * 60_000)
  assert.equal(parseSince('2h'), 2 * 3_600_000)
  assert.equal(parseSince('1d'), DAY)
  assert.equal(parseSince('45s'), 45_000)
  assert.equal(parseSince('15'), 15 * 60_000)
  assert.throws(() => parseSince('soon'), /Not a duration/)

  // `trezi logs [--since 30m] [--follow]`.
  let out = ''
  let err = ''
  const io = {
    env: { TREZI_LOG_DIR: read },
    out: (t) => (out += t),
    err: (t) => (err += t),
    now: () => AT
  }
  assert.equal(await logs([], io), null)
  assert.equal(out.trim().split('\n').length, 2)
  out = ''
  await logs(['--since', '1h'], io)
  assert.equal(out.trim().split('\n').length, 3)
  out = ''
  await logs(['--since=1m'], io)
  assert.equal(out, '')
  assert.match(err, /No Trezi log lines in the last 1m/)
  await assert.rejects(logs(['--verbose'], io), /Unknown option/)
  await assert.rejects(logs(['--since', 'later'], io), /Not a duration/)
  out = ''
  const stop = followLogs(read, (t) => (out += t), {
    now: () => AT,
    interval: 10,
    fileName: logFileName
  })
  appendFileSync(
    join(read, 'trezi-2025-10-05.log'),
    `\n${at(0)} info app chat followed\n${at(0)} info app chat part`
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(out, `\n${at(0)} info app chat followed\n`, 'a partial line waits for its newline')
  stop()
  const cli = spawnSync('bun', ['bin/trezi.mjs', 'logs', '--since', '7d'], {
    encoding: 'utf8',
    env: { ...process.env, TREZI_LOG_DIR: read }
  })
  assert.equal(cli.status, 0, cli.stderr)

  // The process logger: a no-op until initialized, then the turn and preview lines.
  const live = join(temp, 'live')
  productLog.info('chat', 'before init')
  initProductLog('backend', { TREZI_LOG_DIR: live })
  assert.equal(productLogDirectory(), live)
  logTurnStart('chat-a', 'turn-1', { provider: 'codex', model: 'gpt-5' })
  logTurnEvent('chat-a', { type: 'model', model: 'gpt-5-codex' })
  logTurnEvent('chat-a', { type: 'done', turn: 'turn-1' })
  logTurnStart('chat-a', 'turn-2', {})
  logTurnEvent('chat-a', { type: 'error', turn: 'turn-2', message: `failed with ${SECRETS[0]}` })
  productLog.info('output', 'ready on http://localhost:3000', undefined, 'devserver')
  notePreviewMessage('preview:picked')
  notePreviewMessage('preview:picked')
  notePreviewMessage('agent:send', true)
  flushPreviewSummary()
  const liveLines = readLogs(live, DAY)
  const text = liveLines.join('\n')
  assert.ok(!text.includes('before init'))
  assert.ok(!text.includes('sk-ant-'))
  assert.match(
    text,
    / info backend chat chat=chat-a turn=turn-1 Turn started provider=codex model=gpt-5\n/
  )
  assert.match(text, / info backend chat chat=chat-a Model resolved model=gpt-5-codex/)
  assert.match(
    text,
    / info backend chat chat=chat-a turn=turn-1 Turn ended provider=codex model=gpt-5-codex ms=\d+/
  )
  assert.match(
    text,
    / info backend chat chat=chat-a turn=turn-2 Turn started provider=claude model=default resolved=gpt-5-codex/
  )
  assert.match(
    text,
    / error backend chat chat=chat-a turn=turn-2 Turn failed .*error="failed with \[redacted\]"/
  )
  assert.match(text, / info devserver output ready on http:\/\/localhost:3000/)
  assert.match(
    text,
    / warn preview bridge Preview messages total=3 refused=1 channels=preview:picked:2,agent:send:1/
  )

  // Copy Logs for Support: debug lines dropped, the newest lines kept within the cap.
  const many = Array.from({ length: 30 }, (_, i) => `${at(i)} info app chat line-${i}`)
  many.splice(3, 0, `${at(3)} debug app chat noisy`)
  const copied = supportText(many, 'Header', 300)
  assert.ok(copied.startsWith('Header\n\n… ('))
  assert.ok(copied.length < 400 && copied.includes('line-29') && !copied.includes('noisy'))
  assert.match(supportText([], 'Header'), /no log lines/)

  // Export Logs…: a zip of the last 24 hours and the system summary.
  const zip = join(temp, 'export.zip')
  writeFileSync(zip, 'stale')
  const exported = await exportLogs(zip, 'App: Trezi test', { dir: read, now: AT })
  // Three earlier lines and the two followed ones; the future line is outside the window.
  assert.equal(exported.lines, 5)
  const listing = spawnSync('/usr/bin/unzip', ['-l', zip], { encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  assert.match(listing.stdout, /Trezi Logs\/summary\.txt/)
  assert.match(listing.stdout, /Trezi Logs\/trezi\.log/)
  const summary = spawnSync('/usr/bin/unzip', ['-p', zip, 'Trezi Logs/summary.txt'], {
    encoding: 'utf8'
  })
  assert.equal(summary.stdout, 'App: Trezi test\n')
  console.log(
    'product log: redaction, Swift parity, rotation, cap, prune, CLI, support text and export passed'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}

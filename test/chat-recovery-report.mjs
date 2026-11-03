import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logFileName } from '../src/main/product-log.ts'
import { readableRecoveryReport, writeRecoveryReport } from '../src/native/chat-recovery-report.ts'
import { newChat } from '../src/native/chat-state.ts'

const dir = mkdtempSync(join(tmpdir(), 'trezi-recovery-report-test-'))
const previous = process.env.TREZI_LOG_DIR
try {
  process.env.TREZI_LOG_DIR = dir
  const now = new Date().toISOString()
  writeFileSync(
    join(dir, logFileName(Date.now())),
    [
      `${now} info bun landing chat=alpha operation=retry`,
      `${now} info bun landing chat=beta operation=unrelated`,
      `${now} error bun landing chat=alpha token=secret-value`
    ].join('\n')
  )
  const chat = newChat('alpha')
  chat.recoveryId = 'operation-1'
  chat.recoveryStartedAt = Date.now()
  chat.isolation = 'parked'
  const path = await writeRecoveryReport(chat, 'retry', 'Problem: check failed')
  const content = readFileSync(path, 'utf8')
  assert.equal(readableRecoveryReport('alpha'), content)
  assert.equal(readableRecoveryReport('beta'), null)
  assert.match(content, /operation-1/)
  assert.match(content, /check failed/)
  assert.doesNotMatch(content, /chat=beta|unrelated|secret-value/)
  assert.match(content, /\[redacted\]/)
} finally {
  if (previous === undefined) delete process.env.TREZI_LOG_DIR
  else process.env.TREZI_LOG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
}
console.log('CHAT RECOVERY REPORT OK — readable, scoped, redacted')

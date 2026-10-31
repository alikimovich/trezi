import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// LKM-393: red-capable source checks for the native smoke's real input routes.
// Runtime proof requires the manager's foreground `preview-markup` native smoke.
const source = (name) => readFileSync(`src/native/${name}`, 'utf8')
const host = source('PreviewMarkupHost.swift')
const broker = source('HostInspect.swift')
const smoke = source('smoke-preview-markup.ts')

assert.match(host, /NSApp\.postEvent\(event, atStart: false\)/, 'posted AppKit event')
assert.doesNotMatch(
  host,
  /canvas\.pointerDown\(|canvas\.pointerDragged\(|overlay\.select\(/,
  'no direct drawing handler route'
)
assert.doesNotMatch(host, /composer\.text\.insertText\(/, 'no direct text insertion route')
for (const action of ['key', 'pointer', 'button', 'typeInstruction']) {
  assert.match(host, new RegExp(`case "${action}"`), `${action} event implementation`)
  assert.match(broker, new RegExp(`"${action}"`), `${action} event broker`)
  assert.match(smoke, new RegExp(`action: '${action}'`), `${action} smoke route`)
}
assert.match(smoke, /history.*steps/, 'history is checked across posted keys')
assert.match(smoke, /__markupSmokeKeys/, 'page keyDown delivery is checked')
assert.match(smoke, /prompt\.endsWith\(DRAFT \+ INSTRUCTION\)/, 'text travels with the draft')
assert.match(smoke, /route: 'real event route'/, 'receipts classify real events')
assert.match(smoke, /seam only/, 'receipts classify seams')
console.log('PREVIEW-MARKUP-ROUTING PASS')

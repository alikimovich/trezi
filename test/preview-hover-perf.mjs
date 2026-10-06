// A busy chat must not make 100 preview pointer moves do 100 layout passes.
import assert from 'node:assert/strict'
import { coalesceHover } from '../src/preview/coalesce-hover.ts'

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h20v20H0z"/></svg>'
const code = `\`\`\`svg\n${svg.repeat(30)}\n\`\`\``
const chat = {
  messages: [
    { text: code, attachments: [{ id: 'a', url: svg }] },
    { text: code, attachments: [{ id: 'b', url: svg }] }
  ]
}
assert.ok(chat.messages.map((m) => m.text).join('').length > 2048)
assert.equal(
  chat.messages.reduce((sum, m) => sum + m.attachments.length, 0),
  2
)

let callback
let scheduled = 0
let cancelled = 0
const painted = []
const hover = coalesceHover(
  (target) => painted.push(target),
  (next) => {
    scheduled++
    callback = next
    return scheduled
  },
  () => {
    cancelled++
    callback = undefined
  }
)
const start = performance.now()
for (let i = 0; i < 100; i++) hover.move({ index: i, chat })
const elapsed = performance.now() - start
assert.ok(elapsed < 16, `100 hover messages blocked the main thread for ${elapsed.toFixed(2)} ms`)
assert.equal(scheduled, 1, 'only one layout pass is queued per frame')
callback()
assert.equal(painted.length, 1)
assert.equal(painted[0].index, 99, 'the latest pointer target wins')
hover.move({ index: 100, chat })
hover.clear()
assert.equal(cancelled, 1)
assert.equal(callback, undefined, 'a click or mode switch cancels stale hover work')
console.log(
  `PREVIEW HOVER PERF OK — 100 synthetic moves queued in ${elapsed.toFixed(2)} ms; one frame`
)

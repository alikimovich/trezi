import assert from 'node:assert/strict'
import { withConversationHandoff } from '../src/main/backends/conversation-handoff.ts'

const transcript = [
  { role: 'user', text: 'Use the label Indigo Orchard.', at: 1 },
  { role: 'assistant', text: 'I updated the label.', at: 2 },
  { role: 'status', text: 'Edited src/App.tsx', at: 3 }
]
const original = JSON.stringify(transcript)
const calls = []
const send = withConversationHandoff((...args) => calls.push(args), transcript)
const images = [{ path: '/tmp/current-image.png' }]
send('What label did we choose?', images)
assert(calls[0][0].includes('Indigo Orchard.'))
assert(calls[0][0].includes('I updated the label.'))
assert(calls[0][0].includes('Edited src/App.tsx'))
assert(calls[0][0].endsWith('What label did we choose?'))
assert.equal(calls[0][1], images)
send('Continue.')
assert.equal(calls[1][0], 'Continue.')
assert.equal(
  JSON.stringify(transcript),
  original,
  'history must not be mutated or recursively injected'
)
withConversationHandoff((text) => assert.equal(text, 'First prompt'), [])('First prompt')
let attempts = 0
const retry = withConversationHandoff((text) => {
  assert(text.includes('Indigo Orchard.'))
  if (++attempts === 1) throw new Error('send rejected')
}, transcript)
assert.throws(() => retry('Try'))
retry('Try again')
console.log(
  'CONVERSATION-HANDOFF OK — history, tool summaries, one-time replay, images, empty chat, retry'
)

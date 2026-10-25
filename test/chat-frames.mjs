import assert from 'node:assert/strict'
import { chatFrames } from '../src/native/chat-frames.ts'

const frame = chatFrames()
const image = `data:image/png;base64,${'a'.repeat(100_000)}`
const state = (chat, text, id = 'image-1') => ({
  chat,
  messages: [{ id: 'user', role: 'user', text, attachments: [{ id, kind: 'image', url: image }] }]
})
const first = frame(state('a', 'one'))
assert.equal(first.messages[0].attachments[0].url, image, 'first image frame carries its data')
assert.equal(frame(state('a', 'one')).messages, undefined, 'unchanged image is not resent')
const changed = frame(state('a', 'two'))
assert.equal(
  changed.messages[0].attachments[0].url,
  undefined,
  'changed transcript uses the image ID'
)
assert.ok(JSON.stringify(changed).length < 1000, 'later frame excludes image bytes')
assert.equal(
  frame(state('a', 'three', 'image-2')).messages[0].attachments[0].url,
  image,
  'new image still carries its data'
)
frame({ chat: 'a', messages: [] })
assert.equal(
  frame(state('a', 'again')).messages[0].attachments[0].url,
  image,
  'an image reintroduced after removal carries its data again'
)
assert.equal(
  frame(state('b', 'one')).messages[0].attachments[0].url,
  image,
  'switching chats sends the image again for the new host snapshot'
)

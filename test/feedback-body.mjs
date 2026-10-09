/**
 * Unit test for the pure feedback issue-body/title builders (LKM-27, no Electron
 * needed). Run via bun so the .ts import transpiles: bun run test:feedback-body
 */
import assert from 'node:assert'
import { buildFeedbackBody, buildFeedbackTitle } from '../src/shared/feedback-body.ts'

// --- Title: first non-empty line, prefixed + truncated. ---
assert.equal(buildFeedbackTitle('The button is broken'), 'Feedback: The button is broken')
assert.equal(buildFeedbackTitle('\n\n  spacing issue \nmore'), 'Feedback: spacing issue')
assert.equal(buildFeedbackTitle(''), 'Feedback: App feedback')
const long = 'x'.repeat(120)
const title = buildFeedbackTitle(long)
assert.ok(title.length <= 'Feedback: '.length + 70, 'title truncated')
assert.ok(title.endsWith('…'), 'truncation ellipsis')

// --- Body: bare feedback + footer, no optional sections. ---
let body = buildFeedbackBody({ body: 'please fix' })
assert.ok(body.includes('please fix'), 'feedback text kept')
assert.ok(body.includes('Sent from Trezi'), 'footer present')
assert.ok(!body.includes('<details>'), 'no details when nothing attached')

// Empty feedback still yields a placeholder, never an empty body.
body = buildFeedbackBody({ body: '   ' })
assert.ok(body.includes('no description provided'), 'empty-body placeholder')

// --- Conversation + screenshot render as collapsed details. ---
body = buildFeedbackBody({
  body: 'hi',
  conversation: 'You: hello\n\nTrezi: hi',
  screenshot: 'data:image/jpeg;base64,QUJD'
})
assert.ok(body.includes('Conversation transcript'), 'conversation summary')
assert.ok(body.includes('You: hello'), 'transcript content')
assert.ok(body.includes('Screenshot'), 'screenshot summary')
assert.ok(body.includes('data:image/jpeg;base64,QUJD'), 'screenshot data uri embedded')

// --- Oversized screenshot is dropped with a note, feedback text survives. ---
const huge = 'data:image/jpeg;base64,' + 'A'.repeat(70000)
body = buildFeedbackBody({ body: 'keepme', screenshot: huge })
assert.ok(body.includes('keepme'), 'feedback survives oversized attachment')
assert.ok(body.includes('Screenshot omitted'), 'oversized screenshot dropped')
assert.ok(body.length <= 65536, 'body under GitHub limit')

console.log('FEEDBACK-BODY OK')

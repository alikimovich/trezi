/**
 * Unit test for the pure chat auto-naming helpers (LKM-45) — the transcript →
 * prompt digest and the model-output → clean-label sanitiser. No Electron/SDK
 * needed. Run via bun so the .ts import transpiles: bun run test:chat-title
 */
import assert from 'node:assert'
import { sanitizeTitle, transcriptDigest } from '../src/main/backends/title.ts'
import { isSystemText, migrateChatTitle, NEUTRAL_CHAT_TITLE } from '../src/shared/chat-title.ts'

// --- transcriptDigest: user/assistant only, whitespace-collapsed, capped. ---
{
  const digest = transcriptDigest([
    { role: 'user', text: '  Hey there!  Can you\n\nmake the header sticky?  ', at: 1 },
    { role: 'status', text: 'Edit · src/Header.tsx', at: 2 },
    { role: 'assistant', text: 'Sure — I added position: sticky to the header.', at: 3 }
  ])
  assert.ok(
    digest.includes('User: Hey there! Can you make the header sticky?'),
    'user turn kept + collapsed'
  )
  assert.ok(digest.includes('Assistant: Sure'), 'assistant turn kept')
  assert.ok(!digest.includes('Edit ·'), 'tool-status lines dropped from the digest')
}

// Empty / status-only transcripts produce nothing to summarise.
assert.equal(transcriptDigest([]), '', 'empty transcript → empty digest')
assert.equal(
  transcriptDigest([{ role: 'status', text: 'Read · a.ts', at: 1 }]),
  '',
  'status-only transcript → empty digest'
)
assert.equal(
  transcriptDigest([{ role: 'user', text: '   ', at: 1 }]),
  '',
  'blank user turn → empty digest'
)

// Long transcripts are capped so a huge chat can't bloat the prompt.
{
  const big = transcriptDigest([
    { role: 'user', text: 'x'.repeat(9000), at: 1 },
    { role: 'assistant', text: 'y'.repeat(9000), at: 2 }
  ])
  assert.ok(big.length <= 4000, `digest capped (got ${big.length})`)
}

// --- sanitizeTitle: strip framing/quotes/punctuation, cap length. ---
assert.equal(sanitizeTitle('Make Header Sticky'), 'Make Header Sticky')
assert.equal(
  sanitizeTitle('  Make   Header  Sticky  '),
  'Make Header Sticky',
  'whitespace collapsed'
)
assert.equal(
  sanitizeTitle('Title: Make Header Sticky'),
  'Make Header Sticky',
  'drops "Title:" preamble'
)
assert.equal(sanitizeTitle('Name - Fix Nav Spacing'), 'Fix Nav Spacing', 'drops "Name -" preamble')
assert.equal(sanitizeTitle('"Make Header Sticky"'), 'Make Header Sticky', 'peels wrapping quotes')
assert.equal(sanitizeTitle('`Dark Mode Toggle`'), 'Dark Mode Toggle', 'peels wrapping backticks')
assert.equal(
  sanitizeTitle('Add a Dark Mode Toggle.'),
  'Add a Dark Mode Toggle',
  'strips trailing period'
)
assert.equal(sanitizeTitle(''), null, 'empty → null')
assert.equal(sanitizeTitle('   '), null, 'blank → null')

// A "Foo bar" that only becomes empty after quote-peel/trim still yields null.
assert.equal(sanitizeTitle('""'), '""', 'empty-quoted body left intact (no inner content to peel)')

// Over-long titles are truncated with an ellipsis (matches the rail's cap).
{
  const t = sanitizeTitle('Refactor the entire authentication and onboarding subsystem end to end')
  assert.ok(t.length <= 41, `title capped (got ${t.length})`)
  assert.ok(t.endsWith('…'), 'truncation ellipsis')
}

// --- LKM-120: never a title from an error, auth or system message. ---
const systemMessages = [
  'Not logged in · Please run /login',
  'Invalid API key · Please run /login',
  'OAuth token revoked · Please run /login',
  'OAuth token has expired. Please obtain a new token or refresh your existing token.',
  'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
  'API Error: 529 Overloaded',
  'Error: spawn claude ENOENT',
  'Execution error',
  'Credit balance is too low',
  'Claude AI usage limit reached|1759200000',
  "You've hit your limit · resets 3pm",
  'Prompt is too long',
  '[Request interrupted by user]',
  'No conversation found with session ID: 1234',
  'unexpected status 401 Unauthorized',
  'fetch failed',
  'Unable to complete action'
]
for (const text of systemMessages) {
  assert.equal(isSystemText(text), true, `system text: ${text}`)
  assert.equal(sanitizeTitle(text), null, `never a title: ${text}`)
  assert.equal(sanitizeTitle(`"${text}"`), null, `never a title once quotes are peeled: ${text}`)
}
const realTitles = [
  'Make Header Sticky',
  'Fix Login Error Handling',
  'Rate Limit Settings Page',
  'Error Page Redesign',
  'Authentication Error Handling',
  'Handle 401 Responses',
  'Sign In Form Layout',
  'Hero Section Redesign'
]
for (const text of realTitles) {
  assert.equal(isSystemText(text), false, `real content: ${text}`)
  assert.equal(sanitizeTitle(text), text, `real title kept: ${text}`)
}

// An assistant turn that is only an error never reaches the title prompt; real turns do.
{
  const digest = transcriptDigest([
    { role: 'user', text: 'Make the header sticky', at: 1 },
    { role: 'assistant', text: 'Not logged in · Please run /login', at: 2 },
    { role: 'assistant', text: 'I made the header sticky.', at: 3 }
  ])
  assert.equal(
    digest,
    'User: Make the header sticky\nAssistant: I made the header sticky.',
    'error turn dropped from the digest'
  )
  assert.equal(
    transcriptDigest([{ role: 'assistant', text: 'Not logged in · Please run /login', at: 1 }]),
    '',
    'an error-only transcript has nothing to name'
  )
}

// Titles that came from an error migrate to the neutral one; real and absent titles stay.
assert.equal(NEUTRAL_CHAT_TITLE, 'New chat')
assert.equal(
  migrateChatTitle('Not logged in · Please run /login'),
  'New chat',
  'error title migrated'
)
assert.equal(migrateChatTitle('API Error: 529 Overloaded'), 'New chat', 'API error title migrated')
assert.equal(migrateChatTitle('Make Header Sticky'), 'Make Header Sticky', 'real title kept')
assert.equal(migrateChatTitle(undefined), undefined, 'untitled stays untitled')
assert.equal(migrateChatTitle(''), '', 'empty stays empty')

console.log('chat-title: all assertions passed')

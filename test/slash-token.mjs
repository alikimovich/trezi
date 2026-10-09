/**
 * parseSlashToken() unit test (pure — no Electron, no DOM). Drives which "/"
 * token the composer's slash-command menu reads: it must open at the start of
 * a message AND mid-message after whitespace, but never when a non-whitespace
 * character sits directly before the "/".
 *
 * Run with: bun run test:slash-token
 */
import { parseSlashToken } from '../src/shared/slash-token.ts'

let failed = 0
const same = (a, b, msg) => {
  const A = JSON.stringify(a)
  const B = JSON.stringify(b)
  if (A !== B) {
    console.error(`FAIL: ${msg} — got ${A}, want ${B}`)
    failed++
  }
}

// Caret defaults to end of input for readability.
const at = (s, caret = s.length) => parseSlashToken(s, caret)

// Opens at the very start of the message.
same(at('/'), { query: '', start: 0 }, 'bare "/" at start opens (empty query)')
same(at('/rev'), { query: 'rev', start: 0 }, 'query at start')

// Opens mid-message after whitespace (the core of LKM-37).
same(at('hey /rev'), { query: 'rev', start: 4 }, 'after a space mid-message')
same(at('a\n/rev'), { query: 'rev', start: 2 }, 'after a newline')
same(at('a\t/rev'), { query: 'rev', start: 2 }, 'after a tab')
same(at('one two /'), { query: '', start: 8 }, 'bare "/" after words opens')

// Does NOT open when a non-whitespace char sits right before "/".
same(at('foo/bar'), null, 'non-whitespace before "/" (path-like) stays closed')
same(at('a/'), null, 'char immediately before bare "/" stays closed')
same(at('http://x'), null, 'URL scheme "//" stays closed')

// Closed when there is no "/" token before the caret.
same(at('hello'), null, 'plain text, no "/"')
same(at(''), null, 'empty input')

// Reads the token the CARET is in, not the whole string.
same(parseSlashToken('/rev extra', 4), { query: 'rev', start: 0 }, 'caret mid-token')
same(parseSlashToken('/rev tail', 9), null, 'caret past the token (in later plain text) closes')

// A space ends the token — caret after "/foo " is no longer in a "/" token.
same(at('/foo '), null, 'trailing space closes the token')

if (failed) {
  console.error(`SLASH-TOKEN FAILED: ${failed} assertion(s)`)
  process.exitCode = 1
} else {
  console.log('SLASH-TOKEN OK — opens at start & after whitespace, closed after non-ws')
}

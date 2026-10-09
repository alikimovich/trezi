/**
 * media-types.ts unit test (pure — no Electron). This is the half of the
 * editor's media support that decides whether a file is a picture, a video, or
 * bytes we shouldn't pour into CodeMirror, plus the Range parsing the
 * trezi-media protocol needs for <video> seeking.
 *
 * Asserts: media detection is case-insensitive (`arkady.PNG` is the reported
 * bug), .svg stays TEXT on purpose, source files are never mistaken for media;
 * binary sniffing catches a NUL byte and utf8 garbage while leaving real source
 * (accents, emoji, CRLF) alone; Range parses the three RFC forms and rejects
 * out-of-bounds asks.
 *
 * Run with: bun run test:media-types
 */
import { looksBinary, mediaTypeFor, parseRange } from '../src/main/media-types.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) failed++, console.error('  ✗', msg)
}
const eq = (a, b, msg) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}`)

// --- media detection ---------------------------------------------------------
eq(mediaTypeFor('a/b/logo.png'), { kind: 'image', mediaType: 'image/png' }, 'png')
// The reported case: an uppercase extension must still preview.
eq(mediaTypeFor('public/images/team/arkady.PNG'), { kind: 'image', mediaType: 'image/png' }, 'PNG')
eq(mediaTypeFor('shot.JPeG'), { kind: 'image', mediaType: 'image/jpeg' }, 'mixed-case jpeg')
eq(mediaTypeFor('clip.mp4'), { kind: 'video', mediaType: 'video/mp4' }, 'mp4')
eq(mediaTypeFor('clip.webm'), { kind: 'video', mediaType: 'video/webm' }, 'webm')
eq(mediaTypeFor('theme.mp3'), { kind: 'audio', mediaType: 'audio/mpeg' }, 'mp3')
ok(mediaTypeFor('src/App.tsx') === null, 'source file is not media')
ok(mediaTypeFor('README') === null, 'extensionless file is not media')
// SVG is markup the user edits — it must stay in the text editor.
ok(mediaTypeFor('icons/star.svg') === null, 'svg stays text')
// A dotfile is all "extension" to path.extname()'s caller intuition, not ours.
ok(mediaTypeFor('.gitignore') === null, 'dotfile is not media')
ok(mediaTypeFor('fonts/Inter.woff2') === null, 'font is not previewable media')

// --- binary sniffing ---------------------------------------------------------
ok(!looksBinary(''), 'empty file is text')
ok(!looksBinary('export const a = 1\n'), 'source is text')
ok(!looksBinary('// caffè — naïve 🎉\r\nconst x = 1\r\n'), 'accents/emoji/CRLF are text')
ok(looksBinary(`PNG${String.fromCharCode(0)}IHDR`), 'NUL byte means binary')
ok(looksBinary(`${String.fromCharCode(0xfffd).repeat(50)}abc`), 'utf8 garbage means binary')
// One stray replacement char in a big file is not enough to hide it.
ok(
  !looksBinary(`${'x'.repeat(500)}${String.fromCharCode(0xfffd)}`),
  'a single U+FFFD is not binary'
)

// --- Range parsing -----------------------------------------------------------
ok(parseRange(null, 1000) === null, 'no header → whole file')
ok(parseRange('', 1000) === null, 'empty header → whole file')
ok(parseRange('bytes=0-999,2000-2500', 1000) === null, 'multi-range falls back to whole file')
ok(parseRange('items=0-1', 1000) === null, 'unknown unit falls back to whole file')
eq(parseRange('bytes=0-99', 1000), { start: 0, end: 99 }, 'explicit range')
eq(parseRange('bytes=500-', 1000), { start: 500, end: 999 }, 'open-ended range')
eq(parseRange('bytes=-200', 1000), { start: 800, end: 999 }, 'suffix range')
eq(parseRange('bytes=-5000', 1000), { start: 0, end: 999 }, 'suffix larger than the file clamps')
eq(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }, 'end past EOF clamps')
ok(parseRange('bytes=1000-', 1000) === 'unsatisfiable', 'start at EOF is unsatisfiable')
ok(parseRange('bytes=5000-6000', 1000) === 'unsatisfiable', 'start past EOF is unsatisfiable')
ok(parseRange('bytes=-0', 1000) === 'unsatisfiable', 'zero-length suffix is unsatisfiable')
ok(parseRange('bytes=0-', 0) === 'unsatisfiable', 'empty file has no satisfiable range')

if (failed) {
  console.error(`MEDIA-TYPES FAILED — ${failed} assertion(s)`)
  process.exit(1)
}
console.log('MEDIA-TYPES OK — detection (case-insensitive, svg excluded), binary sniff, Range')

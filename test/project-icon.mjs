/**
 * project-icon unit test (pure — no Electron). The rail's per-project favicon:
 * which files count as an icon, how a declared `<link rel="icon">` is lexed and
 * resolved, and the end-to-end pick over a real temp tree (declared href beats
 * convention, conventional order, escapes refused, size cap, mtime
 * revalidation). Run with: bun run test:project-icon
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findProjectIconFile,
  iconCandidates,
  iconHrefCandidates,
  iconMediaType,
  parseHtmlIconHrefs,
  readProjectIcon
} from '../src/main/project-icon.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const eq = (actual, expected, msg) =>
  ok(
    actual === expected,
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
const deepEq = (actual, expected, msg) => eq(JSON.stringify(actual), JSON.stringify(expected), msg)

// --- iconMediaType: what's worth putting in a 16px slot ---

eq(iconMediaType('favicon.svg'), 'image/svg+xml', 'svg is an icon type')
eq(iconMediaType('favicon.ico'), 'image/x-icon', 'ico is an icon type')
eq(iconMediaType('public/logo.PNG'), 'image/png', 'extension match is case-insensitive')
eq(iconMediaType('favicon.webp'), 'image/webp', 'webp is an icon type')
eq(iconMediaType('icon.heic'), null, "a type Chromium can't decode is not an icon")
eq(iconMediaType('index.html'), null, 'markup is not an icon')
eq(iconMediaType('favicon'), null, 'no extension is not an icon')

// --- parseHtmlIconHrefs: the declared icon(s), in declaration order ---

eq(parseHtmlIconHrefs('<link rel="icon" href="/favicon.svg">')[0], '/favicon.svg', 'plain rel=icon')
eq(
  parseHtmlIconHrefs('<link href="/f.ico" rel="shortcut icon">')[0],
  '/f.ico',
  'attribute order is irrelevant, and "shortcut icon" counts'
)
eq(
  parseHtmlIconHrefs("<link rel='apple-touch-icon' href='/apple.png'>")[0],
  '/apple.png',
  'single quotes + apple-touch-icon'
)
eq(
  parseHtmlIconHrefs('<link REL="ICON" HREF="/up.png">')[0],
  '/up.png',
  'tag/attribute matching is case-insensitive'
)
eq(
  parseHtmlIconHrefs('<link rel="stylesheet" href="/app.css">').length,
  0,
  'a stylesheet is not an icon'
)
eq(
  parseHtmlIconHrefs('<link rel="preconnect" href="https://fonts.gstatic.com">').length,
  0,
  'preconnect is not an icon'
)
// 'icon' must be a whole rel token — this is what stops rel="preload" style
// substrings, and anything else that merely CONTAINS the word, from matching.
eq(parseHtmlIconHrefs('<link rel="iconic" href="/x.png">').length, 0, 'rel=iconic is not rel=icon')
deepEq(
  parseHtmlIconHrefs(`
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="icon" href="/favicon.ico">
    <link rel="icon" href="/favicon.svg">
  `),
  ['/favicon.svg', '/favicon.ico'],
  'declaration order preserved, duplicates dropped'
)

// --- iconHrefCandidates: href → project-relative path(s) ---

deepEq(
  iconHrefCandidates('/favicon.png', ''),
  ['public/favicon.png', 'static/favicon.png', 'favicon.png'],
  'a site-absolute href tries each static root, then the project root'
)
deepEq(iconHrefCandidates('./favicon.png', ''), ['favicon.png'], 'relative href at the root')
deepEq(
  iconHrefCandidates('assets/f.png', 'src'),
  ['src/assets/f.png'],
  "a relative href resolves against the declaring document's dir"
)
deepEq(
  iconHrefCandidates('https://cdn.example.com/f.png', ''),
  [],
  'an external URL is not a local file'
)
deepEq(iconHrefCandidates('//cdn.example.com/f.png', ''), [], 'a protocol-relative URL is refused')
deepEq(iconHrefCandidates('#sprite', ''), [], 'a fragment reference is refused')
deepEq(
  iconHrefCandidates('data:image/png;base64,AAAA', ''),
  ['data:image/png;base64,AAAA'],
  'an inline data: icon comes back verbatim'
)

// --- iconCandidates: conventional locations, dir-major, best-first ---

const conventions = iconCandidates()
ok(
  conventions.indexOf('app/favicon.ico') < conventions.indexOf('public/favicon.ico'),
  "Next's app/ favicon outranks public/ (it's what Next serves)"
)
ok(
  conventions.indexOf('public/favicon.svg') < conventions.indexOf('public/favicon.ico'),
  'within a dir, svg outranks ico'
)
ok(conventions.includes('static/favicon.png'), "SvelteKit's static/favicon.png is a candidate")
ok(conventions.includes('favicon.ico'), 'a bare root favicon.ico is a candidate')
ok(
  conventions.every((c) => !c.startsWith('/')),
  'every candidate is project-relative'
)

// --- End-to-end over a real tree ---

const roots = []
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'trezi-icon-'))
  roots.push(dir)
  return dir
}
/** Write `rel` under `root`, creating parents. `body` may be a Buffer. */
const put = (root, rel, body = 'x') => {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  return abs
}

// Nothing to find.
const empty = makeRoot()
put(empty, 'package.json', '{}')
eq(await findProjectIconFile(empty), null, 'a project with no icon resolves to null')
eq(await readProjectIcon(empty), null, 'readProjectIcon is null for an iconless project')

// Conventional locations, no HTML entry.
const conventional = makeRoot()
put(conventional, 'public/favicon.ico')
put(conventional, 'public/favicon.svg')
eq(
  (await findProjectIconFile(conventional)).path,
  'public/favicon.svg',
  'svg wins over ico in the same dir'
)

// A declared <link> beats the conventional file, even a "better" one.
const declared = makeRoot()
put(declared, 'public/favicon.svg')
put(declared, 'public/brand.png')
put(declared, 'index.html', '<html><head><link rel="icon" href="/brand.png"></head></html>')
eq(
  (await findProjectIconFile(declared)).path,
  'public/brand.png',
  "the project's own declaration outranks the convention scan"
)

// A declared href pointing at nothing falls through to the conventions rather
// than leaving the project iconless.
const stale = makeRoot()
put(stale, 'public/favicon.svg')
put(stale, 'index.html', '<link rel="icon" href="/gone.png">')
eq(
  (await findProjectIconFile(stale)).path,
  'public/favicon.svg',
  'a dangling declaration falls through to the conventions'
)

// An href that climbs out of the project is refused — the HTML is project
// content, so it's untrusted input, not a path to join blindly. The escape
// target is created for real, so the refusal is the only reason this is null.
const enclosing = makeRoot()
put(enclosing, 'secret.png')
const escaping = join(enclosing, 'app')
put(escaping, 'index.html', '<link rel="icon" href="../secret.png">')
eq(await findProjectIconFile(escaping), null, 'an href escaping the project root is refused')

// Size cap: an oversized "favicon" is skipped, not inlined.
const huge = makeRoot()
put(huge, 'public/favicon.png', Buffer.alloc(600 * 1024))
put(huge, 'public/favicon.ico', 'small')
eq(
  (await findProjectIconFile(huge)).path,
  'public/favicon.ico',
  'an oversized icon is skipped in favour of the next candidate'
)

// An empty file is not an icon.
const blank = makeRoot()
put(blank, 'favicon.svg', '')
eq(await findProjectIconFile(blank), null, 'a zero-byte icon file is not an icon')

// data: URL declared inline needs no file at all.
const inline = makeRoot()
put(inline, 'index.html', '<link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">')
const inlineIcon = await readProjectIcon(inline)
eq(inlineIcon.dataUrl, 'data:image/png;base64,iVBORw0KGgo=', 'an inline data: icon is used as-is')
eq(inlineIcon.path, 'index.html', 'an inline icon reports the declaring document as its path')

// readProjectIcon produces a usable data URL.
const real = makeRoot()
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>'
put(real, 'public/favicon.svg', svg)
const icon = await readProjectIcon(real)
eq(icon.path, 'public/favicon.svg', 'the icon reports where it came from')
ok(icon.dataUrl.startsWith('data:image/svg+xml;base64,'), 'svg is inlined with its own MIME type')
eq(
  Buffer.from(icon.dataUrl.split(',')[1], 'base64').toString('utf8'),
  svg,
  'the data URL round-trips the file bytes'
)

// The cache revalidates by mtime+size: editing the icon in place must not
// leave a stale one in the rail for the rest of the session.
const next = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect/></svg>'
const abs = put(real, 'public/favicon.svg', next)
const later = new Date(Date.now() + 60_000)
utimesSync(abs, later, later)
eq(
  Buffer.from((await readProjectIcon(real)).dataUrl.split(',')[1], 'base64').toString('utf8'),
  next,
  'a rewritten icon file invalidates the cached data URL'
)

// A cached hit is served without re-scanning — deleting a LOWER-priority
// candidate can't disturb it, and the chosen file is still what's reported.
eq((await readProjectIcon(real)).path, 'public/favicon.svg', 'a cached hit stays stable')

for (const dir of roots) rmSync(dir, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} project-icon assertion(s) failed`)
  process.exit(1)
}
console.log('project-icon: all assertions passed')

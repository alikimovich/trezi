import { readFile, stat } from 'fs/promises'
import { dirname, extname, join, posix, resolve, sep } from 'path'
import type { ProjectIcon } from '../shared/api'

/**
 * A project's own favicon, resolved from its source tree so the rail can lead
 * each project with its real icon instead of a generic folder glyph.
 *
 * Deliberately reads the FILES, not the running page. The rail lists every open
 * project, most of which have no dev server up (and a `page-favicon-updated`
 * from the preview would only ever cover the active one), so anything sourced
 * from the live page would leave the rest on the folder fallback. Scanning the
 * checkout works whether or not the project has ever been run.
 *
 * Two halves, as elsewhere in main: the resolution rules below are pure
 * (`iconMediaType`, `parseHtmlIconHrefs`, `iconCandidates`) and unit-test
 * without Electron or a real tree; `readProjectIcon` is the fs-touching wrapper.
 */

/** Cap on an inlined icon. Anything larger is skipped rather than base64'd into
 *  every rail render — real favicons are a few KB; a 3 MB PNG named `icon.png`
 *  is something else. */
const MAX_ICON_BYTES = 512 * 1024

/** Image types worth putting in a 16px slot. SVG leads: it's the modern favicon
 *  and the only one that stays crisp at any DPI. `.ico` is last — Chromium
 *  renders it in an <img>, but a project shipping both has the better asset in
 *  the other file. */
const ICON_MEDIA_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
}

/** The MIME type to inline this file as, or null if it isn't a usable icon. */
export function iconMediaType(file: string): string | null {
  return ICON_MEDIA_TYPES[extname(file).toLowerCase()] ?? null
}

/**
 * The image type a file's bytes actually are, or null for anything else (a text
 * file named `favicon.png`, an empty or truncated download). The extension only
 * nominates a candidate: a non-image never shadows a later real icon, and a PNG
 * saved as `favicon.ico` is inlined as the PNG it is. The native sidebar still
 * decodes what this lets through and keeps its folder when that fails (LKM-372).
 */
export function sniffIconType(bytes: Uint8Array): string | null {
  const at = (offset: number, signature: number[]) =>
    signature.every((byte, i) => bytes[offset + i] === byte)
  const ascii = (offset: number, text: string) =>
    at(
      offset,
      [...text].map((c) => c.charCodeAt(0))
    )
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  // Reserved 0, type 1 (icon), at least one 16-byte directory entry.
  if (at(0, [0, 0, 1, 0]) && (bytes[4] || bytes[5]) && bytes.length >= 22) return 'image/x-icon'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return 'image/avif'
  if (/<svg[\s>/]/i.test(Buffer.from(bytes).toString('utf8'))) return 'image/svg+xml'
  return null
}

/** Directories a favicon conventionally lives in, most-specific first. `src/app`
 *  and `app` lead because Next's app router serves `app/favicon.ico` in
 *  preference to `public/favicon.ico` when a project has both. */
const ICON_DIRS = ['src/app', 'app', 'public', 'static', 'assets', 'www', '']

/** Conventional favicon filenames, best-first within a directory. */
const ICON_NAMES = [
  'favicon.svg',
  'favicon.png',
  'favicon.webp',
  'favicon.ico',
  'icon.svg',
  'icon.png',
  'apple-touch-icon.png'
]

/** HTML entry points to read a declared `<link rel="icon">` out of, in the order
 *  a project is likely to mean them. */
const HTML_ENTRIES = ['index.html', 'public/index.html', 'src/index.html', 'app/index.html']

/** Roots a site-absolute href (`/favicon.png`) can resolve against — the static
 *  dirs a bundler serves from, then the project itself. */
const STATIC_ROOTS = ['public', 'static', '']

/**
 * Every `<link rel="…icon…" href="…">` href in a document, in declaration
 * order, deduped.
 *
 * Regex rather than parse5: this only needs the attributes of one self-closing
 * tag that lives in `<head>`, and staying dependency-free keeps the module in
 * the pure test tier. Matches `rel="icon"`, `shortcut icon`, `apple-touch-icon`
 * and `mask-icon` alike, in either attribute order.
 */
export function parseHtmlIconHrefs(html: string): string[] {
  const hrefs: string[] = []
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (!rel || !/(^|\s)(shortcut\s+)?(icon|apple-touch-icon|mask-icon)(\s|$)/i.test(rel)) continue
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim()
    if (href && !hrefs.includes(href)) hrefs.push(href)
  }
  return hrefs
}

/**
 * Resolve one declared href to a project-relative path, or null when it isn't a
 * local file we can read (an external URL, a fragment). A `data:` URL is
 * returned verbatim — it's already an inlinable icon.
 *
 * `htmlDir` is the declaring document's directory, project-relative ('' at the
 * root): a relative href resolves against it, a site-absolute one against each
 * static root in turn (the caller picks the first that exists).
 */
export function iconHrefCandidates(href: string, htmlDir: string): string[] {
  if (/^data:image\//i.test(href)) return [href]
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return []
  if (href.startsWith('/')) return STATIC_ROOTS.map((r) => posix.join(r, href.slice(1)))
  return [posix.join(htmlDir, href)]
}

/** Conventional locations to probe when no HTML entry declares an icon. */
export function iconCandidates(): string[] {
  return ICON_DIRS.flatMap((dir) => ICON_NAMES.map((name) => posix.join(dir, name)))
}

export interface ProjectIconFile {
  /** Project-relative path the icon came from (posix separators). For an icon
   *  declared inline as a `data:` URL this is the declaring HTML entry. */
  path: string
  /** The icon as a `data:` URL, ready for an <img src>. */
  dataUrl: string
}

/** Is this path still inside `root`? Guards a declared href like
 *  `../../../.ssh/id_rsa.png` — the HTML is project content, so treat it as
 *  untrusted input rather than a path we can join blindly. */
function withinRoot(root: string, rel: string): boolean {
  const abs = resolve(root, rel)
  return abs === resolve(root) || abs.startsWith(resolve(root) + sep)
}

/** Read one candidate if it exists, has an icon extension, is small enough and
 *  its bytes are an image. */
async function readCandidate(root: string, rel: string): Promise<ProjectIconFile | null> {
  if (!iconMediaType(rel) || !withinRoot(root, rel)) return null
  const abs = join(root, rel)
  try {
    const info = await stat(abs)
    if (!info.isFile() || info.size === 0 || info.size > MAX_ICON_BYTES) return null
    const bytes = await readFile(abs)
    const mediaType = sniffIconType(bytes)
    if (!mediaType) return null
    return {
      path: rel,
      dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`
    }
  } catch {
    return null
  }
}

/**
 * Find a project's favicon: a `<link rel="icon">` declared by an HTML entry
 * first (it's what the project itself says its icon is), then the conventional
 * file locations. Null when the project has none.
 */
export async function findProjectIconFile(root: string): Promise<ProjectIconFile | null> {
  for (const entry of HTML_ENTRIES) {
    let html: string
    try {
      const info = await stat(join(root, entry))
      // A multi-megabyte "index.html" is a build artifact, not an entry to lex.
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue
      html = await readFile(join(root, entry), 'utf8')
    } catch {
      continue
    }
    const htmlDir = dirname(entry) === '.' ? '' : dirname(entry)
    for (const href of parseHtmlIconHrefs(html)) {
      for (const rel of iconHrefCandidates(href, htmlDir)) {
        if (rel.startsWith('data:')) {
          if (rel.length > MAX_ICON_BYTES) continue
          return { path: entry, dataUrl: rel }
        }
        const found = await readCandidate(root, rel)
        if (found) return found
      }
    }
    // The entry existed and declared nothing usable — later entries are
    // fallbacks for projects that don't have this one, so keep looking.
  }
  for (const rel of iconCandidates()) {
    const found = await readCandidate(root, rel)
    if (found) return found
  }
  return null
}

/** Cached per project root, revalidated against the source file's mtime+size so
 *  a designer swapping favicon.svg sees it without relaunching. Only a hit is
 *  cached: a miss re-scans (a handful of stats) so a favicon added after the
 *  project was opened still shows up. */
interface CacheEntry {
  icon: ProjectIcon
  path: string
  /** Never null: an entry whose file couldn't be stamped isn't cached at all,
   *  so a vanished file can't compare `null === null` and pin a stale icon. */
  stamp: string
}
const cache = new Map<string, CacheEntry>()

/** mtime+size of the previously chosen file, or null if it's gone. */
async function stampOf(root: string, rel: string): Promise<string | null> {
  try {
    const info = await stat(join(root, rel))
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
}

/**
 * A project's favicon as a data URL, or null when it has none. Never throws —
 * an unreadable project is simply one without an icon.
 *
 * The data URL is small by construction (`MAX_ICON_BYTES`) and the result is
 * cached per root, so the rail can ask for every open project on mount.
 */
export async function readProjectIcon(root: string): Promise<ProjectIcon | null> {
  const hit = cache.get(root)
  if (hit && (await stampOf(root, hit.path)) === hit.stamp) return hit.icon
  const file = await findProjectIconFile(root).catch(() => null)
  if (!file) {
    cache.delete(root)
    return null
  }
  const icon: ProjectIcon = { path: file.path, dataUrl: file.dataUrl }
  const stamp = await stampOf(root, file.path)
  // No stamp → the source went away between reading it and stamping it. Serve
  // what we read, but don't cache something we can't tell has changed.
  if (stamp !== null) cache.set(root, { icon, path: file.path, stamp })
  else cache.delete(root)
  return icon
}

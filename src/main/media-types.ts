import { extname } from 'path'

/**
 * The pure half of the editor's media support: which files are previewable media
 * and how to spot a binary that isn't (the Swift platform owner keeps the same
 * table in `src/service/PlatformMedia.swift`). `parseRange` is the HTTP range
 * parser of the retired `trezi-media` stream, kept with its unit test.
 *
 * Kept dependency-free so it unit-tests on its own.
 */

export type MediaKind = 'image' | 'video' | 'audio'

/**
 * Extensions the editor previews instead of opening as text, and the MIME type
 * to serve them as. Deliberately limited to formats Chromium itself decodes —
 * anything else (`.heic`, `.tiff`, `.psd`) is better off as the binary
 * placeholder than as a broken <img>.
 *
 * `.svg` is NOT here on purpose: it's markup the user edits, so it stays a text
 * file in CodeMirror — the same reason an IDE's source view doesn't swap SVGs
 * for a picture.
 */
const MEDIA: Record<string, { kind: MediaKind; mediaType: string }> = {
  '.png': { kind: 'image', mediaType: 'image/png' },
  '.jpg': { kind: 'image', mediaType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mediaType: 'image/jpeg' },
  '.gif': { kind: 'image', mediaType: 'image/gif' },
  '.webp': { kind: 'image', mediaType: 'image/webp' },
  '.avif': { kind: 'image', mediaType: 'image/avif' },
  '.bmp': { kind: 'image', mediaType: 'image/bmp' },
  '.ico': { kind: 'image', mediaType: 'image/x-icon' },
  '.mp4': { kind: 'video', mediaType: 'video/mp4' },
  '.m4v': { kind: 'video', mediaType: 'video/mp4' },
  '.webm': { kind: 'video', mediaType: 'video/webm' },
  '.ogv': { kind: 'video', mediaType: 'video/ogg' },
  '.mov': { kind: 'video', mediaType: 'video/quicktime' },
  '.mp3': { kind: 'audio', mediaType: 'audio/mpeg' },
  '.m4a': { kind: 'audio', mediaType: 'audio/mp4' },
  '.aac': { kind: 'audio', mediaType: 'audio/aac' },
  '.wav': { kind: 'audio', mediaType: 'audio/wav' },
  '.oga': { kind: 'audio', mediaType: 'audio/ogg' },
  '.ogg': { kind: 'audio', mediaType: 'audio/ogg' },
  '.flac': { kind: 'audio', mediaType: 'audio/flac' }
}

/**
 * The media kind + MIME type for a path, or null if it isn't previewable media.
 * Case-insensitive — real projects ship `arkady.PNG` as happily as `logo.png`.
 */
export function mediaTypeFor(file: string): { kind: MediaKind; mediaType: string } | null {
  return MEDIA[extname(file).toLowerCase()] ?? null
}

/** How much of a utf8-decoded file to sniff for binary-ness. */
const SNIFF = 4096
// Spelled as char codes so no raw control character / U+FFFD lands in this source.
const NUL = String.fromCharCode(0)
const REPLACEMENT = String.fromCharCode(0xfffd)

/**
 * Does this utf8-decoded content look like binary rather than text? A NUL byte
 * settles it; otherwise a burst of U+FFFD (what `readFile(…, 'utf8')` leaves
 * behind for bytes that weren't valid utf8) does. Used to show a placeholder
 * instead of pouring a font/archive's bytes into the editor as mojibake.
 */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, SNIFF)
  if (head.includes(NUL)) return true
  let bad = 0
  for (const ch of head) if (ch === REPLACEMENT) bad++
  return head.length > 0 && bad / head.length > 0.02
}

export type ByteRange = { start: number; end: number }

/**
 * Parse a `Range: bytes=…` request header against a known file size. Returns
 * null for "serve the whole file" (absent, or a form we don't implement such as
 * multi-range), a `[start, end]` inclusive span, or 'unsatisfiable' → 416.
 *
 * <video> seeking depends on this: Chromium probes with a range request and
 * treats a source that ignores it as unseekable.
 */
export function parseRange(
  header: string | null | undefined,
  size: number
): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, from, to] = m
  if (from === '' && to === '') return null
  let start: number
  let end: number
  if (from === '') {
    // Suffix form: "bytes=-500" → the last 500 bytes.
    const n = Number(to)
    if (n <= 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(from)
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable'
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

import { sendableImages, validImage } from '../main/provider-policy'
import type { Attachment } from './chat-state'

/** What `agent:send` gets for one submission (LKM-166). */
export interface AttachmentPlan {
  /** The agent-visible lines: attached files, on-disk images and anything left out. */
  header: string
  /** Only images the provider takes, within its limits. */
  images: { mediaType: string; data: string }[]
  /** The chat's own statement when the provider cannot take images at all (LKM-390). */
  notice: string
}

type Save = (attachment: Attachment) => Promise<string>

const NO_IMAGE_INPUT = 'this provider cannot take images'
const isImage = (a: Attachment) => a.type.startsWith('image/')
const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 120)

/**
 * Decides how each attachment reaches the agent. An attachment never fails the turn:
 *  - an image the provider takes (png/jpeg/gif/webp within limits) is sent as an image and
 *    listed with its path on disk;
 *  - any other image (SVG, HEIC, TIFF, or one over the limits) keeps its original on disk,
 *    listed by path, and is represented by the PNG `preview` the composer rasterized;
 *  - any other file is referenced by its path;
 *  - whatever cannot be attached, and an image with no picture to send, is named in a
 *    "[Not attached: …]" line.
 * The header calls an image part of the message only when it is in `images`: one left out
 * by the limits, or by a provider without image input (`takesImages` false), stays a file
 * listed by path. The composer already downscales oversized rasters; the checks here are
 * the backstop.
 */
export async function planAttachments(
  attachments: readonly Attachment[],
  save: Save,
  takesImages = true
): Promise<AttachmentPlan> {
  const entries = await Promise.all(attachments.map((a) => describe(a, save)))
  const wanted = takesImages ? entries.flatMap((e) => (e.inline ? [e.inline] : [])) : []
  const { kept } = sendableImages(wanted)
  const left = entries.filter((e) => e.inline && !kept.includes(e.inline))
  for (const entry of left) {
    entry.kind = 'file'
    entry.line = entry.path
    entry.missed = `${entry.inline?.name} (${takesImages ? 'too many or too large to send as an image' : NO_IMAGE_INPUT})`
  }
  const missed = entries.flatMap((e) => (e.missed ? [e.missed] : []))
  const list = (kind: Entry['kind']) =>
    entries.flatMap((e) => (e.kind === kind && e.line ? [e.line] : [])).join('\n')
  const files = list('file')
  const images = list('image')
  const refused = takesImages ? [] : attachments.filter(isImage).map((a) => a.name)
  return {
    header:
      (files ? `[Attached files]\n${files}\n\n` : '') +
      (images
        ? `[Attached images — the image(s) in this message are on disk at]\n${images}\n\n`
        : '') +
      (missed.length ? `[Not attached: ${missed.join('; ')}]\n\n` : ''),
    images: kept.map(({ mediaType, data }) => ({ mediaType, data })),
    notice: refused.length ? `Not sent as images: ${refused.join(', ')} (${NO_IMAGE_INPUT})` : ''
  }
}

interface Entry {
  kind: 'file' | 'image'
  /** The path line the agent reads. */
  line?: string
  path?: string
  inline?: { mediaType: string; data: string; name: string }
  missed?: string
}

async function describe(a: Attachment, save: Save): Promise<Entry> {
  let path = a.path
  let failure = ''
  if (!path && isImage(a) && a.data) {
    try {
      path = await save(a)
    } catch (error) {
      failure = reason(error)
    }
    if (!path && !failure) failure = 'the copy could not be written'
  }
  if (isImage(a) && validImage(a.type, a.data))
    return {
      kind: 'image',
      ...(path ? { line: path, path } : {}),
      inline: { mediaType: a.type, data: a.data, name: a.name }
    }
  if (isImage(a) && a.preview && validImage('image/png', a.preview))
    return {
      kind: 'file',
      ...(path
        ? { line: `${path} (${a.type}; a PNG preview of it is attached as an image)`, path }
        : {}),
      inline: { mediaType: 'image/png', data: a.preview, name: a.name },
      ...(path
        ? {}
        : { missed: `${a.name} (the original could not be saved; only its preview is attached)` })
    }
  if (path)
    return {
      kind: 'file',
      line: path,
      ...(isImage(a) ? { missed: `${a.name} (unsupported or too large to send as an image)` } : {})
    }
  return {
    kind: 'file',
    missed: `${a.name} (${failure ? `could not be saved: ${failure}` : 'the agent cannot read it'})`
  }
}

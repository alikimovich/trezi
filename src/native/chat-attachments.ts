import { sendableImages, validImage } from '../main/provider-policy'
import type { Attachment } from './chat-state'

/** What `agent:send` gets for one submission (LKM-166). */
export interface AttachmentPlan {
  /** The agent-visible lines: attached files, on-disk images and anything left out. */
  header: string
  /** Only images the provider takes, within its limits. */
  images: { mediaType: string; data: string }[]
}

type Save = (attachment: Attachment) => Promise<string>

const isImage = (a: Attachment) => a.type.startsWith('image/')
const reason = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 120)

/**
 * Decides how each attachment reaches the agent. An attachment never fails the turn:
 *  - an image the provider takes (png/jpeg/gif/webp within limits) is sent as an image and
 *    listed with its path on disk;
 *  - any other image (SVG, HEIC, TIFF, or one over the limits) keeps its original on disk,
 *    listed by path, and is represented by the PNG `preview` the composer rasterized;
 *  - any other file is referenced by its path;
 *  - whatever cannot be attached is named in a "[Not attached: …]" line.
 * The composer already downscales oversized rasters; the checks here are the backstop.
 */
export async function planAttachments(
  attachments: readonly Attachment[],
  save: Save
): Promise<AttachmentPlan> {
  const entries = await Promise.all(attachments.map((a) => describe(a, save)))
  const wanted = entries.flatMap((e) => (e.inline ? [e.inline] : []))
  const { kept } = sendableImages(wanted)
  const missed = entries.flatMap((e) => (e.missed ? [e.missed] : []))
  for (const image of wanted)
    if (!kept.includes(image))
      missed.push(`${image.name} (too many or too large to send as an image)`)
  const list = (kind: Entry['kind']) =>
    entries.flatMap((e) => (e.kind === kind && e.line ? [e.line] : [])).join('\n')
  const files = list('file')
  const images = list('image')
  return {
    header:
      (files ? `[Attached files]\n${files}\n\n` : '') +
      (images
        ? `[Attached images — the image(s) in this message are on disk at]\n${images}\n\n`
        : '') +
      (missed.length ? `[Not attached: ${missed.join('; ')}]\n\n` : ''),
    images: kept.map(({ mediaType, data }) => ({ mediaType, data }))
  }
}

interface Entry {
  kind: 'file' | 'image'
  /** The path line the agent reads. */
  line?: string
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
      ...(path ? { line: path } : {}),
      inline: { mediaType: a.type, data: a.data, name: a.name }
    }
  if (isImage(a) && a.preview && validImage('image/png', a.preview))
    return {
      kind: 'file',
      ...(path ? { line: `${path} (${a.type}; a PNG preview of it is attached as an image)` } : {}),
      inline: { mediaType: 'image/png', data: a.preview, name: a.name },
      ...(path
        ? {}
        : { missed: `${a.name} (the original could not be saved; only its preview is attached)` })
    }
  if (path) return { kind: 'file', line: path }
  return {
    kind: 'file',
    missed: `${a.name} (${failure ? `could not be saved: ${failure}` : 'the agent cannot read it'})`
  }
}

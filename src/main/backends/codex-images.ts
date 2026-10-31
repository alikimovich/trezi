import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Input } from '@openai/codex-sdk'
import type { ImageAttachment } from '../../shared/api'

/**
 * LKM-390: composer images for Codex. The CLI takes an image only as a file (`--image`,
 * the SDK's `local_image`) and the helper gets only `{mediaType, data}`, so each turn
 * writes private copies that live as long as that turn. They are synchronous so a turn
 * has no await between its start and its abort controller, where Stop would be lost.
 */

const PREFIX = 'trezi-codex-images-'
/** A helper killed mid-turn leaves its copies; nothing runs this long. */
const STALE_MS = 24 * 60 * 60 * 1000
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}
const IMAGE_ONLY_PROMPT = 'See the attached image(s).'

export interface ImageDelivery {
  paths: string[]
  /** The prompt's prefix and the chat's status when the copies could not be written. */
  note: string
  status: string
  remove(): void
}

const remove = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A sweep of a later turn gets it.
  }
}

function sweepStale(parent: string): void {
  try {
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(PREFIX)) continue
      const dir = join(parent, name)
      if (Date.now() - statSync(dir).mtimeMs > STALE_MS) remove(dir)
    }
  } catch {
    // Best effort: the copies stay private to this user either way.
  }
}

/** One turn's copies. Never throws: a turn is not failed for an attachment. */
export function deliverImages(images: readonly ImageAttachment[] | undefined): ImageDelivery {
  if (!images?.length) return { paths: [], note: '', status: '', remove() {} }
  let dir = ''
  try {
    const parent = tmpdir()
    sweepStale(parent)
    dir = mkdtempSync(join(parent, PREFIX))
    const created = dir
    const paths = images.map((image, index) => {
      const path = join(created, `image-${index + 1}.${EXTENSIONS[image.mediaType] ?? 'png'}`)
      writeFileSync(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
      return path
    })
    return { paths, note: '', status: '', remove: () => remove(created) }
  } catch {
    if (dir) remove(dir)
    const count = images.length
    return {
      paths: [],
      note: `[Not attached: ${count} image(s) could not be prepared for Codex; any paths listed are on disk, but the image(s) are not in this message]\n\n`,
      status: `${count} image(s) could not be prepared for Codex and were not sent`,
      remove() {}
    }
  }
}

/** The SDK's input for one run: the plain prompt, or the prompt and its image files. */
export function codexInput(prompt: string, paths: readonly string[]): Input {
  if (!paths.length) return prompt
  return [
    { type: 'text', text: prompt || IMAGE_ONLY_PROMPT },
    ...paths.map((path) => ({ type: 'local_image' as const, path }))
  ]
}

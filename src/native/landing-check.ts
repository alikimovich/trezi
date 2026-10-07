import { capturePreview, getPreviewUrl, previewAgentHost } from '../main/preview-state'
import { environmentChanges } from '../shared/environment-changes'
import type { NativeLandingCheck } from '../shared/native-chat'
import type { NativeChatMirror } from '../shared/native-chat-controller'

/**
 * LKM-195: a turn's edits reach the preview only when Trezi lands them, after the agent
 * has finished, so the agent cannot look at them itself. Trezi checks instead: once the
 * landed files had time to reload, it reads the preview's console and page errors logged
 * since the landing and captures the page, and posts the result as one compact chat row.
 * Nothing stays "pending". It never starts a turn; page text is shown, never sent.
 */
export interface LandingCheckHost {
  /** The project's running dev-server URL, or null. */
  server: (root: string) => string | null
  /** The URL the preview shows now, or null. */
  url: () => string | null
  /** Console errors and page errors in the page's buffer; null before it is ready. */
  errors: () => Promise<{ text: string; at: number }[] | null>
  /** A JPEG of the preview's current frame (base64), or null. */
  capture: () => Promise<string | null>
  wait: (ms: number) => Promise<void>
  now: () => number
}

export const LANDING_CHECK = {
  /** Hot reload time before the first look. */
  settleMs: 2500,
  /** How long the preview may take to show the project; longer after an environment restart. */
  readyMs: 10_000,
  restartReadyMs: 120_000,
  pollMs: 500,
  /** Errors listed in the row; the line still counts all of them. */
  shownErrors: 3,
  errorChars: 200,
  /** A larger capture is left out rather than carried in every chat frame. */
  thumbnailBytes: 256 * 1024
}

const origin = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One check of `root`'s preview for a landing at `landedAt`; null when cancelled. */
export async function checkAfterLanding(
  root: string,
  landedAt: number,
  host: LandingCheckHost,
  options: { restart?: boolean; cancelled?: () => boolean } = {},
  timing = LANDING_CHECK
): Promise<NativeLandingCheck | null> {
  const cancelled = options.cancelled ?? (() => false)
  await host.wait(timing.settleMs)
  const deadline = host.now() + (options.restart ? timing.restartReadyMs : timing.readyMs)
  let reason = 'the preview is not running'
  let entries: { text: string; at: number }[] | null = null
  for (;;) {
    if (cancelled()) return null
    const server = host.server(root)
    const shown = host.url()
    if (!server) reason = 'the preview is not running'
    else if (!shown) reason = 'the preview did not load'
    else if (origin(shown) !== origin(server)) reason = 'the preview is showing another project'
    else {
      entries = await host.errors().catch(() => null)
      if (entries) break
      reason = 'the preview did not finish loading'
    }
    if (host.now() >= deadline) break
    await host.wait(timing.pollMs)
  }
  if (cancelled()) return null
  if (!entries)
    return { status: 'unchecked', line: `Not checked after landing: ${reason}`, errors: [] }
  const jpeg = await host.capture().catch(() => null)
  const thumbnail =
    jpeg && jpeg.length * 0.75 <= timing.thumbnailBytes
      ? `data:image/jpeg;base64,${jpeg}`
      : undefined
  const errors = entries
    .filter((entry) => entry.at >= landedAt)
    .map((entry) => entry.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return {
    status: errors.length ? 'errors' : 'clean',
    line: `Checked after landing: ${errors.length ? plural(errors.length, 'console error') : 'no console errors'}`,
    errors: errors
      .slice(0, timing.shownErrors)
      .map((text) =>
        text.length > timing.errorChars ? `${text.slice(0, timing.errorChars - 1)}…` : text
      ),
    ...(thumbnail ? { thumbnail } : {})
  }
}

/** The row: plain text for Copy, the check for the host's compact rendering. */
export function landingCheckMessage(
  check: NativeLandingCheck,
  at: number
): NativeChatMirror['messages'][number] {
  const text = [check.line, ...check.errors].join('\n')
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    at,
    text,
    statuses: [],
    segments: [{ kind: 'text', text }],
    landingCheck: check
  }
}

/** One check per chat at a time: a newer landing replaces the one still waiting. */
export class LandingChecks {
  private generations = new Map<string, number>()
  constructor(
    private readonly host: LandingCheckHost,
    /** Posts the row into the chat after message `afterId` (the landed turn's last). */
    private readonly post: (key: string, check: NativeLandingCheck, afterId?: string) => void,
    private readonly timing = LANDING_CHECK
  ) {}

  /** A turn of chat `key` just landed `files` into `root`. */
  async landed(key: string, root: string, files: string[], afterId?: string) {
    if (!files.length || !root) return
    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)
    const check = await checkAfterLanding(
      root,
      this.host.now(),
      this.host,
      {
        restart: environmentChanges(files).restart,
        cancelled: () => this.generations.get(key) !== generation
      },
      this.timing
    )
    if (check) this.post(key, check, afterId)
  }

  cancel(key: string) {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
  }
}

/** The live preview through the agent tools' registry (`src/main/preview-state.ts`). */
export function previewLandingHost(server: (root: string) => string | null): LandingCheckHost {
  return {
    server,
    url: getPreviewUrl,
    errors: async () => {
      const host = previewAgentHost()
      if (!host) return null
      const read = (await host.evaluate(
        'globalThis.__treziAgentConsole?.read({ errorsOnly: true, limit: 50 }) ?? null',
        'preview',
        8000
      )) as { entries?: { text: string; at: number }[] } | null
      return Array.isArray(read?.entries) ? read.entries : null
    },
    capture: async () => {
      const image = await capturePreview()
      if (!image || image.isEmpty()) return null
      return image.toJPEG(70).toString('base64') || null
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now
  }
}

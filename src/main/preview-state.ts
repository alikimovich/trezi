import type { AgentCaptureReply, NativeImage } from '../native/platform'
import { notePhase, phase } from './tool-timing'

/**
 * A tiny registry that lets any main-process module read the live preview's
 * state without importing `index.ts` (which owns the `NativeView`) — that
 * would be a cycle, since `index.ts` already pulls in the agent/backends. The
 * preview owner registers a source once (see `registerPreviewIpc` in
 * `index.ts`); the shared Claude/Codex preview observation tools read it.
 *
 * Both accessors are null/absent-safe: before a source registers (or when no
 * preview is open) they report "nothing to see" rather than throwing.
 */
export interface PreviewSource {
  /** The preview's current URL, or null when no real web preview is showing. */
  getUrl: () => string | null
  /** A capture of the preview's current frame, or null when unavailable. */
  capture: () => Promise<NativeImage | null>
  /** The agent's bounded JPEG of the current frame (LKM-200); `capture` serves sources without it. */
  captureAgent?: (options: { full?: boolean }) => Promise<AgentCaptureReply | null>
  /** The agent inspection host (LKM-138); absent before the native preview registers. */
  agent?: PreviewAgentHost
}

/** The agent's preview frame: the longest side at most `maxPixels` unless full (LKM-200). */
export const AGENT_CAPTURE = { maxPixels: 1280, quality: 0.8 } as const

/** A frame for the agent: JPEG bytes and pixel size. */
export interface AgentCapture {
  jpeg: Buffer
  width: number
  height: number
}

/** CSS-pixel rectangle in the preview viewport. */
export interface PreviewRect {
  x: number
  y: number
  width: number
  height: number
}

/** What `src/main/preview-agent-tools.ts` needs from the native preview. */
export interface PreviewAgentHost {
  /** Run `code` in the TreziPreview world (`preview`) or the handler-less TreziAgent world (`agent`). */
  evaluate: (code: string, world: 'preview' | 'agent', timeoutMs: number) => Promise<unknown>
  /** Snapshot of `rect` (CSS px), clipped to the visible viewport. */
  captureRect: (rect: PreviewRect) => Promise<NativeImage | null>
  /** Lay the page out at `width` CSS px (null restores the normal layout). */
  setViewport: (width: number | null) => Promise<{ width: number | null; zoom: number }>
}

let source: PreviewSource | null = null

/** The registered agent host, or null when no native preview is registered. */
export function previewAgentHost(): PreviewAgentHost | null {
  return source?.agent ?? null
}

export function registerPreviewSource(src: PreviewSource): void {
  source = src
}

/** The preview's current URL, or null when nothing usable is showing. */
export function getPreviewUrl(): string | null {
  try {
    return source?.getUrl() ?? null
  } catch {
    return null
  }
}

/** Capture the preview's current frame, or null on absence/error. */
export async function capturePreview(): Promise<NativeImage | null> {
  if (!source) return null
  try {
    return await source.capture()
  } catch {
    return null
  }
}

/**
 * LKM-200: the frame the agent sees, rendered by WebKit at its sent size (at most
 * `AGENT_CAPTURE.maxPixels` on the longest side unless `full`) and encoded once as JPEG.
 * The tool call's phases get the host's snapshot and encode times and the transfer.
 */
export async function capturePreviewForAgent(full = false): Promise<AgentCapture | null> {
  const src = source
  if (!src) return null
  try {
    if (!src.captureAgent) {
      const image = await phase('capture', () => src.capture())
      if (!image || image.isEmpty()) return null
      const { width, height } = image.getSize()
      const longest = Math.max(width, height)
      const fitted =
        full || longest <= AGENT_CAPTURE.maxPixels
          ? image
          : image.resize({ width: Math.round((width * AGENT_CAPTURE.maxPixels) / longest) })
      return phase('encode', async () => ({
        jpeg: fitted.toJPEG(AGENT_CAPTURE.quality * 100),
        ...fitted.getSize()
      }))
    }
    const at = performance.now()
    const reply = await src.captureAgent(full ? { full } : {})
    const total = performance.now() - at
    if (!reply?.jpeg) return null
    const host = (reply.snapshotMs ?? 0) + (reply.encodeMs ?? 0)
    notePhase('snapshot', reply.snapshotMs)
    notePhase('encode', reply.encodeMs)
    notePhase('transfer', Math.max(0, total - host))
    return { jpeg: Buffer.from(reply.jpeg, 'base64'), width: reply.width, height: reply.height }
  } catch {
    return null
  }
}

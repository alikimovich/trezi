import type { ImageAttachment, RunningSimulator, SimElementPick, SimPreflight } from '../shared/api'

/** A server listening from a project folder (the "Running servers" recovery sheet).
 *  `identity` is the pid and kernel start time, which a stop must repeat unchanged. */
export interface PreviewProcess {
  pid: number
  root: string
  command: string
  started: string
  addresses: string[]
  identity?: string
}

/**
 * The platform owner seam (S14). The service's platform owner performs the OS
 * services Bun used to run itself:
 * - the iOS Simulator preview: preflight, boot, the app's launch command as a
 *   supervised process group, the loopback bridge, idb input and element picks, stop;
 * - scoped media grants for the native source editor (view-bound, expiring, hashed);
 * - pasted composer images (uploaded in bounded chunks, hash-checked, written by it);
 * - the "Running servers" recovery sheet's inspection and SIGTERM;
 * - opening links, files and "Open in editor" (LKM-102).
 * There is no other owner (LKM-111 removed the TS twins).
 */

export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export interface MediaGrant {
  token: string
  url: string
  kind: string
  mediaType: string
  bytes: number
  sha256: string
  /** Milliseconds since the epoch; resolving extends it. */
  expires: number
}

export interface PlatformStatus {
  simulator: { running: boolean; starting: boolean; selectMode: boolean; streams: number }
  grants: number
  uploads: number
}

export interface PlatformOwner {
  readonly kind: 'swift'
  simulatorPreflight(): Promise<SimPreflight>
  simulatorStart(opts: { root: string; command?: string; udid?: string }): Promise<RunningSimulator>
  simulatorStop(): Promise<void>
  simulatorSelect(active: boolean): Promise<void>
  onSimulatorLog(listener: (line: string) => void): void
  onSimulatorPick(listener: (pick: SimElementPick) => void): void
  /** A media URL for the source editor, bound to that view, the file's size and hash. */
  grantMedia(root: string, file: string): Promise<MediaGrant>
  /** The granted file's path for the native editor; an expired or changed grant is issued again. */
  mediaPath(url: string, root: string, file: string): Promise<string | undefined>
  /** A pasted image's saved path, or '' when it could not be saved (the legacy contract). */
  saveAttachment(image: ImageAttachment, name?: string): Promise<string>
  findServers(root: string): Promise<PreviewProcess[]>
  stopServer(server: PreviewProcess): Promise<void>
  status(): Promise<PlatformStatus>
  /** An http(s) link in the default browser; rejects anything else. */
  openLink(url: string): Promise<void>
  /** An existing absolute path with its default app: '' on success, else the failure text. */
  openFile(path: string): Promise<string>
  /** "Open in editor": a file inside `root` at a line, with the first editor CLI that works. */
  openInEditor(
    root: string,
    file: string,
    line: number,
    column?: number
  ): Promise<{ ok: boolean; error?: string }>
}

let owner: PlatformOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setPlatformOwner(next: PlatformOwner | null): void {
  owner = next
}

export function platformOwner(): PlatformOwner {
  if (!owner)
    throw new Error('Trezi’s service is not running, so this system action is unavailable.')
  return owner
}

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatus } from '../shared/api'
import type { NativeSheetController } from './sheets-runtime'

/** Match the built application and its service to the source we just updated. */
export function verifyUpdatedArtifact(root: string): string | null {
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const sha = git.status === 0 ? git.stdout.trim() : ''
  if (!/^[0-9a-f]{40}$/.test(sha)) return 'Could not prove the updated source revision.'
  const count = spawnSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' })
  const build = count.status === 0 ? count.stdout.trim() : ''
  if (!/^\d+$/.test(build)) return 'Could not prove the updated build number.'
  let version: string
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch {
    return 'Could not read the updated source version.'
  }
  const contents = join(root, 'out/native/Trezi.app/Contents')
  for (const path of [
    join(contents, 'Info.plist'),
    join(contents, 'XPCServices/dev.trezi.service.xpc/Contents/Info.plist')
  ]) {
    let plist: string
    try {
      plist = readFileSync(path, 'utf8')
    } catch {
      return 'The updated Trezi application is missing.'
    }
    if (
      !plist.includes(`<key>CFBundleShortVersionString</key><string>${version}</string>`) ||
      !plist.includes(`<key>CFBundleVersion</key><string>${build}</string>`) ||
      !plist.includes(`<key>TreziCommit</key><string>${sha.slice(0, 7)}</string>`)
    )
      return 'The built application does not match the updated version and commit.'
  }
  if (
    !existsSync(join(contents, 'MacOS/TreziHost')) ||
    !existsSync(join(contents, 'XPCServices/dev.trezi.service.xpc/Contents/MacOS/TreziService'))
  )
    return 'The updated application is incomplete.'
  return null
}

/** The workflow owner's update calls (`WorkflowOwner`, S13). */
export interface UpdateOwner {
  updateCheck(root: string): Promise<UpdateStatus>
  update(root: string, progress?: (text: string) => void): Promise<{ ok: boolean; error?: string }>
}

/**
 * Update the current tracked checkout; never discard work or switch branches. The
 * pull, install and build are the workflow owner's journaled workflow (a retry after a
 * failed install or build does not pull again, and a checkout with local changes is
 * refused there); the restart is the service's (`serviceRestart`).
 */
export class NativeUpdateController {
  private inFlight = false
  constructor(
    readonly sheets: NativeSheetController,
    readonly root: string,
    readonly restart: () => void | Promise<void>,
    readonly owner: UpdateOwner,
    readonly canRestart: () => string | null = () => null,
    readonly verifyArtifact: (root: string) => string | null = verifyUpdatedArtifact
  ) {}
  open(knownAvailable = false) {
    if (this.inFlight) return
    if (knownAvailable) {
      this.available()
      return
    }
    this.sheets.present(
      {
        title: 'Trezi updates',
        detail: 'Check for updates to this installation of Trezi.',
        fields: [],
        actions: [
          { id: 'cancel', label: 'Close' },
          { id: 'check', label: 'Check for updates', primary: true }
        ]
      },
      async () => {
        if (this.inFlight) return
        this.inFlight = true
        this.sheets.present(
          {
            title: 'Checking for updates',
            detail: 'Checking this Trezi installation…',
            fields: [],
            actions: []
          },
          async () => {}
        )
        const checking = this.sheets.generation
        try {
          const status = await this.owner.updateCheck(this.root)
          if (checking !== this.sheets.generation) return
          this.inFlight = false
          if (status.status === 'available') this.available(status)
          else if (status.status === 'error')
            this.failure(status.error || 'Could not check for updates.', () => this.open())
          else
            this.sheets.present(
              {
                title: 'No update found',
                detail:
                  'No update was found for this installation. If you are offline, reconnect and check again.',
                fields: [],
                actions: [{ id: 'cancel', label: 'Close' }]
              },
              async () => {}
            )
        } catch (error) {
          if (checking === this.sheets.generation)
            this.failure(error instanceof Error ? error.message : String(error), () => this.open())
        } finally {
          this.inFlight = false
        }
      }
    )
  }
  /** A build badge already compared with main; no second check is needed. */
  available(status?: UpdateStatus) {
    if (this.inFlight) return
    this.sheets.present(
      {
        title: 'Trezi update available',
        detail: status?.behind
          ? `${status.behind} new ${status.behind === 1 ? 'change' : 'changes'} available. Trezi will restart when the update is ready.`
          : 'A newer Trezi is available. Trezi will restart when the update is ready.',
        fields: [],
        actions: [
          { id: 'cancel', label: 'Not Now' },
          { id: 'apply', label: 'Update', primary: true }
        ]
      },
      async (action) => {
        if (action.action === 'apply') await this.apply()
      }
    )
  }
  private failure(message: string, retry: () => void | Promise<void> = () => this.apply()) {
    this.sheets.present(
      {
        title: 'Update could not finish',
        detail: message,
        fields: [],
        actions: [
          { id: 'cancel', label: 'Close' },
          { id: 'retry', label: 'Retry', primary: true }
        ]
      },
      async (action) => {
        if (action.action === 'retry') await retry()
      }
    )
  }
  private progress(text: string) {
    const current = this.sheets.current
    if (current?.state.title === 'Updating Trezi') {
      current.state.message = text
      this.sheets.host.send('sheetState', { state: current.state })
    }
  }
  async apply() {
    if (this.inFlight) return
    this.inFlight = true
    const blocked = this.canRestart()
    if (blocked) {
      this.inFlight = false
      this.failure(blocked)
      return
    }
    this.sheets.present(
      {
        title: 'Updating Trezi',
        detail: 'Downloading changes and rebuilding Trezi. The app will restart when ready.',
        fields: [],
        actions: []
      },
      async () => {}
    )
    const current = this.sheets.current!
    current.state.busy = true
    this.sheets.host.send('sheetState', { state: current.state })
    try {
      const result = await this.owner.update(this.root, (text) => this.progress(text))
      if (!result.ok) throw new Error(result.error ?? 'The update could not finish.')
      const artifactError = this.verifyArtifact(this.root)
      if (artifactError) throw new Error(artifactError)
      const restartBlocked = this.canRestart()
      if (restartBlocked) throw new Error(restartBlocked)
      await this.restart()
    } catch (error) {
      this.failure(error instanceof Error ? error.message : String(error))
    } finally {
      this.inFlight = false
    }
  }
}

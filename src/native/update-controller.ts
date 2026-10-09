import type { UpdateStatus } from '../shared/api'
import type { NativeSheetController } from './sheets-runtime'

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
  constructor(
    readonly sheets: NativeSheetController,
    readonly root: string,
    readonly restart: () => void | Promise<void>,
    readonly owner: UpdateOwner,
    readonly canRestart: () => string | null = () => null
  ) {}
  async open() {
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
        const generation = this.sheets.generation
        const status = await this.owner.updateCheck(this.root)
        if (generation !== this.sheets.generation) return
        this.sheets.present(
          {
            title: 'Trezi updates',
            detail:
              status.status === 'available'
                ? `${status.behind} new ${status.behind === 1 ? 'change' : 'changes'} available. Trezi will restart after updating.${status.subject ? '\n\nLatest change: ' + status.subject : ''}`
                : 'No updates found. If you are offline, reconnect and check again.',
            fields: [],
            actions: [
              { id: 'cancel', label: 'Close' },
              ...(status.status === 'available'
                ? [{ id: 'apply', label: 'Update and restart', primary: true }]
                : [])
            ]
          },
          async () => this.apply()
        )
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
    const blocked = this.canRestart()
    if (blocked) throw new Error(blocked)
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
      const restartBlocked = this.canRestart()
      if (restartBlocked) throw new Error(restartBlocked)
      await this.restart()
    } catch (error) {
      this.sheets.present(
        {
          title: 'Update could not finish',
          detail: error instanceof Error ? error.message : String(error),
          fields: [],
          actions: [
            { id: 'cancel', label: 'Close' },
            { id: 'retry', label: 'Retry', primary: true }
          ]
        },
        async () => this.apply()
      )
    }
  }
}

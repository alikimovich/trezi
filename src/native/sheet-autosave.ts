/** Coalesce typing and serialize writes; closing/navigation awaits the latest draft. */
export class SheetAutosave {
  private pending: Record<string, string> | null = null
  private running: Promise<boolean> | null = null
  private saved: string
  private draft: Record<string, string>
  constructor(
    initial: Record<string, string>,
    readonly save: (values: Record<string, string>) => Promise<void>,
    readonly report: (message: string) => void
  ) {
    this.draft = { ...initial }
    this.saved = JSON.stringify(initial)
  }
  enqueue(values: Record<string, string>): Promise<boolean> {
    this.draft = { ...this.draft, ...values }
    this.pending = { ...this.draft }
    if (!this.running)
      this.running = this.drain().finally(() => {
        this.running = null
      })
    return this.running
  }
  private async drain() {
    let ok = true
    while (this.pending) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const values = this.pending
      this.pending = null
      const snapshot = JSON.stringify(values)
      if (snapshot === this.saved) {
        ok = true
        continue
      }
      this.report('Saving…')
      try {
        await this.save(values)
        this.saved = snapshot
        ok = true
        this.report('Saved automatically.')
      } catch (error) {
        ok = false
        this.report(
          `Could not save: ${error instanceof Error ? error.message : String(error)}. Your draft is still here. Edit it or try closing again to retry.`
        )
      }
    }
    return ok
  }
}

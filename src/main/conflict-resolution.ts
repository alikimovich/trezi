import type { SessionTranscriptEntry } from '../shared/api'
import type { ProviderSession } from './backends/types'
import type { TurnTerminalOutcome } from './turn-terminal'

type Preparation = { cancelled: boolean }
interface ReconciliationDeps {
  running: Set<string>
  preparations: Map<string, Preparation>
  currentSession: (key: string) => ProviderSession | undefined
  begin: (key: string) => void
  land: (
    key: string,
    message: string,
    transcript: SessionTranscriptEntry[],
    terminal: TurnTerminalOutcome,
    reconcile: boolean
  ) => Promise<string[] | null>
  showParked: (key: string) => void
  // The conversation owner's transitions (S11). Absent in unit tests of the policy alone.
  /** landing → running for the continuation run; false when the owner refuses it. */
  continued?: (key: string, turn: string, run: number) => Promise<boolean>
  /** landing → idle; answers the `completedAt` the owner stamped. */
  landed?: (key: string, turn: string) => Promise<number | undefined>
  /** Hands the continuation prompt to the provider as run `run` of the turn. */
  dispatch?: (session: ProviderSession, prompt: string, turn: string, run: number) => void
}

/** Owns one automatic continuation per user turn, independent of active UI chat. */
export class ReconciliationCoordinator {
  private resolving = new Set<string>()
  constructor(private deps: ReconciliationDeps) {}

  begin(key: string): void {
    this.resolving.delete(key)
  }

  async finish(
    key: string,
    message: string,
    terminal: TurnTerminalOutcome,
    turn?: string,
    run = 0
  ): Promise<void> {
    const d = this.deps
    const session = d.currentSession(key)
    const wasResolving = this.resolving.delete(key)
    const preparation = d.preparations.get(key) ?? { cancelled: false }
    d.preparations.set(key, preparation)
    d.running.add(key)
    const current = (): boolean =>
      d.preparations.get(key) === preparation && d.currentSession(key) === session
    const finish = async (): Promise<void> => {
      if (!current()) return
      this.resolving.delete(key)
      d.showParked(key)
      const completedAt =
        turn && d.landed ? await d.landed(key, turn).catch(() => undefined) : undefined
      if (!current()) return
      d.running.delete(key)
      d.preparations.delete(key)
      const entry = [...(session?.record.transcript ?? [])]
        .reverse()
        .find((entry) => entry.role === 'user')
      if (entry && entry.completedAt == null) entry.completedAt = completedAt ?? Date.now()
      session?.emit({ type: 'landing-finished', ...(turn ? { turn } : {}) })
    }
    try {
      const files = await d.land(
        key,
        message,
        session?.record.transcript ?? [],
        preparation.cancelled ? 'failed' : terminal,
        !wasResolving
      )
      if (!current()) return
      const next = run + 1
      if (
        files?.length &&
        session &&
        !preparation.cancelled &&
        (!turn || !d.continued || (await d.continued(key, turn, next)))
      ) {
        if (!current()) return
        this.resolving.add(key)
        d.begin(key)
        session.emit({ type: 'reconciliation-started', ...(turn ? { turn } : {}) })
        const prompt = conflictResolutionPrompt(files)
        if (turn && d.dispatch) d.dispatch(session, prompt, turn, next)
        else session.send(prompt)
      } else await finish()
    } catch {
      await finish()
    }
  }
}

/** Shared by automatic reconciliation and the explicit retry action. */
export function conflictResolutionPrompt(files: string[]): string {
  return (
    `The changes from this chat overlapped with recent project edits. Trezi combined ` +
    `both versions in your private worktree and marked overlapping spots with conflict markers ` +
    `(\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) in: ${files.join(', ')}. ` +
    `Open each file, reconcile both sides while preserving the recent edits AND the change ` +
    `this chat was making, and remove every conflict marker. A side labelled "(deleted)" ` +
    `removed the file: keep the combined content, or delete the file if that is the intent. Use the conversation to infer ` +
    `intent. Do not discard either side wholesale. Verify the combined result with relevant ` +
    `checks, then briefly say what you reconciled. If the intent is genuinely incompatible, ` +
    `leave the unresolved markers and explain the decision needed. Do not edit the live ` +
    `checkout or bypass Trezi's landing mechanism.`
  )
}

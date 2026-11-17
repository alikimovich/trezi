import { randomUUID } from 'node:crypto'
import type { AgentEvent, ImageAttachment, SteerReason, SteerState } from '../../shared/api'

/**
 * LKM-709: steering for the Claude adapter, through the Agent SDK's streaming input.
 *
 * A steer is one user message pushed while a turn runs, stamped with a fresh `uuid` and
 * `priority: 'next'`: the CLI folds such a message into the running turn between tool
 * rounds and from then on names it in the turn's `user_message_uuids` (on its reply
 * frames and its `result`). That echo is the admission: nothing is reported as steered
 * before the CLI says it took it.
 *
 * A turn that ends without folding it leaves the message in the CLI's queue, where the
 * CLI runs it next on its own. Trezi first asks the CLI to withdraw it
 * (`cancel_async_message`, the SDK's `cancelAsyncMessage`): withdrawn, it is `returned`
 * and Trezi's queue sends it as usual. Otherwise the CLI is already running it, so the
 * turn is carried on (its `done` waits) until a frame names it (`admitted`, `continued`);
 * without one in time the outcome is `uncertain` and the turn ends.
 *
 * Every outcome is one `steer` event, emitted before the turn's `done`, so the chat
 * settles the queued message before it drains its queue.
 */
export const STEER_CANCEL_MS = 3000
export const STEER_CARRY_MS = 30_000
const MAX_PENDING = 4

type SteerEvent = Extract<AgentEvent, { type: 'steer' }>

export interface ClaudeSteerDeps {
  emit: (event: SteerEvent) => void
  /** Pushes one stamped user message onto the session's streaming input. */
  push: (text: string, images: ImageAttachment[] | undefined, uuid: string) => void
  /** Withdraws a queued message; undefined when the SDK cannot. */
  cancel?: (uuid: string) => Promise<boolean>
  /** The carried turn found no echo in time: it ends now (`done`). */
  expire: () => void
  uuid?: () => string
  cancelMs?: number
  carryMs?: number
}

interface Pending {
  id: string
  carried: boolean
}

export function createClaudeSteers(deps: ClaudeSteerDeps) {
  const pending = new Map<string, Pending>()
  let open = false
  let echoes = false
  let stopping = false
  let carryTimer: ReturnType<typeof setTimeout> | undefined
  const emit = (id: string, state: SteerState, reason?: SteerReason) =>
    deps.emit({ type: 'steer', id, state, ...(reason ? { reason } : {}) })
  const settle = (uuid: string, state: SteerState, reason?: SteerReason) => {
    const steer = pending.get(uuid)
    if (!steer) return
    pending.delete(uuid)
    emit(steer.id, state, reason)
  }
  const clearCarry = () => {
    clearTimeout(carryTimer)
    carryTimer = undefined
  }
  const withdraw = async (uuid: string): Promise<boolean | undefined> => {
    if (!deps.cancel) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        deps.cancel(uuid),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), deps.cancelMs ?? STEER_CANCEL_MS)
        })
      ])
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /** A turn was sent. */
    turnStarted() {
      open = true
      stopping = false
    },
    get open() {
      return open
    },
    get pending() {
      return pending.size
    },
    /** Any frame from the CLI: an echo admits the steers it names. */
    frame(msg: unknown) {
      const uuids = (msg as { user_message_uuids?: unknown }).user_message_uuids
      if (!Array.isArray(uuids)) return
      echoes = true
      for (const uuid of uuids) {
        const steer = typeof uuid === 'string' ? pending.get(uuid) : undefined
        if (steer) settle(uuid, 'admitted', steer.carried ? 'continued' : undefined)
      }
      if (![...pending.values()].some((p) => p.carried)) clearCarry()
    },
    /** `blocked`: the adapter's own reason this session cannot take input now. */
    steer(id: string, text: string, images?: ImageAttachment[], blocked?: SteerReason) {
      if ([...pending.values()].some((p) => p.id === id)) return
      const refusal: SteerReason | undefined =
        blocked ??
        (!open || stopping
          ? 'idle'
          : !echoes
            ? 'unconfirmed'
            : text.trimStart().startsWith('/')
              ? 'command'
              : pending.size >= MAX_PENDING
                ? 'busy'
                : undefined)
      if (refusal) return emit(id, 'rejected', refusal)
      const uuid = (deps.uuid ?? randomUUID)()
      pending.set(uuid, { id, carried: false })
      deps.push(text, images, uuid)
    },
    /** Stop was pressed: withdraw what the CLI has not taken yet, before the interrupt. */
    async stop() {
      stopping = true
      await Promise.all(
        [...pending]
          .filter(([, steer]) => !steer.carried)
          .map(async ([uuid]) => {
            if ((await withdraw(uuid)) === true) settle(uuid, 'returned', 'stopped')
          })
      )
    },
    /**
     * The turn's `result`. Returns `carry` when a steer the CLI kept is running on, so the
     * caller holds back `done`; `done` otherwise.
     */
    async turnEnded(result: unknown): Promise<'done' | 'carry'> {
      this.frame(result)
      // A carried steer's own turn ended: it ran, whatever its frames said.
      for (const [uuid, steer] of [...pending])
        if (steer.carried) settle(uuid, 'admitted', 'continued')
      clearCarry()
      for (const [uuid] of [...pending]) {
        const withdrawn = await withdraw(uuid)
        if (!pending.has(uuid)) continue
        if (withdrawn === true) settle(uuid, 'returned', stopping ? 'stopped' : 'turn-ended')
        else if (stopping) settle(uuid, 'uncertain', 'stopped')
        else {
          const steer = pending.get(uuid)
          if (steer) steer.carried = true
        }
      }
      if (pending.size) {
        carryTimer = setTimeout(() => {
          carryTimer = undefined
          if (!pending.size) return
          for (const [uuid] of [...pending]) settle(uuid, 'uncertain', 'unknown')
          open = false
          deps.expire()
        }, deps.carryMs ?? STEER_CARRY_MS)
        carryTimer.unref?.()
        return 'carry'
      }
      open = false
      stopping = false
      return 'done'
    },
    /** The session ended or was killed: the CLI that held these is gone. */
    abandon() {
      clearCarry()
      for (const [uuid] of [...pending]) settle(uuid, 'returned', 'stopped')
      open = false
    }
  }
}

import type { SessionTranscriptEntry } from '../shared/api'
import { type ChatState, chatDeps } from './chat-state'
import {
  changeEvidence,
  describeChange,
  fullCommitMessage,
  usesConventionalCommits,
  withTrailers
} from './commit-message'
import { productLog } from './product-log'

/** A chat landing's message: `text` for the chat branch's squashed commit, `subject`
 *  and `body` (trailers included) for the live checkout's commit. */
export interface TurnMessage {
  text: string
  subject: string
  body: string
}

/** The agent's final reply in a turn's transcript tail. */
export function finalReply(turn: SessionTranscriptEntry[]): string {
  for (let i = turn.length - 1; i >= 0; i--) if (turn[i].role === 'assistant') return turn[i].text
  return ''
}

/**
 * The commit message for the chat's cumulative change since its fork point (LKM-189),
 * built before the squash so the chat branch and the live commit carry the same
 * description. Every re-squash of parked turns asks again for the combined diff.
 * `prompt` is only a guard: a subject that repeats it is refused. Trailers carry the
 * turn and the chat's branch. Waits at most 3 s for the model, never throws.
 */
export async function turnMessage(
  sessionKey: string,
  st: ChatState,
  turn: number | 'resolve' | 'apply',
  opts: { prompt?: string; reply?: string } = {}
): Promise<TurnMessage> {
  const [evidence, conventional] = await Promise.all([
    changeEvidence(st.wt.path, st.wt.baseSha),
    usesConventionalCommits(st.liveRoot)
  ])
  let generate = null
  try {
    generate = chatDeps()?.describe?.(sessionKey) ?? null
  } catch {
    /* no provider for this chat: the deterministic message */
  }
  const started = Date.now()
  const message = await describeChange({ evidence, conventional, generate, ...opts })
  if (evidence.files.length)
    productLog.info('landing', 'Landing commit message', {
      worktree: st.wt.id,
      generated: message.generated,
      files: evidence.files.length,
      ms: Date.now() - started
    })
  const trailers = { 'Trezi-Turn': String(turn), 'Trezi-Chat': st.wt.branch }
  return {
    text: fullCommitMessage(message, trailers),
    subject: message.subject,
    body: withTrailers(message.body, trailers)
  }
}

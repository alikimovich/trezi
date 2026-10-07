import type { QuestionAnswers, QuestionSpec } from '../shared/api'

/**
 * Coerce question tool input (Claude's AskUserQuestion, Trezi's ask_user) into our
 * `QuestionSpec[]`, tolerating a loosely-typed payload. Returns [] when nothing usable
 * is present (the caller then refuses rather than showing an empty card).
 */
export function parseQuestions(input: unknown): QuestionSpec[] {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return []
  const out: QuestionSpec[] = []
  for (const q of raw) {
    const question =
      typeof (q as { question?: unknown })?.question === 'string'
        ? (q as { question: string }).question
        : ''
    const options = Array.isArray((q as { options?: unknown })?.options)
      ? (q as { options: unknown[] }).options
          .map((o) => ({
            label:
              typeof (o as { label?: unknown })?.label === 'string'
                ? (o as { label: string }).label
                : '',
            ...(typeof (o as { description?: unknown })?.description === 'string'
              ? { description: (o as { description: string }).description }
              : {})
          }))
          .filter((o) => o.label)
      : []
    if (!question || options.length === 0) continue
    out.push({
      question,
      header:
        typeof (q as { header?: unknown })?.header === 'string' && (q as { header: string }).header
          ? (q as { header: string }).header
          : 'Question',
      options,
      multiSelect: (q as { multiSelect?: unknown })?.multiSelect === true
    })
  }
  return out
}

/** The user's picks, phrased as an answer so the model continues with them in hand. */
export function formatAnswers(questions: QuestionSpec[], answers: QuestionAnswers): string {
  const lines = questions.map((q) => {
    const a = (answers[q.question] ?? '').trim()
    return `- ${q.question}\n  → ${a || '(no answer)'}`
  })
  return `The user answered your question(s):\n${lines.join('\n')}`
}

interface AskScope {
  emitKey: string
  background: boolean
  notify: (channel: string, payload: unknown) => void
}

/** ask_user questions on screen, until the user answers or dismisses them. */
const asked = new Map<string, QuestionSpec[]>()
let counter = 0

/**
 * Trezi's question tool for providers without a native one (LKM-199). The card is the
 * same as AskUserQuestion's, but the call returns at once: a tool call cannot wait for a
 * person (the bridges time out), so the agent ends its turn and the answer arrives as the
 * user's next message.
 */
export function askUser(args: unknown, s: AskScope): Record<string, unknown> {
  if (s.background)
    return {
      error:
        'Background agents cannot ask with ask_user. Make the reasonable default choice and name it in your final message.'
    }
  const questions = parseQuestions(args)
  if (!questions.length)
    return { error: 'ask_user needs at least one question with a question sentence and options.' }
  const id = `ask-user:${Date.now().toString(36)}:${++counter}`
  asked.set(id, questions)
  s.notify('agent:event', {
    type: 'question-request',
    request: { id, questions, sessionKey: s.emitKey },
    projectKey: s.emitKey
  })
  return {
    asked: true,
    guidance:
      "The question is on the user's screen. End your turn now with one short line saying what you are waiting for. Do not choose for the user or continue the work this choice decides; their answer arrives as their next message."
  }
}

/**
 * The user's answer to an ask_user question as their next message; `{}` when dismissed.
 * Undefined when `id` is not an ask_user question (an AskUserQuestion is the owner's).
 */
export function answerAsked(
  id: string,
  answers: QuestionAnswers | null
): { message?: string } | undefined {
  const questions = asked.get(id)
  if (!questions) return undefined
  asked.delete(id)
  return answers ? { message: formatAnswers(questions, answers) } : {}
}

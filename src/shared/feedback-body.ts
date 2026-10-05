/**
 * Pure builders for the in-app "Send feedback" GitHub issue (LKM-27). Kept
 * electron-free so it unit-tests without a build, mirroring pr-body.ts. The main
 * process (feedback.ts) captures the screenshot + gathers the transcript and
 * hands the finished strings here; this module only assembles Markdown and
 * enforces GitHub's hard limits.
 *
 * GitHub caps an issue body at 65536 characters and its Markdown sanitizer
 * strips `data:` URIs from <img> (so a screenshot can't render inline) — the
 * screenshot is therefore attached as a copy-into-a-browser data-URI inside a
 * collapsed <details>, and any section that would blow the cap is dropped with a
 * visible note rather than failing the whole post.
 */

/** GitHub's hard issue-body limit; stay safely under it. */
export const BODY_LIMIT = 65536
export const SAFE_LIMIT = 60000

/** Collapse the feedback's first non-empty line into a concise issue title. */
export function buildFeedbackTitle(body: string): string {
  const firstLine = body
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  const base = (firstLine || 'App feedback').replace(/\s+/g, ' ').trim()
  const title = base.length > 70 ? `${base.slice(0, 69)}…` : base
  return `Feedback: ${title}`
}

export interface FeedbackBodyParts {
  /** The user's typed feedback (required). */
  body: string
  /** Rendered chat transcript, when the user opted to attach the conversation. */
  conversation?: string | null
  /** A screenshot as a `data:image/...;base64,…` URI, when opted in. */
  screenshot?: string | null
  /** Redacted diagnostics (LKM-165), when the user consented to attach them. */
  diagnostics?: string | null
}

/**
 * Assemble the issue body: the feedback text, then optional (collapsed)
 * conversation and screenshot sections, then a provenance footer. Optional
 * sections are dropped (with a note) if they'd exceed GitHub's body limit;
 * the feedback text itself is always kept (hard-truncated only as a last resort).
 */
export function buildFeedbackBody(parts: FeedbackBodyParts): string {
  const feedback = parts.body.trim() || '_(no description provided)_'
  const sections: string[] = [feedback]

  const footer = '\n\n---\n_Sent from Trezi via the in-app feedback button._'

  // Budget remaining after the feedback text + footer, for the optional blocks.
  const used = (): number => sections.join('\n\n').length + footer.length

  const conversation = parts.conversation?.trim()
  if (conversation) {
    const block =
      `<details>\n<summary>Conversation transcript</summary>\n\n` +
      '```\n' +
      conversation +
      '\n```\n\n</details>'
    if (used() + block.length + 2 <= SAFE_LIMIT) sections.push(block)
    else sections.push('_Conversation transcript omitted — too large to attach._')
  }

  const diagnostics = parts.diagnostics?.trim()
  if (diagnostics) {
    // A four-backtick fence, so a fence inside a log line cannot close it.
    const block =
      `<details>\n<summary>Diagnostics</summary>\n\n` +
      '````\n' +
      diagnostics +
      '\n````\n\n</details>'
    if (used() + block.length + 2 <= SAFE_LIMIT) sections.push(block)
    else sections.push('_Diagnostics omitted — too large to attach._')
  }

  if (parts.screenshot) {
    const block =
      `<details>\n<summary>Screenshot (base64 PNG/JPEG — paste the data URI below into a browser to view)</summary>\n\n` +
      '```\n' +
      parts.screenshot +
      '\n```\n\n</details>'
    if (used() + block.length + 2 <= SAFE_LIMIT) sections.push(block)
    else sections.push('_Screenshot omitted — too large to attach._')
  }

  let out = sections.join('\n\n') + footer
  // Absolute backstop: never hand gh a body it will reject.
  if (out.length > BODY_LIMIT) out = out.slice(0, BODY_LIMIT - 1)
  return out
}

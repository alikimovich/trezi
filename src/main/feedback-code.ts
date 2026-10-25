/**
 * The Send Feedback invite code (LKM-336), from the tester's Trezi beta invite. The
 * service's provider owner keeps it encrypted with the Keychain helper
 * (`<profile>/trezi/feedback-code.json`, `service/ProviderData.swift`), never in plain text
 * on disk. Bun reads the plaintext only to send it as the Bearer of a request to the Trezi
 * feedback endpoint (`feedback-endpoint.ts`); no sheet ever shows it.
 */
export interface FeedbackCodeOwner {
  feedbackCodeStatus(): Promise<{ hasCode: boolean }>
  /** '' removes the code. Answers whether one is saved. */
  saveFeedbackCode(code: string): Promise<boolean>
  feedbackCode(): Promise<string | null>
}

let owner: FeedbackCodeOwner | null = null

/** Installed once by the native entry point (the provider owner's data client). */
export function setFeedbackCodeOwner(next: FeedbackCodeOwner | null): void {
  owner = next
}

function codeOwner(): FeedbackCodeOwner {
  if (!owner) throw new Error('Trezi’s service is not running, so the invite code cannot be saved.')
  return owner
}

export const feedbackCode = {
  /** false without a service or when the status cannot be read. */
  has: async (): Promise<boolean> =>
    owner ? (await owner.feedbackCodeStatus().catch(() => null))?.hasCode === true : false,
  /** null when there is no code, it cannot be decrypted, or there is no service. */
  read: async (): Promise<string | null> => (owner ? owner.feedbackCode().catch(() => null) : null),
  /** Throws the service's plain message for a code it cannot store. */
  save: async (code: string): Promise<boolean> => codeOwner().saveFeedbackCode(code.trim()),
  remove: async (): Promise<void> => {
    await codeOwner().saveFeedbackCode('')
  }
}

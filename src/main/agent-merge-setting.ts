/** The user's permission for an agent to merge an existing pull request. */
export const AGENT_MERGE_KEY = 'trezi:agent-merge:v1'

let read: () => string | null | undefined = () => null
export function setAgentMergeSource(source: () => string | null | undefined): void {
  read = source
}

/** New installations allow merging in the user's own project by default. */
export function currentAgentMergeAllowed(): boolean {
  return read() !== 'false'
}

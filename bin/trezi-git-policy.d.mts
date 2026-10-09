export function gitCommandRefusal(
  command: string,
  access: 'managed' | 'full',
  liveRoot?: string,
  workRoot?: string,
  liveBranch?: string
): string | null

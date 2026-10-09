/**
 * Build a Publish commit/PR title and body from the changes that actually landed
 * on the branch. Chat transcripts are deliberately not an input: conversation
 * contains questions, corrections, logs, and commands that are not release notes.
 */

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`

const cleanSummary = (raw: string): string => {
  let text = raw.replace(/\s+/g, ' ').trim()
  text = text.replace(/^In the preview I selected [\s\S]*?\.\s+/i, '')
  text = text.replace(
    /^so i have (.+?) project\. i want to (.+)$/i,
    (_match, project: string, action: string) => action.replace(/\bit\b/i, project)
  )
  text = text.replace(/^(?:that's|that is) (?:cool|great|good),? but\s+/i, '')
  text = text.replace(/^(?:ok(?:ay)?|cool|great|nice|well)[.!,:;\s-]+/i, '')
  text = text.replace(/^i (?:actually )?want (?:it|you) to\s+/i, '')
  text = text.trim()
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

const isNoise = (summary: string): boolean =>
  !summary ||
  summary.startsWith('/') ||
  /^(?:do it(?: for me)?|tell me what|sounds like you|you are trezi|pull latest from main)$/i.test(
    summary
  ) ||
  /\[vite\]|Publishing —|Creating PR —/i.test(summary)

/**
 * Parse `%s%x1f%b%x1e` git-log output. The legacy publisher made a final commit
 * whose body began with "Changes requested in Trezi:" and contained the pasted
 * chat; exclude it when an existing PR is updated so that mistake cannot persist.
 */
export function publishCommitSummaries(log: string): string[] {
  const seen = new Set<string>()
  const summaries: string[] = []
  for (const record of log.split('\x1e')) {
    const [subject = '', body = ''] = record.split('\x1f')
    if (body.includes('Changes requested in Trezi:')) continue
    if (/^Reconcile local and remote Trezi publish histories$/i.test(subject.trim())) continue
    const summary = cleanSummary(subject)
    if (isNoise(summary)) continue
    const key = summary.toLocaleLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      summaries.push(summary)
    }
  }
  return summaries
}

const hasAny = (files: string[], test: (file: string) => boolean): boolean => files.some(test)

export function changedScopes(files: string[]): string[] {
  const scopes: string[] = []
  const add = (label: string, test: (file: string) => boolean): void => {
    if (hasAny(files, test)) scopes.push(label)
  }
  add('UI components', (f) => /(?:^|\/)components?\//i.test(f))
  add('content', (f) => /(?:^|\/)(?:content|posts?|articles?)\//i.test(f) || /\.mdx$/i.test(f))
  add('styles', (f) => /\.(?:css|scss|sass|less|pcss)$/i.test(f))
  add('media', (f) => /\.(?:avif|gif|jpe?g|png|svg|webp|mp4|mov|webm|mp3|wav)$/i.test(f))
  add('tests', (f) => /(?:^|\/)(?:test|tests|__tests__)\//i.test(f) || /\.(?:test|spec)\./i.test(f))
  add('dependencies', (f) =>
    /(?:^|\/)(?:package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/i.test(f)
  )
  add('documentation', (f) => /(?:^|\/)docs?\//i.test(f) || /(?:^|\/)README(?:\.|$)/i.test(f))
  add('configuration', (f) => /(?:^|\/)(?:[^/]+\.config\.[^/]+|tsconfig[^/]*\.json)$/i.test(f))
  if (!scopes.length && files.length) scopes.push('project files')
  return scopes
}

const naturalList = (items: string[]): string => {
  if (items.length < 2) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

export interface PublishMessage {
  title: string
  body: string
}

export function buildPublishMessage(
  branch: string,
  commitSummaries: string[],
  diffstat = '',
  changedFiles: string[] = []
): PublishMessage {
  const summaries = commitSummaries.map(cleanSummary).filter((s) => !isNoise(s))
  const scopes = changedScopes(changedFiles)
  const scopeText = naturalList(scopes.slice(0, 4))
  const title = truncate(
    summaries.length === 1
      ? summaries[0]
      : scopeText
        ? `Update ${scopeText}`
        : summaries.length > 1
          ? `Implement ${summaries.length} project changes`
          : `Trezi: publish ${branch}`,
    72
  )

  const lines = ['## Summary', '']
  if (summaries.length) {
    for (const summary of summaries.slice(0, 8)) lines.push(`- ${truncate(summary, 180)}`)
    if (summaries.length > 8) lines.push(`- …and ${summaries.length - 8} more change commits`)
  } else if (changedFiles.length) {
    lines.push(
      `- Update ${changedFiles.length} ${scopeText || 'project'} ${changedFiles.length === 1 ? 'file' : 'files'}.`
    )
  } else {
    lines.push('- Publish the current Trezi work branch.')
  }

  if (changedFiles.length) {
    lines.push('', '## Change overview', '')
    if (scopeText) lines.push(`- Areas touched: ${scopeText}`)
    lines.push(`- Files changed: ${changedFiles.length}`)
  }

  const stat = diffstat.trim()
  if (stat) {
    lines.push(
      '',
      '<details>',
      '<summary>Diffstat</summary>',
      '',
      '```text',
      ...stat.split('\n').slice(0, 24),
      '```',
      '</details>'
    )
  }

  lines.push('', '_Prepared in Trezi._')
  return { title, body: lines.join('\n') }
}

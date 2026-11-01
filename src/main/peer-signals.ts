/**
 * What a peer row knows about its work beyond file paths (LKM-403). Both are read from
 * the request and the paths alone, and both are untrusted hints for the owner's
 * advisories. A `target` names a thing the request pointed at exactly, so two peers on
 * one target are known to overlap. A `term` is only a shared word: two peers with one in
 * common across different files may be related, and nothing says they are.
 */

const MAX_TARGETS = 8
const MAX_TERMS = 16
const MAX_TERM = 32
// Words any request or path may share: they say nothing about the work.
const STOP_WORDS = new Set(
  `about above after again also before below button change changes check code color component
  components could does each edit element file files first from have index into just keep layout
  like line lines lib main make more move need next only other page please preview remove rename
  same selected should show style styles test tests text than that their them then there these
  this those type types update used user using very view when where which while with without
  work would your`.split(/\s+/)
)

const SELECTION = /In the preview I selected the <([^>]{1,80})> element(?: in ([^\s:()]{1,160}))?/

/** A multi-word component name, a JSX tag, or a PascalCase source file. */
const COMPONENT_NAME = /<([A-Z][A-Za-z0-9]{1,48})\b|\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g
const componentOf = (path: string): string | null =>
  /(?:^|\/)([A-Z][A-Za-z0-9]{1,48})\.(?:tsx|jsx|svelte|vue)$/.exec(path)?.[1] ?? null

/** The component and element targets a request names, as `kind:name`. */
export function peerTargets(text: string, label?: string): string[] {
  const head = text.slice(0, 2048)
  const selection = SELECTION.exec(head)
  const source = selection?.[2]
  const component = source ? componentOf(source) : null
  const named = [...head.matchAll(COMPONENT_NAME)].map((match) => match[1] ?? match[2])
  return [
    ...new Set([
      ...(selection ? [`element:${selection[1]}`] : []),
      ...(label ? [`element:${label.slice(0, 80)}`] : []),
      ...(source ? [`source:${source}`] : []),
      ...(component ? [`component:${component}`] : []),
      ...named.map((name) => `component:${name}`)
    ])
  ].slice(0, MAX_TARGETS)
}

/** Lowercase words of the goal and the stems of its paths, the paths first. */
export function peerTerms(goal: string, paths: string[]): string[] {
  const stems = paths.flatMap((path) =>
    (path.split('/').pop() ?? '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
  )
  const words = goal.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []
  return [...new Set([...stems, ...words].map((word) => word.toLowerCase()))]
    .filter((word) => word.length >= 4 && word.length <= MAX_TERM && !STOP_WORDS.has(word))
    .slice(0, MAX_TERMS)
}

/** Paths whose content is never handed to a peer or a resolution prompt. */
const SECRET_PATH =
  /(^|\/)\.env($|[./])|(^|\/)(credentials?|secrets?)($|[./])|(^|\/)\.(npmrc|netrc|pypirc|git-credentials)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|key|p12|pfx|keystore|jks)$/i

export const secretPath = (path: string): boolean => SECRET_PATH.test(path)

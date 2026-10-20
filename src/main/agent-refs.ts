import { randomBytes } from 'node:crypto'

/**
 * LOCAL-WEBKIT-2: host-scoped element refs. The page names elements `e<n>` within one
 * document (`src/preview/agent-observe.ts`); the agent only ever sees `<scope>:e<n>`,
 * where the scope is drawn here for one agent browser, one navigation and one document.
 * A ref resolves only in the browser that issued it and only while that navigation is
 * the page's current one; the page then checks the document and that the element is
 * still connected. A ref from another session, a closed page, an earlier run or an
 * earlier navigation is refused, never guessed.
 */

export interface RefScope {
  nonce: string
  /** The agent browser's id. */
  browser: string
  navigation: number
  /** The page document id the refs were issued in. */
  document: string
}

export const REF_PATTERN = /^[0-9a-f]{8}:e\d{1,7}$/
const MAX_SCOPES = 200
const scopes = new Map<string, RefScope>()
const current = new Map<string, RefScope>()

/** The scope for the browser's current navigation and document, issued once. */
export function refScope(browser: string, navigation: number, document: string): RefScope {
  const scope = current.get(browser)
  if (scope && scope.navigation === navigation && scope.document === document) return scope
  const fresh = { nonce: randomBytes(4).toString('hex'), browser, navigation, document }
  current.set(browser, fresh)
  scopes.set(fresh.nonce, fresh)
  // Evict the oldest scope that is not some browser's current one: a browser's own
  // scope must keep resolving its refs, whatever else was issued since.
  if (scopes.size > MAX_SCOPES)
    for (const [nonce, old] of scopes)
      if (current.get(old.browser) !== old) {
        scopes.delete(nonce)
        break
      }
  return fresh
}

export const refToken = (scope: RefScope, id: string) => `${scope.nonce}:${id}`

/** The page-side ref and document for `token`, or why it cannot be used here. */
export function resolveRef(
  browser: { id: string; navigation: number },
  token: string
): { ref: string; document: string } | { error: string; stale?: boolean } {
  if (!REF_PATTERN.test(token))
    return {
      error:
        'ref must look like "1a2b3c4d:e12", exactly as preview_interact action "refs" returned it.'
    }
  const [nonce, ref] = token.split(':')
  const scope = scopes.get(nonce)
  if (!scope || scope.browser !== browser.id)
    return {
      error: `Ref ${token} was not issued by this session's agent browser (another session, a closed page or an earlier run). Call preview_interact action "refs" again.`
    }
  if (scope.navigation !== browser.navigation)
    return {
      stale: true,
      error: `Ref ${token} is stale: the agent page navigated since it was issued (navigation ${scope.navigation} → ${browser.navigation}). Call preview_interact action "refs" again.`
    }
  return { ref, document: scope.document }
}

/** A closed browser's refs never resolve again. */
export function dropRefScopes(browser: string): void {
  current.delete(browser)
  for (const [nonce, scope] of scopes) if (scope.browser === browser) scopes.delete(nonce)
}

import type { DiagStep } from '../shared/api'

/**
 * Rule-based failure matching — the proactive-checks layer. Known error
 * signatures map to known fixes *before* we spend a model call: instant,
 * offline, identical every time. The AI diagnose in diagnose.ts stays the
 * fallback for everything this doesn't match.
 *
 * Pure (no electron / no fs) so it's bun-unit-testable. A match returns just the
 * fix content; diagnose.ts attaches the cache signature + status and renders it
 * through the same propose-first DiagnoseCard as an AI diagnosis. Steps reuse the
 * `DiagStep` shape — repo steps are applyable, host steps are copy-only.
 */
export interface RuleMatch {
  summary: string
  detail?: string
  steps: DiagStep[]
}

interface Rule {
  id: string
  test: (text: string) => boolean
  match: (text: string) => RuleMatch
}

const RULES: Rule[] = [
  {
    // Observed first-hand: a stale Homebrew node keg pinned in ios/.xcode.env.local
    // links a dylib that a later `brew upgrade` removed, so the RN build's script
    // phase invokes a node that aborts (`dyld: Library not loaded … Abort trap: 6`).
    id: 'broken-node-binary',
    test: (t) =>
      /Library not loaded|dyld\[|Abort trap/i.test(t) &&
      /\bnode\b|NODE_BINARY|\.xcode\.env/i.test(t),
    match: (t) => {
      const nodePath = t.match(/Node found at:\s*(\S+)/i)?.[1]
      const lib = t.match(/Library not loaded:\s*(\S+)/i)?.[1]
      return {
        summary:
          'The Node binary the iOS build uses is broken — a shared library it links is missing.',
        detail:
          `The Xcode script phase ran ${nodePath ?? 'a node binary'} which failed to load ` +
          `${lib ?? 'a shared library'} and aborted. This is almost always a stale Homebrew node keg ` +
          `pinned in ios/.xcode.env.local after a dependency upgrade. Point NODE_BINARY at a working node.`,
        steps: [
          {
            text: 'Repoint the iOS build at your current working node (overrides the stale pinned path).',
            command:
              'printf \'export NODE_BINARY=%s\\n\' "$(command -v node)" > ios/.xcode.env.local',
            scope: 'repo'
          },
          {
            text: 'Optional: clear the broken Homebrew node keg so nothing else picks it up.',
            command: 'brew cleanup node',
            scope: 'host'
          }
        ]
      }
    }
  }
]

/** First matching rule wins; null means "no known rule — fall through to the AI". */
export function matchKnownError(text: string): RuleMatch | null {
  if (!text) return null
  for (const r of RULES) {
    try {
      if (r.test(text)) return r.match(text)
    } catch {
      /* a rule must never throw the diagnosis path — skip it */
    }
  }
  return null
}

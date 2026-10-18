/**
 * Recommended skills shown in Settings → Skills (LKM-288): read-only metadata about
 * public skill packages, never their files. Nothing here is downloaded, installed or
 * run. GitHub import (Trezi Skills 3/4, LKM-285) reuses these entries as its starting
 * points; until then a recommendation only names its source and license.
 *
 * Repositories and licenses are the ones confirmed upstream in the LKM-288 brief. A
 * folder inside the repository is shown only when `pathVerified` is true; the others
 * keep their expected folder for the importer (or a reviewer) to confirm first.
 */

export interface SkillRecommendation {
  /** Stable ID, also the expected `name` in the skill's SKILL.md. */
  id: string
  title: string
  publisher: string
  summary: string
  /** `owner/name` on github.com. */
  repository: string
  /** The skill's folder inside the repository, '' for its root. */
  path: string
  /** Whether `path` was confirmed upstream; an unconfirmed folder is not shown. */
  pathVerified: boolean
  /** SPDX identifier. */
  license: 'Apache-2.0' | 'MIT'
  /** Where the license was found: a file in the repository, or the SKILL.md front matter. */
  licenseSource: string
}

export const SKILL_RECOMMENDATIONS: readonly SkillRecommendation[] = Object.freeze([
  {
    id: 'frontend-design',
    title: 'Frontend Design',
    publisher: 'Anthropic',
    summary: 'Distinctive, production-grade interfaces that avoid generic AI styling.',
    repository: 'anthropics/skills',
    path: 'skills/frontend-design',
    pathVerified: true,
    license: 'Apache-2.0',
    licenseSource: 'skills/frontend-design/LICENSE.txt'
  },
  {
    id: 'vercel-react-best-practices',
    title: 'React Best Practices',
    publisher: 'Vercel',
    summary: 'React and Next.js performance guidance from Vercel Engineering.',
    repository: 'vercel-labs/agent-skills',
    path: 'skills/react-best-practices',
    pathVerified: false,
    license: 'MIT',
    licenseSource: 'SKILL.md front matter'
  },
  {
    id: 'vercel-composition-patterns',
    title: 'Composition Patterns',
    publisher: 'Vercel',
    summary: 'Composition patterns for React components that stay flexible as they grow.',
    repository: 'vercel-labs/agent-skills',
    path: 'skills/composition-patterns',
    pathVerified: false,
    license: 'MIT',
    licenseSource: 'SKILL.md front matter'
  },
  {
    id: 'swiftui-expert-skill',
    title: 'SwiftUI Expert',
    publisher: 'Antoine van der Lee',
    summary: 'SwiftUI guidance for state management, view composition and performance.',
    repository: 'AvdLee/SwiftUI-Agent-Skill',
    path: 'swiftui-expert-skill',
    pathVerified: false,
    license: 'MIT',
    licenseSource: 'LICENSE'
  }
] satisfies SkillRecommendation[])

/** The page a recommendation links to: its verified folder, otherwise the repository. */
export function recommendationUrl(entry: SkillRecommendation): string {
  const base = `https://github.com/${entry.repository}`
  return entry.pathVerified && entry.path ? `${base}/tree/main/${entry.path}` : base
}

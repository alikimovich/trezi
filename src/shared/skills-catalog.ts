/**
 * Recommended skills shown in Settings → Skills (LKM-288): read-only metadata about
 * public skill packages, never their files. Nothing here is downloaded, installed or
 * run. GitHub import (Trezi Skills 2/4, LKM-285) reuses the importable entries as its
 * starting points (`skills-recommendations.ts`); an entry that is not importable only
 * names its source and license, and says why.
 *
 * Repositories and licenses are the ones confirmed upstream in the LKM-288 brief. Every
 * `path` was checked against the upstream tree at the commit recorded in
 * `skills-recommendations.ts`; a folder is linked only when `pathVerified` is true.
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
  /**
   * Whether Trezi can import this folder: it must be instructions only and fit the
   * skill size limits. False entries are shown with `unavailableReason`, never imported.
   */
  importable: boolean
  /** Why the folder cannot be imported; set exactly when `importable` is false. */
  unavailableReason?: string
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
    licenseSource: 'skills/frontend-design/LICENSE.txt',
    importable: true
  },
  {
    id: 'vercel-react-best-practices',
    title: 'React Best Practices',
    publisher: 'Vercel',
    summary: 'React and Next.js performance guidance from Vercel Engineering.',
    repository: 'vercel-labs/agent-skills',
    path: 'skills/react-best-practices',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'SKILL.md front matter',
    importable: false,
    unavailableReason:
      'The folder has 76 files; Trezi imports at most 64 files per skill, so it cannot be imported yet.'
  },
  {
    id: 'vercel-composition-patterns',
    title: 'Composition Patterns',
    publisher: 'Vercel',
    summary: 'Composition patterns for React components that stay flexible as they grow.',
    repository: 'vercel-labs/agent-skills',
    path: 'skills/composition-patterns',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'SKILL.md front matter',
    importable: true
  },
  {
    id: 'swiftui-view-refactor',
    title: 'SwiftUI View Refactor',
    publisher: 'Peter Steinberger',
    summary:
      'Refactor and review SwiftUI views: layout, dependency injection, Observation and view models.',
    repository: 'steipete/agent-scripts',
    path: 'skills/swiftui-view-refactor',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'swiftui-expert-skill',
    title: 'SwiftUI Expert',
    publisher: 'Antoine van der Lee',
    summary: 'SwiftUI guidance for state management, view composition and performance.',
    repository: 'AvdLee/SwiftUI-Agent-Skill',
    path: 'skills/swiftui-expert-skill',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: false,
    unavailableReason:
      'The folder has 51 files including scripts and images, and one file over 256 KiB; Trezi imports instructions only, within its size limits.'
  }
] satisfies SkillRecommendation[])

/** The page a recommendation links to: its verified folder, otherwise the repository. */
export function recommendationUrl(entry: SkillRecommendation): string {
  const base = `https://github.com/${entry.repository}`
  return entry.pathVerified && entry.path ? `${base}/tree/main/${entry.path}` : base
}

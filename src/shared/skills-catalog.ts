/** Public, opt-in recommendations for Settings → Skills. The source folders are
 * checked against the pinned commits in skills-recommendations.ts; the catalog
 * contains metadata only and never installs or runs a skill by itself. */
export interface SkillRecommendation {
  /** Stable ID and expected SKILL.md name. */
  id: string
  title: string
  publisher: string
  summary: string
  /** owner/name on github.com. */
  repository: string
  path: string
  pathVerified: boolean
  license: 'Apache-2.0' | 'MIT'
  licenseSource: string
  importable: boolean
  /** Explains a checked, instruction-only adaptation at install time. */
  installNote?: string
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
    id: 'impeccable',
    title: 'Impeccable',
    publisher: 'Paul Bakaus',
    summary:
      'A static Markdown edition of Impeccable’s UI craft, motion, copy and adaptation playbooks.',
    repository: 'pbakaus/impeccable',
    path: 'plugin/skills/impeccable',
    pathVerified: true,
    license: 'Apache-2.0',
    licenseSource: 'LICENSE',
    importable: true,
    installNote:
      'Trezi keeps 17 static Markdown playbooks and an adapted SKILL.md. Impeccable’s launcher, hooks, live browser and runtime workflows are excluded; no script is installed or run.'
  },
  {
    id: 'emil-design-eng',
    title: 'Design Engineering',
    publisher: 'Emil Kowalski',
    summary: 'Polish UI components, interaction details and motion with a design engineer’s eye.',
    repository: 'emilkowalski/skills',
    path: 'skills/emil-design-eng',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'better-ui',
    title: 'UI Polish',
    publisher: 'Jakub Krehel',
    summary: 'Refine surfaces, icons and motion using concrete visual and interaction rules.',
    repository: 'jakubkrehel/skills',
    path: 'skills/better-ui',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'animate',
    title: 'Build Animations',
    publisher: 'Emil Kowalski',
    summary: 'Choose when motion helps, then build transitions with purposeful timing and exits.',
    repository: 'emilkowalski/skills',
    path: 'skills/animate',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'better-typography',
    title: 'Typography',
    publisher: 'Jakub Krehel',
    summary: 'Improve type scale, spacing, wrapping, truncation and font rendering.',
    repository: 'jakubkrehel/skills',
    path: 'skills/better-typography',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'better-colors',
    title: 'Color Systems',
    publisher: 'Jakub Krehel',
    summary: 'Build semantic palettes and check rendered color and contrast.',
    repository: 'jakubkrehel/skills',
    path: 'skills/better-colors',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'better-accessibility',
    title: 'Accessibility',
    publisher: 'Jakub Krehel',
    summary: 'Review keyboard, focus, semantics, forms, motion and zoom against WCAG 2.2.',
    repository: 'jakubkrehel/skills',
    path: 'skills/better-accessibility',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'better-layout',
    title: 'Layout',
    publisher: 'Jakub Krehel',
    summary:
      'Improve grouping, alignment, responsive structure and translated or mirrored layouts.',
    repository: 'jakubkrehel/skills',
    path: 'skills/better-layout',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: true
  },
  {
    id: 'better-writing',
    title: 'Product Writing',
    publisher: 'Jakub Krehel',
    summary: 'Write clearer labels, errors, empty states and confirmations in the product’s voice.',
    repository: 'jakubkrehel/skills',
    path: 'skills/better-writing',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: false,
    unavailableReason:
      'Its Markdown contains a !` sequence that Trezi’s instruction-only importer conservatively refuses.'
  },
  {
    id: 'variant',
    title: 'Explore Variants',
    publisher: 'Jakub Krehel',
    summary: 'Explore deliberate component variants along one design axis.',
    repository: 'jakubkrehel/skills',
    path: 'skills/variant',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: false,
    unavailableReason:
      'Its SKILL.md disables model invocation; Trezi cannot preserve that invocation rule in an imported skill.'
  },
  {
    id: 'state-machine',
    title: 'Explore Component States',
    publisher: 'Jakub Krehel',
    summary: 'Explore real loading, empty, error and permission states of one component.',
    repository: 'jakubkrehel/skills',
    path: 'skills/state-machine',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: false,
    unavailableReason:
      'Its SKILL.md disables model invocation; Trezi cannot preserve that invocation rule in an imported skill.'
  },
  {
    id: 'interface-review',
    title: 'Interface Review',
    publisher: 'Jakub Krehel',
    summary: 'Review a UI change for accessibility, layout, writing, type, color and polish.',
    repository: 'jakubkrehel/skills',
    path: 'skills/interface-review',
    pathVerified: true,
    license: 'MIT',
    licenseSource: 'LICENSE',
    importable: false,
    unavailableReason:
      'Its SKILL.md disables model invocation; Trezi cannot preserve that invocation rule in an imported skill.'
  }
] satisfies SkillRecommendation[])

/** Link to the reviewed commit and folder, never a moving branch. */
export function recommendationUrl(entry: SkillRecommendation): string {
  const base = `https://github.com/${entry.repository}`
  const commits: Record<string, string> = {
    'emilkowalski/skills': 'c8a79627b59d72d764d6ab6f2c87c09a48169833',
    'jakubkrehel/skills': '60bf140e43c98b248e6594487384ec967e89d98a',
    'pbakaus/impeccable': '5af4319c4e7a7ee3e5e2b9fe899bcfb21c6190cb'
  }
  const ref = commits[entry.repository] ?? 'main'
  return entry.pathVerified && entry.path ? `${base}/tree/${ref}/${entry.path}` : base
}

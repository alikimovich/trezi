/**
 * Trezi Skills registry contract v1 (LKM-284): the app-scoped, service-owned store of
 * skill packages shared by every project and provider. The Swift twin is
 * `src/service/Skills*.swift`; `docs/SWIFT-BACKEND-SKILLS.md` documents the methods,
 * storage and the seams the provider, import and Settings tasks build on.
 */
import type { Revision } from './service-contract/types'

export const SKILLS_SERVICE = 'skills'
export const SKILLS_REGISTRY_FORMAT = 'trezi-skills-registry-v1'
export const SKILL_REVISION_FORMAT = 'trezi-skill-revision-v1'
export const SKILLS_SNAPSHOT_FORMAT = 'trezi-skills-snapshot-v1'
export const SKILL_ENTRY_FILE = 'SKILL.md'

/** Mirrors `SkillsLimits` in `src/service/SkillsPackage.swift`. */
export const SKILLS_LIMITS = {
  maxFiles: 64,
  maxDirectoryEntries: 1024,
  maxFileBytes: 256 * 1024,
  maxPackageBytes: 1024 * 1024,
  maxDepth: 6,
  maxPath: 512,
  maxComponent: 128,
  maxName: 64,
  maxDescription: 1024,
  maxSkills: 512,
  maxHistory: 64,
  maxSnapshots: 4096,
  maxSession: 200
} as const

export type SkillProviderName = 'claude' | 'codex' | 'gemini'
/** Which provider seams may offer the skill (the user's choice; default all). */
export type SkillProviders = Record<SkillProviderName, boolean>

export type SkillSource =
  | { kind: 'manual' }
  | {
      kind: 'github'
      /** `owner/name`. */
      repository: string
      /** Folder inside the repository, '' for its root. */
      subpath: string
      /** The resolved full commit ID the files were taken at. */
      commit: string
      /**
       * SPDX identifier, `NOASSERTION` when a license was found but not recognised, null
       * when none was found (see `skillLicenseStatus`).
       */
      license: string | null
      /** GitHub import (LKM-285): the branch, tag or commit that was asked for. */
      ref?: string
      /** GitHub import: repository path of the license evidence (a file or `SKILL.md`). */
      licenseFile?: string
    }

export type SkillHistoryKind = 'create' | 'import' | 'install' | 'update' | 'edit'
export interface SkillHistoryEntry {
  revision: string
  createdAt: number
  kind: SkillHistoryKind
}

/** Metadata only: listing never carries package text. */
export interface SkillSummary {
  id: string
  name: string
  description: string
  /** Content address (SHA-256) of the revision new sessions get. */
  revision: string
  /** The revision as created or as last taken from its source. */
  installedRevision: string
  /** Edited since it was created or installed (`revision !== installedRevision`). */
  modified: boolean
  enabled: boolean
  /** Recoverably removed: kept, restorable, never offered to new sessions. */
  removed: boolean
  removedAt: number | null
  providers: SkillProviders
  source: SkillSource
  files: number
  bytes: number
  history: SkillHistoryEntry[]
  createdAt: number
  updatedAt: number
}

export interface SkillsList {
  /** The `skills` ledger domain revision; every manifest mutation names it. */
  revision: Revision
  digest: string
  skills: SkillSummary[]
}

export interface SkillFileEntry {
  path: string
  size: number
  digest: string
}
export interface SkillBody {
  skill: string
  revision: string
  name: string
  description: string
  /** `SKILL.md` as stored. */
  body: string
  /** Every other file, read one at a time with `reference`. */
  references: SkillFileEntry[]
}
export interface SkillReference {
  skill: string
  revision: string
  path: string
  text: string
}

export interface SkillPin {
  skill: string
  name: string
  revision: string
  providers: SkillProviders
}
export interface SkillSnapshot {
  session: string
  createdAt: number
  pins: SkillPin[]
  /** Present on `snapshot`: false when the session already had pins. */
  created?: boolean
  /** Enabled skills left out because their stored revision is unreadable. */
  skipped?: string[]
}

/**
 * `project` (LKM-287): a session's pins laid out read-only for one provider under
 * `<profile>/skills/projections/<sha256(session)>/<provider>/`. `catalog.json` there is a
 * `SkillsCatalog`; Claude's folder is also the `trezi-library` local plugin.
 */
export interface SkillProjection {
  session: string
  provider: SkillProviderName
  path: string
  /** True when this call created the session's snapshot. */
  created: boolean
  skills: Array<{ skill: string; name: string; revision: string }>
  /** Pins left out: `unreadable`, `outside the skills-only scope` or `duplicate name`. */
  omitted: Array<{ skill: string; name: string; reason: string }>
}
export const SKILLS_CATALOG_FORMAT = 'trezi-skills-catalog-v1'
export const SKILLS_PLUGIN_NAME = 'trezi-library'
export interface SkillsCatalog {
  format: typeof SKILLS_CATALOG_FORMAT
  session: string
  provider: SkillProviderName
  plugin: typeof SKILLS_PLUGIN_NAME | null
  skills: Array<{
    skill: string
    name: string
    description: string
    revision: string
    /** Relative to the projection folder, e.g. `skills/pdf/SKILL.md`. */
    entry: string
  }>
  omitted: SkillProjection['omitted']
}

export interface SkillMutation {
  revision: Revision
  digest: string
  changed: boolean
  skill?: string
  skillRevision?: string
  /** `import`: hidden entries that were not read (`.git`, `.DS_Store`, …). */
  skipped?: string[]
}

export interface SkillFileInput {
  path: string
  text: string
}
/** `text: null` deletes the file (never `SKILL.md`). */
export interface SkillFileChange {
  path: string
  text: string | null
}

/**
 * `github` (LKM-285): a public repository folder fetched at the commit its ref resolves
 * to. `url` is `https://github.com/<owner>/<repo>` (with optional `ref` and `subpath`)
 * or `https://github.com/<owner>/<repo>/tree/<ref>/<folder>` (without them).
 * `replacing` names a skill imported from the same folder to update in place.
 */
export interface SkillGitHubInput {
  url: string
  ref?: string
  subpath?: string
  replacing?: string
}
export interface SkillGitHubImport extends SkillMutation {
  skill: string
  skillRevision: string
  name: string
  source: Extract<SkillSource, { kind: 'github' }>
  /** Hidden entries of the folder that were not read. */
  skipped: string[]
  /** The repository license file copied into the package for attribution, if any. */
  attribution: string | null
}

/** Mirrors `SkillsArchiveLimits` and `SkillsGitHubFetcher` in `src/service/`. */
export const SKILLS_GITHUB_LIMITS = {
  compressedBytes: 64 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  entries: 20_000,
  headerBytes: 64 * 1024,
  deadlineSeconds: 120,
  maxImports: 2
} as const

/** Licenses an imported skill may be used and shared under with attribution only. */
const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense'
])
const COPYLEFT = new Set([
  'AGPL-3.0',
  'CC-BY-SA-4.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'MPL-2.0'
])
/**
 * How to present an imported skill's license: `unknown` (none found, or `NOASSERTION`)
 * and `restricted` (e.g. non-commercial) must be shown as such, never as permissive.
 */
export function skillLicenseStatus(
  license: string | null
): 'permissive' | 'copyleft' | 'restricted' | 'unknown' {
  if (!license || license === 'NOASSERTION') return 'unknown'
  if (PERMISSIVE.has(license)) return 'permissive'
  if (COPYLEFT.has(license)) return 'copyleft'
  return 'restricted'
}

/**
 * Every pipe method, its mode and body. Ledger mutations need `expectedRevision`;
 * `fetch` methods are mutations without it, answered when the fetch ends.
 */
export interface SkillsMethods {
  list: { mode: 'read'; body: Record<string, never>; result: SkillsList }
  read: {
    mode: 'read'
    body: { skill: string; revision?: string; session?: string }
    result: SkillBody
  }
  reference: {
    mode: 'read'
    body: { skill: string; revision: string; path: string }
    result: SkillReference
  }
  pins: { mode: 'read'; body: { session: string }; result: SkillSnapshot }
  create: { mode: 'ledger'; body: { files: SkillFileInput[] }; result: SkillMutation }
  import: { mode: 'ledger'; body: { folder: string }; result: SkillMutation }
  edit: {
    mode: 'ledger'
    body: { skill: string; base: string; changes: SkillFileChange[] }
    result: SkillMutation
  }
  enable: { mode: 'ledger'; body: { skill: string; enabled: boolean }; result: SkillMutation }
  providers: {
    mode: 'ledger'
    body: { skill: string; providers: SkillProviders }
    result: SkillMutation
  }
  remove: { mode: 'ledger'; body: { skill: string }; result: SkillMutation }
  restore: { mode: 'ledger'; body: { skill: string }; result: SkillMutation }
  purge: { mode: 'ledger'; body: { skill: string }; result: SkillMutation }
  snapshot: { mode: 'session'; body: { session: string }; result: SkillSnapshot }
  release: {
    mode: 'session'
    body: { session: string }
    result: { session: string; released: boolean }
  }
  project: {
    mode: 'session'
    body: { session: string; provider: SkillProviderName }
    result: SkillProjection
  }
  github: { mode: 'fetch'; body: SkillGitHubInput; result: SkillGitHubImport }
  /** Cancels a `github` import of this connection by its operation ID, until it commits. */
  cancel: {
    mode: 'fetch'
    body: { operation: string }
    result: { operation: string; cancelled: boolean }
  }
}
export type SkillsMethod = keyof SkillsMethods
export const SKILLS_METHOD_MODES: { [M in SkillsMethod]: SkillsMethods[M]['mode'] } = {
  list: 'read',
  read: 'read',
  reference: 'read',
  pins: 'read',
  create: 'ledger',
  import: 'ledger',
  edit: 'ledger',
  enable: 'ledger',
  providers: 'ledger',
  remove: 'ledger',
  restore: 'ledger',
  purge: 'ledger',
  snapshot: 'session',
  release: 'session',
  project: 'session',
  github: 'fetch',
  cancel: 'fetch'
}

/** Agent Skills names: 1–64 of a-z, 0-9 and '-', not starting or ending with '-'. */
export const validSkillName = (name: string): boolean =>
  name.length <= SKILLS_LIMITS.maxName && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)

const COMPONENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._ -]*[A-Za-z0-9_-])?$/
/** A package-relative path the service accepts (see `SkillsPackage.validPath`). */
export function validSkillPath(path: string): boolean {
  if (!path || path.length > SKILLS_LIMITS.maxPath) return false
  const parts = path.split('/')
  return (
    parts.length <= SKILLS_LIMITS.maxDepth &&
    parts.every((part) => part.length <= SKILLS_LIMITS.maxComponent && COMPONENT.test(part))
  )
}

/** 1–200 of A-Z a-z 0-9 . _ : - (e.g. a chat ID). */
export const validSkillSession = (session: string): boolean =>
  session.length <= SKILLS_LIMITS.maxSession && /^[A-Za-z0-9._:-]+$/.test(session)

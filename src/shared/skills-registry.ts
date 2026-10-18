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
      /** SPDX identifier or license name as found, null when none was found. */
      license: string | null
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

/** Every pipe method, its mode and body. Ledger mutations need `expectedRevision`. */
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
  release: 'session'
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

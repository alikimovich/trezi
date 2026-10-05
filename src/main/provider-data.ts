import { app } from '../native/platform'
import { nativeSessionPath } from '../native/profile-path'
import type {
  ProviderConnection,
  ProviderConnectionInput,
  ProviderLoginReport
} from '../shared/api'
import {
  type CatalogBackend,
  type CatalogModel,
  createModelCatalog,
  harnessStamp,
  installedVersion,
  type ModelCatalog
} from './model-catalog'
import { createProviderStore, type ProviderStore } from './providers-store'

/**
 * Who writes the provider data (LKM-102): the v10 connections store with its encrypted
 * keys (`providers.json`), the built-in seats' model catalog cache (`model-catalog.json`)
 * and the Codex model probe. The service's provider owner does
 * (`service/ProviderData.swift`, installed by `native/index.ts`), the only writer since
 * LKM-111 removed the Bun twins; Bun only reads the two files.
 *
 * KEY DISCIPLINE is unchanged: a plaintext key only ever comes back from `secretFor`,
 * in main, for a catalog probe, a chat turn or Jev.
 */
export interface ProviderDataOwner {
  readonly kind: 'swift'
  /** Throws a user-readable message for a bad draft or an un-storable key. */
  save(input: ProviderConnectionInput): Promise<ProviderConnection>
  remove(id: string): Promise<void>
  secretFor(id: string): Promise<string | null>
  /** Persists a discovered list with the harness stamp it came from (LKM-164); false
   *  when it could not be written. */
  saveCatalog(backend: CatalogBackend, models: CatalogModel[], harness?: string): Promise<boolean>
  /** `codex debug models`, parsed; [] on any failure. */
  codexModels(): Promise<CatalogModel[]>
  /** A built-in seat's subscription token (`claude setup-token`, LKM-119); '' removes it.
   *  Answers whether one is saved. The token itself never comes back. */
  saveSeatToken(provider: 'claude', token: string): Promise<boolean>
  seatTokenStatus(): Promise<{ claude: { hasToken: boolean } }>
  /** "Check provider login": the provider's auth status, from a helper launched like a chat's in `root`. */
  checkLogin(provider: string, root: string): Promise<ProviderLoginReport>
}

let owner: ProviderDataOwner | null = null

/** Installed once by the native entry point when the Swift service is supervising Bun. */
export function setProviderDataOwner(next: ProviderDataOwner | null): void {
  owner = next
}

/**
 * The data dir is INJECTED by `registerProviderIpc` (agent.ts hands over its own
 * `dataDir()`) rather than recomputed here: agent.ts's version also performs the
 * one-time `<userData>/dsgn` → `trezi` migration, which creating the dir first
 * would skip forever.
 */
let getDataDir: () => string = () => nativeSessionPath(app.getPath('userData'))
let store: ProviderStore | null = null
let catalog: ModelCatalog | null = null

export function setProviderDataDir(dataDir: () => string): void {
  getDataDir = dataDir
  store = null
  catalog = null
}

function dataOwner(): ProviderDataOwner {
  if (!owner)
    throw new Error('Trezi’s service is not running, so provider connections cannot be changed.')
  return owner
}

/** The connections store: reads are Bun's; writes and keys go to the owner. */
export const connectionStore = {
  list: (): ProviderConnection[] => reader().list(),
  get: (id: string): ProviderConnection | null => reader().get(id),
  save: async (input: ProviderConnectionInput): Promise<ProviderConnection> =>
    dataOwner().save(input),
  remove: async (id: string): Promise<void> => dataOwner().remove(id),
  /** null when there is no key, it cannot be decrypted, or there is no service. */
  secretFor: async (id: string): Promise<string | null> =>
    owner ? owner.secretFor(id).catch(() => null) : null
}

/** The bundled SDK/CLI versions per seat, read once per run from the checkout's
 *  node_modules (the packages stay external to the backend bundle). */
const harnesses = new Map<CatalogBackend, string>()
function bundledHarness(backend: CatalogBackend): string {
  let stamp = harnesses.get(backend)
  if (stamp === undefined) {
    const root = app.getAppPath()
    stamp = harnessStamp(backend, (pkg) => installedVersion(root, pkg))
    harnesses.set(backend, stamp)
  }
  return stamp
}

/** Lazy for the same reason as the store: `getDataDir` isn't final until registration. */
export function modelCatalog(): ModelCatalog {
  catalog ??= createModelCatalog({
    baseDir: getDataDir(),
    harness: bundledHarness,
    persist: (backend, models, harness) => {
      if (!owner) return false // no service: this run keeps the list in memory
      void owner.saveCatalog(backend, models, harness).catch(() => false)
      return true
    }
  })
  return catalog
}

/** The Claude subscription token and the login check (LKM-119); both need the service. */
export const seatLogin = {
  save: (token: string): Promise<boolean> => dataOwner().saveSeatToken('claude', token),
  hasToken: async (): Promise<boolean> =>
    owner ? (await owner.seatTokenStatus().catch(() => null))?.claude.hasToken === true : false,
  check: (provider: string, root: string): Promise<ProviderLoginReport> =>
    dataOwner().checkLogin(provider, root)
}

/** [] on any failure, including no service: the picker keeps its cached list. */
export function codexModels(): Promise<CatalogModel[]> {
  return owner ? owner.codexModels().catch(() => []) : Promise.resolve([])
}

function reader(): ProviderStore {
  store ??= createProviderStore(getDataDir())
  return store
}

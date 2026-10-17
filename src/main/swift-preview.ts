import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeProjectInfo, NativeToolchainInfo } from '../shared/api'
import { projectKey } from '../shared/projectKey'
import { discoverNative } from '../swift-preview/discovery'

/** The checkout's Swift component preview driver (LKM-271, `docs/SWIFT-PREVIEWS.md`). */
export const SWIFT_PREVIEW_DRIVER = join(__dirname, '../..', 'src/swift-preview/driver.ts')

const MANIFEST = 'trezi-previews.json'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Trezi's own folder for a project's preview manifest (LKM-273), in Trezi's app data
 * so the user's repo never needs an edit: `<userData>/swift-previews/<key hash>`. A
 * `trezi-previews.json` there wins over the repo's. Stage 1 only reads it; the user
 * (or a later stage's setup flow) writes it.
 */
export function treziManifestDir(root: string, userData: string): string {
  const hash = createHash('sha256').update(projectKey(root)).digest('hex').slice(0, 16)
  return join(userData, 'swift-previews', hash)
}

/**
 * Trezi-owned derived data of every Swift preview build (LKM-275): resolved settings,
 * package checkouts and builds, compiled resources and modules, per project and
 * toolchain. Never inside the user's repo or `~/Library/Developer/Xcode`.
 */
export function swiftPreviewDerivedData(userData: string): string {
  return join(userData, 'swift-previews', 'DerivedData')
}

/**
 * The launch command for a detected Swift project: Trezi's own driver on the Bun that
 * runs this backend, in the project root the runtime owner starts it in, given Trezi's
 * manifest folder for it and its derived data root. Built from these paths only, never
 * from project files.
 */
export function swiftPreviewCommand(
  bun: string = process.execPath,
  driver: string = SWIFT_PREVIEW_DRIVER,
  manifestDir?: string,
  cacheRoot?: string
): string {
  const command = `${quote(bun)} ${quote(driver)}`
  return [
    command,
    ...(manifestDir ? [`--manifest-dir ${quote(manifestDir)}`] : []),
    ...(cacheRoot ? [`--cache-root ${quote(cacheRoot)}`] : [])
  ].join(' ')
}

/** The project's running server and whether Trezi started it with `swiftPreviewCommand`. */
export interface NativeServer {
  url: string
  driver: boolean
}

/**
 * `project:native`: the native roots, where the manifest can live, and the target graph
 * and selected toolchain (LKM-274) the running preview driver read (fetched from it;
 * nothing is spawned here). Only
 * Trezi's own driver is asked: a JS or mixed project's server is the user's dev server
 * and gets no request, so `graph` stays null with an explanation.
 */
export async function nativeProjectInfo(
  root: string,
  userData: string,
  server: NativeServer | undefined
): Promise<NativeProjectInfo> {
  const treziDir = treziManifestDir(root, userData)
  const info: NativeProjectInfo = {
    structure: discoverNative(root),
    manifest: {
      trezi: join(treziDir, MANIFEST),
      treziExists: existsSync(join(treziDir, MANIFEST)),
      repo: join(root, MANIFEST),
      repoExists: existsSync(join(root, MANIFEST))
    },
    graph: null,
    plan: null,
    build: null,
    toolchain: null,
    error: ''
  }
  if (!server) {
    info.error = 'The Swift preview driver is not running.'
    return info
  }
  if (!server.driver) {
    info.error =
      "This project's preview is its own dev server, not Trezi's Swift preview driver, so the target graph is not read."
    return info
  }
  try {
    const response = await fetch(new URL('/graph', server.url), {
      signal: AbortSignal.timeout(60_000)
    })
    const body = (await response.json()) as {
      graph?: unknown
      plan?: unknown
      build?: unknown
      toolchain?: NativeToolchainInfo | null
      error?: string
    }
    if (!response.ok) info.error = body.error ?? `The driver answered ${response.status}.`
    else {
      info.graph = body.graph ?? null
      info.plan = body.plan ?? null
      info.build = body.build ?? null
      info.toolchain = body.toolchain ?? null
    }
  } catch (error) {
    info.error = `Could not read the graph from the preview driver: ${(error as Error).message}`
  }
  return info
}

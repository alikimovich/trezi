import { ARCH, compileModules, moduleInputs, type PreparedBuild, run } from './builder'
import { hostCompileArgs, type PreviewManifest } from './manifest'
import type { BuildPlan } from './plan'
import { hostBundle } from './resources'
import type { ToolchainSelection } from './toolchain'

/**
 * One build of the preview host: the libraries and plan modules into their cached
 * folders, the host bundle with the resources, then the host executable from the host
 * source, the preview declarations and the built modules. `failed` names the module
 * that did not compile ('' when the host itself failed or nothing did).
 */
export async function compileHost(input: {
  root: string
  cacheDir: string
  hostSource: string
  /** The host `.app` folder to create. */
  app: string
  manifest: PreviewManifest
  plan: BuildPlan | null
  prepared: PreparedBuild | null
  toolchain: ToolchainSelection
  moduleCache: string
  /** Absolute files compiled into the host besides its source. */
  sources: string[]
  log: (line: string) => void
}) {
  const { root, plan, prepared, toolchain, moduleCache } = input
  const shared = { compile: prepared?.compile ?? [], link: prepared?.link ?? [] }
  let compiled = await compileModules(moduleInputs(root, input.manifest, plan, prepared), {
    root,
    cacheDir: input.cacheDir,
    toolchainKey: toolchain.key,
    moduleCache,
    env: toolchain.env,
    ...shared,
    salt: prepared?.salt ?? '',
    log: input.log
  })
  const output = hostBundle(input.app, {
    root,
    assets: prepared?.assets ?? '',
    copied: plan?.resources.copied ?? [],
    accentColor: prepared?.accentColor
  })
  const target = prepared ? ['-target', `${ARCH}-apple-macosx${prepared.deploymentTarget}`] : []
  if (compiled.code === 0)
    compiled = {
      ...compiled,
      ...(await run(
        '/usr/bin/xcrun',
        hostCompileArgs({
          host: input.hostSource,
          sources: input.sources,
          moduleCache,
          output,
          libraries: compiled.built,
          flags: [...target, ...shared.compile, ...shared.link]
        }),
        root,
        toolchain.env
      ))
    }
  return { ...compiled, executable: output }
}

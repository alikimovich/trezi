import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeCatAssets } from './native-cat-assets.mjs'
import { bundleBun } from './bundle-bun.mjs'
import { appInfoPlist, serviceInfoPlist } from './service-info.mjs'
import { buildInfo, versionLabel } from './version.mjs'
import { build as bundle } from 'esbuild'
import { MIN_MACOS, requireSupportedPlatform } from './requirements.mjs'
import { describeSigner, designatedRequirement, sign, signingIdentity, signWithFallback } from './signing.mjs'
import { buildProfile, swiftBuilder } from './native-swift.mjs'

requireSupportedPlatform({ sdk: true })
// LKM-175: `release` (-O) unless TREZI_BUILD_PROFILE=test; see scripts/native-swift.mjs.
const profile = buildProfile()
const buildStarted = performance.now()
const seconds = since => `${((performance.now() - since) / 1000).toFixed(1)} s`
const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx${MIN_MACOS}`
const root = fileURLToPath(new URL('../', import.meta.url))
const out = join(root, 'out/native')
const contents = join(out, 'Trezi.app/Contents')
// The retained JS ships inside the app beside its bundled Bun (LKM-111). Its packages
// stay external and resolve up the tree to the checkout's node_modules, and the
// sources' `__dirname/../..` (the checkout root) is kept by pointing `__dirname` at
// out/native, where these bundles were built before.
const backendDir = join(contents, 'Resources/backend')
// LKM-143: package version, commit count and short sha, stamped into both Info.plists
// and both JS bundles (the backend shows it in Settings; `TREZI_VERSION`).
const info = buildInfo(root)
const label = versionLabel(info)
const outDirname = {
  define: { __dirname: '__treziOutDir', TREZI_VERSION: JSON.stringify(label) },
  banner: { js: `// ${label}\nvar __treziOutDir = require("node:path").resolve(__dirname, "../../../..");` }
}
mkdirSync(join(contents, 'MacOS'), { recursive: true })
mkdirSync(join(contents, 'Resources'), { recursive: true })
mkdirSync(join(contents, 'Helpers'), { recursive: true })
copyFileSync(join(root, 'build/icon.icns'), join(contents, 'Resources/Trezi.icns'))
writeFileSync(join(contents, 'Resources/cat.json'), JSON.stringify(nativeCatAssets(root)))
const device = readFileSync(join(root, 'src/shared/iphone-frame.ts'), 'utf8').match(/FRAME_DATA_URI =\s*'([^']+)'/)[1]
writeFileSync(join(out, 'device.png'), Buffer.from(device.split(',')[1], 'base64'))
// The esbuild bundles run next to the Swift compiles below (LKM-175).
const bundles = (async () => {
  const started = performance.now()
  const [backend] = await Promise.all([
    bundle({
      metafile: true,
      entryPoints: [join(root, 'src/native/index.ts')],
      outfile: join(backendDir, 'index.cjs'),
      bundle: true,
      platform: 'node',
      target: 'es2022',
      format: 'cjs',
      packages: 'external',
      sourcemap: true,
      ...outDirname
    }),
    bundle({
      entryPoints: [join(root, 'src/main/backends/provider-helper-entry.ts')],
      outfile: join(backendDir, 'provider-helper.cjs'),
      bundle: true,
      platform: 'node',
      target: 'es2022',
      format: 'cjs',
      packages: 'external',
      sourcemap: true,
      ...outDirname
    }),
    ...[['src/preview/preload.ts', 'preview.js']].map(([input, output]) =>
      bundle({
        entryPoints: [join(root, input)],
        outfile: join(out, output),
        bundle: true,
        platform: 'browser',
        target: 'safari16.4',
        format: 'iife'
      })
    )
  ])
  const inputs = Object.keys(backend.metafile.inputs)
  const externalImports = Object.values(backend.metafile.outputs).flatMap(output => output.imports).filter(item => item.external).map(item => item.path)
  if (inputs.some(path => /src\/renderer\//.test(path)) || externalImports.some(path => /^(electron|electron-vite|react|react-dom|@codemirror)(\/|$)/.test(path))) throw new Error('Native build unexpectedly depends on a retired application runtime')
  writeFileSync(join(out, 'build-inputs.json'), JSON.stringify({ inputs, externalImports }, null, 2))
  console.log(`[build] JS bundles: ${seconds(started)}`)
})()
// Remove stale application UI artifacts from earlier hybrid builds.
rmSync(join(out, 'renderer'), { recursive: true, force: true })
rmSync(join(out, 'preload.js'), { force: true })
// The backend lived beside the app before LKM-111 moved it inside.
for (const name of ['index.cjs', 'index.cjs.map', 'provider-helper.cjs', 'provider-helper.cjs.map']) rmSync(join(out, name), { force: true })
// The bundle was "Trezi Native.app" before LKM-108; don't leave a second app behind.
rmSync(join(out, 'Trezi Native.app'), { recursive: true, force: true })
// Only the current service stays embedded: launchd must not find a service under an
// earlier identifier (LKM-132 renamed it to dev.trezi.service).
const services = join(contents, 'XPCServices')
if (existsSync(services)) for (const name of readdirSync(services)) if (name !== 'dev.trezi.service.xpc') rmSync(join(services, name), { recursive: true, force: true })
writeFileSync(join(contents, 'Info.plist'), appInfoPlist(info))
const serviceContents = join(contents, 'XPCServices/dev.trezi.service.xpc/Contents')
mkdirSync(join(serviceContents, 'MacOS'), { recursive: true })
writeFileSync(join(serviceContents, 'Info.plist'), serviceInfoPlist(info))
writeFileSync(join(out, 'main.swift'), readFileSync(join(root, 'src/native/Host.swift')))
// The three Swift products compile in parallel, each from the binary cache when its
// sources, flags and toolchain are unchanged (LKM-175).
const compile = swiftBuilder({ root, target, profile })
const service = compile('TreziService', [
  ...['ServiceContract', 'ServiceXPC', 'ProductLog', 'LedgerStore', 'OperationLedger', 'PreferencesFile', 'PreferencesOwner', 'WorkspaceFile', 'WorkspaceOwner', 'MemoryFile', 'MemoryOwner', 'DomainChannel', 'BackendSupervisor', 'ProcessGuardian', 'ManagedProcess', 'RuntimeNet', 'RuntimeDetect', 'StaticSite', 'StaticServer', 'RuntimeServer', 'RuntimeOwner', 'RepositoryGit', 'GitMessages','RepositoryJournal', 'RepositoryEffects', 'RepositoryLanding', 'RepositoryCleanup', 'RepositoryMerge', 'RepositoryOwner', 'SourcePaths', 'SourceJournal', 'SourceHistory', 'SourceStore', 'SourceDrafts', 'SourceOwner', 'ConversationState', 'ConversationStore', 'ConversationOwner', 'ProviderPolicy', 'ProviderStore', 'ProviderHelper', 'ProviderFrames', 'ProviderData', 'ProviderLaunch', 'ProviderOwner', 'EditingIslands', 'EditingStores', 'EditingProject', 'EditingLegacyNames', 'EditingOwner', 'WorkflowJournal', 'WorkflowContext', 'WorkflowOwner', 'WorkflowPublish', 'WorkflowRemote', 'WorkflowSetup', 'WorkflowTools', 'PlatformTools', 'PlatformOpen', 'PlatformMedia', 'SimulatorTools', 'SimulatorBridge', 'SimulatorOwner', 'PlatformOwner', 'ProfilePaths', 'ServiceRuntime', 'ServiceMain'].map(name => join(root, `src/service/${name}.swift`)),
  '-o', join(serviceContents, 'MacOS/TreziService'), '-framework', 'Foundation', '-framework', 'Security', '-framework', 'CoreServices'
]).then(built => {
  copyFileSync(join(serviceContents, 'MacOS/TreziService'), join(out, 'TreziService'))
  return built
})
const host = compile(
  'TreziHost',
  [
    join(out, 'main.swift'),
    join(root, 'src/service/ServiceContract.swift'),
    join(root, 'src/service/ServiceXPC.swift'),
    join(root, 'src/service/ProductLog.swift'),
    join(root, 'src/native/ServiceClient.swift'),
    join(root, 'src/native/HostService.swift'),
    join(root, 'src/native/HostLaunch.swift'),
    join(root, 'src/native/HostMenus.swift'),
    join(root, 'src/native/HostLogs.swift'),
    join(root, 'src/native/HostInspect.swift'),
    join(root, 'src/native/SecuritySession.swift'),
    join(root, 'src/native/Shell.swift'),
    join(root, 'src/native/ProjectCell.swift'),
    join(root, 'src/native/SidebarVerification.swift'),
    join(root, 'src/native/SidebarSizing.swift'),
    join(root, 'src/native/SidebarFocus.swift'),
    join(root, 'src/native/SidebarIcon.swift'),
    join(root, 'src/native/SourceList.swift'),
    join(root, 'src/native/PreviewSurface.swift'),
    join(root, 'src/native/PreviewCover.swift'),
    join(root, 'src/native/PreviewAgent.swift'),
    join(root, 'src/native/ToolbarLayout.swift'),
    join(root, 'src/native/ToolbarAddress.swift'),
    join(root, 'src/native/Inspector.swift'),
    join(root, 'src/native/Composer.swift'),
    join(root, 'src/native/ComposerVerification.swift'),
    join(root, 'src/native/ComposerAttachments.swift'),
    join(root, 'src/native/AttachmentThumbnail.swift'),
    join(root, 'src/native/ChatAttachments.swift'),
    join(root, 'src/native/ComposerQueue.swift'),
    join(root, 'src/native/ComposerBeam.swift'),
    join(root, 'src/native/Chat.swift'),
    join(root, 'src/native/ChatCommentRow.swift'),
    join(root, 'src/native/ChatCommentCapture.swift'),
    join(root, 'src/native/ChatScrollStyle.swift'),
    join(root, 'src/native/ChatLatestButton.swift'),
    join(root, 'src/native/ChatEnvironment.swift'),
    join(root, 'src/native/ChatReveal.swift'),
    join(root, 'src/native/ChatAcceptance.swift'),
    join(root, 'src/native/SmokeFocus.swift'),
    join(root, 'src/native/ScrollerDrag.swift'),
    join(root, 'src/native/VisibleChatCapture.swift'),
    join(root, 'src/native/ChatIsland.swift'),
    join(root, 'src/native/IslandEditing.swift'),
    join(root, 'src/native/ShadowIsland.swift'),
    join(root, 'src/native/ChatActivity.swift'),
    join(root, 'src/native/ChatActivityClock.swift'),
    join(root, 'src/native/StreamingText.swift'),
    join(root, 'src/native/Cat.swift'),
    join(root, 'src/native/Welcome.swift'),
    join(root, 'src/native/Sheets.swift'),
    join(root, 'src/native/SheetSections.swift'),
    join(root, 'src/native/SheetSidebar.swift'),
    join(root, 'src/native/SheetVerification.swift'),
    join(root, 'src/native/SheetAlert.swift'),
    join(root, 'src/native/Toast.swift'),
    join(root, 'src/native/Activity.swift'),
    join(root, 'src/native/ActivityIndicator.swift'),
    join(root, 'src/native/SourceEditor.swift'),
    join(root, 'src/native/SourceFileTree.swift'),
    join(root, 'src/native/FloatingIsland.swift'),
    join(root, 'src/native/IslandLayout.swift'),
    join(root, 'src/native/IslandVerification.swift'),
    join(root, 'src/native/Layers.swift'),
    join(root, 'src/native/LayersLayout.swift'),
    join(root, 'src/native/LayersVerification.swift'),
    join(root, 'src/native/EditingInspector.swift'),
    join(root, 'src/native/InspectorIslandVerification.swift'),
    join(root, 'src/native/PreviewPlatform.swift'),
    join(root, 'src/native/WorkspaceLayout.swift'),
    join(root, 'src/native/PreviewStatus.swift'),
    join(root, 'src/native/ChatDivider.swift'),
    join(root, 'src/native/ChatMarkdown.swift'),
    join(root, 'src/native/ChatQuestion.swift'),
    join(root, 'src/native/SnappedSlider.swift'),
    '-o',
    join(contents, 'MacOS/TreziHost'),
    '-framework',
    'AppKit',
    '-framework',
    'WebKit',
    '-framework',
    'Security',
    '-framework',
    'CryptoKit',
    '-framework',
    'AVKit'
  ]
)
// The Keychain helper is its own small executable (src/native/Secrets.swift) so that it
// compiles to the same bytes on every rebuild and keeps the user's Keychain approval.
// It is always the release build, so a test build produces the same bytes too.
const secrets = compile('TreziSecrets', [
  '-suppress-warnings', join(root, 'src/native/Secrets.swift'), '-o', join(contents, 'Helpers/TreziSecrets'), '-framework', 'Security', '-framework', 'CryptoKit'
], { profile: 'release' })
const steps = await Promise.allSettled([bundles, service, host, secrets])
rmSync(join(out, 'swift-tmp'), { recursive: true, force: true })
const failed = steps.find(step => step.status === 'rejected')
if (failed) {
  if (!(failed.reason?.code > 0)) console.error(failed.reason)
  process.exit(failed.reason?.code > 0 ? failed.reason.code : 1)
}
// One stable identity for every piece (LKM-137), so Keychain and privacy grants survive
// rebuilds. Test builds use an existing identity but never create one.
// A chosen identity that cannot sign (locked login keychain over SSH, denied key access, a
// deleted certificate) re-signs every piece ad hoc with the one warning: a build that
// worked before identities still works.
const signStarted = performance.now()
let signer
try {
  signer = signWithFallback(signingIdentity({ create: process.env.TREZI_SIGN_CREATE !== '0' }), current => {
    bundleBun(contents, { signer: current })
    for (const [path, identifier] of [
      [join(contents, 'Helpers/TreziSecrets'), 'dev.trezi.secrets'],
      [join(out, 'TreziService'), 'dev.trezi.service'],
      [join(contents, 'XPCServices/dev.trezi.service.xpc'), 'dev.trezi.service'],
      [join(out, 'Trezi.app'), 'dev.praxis.native']
    ]) sign(current, path, identifier)
  })
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
console.log(`[build] Bun copy and signing: ${seconds(signStarted)}`)
console.log(`Signed Trezi: ${describeSigner(signer)}${designatedRequirement(signer, 'dev.praxis.native') ? `, ${designatedRequirement(signer, 'dev.praxis.native')}` : ''}`)
if (/require\(["']electron["']\)/.test(readFileSync(join(backendDir, 'index.cjs'), 'utf8')))
  throw new Error('Native backend still imports Electron')
console.log(`[build] total: ${seconds(buildStarted)} (${profile} profile)`)
console.log(
  `Built ${label}${profile === 'release' ? '' : ` (${profile} profile, -Onone)`}: Swift/AppKit UI, Bun services (bundled Bun), isolated WebKit project preview. Start it with open -a Trezi or trezi.`
)

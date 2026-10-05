import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// Compiles the islands' live-write and typed-entry policy (IslandEditing.swift) without a window.
if (process.platform !== 'darwin') {
  console.log('NATIVE-ISLAND-EDITING SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('island-editing', [
    'test/fixtures/island-editing/main.swift',
    'src/native/IslandEditing.swift'
  ])
  console.log(runFixture(binary).trim())
}

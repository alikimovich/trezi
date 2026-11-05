import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('PUBLISH TOOLBAR SKIP — macOS required')
} else {
  const binary = swiftBuild('publish-toolbar', [
    'test/fixtures/publish-toolbar/main.swift',
    'src/native/ToolbarPublish.swift'
  ])
  console.log(runFixture(binary).trim())
}

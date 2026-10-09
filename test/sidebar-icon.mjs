import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-ICON SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-icon', [
    'test/fixtures/sidebar-icon/main.swift',
    'src/native/SidebarIcon.swift'
  ])
  console.log(runFixture(binary).trim())
}

import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-FAVICON SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-favicon', [
    'test/fixtures/sidebar-favicon/main.swift',
    'src/native/SidebarIcon.swift',
    'src/native/SourceList.swift'
  ])
  console.log(runFixture(binary).trim())
}

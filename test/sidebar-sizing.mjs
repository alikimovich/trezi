import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-SIZING SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-sizing', [
    'test/fixtures/sidebar-sizing/main.swift',
    'src/native/SidebarSizing.swift'
  ])
  console.log(runFixture(binary).trim())
}

import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('NATIVE-SETTINGS-LAYOUT SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('settings-layout', [
    'test/fixtures/settings-layout/main.swift',
    ...[
      'Sheets',
      'SheetSections',
      'SheetSidebar',
      'SheetVerification',
      'SheetAlert',
      'SourceList',
      'SidebarIcon'
    ].map((name) => `src/native/${name}.swift`)
  ])
  console.log(runFixture(binary).trim())
}

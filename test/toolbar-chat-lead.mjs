import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-356: right after a sidebar width set without animation, the chat header was sized from
// its frame before the split moved and pushed the address block into the overflow menu.
if (process.platform !== 'darwin') {
  console.log('TOOLBAR-CHAT-LEAD SKIP — macOS required')
} else {
  const binary = swiftBuild('toolbar-chat-lead', [
    'test/fixtures/toolbar-chat-lead/main.swift',
    'src/native/ToolbarChatLead.swift'
  ])
  console.log(runFixture(binary).trim())
}

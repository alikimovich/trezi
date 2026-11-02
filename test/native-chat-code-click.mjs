// LKM-431: one click on inline or fenced code copies the raw code, and only a single
// click on real code does, through real window events and NSTextView's tracking loop.
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-CODE-CLICK SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('chat-code-click', [
    'test/fixtures/chat-code-click/main.swift',
    'src/native/ChatRichText.swift',
    'src/native/ChatTextView.swift'
  ])
  console.log(runFixture(binary).trim())
}

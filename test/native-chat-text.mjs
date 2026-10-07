// LKM-186: an assistant segment renders in one text view, so selection, Select All and
// Copy span its paragraphs, lists, headings, tables and code blocks.
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-TEXT SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('chat-text', [
    'test/fixtures/chat-text/main.swift',
    'src/native/ChatRichText.swift',
    'src/native/ChatTextView.swift'
  ])
  console.log(runFixture(binary).trim())
}

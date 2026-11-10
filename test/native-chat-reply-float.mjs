// LKM-627: the selected-text Reply floats over the transcript, clear of every line of text,
// in a real window: the reported wrapped two-line message between its neighbours, a real
// press through hit-testing, scrolling out of and back into view, and a chat switch.
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-REPLY-FLOAT SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('chat-reply-float', [
    'test/fixtures/chat-reply-float/main.swift',
    'src/native/ChatRichText.swift',
    'src/native/ChatTextView.swift',
    'src/native/ChatTextReply.swift'
  ])
  console.log(runFixture(binary).trim())
}

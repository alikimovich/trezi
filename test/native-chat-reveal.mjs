import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// Compiles the host's pure reveal-acknowledgement logic without a window.
if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-REVEAL SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('chat-reveal', [
    'test/fixtures/chat-reveal/main.swift',
    'src/native/ChatReveal.swift'
  ])
  console.log(runFixture(binary).trim())
}

import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// Swift decoding and validation of answer components (LKM-208).
if (process.platform !== 'darwin') {
  console.log('CHAT-UI-MODEL SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('chat-ui-model', [
    'test/fixtures/chat-ui-model/main.swift',
    'src/native/ChatUiModel.swift'
  ])
  console.log(runFixture(binary).trim())
}

import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LOCAL-WEBKIT-PUBLISH: the routing that decides which navigation answers an agent open.
if (process.platform !== 'darwin') {
  console.log('AGENT-LOAD-ROUTING SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('agent-load-routing', [
    'test/fixtures/agent-load-routing/main.swift',
    'src/native/AgentLoadRouting.swift'
  ])
  console.log(runFixture(binary).trim())
}

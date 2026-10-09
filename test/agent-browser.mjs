import assert from 'node:assert/strict'
import {
  agentBrowser,
  agentBrowserCount,
  closeAgentBrowser,
  registerChromiumBrowser
} from '../src/main/agent-browser.ts'

const made = []
registerChromiumBrowser(async (key, root) => {
  const browser = {
    id: key,
    root,
    url: null,
    navigation: 0,
    servedRevision: null,
    speed: 1,
    host: {},
    async capture() {
      return null
    },
    async setSpeed(speed) {
      this.speed = speed
    },
    async step() {
      this.speed = 0
    },
    async open(path) {
      this.url = `http://localhost:3000${path}`
      this.navigation++
      return { url: this.url, loaded: true, identity: await this.identity() }
    },
    async identity() {
      return {
        session: this.id,
        navigation: this.navigation,
        servedRevision: null,
        liveRevision: null,
        documentStartedAt: null,
        stale: false
      }
    },
    async close() {
      made.push(`closed:${key}`)
    }
  }
  made.push(key)
  return browser
})

const [a, b, c] = await Promise.all([
  agentBrowser('a', '/repo', 'chromium'),
  agentBrowser('b', '/repo', 'chromium'),
  agentBrowser('c', '/repo', 'chromium')
])
assert.equal(agentBrowserCount(), 3)
await assert.rejects(agentBrowser('d', '/repo', 'chromium'), /limit \(3\)/)
assert.strictEqual(
  await agentBrowser('a', '/repo', 'chromium'),
  a,
  'same session reuses its browser'
)
await Promise.all([a.open('/one'), b.open('/two')])
assert.equal(a.url, 'http://localhost:3000/one')
assert.equal(b.url, 'http://localhost:3000/two')
assert.equal(c.url, null)
await closeAgentBrowser('chromium:a')
await closeAgentBrowser('chromium:b')
await closeAgentBrowser('chromium:c')
assert.equal(agentBrowserCount(), 0)
assert.deepEqual(made.slice(3).sort(), ['closed:a', 'closed:b', 'closed:c'])
registerChromiumBrowser(null)
await assert.rejects(agentBrowser('a', '/repo', 'chromium'), /unavailable/)
console.log('AGENT-BROWSER OK — session isolation, cap, reuse, cleanup and Chromium adapter stub')

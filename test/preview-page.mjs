import assert from 'node:assert/strict'
import { previewServers } from '../src/main/preview-evidence.ts'
import { observeAgentPreview } from '../src/main/preview-observation-tools.ts'
import { previewPage } from '../src/main/preview-page.ts'
import { registerPreviewSource } from '../src/main/preview-state.ts'
import { projectKey } from '../src/shared/projectKey.ts'

// LKM-199: route, DOM and screenshot describe one page, the user's preview, named with its
// port and route; a chat's tools never describe a page another server is showing.
const root = '/fixture/lkmv'
const jpeg = Buffer.from('jpeg')
const image = {
  isEmpty: () => false,
  getSize: () => ({ width: 800, height: 600 }),
  resize: () => image,
  toJPEG: () => jpeg
}
let viewUrl = 'http://127.0.0.1:7777/projects'
let pageHref = 'http://127.0.0.1:7777/portfolio'
const evaluated = []
registerPreviewSource({
  getUrl: () => viewUrl,
  capture: async () => image,
  agent: {
    evaluate: async (code, world) => {
      evaluated.push([code, world])
      if (code === 'location.href') return pageHref
      return { element: '<main>', path: new URL(pageHref).pathname }
    },
    captureRect: async () => null,
    setViewport: async () => ({ width: null, zoom: 1 })
  }
})
previewServers.set(projectKey(root), { url: 'http://127.0.0.1:7777/', pid: 1 })
const texts = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text)

// The page's own location wins over a view URL that missed an SPA navigation.
const location = await observeAgentPreview('preview_location', {}, root)
assert.match(texts(location)[0], /127\.0\.0\.1:7777\/portfolio \(port 7777, route \/portfolio\)/)
const shot = await observeAgentPreview('preview_screenshot', {}, root)
assert.equal(shot.content[0].type, 'image')
assert.equal(
  texts(shot).at(-1),
  'Preview page: http://127.0.0.1:7777/portfolio (port 7777, route /portfolio).'
)
const inspected = await observeAgentPreview('preview_inspect', { selector: 'main' }, root)
assert.match(texts(inspected)[0], /portfolio/)
assert.equal(texts(inspected).at(-1), texts(shot).at(-1), 'Every tool names the same page')

// The preview shows another server (another project, an old port): every tool refuses.
pageHref = 'http://127.0.0.1:7779/projects'
viewUrl = pageHref
for (const action of ['preview_location', 'preview_screenshot', 'preview_inspect']) {
  const refused = await observeAgentPreview(action, { selector: 'main' }, root)
  assert.equal(refused.isError, true, action)
  assert.equal(refused.content.length, 1)
  assert.match(
    refused.content[0].text,
    /shows http:\/\/127\.0\.0\.1:7779\/projects \(port 7779\), not this project's dev server http:\/\/127\.0\.0\.1:7777 \(port 7777\)/
  )
  assert.match(refused.content[0].text, /open_preview/)
}
const before = evaluated.length
await observeAgentPreview('preview_inspect', { selector: 'main' }, root)
assert.deepEqual(
  evaluated.slice(before).map(([code]) => code),
  ['location.href'],
  'A refused tool never inspects the other page'
)

// Without a known server (stopped, or no chat) the page is still named, never refused.
assert.equal((await previewPage('/fixture/other')).refusal, undefined)
assert.equal((await previewPage()).page.port, '7779')
// The page cannot answer (loading): the view URL names it.
registerPreviewSource({ getUrl: () => 'https://example.test/a?b#c', capture: async () => null })
const fallback = (await previewPage()).page
assert.deepEqual({ port: fallback.port, route: fallback.route }, { port: '443', route: '/a?b#c' })
console.log('preview-page: OK')

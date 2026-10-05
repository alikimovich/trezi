import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPreviewAgentTool } from '../main/preview-agent-tools'
import { waitFor } from './smoke-wait'

type Page = (code: string) => Promise<unknown>
const SHADOW = 'rgb(255, 0, 0) 0px 4px 12px 0px'
const CARD = 'agent-preview-card'

/**
 * LKM-138: the agent's preview tools against the real WebKit preview, through the same
 * path the Claude and Codex tools take (`runPreviewAgentTool`). The fixture element and
 * page error are added in the page world; every tool runs in an isolated world.
 */
export async function checkAgentPreview(page: Page, artifacts: string) {
  const textOf = (result: Awaited<ReturnType<typeof runPreviewAgentTool>>) =>
    result.content.find((c) => c.type === 'text')?.text ?? ''
  const json = async (action: Parameters<typeof runPreviewAgentTool>[0], args: unknown) => {
    const result = await runPreviewAgentTool(action, args)
    assert.notEqual(result.isError, true, `${action}: ${textOf(result)}`)
    return JSON.parse(textOf(result))
  }
  const evidence: Record<string, unknown> = {}
  await page(`(() => {
    const card = document.createElement('div'); card.id = ${JSON.stringify(CARD)};
    card.style.cssText = 'box-shadow: ${SHADOW}; width: 120px; height: 60px; margin: 24px; background: #fff';
    document.body.append(card);
    console.error('agent-console-fixture: logged');
    const script = document.createElement('script');
    script.textContent = "throw new Error('agent-console-fixture: thrown')";
    document.body.append(script);
    return true
  })()`)

  // Inspect: the known element's box-shadow, box and source-free identity.
  const inspected = await json('preview_inspect', { selector: `#${CARD}` })
  assert.equal(inspected.styles['box-shadow'], SHADOW, 'inspect returns the computed box-shadow')
  assert.equal(Math.round(inspected.rect.width), 120)
  assert.equal(Math.round(inspected.rect.height), 60)
  evidence.inspect = inspected

  // Evaluate: DOM reads work; writes, navigation, storage, oversized and slow results do not.
  const read = await json('preview_evaluate', {
    expression: `document.querySelector('#${CARD}').getBoundingClientRect().width`
  })
  assert.equal(Math.round(read.value), 120)
  const before = await page(
    'JSON.stringify([document.title, location.href, document.body.childElementCount])'
  )
  const rejected: Record<string, string> = {}
  for (const [expression, pattern] of [
    ["document.title = 'changed by agent'", /read-only/],
    [`document.querySelector('#${CARD}').remove()`, /not a read-only call/],
    ["location.href = 'about:blank'", /read-only/],
    ['location.reload()', /not a read-only call/],
    ["localStorage.setItem('agent', '1')", /localStorage is not available/],
    ["Array.from({ length: 100 }, () => 'x'.repeat(3000))", /Result too large/],
    ['new Promise(() => {})', /Timed out/],
    ['(() => { for (;;) {} })()', /loops cannot run/]
  ] as const) {
    const result = await runPreviewAgentTool('preview_evaluate', { expression })
    assert.equal(result.isError, true, `${expression} must be rejected`)
    assert.match(textOf(result), pattern, expression)
    rejected[expression] = textOf(result)
  }
  assert.equal(
    await page('JSON.stringify([document.title, location.href, document.body.childElementCount])'),
    before,
    'evaluate changed nothing'
  )
  evidence.rejected = rejected

  // Console: the page error and the console.error call were captured.
  let logged = ''
  await waitFor(
    async () => {
      logged = textOf(await runPreviewAgentTool('preview_console', { errorsOnly: true }))
      return (
        logged.includes('agent-console-fixture: thrown') &&
        logged.includes('agent-console-fixture: logged')
      )
    },
    'console captures the page error',
    5000,
    async () => ({ console: logged.slice(0, 1500) })
  )
  assert.match(logged, /"pageerror"/)
  evidence.console = logged

  // Viewport: a preset changes the CSS width, restore brings the original back.
  const original = (await page('innerWidth')) as number
  const mobile = await json('preview_viewport', { preset: 'mobile' })
  assert.equal(mobile.innerWidth, 390, 'the mobile preset lays the page out at 390 CSS px')
  const tablet = await json('preview_viewport', { width: 768 })
  assert.equal(tablet.innerWidth, 768)
  const restored = await json('preview_viewport', { restore: true })
  assert.ok(
    Math.abs(restored.innerWidth - original) <= 1,
    `restore returns to ${original} CSS px (got ${restored.innerWidth})`
  )
  evidence.viewport = { original, mobile, tablet, restored }

  // Element screenshot: an image bounded to the element (plus padding), not the whole page.
  const shot = await runPreviewAgentTool('preview_screenshot', { selector: `#${CARD}`, padding: 0 })
  const image = shot.content.find((c) => c.type === 'image')
  assert.ok(image && image.type === 'image', `element screenshot: ${textOf(shot)}`)
  const meta = JSON.parse(textOf(shot))
  assert.equal(Math.round(meta.crop.width), 120)
  assert.equal(Math.round(meta.crop.height), 60)
  const scale = meta.pixels.width / meta.crop.width
  assert.ok(scale >= 0.9 && scale <= 3.1, `capture scale ${scale}`)
  assert.ok(
    Math.abs(meta.pixels.height / scale - meta.crop.height) <= 2,
    'the capture height matches the element'
  )
  assert.ok(meta.pixels.width < original * scale * 0.5, 'the capture is the element, not the page')
  writeFileSync(join(artifacts, 'agent-preview-element.png'), Buffer.from(image.data, 'base64'))
  evidence.screenshot = meta
  writeFileSync(join(artifacts, 'agent-preview.json'), JSON.stringify(evidence, null, 2))
  console.log(
    'Native agent preview tools: inspect box-shadow, read-only bounded evaluate, console page error, viewport width/restore and element-cropped screenshot.'
  )
}

/** Leave the preview as the other checks expect it. */
export async function restoreAgentPreview(page: Page) {
  await runPreviewAgentTool('preview_viewport', { restore: true }).catch(() => {})
  await page(
    `(() => { document.getElementById(${JSON.stringify(CARD)})?.remove(); return true })()`
  ).catch(() => {})
}

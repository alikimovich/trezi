import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentBrowser, agentBrowserCount, closeAgentBrowser } from '../main/agent-browser'
import { runPreviewAgentTool } from '../main/preview-agent-tools'
import { bridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

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
  const active = nativeWorkspace.active
  assert.ok(active, 'an open project for the private browser')
  const visible = () =>
    page(
      'JSON.stringify({url:location.href,width:innerWidth,x:scrollX,y:scrollY,selection:getSelection()?.toString(),focus:document.hasFocus()})'
    )
  const priorScroll = (await page('JSON.stringify({x:scrollX,y:scrollY})')) as string
  await page(
    '(() => { getSelection()?.selectAllChildren(document.body); scrollTo(0, 40); return true })()'
  )
  const beforePrivate = await visible()
  const first = await agentBrowser('native-agent-a', active.root)
  const second = await agentBrowser('native-agent-b', active.root)
  try {
    const [a, b] = await Promise.all([first.open('/?agent=a'), second.open('/?agent=b')])
    assert.match(a.url, /agent=a/)
    assert.match(b.url, /agent=b/)
    // reload_preview: the same route loads again (soft and hard) instead of returning early.
    const loads = first.navigation
    await first.open('/?agent=a', { reload: true })
    assert.equal(first.navigation, loads + 1, 'a soft reload navigates the agent browser again')
    await first.open('/?agent=a', { reload: true, hard: true })
    assert.equal(first.navigation, loads + 2, 'a hard reload navigates the agent browser again')
    await first.host.setViewport(390)
    const width = await first.host.evaluate('innerWidth', 'preview', 1000)
    assert.equal(width, 390)
    assert.notEqual(await second.host.evaluate('innerWidth', 'preview', 1000), 390)
    const frame = await first.capture()
    assert.ok(frame?.jpeg.length, 'offscreen WebKit snapshot')
    const measure = async (run: () => Promise<unknown>) => {
      const samples: number[] = []
      for (let i = 0; i < 5; i++) {
        const at = performance.now()
        await run()
        samples.push(performance.now() - at)
      }
      return samples.sort((x, y) => x - y)[2]
    }
    const readMs = await measure(() => first.host.evaluate('document.title', 'preview', 1000))
    const screenshotMs = await measure(() => first.capture())
    assert.ok(readMs < 150, `agent browser DOM read ${Math.round(readMs)} ms < 150 ms`)
    assert.ok(
      screenshotMs < 400,
      `agent browser screenshot ${Math.round(screenshotMs)} ms < 400 ms`
    )
    await first.setSpeed(0.25)
    await first.step(2)
    assert.equal(first.speed, 0)
    await first.setSpeed(1)
    await agentBrowser('native-agent-c', active.root)
    try {
      await assert.rejects(agentBrowser('native-agent-d', active.root), /limit \(3\)/)
      assert.equal(agentBrowserCount(), 3)
    } finally {
      await closeAgentBrowser('webkit:native-agent-c')
    }
    evidence.privateBrowser = {
      first: a.url,
      second: b.url,
      width,
      screenshot: frame && [frame.width, frame.height],
      readMs,
      screenshotMs
    }
  } finally {
    await closeAgentBrowser('webkit:native-agent-a')
    await closeAgentBrowser('webkit:native-agent-b')
  }
  assert.equal(
    await visible(),
    beforePrivate,
    'agent navigation, resize and snapshot preserve the user preview and focus'
  )
  const restoreScroll = JSON.parse(priorScroll) as { x: number; y: number }
  await page(
    `(() => { getSelection()?.removeAllRanges(); scrollTo(${restoreScroll.x}, ${restoreScroll.y}); return true })()`
  )
  assert.equal(await bridge().request('agentRevealTest', { idleSeconds: 0 }), false)
  assert.equal(await bridge().request('previewRevealAllowed'), false)
  assert.equal(await bridge().request('agentRevealTest', { idleSeconds: 6 }), true)
  assert.equal(await bridge().request('previewRevealAllowed'), true)
  await bridge().request('agentRevealTest', { idleSeconds: 0 })
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

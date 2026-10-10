import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentBrowser, closeAgentBrowser } from '../main/agent-browser'
import { parseInteraction, runAgentInteraction } from '../main/agent-interact'
import { nativeWorkspace } from './workspace-runtime'

type Page = (code: string) => Promise<unknown>
const SESSION = 'native-agent-interact'
/** What the user's preview shows and has received; no agent interaction may change it. */
const USER_STATE =
  'JSON.stringify({url:location.href,x:scrollX,y:scrollY,inputs:(window.previewInputs||[]).length,focus:document.activeElement&&document.activeElement.tagName,title:document.title})'

/**
 * LKM-230: `preview_interact` against the real offscreen WebKit agent browser, through
 * the same calls the session tool makes. The fixture's filter shows its card only after
 * the click; uploads, downloads, off-origin links and external form posts are refused in
 * the page, and script navigations, script form posts and undisplayable responses are
 * cancelled by the host. The user's preview is compared before and after.
 */
export async function checkAgentInteract(page: Page, artifacts: string) {
  const active = nativeWorkspace.active
  assert.ok(active, 'an open project for the agent browser')
  const userBefore = await page(USER_STATE)
  const browser = await agentBrowser(SESSION, active.root)
  const read = (code: string) => browser.host.evaluate(code, 'preview', 2000)
  const act = async (args: Record<string, unknown>) => {
    const request = parseInteraction(args)
    assert.ok(!('error' in request), `${JSON.stringify(args)}: ${JSON.stringify(request)}`)
    const result = await runAgentInteraction(browser, request)
    const text = result.content.find((c) => c.type === 'text')
    const image = result.content.find((c) => c.type === 'image')
    assert.ok(text?.type === 'text', 'every interaction answers with a JSON report')
    return { result, report: JSON.parse(text.text), image: image?.type === 'image' ? image : null }
  }
  const evidence: Record<string, unknown> = {}
  try {
    const opened = await browser.open('/filter.html')
    assert.equal(opened.loaded, true, 'the agent browser loads the fixture')
    assert.equal(await read(`!!document.querySelector('#design-card:not([hidden])')`), false)

    // The filter: the click shows the design card, with the URL, no errors and a screenshot.
    const filtered = await act({ action: 'click', selector: '#filter-design' })
    assert.notEqual(filtered.result.isError, true, JSON.stringify(filtered.report))
    assert.equal(filtered.report.ok, true)
    assert.match(filtered.report.url, /\/filter\.html$/)
    assert.deepEqual(filtered.report.consoleErrors, [])
    assert.equal(filtered.report.navigated, false)
    assert.ok(filtered.image?.data.length, 'the click returns a small screenshot')
    writeFileSync(
      join(artifacts, 'agent-interact-filter.jpg'),
      Buffer.from(filtered.image.data, 'base64')
    )
    const card = await act({ action: 'wait', selector: '#design-card', timeoutMs: 2000 })
    assert.equal(card.report.ok, true, 'the filtered card appears')
    assert.equal(await read(`document.querySelector('#status').textContent`), 'Showing design')
    const idle = await act({ action: 'wait', networkIdle: true, screenshot: false })
    assert.equal(idle.report.ok, true, JSON.stringify(idle.report))
    assert.match(String(await read(`document.querySelector('#loaded').textContent`)), /^loaded \d/)
    const bySource = await act({ action: 'click', source: 'filter.html:10', screenshot: false })
    assert.match(bySource.report.element ?? '', /filter-code/, 'a source stamp names the element')
    evidence.filter = { clicked: filtered.report, waited: card.report, idle: idle.report }

    // Type, select, hover and scroll reach the page's own handlers.
    await act({ action: 'type', selector: '#search', text: 'tokens', screenshot: false })
    assert.equal(await read(`document.querySelector('#echo').textContent`), 'tokens')
    await act({ action: 'select', selector: '#sort', option: 'Oldest', screenshot: false })
    assert.equal(await read(`document.querySelector('#sort-status').textContent`), 'old')
    await act({ action: 'hover', selector: '#hover-target', screenshot: false })
    assert.equal(await read(`document.querySelector('#hover-status').textContent`), 'hovered')
    const scrolled = await act({
      action: 'scroll',
      selector: '#scroller',
      deltaY: 120,
      screenshot: false
    })
    assert.ok(
      scrolled.report.to?.y > 0,
      `the inner scroller moved: ${JSON.stringify(scrolled.report)}`
    )

    // Refused in the page before any event.
    const refused: Record<string, unknown> = {}
    for (const [selector, kind] of [
      ['#upload', 'upload'],
      ['#download-link', 'download'],
      ['#external-link', 'navigation'],
      ['#external-submit', 'form']
    ] as const) {
      const { result, report } = await act({ action: 'click', selector, screenshot: false })
      assert.equal(result.isError, true, `${selector} is refused`)
      assert.equal(report.refused, kind, `${selector}: ${JSON.stringify(report)}`)
      assert.match(report.url, /\/filter\.html$/, `${selector} stays on the page`)
      refused[selector] = report.error
    }
    const typedFile = await act({
      action: 'type',
      selector: '#upload',
      text: '/etc/hosts',
      screenshot: false
    })
    assert.equal(typedFile.report.refused, 'upload', 'typing a path into a file input is refused')

    // Cancelled by the host: page scripts that leave, post off-origin or download.
    for (const [selector, reason] of [
      ['#js-leave', 'navigation'],
      ['#js-post', 'form'],
      ['#binary-link', 'download']
    ] as const) {
      const { result, report } = await act({ action: 'click', selector, screenshot: false })
      assert.equal(result.isError, true, `${selector} is blocked: ${JSON.stringify(report)}`)
      assert.ok(
        report.blocked?.some(
          (b: { phase: string; reason?: string }) => b.phase === 'blocked' && b.reason === reason
        ),
        `${selector} reports a blocked ${reason}: ${JSON.stringify(report)}`
      )
      assert.match(report.url, /\/filter\.html$/, `${selector} stays on the page`)
      refused[selector] = report.blocked
    }
    assert.match(String(await read('location.href')), /\/filter\.html$/)
    evidence.refused = refused

    // A same-origin form still submits: Enter navigates and the answer waits for the load.
    await act({ action: 'type', selector: '#q', text: 'cards', screenshot: false })
    const before = browser.navigation
    const submitted = await act({ action: 'press', selector: '#q', key: 'Enter' })
    assert.equal(submitted.report.navigated, true, JSON.stringify(submitted.report))
    assert.match(submitted.report.url, /\/filter\.html\?q=cards$/)
    assert.ok(browser.navigation > before)
    evidence.submitted = submitted.report
  } finally {
    await closeAgentBrowser(`webkit:${SESSION}`)
  }
  assert.equal(
    await page(USER_STATE),
    userBefore,
    "agent interactions leave the user's preview unchanged"
  )
  evidence.userPreview = userBefore
  writeFileSync(join(artifacts, 'agent-interact.json'), JSON.stringify(evidence, null, 2))
  console.log(
    'Native agent interaction: filter click shows its card; type, select, hover, scroll, wait; uploads, downloads, off-origin navigation and external forms refused; user preview unchanged.'
  )
}

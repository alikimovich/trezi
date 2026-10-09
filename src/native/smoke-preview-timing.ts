import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasUnlandedWork } from '../main/chat-status'
import { runPreviewAgentTool } from '../main/preview-agent-tools'
import { previewServers } from '../main/preview-evidence'
import { previewLoads } from '../main/preview-loads'
import { observeAgentPreview } from '../main/preview-observation-tools'
import { capturePreview, previewAgentHost } from '../main/preview-state'
import { openAgentPreview } from '../main/preview-tools'
import { timedToolCall } from '../main/tool-timing'
import { projectKey } from '../shared/projectKey'
import { serviceEvents } from './platform'
import { nativeWorkspace } from './workspace-runtime'

type Page = (code: string) => Promise<unknown>
const RUNS = 5
/** LKM-200 targets (ms): the median must meet them, no run may take twice as long. */
export const PREVIEW_TARGETS = {
  preview_screenshot: 400,
  preview_inspect: 150,
  preview_viewport: 800,
  open_preview: 300
} as const

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]
const round = (values: number[]) => values.map((ms) => Math.round(ms))

/** The pre-LKM-200 paths, timed for the PROGRESS before/after record only. */
async function legacyScreenshot() {
  const image = await capturePreview()
  return image?.toJPEG(70).length ?? 0
}
async function legacyViewport(width: number | null) {
  const host = previewAgentHost()!
  await host.setViewport(width)
  const code = 'new Promise((r) => requestAnimationFrame(() => r({ innerWidth, innerHeight })))'
  for (let i = 0; i < 20; i++) {
    const size = (await host.evaluate(code, 'preview', 2000)) as { innerWidth: number } | null
    if (width === null || Math.abs((size?.innerWidth ?? 0) - width) <= 1) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * LKM-200: the agent's preview tools against the real WebKit preview, each timed through
 * the same `timedToolCall` wrapper the provider tools use (so the product log carries
 * their phases), with the median held to its target. A viewport change and a screenshot
 * at that size never reload the page or restart the dev server, and `open_preview` on
 * the route already shown answers without a reload.
 */
export async function checkPreviewTiming(page: Page, artifacts: string) {
  const active = nativeWorkspace.active
  assert.ok(active, 'an open project')
  const { root, activeSessionKey: key } = active
  const server = previewServers.get(projectKey(root))
  assert.ok(server, 'the fixture dev server runs')
  // WebKit re-derives `performance.timeOrigin` from the wall clock on every read, so one
  // document can answer ±1 ms apart; a token planted in the page is gone after a reload.
  const document = async () => ({
    navigation: previewLoads.navigation,
    token: (await page(
      'window.__treziTimingDocument ??= String(Math.random()).slice(2)'
    )) as string,
    pid: previewServers.get(projectKey(root))?.pid
  })
  const time = async (tool: string, run: () => Promise<unknown>) => {
    const started = performance.now()
    const result = (await timedToolCall(key, tool, run)) as { isError?: boolean } | undefined
    const ms = performance.now() - started
    if (result?.isError) assert.fail(`${tool}: ${JSON.stringify(result).slice(0, 400)}`)
    return { ms, result }
  }
  const runs = async (tool: string, run: () => Promise<unknown>) => {
    const out: number[] = []
    for (let i = 0; i < RUNS; i++) out.push((await time(tool, run)).ms)
    return out
  }
  const before = await document()
  const measured: Record<string, number[]> = {}
  const legacy: Record<string, number[]> = {}

  legacy.preview_screenshot = await runs('legacy_screenshot', legacyScreenshot)
  measured.preview_screenshot = await runs('preview_screenshot', () =>
    observeAgentPreview('preview_screenshot', {}, root)
  )
  const shot = await observeAgentPreview('preview_screenshot', {}, root)
  assert.equal(shot.content[0].type, 'image', 'the timed screenshot is a real frame')
  assert.match((shot.content[1] as { text?: string }).text ?? '', /^Screenshot: \d+×\d+ px JPEG\.$/)
  measured.preview_inspect = await runs('preview_inspect', () =>
    observeAgentPreview('preview_inspect', { selector: 'body' }, root)
  )

  // Viewport change + settle, alternating with the restore; a screenshot at that size.
  legacy.preview_viewport = []
  measured.preview_viewport = []
  for (let i = 0; i < RUNS; i++) {
    legacy.preview_viewport.push((await time('legacy_viewport', () => legacyViewport(768))).ms)
    await legacyViewport(null)
    const { ms, result } = await time('preview_viewport', () =>
      runPreviewAgentTool('preview_viewport', { width: 768 })
    )
    measured.preview_viewport.push(ms)
    const size = JSON.parse((result as { content: { text: string }[] }).content[0].text)
    assert.equal(Math.round(size.innerWidth), 768, 'the viewport settled at the asked width')
    if (i === 0)
      await time('preview_screenshot', () => observeAgentPreview('preview_screenshot', {}, root))
    await runPreviewAgentTool('preview_viewport', { restore: true })
  }
  assert.deepEqual(await document(), before, 'viewport screenshots never reload or restart')

  // open_preview on the route already shown, loaded: no reload.
  assert.equal(await hasUnlandedWork(key), false, 'the smoke chat holds no unlanded work')
  const href = new URL((await page('location.href')) as string)
  const path = href.pathname + href.search + href.hash
  const notify = (channel: string, payload: unknown) =>
    serviceEvents.emit('event', channel, payload)
  measured.open_preview = []
  for (let i = 0; i < RUNS; i++) {
    const { ms, result } = await time('open_preview', () =>
      openAgentPreview(root, key, { path }, notify)
    )
    assert.equal(
      (result as { navigation?: string }).navigation,
      'already-loaded',
      JSON.stringify(result)
    )
    measured.open_preview.push(ms)
  }
  assert.deepEqual(await document(), before, 'open_preview on the shown route did not reload')

  const report = Object.fromEntries(
    Object.entries(PREVIEW_TARGETS).map(([tool, target]) => [
      tool,
      {
        target,
        medianMs: Math.round(median(measured[tool])),
        runsMs: round(measured[tool]),
        ...(legacy[tool]
          ? { legacyMedianMs: Math.round(median(legacy[tool])), legacyRunsMs: round(legacy[tool]) }
          : {})
      }
    ])
  )
  writeFileSync(join(artifacts, 'preview-timing.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log('Native preview timing', JSON.stringify(report))
  for (const [tool, target] of Object.entries(PREVIEW_TARGETS)) {
    assert.ok(
      median(measured[tool]) < target,
      `${tool} median ${report[tool].medianMs} ms ≥ ${target} ms`
    )
    assert.ok(
      Math.max(...measured[tool]) < target * 2,
      `${tool} slowest run ${Math.max(...round(measured[tool]))} ms ≥ ${target * 2} ms`
    )
  }
}

export async function restorePreviewTiming() {
  await runPreviewAgentTool('preview_viewport', { restore: true }).catch(() => {})
}

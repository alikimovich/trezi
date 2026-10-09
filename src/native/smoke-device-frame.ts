import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { preparePreviewInput } from './smoke-input'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

type Box = { x: number; y: number; width: number; height: number }
/** One offered device frame as DeviceFrame.swift measured it from its asset (pixels). */
type Frame = {
  name: string
  width: number
  height: number
  radius: number
  screen: Box
  missing?: boolean
}
type Device = {
  shown: boolean
  name: string
  bezel: Box
  page: Box
  radius: number
  curve: string
  masks: boolean
  guidesRadius: number
  guidesCurve: string
  backingScale: number
  frames: Frame[]
}

/** The asset's opening and corner for a bezel drawn at `bezel` (y down), as
 *  `DeviceFrame.screen(in:)` computes them. */
export function deviceScreen(
  frame: Frame,
  bezel: Box
): { scale: number; radius: number; rect: Box } {
  const scale = bezel.height / frame.height
  return {
    scale,
    radius: frame.radius * scale,
    rect: {
      x: bezel.x + frame.screen.x * scale,
      y: bezel.y + frame.screen.y * scale,
      width: frame.screen.width * scale,
      height: frame.screen.height * scale
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const mobile = () => nativeWorkspace.active?.viewport === 'mobile'
const device = async (host: NativeBridge): Promise<Device> =>
  (await host.request('layoutInspect')).device

/** Two window widths give two bezel scales. */
const WIDTHS = { wide: 1320, narrow: 850 } as const

/** LKM-217: the mobile page fills each offered bezel's opening exactly and is clipped
 *  with its continuous corner, at two scales; the four corners are captured in light
 *  and dark. */
export async function checkDeviceFrame(host: NativeBridge, artifacts: string) {
  const foreground = process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1'
  if (!mobile()) await host.request('shellPerform', { action: 'device' })
  const first: Device = await waitFor(async () => {
    const state = await device(host)
    return state.shown && state.page.width > 0 && state
  }, 'mobile device frame shown')
  // Every offered frame's opening was measured from its asset.
  assert.ok(first.frames.length > 0, 'At least one device frame is offered')
  for (const frame of first.frames) {
    assert.ok(!frame.missing, `Device frame ${frame.name}: asset loads and its opening is measured`)
    const { screen } = frame
    assert.ok(
      screen.x > 0 &&
        screen.y > 0 &&
        screen.x + screen.width < frame.width &&
        screen.y + screen.height < frame.height,
      `Device frame ${frame.name}: the opening lies inside the asset: ${JSON.stringify(frame)}`
    )
    // A continuous corner runs 1.53 r along each side: it must fit the opening.
    assert.ok(
      frame.radius > 0 && frame.radius * 1.53 * 2 < Math.min(screen.width, screen.height),
      `Device frame ${frame.name}: plausible corner radius ${frame.radius}`
    )
  }
  const active = first.frames.find((frame) => frame.name === first.name)
  assert.ok(active, `The shown bezel (${first.name}) is an offered frame`)
  const evidence: Record<string, unknown> = { frames: first.frames, foreground }
  const scales: number[] = []
  for (const [name, width] of Object.entries(WIDTHS)) {
    await host.request('shellPerform', { action: 'window-width', row: String(width) })
    let previous = ''
    const state: Device = await waitFor(
      async () => {
        const next = await device(host)
        // Explicit fields: Swift dictionaries serialize their keys in no stable order.
        const key = [next.bezel, next.page]
          .flatMap((box) => [box.x, box.y, box.width, box.height])
          .concat(next.radius)
          .join()
        const settled = next.shown && key === previous
        previous = key
        return settled && next
      },
      `device frame settled at window width ${width}`,
      10000,
      undefined,
      150
    )
    const expected = deviceScreen(active, state.bezel)
    scales.push(expected.scale)
    const label = `Device frame ${state.name} at ${name} (${width} pt, scale ${expected.scale.toFixed(3)})`
    assert.ok(
      Math.abs(state.bezel.width / state.bezel.height - active.width / active.height) < 0.002,
      `${label}: the bezel keeps the asset's aspect: ${JSON.stringify(state.bezel)}`
    )
    // The page is the opening with its edges rounded out to whole backing pixels.
    const pixel = 1 / state.backingScale + 0.01
    const edges = {
      left: [state.page.x, expected.rect.x, -1],
      top: [state.page.y, expected.rect.y, -1],
      right: [state.page.x + state.page.width, expected.rect.x + expected.rect.width, 1],
      bottom: [state.page.y + state.page.height, expected.rect.y + expected.rect.height, 1]
    }
    for (const [edge, [actual, wanted, outward]] of Object.entries(edges))
      assert.ok(
        (actual - wanted) * outward > -0.01 && Math.abs(actual - wanted) < pixel,
        `${label}: page ${edge} edge ${actual} must be the opening's ${wanted} (within one backing pixel, outwards)`
      )
    assert.ok(
      Math.abs(state.radius - expected.radius) < 0.01,
      `${label}: clip radius ${state.radius} must be the opening's ${expected.radius}`
    )
    assert.equal(state.curve, 'continuous', `${label}: the page clip is a continuous corner`)
    assert.equal(state.masks, true, `${label}: the page is clipped`)
    assert.ok(
      Math.abs(state.guidesRadius - state.radius) < 0.01 && state.guidesCurve === 'continuous',
      `${label}: the overlay over the page has the same clip`
    )
    const captures: Record<string, string[]> = {}
    for (const appearance of ['light', 'dark'] as const) {
      await host.request('shellPerform', { action: 'window-appearance', row: appearance })
      await delay(250)
      const shot = await corners(host, foreground)
      captures[appearance] = Object.entries(shot.corners as Record<string, string>).map(
        ([corner, png]) => {
          const file = `device-corner-${name}-${appearance}-${corner}.png`
          assert.ok(png, `${label} ${appearance}: ${corner} captured`)
          writeFileSync(join(artifacts, file), Buffer.from(png, 'base64'))
          return file
        }
      )
    }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
    evidence[name] = { width, state, expected, captures }
  }
  assert.ok(
    Math.abs(scales[0] - scales[1]) / Math.max(...scales) > 0.05,
    `The two window widths show the bezel at two scales: ${scales.join(', ')}`
  )
  if (!foreground)
    console.log(
      'Reduced coverage: device corners captured offscreen (TREZI_NATIVE_BACKGROUND_TEST); WebKit does not paint there.'
    )
  writeFileSync(join(artifacts, 'device-frame.json'), JSON.stringify(evidence, null, 2))
  console.log(
    `Device frame ${first.name}: page matches the opening and its ${active.radius.toFixed(2)} px continuous corner at scales ${scales.map((s) => s.toFixed(3)).join(' and ')}.`
  )
}

/** Foreground captures are refused when the window loses focus while ScreenCaptureKit
 *  works; reacquire and retry, like the chat captures. */
async function corners(host: NativeBridge, foreground: boolean) {
  if (!foreground) return host.request('deviceCorners', { foreground: false })
  for (let attempt = 1; ; attempt++) {
    await preparePreviewInput(host, true)
    try {
      return await host.request('deviceCorners', { foreground: true })
    } catch (error) {
      const lost = error instanceof Error && /foreground/.test(error.message)
      if (!lost || attempt === 3) throw error
      console.warn(`Device corner capture lost foreground (attempt ${attempt}/3); reacquiring`)
    }
  }
}

/** Desktop viewport, the default window width and the system appearance. The check
 *  runs it when it ends too: the runner's cleanup only follows a failure. */
export async function restoreDeviceFrame(host: NativeBridge) {
  await host.request('shellPerform', { action: 'window-appearance', row: '' })
  await host.request('shellPerform', { action: 'window-width', row: '1320' })
  if (mobile()) await host.request('shellPerform', { action: 'device' })
  await waitFor(async () => !(await device(host)).shown, 'desktop viewport restored')
}

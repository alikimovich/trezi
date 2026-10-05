import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnHostBridge } from './host-bridge.mjs'

const directory = resolve('out/native')
const executable = `${directory}/Trezi.app/Contents/MacOS/TreziHost`
if (process.platform !== 'darwin' || !existsSync(executable)) {
  console.log('NATIVE-SOURCE-WINDOW SKIP — build the macOS native host first.')
  process.exit(0)
}
const host = spawnHostBridge(executable, directory, 'ephemeral')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = '/tmp/trezi-source-window-fixture'
const state = {
  root,
  visible: true,
  popped: false,
  source: 'src/Example.tsx',
  files: ['src/Example.tsx'],
  text: Array.from({ length: 100 }, (_, i) => `const line${i} = "Editable source line ${i}"`).join(
    '\n'
  ),
  revision: 1
}
const inspect = () => host.request('sourceInspect', { root })
const update = async (patch) => {
  Object.assign(state, patch)
  host.send('sourceState', { state })
  await delay(200)
}
try {
  await Promise.race([
    once(host, 'ready'),
    delay(10000).then(() => {
      throw Error('Host did not start')
    })
  ])
  host.send('sourceActive', { root })
  await update({})
  await update({ popped: true })
  let info = await inspect()
  console.log('Initial source window:', info.width, info.height, info.minHeight, info.maxHeight)
  assert.ok(info.height >= 600, 'Popout opens at a useful height')
  assert.equal(info.minHeight, 420, 'Popout has a usable minimum height')
  assert.ok(info.viewportHeight >= 500, 'Code viewport fills the window')
  for (const [width, height] of [
    [1100, 800],
    [900, 500]
  ]) {
    await host.request('sourceResize', { root, width, height })
    await delay(200)
    info = await inspect()
    assert.equal(info.width, width)
    assert.equal(info.height, height)
    assert.ok(info.viewportHeight > height - 100)
    assert.ok(info.maxHeight >= 800, 'Configured maximum does not restrict vertical resizing')
  }
  await update({ text: state.text + '\n// Unsaved edit', revision: 2, dirty: true })
  assert.equal((await inspect()).height, 500, 'State refresh preserves resized window')
  await update({ popped: false })
  await update({ popped: true })
  assert.equal((await inspect()).height, 500, 'Redocking preserves window size')
  await update({ visible: false })
  await update({ visible: true })
  assert.equal((await inspect()).height, 500, 'Reopening preserves window size')
  assert.equal((await inspect()).text, state.text)
  const artifacts = resolve('test/artifacts/native')
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(
    `${artifacts}/source-window.png`,
    Buffer.from(await host.request('captureSource', { root }), 'base64')
  )
  console.log(
    'Native source window: initial height, resize, viewport, state refresh, dock/reopen and draft preservation pass.'
  )
} finally {
  host.child.kill()
  await once(host.child, 'exit')
}

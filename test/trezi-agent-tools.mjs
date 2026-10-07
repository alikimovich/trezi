/**
 * Codex ↔ Trezi MCP control bridge (pure Node/Bun, no provider credentials).
 * Proves the loopback bridge is session-scoped and that the actual stdio MCP
 * subprocess advertises/calls both workspace tools instead of merely testing a
 * config-shaped object.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatIslandDescription } from '../bin/chat-island-schema.mjs'
import { observeAgentPreview } from '../src/main/preview-observation-tools.ts'
import { registerPreviewSource } from '../src/main/preview-state.ts'
import { registerTreziAgentTools, shutdownTreziAgentTools } from '../src/main/trezi-agent-tools.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const calls = []
const registration = await registerTreziAgentTools(async (action, args) => {
  if (action.startsWith('preview_')) return observeAgentPreview(action, args)
  if (
    action === 'chat_island' ||
    action === 'project_ui_catalog' ||
    action === 'compose_project_ui' ||
    action === 'open_preview' ||
    action === 'open_code'
  )
    return { received: args ?? {} }
  calls.push(action)
  if (action === 'workspace_state') {
    return { state: 'parked', files: ['src/App.tsx'] }
  }
  return { ok: true, state: 'resolving', files: ['src/App.tsx'] }
})

const bridgeCall = (token, action) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify({ action })
    const req = httpRequest(
      {
        socketPath: registration.socketPath,
        path: '/invoke',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })

assert.equal(
  await bridgeCall('wrong', 'workspace_state'),
  401,
  'another session token cannot operate this chat'
)

const child = spawn(process.execPath, [join(root, 'bin', 'trezi-agent-mcp.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    TREZI_AGENT_TOOL_SOCKET: registration.socketPath,
    TREZI_AGENT_TOOL_TOKEN: registration.token
  },
  stdio: ['pipe', 'pipe', 'pipe']
})

let buffer = ''
let nextId = 1
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n')
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})

const request = (method, params = {}) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`MCP ${method} timed out`))
    }, 10_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'trezi-test', version: '1.0.0' }
  })
  assert.equal(initialized.result.serverInfo.name, 'trezi')
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`
  )

  const listed = await request('tools/list')
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
    'chat_island',
    'compose_project_ui',
    'git_merge_abort',
    'git_merge_continue',
    'git_sync_base',
    'open_code',
    'open_preview',
    'pr_status',
    'prepare_conflict_resolution',
    'preview_console',
    'preview_evaluate',
    'preview_inspect',
    'preview_location',
    'preview_screenshot',
    'preview_viewport',
    'project_ui_catalog',
    'publish_update',
    'reload_preview',
    'restart_dev_server',
    'workspace_state'
  ])

  assert.equal(
    listed.result.tools.find((tool) => tool.name === 'chat_island').description,
    chatIslandDescription
  )

  const previewCall = (name) => request('tools/call', { name, arguments: {} })
  const absent = await previewCall('preview_screenshot')
  assert.equal(absent.result.content[0].type, 'text')
  assert.match(absent.result.content[0].text, /No project preview/)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  let resized = false
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1600, height: 900 }),
    resize: ({ width }) => {
      assert.equal(width, 1200)
      resized = true
      return image
    },
    toJPEG: (quality) => {
      assert.equal(quality, 70)
      return jpeg
    }
  }
  registerPreviewSource({
    getUrl: () => 'http://localhost:3000/page?view=full#intro',
    capture: async () => image
  })
  const location = await previewCall('preview_location')
  assert.match(location.result.content[0].text, /page\?view=full#intro/)
  const captured = await previewCall('preview_screenshot')
  assert.deepEqual(
    captured.result.content,
    [{ type: 'image', mimeType: 'image/jpeg', data: jpeg.toString('base64') }],
    'real stdio transport preserves image content instead of stringifying it'
  )
  assert.equal(captured.result.structuredContent, undefined)
  assert.ok(resized)
  // LKM-138: inspection arguments survive the MCP transport and reach the isolated host.
  const evaluated = []
  registerPreviewSource({
    getUrl: () => 'http://localhost:3000/',
    capture: async () => image,
    agent: {
      evaluate: async (code, world) => {
        evaluated.push(world)
        return { element: '<h1>', styles: { 'box-shadow': 'rgb(0, 0, 0) 0px 2px 4px 0px' } }
      },
      captureRect: async () => null,
      setViewport: async () => ({ width: null, zoom: 1 })
    }
  })
  const inspected = await request('tools/call', {
    name: 'preview_inspect',
    arguments: { selector: 'h1' }
  })
  assert.match(inspected.result.content[0].text, /box-shadow/)
  assert.deepEqual(evaluated, ['preview'])
  const looped = await request('tools/call', {
    name: 'preview_evaluate',
    arguments: { expression: '(() => { while (true) {} })()' }
  })
  assert.equal(looped.result.isError, true)
  assert.match(looped.result.content[0].text, /loops cannot run/)
  assert.deepEqual(evaluated, ['preview'], 'a rejected expression never reaches the page')
  registerPreviewSource({
    getUrl: () => null,
    capture: async () => {
      throw new Error('closed')
    }
  })
  assert.match((await previewCall('preview_location')).result.content[0].text, /No project preview/)
  assert.equal((await previewCall('preview_screenshot')).result.content[0].type, 'text')
  registerPreviewSource({
    getUrl: () => null,
    capture: async () => ({ ...image, isEmpty: () => true })
  })
  assert.equal((await previewCall('preview_screenshot')).result.content[0].type, 'text')
  assert.equal(await bridgeCall('wrong', 'preview_screenshot'), 401)

  const island = await request('tools/call', {
    name: 'chat_island',
    arguments: { action: 'catalog' }
  })
  assert.deepEqual(island.result.structuredContent.received, { action: 'catalog' })
  assert.equal(await bridgeCall('wrong', 'chat_island'), 401)
  const catalog = await request('tools/call', { name: 'project_ui_catalog', arguments: {} })
  assert.deepEqual(catalog.result.structuredContent.received, {})
  const composition = {
    file: 'src/Page.tsx',
    spec: { root: 'a', elements: { a: { type: 'Card', props: {}, children: [] } } }
  }
  const composed = await request('tools/call', {
    name: 'compose_project_ui',
    arguments: composition
  })
  assert.deepEqual(
    composed.result.structuredContent.received,
    composition,
    'composition survives the real MCP transport'
  )
  const status = await request('tools/call', {
    name: 'workspace_state',
    arguments: {}
  })
  assert.equal(status.result.structuredContent.state, 'parked')

  const prepared = await request('tools/call', {
    name: 'prepare_conflict_resolution',
    arguments: {}
  })
  assert.equal(prepared.result.structuredContent.state, 'resolving')
  assert.deepEqual(calls, ['workspace_state', 'prepare_conflict_resolution'])
  for (const name of ['define_controls', 'open_controls']) {
    const removed = await request('tools/call', { name, arguments: {} })
    assert.ok(removed.error || removed.result?.isError, 'Removed panel tool cannot execute')
    assert.equal(
      await bridgeCall(registration.token, name),
      400,
      'Legacy socket action is rejected'
    )
  }
  const revealed = await request('tools/call', {
    name: 'open_code',
    arguments: { file: 'src/App.tsx', startLine: 10, endLine: 14 }
  })
  assert.deepEqual(revealed.result.structuredContent.received, {
    file: 'src/App.tsx',
    startLine: 10,
    endLine: 14
  })
  const navigated = await request('tools/call', {
    name: 'open_preview',
    arguments: { path: '/work/article?view=full#intro' }
  })
  assert.deepEqual(navigated.result.structuredContent.received, {
    path: '/work/article?view=full#intro'
  })
  const manifest = {
    file: 'src/App.tsx',
    component: 'App',
    title: 'Motion',
    params: [
      {
        id: 'delay',
        label: 'Delay',
        kind: 'number',
        min: 0,
        max: 1000,
        step: 10,
        unit: 'ms',
        apply: { strategy: 'literal', anchor: 'const DELAY = ' }
      }
    ]
  }
  const registered = await request('tools/call', {
    name: 'chat_island',
    arguments: {
      action: 'define',
      manifest,
      blocks: [{ id: 'motion', title: 'Motion', kind: 'group', params: ['delay'] }]
    }
  })
  assert.deepEqual(
    registered.result.structuredContent.received,
    {
      action: 'define',
      manifest,
      blocks: [{ id: 'motion', title: 'Motion', kind: 'group', params: ['delay'] }]
    },
    'Island definition survives the stdio/socket bridge'
  )
} finally {
  registration.dispose()
  child.kill()
}

assert.equal(
  await bridgeCall(registration.token, 'workspace_state'),
  401,
  'disposed sessions are no longer callable'
)
await shutdownTreziAgentTools()

console.log('TREZI-AGENT-TOOLS OK — scoped loopback bridge + real stdio MCP tools')

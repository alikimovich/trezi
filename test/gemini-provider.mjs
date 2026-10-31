// LKM-315: Gemini is an optional provider with an On/Off row in Settings → AI Providers.
// - setting: off by default, stored as 'true'/'false', the old opt-in variable only when
//   nothing is stored;
// - off: no Gemini models, a Gemini request runs on Claude, Check login starts no helper;
// - on: its models are listed, it runs in its own helper and its login check runs there;
// - Settings: the row sits with the provider rows (laid out like the fallback row), the
//   toggle persists across a relaunch, the model lists reload, a Gemini default that is
//   gone falls back to the last selected model; the Gemini… pane saves the API key through
//   the seat-credential path and never echoes it;
// - adapter: a turn against a stand-in `gemini` CLI, the model alias, the auth error and
//   Check login.
// The provider data owner and the CLI are stand-ins: no service, helper, Gemini or Keychain.
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { geminiProvider } from '../src/main/backends/gemini.ts'
import { pickProvider } from '../src/main/backends/index.ts'
import {
  GEMINI_ENABLED_KEY,
  GEMINI_OFF,
  geminiEnabled,
  setGeminiEnabledSource
} from '../src/main/gemini-setting.ts'
import { setProviderDataOwner } from '../src/main/provider-data.ts'
import { choices, registerProviderIpc } from '../src/main/providers.ts'
import { withClaudePane } from '../src/native/settings-claude.ts'
import { NativeSettingsController } from '../src/native/settings-controller.ts'
import { withGeminiPane } from '../src/native/settings-gemini.ts'
import { providerFallbackField } from '../src/native/settings-provider-fallback.ts'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { providerOptions } from '../src/shared/provider-choices.ts'

const KEY = 'AIzaFakeGeminiKeyForTests0123456789'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-gemini-provider-')))
const saved = { ...process.env }
const values = new Map()
const preferences = {
  get: (key) => values.get(key) ?? null,
  snapshot: () => Object.fromEntries(values),
  async apply(batch) {
    for (const [key, value] of typeof batch === 'function'
      ? batch(Object.fromEntries(values))
      : batch)
      values.set(key, value)
  },
  set(key, value) {
    return this.apply([[key, value]])
  },
  subscribe() {}
}
const gemini = (list) => list.filter((c) => c.provider === 'gemini')

try {
  delete process.env.TREZI_EXPERIMENTAL_GEMINI
  setGeminiEnabledSource(() => preferences.get(GEMINI_ENABLED_KEY))

  // The setting itself.
  assert.equal(geminiEnabled(), false, 'off by default')
  process.env.TREZI_EXPERIMENTAL_GEMINI = '1'
  assert.equal(geminiEnabled(), true, 'the old opt-in counts while nothing is stored')
  values.set(GEMINI_ENABLED_KEY, 'false')
  assert.equal(geminiEnabled(), false, 'a stored Off wins over the old opt-in')
  delete process.env.TREZI_EXPERIMENTAL_GEMINI
  values.set(GEMINI_ENABLED_KEY, 'true')
  assert.equal(geminiEnabled(), true)
  values.delete(GEMINI_ENABLED_KEY)

  // The provider IPC against a stand-in data owner that records what reaches it.
  const owned = [],
    tokens = {}
  setProviderDataOwner({
    save: async () => {
      throw new Error('unused')
    },
    remove: async () => {},
    secretFor: async () => null,
    saveCatalog: async () => true,
    codexModels: async () => [],
    async saveSeatToken(provider, token) {
      owned.push(['saveSeatToken', provider])
      tokens[provider] = !!token
      return !!token
    },
    async seatTokenStatus() {
      return {
        claude: { hasToken: !!tokens.claude },
        gemini: { hasToken: !!tokens.gemini }
      }
    },
    async checkLogin(provider) {
      owned.push(['checkLogin', provider])
      return { provider, loggedIn: true, authMethod: 'Gemini API key', detail: 'Gemini CLI 1.0' }
    }
  })
  const handlers = new Map()
  registerProviderIpc(() => scratch, { handle: (channel, fn) => handlers.set(channel, fn) })
  const invoke = async (channel, ...args) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler ${channel}`)
    return handler({}, ...args)
  }

  // Off: no models, a Gemini request runs on Claude, no login check reaches a helper.
  process.env.TREZI_SERVICE_SUPERVISED = '1'
  assert.deepEqual(gemini(choices()), [], 'off hides the Gemini models')
  assert.ok(!providerOptions(choices()).some((o) => o.provider === 'gemini'))
  assert.equal(pickProvider({ provider: 'gemini' }).id, 'claude', 'off starts no Gemini helper')
  const off = await invoke('providers:check-login', 'gemini', scratch)
  assert.deepEqual(off, { provider: 'gemini', loggedIn: null, detail: GEMINI_OFF })
  assert.deepEqual(owned, [], 'off, the login check starts no helper')

  // On: the models, its own helper, the login check through the owner.
  values.set(GEMINI_ENABLED_KEY, 'true')
  assert.deepEqual(
    gemini(choices()).map((c) => [c.value, c.modelId, c.group, c.label]),
    [
      ['gemini:default', 'default', 'Gemini', 'Default'],
      ['gemini:pro', 'pro', 'Gemini', 'Pro'],
      ['gemini:flash', 'flash', 'Gemini', 'Flash'],
      ['gemini:flash-lite', 'flash-lite', 'Gemini', 'Flash-Lite']
    ]
  )
  assert.deepEqual(
    providerOptions(choices()).map((o) => o.label),
    ['Claude', 'Codex', 'Gemini'],
    'Gemini is listed after the other seats'
  )
  const picked = pickProvider({ provider: 'gemini' })
  assert.equal(picked.id, 'gemini')
  assert.equal(picked.host, 'helper', 'Gemini runs in a supervised helper like the other seats')
  assert.equal((await invoke('providers:check-login', 'gemini', scratch)).loggedIn, true)
  assert.deepEqual(owned.at(-1), ['checkLogin', 'gemini'])
  // Its key goes the seat-credential way; no provider argument still means Claude.
  assert.equal((await invoke('providers:seat-token-save', KEY, 'gemini')).hasToken, true)
  assert.deepEqual(owned.at(-1), ['saveSeatToken', 'gemini'])
  assert.deepEqual(await invoke('providers:seat-token-status', 'gemini'), { hasToken: true })
  assert.deepEqual(await invoke('providers:seat-token-status'), { hasToken: false })
  await invoke('providers:seat-token-save', '', 'gemini')
  values.delete(GEMINI_ENABLED_KEY)
  console.log('GEMINI-PROVIDER routing PASS')

  // Settings → AI Providers, through the real provider IPC.
  const sent = [],
    calls = []
  let changed = 0
  const sheets = new NativeSheetController(
    { send: (method, data) => sent.push([method, structuredClone(data)]) },
    {},
    {},
    async (channel, ...args) => {
      calls.push([channel, ...args])
      return invoke(channel, ...args)
    }
  )
  const open = () => {
    const settings = withGeminiPane(
      withClaudePane(new NativeSettingsController(sheets, preferences, () => {})),
      preferences,
      () => changed++
    )
    return settings.open()
  }
  const action = (name, extra = {}) =>
    sheets.action({ id: sheets.current.state.id, action: name, values: extra })
  const field = (id) => sheets.current.state.fields.find((f) => f.id === id)
  const providerFields = () => sheets.current.state.fields.filter((f) => f.section === 'providers')
  const general = () => ({
    default: field('default').value,
    projectUi: field('projectUi').value,
    engine: field('engine').value
  })
  await open()
  assert.deepEqual(
    providerFields().map((f) => f.id),
    ['connections', 'geminiEnabled']
  )
  // Laid out like the other provider rows: the fallback row's kind, choices and pane.
  const row = field('geminiEnabled'),
    fallback = providerFallbackField(preferences)
  assert.deepEqual(
    [row.kind, row.section, row.choices, row.draft],
    [fallback.kind, fallback.section, fallback.choices, fallback.draft]
  )
  assert.equal(row.value, 'off')
  assert.deepEqual(
    sheets.current.state.actions.map((a) => a.id),
    ['clean-workspaces', 'add', 'claude', 'gemini'],
    'Gemini… sits next to Claude…'
  )
  assert.ok(!field('default').choices.some((c) => c.value.startsWith('gemini:')))

  // On: stored, the model lists reload (Settings and the chat picker).
  await action('change', { ...general(), geminiEnabled: 'on' })
  assert.equal(preferences.get(GEMINI_ENABLED_KEY), 'true')
  assert.equal(changed, 1, 'the chat picker is told to reload')
  assert.equal(field('geminiEnabled').value, 'on')
  assert.ok(field('default').choices.some((c) => c.value === 'gemini:pro'))
  // Gemini as the default model, then a relaunch: the row reads the stored value.
  await action('change', { ...general(), default: 'gemini:pro', geminiEnabled: 'on' })
  assert.equal(JSON.parse(preferences.get('trezi:preferred-model')).fixed.model, 'gemini:pro')
  assert.equal(changed, 1, 'an unchanged toggle reloads nothing')
  sheets.close()
  await open()
  assert.equal(field('geminiEnabled').value, 'on', 'the toggle persists across a relaunch')
  assert.equal(field('default').value, 'gemini:pro')

  // Off again: gone from the lists, and the Gemini default falls back to the last selected.
  await action('change', { ...general(), geminiEnabled: 'off' })
  assert.equal(preferences.get(GEMINI_ENABLED_KEY), 'false')
  assert.equal(changed, 2)
  assert.ok(!field('default').choices.some((c) => c.value.startsWith('gemini:')))
  assert.equal(field('default').value, 'last-used')
  assert.equal(JSON.parse(preferences.get('trezi:preferred-model')).mode, 'last-used')
  await assert.rejects(
    sheets.current.handle({ action: 'save', values: { geminiEnabled: 'maybe' } }),
    /Invalid setting/
  )

  // The Gemini… pane: a draft key, Check login, save and remove without echo, Back.
  values.set(GEMINI_ENABLED_KEY, 'true')
  await action('gemini')
  assert.deepEqual(
    providerFields().map((f) => [f.id, f.kind, f.draft]),
    [['geminiKey', 'secure', true]]
  )
  assert.deepEqual(
    sheets.current.state.actions.map((a) => a.id),
    ['clean-workspaces', 'back', 'gemini-check', 'gemini-save']
  )
  await action('change', { ...general(), geminiKey: KEY })
  assert.ok(!JSON.stringify([...values]).includes(KEY), 'the key draft is never a preference')
  await action('gemini-save', { geminiKey: '  ' })
  assert.match(sheets.current.state.message, /Paste a Gemini API key/)
  assert.ok(!calls.some((c) => c[0] === 'providers:seat-token-save'), 'refused before the service')
  await action('gemini-save', { geminiKey: ` ${KEY} ` })
  assert.deepEqual(calls.filter((c) => c[0] === 'providers:seat-token-save').at(-1), [
    'providers:seat-token-save',
    KEY,
    'gemini'
  ])
  assert.equal(sheets.current.state.message, 'Key saved. New Gemini chats use it.')
  assert.ok(sheets.current.state.actions.some((a) => a.id === 'gemini-remove'))
  assert.equal(field('geminiKey').value, '')
  assert.ok(!JSON.stringify(sent).includes(KEY), 'the key never returns in a sheet snapshot')
  await action('gemini-check')
  assert.match(field('report').value, /Gemini CLI/)
  assert.deepEqual(owned.at(-1), ['checkLogin', 'gemini'])
  await action('gemini-remove')
  assert.deepEqual(calls.filter((c) => c[0] === 'providers:seat-token-save').at(-1), [
    'providers:seat-token-save',
    '',
    'gemini'
  ])
  assert.equal(sheets.current.state.message, 'Key removed.')
  await action('back')
  assert.deepEqual(
    providerFields().map((f) => f.id),
    ['connections', 'geminiEnabled']
  )
  assert.deepEqual(
    sheets.current.state.actions.map((a) => a.id),
    ['clean-workspaces', 'add', 'claude', 'gemini']
  )
  console.log('GEMINI-PROVIDER settings PASS')

  // The adapter (what a Gemini helper runs) against a stand-in `gemini` CLI, with a private
  // HOME and no sign-in variables: a turn streams, the picked alias reaches `-m`, a CLI
  // that fails without any sign-in is an `auth` error (the chat's sign-in card).
  const home = join(scratch, 'home'),
    bin = join(scratch, 'gemini'),
    seen = join(scratch, 'model'),
    prompts = join(scratch, 'prompts')
  mkdirSync(home)
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo 0.9.0; exit 0; fi',
      `for a in "$@"; do if [ "$prev" = "-m" ]; then echo "$a" > '${seen}'; fi; if [ "$prev" = "-p" ]; then echo "$a" >> '${prompts}'; fi; prev="$a"; done`,
      'if [ -n "$FAIL" ]; then exit 1; fi',
      `echo '{"type":"init"}'`,
      `echo '{"type":"message","role":"assistant","text":"PONG"}'`,
      `echo '{"type":"result"}'`
    ].join('\n')
  )
  chmodSync(bin, 0o755)
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'FAIL'])
    delete process.env[key]
  Object.assign(process.env, { HOME: home, TREZI_GEMINI_BIN: bin })
  const events = []
  const session = await geminiProvider.startSession(scratch, { model: 'pro' }, () => null, {
    onEvent: (e) => events.push(e)
  })
  const turn = async (text) => {
    const start = events.length
    session.send(text)
    for (let i = 0; i < 500 && !events.slice(start).some((e) => e.type === 'done'); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    return events.slice(start).map(({ projectKey: _, ...e }) => e)
  }
  assert.deepEqual(await turn('ping'), [{ type: 'delta', text: 'PONG' }, { type: 'done' }])
  assert.equal(readFileSync(seen, 'utf8').trim(), 'pro')
  await session.setModel('flash')
  await turn('again')
  assert.equal(readFileSync(seen, 'utf8').trim(), 'flash', 'a model switch applies next turn')
  // LKM-390: an image that reaches this text-only adapter is said, never dropped silently.
  const imageStart = events.length
  session.send('with a picture', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }])
  for (let i = 0; i < 500 && !events.slice(imageStart).some((e) => e.type === 'done'); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const imageTurn = events.slice(imageStart)
  assert.ok(
    imageTurn.some((e) => e.type === 'status' && /cannot take images: 1 image/.test(e.text)),
    'the chat states the image was not sent'
  )
  assert.match(
    readFileSync(prompts, 'utf8'),
    /\[Not attached: 1 image\(s\); Gemini cannot take images[^\n]*\n\nwith a picture\n$/,
    'the agent is told too'
  )
  process.env.FAIL = '1'
  const failed = await turn('fail')
  assert.equal(failed[0].code, 'auth')
  assert.match(failed[0].message, /not signed in/)
  process.env.GEMINI_API_KEY = KEY
  const signedIn = await turn('fail again')
  assert.equal(signedIn[0].code, undefined, 'signed in, a failure is an ordinary error')
  delete process.env.FAIL
  session.shutdown()
  const login = await geminiProvider.checkLogin()
  assert.deepEqual([login.loggedIn, login.authMethod, login.token], [true, 'Gemini API key', true])
  assert.ok(!JSON.stringify(login).includes(KEY), 'the report names the key, never its value')
  delete process.env.GEMINI_API_KEY
  assert.equal((await geminiProvider.checkLogin()).loggedIn, false)
  console.log('GEMINI-PROVIDER adapter PASS')
} finally {
  setProviderDataOwner(null)
  for (const key of [
    'TREZI_SERVICE_SUPERVISED',
    'TREZI_EXPERIMENTAL_GEMINI',
    'TREZI_GEMINI_BIN',
    'HOME',
    'FAIL',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI'
  ]) {
    if (key in saved) process.env[key] = saved[key]
    else delete process.env[key]
  }
  rmSync(scratch, { recursive: true, force: true })
}

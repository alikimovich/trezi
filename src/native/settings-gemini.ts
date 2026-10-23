import { GEMINI_ENABLED_KEY, geminiEnabled } from '../main/gemini-setting'
import type { ProviderLoginReport } from '../shared/api'
import type { NativeSheetAction, NativeSheetField, NativeSheetState } from '../shared/native-sheet'
import {
  LAST_USED_VALUE,
  PREFERRED_MODEL_KEY,
  parsePreferredModelState,
  preferredSelectValue
} from '../shared/preferred-model'
import { loginSummary } from './chat-login'
import type { NativePreferences } from './preferences'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LKM-315: Settings → AI Providers → Gemini. The provider list gets a "Gemini" On/Off row
 * (laid out like the fallback row) and a "Gemini…" pane next to "Claude…": the Gemini API
 * key (a draft, saved encrypted by the service and never echoed) and Check login. Off
 * hides Gemini's models and starts no Gemini helper (`main/gemini-setting.ts`).
 */

interface Pane {
  detail: string
  fields: Omit<NativeSheetField, 'section' | 'draft'>[]
  actions: NativeSheetState['actions']
}
type Sheet = NonNullable<NativeSheetController['current']>
const decorated = new WeakSet<Sheet>()
const ENTRY = { id: 'gemini', label: 'Gemini…', section: 'providers' }
const CHOICES = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
]

export const geminiField = (): NativeSheetField => ({
  id: 'geminiEnabled',
  section: 'providers',
  label: 'Gemini',
  help: 'On: Gemini models are in the model picker. They use the Gemini CLI’s Login with Google, or the API key saved under Gemini…. Off: they are hidden and Gemini never starts.',
  kind: 'choice',
  value: geminiEnabled() ? 'on' : 'off',
  choices: CHOICES
})

/** The key goes to the service and never comes back into a sheet. */
async function pane(sheets: NativeSheetController, report?: ProviderLoginReport): Promise<Pane> {
  const { hasToken }: { hasToken: boolean } = await sheets.invoke(
    'providers:seat-token-status',
    'gemini'
  )
  return {
    detail:
      'Gemini chats use the Gemini CLI: install it, run gemini once and choose Login with Google. Or save an API key from Google AI Studio here; it is encrypted with your Keychain and given only to Gemini chats.',
    fields: [
      {
        id: 'geminiKey',
        label: 'Gemini API key',
        help: hasToken ? 'Saved. Paste a new key to replace it.' : 'From Google AI Studio.',
        kind: 'secure',
        value: '',
        placeholder: hasToken ? 'Saved' : 'Paste key'
      },
      ...(report
        ? [
            {
              id: 'report',
              label: loginSummary(report),
              kind: 'readonly' as const,
              value: report.detail
            }
          ]
        : [])
    ],
    actions: [
      { id: 'back', label: 'Back', section: 'providers' },
      { id: 'gemini-check', label: 'Check login', section: 'providers' },
      ...(hasToken
        ? [{ id: 'gemini-remove', label: 'Remove key', destructive: true, section: 'providers' }]
        : []),
      { id: 'gemini-save', label: 'Save key', primary: true, section: 'providers' }
    ]
  }
}

async function geminiAction(
  sheets: NativeSheetController,
  sheet: Sheet,
  action: NativeSheetAction
) {
  let report: ProviderLoginReport | undefined, message: string | undefined
  if (action.action === 'gemini-check')
    report = await sheets.invoke('providers:check-login', 'gemini')
  else if (action.action !== 'gemini') {
    const remove = action.action === 'gemini-remove'
    const key = remove ? '' : (action.values.geminiKey?.trim() ?? '')
    if (!remove && !key) throw new Error('Paste a Gemini API key.')
    const result = await sheets.invoke('providers:seat-token-save', key, 'gemini')
    if (!result.ok) throw new Error(result.error ?? 'Could not save the key.')
    message = result.hasToken ? 'Key saved. New Gemini chats use it.' : 'Key removed.'
  }
  const next = await pane(sheets, report)
  if (sheets.current !== sheet) return
  // Swap the AI Providers pane in place, like the Claude pane: other panes untouched.
  sheet.state.fields = [
    ...sheet.state.fields.filter((f) => f.section !== 'providers'),
    ...next.fields.map((field) => ({ ...field, section: 'providers', draft: true }))
  ]
  sheet.state.actions = [
    ...sheet.state.actions.filter((a) => a.section !== 'providers'),
    ...next.actions
  ]
  const section = sheet.state.sections?.find((s) => s.id === 'providers')
  if (section) section.detail = next.detail
  sheet.state.message = message
  sheets.refresh()
}

/** The row and the entry on the provider list (the pane with "Add provider…"), once each. */
function offer(sheet: Sheet) {
  const actions = sheet.state.actions,
    add = actions.findIndex((a) => a.id === 'add')
  if (add < 0) return
  if (!actions.some((a) => a.id === ENTRY.id)) {
    const after = actions.findIndex((a) => a.id === 'claude')
    const at = (after >= 0 ? after : add) + 1
    sheet.state.actions = [...actions.slice(0, at), ENTRY, ...actions.slice(at)]
  }
  const fields = sheet.state.fields
  if (fields.some((f) => f.id === 'geminiEnabled')) return
  // Right after the added providers, before the fallback row.
  const at = fields.findIndex((f) => f.id === 'connection' || f.id === 'connections')
  fields.splice(at < 0 ? fields.length : at + 1, 0, geminiField())
}

/** New default-model choices; a Gemini default that is gone falls back to the last selected model. */
async function refreshModels(
  settings: NativeSettingsController,
  sheet: Sheet,
  preferences: Pick<NativePreferences, 'get'>
) {
  const choices = await settings.refreshChoices(sheet.state.id)
  if (!choices || settings.sheets.current !== sheet) return
  let raw: unknown
  try {
    raw = JSON.parse(preferences.get(PREFERRED_MODEL_KEY) ?? 'null')
  } catch {}
  const current = preferredSelectValue(parsePreferredModelState(raw))
  const field = sheet.state.fields.find((f) => f.id === 'default')
  if (field && current !== LAST_USED_VALUE && !choices.some((c) => c.value === current)) {
    field.value = LAST_USED_VALUE
    // Not awaited: this runs inside the autosave's own save, which then takes this one.
    void sheet.autosave?.enqueue({ default: LAST_USED_VALUE })
  }
  settings.sheets.refresh()
}

/**
 * Settings → AI Providers → Gemini on top of the Settings window. `changed` runs after the
 * toggle was saved, so the chat's model picker reloads its list.
 */
export function withGeminiPane(
  settings: NativeSettingsController,
  preferences: NativePreferences,
  changed: () => void
) {
  const open = settings.open.bind(settings)
  settings.open = async () => {
    await open()
    const sheets = settings.sheets,
      sheet = sheets.current
    if (!sheet || decorated.has(sheet) || !sheet.state.sections?.some((s) => s.id === 'providers'))
      return
    decorated.add(sheet)
    const handle = sheet.handle
    sheet.handle = async (action) => {
      if (action.action.startsWith('gemini')) return geminiAction(sheets, sheet, action)
      const value = action.values.geminiEnabled
      let toggled = false
      if (action.action === 'save' && value !== undefined) {
        if (!['on', 'off'].includes(value)) throw new Error('Invalid setting.')
        toggled = geminiEnabled() !== (value === 'on')
        if (toggled) await preferences.set(GEMINI_ENABLED_KEY, value === 'on' ? 'true' : 'false')
      }
      await handle(action)
      offer(sheet)
      if (!toggled) return
      const field = sheet.state.fields.find((f) => f.id === 'geminiEnabled')
      if (field) field.value = value === 'on' ? 'on' : 'off'
      await refreshModels(settings, sheet, preferences)
      changed()
    }
    offer(sheet)
    sheets.refresh()
  }
  return settings
}

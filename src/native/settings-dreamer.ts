import type { NativeSheetAction, NativeSheetField } from '../shared/native-sheet'
import { DREAMER_SCHEDULE_KEY } from './dreamer-controller'
import {
  DEFAULT_AGENT_OS_URL,
  DREAMER_PROJECT_KEY,
  DREAMER_START_KEY,
  DREAMER_TOKEN_KEY,
  DREAMER_URL_KEY
} from './dreamer-export'
import type { NativePreferences } from './preferences'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LKM-202: Settings → Dreamer. Where Send to Agent OS posts (URL, project ID, token)
 * and the optional weekly run. The token is saved only with its own button and never
 * shown again; the other rows autosave with the rest of Settings.
 */

type Sheet = NonNullable<NativeSheetController['current']>
const SECTION = 'dreamer'
const decorated = new WeakSet<Sheet>()
const START_CHOICES = [
  { value: 'off', label: 'Only create them' },
  { value: 'on', label: 'Start them on import' }
]
const SCHEDULE_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'weekly', label: 'Weekly, while Trezi is idle' }
]

function pane(preferences: NativePreferences) {
  const hasToken = !!preferences.get(DREAMER_TOKEN_KEY)
  const fields: NativeSheetField[] = [
    {
      id: 'dreamerUrl',
      label: 'Agent OS URL',
      help: 'Send to Agent OS posts the selected proposals to <URL>/proposals.',
      kind: 'text',
      value: preferences.get(DREAMER_URL_KEY) ?? '',
      placeholder: DEFAULT_AGENT_OS_URL
    },
    {
      id: 'dreamerProject',
      label: 'Agent OS project ID',
      help: 'The project that gets one task per proposal.',
      kind: 'text',
      value: preferences.get(DREAMER_PROJECT_KEY) ?? '',
      placeholder: 'Project ID'
    },
    {
      id: 'dreamerToken',
      label: 'Agent OS token',
      help: hasToken
        ? 'Saved. Paste a new token to replace it.'
        : 'Sent as a Bearer token. Optional.',
      kind: 'secure',
      value: '',
      draft: true,
      placeholder: hasToken ? 'Saved' : 'Paste token'
    },
    {
      id: 'dreamerStart',
      label: 'When tasks are created',
      help: 'Agent OS listens on 127.0.0.1 only, so Send works on the Mac that runs it.',
      kind: 'choice',
      value: preferences.get(DREAMER_START_KEY) === 'on' ? 'on' : 'off',
      choices: START_CHOICES
    },
    {
      id: 'dreamerSchedule',
      label: 'Run the Dreamer',
      help: 'A weekly run looks at the last 14 days of every project and shows its proposals when it finishes.',
      kind: 'choice',
      value: preferences.get(DREAMER_SCHEDULE_KEY) === 'weekly' ? 'weekly' : 'off',
      choices: SCHEDULE_CHOICES
    }
  ]
  const actions = [
    ...(hasToken
      ? [{ id: 'dreamer-token-remove', label: 'Remove Token', destructive: true, section: SECTION }]
      : []),
    { id: 'dreamer-token-save', label: 'Save Token', primary: true, section: SECTION }
  ]
  return { fields: fields.map((field) => ({ ...field, section: SECTION })), actions }
}

function show(sheets: NativeSheetController, sheet: Sheet, preferences: NativePreferences) {
  const next = pane(preferences)
  sheet.state.fields = [...sheet.state.fields.filter((f) => f.section !== SECTION), ...next.fields]
  sheet.state.actions = [
    ...sheet.state.actions.filter((a) => a.section !== SECTION),
    ...next.actions
  ]
}

/** The URL must be http(s); empty means the default. */
export function agentOsUrl(value: string | undefined) {
  const text = (value ?? '').trim()
  if (!text) return ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('Enter the Agent OS URL as http://host:port.')
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('The Agent OS URL must start with http:// or https://.')
  return text.replace(/\/+$/, '')
}

async function save(preferences: NativePreferences, values: NativeSheetAction['values']) {
  if (values.dreamerUrl === undefined) return
  const schedule = values.dreamerSchedule === 'weekly' ? 'weekly' : 'off'
  const url = agentOsUrl(values.dreamerUrl)
  await preferences.apply([
    [DREAMER_URL_KEY, url || null],
    [DREAMER_PROJECT_KEY, values.dreamerProject?.trim() || null],
    [DREAMER_START_KEY, values.dreamerStart === 'on' ? 'on' : null],
    [DREAMER_SCHEDULE_KEY, schedule]
  ])
}

/** Settings → Dreamer on top of the Settings window, like the Claude pane (`settings-claude.ts`). */
export function withDreamerPane(
  settings: NativeSettingsController,
  preferences: NativePreferences
) {
  const open = settings.open.bind(settings)
  settings.open = async () => {
    await open()
    const sheets = settings.sheets,
      sheet = sheets.current
    if (!sheet || decorated.has(sheet) || !sheet.state.sections?.some((s) => s.id === SECTION))
      return
    decorated.add(sheet)
    const handle = sheet.handle
    sheet.handle = async (action) => {
      if (action.action === 'dreamer-token-save' || action.action === 'dreamer-token-remove') {
        const remove = action.action === 'dreamer-token-remove'
        const token = remove ? '' : (action.values.dreamerToken?.trim() ?? '')
        if (!remove && !token) throw new Error('Paste the Agent OS token first.')
        await preferences.set(DREAMER_TOKEN_KEY, token || null)
        if (sheets.current !== sheet) return
        show(sheets, sheet, preferences)
        sheet.state.message = remove ? 'Agent OS token removed.' : 'Agent OS token saved.'
        sheets.refresh()
        return
      }
      if (action.action === 'save') await save(preferences, action.values)
      await handle(action)
    }
    show(sheets, sheet, preferences)
    sheets.refresh()
  }
  return settings
}

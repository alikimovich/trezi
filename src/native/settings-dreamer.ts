import type { NativeSheetAction, NativeSheetField } from '../shared/native-sheet'
import { DREAMER_SCHEDULE_KEY } from './dreamer-controller'
import type { NativePreferences } from './preferences'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LKM-202: Settings → Dreamer, the optional weekly run; it autosaves with the rest of
 * Settings. LKM-443 removed Send to Agent OS and its rows (URL, project ID, token, start);
 * the values an earlier version saved stay in preferences, unread and not erased.
 */

type Sheet = NonNullable<NativeSheetController['current']>
const SECTION = 'dreamer'
const decorated = new WeakSet<Sheet>()
const SCHEDULE_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'weekly', label: 'Weekly, while Trezi is idle' }
]

function pane(preferences: NativePreferences) {
  const fields: NativeSheetField[] = [
    {
      id: 'dreamerSchedule',
      label: 'Run the Dreamer',
      help: 'A weekly run looks at the last 14 days of every project and shows its proposals when it finishes.',
      kind: 'choice',
      value: preferences.get(DREAMER_SCHEDULE_KEY) === 'weekly' ? 'weekly' : 'off',
      choices: SCHEDULE_CHOICES
    }
  ]
  return { fields: fields.map((field) => ({ ...field, section: SECTION })) }
}

function show(sheet: Sheet, preferences: NativePreferences) {
  const next = pane(preferences)
  sheet.state.fields = [...sheet.state.fields.filter((f) => f.section !== SECTION), ...next.fields]
}

async function save(preferences: NativePreferences, values: NativeSheetAction['values']) {
  if (values.dreamerSchedule === undefined) return
  await preferences.set(
    DREAMER_SCHEDULE_KEY,
    values.dreamerSchedule === 'weekly' ? 'weekly' : 'off'
  )
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
      if (action.action === 'save') await save(preferences, action.values)
      await handle(action)
    }
    show(sheet, preferences)
    sheets.refresh()
  }
  return settings
}

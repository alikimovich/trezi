import type { NativeSheetField } from '../shared/native-sheet'
import { BUILD_CHECK_KEY } from './build-status-controller'
import type { NativePreferences } from './preferences'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LKM-226: Settings → General → "Check whether this build is on main", after Version.
 * Off: the build badge never reads GitHub (it still shows local changes and the branch).
 * Autosaves with the rest of Settings; `changed` re-runs the check.
 */

type Sheet = NonNullable<NativeSheetController['current']>
const decorated = new WeakSet<Sheet>()
const CHOICES = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
]

export const buildCheckField = (preferences: Pick<NativePreferences, 'get'>): NativeSheetField => ({
  id: 'buildCheck',
  section: 'general',
  label: 'Check whether this build is on main',
  help: 'At launch and every 30 minutes Trezi compares its build with GitHub main. Off: no network check.',
  kind: 'choice',
  value: preferences.get(BUILD_CHECK_KEY) === 'off' ? 'off' : 'on',
  choices: CHOICES
})

export function withBuildCheckSetting(
  settings: NativeSettingsController,
  preferences: NativePreferences,
  changed: () => void
) {
  const open = settings.open.bind(settings)
  settings.open = async () => {
    await open()
    const sheets = settings.sheets,
      sheet = sheets.current
    if (!sheet || decorated.has(sheet) || sheet.state.title !== 'Settings') return
    decorated.add(sheet)
    const field = buildCheckField(preferences)
    const at = sheet.state.fields.findIndex((f) => f.id === 'version')
    sheet.state.fields.splice(at < 0 ? sheet.state.fields.length : at + 1, 0, field)
    const handle = sheet.handle
    sheet.handle = async (action) => {
      const value = action.values.buildCheck
      if (action.action === 'save' && value !== undefined) {
        if (!['on', 'off'].includes(value)) throw new Error('Invalid setting.')
        if ((preferences.get(BUILD_CHECK_KEY) === 'off') !== (value === 'off')) {
          await preferences.set(BUILD_CHECK_KEY, value === 'off' ? 'off' : null)
          changed()
        }
      }
      await handle(action)
    }
    sheets.refresh()
  }
  return settings
}

import { PROVIDER_FALLBACK_KEY } from '../main/self-heal/fallback'
import type { NativeSheetField } from '../shared/native-sheet'
import type { NativePreferences } from './preferences'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LKM-225: Settings → AI Providers → "Automatic provider fallback", after the provider list.
 * On (the default): a turn whose provider could not connect, after its own retries, runs on
 * the other signed-in provider once and says so. Off: the error stays. Stored as 'false'.
 */

type Sheet = NonNullable<NativeSheetController['current']>
const decorated = new WeakSet<Sheet>()
const CHOICES = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
]

export const providerFallbackField = (
  preferences: Pick<NativePreferences, 'get'>
): NativeSheetField => ({
  id: 'providerFallback',
  section: 'providers',
  label: 'Automatic provider fallback',
  help: 'If Codex or Claude cannot connect after a few retries, run that turn on the other one when it is signed in.',
  kind: 'choice',
  value: preferences.get(PROVIDER_FALLBACK_KEY) === 'false' ? 'off' : 'on',
  choices: CHOICES
})

export function withProviderFallbackSetting(
  settings: NativeSettingsController,
  preferences: NativePreferences
) {
  const open = settings.open.bind(settings)
  settings.open = async () => {
    await open()
    const sheets = settings.sheets,
      sheet = sheets.current
    if (!sheet || decorated.has(sheet) || sheet.state.title !== 'Settings') return
    decorated.add(sheet)
    // After the provider list; the AI Providers pane has room, General is full.
    const at = sheet.state.fields.map((f) => f.section).lastIndexOf('providers')
    sheet.state.fields.splice(
      at < 0 ? sheet.state.fields.length : at + 1,
      0,
      providerFallbackField(preferences)
    )
    const handle = sheet.handle
    sheet.handle = async (action) => {
      const value = action.values.providerFallback
      if (action.action === 'save' && value !== undefined) {
        if (!['on', 'off'].includes(value)) throw new Error('Invalid setting.')
        if ((preferences.get(PROVIDER_FALLBACK_KEY) === 'false') !== (value === 'off'))
          await preferences.set(PROVIDER_FALLBACK_KEY, value === 'off' ? 'false' : null)
      }
      await handle(action)
    }
    sheets.refresh()
  }
  return settings
}

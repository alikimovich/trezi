import type { NativeSheetField } from '../shared/native-sheet'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/**
 * LKM-336: Settings → General → "Feedback invite code". Send Feedback asks for the code
 * from the tester's Trezi beta invite the first time; here it can be replaced or removed.
 * A new code is checked with the feedback endpoint before the service saves it, encrypted
 * with the Keychain helper; it is never shown again.
 */

type Sheet = NonNullable<NativeSheetController['current']>
const SECTION = 'general'
const FIELD = 'feedbackCode'
const SAVE = 'feedback-code-save'
const REMOVE = 'feedback-code-remove'
const decorated = new WeakSet<Sheet>()

export const feedbackCodeField = (hasCode: boolean): NativeSheetField => ({
  id: FIELD,
  section: SECTION,
  label: 'Feedback invite code',
  help: hasCode
    ? 'Saved, encrypted with your Keychain. Paste a new code to replace it.'
    : 'From your Trezi beta invite. Send Feedback asks for it the first time.',
  kind: 'secure',
  value: '',
  draft: true,
  placeholder: hasCode ? 'Saved' : 'Paste invite code'
})

function show(sheet: Sheet, hasCode: boolean) {
  const fields = sheet.state.fields.filter((f) => f.id !== FIELD)
  const last = fields.map((f) => f.section).lastIndexOf(SECTION)
  fields.splice(last < 0 ? fields.length : last + 1, 0, feedbackCodeField(hasCode))
  sheet.state.fields = fields
  sheet.state.actions = [
    ...sheet.state.actions.filter((a) => a.id !== SAVE && a.id !== REMOVE),
    ...(hasCode
      ? [{ id: REMOVE, label: 'Remove Invite Code', destructive: true, section: SECTION }]
      : []),
    { id: SAVE, label: 'Save Invite Code', section: SECTION }
  ]
}

export function withFeedbackCodeSetting(settings: NativeSettingsController) {
  const open = settings.open.bind(settings)
  settings.open = async () => {
    await open()
    const sheets = settings.sheets,
      sheet = sheets.current
    if (!sheet || decorated.has(sheet) || sheet.state.title !== 'Settings') return
    decorated.add(sheet)
    const status: { hasCode?: boolean } = await sheets
      .invoke('feedback:code-status')
      .catch(() => ({}))
    if (sheets.current !== sheet) return
    const handle = sheet.handle
    sheet.handle = async (action) => {
      if (action.action === SAVE || action.action === REMOVE) {
        const remove = action.action === REMOVE
        const code = remove ? '' : (action.values[FIELD]?.trim() ?? '')
        if (!remove && !code) throw new Error('Paste the invite code from your Trezi beta invite.')
        const result = await sheets.invoke('feedback:code', code)
        if (!result?.ok) throw new Error(result?.error ?? 'Could not save the invite code.')
        if (sheets.current !== sheet) return
        show(sheet, !remove)
        sheet.state.message = remove
          ? 'Invite code removed.'
          : `Invite code saved.${result.name ? ` Sending feedback as ${result.name}.` : ''}`
        sheets.refresh()
        return
      }
      await handle(action)
    }
    show(sheet, status.hasCode === true)
    sheets.refresh()
  }
  return settings
}

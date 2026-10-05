import type { ProviderLoginReport } from '../shared/api'
import type { NativeSheetAction, NativeSheetField, NativeSheetState } from '../shared/native-sheet'
import { loginSummary } from './chat-login'
import type { NativeSettingsController } from './settings-controller'
import type { NativeSheetController } from './sheets-runtime'

/** The Claude pane of AI Providers, in the shape of the other provider panes. */
interface Pane {
  detail: string
  fields: Omit<NativeSheetField, 'section' | 'draft'>[]
  actions: NativeSheetState['actions']
}
type Sheet = NonNullable<NativeSheetController['current']>
const ENTRY = { id: 'claude', label: 'Claude…', section: 'providers' }
const decorated = new WeakSet<Sheet>()
/** The token goes to the service and never comes back into a sheet. */
async function pane(sheets: NativeSheetController, report?: ProviderLoginReport): Promise<Pane> {
  const { hasToken }: { hasToken: boolean } = await sheets.invoke('providers:seat-token-status')
  return {
    detail:
      'Claude chats use the Claude CLI’s sign-in. If a chat says it is not logged in, run `claude auth login` in Terminal, or run `claude setup-token` and paste the token it prints here. The token is encrypted with your Keychain and given only to Claude chats.',
    fields: [
      {
        id: 'token',
        label: 'Subscription token',
        help: hasToken ? 'Saved. Paste a new token to replace it.' : 'From claude setup-token.',
        kind: 'secure',
        value: '',
        placeholder: hasToken ? 'Saved' : 'Paste token'
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
      { id: 'claude-check', label: 'Check login', section: 'providers' },
      ...(hasToken
        ? [{ id: 'claude-remove', label: 'Remove token', destructive: true, section: 'providers' }]
        : []),
      { id: 'claude-save', label: 'Save token', primary: true, section: 'providers' }
    ]
  }
}
/** Claude's sign-in (LKM-119): open its pane, "Check login", save or remove the `claude setup-token` token. */
async function claudeAction(
  sheets: NativeSheetController,
  sheet: Sheet,
  action: NativeSheetAction
) {
  let report: ProviderLoginReport | undefined, message: string | undefined
  if (action.action === 'claude-check')
    report = await sheets.invoke('providers:check-login', 'claude')
  else if (action.action !== 'claude') {
    const remove = action.action === 'claude-remove'
    const token = remove ? '' : (action.values.token?.trim() ?? '')
    if (!remove && !token) throw new Error('Paste the token that claude setup-token printed.')
    const result = await sheets.invoke('providers:seat-token-save', token)
    if (!result.ok) throw new Error(result.error ?? 'Could not save the token.')
    message = result.hasToken ? 'Token saved. New Claude chats use it.' : 'Token removed.'
  }
  const next = await pane(sheets, report)
  if (sheets.current !== sheet) return
  // Swap the AI Providers pane in place, like the provider editor does: other panes untouched.
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
/** Add the Claude entry to the provider list, wherever the list is shown. */
const offer = (sheet: Sheet) => {
  const actions = sheet.state.actions,
    add = actions.findIndex((a) => a.id === 'add')
  if (add >= 0 && !actions.some((a) => a.id === ENTRY.id))
    sheet.state.actions = [...actions.slice(0, add + 1), ENTRY, ...actions.slice(add + 1)]
}
/**
 * AI Providers → Claude… on top of the Settings window, without touching its controller:
 * each opened Settings sheet gets the entry and routes `claude*` actions to the pane above.
 */
export function withClaudePane(settings: NativeSettingsController) {
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
      if (action.action.startsWith('claude')) return claudeAction(sheets, sheet, action)
      await handle(action)
      offer(sheet)
    }
    offer(sheet)
    sheets.refresh()
  }
  return settings
}

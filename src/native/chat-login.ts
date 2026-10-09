import type { ProviderErrorCode, ProviderLoginReport } from '../shared/api'
import { agentOptionsFor } from '../shared/chat-settings'
import type { NativeChatCard } from '../shared/native-chat'
import type { NativeChatController } from './chat-controller'
import type { Chat } from './chat-state'

/**
 * The provider login card (LKM-119). A turn that ended because the provider is not
 * signed in (`code: 'auth'`, including a typed `/login`) or never answered
 * (`code: 'no-response'`) shows this card instead of warning text in the transcript:
 * the steps to sign in, "Check login" (the provider's auth status, from a helper
 * launched like the chat's) and Retry (a fresh session, then the same message again).
 */
export interface ChatLogin {
  code: ProviderErrorCode
  message: string
  report?: ProviderLoginReport
  checking?: boolean
}

const STEPS = [
  'To sign in, run `claude auth login` in Terminal, then choose Retry.',
  'Or run `claude setup-token` in Terminal and paste the token in Settings → AI providers → Claude.'
].join('\n')

export function loginSummary(report: ProviderLoginReport): string {
  const where = report.source === 'installed' ? ' (using the installed Claude CLI)' : ''
  return report.loggedIn === true
    ? `Logged in${report.authMethod ? ` with ${report.authMethod}` : ''}${where}.`
    : report.loggedIn === false
      ? 'Not logged in.'
      : 'Login status unknown.'
}

export function loginCard(chat: Chat): NativeChatCard | null {
  const login = chat.login
  if (!login) return null
  const claude = chat.settings.provider === 'claude'
  const title =
    login.code === 'auth'
      ? claude
        ? 'Not logged in to Claude'
        : 'Not logged in'
      : claude
        ? 'Claude did not respond'
        : 'The provider did not respond'
  const report = login.report ? `${loginSummary(login.report)}\n${login.report.detail}` : ''
  const detail = [
    login.message,
    claude ? STEPS : 'Sign in with the provider’s CLI in Terminal, then choose Retry.',
    report
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    id: 'login',
    title,
    detail,
    actions: [
      { label: 'Dismiss', action: 'login-dismiss' },
      {
        label: login.checking ? 'Checking…' : 'Check login',
        action: 'login-check',
        disabled: !!login.checking
      },
      {
        label: 'Retry',
        action: 'login-retry',
        disabled: !chat.last || chat.isRunning || chat.sending || chat.switching
      }
    ]
  }
}

export async function loginAction(
  controller: NativeChatController,
  chat: Chat,
  action: string
): Promise<void> {
  const login = chat.login
  if (!login) return
  if (action === 'login-dismiss') {
    chat.login = undefined
    return
  }
  if (action === 'login-check') {
    if (login.checking) return
    login.checking = true
    controller.changed(chat)
    try {
      login.report = await controller.services.invoke(
        'providers:check-login',
        chat.settings.provider,
        chat.root
      )
    } finally {
      login.checking = false
    }
    return
  }
  if (action !== 'login-retry' || !chat.last || chat.isRunning || chat.sending || chat.switching)
    return
  // A fresh session: its helper reads the current sign-in and any newly saved token.
  chat.switching = true
  controller.changed(chat)
  try {
    const result = await controller.services.invoke(
      'agent:restart-chat',
      chat.root,
      chat.chat,
      agentOptionsFor(chat.settings)
    )
    if (!result.ok) throw new Error(result.error ?? 'Unable to restart this chat.')
  } finally {
    chat.switching = false
  }
  chat.login = undefined
  chat.paused = false
  await controller.run(chat, { ...chat.last, id: crypto.randomUUID() })
}

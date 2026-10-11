import type { ProviderErrorCode, ProviderLoginReport } from '../shared/api'
import { agentOptionsFor } from '../shared/chat-settings'
import type { NativeChatCard } from '../shared/native-chat'
import type { BuiltinProvider, ProviderReadinessMap } from '../shared/provider-readiness'
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

const name = (provider: string) => (provider === 'claude' ? 'Claude' : 'Codex')
const signInActions = (chat: Chat) =>
  (['claude', 'codex'] as const).map((provider) => ({
    label:
      chat.signingIn === provider
        ? `Signing in to ${name(provider)}…`
        : `Sign in to ${name(provider)}`,
    action: `sign-in-${provider}`,
    disabled: !!chat.signingIn
  }))

export function startLoginCard(chat: Chat, readiness: ProviderReadinessMap): NativeChatCard | null {
  if (
    chat.messages.length ||
    chat.login ||
    readiness.claude.status === 'ready' ||
    readiness.codex.status === 'ready'
  )
    return null
  const detail =
    chat.signInMessage ??
    (readiness.claude.status === 'checking' || readiness.codex.status === 'checking'
      ? 'Checking provider sign-in…'
      : 'Sign in to either provider to start chatting.')
  return {
    id: 'provider-start',
    title: 'Choose a provider',
    detail,
    actions: [
      ...signInActions(chat),
      ...(chat.signingIn ? [{ label: 'Cancel sign-in', action: 'sign-in-cancel' }] : [])
    ]
  }
}

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
  const title =
    login.code === 'auth'
      ? `Not logged in to ${name(chat.settings.provider)}`
      : `${name(chat.settings.provider)} did not respond`
  const report = login.report ? `${loginSummary(login.report)}\n${login.report.detail}` : ''
  const detail = [
    login.code === 'auth'
      ? `${name(chat.settings.provider)} needs sign-in.`
      : `${name(chat.settings.provider)} did not respond.`,
    chat.signInMessage ??
      `Sign in to ${name(chat.settings.provider)}, then choose Retry to send this message.`,
    report
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    id: 'login',
    title,
    detail,
    actions: [
      ...signInActions(chat),
      ...(chat.signingIn ? [{ label: 'Cancel sign-in', action: 'sign-in-cancel' }] : []),
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

/** Retry restarts the chat with its own provider, so it only helps when that one signed in. */
function readyHint(chat: Chat, provider: string): string {
  if (!(chat.last && chat.login)) return 'Send your message when ready.'
  return chat.settings.provider === provider
    ? 'Choose Retry to send the saved message.'
    : `This chat uses ${name(chat.settings.provider)}. Start a new chat with ${name(provider)} or switch the provider in the model picker, then send your message again.`
}

export async function loginAction(
  controller: NativeChatController,
  chat: Chat,
  action: string
): Promise<void> {
  const login = chat.login
  if (action === 'sign-in-cancel') {
    if (chat.signingIn) await controller.services.invoke('providers:cancel-sign-in', chat.signingIn)
    return
  }
  if (action === 'sign-in-claude' || action === 'sign-in-codex') {
    if (chat.signingIn) return
    const provider = action.slice('sign-in-'.length) as BuiltinProvider
    chat.signingIn = provider
    chat.paused = true
    chat.signInMessage = `Waiting for ${name(provider)} sign-in in your browser…`
    controller.changed(chat)
    try {
      const result = await controller.services.invoke('providers:sign-in', provider, chat.root)
      chat.signInMessage = result.ok
        ? `${name(provider)} is ready. ${readyHint(chat, provider)}`
        : result.reason === 'cancelled'
          ? 'Sign-in cancelled. Your message is still here.'
          : (result.detail ?? 'Sign-in did not complete. Retry when ready.')
      await controller.refreshReadiness(provider)
      if (result.ok && !chat.messages.length && chat.settings.provider !== provider)
        await controller.choice(chat, 'Provider', provider)
    } catch {
      chat.signInMessage = 'Sign-in could not start. Check your connection and retry.'
    } finally {
      chat.signingIn = undefined
      controller.changed(chat)
    }
    return
  }
  if (!login) return
  if (action === 'login-dismiss') {
    chat.login = undefined
    chat.signInMessage = undefined
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

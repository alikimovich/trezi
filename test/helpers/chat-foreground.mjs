/** The host's answer (`ChatAcceptance.swift`) when the chat window is not key in the active app. */
export const CHAT_NOT_FOREGROUND = 'Chat must be foreground'

/**
 * Chat acceptance reads real window geometry, so the host refuses it unless the chat window is key
 * in the active app, and another worker's native run on the same desktop can take focus at any
 * moment. This wraps a host bridge so that every `chatAcceptance` request first activates the app
 * and makes the chat window key (`prepare`: the host waits until it reports itself foreground),
 * and a request the host still refuses is sent once more after a fresh activation. The refusal is
 * the host's first check, before it applies any width, override or hover, so the failed attempt
 * leaves nothing behind; the retry sends the same absolute state again. Any other error, and a
 * second refusal, propagate unchanged: the host's precondition and every assertion stay as they are.
 */
export function foregroundChatHost(host, warn = console.warn) {
  const acceptance = async (body = {}) => {
    try {
      return await host.request('chatAcceptance', { ...body, prepare: true })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== CHAT_NOT_FOREGROUND) throw error
      warn('Chat acceptance lost foreground; reactivating and retrying once')
      return host.request('chatAcceptance', { ...body, prepare: true })
    }
  }
  return new Proxy(host, {
    get(target, key) {
      if (key === 'request')
        return (method, body) =>
          method === 'chatAcceptance' ? acceptance(body) : target.request(method, body)
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

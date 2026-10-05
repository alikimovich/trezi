// A mocked Claude Agent SDK for adapter tests (LKM-165): `query()` records every call's
// options and replays a script per call, reading the streaming input like the real one.
import { plugin } from 'bun'

export const calls = []
/** One script per `query()` call, in order: (input, options) => async messages. */
export const scripts = []

const mockModule = {
  query({ prompt, options }) {
    const call = { options, prompts: [] }
    calls.push(call)
    const script = scripts.shift()
    async function* run() {
      yield* script(
        (async function* () {
          for await (const message of prompt) {
            call.prompts.push(message.message.content)
            yield message
          }
        })(),
        options
      )
    }
    const iterator = run()
    return Object.assign(iterator, {
      supportedCommands: async () => [],
      supportedModels: async () => [],
      setModel: async () => {},
      setPermissionMode: async () => {},
      interrupt: async () => {}
    })
  },
  createSdkMcpServer: () => ({ type: 'sdk', name: 'trezi', instance: {} }),
  tool: (name, description, schema, handler) => ({ name, description, schema, handler })
}

plugin({
  name: 'claude-sdk-mock',
  setup(build) {
    build.module('@anthropic-ai/claude-agent-sdk', () => ({
      exports: mockModule,
      loader: 'object'
    }))
  }
})

/** A scripted turn: waits for the next user message, then answers with one result. */
export const answer = (text = 'ok') =>
  async function* (input) {
    for await (const _ of input) {
      yield { type: 'system', subtype: 'init', session_id: 'new-session', slash_commands: [] }
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text }], usage: {} }
      }
      yield { type: 'result', subtype: 'success', is_error: false }
      return
    }
  }

/** A resume the CLI rejects, the way the SDK reports it. */
export const noConversation = (id) => () => ({
  [Symbol.asyncIterator]: () => ({
    next: () =>
      Promise.reject(
        new Error(
          `Claude Code returned an error result: No conversation found with session ID: ${id}`
        )
      )
  })
})

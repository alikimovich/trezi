import type { ProviderConnection } from '../shared/api'

export class MissingJevCredentialError extends Error {}

/** The saved Vercel AI Gateway connection Jev may use. Never a custom endpoint's. */
export function jevConnection(
  connections: ProviderConnection[],
  connectionId?: string
): ProviderConnection | undefined {
  const gateways = connections.filter((connection) => {
    try {
      const url = new URL(connection.baseUrl)
      return (
        connection.preset === 'gateway' &&
        connection.hasKey &&
        url.origin === 'https://ai-gateway.vercel.sh' &&
        !url.username &&
        !url.password
      )
    } catch {
      return false
    }
  })
  const selected = gateways.find((connection) => connection.id === connectionId)
  if (!selected && gateways.length > 1)
    throw new Error(
      'Select a saved Vercel AI Gateway connection for Jev; multiple connections are configured.'
    )
  return selected ?? gateways[0]
}

export function checkedJevKey(key: string | null): string {
  if (!key?.trim())
    throw new Error('Reconnect Vercel AI Gateway in Settings so Jev can access its saved key.')
  return key
}

/** Main-process only. Never send a custom endpoint's credential to Gateway. */
export function savedJevKey(
  store: { list: () => ProviderConnection[]; secretFor: (id: string) => string | null },
  connectionId?: string
): string | undefined {
  const connection = jevConnection(store.list(), connectionId)
  return connection && checkedJevKey(store.secretFor(connection.id))
}

export async function resolveJevKey(connectionId?: string): Promise<string> {
  const override = process.env.JEV_AI_GATEWAY_API_KEY?.trim()
  if (override) return override
  const { resolveSavedJevKey } = await import('./providers')
  const key = (await resolveSavedJevKey(connectionId)) ?? process.env.AI_GATEWAY_API_KEY?.trim()
  if (!key)
    throw new MissingJevCredentialError(
      'Connect Vercel AI Gateway in Settings to use Jev, or set JEV_AI_GATEWAY_API_KEY.'
    )
  return key
}

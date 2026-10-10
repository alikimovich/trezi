/** Probe from the same helper process and environment as the provider CLI. A 401/403
 * still proves DNS, proxy and TLS work; the probe never sends credentials. */
export async function providerReachable(host: string): Promise<boolean> {
  try {
    const response = await fetch(host, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
    return response.status > 0
  } catch {
    return false
  }
}

export const recoveryDelay = (attempt: number): number => Math.min(250 * 2 ** attempt, 2000)

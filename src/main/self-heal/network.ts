type Probe = (host: string) => Promise<boolean>

/** Probe from the same helper process and environment as the provider CLI. A 401/403
 * still proves DNS, proxy and TLS work; the probe never sends credentials. */
const fetchProbe: Probe = async (host) => {
  try {
    const response = await fetch(host, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
    return response.status > 0
  } catch {
    return false
  }
}

let probe = fetchProbe

/** Tests replace the probe so no run reaches the network; `null` restores it. */
export function setProviderProbe(replacement: Probe | null): void {
  probe = replacement ?? fetchProbe
}

export const providerReachable = (host: string): Promise<boolean> => probe(host)

export const recoveryDelay = (attempt: number): number => Math.min(250 * 2 ** attempt, 2000)

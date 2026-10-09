import { chooseControlsWithJev } from './controls-jev'
import { MissingJevCredentialError } from './jev-credentials'

/** Missing optional credentials must not prevent source-backed controls. */
export async function selectControlCandidates<T>(
  key: string,
  candidates: T[],
  options: { engine?: string; prompt?: string; connectionId?: string },
  choose: typeof chooseControlsWithJev<T> = chooseControlsWithJev
): Promise<{ controls: T[]; engine: 'agent' | 'jev'; fallback?: string }> {
  if (!options.engine || options.engine === 'agent')
    return { controls: candidates, engine: 'agent' }
  if (options.engine !== 'auto' && options.engine !== 'jev')
    throw new Error('Unknown control engine.')
  try {
    const controls = await choose(key, options.prompt ?? '', candidates, {
      connectionId: options.connectionId
    })
    return { controls, engine: 'jev' }
  } catch (error) {
    if (!(error instanceof MissingJevCredentialError)) throw error
    return {
      controls: candidates,
      engine: 'agent',
      fallback:
        'No Gateway key is configured. Used the chat model’s prepared controls; Jev was not called.'
    }
  }
}

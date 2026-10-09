import type { ChatAgentSettings } from '../shared/chat-settings'
import type { NativePreferences } from './preferences'

/**
 * LKM-144: the Claude Code CLI that runs a Claude chat touches a network volume while it
 * starts (TCC: responsible TreziHost, accessing the bundled `claude`). macOS then asks
 * whether "Trezi" may access files on a network volume. Trezi cannot configure that
 * away: sandbox settings only restrict the commands Claude runs, not the CLI process
 * itself (docs/PROVIDERS.md "Network-volume prompt"). So the first Claude turn of a
 * profile explains it once, as a status line in that turn. macOS asks once per app
 * identity, which stable signing (LKM-137) keeps across rebuilds.
 */
export const NETWORK_VOLUME_NOTE_KEY = 'trezi:network-volume-note:v1'
export const NETWORK_VOLUME_NOTE =
  'If macOS asks whether Trezi may access files on a network volume: Claude Code checks one as it starts. Allow it only if your project is on a network drive.'

/** Runs on the Claude CLI (`pickProvider`): not a connection, Codex or Gemini chat. */
export const runsClaudeCli = (settings: Pick<ChatAgentSettings, 'provider' | 'connectionId'>) =>
  !settings.connectionId && settings.provider !== 'codex' && settings.provider !== 'gemini'

/** The note for this turn, once per profile; marks it shown. */
export function networkVolumeNote(
  preferences: Pick<NativePreferences, 'get' | 'set'>,
  report: (error: unknown) => void = () => {}
) {
  return (settings: Pick<ChatAgentSettings, 'provider' | 'connectionId'>): string | undefined => {
    if (!runsClaudeCli(settings) || preferences.get(NETWORK_VOLUME_NOTE_KEY)) return undefined
    void preferences.set(NETWORK_VOLUME_NOTE_KEY, 'shown').catch(report)
    return NETWORK_VOLUME_NOTE
  }
}

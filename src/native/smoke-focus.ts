import type { NativeBridge } from './bridge'
import { type FocusReport, parseInjectedFailures, type SmokeHooks } from './smoke-runner'

/** LKM-176: the runner's focus hooks over the host's `smokeFocus` test command
 *  (`SmokeFocus.swift`). `restore` re-activates Trezi and makes a window key only when
 *  focus is missing, waiting at most 2 s; `lose` takes focus away in-process to simulate
 *  another app or a system dialog. Background runs never take focus, so they get none. */
export function smokeFocusHooks(
  host: NativeBridge,
  env: NodeJS.ProcessEnv = process.env
): Pick<SmokeHooks, 'focus' | 'loseFocus' | 'stealFocus'> {
  if (env.TREZI_NATIVE_BACKGROUND_TEST === '1') return {}
  return {
    focus: async (): Promise<FocusReport> => {
      const report = await host.request('smokeFocus', { restore: true }, 10_000)
      return {
        focused: report?.focused === true,
        restored: report?.restored === true,
        lost: report?.lost === true,
        ...(typeof report?.reason === 'string' ? { reason: report.reason } : {})
      }
    },
    loseFocus: async () => {
      await host.request('smokeFocus', { lose: true }, 10_000)
    },
    stealFocus: parseInjectedFailures(env.TREZI_NATIVE_SMOKE_STEAL_FOCUS)
  }
}

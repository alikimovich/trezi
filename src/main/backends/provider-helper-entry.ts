/**
 * Provider helper process entry (S10/S15): runs one built-in adapter in a supervised
 * helper speaking the helper protocol (`helper-host.ts`). The Swift owner spawns this
 * with stdio only and a scrubbed environment (`ProviderHelper.swift`).
 */
import { initProductLog, productLog } from '../product-log'
import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import { geminiProvider } from './gemini'
import { runProviderHelper } from './helper-host'
import { managedBrowserEnv } from './managed-browser-path'
import { withSkillMenu } from './skill-menu'

// LKM-168: `TREZI_LOG_DIR` is the one log variable the scrubbed environment keeps.
initProductLog('helper')
productLog.info('lifecycle', 'Provider helper process started', { pid: process.pid })

// Every provider's shell tools reach Trezi's managed wrapper. The bundle's __dirname is
// out/native; direct tests use the source tree. PATH (managed first) is defence in
// depth: a login shell rebuilds it, so the verified absolute wrapper in
// TREZI_AGENT_BROWSER is the route (LKM-269). Codex and Claude also get it per turn.
Object.assign(process.env, managedBrowserEnv(__dirname, process.env.PATH, process.execPath))

runProviderHelper({
  claude: claudeProvider,
  codex: withSkillMenu(codexProvider),
  gemini: withSkillMenu(geminiProvider)
})

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
import { managedBrowserDirectory, managedBrowserPath } from './managed-browser-path'
import { withSkillMenu } from './skill-menu'

// LKM-168: `TREZI_LOG_DIR` is the one log variable the scrubbed environment keeps.
initProductLog('helper')
productLog.info('lifecycle', 'Provider helper process started', { pid: process.pid })

// Every provider's shell tools resolve agent-browser to Trezi's managed wrapper.
// The bundle's __dirname is out/native; direct tests use the source tree.
// An absolute global CLI path is not advertised to agents.
const managedBrowserDir = managedBrowserDirectory(__dirname)
if (managedBrowserDir)
  process.env.PATH = managedBrowserPath(managedBrowserDir, process.env.PATH, process.execPath)

runProviderHelper({
  claude: claudeProvider,
  codex: withSkillMenu(codexProvider),
  gemini: withSkillMenu(geminiProvider)
})

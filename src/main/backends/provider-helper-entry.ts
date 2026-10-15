/**
 * Provider helper process entry (S10/S15): runs one built-in adapter in a supervised
 * helper speaking the helper protocol (`helper-host.ts`). The Swift owner spawns this
 * with stdio only and a scrubbed environment (`ProviderHelper.swift`).
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { initProductLog, productLog } from '../product-log'
import { claudeProvider } from './claude'
import { codexProvider } from './codex'
import { geminiProvider } from './gemini'
import { runProviderHelper } from './helper-host'
import { withSkillMenu } from './skill-menu'

// LKM-168: `TREZI_LOG_DIR` is the one log variable the scrubbed environment keeps.
initProductLog('helper')
productLog.info('lifecycle', 'Provider helper process started', { pid: process.pid })

// Every provider's shell tools resolve agent-browser to Trezi's managed wrapper.
// In the bundled app __dirname points at the checkout root; direct tests use
// the source tree. An absolute global CLI path is not advertised to agents.
const managedBrowserDir = [
  join(__dirname, 'bin/managed'),
  join(__dirname, '../../../bin/managed')
].find((dir) => existsSync(join(dir, 'agent-browser')))
if (managedBrowserDir)
  process.env.PATH = `${managedBrowserDir}${delimiter}${process.env.PATH ?? ''}`

runProviderHelper({
  claude: claudeProvider,
  codex: withSkillMenu(codexProvider),
  gemini: withSkillMenu(geminiProvider)
})

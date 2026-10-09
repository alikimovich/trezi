import {
  AGENT_FILE_ACCESS_CHOICES,
  AGENT_FILE_ACCESS_KEY,
  agentFileAccess
} from '../main/agent-file-access'
import {
  AGENT_GIT_ACCESS_CHOICES,
  AGENT_GIT_ACCESS_KEY,
  agentGitAccess
} from '../main/agent-git-access'
import { AGENT_MERGE_KEY } from '../main/agent-merge-setting'
import { CLAUDE_USER_PLUGINS_KEY } from '../main/backends/claude-isolation'
import type { ModelChoice, ProviderConnection } from '../shared/api'
import type {
  NativeSheetAction,
  NativeSheetField,
  NativeSheetSection,
  NativeSheetState
} from '../shared/native-sheet'
import {
  parsePreferredModelState,
  preferredSelectValue,
  setFixedPreference,
  setLastUsedMode,
  settingsFromChoice
} from '../shared/preferred-model'
import {
  ACTIVITY_AUTO_OPEN_CHOICES,
  ACTIVITY_AUTO_OPEN_KEY,
  activityAutoOpen
} from './activity-controller'
import { appVersion } from './app-version'
import type { NativePreferences } from './preferences'
import { QUIT_DONT_ASK_CHOICES, QUIT_DONT_ASK_KEY } from './quit-guard'
import type { NativeSheetController } from './sheets-runtime'

const ids = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))]
const origin = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
/** Remembers the last selected Settings section. The settings keys themselves are unchanged. */
export const SETTINGS_SECTION_KEY = 'trezi:settings-section:v1'
const PROVIDERS =
  'Claude and Codex use your existing sign-ins. Add another provider to use its models in chats.'
const sections = (): NativeSheetSection[] => [
  { id: 'general', label: 'General', symbol: 'gearshape', detail: 'Changes save automatically.' },
  { id: 'providers', label: 'AI Providers', symbol: 'sparkles', detail: PROVIDERS },
  {
    id: 'experimental',
    label: 'Experimental',
    symbol: 'testtube.2',
    detail: 'Changes save automatically. UI generation options apply to your next message.'
  },
  // LKM-202: its rows come from `settings-dreamer.ts`.
  {
    id: 'dreamer',
    label: 'Dreamer',
    symbol: 'moon.stars',
    detail: 'Where Send to Agent OS posts the Dreamer’s proposals, and the optional weekly run.'
  }
]
/** LKM-136: chat workspace cleanup, under General. Keep in sync with `src/main/chat-workspaces.ts`. */
const IDLE_KEY = 'trezi:chat-workspace-idle-days:v1'
const IDLE_CHOICES = [
  ...['1', '3', '7', '14', '30'].map((days) => ({
    value: days,
    label: days === '1' ? '1 day' : `${days} days`
  })),
  { value: 'never', label: 'Never' }
]
const CLEAN_UP = { id: 'clean-workspaces', label: 'Clean up now', section: 'general' }
const size = (bytes: number) =>
  bytes < 1024 ** 2
    ? `${Math.round(bytes / 1024)} KB`
    : bytes < 1024 ** 3
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${(bytes / 1024 ** 3).toFixed(1)} GB`
const usageText = (usage: { bytes: number; workspaces: number }) =>
  `${size(usage.bytes)} in ${usage.workspaces} ${usage.workspaces === 1 ? 'workspace' : 'workspaces'}`
const defaultChoices = (choices: ModelChoice[]) => [
  { value: 'last-used', label: 'Use last selected model' },
  ...choices.map((c) => ({ value: c.value, label: `${c.group} · ${c.label}` }))
]
/** The AI Providers pane: its fields are drafts, submitted only by the pane's own actions. */
interface Pane {
  detail: string
  fields: Omit<NativeSheetField, 'section' | 'draft'>[]
  actions: NativeSheetState['actions']
}
export class NativeSettingsController {
  private choices: ModelChoice[] = []
  private connections: ProviderConnection[] = []
  /** The provider the editor or the remove confirmation is about. */
  private target?: ProviderConnection
  constructor(
    readonly sheets: NativeSheetController,
    readonly preferences: NativePreferences,
    readonly notify: () => void
  ) {}
  private get invoke() {
    return this.sheets.invoke
  }
  /** One Settings window: General, AI Providers and Experimental in a sidebar. Autosaved. */
  async open() {
    const generation = this.sheets.generation
    const [choices, connections]: [ModelChoice[], ProviderConnection[]] = await Promise.all([
      this.invoke('providers:choices'),
      this.invoke('providers:list')
    ])
    if (generation !== this.sheets.generation) return
    this.choices = choices
    this.connections = connections
    this.target = undefined
    let raw: unknown
    try {
      raw = JSON.parse(this.preferences.get('trezi:preferred-model') ?? 'null')
    } catch {}
    const preferred = parsePreferredModelState(raw)
    const all = sections(),
      saved = this.preferences.get(SETTINGS_SECTION_KEY)
    const providers = this.list()
    this.sheets.present(
      {
        title: 'Settings',
        detail: '',
        sections: all,
        section: all.find((s) => s.id === saved)?.id ?? 'general',
        fields: [
          {
            id: 'default',
            section: 'general',
            label: 'Default model',
            help: 'New chats start with this model.',
            kind: 'choice',
            value: preferredSelectValue(preferred),
            choices: defaultChoices(choices)
          },
          {
            id: 'claudePlugins',
            section: 'general',
            label: 'Allow my Claude Code plugins in Trezi chats',
            help: 'Off: Claude chats load your CLAUDE.md files and skills, but not your own Claude Code plugins or MCP servers. Applies to new chats.',
            kind: 'choice',
            value: this.preferences.get(CLAUDE_USER_PLUGINS_KEY) === 'true' ? 'true' : 'false',
            choices: [
              { value: 'false', label: 'Don’t allow' },
              { value: 'true', label: 'Allow' }
            ]
          },
          {
            id: 'agentFileAccess',
            section: 'general',
            label: 'Agent file access',
            help: 'Full access: any file and the network. Project only: Codex edits only the chat’s copy of your project. Applies to new chats.',
            kind: 'choice',
            value: agentFileAccess(this.preferences.get(AGENT_FILE_ACCESS_KEY)),
            choices: AGENT_FILE_ACCESS_CHOICES
          },
          {
            id: 'agentGitAccess',
            section: 'general',
            label: 'Agent Git access',
            help: 'Managed: use Trezi Git tools and read-only Git. Full: also allow Git changes in the chat workspace. Publishing stays in Trezi.',
            kind: 'choice',
            value: agentGitAccess(this.preferences.get(AGENT_GIT_ACCESS_KEY)),
            choices: AGENT_GIT_ACCESS_CHOICES
          },
          {
            id: 'agentMerge',
            section: 'general',
            label: 'Agent can merge pull requests',
            help: 'When off, an agent must ask before merging a pull request.',
            kind: 'choice',
            value: this.preferences.get(AGENT_MERGE_KEY) === 'false' ? 'false' : 'true',
            choices: [
              { value: 'true', label: 'On' },
              { value: 'false', label: 'Off' }
            ]
          },
          {
            id: 'workspaceIdle',
            section: 'general',
            label: 'Remove idle chat workspaces after',
            help: 'Each chat edits a private copy of your project. An idle copy is removed and made again on the chat’s next message. Copies with unsaved or unapplied work are kept.',
            kind: 'choice',
            value: IDLE_CHOICES.some((c) => c.value === this.preferences.get(IDLE_KEY))
              ? this.preferences.get(IDLE_KEY)!
              : '7',
            choices: IDLE_CHOICES
          },
          {
            id: 'activityAutoOpen',
            section: 'general',
            label: 'Show Activity automatically',
            help: 'Unread warnings always show a dot on Activity.',
            kind: 'choice',
            value: activityAutoOpen(this.preferences.get(ACTIVITY_AUTO_OPEN_KEY)),
            choices: ACTIVITY_AUTO_OPEN_CHOICES
          },
          {
            id: 'quitDontAsk',
            section: 'general',
            label: 'Quit while agents are working',
            help: 'A landing or publish still finishes first.',
            kind: 'choice',
            value: this.preferences.get(QUIT_DONT_ASK_KEY) === 'true' ? 'true' : 'false',
            choices: QUIT_DONT_ASK_CHOICES
          },
          {
            id: 'workspaceUsage',
            section: 'general',
            label: 'Chat workspaces',
            help: 'Clean up now removes every idle copy under the same rules; running chats are kept.',
            kind: 'readonly',
            value: 'Calculating…',
            draft: true
          },
          {
            id: 'version',
            section: 'general',
            label: 'Version',
            kind: 'readonly',
            value: appVersion()
          },
          {
            id: 'projectUi',
            section: 'experimental',
            label: 'Gen UI',
            help: 'Generate UI using your project’s existing components and styles. Experimental; supports React and Svelte.',
            kind: 'choice',
            value: this.preferences.get('trezi:project-ui:v1') ?? 'false',
            choices: [
              { value: 'false', label: 'Off' },
              { value: 'true', label: 'On' }
            ]
          },
          {
            id: 'engine',
            section: 'experimental',
            label: 'UI layout method',
            help: 'Chat model uses your selected chat model to arrange components. Jev uses a separate layout model and requires an AI Gateway API key.',
            visibleWhen: { field: 'projectUi', value: 'true' },
            kind: 'choice',
            value: this.preferences.get('trezi:project-ui-engine:v1') ?? 'agent',
            choices: [
              { value: 'agent', label: 'Chat model' },
              { value: 'jev', label: 'Jev layout engine' }
            ]
          },
          ...providers.fields.map((field) => ({ ...field, section: 'providers', draft: true }))
        ],
        autosave: true,
        actions: [CLEAN_UP, ...providers.actions]
      },
      (action) => this.handle(action),
      (section) => {
        void this.preferences.set(SETTINGS_SECTION_KEY, section).catch(() => {})
      }
    )
    void this.usage(this.sheets.current?.state.id)
  }
  /** `du` can take a moment on large projects, so the window opens first. */
  private async usage(id: string | undefined, usage?: { bytes: number; workspaces: number }) {
    let text: string
    try {
      text = usageText(usage ?? (await this.invoke('chat-workspaces:usage')))
    } catch {
      text = 'Unavailable'
    }
    const field =
      this.sheets.current?.state.id === id
        ? this.sheets.current?.state.fields.find((f) => f.id === 'workspaceUsage')
        : undefined
    if (!field) return
    field.value = text
    this.sheets.refresh()
  }
  private async handle(action: NativeSheetAction) {
    if (action.action === 'save') return this.save(action)
    if (action.action === 'clean-workspaces') {
      const result = await this.invoke('chat-workspaces:clean-up')
      await this.usage(action.id, result.usage)
      if (this.sheets.current?.state.id === action.id)
        this.sheets.current.state.message =
          result.removed || result.legacyRemoved
            ? `Removed ${result.removed + result.legacyRemoved} idle chat ${result.removed + result.legacyRemoved === 1 ? 'workspace' : 'workspaces'}.`
            : 'Nothing to clean up.'
      return
    }
    if (action.action === 'back') return this.reload(action.id)
    if (action.action === 'add') {
      this.target = undefined
      this.show(action.id, this.editor())
      return
    }
    if (action.action === 'edit' || action.action === 'delete') {
      const connection = this.connections.find((c) => c.id === action.values.connection)
      if (!connection) throw new Error('Choose a provider first.')
      this.target = connection
      this.show(
        action.id,
        action.action === 'edit' ? this.editor(connection) : this.removal(connection)
      )
      return
    }
    if (action.action === 'remove') {
      if (this.target) await this.invoke('providers:remove', this.target.id)
      return this.reload(action.id)
    }
    if (action.action === 'connect' || action.action === 'save-provider') return this.submit(action)
  }
  private async save(action: NativeSheetAction) {
    const choice = this.choices.find((c) => c.value === action.values.default)
    if (action.values.default !== 'last-used' && !choice)
      throw new Error('Select an available model.')
    if (
      !['true', 'false'].includes(action.values.projectUi) ||
      !['agent', 'jev'].includes(action.values.engine)
    )
      throw new Error('Invalid setting.')
    // Absent (an older sheet or caller) leaves the saved choice unchanged.
    const plugins = action.values.claudePlugins
    if (plugins !== undefined && !['true', 'false'].includes(plugins))
      throw new Error('Invalid setting.')
    const idle = action.values.workspaceIdle
    if (idle !== undefined && !IDLE_CHOICES.some((c) => c.value === idle))
      throw new Error('Invalid setting.')
    const activity = action.values.activityAutoOpen
    if (activity !== undefined && !ACTIVITY_AUTO_OPEN_CHOICES.some((c) => c.value === activity))
      throw new Error('Invalid setting.')
    const quitDontAsk = action.values.quitDontAsk
    if (quitDontAsk !== undefined && !['true', 'false'].includes(quitDontAsk))
      throw new Error('Invalid setting.')
    const access = action.values.agentFileAccess
    if (access !== undefined && !AGENT_FILE_ACCESS_CHOICES.some((c) => c.value === access))
      throw new Error('Invalid setting.')
    const gitAccess = action.values.agentGitAccess
    if (gitAccess !== undefined && !AGENT_GIT_ACCESS_CHOICES.some((c) => c.value === gitAccess))
      throw new Error('Invalid setting.')
    const agentMerge = action.values.agentMerge
    if (agentMerge !== undefined && !['true', 'false'].includes(agentMerge))
      throw new Error('Invalid setting.')
    // One atomic batch, built from the committed state when it is sent (a chat may
    // have recorded a newer last-used model since the sheet opened). Autosave
    // keeps the draft and closing waits for this to settle.
    await this.preferences.apply((current) => {
      let saved: unknown
      try {
        saved = JSON.parse(current['trezi:preferred-model'] ?? 'null')
      } catch {}
      const state = parsePreferredModelState(saved)
      return [
        [
          'trezi:preferred-model',
          JSON.stringify(
            choice ? setFixedPreference(state, settingsFromChoice(choice)) : setLastUsedMode(state)
          )
        ],
        ['trezi:project-ui:v1', action.values.projectUi],
        ['trezi:project-ui-engine:v1', action.values.engine],
        ...(plugins === undefined ? [] : [[CLAUDE_USER_PLUGINS_KEY, plugins] as [string, string]]),
        ...(idle === undefined ? [] : [[IDLE_KEY, idle] as [string, string]]),
        ...(activity === undefined ? [] : [[ACTIVITY_AUTO_OPEN_KEY, activity] as [string, string]]),
        ...(quitDontAsk === undefined
          ? []
          : [[QUIT_DONT_ASK_KEY, quitDontAsk] as [string, string]]),
        ...(access === undefined ? [] : [[AGENT_FILE_ACCESS_KEY, access] as [string, string]]),
        ...(gitAccess === undefined ? [] : [[AGENT_GIT_ACCESS_KEY, gitAccess] as [string, string]]),
        ...(agentMerge === undefined ? [] : [[AGENT_MERGE_KEY, agentMerge] as [string, string]])
      ]
    })
    this.notify()
    if (this.sheets.current) this.sheets.current.state.message = 'Settings saved.'
  }
  /** Swap the AI Providers pane in place: same window, same section, the other panes untouched. */
  private show(id: string, pane: Pane) {
    const sheet = this.sheets.current
    if (!sheet || sheet.state.id !== id) return
    sheet.state.fields = [
      ...sheet.state.fields.filter((f) => f.section !== 'providers'),
      ...pane.fields.map((field) => ({ ...field, section: 'providers', draft: true }))
    ]
    sheet.state.actions = [CLEAN_UP, ...pane.actions]
    const section = sheet.state.sections?.find((s) => s.id === 'providers')
    if (section) section.detail = pane.detail
    sheet.state.message = undefined
    this.sheets.refresh()
  }
  /** Back to the provider list; new or removed providers also change the default-model choices. */
  private async reload(id: string) {
    const [choices, connections]: [ModelChoice[], ProviderConnection[]] = await Promise.all([
      this.invoke('providers:choices'),
      this.invoke('providers:list')
    ])
    const sheet = this.sheets.current
    if (!sheet || sheet.state.id !== id) return
    this.choices = choices
    this.connections = connections
    this.target = undefined
    const field = sheet.state.fields.find((f) => f.id === 'default')
    if (field) field.choices = defaultChoices(choices)
    this.show(id, this.list())
  }
  private list(): Pane {
    const connections = this.connections
    return {
      detail: PROVIDERS,
      fields: connections.length
        ? [
            {
              id: 'connection',
              label: 'Provider',
              kind: 'choice',
              value: connections[0].id,
              choices: connections.map((c) => ({
                value: c.id,
                label: `${c.label} · ${c.models.length} models · ${c.hasKey ? 'API key saved' : 'No API key'}`
              }))
            }
          ]
        : [{ id: 'connections', label: 'Added providers', kind: 'readonly', value: 'None' }],
      actions: [
        { id: 'add', label: 'Add provider…', section: 'providers' },
        ...(connections.length
          ? [
              { id: 'edit', label: 'Edit…', section: 'providers' },
              { id: 'delete', label: 'Remove…', section: 'providers' }
            ]
          : [])
      ]
    }
  }
  private removal(connection: ProviderConnection): Pane {
    return {
      detail: PROVIDERS,
      fields: [
        {
          id: 'remove-confirm',
          label: `Remove ${connection.label}?`,
          help: 'Remove this provider and its saved API key from Trezi. Chats using it will switch to a default model.',
          kind: 'readonly',
          value: ''
        }
      ],
      actions: [
        { id: 'back', label: 'Back', section: 'providers' },
        {
          id: 'remove',
          label: 'Remove provider',
          primary: true,
          destructive: true,
          section: 'providers'
        }
      ]
    }
  }
  private editor(connection?: ProviderConnection): Pane {
    return {
      detail: `${connection ? `Edit ${connection.label}` : 'Add a provider'}: enter its API base URL and key, then load its models or enter model IDs below. The provider must support the Responses API.`,
      fields: [
        {
          id: 'label',
          label: 'Provider name',
          kind: 'text',
          value: connection?.label ?? 'AI Gateway',
          placeholder: 'Required'
        },
        {
          id: 'url',
          label: 'API base URL',
          kind: 'text',
          value: connection?.baseUrl ?? 'https://ai-gateway.vercel.sh/v1',
          placeholder: 'https://'
        },
        connection?.hasKey
          ? {
              id: 'key',
              label: 'API key',
              help: 'Leave blank to keep the current key.',
              kind: 'secure',
              value: '',
              placeholder: 'Saved'
            }
          : { id: 'key', label: 'API key', kind: 'secure', value: '', placeholder: 'Required' },
        {
          id: 'models',
          label: 'Model IDs (one per line)',
          kind: 'multiline',
          value: connection?.models.join('\n') ?? ''
        }
      ],
      actions: [
        { id: 'back', label: 'Back', section: 'providers' },
        { id: 'connect', label: 'Load models', section: 'providers' },
        {
          id: 'save-provider',
          label: connection ? 'Update provider' : 'Add provider',
          primary: true,
          section: 'providers'
        }
      ]
    }
  }
  private async submit(action: NativeSheetAction) {
    const connection = this.target
    const { values } = action
    const baseUrl = values.url?.trim() ?? '',
      apiKey = values.key?.trim() ?? ''
    const endpointOrigin = origin(baseUrl)
    if (!endpointOrigin) throw new Error('Enter the provider’s API base URL, including https://.')
    if (!apiKey && (!connection || origin(connection.baseUrl) !== endpointOrigin))
      throw new Error('Enter an API key for this provider URL.')
    const key = apiKey ? { apiKey } : {}
    if (action.action === 'connect') {
      const result = await this.invoke('providers:catalog', {
        baseUrl,
        ...(connection ? { id: connection.id } : {}),
        ...key
      })
      if (!result.ok && !result.unsupported)
        throw new Error(result.error ?? 'Could not load models. Check the URL and API key.')
      const sheet = this.sheets.current
      if (!sheet || sheet.state.id !== action.id) return
      const field = sheet.state.fields.find((f) => f.id === 'models')
      if (!field) return
      field.kind = result.unsupported ? 'multiline' : 'multichoice'
      field.label = result.unsupported ? 'Model IDs (one per line)' : 'Models for chats'
      field.choices = [...new Set<string>([...result.models, ...ids(values.models ?? '')])].map(
        (value) => ({ value, label: value })
      )
      sheet.state.message = result.unsupported
        ? 'This provider does not list its models. Enter their IDs, one per line.'
        : 'Choose the models you want to use in chats, then save this provider.'
      return
    }
    const models = ids(values.models ?? '')
    if (!values.label?.trim() || !models.length)
      throw new Error('Enter a provider name and choose or enter at least one model.')
    const result = await this.invoke('providers:save', {
      ...(connection ? { id: connection.id } : {}),
      label: values.label.trim(),
      baseUrl,
      preset: endpointOrigin === 'https://ai-gateway.vercel.sh' ? 'gateway' : 'custom',
      wireApi: 'responses',
      models,
      ...key
    })
    if (!result.ok) throw new Error(result.error ?? 'Could not save this provider.')
    await this.reload(action.id)
  }
}

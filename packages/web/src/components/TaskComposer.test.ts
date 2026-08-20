import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import {
  commandForAgentId,
  CURRENT_AGENT_ID,
  matchAgentId,
  pickerAgents,
  taskComposerPayload,
} from '../composables/taskComposer'
import { catalogs, t } from '../i18n'
import type { AgentOption } from '../types'

Bun.plugin({
  name: 'vue-sfc-with-template',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const { descriptor } = parse(source, { filename: args.path })
      const compiled = compileScript(descriptor, { id: args.path, inlineTemplate: true })
      return { contents: compiled.content, loader: 'ts' }
    })
  },
})

const AGENTS: AgentOption[] = [
  {
    id: 'claude',
    label: 'Claude Code (Anthropic)',
    bin: 'claude',
    command: 'claude -p',
    detected: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    command: 'opencode run',
    detected: true,
  },
  {
    id: 'codex',
    label: 'Codex CLI (OpenAI / ChatGPT)',
    bin: 'codex',
    command: 'codex exec -',
    detected: false,
  },
]

async function renderComposer(
  overrides: {
    agents?: AgentOption[]
    currentAgent?: string
    isolation?: 'container' | 'policy' | null
  } = {},
): Promise<string> {
  const TaskComposer = (await import('./TaskComposer.vue')).default
  const app = createSSRApp(TaskComposer, {
    creating: false,
    error: null,
    agents: overrides.agents ?? AGENTS,
    currentAgent: overrides.currentAgent ?? 'claude -p',
    isolation: overrides.isolation ?? null,
  })
  app.config.globalProperties.$t = t
  return await renderToString(app)
}

describe('taskComposerPayload', () => {
  test('emits agent only when it differs from the project default', () => {
    expect(
      taskComposerPayload({
        title: 'Title',
        prompt: 'do it',
        autoShip: false,
        agent: 'opencode run',
        defaultAgent: 'claude -p',
      }),
    ).toEqual({
      title: 'Title',
      prompt: 'do it',
      autoShip: false,
      agent: 'opencode run',
    })
    expect(
      taskComposerPayload({
        title: 'Title',
        prompt: 'do it',
        autoShip: false,
        agent: 'claude -p',
        defaultAgent: 'claude -p',
      }),
    ).toEqual({
      title: 'Title',
      prompt: 'do it',
      autoShip: false,
    })
    expect(
      taskComposerPayload({ title: 'Title', prompt: 'do it', autoShip: true, agent: '' }),
    ).toEqual({
      title: 'Title',
      prompt: 'do it',
      autoShip: true,
    })
  })

  test('an unmatched default command stays on a dedicated option, never another provider', () => {
    const current = 'opencode run -m openrouter/foo'
    expect(matchAgentId(current, AGENTS)).toBe(CURRENT_AGENT_ID)
    expect(pickerAgents(AGENTS, current)[0]?.id).toBe(CURRENT_AGENT_ID)
    expect(pickerAgents(AGENTS, current)[0]?.command).toBe(current)
    expect(commandForAgentId(CURRENT_AGENT_ID, AGENTS, current)).toBe(current)
    expect(commandForAgentId('claude', AGENTS, current)).toBe('claude -p')
    expect(matchAgentId('claude -p', AGENTS)).toBe('claude')
    expect(matchAgentId('', AGENTS)).toBe('')
  })
})

describe('TaskComposer agent picker', () => {
  test('renders a select of known agents, detected first', async () => {
    const html = await renderComposer()
    expect(html).toContain(t('workspace.agentLabel'))
    const opencodeAt = html.indexOf('OpenCode')
    const codexAt = html.indexOf('Codex CLI')
    expect(opencodeAt).toBeGreaterThan(0)
    expect(codexAt).toBeGreaterThan(opencodeAt)
    expect(html).toContain('disabled')
  })

  test('shows the first-image hint when isolation is container', async () => {
    const html = await renderComposer({ isolation: 'container' })
    expect(html).toContain(t('workspace.agentBuildHint'))
  })

  test('hides the first-image hint when isolation is policy', async () => {
    const html = await renderComposer({ isolation: 'policy' })
    expect(html).not.toContain(t('workspace.agentBuildHint'))
  })

  test('hides the picker when no agents are given', async () => {
    const html = await renderComposer({ agents: [], currentAgent: '' })
    expect(html).not.toContain('tc-agent-select')
    expect(html).not.toContain(t('workspace.agentBuildHint'))
  })

  test('renders the unmatched default command as its own option', async () => {
    const html = await renderComposer({ currentAgent: 'opencode run -m openrouter/foo' })
    expect(html).toContain('value="_current"')
    expect(html).toContain('opencode run -m openrouter/foo')
    expect(html.indexOf('value="_current"')).toBeLessThan(html.indexOf('value="claude"'))
  })
})

describe('i18n keys for the per-task agent picker', () => {
  test('en and fr define the new keys, and French is actually translated', () => {
    for (const key of [
      'workspace.agentLabel',
      'workspace.agentBuildHint',
      'settings.agentTitle',
    ] as const) {
      expect(catalogs.en?.[key]).toBeDefined()
      expect(catalogs.fr?.[key]).toBeDefined()
    }
    expect(catalogs.fr?.['workspace.agentBuildHint']).not.toBe(
      catalogs.en?.['workspace.agentBuildHint'],
    )
    expect(catalogs.fr?.['settings.agentTitle']).not.toBe(catalogs.en?.['settings.agentTitle'])
  })
})

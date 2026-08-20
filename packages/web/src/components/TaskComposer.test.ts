import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { commandForAgentId, matchAgentId, taskComposerPayload } from '../composables/taskComposer'
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
  test('emits agent only when a command was selected', () => {
    expect(taskComposerPayload('Title', 'do it', false, 'opencode run')).toEqual({
      title: 'Title',
      prompt: 'do it',
      autoShip: false,
      agent: 'opencode run',
    })
    expect(taskComposerPayload('Title', 'do it', true, '')).toEqual({
      title: 'Title',
      prompt: 'do it',
      autoShip: true,
    })
  })

  test('keeps the session command when the matching agent is selected', () => {
    expect(matchAgentId('opencode run -m openrouter/foo', AGENTS)).toBe('opencode')
    expect(commandForAgentId('opencode', AGENTS, 'opencode run -m openrouter/foo')).toBe(
      'opencode run -m openrouter/foo',
    )
    expect(commandForAgentId('claude', AGENTS, 'opencode run -m openrouter/foo')).toBe('claude -p')
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
    const html = await renderComposer({ agents: [] })
    expect(html).not.toContain('tc-agent-select')
    expect(html).not.toContain(t('workspace.agentBuildHint'))
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

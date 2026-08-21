import { describe, expect, test } from 'bun:test'
import { createRenderer, createSSRApp, nextTick } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import {
  commandForAgentId,
  CURRENT_AGENT_ID,
  matchAgentId,
  pickerAgents,
  taskComposerPayload,
} from '../composables/taskComposer'
import { forkDraft, workonDraft, type DraftTarget } from '../composables/useColumns'
import type { PlanComposerInput } from '../composables/useTaskPlan'
import { catalogs, t } from '../i18n'
import type { AgentOption, TaskPlan } from '../types'

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
    draft?: DraftTarget | null
    plan?: TaskPlan | null
    planError?: string | null
    planPending?: boolean
  } = {},
): Promise<string> {
  const TaskComposer = (await import('./TaskComposer.vue')).default
  const app = createSSRApp(TaskComposer, {
    creating: false,
    error: null,
    agents: overrides.agents ?? AGENTS,
    currentAgent: overrides.currentAgent ?? 'claude -p',
    isolation: overrides.isolation ?? null,
    draft: overrides.draft ?? null,
    plan: overrides.plan ?? null,
    planError: overrides.planError ?? null,
    planPending: overrides.planPending ?? false,
  })
  app.config.globalProperties.$t = t
  return await renderToString(app)
}

const PLAN: TaskPlan = {
  mode: 'fork',
  repo: '/home/me/repo',
  title: 'Fix flaky cleanup',
  branch: 'codesema/task-fix-flaky-cleanup',
  branch_certain: true,
  worktree_root: '/home/me/repo/.codesema/worktrees',
  base: 'develop',
  target: 'develop',
  isolation: 'policy',
  isolation_reason: 'no container runtime found',
  agent: 'claude -p',
  queue_position: 2,
  issue: null,
  auto_ship: false,
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

  test('a modeled command of a known agent stays on that agent, keeping the model', () => {
    const current = 'opencode run -m openrouter/foo'
    expect(matchAgentId(current, AGENTS)).toBe('opencode')
    expect(pickerAgents(AGENTS, current).some((a) => a.id === CURRENT_AGENT_ID)).toBe(false)
    expect(commandForAgentId('opencode', AGENTS, current)).toBe(current)
    expect(commandForAgentId('claude', AGENTS, current)).toBe('claude -p')
    expect(matchAgentId('claude -p', AGENTS)).toBe('claude')
    expect(matchAgentId('', AGENTS)).toBe('')
  })

  test('an unmatched default command stays on a dedicated option, never another provider', () => {
    const current = 'my-agent --do-it'
    expect(matchAgentId(current, AGENTS)).toBe(CURRENT_AGENT_ID)
    expect(pickerAgents(AGENTS, current)[0]?.id).toBe(CURRENT_AGENT_ID)
    expect(pickerAgents(AGENTS, current)[0]?.command).toBe(current)
    expect(commandForAgentId(CURRENT_AGENT_ID, AGENTS, current)).toBe(current)
    expect(commandForAgentId('claude', AGENTS, current)).toBe('claude -p')
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
    const html = await renderComposer({ currentAgent: 'my-agent --do-it' })
    expect(html).toContain('value="_current"')
    expect(html).toContain('my-agent --do-it')
    expect(html.indexOf('value="_current"')).toBeLessThan(html.indexOf('value="claude"'))
  })

  test('a modeled OpenCode default selects OpenCode, not a duplicate row', async () => {
    const html = await renderComposer({ currentAgent: 'opencode run -m openrouter/foo' })
    expect(html).not.toContain('value="_current"')
    expect(html).toContain('value="opencode"')
  })
})

describe('i18n keys for the per-task agent picker', () => {
  test('en and fr define the new keys, and French is actually translated', () => {
    for (const key of [
      'workspace.agentLabel',
      'workspace.agentBuildHint',
      'settings.agentTitle',
      'settings.modelLabel',
      'settings.modelPlaceholder',
      'settings.modelPlaceholderOpencode',
      'settings.effortLabel',
      'settings.effortDefault',
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

// T2.6 — the half a human reads. The mechanism being right is not the point
// here: what is asserted is that the panel actually SHOWS the plan, in the
// workspace's own words, and never claims more than the server said.
describe('TaskComposer plan panel', () => {
  test('a composer with no draft shows no plan panel at all', async () => {
    const html = await renderComposer({ plan: PLAN })
    expect(html).not.toContain('tc-plan')
    expect(html).not.toContain(t('workspace.planTitle'))
  })

  test('a fork draft shows every field of the plan', async () => {
    const html = await renderComposer({ draft: forkDraft('develop'), plan: PLAN })
    expect(html).toContain(t('workspace.planTitle'))
    for (const label of [
      'workspace.planRepo',
      'workspace.planBranch',
      'workspace.planWorktree',
      'workspace.planBase',
      'workspace.planTarget',
      'workspace.planIsolation',
      'workspace.planAgent',
      'workspace.planQueue',
      'workspace.planIssue',
    ] as const) {
      expect(html).toContain(t(label))
    }
    expect(html).toContain('codesema/task-fix-flaky-cleanup')
    expect(html).toContain('/home/me/repo/.codesema/worktrees')
    expect(html).toContain('develop')
    // The isolation reason travels with the isolation: never the label alone.
    expect(html).toContain('no container runtime found')
    expect(html).toContain(t('workspace.planIsolationPolicy'))
    // A rank, not a mute "queued".
    expect(html).toContain(t('workspace.planQueueAt', { n: 2 }))
    // And the plan says out loud that it is only true right now.
    expect(html).toContain(t('workspace.planIndicative'))
  })

  test('a caged plan says container, a degraded one never does', async () => {
    const caged = await renderComposer({
      draft: forkDraft('develop'),
      plan: { ...PLAN, isolation: 'container', isolation_reason: 'podman is available' },
    })
    expect(caged).toContain(t('workspace.planIsolationContainer'))
    expect(caged).toContain('podman is available')
    const degraded = await renderComposer({ draft: forkDraft('develop'), plan: PLAN })
    expect(degraded).not.toContain(`>${t('workspace.planIsolationContainer')}`)
  })

  test('a branch the server would not promise is NOT shown as final', async () => {
    const html = await renderComposer({
      draft: forkDraft('develop'),
      plan: { ...PLAN, branch_certain: false },
    })
    expect(html).toContain(t('workspace.planBranchUncertain', { branch: PLAN.branch }))
  })

  test('a base the server could not detect is shown WITH its reason', async () => {
    const html = await renderComposer({
      draft: forkDraft('develop'),
      plan: { ...PLAN, base: '', target: '', base_note: 'no trunk branch found' },
    })
    expect(html).toContain('no trunk branch found')
  })

  test('the correctable field is prefilled with the draft’s own target, per mode', async () => {
    const fork = await renderComposer({ draft: forkDraft('develop'), plan: PLAN })
    expect(fork).toContain(t('workspace.planBaseLabel'))
    expect(fork).toContain('value="develop"')
    // Nothing to apply until the field actually differs from the draft.
    expect(fork).toContain('class="tc-plan-apply" type="button" disabled')
    // Fork mode says the branch follows the title — the one field a fork's
    // branch name actually depends on.
    expect(fork).toContain(t('workspace.planBranchDerived'))

    const workon = await renderComposer({
      draft: workonDraft('fix/x', 'release'),
      plan: { ...PLAN, mode: 'work_on', branch: 'fix/x', base: '', target: 'release' },
    })
    expect(workon).toContain(t('workspace.planBranchLabel'))
    expect(workon).toContain('value="fix/x"')
    // Nothing is branched in work-on mode: the "starts from" row is dropped
    // rather than rendered empty.
    expect(workon).not.toContain(t('workspace.planBase'))
    expect(workon).not.toContain(t('workspace.planBranchDerived'))
  })

  test('a plan that could not be worked out shows its reason instead of a stale plan', async () => {
    const html = await renderComposer({
      draft: forkDraft('develop'),
      plan: PLAN,
      planError: 'base branch ghost does not exist',
    })
    expect(html).toContain(t('workspace.planError', { error: 'base branch ghost does not exist' }))
    expect(html).not.toContain('codesema/task-fix-flaky-cleanup')
  })

  test('while the plan is being worked out, no stale plan is shown', async () => {
    const html = await renderComposer({
      draft: forkDraft('develop'),
      plan: PLAN,
      planPending: true,
    })
    expect(html).toContain(t('workspace.planLoading'))
    expect(html).not.toContain('codesema/task-fix-flaky-cleanup')
  })

  test('the panel offers no control that would create anything', async () => {
    const html = await renderComposer({ draft: forkDraft('develop'), plan: PLAN })
    // One Apply button in the panel, and the Launch button that was already
    // there — the correction never doubles as a creation.
    expect(html.split(t('workspace.launch')).length - 1).toBe(1)
    expect(html).toContain(t('workspace.planRetarget'))
  })
})

// ── The plan panel's own MECHANISM (T2.6 review round 1, MAJEUR 3) ────────
//
// The tests above render the panel to a string: they prove what a human reads,
// and nothing about what the component DOES. The one thing it has to do is
// ask for a plan — and the case that broke is the one no string can show, a
// fresh MOUNT with a prompt already in it. Correcting the target branch
// changes the draft column's key, so the `v-for` remounts this component with
// the prompt carried over; a watch that only fires on change fires never, the
// parent never hears a `plan-input`, and the panel sits empty until the human
// types one more character.
//
// Mounted on a NULL renderer rather than SSR: SSR runs `setup` and stops, so
// it cannot tell a watcher that fires on the initial value from one that fires
// in `onMounted` — and it cannot exercise an update at all, which is where the
// control below comes from.
// `@vue/runtime-dom`'s v-model feature-tests these two DOM constructors on
// every update, and bun's runtime defines neither. Two empty classes are the
// whole fix: no fake node is an instance of either, which is precisely the
// answer the guard is looking for ("this element is not the focused one").
function NotTheRealThing(): void {}
const globals = globalThis as unknown as Record<string, unknown>
globals.Document ??= NotTheRealThing
globals.ShadowRoot ??= NotTheRealThing

type FakeNode = {
  tag: string
  text: string
  parent: FakeNode | null
  children: FakeNode[]
  /** v-model's directives reach for these; a mount must not die on them. */
  addEventListener: () => void
  removeEventListener: () => void
  getRootNode: () => { activeElement: FakeNode | null }
  options: FakeNode[]
  value: string
  checked: boolean
}

const fakeNode = (tag: string): FakeNode => ({
  tag,
  text: '',
  parent: null,
  children: [],
  addEventListener: () => {},
  removeEventListener: () => {},
  getRootNode: () => ({ activeElement: null }),
  options: [],
  value: '',
  checked: false,
})

const { createApp: createNullApp } = createRenderer<FakeNode, FakeNode>({
  createElement: (tag) => fakeNode(tag),
  createText: (text) => Object.assign(fakeNode('#text'), { text }),
  createComment: (text) => Object.assign(fakeNode('#comment'), { text }),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
    node.children = []
  },
  insert: (child, parent, anchor) => {
    child.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    if (at === -1) {
      parent.children.push(child)
    } else {
      parent.children.splice(at, 0, child)
    }
  },
  remove: (child) => {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp: () => {},
})

type MountedComposer = {
  emissions: PlanComposerInput[]
  retargets: [string, string][]
  /** The component's exposed surface — `reset()`, as the parent calls it. */
  reset: () => void
}

async function mountComposer(overrides: {
  draft: DraftTarget | null
  initialPrompt?: string
}): Promise<MountedComposer> {
  const TaskComposer = (await import('./TaskComposer.vue')).default
  const emissions: PlanComposerInput[] = []
  const retargets: [string, string][] = []
  const app = createNullApp(TaskComposer, {
    creating: false,
    error: null,
    agents: AGENTS,
    currentAgent: 'claude -p',
    isolation: null,
    draft: overrides.draft,
    plan: null,
    planError: null,
    planPending: false,
    initialPrompt: overrides.initialPrompt ?? '',
    'onPlan-input': (input: PlanComposerInput) => emissions.push(input),
    onRetarget: (branch: string, prompt: string) => retargets.push([branch, prompt]),
  })
  app.config.globalProperties.$t = t
  const vm = app.mount(fakeNode('#root')) as unknown as { reset: () => void }
  await nextTick()
  return { emissions, retargets, reset: () => vm.reset() }
}

describe('a draft column asks for its plan without waiting for a keystroke', () => {
  test('mounting with a carried prompt emits plan-input straight away', async () => {
    const mounted = await mountComposer({
      draft: forkDraft('develop'),
      initialPrompt: 'carried over',
    })
    // This IS the correction case: `onDraftRetarget` swaps the draft, the
    // column remounts with the prompt, and no keystroke follows.
    expect(mounted.emissions).toEqual([
      { title: 'carried over', prompt: 'carried over', autoShip: false, agent: 'claude -p' },
    ])

    // The control, without which "one emission at mount" would be a fact about
    // this rig rather than about the component: a CHANGE emits too, and the
    // harness sees it.
    mounted.reset()
    await nextTick()
    expect(mounted.emissions).toHaveLength(2)
    expect(mounted.emissions[1]).toMatchObject({ prompt: '' })
  })

  test('a correction lands on a column that asks for the NEW branch’s plan', async () => {
    // Before and after the swap `onDraftRetarget` performs: two different
    // draft columns, the same prompt, and each one asks on its own account.
    const before = await mountComposer({ draft: forkDraft('develop'), initialPrompt: 'ship it' })
    const after = await mountComposer({ draft: forkDraft('release'), initialPrompt: 'ship it' })
    expect(before.emissions).toHaveLength(1)
    expect(after.emissions).toHaveLength(1)
    expect(after.emissions[0]?.prompt).toBe('ship it')
  })

  test('the standalone composer targets no branch, so it asks for nothing — ever', async () => {
    const mounted = await mountComposer({ draft: null, initialPrompt: 'typed already' })
    expect(mounted.emissions).toEqual([])
    mounted.reset()
    await nextTick()
    expect(mounted.emissions).toEqual([])
  })
})

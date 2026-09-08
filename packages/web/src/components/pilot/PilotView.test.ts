// SSR string-render tests, same harness as PilotThread.test.ts.
//
// PilotView's setup calls `useTasks(props.token)` directly (same shape as
// WorkspaceView.vue, see WorkspaceView.test.ts's own doctrine comment): the
// task store only ever gets populated by `start()`, which only ever runs
// from `onMounted` — a hook `renderToString` never fires. So a real SSR
// render of this component can only ever observe the store in its EMPTY,
// pre-mount state: there is no way to inject fixture TaskStates into it from
// outside (no prop bag, no exposed setter, no module-level singleton to
// reach into). What a genuine render DOES prove — the root class, the list
// column, the empty centre, the counters at zero — is checked below via
// `renderToString`. Everything that depends on a populated store (the open
// conversation, the needsYou badge past zero, the hydration guard, the reply
// wiring) is pinned on the SOURCE instead, same doctrine as
// WorkspaceView.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { catalogs, t } from '../../i18n'

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

async function render(token = 'tok-1'): Promise<string> {
  const PilotView = (await import('./PilotView.vue')).default
  const app = createSSRApp({ render: () => h(PilotView, { token }) })
  return renderToString(app)
}

const SOURCE = readFileSync(new URL('./PilotView.vue', import.meta.url), 'utf-8')

describe('PilotView: pre-mount SSR render (empty store)', () => {
  test('the root carries the mandatory ws-root class', async () => {
    const html = await render()
    expect(html).toContain('class="ws-root pv-root"')
  })

  test('the single column is a conversations list plus one centred stage', async () => {
    const html = await render()
    expect(html).toContain('cvl-root')
    expect(html).toContain('pv-stage')
    expect(html).not.toContain('pv-grid')
    expect(html).not.toContain('pv-lane')
    expect(html).not.toContain('pv-hidden-bar')
  })

  test('an empty store renders the dignified empty state, not a blank stage', async () => {
    const html = await render()
    expect(html).toContain('pv-empty')
    expect(html).toContain(t('pilot.grid.empty'))
    expect(html).not.toContain('pt-root')
  })

  test('the conversation count renders at zero; the needsYou and working badges stay hidden at zero', async () => {
    const html = await render()
    expect(html).toContain(t('pilot.header.conversations', { n: 0 }))
    expect(html).not.toContain(t('workspace.needsYouBadge', { n: 0 }))
    expect(html).not.toContain(t('pilot.header.working', { n: 0 }))
    expect(html).not.toContain('pv-count--attention')
  })

  test('the classic-shell toggle button is present', async () => {
    const html = await render()
    expect(html).toContain(t('pilot.toggle.classic'))
  })

  test('nothing selected: the body says so, for the narrow layout to read', async () => {
    const html = await render()
    expect(html).toContain('data-selected="false"')
  })

  test('no lens, no mobile list, no agent card survives the single-column shell', async () => {
    const html = await render()
    expect(html).not.toContain('pl-lens')
    expect(html).not.toContain('mbl-root')
    expect(html).not.toContain('ac-root')
  })
})

describe('PilotView: data model wiring (pinned on the source, see file header)', () => {
  test('owns its own useTasks(token), started on mount and stopped on unmount', () => {
    expect(SOURCE).toContain('useTasks(props.token)')
    expect(SOURCE).toContain('onMounted(() => tasks.start())')
    expect(SOURCE).toContain('onUnmounted(tasks.stop)')
  })

  test('the list is fed orderCards, never a raw store iteration', () => {
    expect(SOURCE).toContain('orderCards(tasks.states.value)')
    expect(SOURCE).toContain(':states="orderedStates"')
  })

  test('the list gets its project names and its selected row from this view', () => {
    expect(SOURCE).toContain(':project-names="projectNameById"')
    expect(SOURCE).toContain(':focused-keys="focusedKeys"')
    expect(SOURCE).toContain(
      'taskKey(selectedState.value.projectId, selectedState.value.record.id)',
    )
  })

  test('the one thread gets the five actions wired: send, pick, ship, stop, resume', () => {
    const threadBlock = SOURCE.slice(
      SOURCE.indexOf('<PilotThread'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<PilotThread')),
    )
    expect(threadBlock).toContain('@send="onSend"')
    expect(threadBlock).toContain('@pick="onPick"')
    expect(threadBlock).toContain(
      '@ship="doShip(selectedState.projectId, selectedState.record.id)"',
    )
    expect(threadBlock).toContain(
      '@stop="doStop(selectedState.projectId, selectedState.record.id)"',
    )
    expect(threadBlock).toContain(
      '@resume="doResume(selectedState.projectId, selectedState.record.id)"',
    )
  })

  test('ship/stop/resume each call the matching useTasks action, tracked as sending', () => {
    expect(SOURCE).toContain('tasks.ship(projectId, taskId)')
    expect(SOURCE).toContain('tasks.interrupt(projectId, taskId)')
    expect(SOURCE).toContain('tasks.resume(projectId, taskId)')
    expect(SOURCE).toContain('withSending(taskId,')
  })

  test('recap/evidence/verification/checks are hydrated once per task, guarded by a requested set', () => {
    expect(SOURCE).toContain('tasks.hydrateRecap(')
    expect(SOURCE).toContain('tasks.hydrateEvidence(')
    expect(SOURCE).toContain('tasks.hydrateVerification(')
    expect(SOURCE).toContain('tasks.hydrateChecks(')
    expect(SOURCE).toContain('state.recap === undefined')
    expect(SOURCE).toContain('state.evidence === undefined')
    expect(SOURCE).toContain('state.verification === undefined')
    expect(SOURCE).toContain('requestedHydration')
  })

  test('a reconnect (connections change) clears the requested set and asks again', () => {
    const watchBlock = SOURCE.slice(
      SOURCE.indexOf('watch(tasks.connections'),
      SOURCE.indexOf('})', SOURCE.indexOf('watch(tasks.connections')),
    )
    expect(watchBlock).toContain('requestedHydration.clear()')
    expect(watchBlock).toContain('hydrateIfNeeded(state)')
  })

  test('sending state is tracked per task, not read off useTasks (it has none)', () => {
    expect(SOURCE).toContain('sendingTaskIds')
    expect(SOURCE).toContain('tasks.reply(projectId, taskId, message)')
  })

  test('exactly one thread and one list: no lane, no lens, no second mobile list', () => {
    expect(SOURCE.match(/<PilotThread\b/g)).toHaveLength(1)
    expect(SOURCE.match(/<ConversationsList\b/g)).toHaveLength(1)
    expect(SOURCE).not.toContain('<Lens')
    expect(SOURCE).not.toContain('<AgentCard')
    expect(SOURCE).not.toContain('<MobileList')
    expect(SOURCE).not.toContain('MobileThread')
  })

  test('the centred stage is one column, capped and centred, never a grid template', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style'), SOURCE.lastIndexOf('</style>'))
    expect(styleBlock).toContain('max-width: 100ch;')
    expect(styleBlock).toContain('margin-inline: auto;')
    expect(styleBlock).toContain('width: 30ch;')
    expect(styleBlock).not.toContain('grid-template-columns')
  })

  test('selecting a conversation opens it, back clears it', () => {
    expect(SOURCE).toContain('@select="onSelect"')
    expect(SOURCE).toContain('selectedId.value = state.record.id')
    expect(SOURCE).toContain('@back="selectedId = null"')
  })

  test('the narrow layout swaps list and thread on the same selection flag', () => {
    expect(SOURCE).toContain(':data-selected="selectedState !== null"')
    expect(SOURCE).toContain('show-back')
    expect(SOURCE).toContain('@media (max-width: 760px)')
    expect(SOURCE).toContain(".pv-body[data-selected='true'] .pv-list {")
    expect(SOURCE).toContain(".pv-body[data-selected='false'] .pv-stage {")
  })

  test('creating a conversation hands over to the classic shell, where the draft composer lives', () => {
    expect(SOURCE).toContain('@create="onSwitchShell"')
  })

  test('switching to the classic shell persists the choice and emits switch-shell', () => {
    expect(SOURCE).toContain("shell.value = 'classic'")
    expect(SOURCE).toContain("emit('switch-shell')")
  })
})

// Review fix: opening a conversation used to show an empty thread for any
// task whose events had never streamed in live, since
// recap/evidence/checks were the only things PilotView ever hydrated. Full
// event history is fetched (a) eagerly for the attention tasks the reader is
// expected to answer next, mirroring WorkspaceView's own
// `hydratedForQuestion`, and (b) on demand the moment a conversation is
// selected, mirroring WorkspaceView's `openConversation`. Verified on the
// source: see the file-header limitation on rendering a populated store
// under SSR.
describe('PilotView: full event history is hydrated, not left to the live stream alone', () => {
  test('the attention statuses (waiting_for_you, review_ko) are hydrated eagerly, like WorkspaceView', () => {
    expect(SOURCE).toContain(
      "const EVENTS_EAGER_STATUSES: ReadonlySet<TaskStatus> = new Set(['waiting_for_you', 'review_ko'])",
    )
    const hydrateIfNeededBlock = SOURCE.slice(
      SOURCE.indexOf('function hydrateIfNeeded'),
      SOURCE.indexOf('\n}\n', SOURCE.indexOf('function hydrateIfNeeded')),
    )
    expect(hydrateIfNeededBlock).toContain('EVENTS_EAGER_STATUSES.has(state.record.status)')
    expect(hydrateIfNeededBlock).toContain('hydrateEventsIfNeeded(state)')
  })

  test('any task is hydrated on demand through tasks.hydrate, guarded by the same requested set', () => {
    const hydrateEventsBlock = SOURCE.slice(
      SOURCE.indexOf('function hydrateEventsIfNeeded'),
      SOURCE.indexOf('\n}\n', SOURCE.indexOf('function hydrateEventsIfNeeded')),
    )
    expect(hydrateEventsBlock).toContain('`${state.projectId}:${state.record.id}:events`')
    expect(hydrateEventsBlock).toContain('requestedHydration')
    expect(hydrateEventsBlock).toContain('tasks.hydrate(state.projectId, state.record.id)')
  })

  test('selecting a conversation triggers the on-demand hydration', () => {
    const selectBlock = SOURCE.slice(
      SOURCE.indexOf('function onSelect'),
      SOURCE.indexOf('\n}\n', SOURCE.indexOf('function onSelect')),
    )
    expect(selectBlock).toContain('selectedId.value = state.record.id')
    expect(selectBlock).toContain('hydrateEventsIfNeeded(state)')
  })

  test('a reconnect also re-asks for events on the open conversation', () => {
    const watchBlock = SOURCE.slice(
      SOURCE.indexOf('watch(tasks.connections'),
      SOURCE.indexOf('\n})', SOURCE.indexOf('watch(tasks.connections')),
    )
    expect(watchBlock).toContain('if (selectedState.value !== null)')
    expect(watchBlock.match(/hydrateEventsIfNeeded\(/g)).toHaveLength(1)
  })
})

// The header counter used to show "0 agents" over 3 open conversations
// (workspace.agentsCount only counts running/reviewing tasks): a real SSR
// render can only ever see the empty pre-mount store (see file header), so
// the "3 conversations" case is pinned on the source expression plus the new
// keys' own pluralization, the same way every other populated-store fact in
// this file is proven.
describe('PilotView: header counter reads the whole list, not just the working agents', () => {
  test('the conversation count binds orderedStates.length, not counts.agents', () => {
    const countsBlock = SOURCE.slice(
      SOURCE.indexOf('<div class="pv-counts">'),
      SOURCE.indexOf('<div class="pv-spacer"'),
    )
    expect(countsBlock).toContain("t('pilot.header.conversations', { n: orderedStates.length })")
    expect(countsBlock).toContain("t('pilot.header.working', { n: counts.agents })")
    expect(countsBlock).toContain('v-if="counts.agents > 0"')
  })

  test('at n=3 the conversations key pluralizes correctly in both catalogs', () => {
    expect(t('pilot.header.conversations', { n: 3 })).toBe('3 conversations')
    expect(catalogs.fr?.['pilot.header.conversations']).toContain(
      '{n} conversation | {n} conversations',
    )
  })

  test('at n=3 the working key pluralizes, and conjugates, correctly in both catalogs', () => {
    expect(t('pilot.header.working', { n: 3 })).toBe('3 agents working')
    expect(t('pilot.header.working', { n: 1 })).toBe('1 agent working')
    expect(catalogs.fr?.['pilot.header.working']).toBe(
      '{n} agent travaille | {n} agents travaillent',
    )
  })
})

describe('PilotView: no new i18n keys, no hardcoded color, no animation-fill-mode', () => {
  test('every t(...) call in the template uses an existing pilot.* or workspace.* key', () => {
    const keys = [...SOURCE.matchAll(/t\('([a-zA-Z0-9.]+)'/g)].map((m) => m[1] ?? '')
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key.startsWith('pilot.') || key.startsWith('workspace.')).toBe(true)
    }
  })

  test('the scoped style block uses only theme tokens, no hex literal, no animation-fill-mode', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style'), SOURCE.lastIndexOf('</style>'))
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(styleBlock).not.toMatch(/animation-fill-mode\s*:|animation\s*:[^;]*\b(forwards|both)\b/)
  })

  test('no em dash anywhere in the file', () => {
    expect(SOURCE).not.toContain('—')
  })
})

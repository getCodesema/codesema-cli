// SSR string-render tests, same harness as AgentCard.test.ts / Lens.test.ts.
//
// PilotView's setup calls `useTasks(props.token)` directly (same shape as
// WorkspaceView.vue, see WorkspaceView.test.ts's own doctrine comment): the
// task store only ever gets populated by `start()`, which only ever runs
// from `onMounted` — a hook `renderToString` never fires. So a real SSR
// render of this component can only ever observe the store in its EMPTY,
// pre-mount state: there is no way to inject fixture TaskStates into it from
// outside (no prop bag, no exposed setter, no module-level singleton to
// reach into). What a genuine render DOES prove — the root class, the
// default-prefs column count, the empty-grid message, the counters at
// zero — is checked below via `renderToString`. Everything that depends on
// a populated store (one AgentCard per task, the needsYou badge past zero,
// the hydration guard, the reply wiring) is pinned on the SOURCE instead,
// same doctrine as WorkspaceView.test.ts.
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

  test('no column selector renders (fixed lanes replaced it)', async () => {
    const html = await render()
    expect(html).not.toContain('pv-cols')
    expect(html).not.toContain(t('pilot.cols.aria'))
  })

  test('an empty store renders the dignified empty state, not a blank grid', async () => {
    const html = await render()
    expect(html).toContain('pv-empty')
    expect(html).toContain(t('pilot.grid.empty'))
    expect(html).not.toContain('ac-root')
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

  test('no lens or full-screen overlay renders with nothing selected', async () => {
    const html = await render()
    expect(html).not.toContain('pl-lens')
  })

  test('the mobile pane renders the (empty) list, since nothing is selected', async () => {
    const html = await render()
    expect(html).toContain('pv-mobile')
    expect(html).toContain('mbl-root')
    expect(html).not.toContain('mbt-root')
  })

  test('the hidden-lanes bar is absent when nothing is closed or beyond the top 4', async () => {
    const html = await render()
    expect(html).not.toContain('pv-hidden-bar')
  })

  test('no lane wrapper renders with an empty store', async () => {
    const html = await render()
    expect(html).not.toContain('pv-lane-bar')
  })
})

describe('PilotView: data model wiring (pinned on the source, see file header)', () => {
  test('owns its own useTasks(token), started on mount and stopped on unmount', () => {
    expect(SOURCE).toContain('useTasks(props.token)')
    expect(SOURCE).toContain('onMounted(() => tasks.start())')
    expect(SOURCE).toContain('onUnmounted(tasks.stop)')
  })

  test('cards are ordered with orderCards, never a raw store iteration', () => {
    expect(SOURCE).toContain('orderCards(tasks.states.value)')
    expect(SOURCE).toContain('v-for="state in visibleLaneStates"')
  })

  test('every card gets the seven events wired: open-full, open-lens, send, pick, ship, stop, resume', () => {
    const cardBlock = SOURCE.slice(
      SOURCE.indexOf('<AgentCard'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<AgentCard')),
    )
    expect(cardBlock).toContain('@open-full="onOpenFull(state)"')
    expect(cardBlock).toContain('@open-lens="onOpenLens(state.record.id, $event)"')
    expect(cardBlock).toContain('sendReply(state.projectId, state.record.id, text)')
    expect(cardBlock).toContain('sendReply(state.projectId, state.record.id, option)')
    expect(cardBlock).toContain('@ship="doShip(state.projectId, state.record.id)"')
    expect(cardBlock).toContain('@stop="doStop(state.projectId, state.record.id)"')
    expect(cardBlock).toContain('@resume="doResume(state.projectId, state.record.id)"')
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

  test('the lens opens/closes through PilotLogic, never a hand-rolled toggle', () => {
    expect(SOURCE).toContain('openLens(lensState.value, taskId, block)')
    expect(SOURCE).toContain('closeLens()')
  })

  test('each lens block renders the matching pilot component with the matching title key', () => {
    for (const [block, cmp, key] of [
      ['evidence', 'EvidenceBlock', 'pilot.evidence.title'],
      ['recap', 'RecapBlock', 'pilot.recap.title'],
      ['checks', 'ChecksBlock', 'pilot.checks.title'],
      ['criteria', 'CriteriaBlock', 'pilot.criteria.title'],
      ['question', 'QuestionBlock', 'pilot.question.waiting'],
    ] as const) {
      expect(SOURCE).toContain(`lensBlock === '${block}'`)
      expect(SOURCE).toContain(`<${cmp}`)
      expect(SOURCE).toContain(`${block}: '${key}'`)
    }
  })

  test('open-full, the expanded lane and the mobile pane all render the same PilotThread', () => {
    expect(SOURCE.match(/<PilotThread\b/g)).toHaveLength(3)
    expect(SOURCE).toContain('class="pv-expanded-thread"')
    expect(SOURCE).toContain('class="pv-lane-thread"')
    expect(SOURCE).toContain('v-if="expandedLaneId === state.record.id"')
    expect(SOURCE).toContain('show-back')
    expect(SOURCE).not.toContain('MobileThread')
    // Only one other <Lens overlay besides the block lens: open-full reuses
    // the same shell rather than a second modal implementation.
    expect(SOURCE.match(/<Lens\b/g)).toHaveLength(2)
  })

  test('widening a lane hydrates its events, same as open-full', () => {
    const toggleBlock = SOURCE.slice(
      SOURCE.indexOf('function onToggleLane'),
      SOURCE.indexOf('function onCloseLane'),
    )
    expect(toggleBlock).toContain('hydrateEventsIfNeeded(target)')
  })

  test('mobile: open sets the selection, back clears it, mobilePane picks the pane', () => {
    expect(SOURCE).toContain('mobilePane(selectedId.value)')
    expect(SOURCE).toContain('@open="onMobileOpen"')
    expect(SOURCE).toContain('selectedId.value = taskId')
    expect(SOURCE).toContain('@back="selectedId = null"')
  })

  test('the top bar and grid hide at 760px in favor of the mobile pane', () => {
    expect(SOURCE).toContain('@media (max-width: 760px)')
    expect(SOURCE).toContain('.pv-top,')
    expect(SOURCE).toContain('.pv-grid {')
    expect(SOURCE).toContain('.pv-mobile {')
  })

  test('the grid is fixed lanes (max 4, closable) built from PilotLogic, never a raw column count', () => {
    expect(SOURCE).toContain('visibleLanes(tasks.states.value, closed.value)')
    expect(SOURCE).toContain('hiddenStates(tasks.states.value, closed.value)')
    expect(SOURCE).toContain('laneTemplate(')
    expect(SOURCE).toContain("'grid-template-columns': laneGridTemplate")
    expect(SOURCE).not.toContain('COLS_OPTIONS')
    expect(SOURCE).not.toContain('data-cols')
  })

  test('a lane bar click, its expand button, and its close button all read PilotLogic', () => {
    expect(SOURCE).toContain('toggleExpanded(expandedLaneId.value, id)')
    expect(SOURCE).toContain('closed.value = [...closed.value, id]')
    expect(SOURCE).toContain('closed.value.filter((closedId) => closedId !== id)')
  })

  test('closed lane ids are pruned against the live task list on every states change', () => {
    expect(SOURCE).toContain('pruneClosed(')
    expect(SOURCE).toContain('states.map((state) => state.record.id)')
  })

  test('switching to the classic shell persists the choice and emits switch-shell', () => {
    expect(SOURCE).toContain("shell.value = 'classic'")
    expect(SOURCE).toContain("emit('switch-shell')")
  })
})

// Review fix: opening a card in full (or on mobile) used to show an empty
// thread for any task whose events had never streamed in live, since
// recap/evidence/checks were the only things PilotView ever hydrated. Full
// event history is fetched (a) eagerly for the attention cards that show
// their question inline, unopened, mirroring WorkspaceView's own
// `hydratedForQuestion`, and (b) on demand the moment a card is opened
// (open-full, mobile select), mirroring WorkspaceView's `openConversation`.
// Verified on the source: see the file-header limitation on rendering a
// populated store under SSR.
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

  test('any card is hydrated on demand through tasks.hydrate, guarded by the same requested set', () => {
    const hydrateEventsBlock = SOURCE.slice(
      SOURCE.indexOf('function hydrateEventsIfNeeded'),
      SOURCE.indexOf('\n}\n', SOURCE.indexOf('function hydrateEventsIfNeeded')),
    )
    expect(hydrateEventsBlock).toContain('`${state.projectId}:${state.record.id}:events`')
    expect(hydrateEventsBlock).toContain('requestedHydration')
    expect(hydrateEventsBlock).toContain('tasks.hydrate(state.projectId, state.record.id)')
  })

  test('open-full and the mobile open both trigger the on-demand hydration', () => {
    const openFullBlock = SOURCE.slice(
      SOURCE.indexOf('function onOpenFull'),
      SOURCE.indexOf('\n}\n', SOURCE.indexOf('function onOpenFull')),
    )
    expect(openFullBlock).toContain('expandedId.value = state.record.id')
    expect(openFullBlock).toContain('hydrateEventsIfNeeded(state)')

    const mobileOpenBlock = SOURCE.slice(
      SOURCE.indexOf('function onMobileOpen'),
      SOURCE.indexOf('\n}\n', SOURCE.indexOf('function onMobileOpen')),
    )
    expect(mobileOpenBlock).toContain('selectedId.value = taskId')
    expect(mobileOpenBlock).toContain('hydrateEventsIfNeeded(target)')
  })

  test('a reconnect also re-asks for events on whichever task is currently open', () => {
    const watchBlock = SOURCE.slice(
      SOURCE.indexOf('watch(tasks.connections'),
      SOURCE.indexOf('\n})', SOURCE.indexOf('watch(tasks.connections')),
    )
    expect(watchBlock).toContain('if (expandedState.value !== null)')
    expect(watchBlock).toContain('if (selectedState.value !== null)')
    expect(watchBlock.match(/hydrateEventsIfNeeded\(/g)).toHaveLength(2)
  })
})

// The header counter used to show "0 agents" over 3 visible cards
// (workspace.agentsCount only counts running/reviewing tasks): a real SSR
// render can only ever see the empty pre-mount store (see file header), so
// the "3 conversations" case is pinned on the source expression plus the new
// keys' own pluralization, the same way every other populated-store fact in
// this file is proven.
describe('PilotView: header counter reads the whole grid, not just the working agents', () => {
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

  test('the scoped style block uses only --cs- tokens, no hex literal, no animation-fill-mode', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style'), SOURCE.lastIndexOf('</style>'))
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(styleBlock).not.toMatch(/animation-fill-mode\s*:|animation\s*:[^;]*\b(forwards|both)\b/)
  })

  test('no em dash anywhere in the file', () => {
    expect(SOURCE).not.toContain('—')
  })
})

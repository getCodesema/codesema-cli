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
import { t } from '../../i18n'

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

  test('the column count defaults to 2 (no localStorage in this environment)', async () => {
    const html = await render()
    expect(html).toContain('data-cols="2"')
    expect(html).toContain('--cols:2')
  })

  test('an empty store renders the dignified empty state, not a blank grid', async () => {
    const html = await render()
    expect(html).toContain('pv-empty')
    expect(html).toContain(t('pilot.grid.empty'))
    expect(html).not.toContain('ac-root')
  })

  test('the agents counter renders at zero; the needsYou badge stays hidden at zero', async () => {
    const html = await render()
    expect(html).toContain(t('workspace.agentsCount', { n: 0 }))
    expect(html).not.toContain(t('workspace.needsYouBadge', { n: 0 }))
    expect(html).not.toContain('pv-count--attention')
  })

  test('the column selector renders four options, 2 marked current', async () => {
    const html = await render()
    for (const n of [1, 2, 3, 4]) {
      expect(html).toContain(`aria-pressed="${n === 2 ? 'true' : 'false'}"`)
    }
    expect(html).toContain(t('pilot.cols.aria'))
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
})

describe('PilotView: data model wiring (pinned on the source, see file header)', () => {
  test('owns its own useTasks(token), started on mount and stopped on unmount', () => {
    expect(SOURCE).toContain('useTasks(props.token)')
    expect(SOURCE).toContain('onMounted(() => tasks.start())')
    expect(SOURCE).toContain('onUnmounted(tasks.stop)')
  })

  test('cards are ordered with orderCards, never a raw store iteration', () => {
    expect(SOURCE).toContain('orderCards(tasks.states.value)')
    expect(SOURCE).toContain('v-for="state in orderedStates"')
  })

  test('every card gets the four events wired: open-full, open-lens, send, pick', () => {
    const cardBlock = SOURCE.slice(
      SOURCE.indexOf('<AgentCard'),
      SOURCE.indexOf('/>', SOURCE.indexOf('<AgentCard')),
    )
    expect(cardBlock).toContain('@open-full="expandedId = state.record.id"')
    expect(cardBlock).toContain('@open-lens="onOpenLens(state.record.id, $event)"')
    expect(cardBlock).toContain('sendReply(state.projectId, state.record.id, text)')
    expect(cardBlock).toContain('sendReply(state.projectId, state.record.id, option)')
  })

  test('recap/evidence are hydrated once per task, guarded by a requested set', () => {
    expect(SOURCE).toContain('tasks.hydrateRecap(')
    expect(SOURCE).toContain('tasks.hydrateEvidence(')
    expect(SOURCE).toContain('state.recap === undefined')
    expect(SOURCE).toContain('state.evidence === undefined')
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

  test('open-full is a stand-in (MobileThread, large) reusing Lens, not a duplicate overlay', () => {
    expect(SOURCE).toContain('<MobileThread')
    expect(SOURCE).toContain('class="pv-expanded-thread"')
    // Only one other <Lens overlay besides the block lens: this stand-in
    // reuses the same component rather than a second modal implementation.
    expect(SOURCE.match(/<Lens\b/g)).toHaveLength(2)
  })

  test('mobile: open sets the selection, back clears it, mobilePane picks the pane', () => {
    expect(SOURCE).toContain('mobilePane(selectedId.value)')
    expect(SOURCE).toContain('@open="selectedId = $event"')
    expect(SOURCE).toContain('@back="selectedId = null"')
  })

  test('the top bar and grid hide at 760px in favor of the mobile pane', () => {
    expect(SOURCE).toContain('@media (max-width: 760px)')
    expect(SOURCE).toContain('.pv-top,')
    expect(SOURCE).toContain('.pv-grid {')
    expect(SOURCE).toContain('.pv-mobile {')
  })

  test('the grid columns read the persisted preference through var(--cols)', () => {
    expect(SOURCE).toContain('grid-template-columns: repeat(var(--cols), minmax(0, 1fr))')
    expect(SOURCE).toContain(':data-cols="cols"')
    expect(SOURCE).toContain("'--cols': cols")
  })

  test('switching to the classic shell persists the choice and emits switch-shell', () => {
    expect(SOURCE).toContain("shell.value = 'classic'")
    expect(SOURCE).toContain("emit('switch-shell')")
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

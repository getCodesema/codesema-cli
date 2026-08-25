// The #N pill's tooltip, rendered — not computed (T1.3 round 5, MAJEUR B).
//
// `queueRankHintKey` had a unit test for all three of its branches, and the
// French key `workspace.queuePositionHintMachine` existed in both catalogs.
// What nothing covered was the ONE line that binds them, WorkQueue.vue's
// `t(queueRankHintKey(state.record), { n: rank })`: forcing it back to
// `t('workspace.queuePositionHint', { n: rank })` left the whole suite green
// while a task alone in an idle project, held back by the MACHINE-wide cap,
// was told "N conversations ahead in this project" — there are none — and the
// machine phrasing became structurally dead. That is adversarial review round
// 3, MAJEUR 3, returning without a single red.
//
// The harness is the one TaskConversation.test.ts introduced, reused verbatim
// and with no new dependency: `vue/compiler-sfc` compiles the SFC with its
// template inlined (Bun's built-in `.vue` loader keeps only `<script setup>`,
// which drops exactly the half under test), `vue/server-renderer` renders to a
// STRING — no DOM, no happy-dom, no global `document` leaking into the CLI
// suites that share this process. The import of the SFC is DYNAMIC on purpose:
// a static one is hoisted above `Bun.plugin()` and would be loaded by the
// built-in loader before the override is registered.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { TaskState } from '../composables/useTasks'
import { t } from '../i18n'
import type { Project, TaskRecord, WorkspaceInfo } from '../types'

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

/**
 * The machine-cap `reason.detail` READ OUT OF THE CLI, not copied here.
 *
 * `MACHINE_LOAD_DETAIL` (packages/cli/src/task-runner.ts) is hand-mirrored as
 * `MACHINE_LOAD_WAIT_DETAIL` in useTaskBoard.ts — the only discriminant
 * between the two `resource_busy` motifs on a record that carries no events.
 * Until now the two sides were coupled by a COMMENT: mutating the CLI literal
 * reddened two task-runner tests, but both were copies of the same sentence,
 * so fixing them was enough to ship a stale web mirror and silently send the
 * #N pill back to the lying project wording (round 5, mineur F).
 *
 * Extracting the literal from the CLI source makes the coupling real, in the
 * only way a hand-mirror allows: the web bundle must not import CLI code, and
 * the constant is private on both sides. This is a test-time file read, not a
 * dependency — and it is not tautological, since the value crosses the mirror
 * and the assertion is on the RENDERED tooltip, not on either constant.
 */
const MACHINE_DETAIL = (() => {
  const cliSource = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'task-runner.ts'),
    'utf8',
  )
  const match = cliSource.match(/const MACHINE_LOAD_DETAIL\s*=\s*'([^']*)'/)
  if (!match?.[1]) {
    throw new Error('MACHINE_LOAD_DETAIL not found in packages/cli/src/task-runner.ts')
  }
  return match[1]
})()

function state(
  reason: NonNullable<TaskRecord['reason']>,
  queuePosition: number,
  projectId = 'p1',
  isolation: TaskRecord['isolation'] = 'policy',
): TaskState {
  return {
    projectId,
    record: {
      isolation,
      version: 1,
      id: 'a1b2c3d4e5f6',
      title: 'a queued task',
      status: 'queued',
      base: 'main',
      branch: 'codesema/task-x',
      worktree: '/tmp/w',
      agent_session_id: null,
      turns: [],
      review_ref: null,
      work_ms: 0,
      wait_ms: 0,
      auto_ship: false,
      created_at: '2026-08-13T10:00:00.000Z',
      updated_at: '2026-08-13T10:00:00.000Z',
      queue_position: queuePosition,
      reason,
    },
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
  }
}

/**
 * Server-renders the queue to HTML. No DOM, no fetch, no timer.
 *
 * The component opens a 30 s minute-tick `setInterval` in `setup()` and clears
 * it in `onUnmounted`, which SSR never calls — so the tick is neutralised for
 * the duration of the render rather than left to hold the test process open.
 * Nothing under test depends on it firing: the pause durations it refreshes
 * are seeded from `Date.now()` at setup.
 */
async function renderQueue(
  states: TaskState[],
  overrides: {
    projects?: Project[]
    filter?: string | null
    workspace?: WorkspaceInfo | null
  } = {},
): Promise<string> {
  const WorkQueue = (await import('./WorkQueue.vue')).default
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval
  try {
    const app = createSSRApp(WorkQueue, {
      states,
      projectNames: new Map([
        ['p1', 'repo'],
        ['p2', 'sibling'],
      ]),
      focusedKeys: [],
      projects: overrides.projects ?? [],
      filter: overrides.filter === undefined ? 'p1' : overrides.filter,
      creating: false,
      createError: null,
      workspace: overrides.workspace ?? null,
    })
    app.config.globalProperties.$t = t
    return await renderToString(app)
  } finally {
    globalThis.setInterval = realSetInterval
  }
}

/**
 * The tooltip lands in a `title="…"` attribute, so the comparison has to be
 * made against what Vue's SSR actually writes — same escapes as
 * `@vue/shared`'s escapeHtml (an apostrophe becomes `&#39;`).
 */
function inAttribute(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

describe('WorkQueue renders the #N pill tooltip (round 3 MAJEUR 3, the wiring half)', () => {
  const projectHint = (n: number) => inAttribute(t('workspace.queuePositionHint', { n }))
  const machineHint = (n: number) => inAttribute(t('workspace.queuePositionHintMachine', { n }))
  const idleHint = (n: number) => inAttribute(t('workspace.queuePositionHintIdle', { n }))

  // The mutation this kills: `t(queueRankHintKey(state.record), { n: rank })`
  // → `t('workspace.queuePositionHint', { n: rank })`. `queueRankHintKey` and
  // its three unit tests all stay green — the function is still right, it is
  // simply no longer read, and the human reads a promise about conversations
  // that do not exist.
  test('a task held by the MACHINE cap is not told conversations are ahead of it', async () => {
    const html = await renderQueue([state({ code: 'resource_busy', detail: MACHINE_DETAIL }, 2)])
    expect(html).toContain(machineHint(2))
    // The cross-assertion is what kills the mutant: the wrong claim is absent.
    expect(html).not.toContain(projectHint(2))
  })

  // The other side of the binding: without it, forcing the call to the
  // MACHINE key would be invisible to a suite that only rendered that case.
  test('a task waiting behind another conversation of its project still says so', async () => {
    const html = await renderQueue([state({ code: 'resource_busy', detail: 'another task' }, 2)])
    expect(html).toContain(projectHint(2))
    expect(html).not.toContain(machineHint(2))
  })

  // And the third branch, so that collapsing the key choice to either
  // `resource_busy` phrasing is red too: a line that is STOPPED, not busy.
  test('a task whose line is stopped rather than busy gets the honest hint', async () => {
    const html = await renderQueue([state({ code: 'agent_error', detail: 'no such branch' }, 2)])
    expect(html).toContain(idleHint(2))
    expect(html).not.toContain(projectHint(2))
    expect(html).not.toContain(machineHint(2))
  })
})

// --- the per-project isolation WIRING, rendered (T1.4 round 6, MAJEUR B3) --
//
// `isolationForProject` had two unit tests. Its three CALL SITES in
// WorkQueue.vue had none, and an adversarial campaign confirmed all three
// survive with the whole suite green:
//
//   1. `shouldOfferIsolationUpgrade(composeIsolation.value, …)`
//      -> `shouldOfferIsolationUpgrade(props.workspace, …)`
//   2. `showIsolationDot(state.record, isolationOf(state.projectId))`
//      -> `showIsolationDot(state.record, props.workspace)`
//   3. the banner's `reason:` read off `workspace` instead of `composeIsolation`
//
// All three are the same failure: the human is shown the LAUNCH repo's cage
// while looking at (or about to create in) another repo. This suite renders
// the component and asserts on the STRING, with the cross-assertion that the
// wrong claim is absent — the only thing that kills a fallback mutant.

describe('WorkQueue renders isolation PER PROJECT, not per launch repo', () => {
  const CAGED: WorkspaceInfo = {
    isolation_available: true,
    isolation_default: 'container',
    isolation_reason: 'podman is available',
    isolation_configured: 'auto',
  }
  const NOT_CAGED: WorkspaceInfo = {
    isolation_available: false,
    isolation_default: 'policy',
    isolation_reason:
      'the cage only provides claude-code, and the configured agent is codex exec -',
    isolation_configured: 'auto',
  }
  const project = (id: string, isolation: WorkspaceInfo): Project => ({
    id,
    path: `/repos/${id}`,
    name: id,
    kind: 'repo',
    added_at: '2026-08-13T10:00:00.000Z',
    isolation,
  })
  const busy = { code: 'resource_busy' as const, detail: 'another task' }
  const banner = (reason: string) => inAttribute(t('workspace.isolationUpgradeBody', { reason }))

  test('the degraded SIBLING you are composing on gets the banner, with ITS reason', async () => {
    const html = await renderQueue([state(busy, 1, 'p2')], {
      projects: [project('p1', CAGED), project('p2', NOT_CAGED)],
      filter: 'p2',
      // The launch repo IS caged: reading the banner off this blob hides the
      // degradation of the repo the next task actually lands in.
      workspace: CAGED,
    })
    expect(html).toContain(t('workspace.isolationUpgradeTitle'))
    expect(html).toContain(banner(NOT_CAGED.isolation_reason))
    expect(html).not.toContain(banner(CAGED.isolation_reason))
    // And the dot: p2 cannot cage anything, so a 'policy' card there carries
    // no information — while the launch-repo blob would have shown one.
    expect(html).not.toContain('wq-iso--policy')
  })

  test('a caged compose target shows no banner, and its policy cards keep their dot', async () => {
    const html = await renderQueue([state(busy, 1, 'p1')], {
      projects: [project('p1', CAGED), project('p2', NOT_CAGED)],
      filter: 'p1',
      // Mirror image: the process-wide blob is the degraded one this time.
      workspace: NOT_CAGED,
    })
    expect(html).not.toContain(t('workspace.isolationUpgradeTitle'))
    expect(html).toContain('wq-iso--policy')
  })
})

describe('WorkQueue composer target select and the scratch project', () => {
  const makeProject = (id: string, kind: Project['kind']): Project => ({
    id,
    path: `/repos/${id}`,
    name: id,
    kind,
    added_at: '2026-08-13T10:00:00.000Z',
  })
  const scratch = makeProject('scratch1', 'scratch')
  const repoA = makeProject('aaaa1111', 'repo')
  const repoB = makeProject('bbbb2222', 'repo')

  /** The rendered `<select …>` opening tag, or throws if the composer target
   * select is absent from the queue. */
  function selectTag(html: string): string {
    const match = html.match(/<select[^>]*>/)
    if (!match) {
      throw new Error('no target <select> in the rendered queue')
    }
    return match[0]
  }

  test('a single scratch project (no repo registered) hides the target select', async () => {
    const html = await renderQueue([], { projects: [scratch], filter: null })
    expect(html).not.toContain('wq-target-select')
  })

  test('a repo alongside scratch shows the select, scratch first and never under its raw name', async () => {
    const html = await renderQueue([], { projects: [scratch, repoA], filter: null })
    // Sliced from the first <option>, not the <select> tag itself: the tag
    // carries its own `value="aaaa1111"` (the resolved default target),
    // which would otherwise be mistaken for the option list's own order.
    const optionsBlock = html.slice(html.indexOf('<option'), html.indexOf('</select>'))
    expect(optionsBlock).toContain(t('workspace.noRepoOption'))
    expect(optionsBlock.indexOf(t('workspace.noRepoOption'))).toBeLessThan(
      optionsBlock.indexOf('aaaa1111'),
    )
    // The raw registry name ('scratch') never reaches the option text: it
    // would read as an ordinary, oddly-named repo instead of "no repo".
    expect(optionsBlock).not.toContain('>scratch<')
  })

  test('with a repo registered, an untouched select still defaults to the repo, not to scratch', async () => {
    const html = await renderQueue([], { projects: [scratch, repoA, repoB], filter: null })
    expect(selectTag(html)).toContain('value="aaaa1111"')
  })
})

describe('WorkQueue renders the checks_failed flag (T3.1)', () => {
  function attention(reason: NonNullable<TaskRecord['reason']>): TaskState {
    const s = state(reason, 0)
    s.record.status = 'review_ko'
    delete s.record.queue_position
    s.record.title = 'blocked by checks'
    return s
  }

  test('a review_ko from failed checks is not labelled as a blocked review', async () => {
    const html = await renderQueue([
      attention({ code: 'checks_failed', detail: 'repository checks failed (bun test)' }),
    ])
    expect(html).toContain(t('workspace.statusChecksFailed'))
    expect(html).not.toContain(t('workspace.statusReviewKo'))
  })

  test('a review_ko from the review itself keeps the review-blocked flag', async () => {
    const html = await renderQueue([
      attention({ code: 'review_blocked', detail: 'review failed: agent timed out' }),
    ])
    expect(html).toContain(t('workspace.statusReviewKo'))
    expect(html).not.toContain(t('workspace.statusChecksFailed'))
  })

  // T3.6. The merge gate hands a task back on `waiting_for_you`, whose own
  // label is "Needs you" — true of every question ever asked and useless
  // here. These two prove the card reaches the CARD, not just the map: the
  // two codes DP1/DP2 minted are shown, and their nearest neighbours (whose
  // sentences say the opposite) are not.
  function merged(reason: NonNullable<TaskRecord['reason']>): TaskState {
    const s = state(reason, 0)
    s.record.status = 'waiting_for_you'
    delete s.record.queue_position
    s.record.title = 'merge held'
    return s
  }

  test('a merge refused for unavailable checks is not labelled "checks failed"', async () => {
    const html = await renderQueue([
      merged({ code: 'checks_unavailable', detail: 'this repository configures no checks' }),
    ])
    // The card's FLAG, not the section header (which legitimately reads
    // "Needs you" for every conversation in this zone).
    expect(html).toContain(`<span class="wq-flag">${t('workspace.statusChecksUnavailable')}</span>`)
    expect(html).not.toContain(t('workspace.statusChecksFailed'))
  })

  test('a merge refused for missing criteria is not labelled "criteria not met"', async () => {
    const html = await renderQueue([
      merged({ code: 'criteria_missing', detail: 'no acceptance criterion was ever written' }),
    ])
    expect(html).toContain(`<span class="wq-flag">${t('workspace.statusCriteriaMissing')}</span>`)
    expect(html).not.toContain(t('workspace.statusCriteriaUnmet'))
  })

  // T3.6 adversarial review, MAJEUR 1. Six codes reach this card and the
  // ticket wired two: the four below all rendered the plain `waiting_for_you`
  // flag — "Needs you", true of every question ever asked — while the card
  // showed nothing at all about the merge that was held. `branch_diverged` is
  // the ticket's own "most frequent refusal on an active repository".
  //
  // On the CARD, not on the map: `statusLabelKey` had unit coverage for the
  // codes it knew, and what nothing pinned was that WorkQueue.vue reads it for
  // these records at all.
  const MERGE_EXITS = [
    { code: 'merge_conflict', flag: 'workspace.statusMergeConflict' },
    { code: 'forge_unreachable', flag: 'workspace.statusForgeUnreachable' },
    { code: 'branch_diverged', flag: 'workspace.statusBranchDiverged' },
    { code: 'checks_failed', flag: 'workspace.statusMergeHeld' },
  ] as const

  for (const exit of MERGE_EXITS) {
    test(`a merge held by ${exit.code} says so on the card, not "Needs you"`, async () => {
      const html = await renderQueue([merged({ code: exit.code, detail: 'the way out' })])
      expect(html).toContain(`<span class="wq-flag">${t(exit.flag)}</span>`)
      expect(html).not.toContain(`<span class="wq-flag">${t('workspace.statusWaiting')}</span>`)
    })
  }

  // The OTHER half of MAJEUR 1: the flag names the blocker, and only
  // `reason.detail` names the way out of it (DP1). Measured absent — no
  // component rendered that field, on any status — so the sentence the server
  // composes for exactly this purpose reached no screen at all.
  //
  // The mutation this kills: dropping the `wq-reason` span from WorkQueue.vue.
  // Every label test above stays green without it.
  test('the refusal spells out the way OUT, not just the blocker', async () => {
    const detail =
      "this branch is behind its target 'origin/main': merge or rebase the target into it"
    const html = await renderQueue([merged({ code: 'branch_diverged', detail })])
    // Vue's SSR escapes text nodes with the same escapes as an attribute
    // value (@vue/shared's escapeHtml), apostrophes included.
    expect(html).toContain(inAttribute(detail))
  })

  // The precedence rule, and why it is not "question first": `lastQuestion`
  // scans the WHOLE journal, so a conversation that asked something three
  // turns ago and is now parked by the merge gate would show that answered
  // question as if it were what the card waits on.
  const QUESTION = 'should I use bun or node?'
  const asked = [
    { seq: 1, at: '2026-08-13T09:00:00.000Z', type: 'question' as const, data: { text: QUESTION } },
  ]

  test('a stale question never stands in for the blocker that actually parked the task', async () => {
    const parked = merged({ code: 'merge_conflict', detail: 'resolve the overlap on the branch' })
    parked.events = asked
    const html = await renderQueue([parked])
    expect(html).toContain('resolve the overlap on the branch')
    expect(html).not.toContain(QUESTION)
  })

  // ...and an ordinary wait is untouched: a real question still shows.
  test('a conversation parked on a question still shows the question', async () => {
    const asking = merged({ code: 'merge_conflict', detail: 'x' })
    delete asking.record.reason
    asking.events = asked
    const html = await renderQueue([asking])
    expect(html).toContain(QUESTION)
  })
})

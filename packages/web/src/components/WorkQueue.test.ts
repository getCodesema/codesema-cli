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

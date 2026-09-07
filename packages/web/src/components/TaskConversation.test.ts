// The FIRST rendering test of packages/web (T1.3 round 4, MAJEUR 4).
//
// Until this file, every web test exercised a pure composable, and nothing in
// the repo ever rendered a `.vue` file — so the LAST hop, the one binding a
// tested function to the pixels a human reads, was invisible to the suite.
// Three mutations survived because of that hole: `{{ t(phraseKey) }}` →
// `{{ t(visual.phraseKey) }}` (AC-12's header phrase dies, silently),
// `v-if="checksHeadVerified(checks)"` → `v-if="checks.head_sha"` (the round-2
// MAJEUR comes straight back), and the re-run button's `:disabled` chain.
//
// No new dependency was needed, which is why the hole is closed here rather
// than deferred: `vue` already ships BOTH halves as subpath exports —
// `vue/compiler-sfc` (the SFC compiler vite uses) and `vue/server-renderer`.
// Rendering to a STRING also means no DOM at all: no happy-dom, no jsdom, no
// global `document` leaking into the CLI suites that share this process.
//
// Bun does resolve `.vue` imports natively, but its built-in loader only
// keeps the `<script setup>` half — the component comes back without a render
// function ("missing template or render function"), which is precisely the
// half this file exists to test. Hence the plugin below, and hence the
// DYNAMIC import inside `renderConversation`: a static `import … from
// './TaskConversation.vue'` is hoisted above `Bun.plugin()` and would be
// loaded by the built-in loader before the override is registered.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../i18n'
import type { TaskChecks, TaskEvent, TaskRecord, TaskTurn } from '../types'

Bun.plugin({
  name: 'vue-sfc-with-template',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const { descriptor } = parse(source, { filename: args.path })
      // `inlineTemplate` compiles the template INTO the setup function, so one
      // module carries both halves — the same shape @vitejs/plugin-vue
      // produces for the production bundle. The id only has to be stable per
      // file (it scopes styles, which SSR ignores here).
      const compiled = compileScript(descriptor, { id: args.path, inlineTemplate: true })
      return { contents: compiled.content, loader: 'ts' }
    })
  },
})

function record(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'task',
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
    ...partial,
  }
}

function checksJson(over: Partial<TaskChecks> = {}): TaskChecks {
  return {
    head_sha: 'abc1234def5678',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:01:00.000Z',
    status: 'passed',
    checks: [{ command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 5, tail: 'ok\n' }],
    error: null,
    ...over,
  }
}

const commitEvent: TaskEvent = {
  seq: 1,
  at: '2026-08-14T09:00:00.000Z',
  type: 'commit',
  data: { sha: 'abc', files_changed: 1, turn: 1 },
}

type RenderOptions = {
  record?: Partial<TaskRecord>
  events?: TaskEvent[]
  checks?: TaskChecks | null
  liveLoadCap?: { occupied: number; max: number; queued: number; waitingForSlot: boolean } | null
}

/** Server-renders one conversation to HTML. No DOM, no fetch, no timers. */
async function renderConversation(options: RenderOptions = {}): Promise<string> {
  const TaskConversation = (await import('./TaskConversation.vue')).default
  const ok = async () => ({ ok: true as const })
  const app = createSSRApp(TaskConversation, {
    state: {
      projectId: 'p1',
      record: record(options.record),
      events: options.events ?? [],
      liveText: '',
      liveMessages: [],
      liveTokens: 0,
      liveLoadCap: options.liveLoadCap ?? null,
      checks: options.checks ?? null,
    },
    projectName: 'repo',
    reply: ok,
    interrupt: ok,
    resume: ok,
    ship: ok,
    abandon: ok,
    runChecks: ok,
    loadChecks: async () => {},
    checksSetup: undefined,
    loadChecksSetup: async () => {},
    runChecksSetup: ok,
    applyChecksProposal: ok,
    dismissChecksProposal: () => {},
  })
  // main.ts registers this global; PreviewPanel.vue (a child of the Diff tab)
  // renders through `$t` and would throw without it.
  app.config.globalProperties.$t = t
  return renderToString(app)
}

/** The `<button>` element carrying the given class, from the rendered HTML. */
function buttonWith(html: string, className: string): string {
  const match = html.match(new RegExp(`<button[^>]*class="[^"]*${className}[^"]*"[^>]*>`))
  if (!match) {
    throw new Error(`no <button> with class ${className} in the rendered conversation`)
  }
  return match[0]
}

describe('TaskConversation renders the header phrase (AC-12)', () => {
  // The mutation this kills: `{{ t(phraseKey) }}` → `{{ t(visual.phraseKey) }}`
  // in the template. `queuePhraseKey` and its own unit test would both stay
  // green — the composable is still correct, it is simply no longer read, and
  // AC-12 ("the conversation says it is the MACHINE it waits for") dies
  // without a single failure.
  test('a queued task waiting on the machine cap gets the machine-wide phrase', async () => {
    const html = await renderConversation({
      record: { status: 'queued' },
      liveLoadCap: { occupied: 4, max: 4, queued: 0, waitingForSlot: true },
    })
    expect(html).toContain(t('workspace.phaseQueuedMachine'))
    expect(html).not.toContain(t('workspace.phaseQueued'))
  })

  // The other side of the same binding: without it, the mutation above would
  // be invisible to a suite that only ever rendered the machine-wait case.
  test('a queued task NOT waiting on the machine cap keeps the generic phrase', async () => {
    const html = await renderConversation({ record: { status: 'queued' } })
    expect(html).toContain(t('workspace.phaseQueued'))
    expect(html).not.toContain(t('workspace.phaseQueuedMachine'))
  })

  // T3.1: `review_ko` used to always say "findings to fix". A green review
  // blocked by red checks must not reuse that sentence — the human would
  // open the review looking for findings that are not there.
  test('a review_ko from failed checks says so, and does not mention findings', async () => {
    const html = await renderConversation({
      record: {
        status: 'review_ko',
        reason: { code: 'checks_failed', detail: 'repository checks failed (bun test)' },
      },
    })
    expect(html).toContain(t('workspace.phaseChecksFailed'))
    expect(html).not.toContain(t('workspace.phaseReviewKo'))
  })

  test('a review_ko from the review itself still mentions findings', async () => {
    const html = await renderConversation({
      record: {
        status: 'review_ko',
        reason: { code: 'review_blocked', detail: 'review failed' },
      },
    })
    expect(html).toContain(t('workspace.phaseReviewKo'))
    expect(html).not.toContain(t('workspace.phaseChecksFailed'))
  })

  // T3.6 adversarial review, MAJEUR 1. `runMergeStep` parks a task on
  // `waiting_for_you` with one of six codes; the ticket phrased two, so a
  // merge held by a conflict, an unreachable forge or a diverged branch said
  // "paused — waiting for your answer" while nobody had asked anything.
  test('a merge the gate refused names its blocker in the header', async () => {
    for (const code of ['merge_conflict', 'forge_unreachable', 'branch_diverged'] as const) {
      const html = await renderConversation({
        record: { status: 'waiting_for_you', reason: { code, detail: 'the way out' } },
      })
      expect(html).not.toContain(t('workspace.phaseWaiting'))
    }
  })

  // The half no component did at all: `reason.detail` is where the server
  // writes what to DO about the refusal (DP1), and nothing rendered it. The
  // mutation this kills: dropping the `cv-reason` paragraph from the template.
  test('the refusal sentence itself reaches the screen, not just its label', async () => {
    const detail =
      'this branch could not be compared with its target locally, so it could not be proven up to date'
    const html = await renderConversation({
      record: { status: 'waiting_for_you', reason: { code: 'branch_diverged', detail } },
    })
    expect(html).toContain(detail)
  })

  // ...and the gate on it: an English server sentence with no translated
  // phrase beside it is never poured into the header (the doctrine
  // `SUMMARY_KEYS` applies to journal lines, applied here to reasons).
  test('a reason this build has no phrase for shows no raw server English', async () => {
    const detail = 'the machine-wide load cap has no free slot for a turn'
    const html = await renderConversation({
      record: { status: 'queued', reason: { code: 'resource_busy', detail } },
    })
    expect(html).not.toContain(detail)
  })
})

describe('TaskConversation renders the checks bar', () => {
  const verified = (sha: string) => t('workspace.checksHeadVerified', { sha })

  // The mutation this kills: `v-if="checksHeadVerified(checks)"` →
  // `v-if="checks.head_sha"`, which is the round-2 MAJEUR verbatim — a SHA
  // announced as "verified" by a run that has verified nothing yet.
  test('a running check does NOT claim its head is verified', async () => {
    const html = await renderConversation({
      events: [commitEvent],
      checks: checksJson({ status: 'running', finished_at: null, checks: [] }),
    })
    expect(html).not.toContain(verified('abc1234'))
    // The status badge is still there: what is gated is the claim, not the bar.
    expect(html).toContain(t('workspace.checksStatusRunning'))
  })

  test('a finished check does claim it, on the short sha', async () => {
    const html = await renderConversation({ events: [commitEvent], checks: checksJson() })
    expect(html).toContain(verified('abc1234'))
  })
})

// Round 4, MAJEUR 1, the UI half: this is the chain that made a stale
// 'running' in checks.json a permanent dead end rather than a cosmetic
// residue — `checksRunning` ← `checks.status`, `canRunChecks` ← that, and the
// button's `:disabled` ← that. The server-side fix (undoing the 'running' of
// a run that never started) is only worth anything because of this.
describe('TaskConversation gates the re-run button on the checks status', () => {
  test('a task with a commit and no checks result can run them', async () => {
    const html = await renderConversation({ events: [commitEvent], checks: null })
    expect(buttonWith(html, 'cv-checks-rerun')).not.toContain('disabled')
    expect(html).toContain(t('workspace.checksRunNow'))
  })

  test('a checks.json stuck on running greys the button out', async () => {
    const html = await renderConversation({
      events: [commitEvent],
      checks: checksJson({ status: 'running', finished_at: null, checks: [] }),
    })
    expect(buttonWith(html, 'cv-checks-rerun')).toContain('disabled')
  })

  test('a finished run can be re-run', async () => {
    const html = await renderConversation({ events: [commitEvent], checks: checksJson() })
    expect(buttonWith(html, 'cv-checks-rerun')).not.toContain('disabled')
    expect(html).toContain(t('workspace.checksRerun'))
  })
})

// The user's own turn is rendered by TaskEventUser, not inline as raw text.
// It used to be a `<p>` with the prompt interpolated, so a user who wrote a
// list, a code block or a link saw it verbatim while the assistant's own
// markdown right below rendered properly. Same renderer for both sides now.
/** A started turn: the prompt only reaches the thread through this event
 *  (see TaskConversation.vue's `thread`), so a turn alone renders nothing. */
const turnStarted: TaskEvent = {
  seq: 1,
  at: '2026-08-24T10:00:00.000Z',
  type: 'turn_started',
  data: { turn: 1 },
}

/** One finished user turn, with only the fields this suite cares about. */
function turn(prompt: string): TaskTurn {
  return {
    prompt,
    response: null,
    question: null,
    started_at: '2026-08-24T10:00:00Z',
    ended_at: '2026-08-24T10:00:05Z',
  }
}

describe('the user turn renders markdown, like the assistant beside it', () => {
  test('a list written by the user becomes a real list, not literal dashes', async () => {
    const html = await renderConversation({
      record: { turns: [turn('do this:\n\n- first\n- second')] },
      events: [turnStarted],
    })
    expect(html).toContain('<li>')
    expect(html).toContain('first')
    // The raw markdown must NOT survive as text.
    expect(html).not.toContain('- first\n- second')
  })

  test('inline code and emphasis render as elements', async () => {
    const html = await renderConversation({
      record: { turns: [turn('run `bun test` and **stop**')] },
      events: [turnStarted],
    })
    expect(html).toContain('<code>')
    expect(html).toContain('<strong>')
  })

  test('the old inline bubble is gone: no decorative colour on a turn that is not a state', async () => {
    const html = await renderConversation({
      record: { turns: [turn('plain text')] },
      events: [turnStarted],
    })
    expect(html).not.toContain('cv-user')
    expect(html).toContain('plain text')
  })
})

// The quick-reply buttons were extracted into their own component
// (composer/QuickReplies.vue); this proves the wiring still holds end to
// end — the parent still derives `quickReplies` from the active question and
// still passes it down, rather than checking the rendering details already
// covered by QuickReplies.test.ts.
describe('TaskConversation wires the extracted QuickReplies component', () => {
  const disjunctiveQuestion: TaskEvent = {
    seq: 2,
    at: '2026-08-30T09:00:00.000Z',
    type: 'question',
    data: { question: 'Do you want to use v2 or the optional field?' },
  }

  test('an active question with enumerated options renders the quick-reply buttons', async () => {
    const html = await renderConversation({
      record: { status: 'waiting_for_you' },
      events: [disjunctiveQuestion],
    })
    expect(html).toContain('→ v2')
    expect(html).toContain('→ the optional field')
    expect(html).toContain(t('workspace.quickReplyOther'))
  })

  test('the same question renders no quick replies once the task is no longer waiting', async () => {
    const html = await renderConversation({
      record: { status: 'running' },
      events: [disjunctiveQuestion, { ...turnStarted, seq: 3 }],
    })
    expect(html).not.toContain('→ v2')
    expect(html).not.toContain(t('workspace.quickReplyOther'))
  })
})

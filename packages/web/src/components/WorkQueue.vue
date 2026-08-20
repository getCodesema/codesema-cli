<script setup lang="ts">
// Work queue (center-left column, ~430px, scrollable): the composer on top
// ("New task…", auto-ship kept, plus the target-project select — hidden when
// a specific project is already selected), then the conversations grouped by
// the queue grammar (groupQueue, pure): "⚠ NEEDS YOU" amber cards with the
// last question excerpt, "paused for X" and — for a conversation stopped
// mid-turn — a [Resume] that restarts it, "IN PROGRESS" with a pulsing dot
// and a thin indeterminate amber bar, "READY TO SHIP" green-ringed cards with
// [Ship] + [Diff], and the folded "DONE" pile. Clicking a card opens it in
// the focus zone. Each live card carries a discreet isolation dot (green =
// caged in a container, hollow = policy) whenever that dot tells the cards
// apart, and a dismissible banner sits on top when the compose-target
// project fell back to policy while a container runtime could have carried
// it (in "All projects", that is the select, not the launch-repo blob). All
// grouping/extraction is pure; the queue only holds its disclosure state, the
// banner dismissal and a minute tick for the pause durations.
import { computed, onUnmounted, ref, watch } from 'vue'
import { CHECKS_STATUS_KEY, checksBadge, checksTone } from '../composables/useChecks'
import {
  ISOLATION_DOC_URL,
  isolationBadge,
  persistIsolationBannerDismissed,
  readIsolationBannerDismissed,
  shouldOfferIsolationUpgrade,
  showIsolationDot,
} from '../composables/useIsolation'
import { isolationForProject } from '../composables/useProjects'
import {
  formatDuration,
  groupQueue,
  lastQuestion,
  queueRankHintKey,
  resumeStateOf,
  waitingSince,
  type QueueSection,
} from '../composables/useTaskBoard'
import { taskKey, type CreateTaskInput, type TaskState } from '../composables/useTasks'
import { EXECUTION_STATUS } from '../execution-status'
import { t } from '../i18n'
import type { AgentOption, Project, TaskIsolation, WorkspaceInfo } from '../types'
import TaskComposer from './TaskComposer.vue'

const props = defineProps<{
  /** Conversations to show, already filtered (project + search) upstream. */
  states: TaskState[]
  /** Project display names, to label each card's repo. */
  projectNames: ReadonlyMap<string, string>
  /** Keys (taskKey) of the conversations open in the focus deck. */
  focusedKeys: readonly string[]
  /** Registered projects: the composer's target select ("All" mode only). */
  projects: Project[]
  /** The selected project filter; null = "All projects". */
  filter: string | null
  creating: boolean
  createError: string | null
  /** Launch-repo / process-wide isolation (fallback for older CLIs). */
  workspace: WorkspaceInfo | null
  agents?: readonly AgentOption[]
  currentAgent?: string
}>()

const emit = defineEmits<{
  open: [state: TaskState]
  ship: [state: TaskState]
  resume: [state: TaskState]
  create: [projectId: string, input: CreateTaskInput]
}>()

const groups = computed(() => groupQueue(props.states))

const keyOf = (state: TaskState): string => taskKey(state.projectId, state.record.id)
const projectName = (state: TaskState): string =>
  props.projectNames.get(state.projectId) ?? state.projectId

// ── Composer: target project ("All" mode) + reset once a create settles ───
const composer = ref<InstanceType<typeof TaskComposer> | null>(null)
const target = ref<string | null>(null)

/** The repo a new task lands in: the filter when one is selected, else the
 * select's choice, seeded with the first registered project. */
const effectiveTarget = computed(() => {
  if (props.filter !== null) {
    return props.filter
  }
  if (target.value !== null && props.projects.some((p) => p.id === target.value)) {
    return target.value
  }
  return props.projects[0]?.id ?? null
})

function onCreate(input: CreateTaskInput): void {
  if (effectiveTarget.value !== null) {
    emit('create', effectiveTarget.value, input)
  }
}

watch(
  () => props.creating,
  (busy, wasBusy) => {
    if (wasBusy && !busy && props.createError === null) {
      composer.value?.reset()
    }
  },
)

// ── Minute tick: "paused for X" stays honest without being busy ───────────
const now = ref(Date.now())
const ticker = setInterval(() => {
  now.value = Date.now()
}, 30_000)
onUnmounted(() => clearInterval(ticker))

function pausedFor(state: TaskState): string | null {
  const since = waitingSince(state.events, state.record.updated_at)
  return since === null ? null : formatDuration(Math.max(0, now.value - since))
}

const excerptOf = (state: TaskState): string | null => lastQuestion(state.events)

/** T8: what a stopped conversation offers — only 'ready' earns a button. */
const resumeOf = (state: TaskState) => resumeStateOf(state.record)

// Done pile: visible by default (Hasan: "je veux toujours voir les dones"),
// still foldable for long histories.
const doneOpen = ref(true)

const isEmpty = computed(() => props.states.length === 0)

/** The #N pill's tooltip; queueRankHintKey decides which promise it may make. */
const rankHint = (state: TaskState, rank: number): string =>
  t(queueRankHintKey(state.record), { n: rank })

// ── Isolation: per-card dot + the one-time upgrade banner ─────────────────
const isoOf = (state: TaskState) => isolationBadge(state.record)
const isolationOf = (projectId: string): WorkspaceInfo | null =>
  isolationForProject(projectId, props.projects, props.workspace)
const showIso = (state: TaskState): boolean =>
  showIsolationDot(state.record, isolationOf(state.projectId))

// Dismissal is a local preference, persisted for good on this machine.
const isoBannerDismissed = ref(readIsolationBannerDismissed())
// Banner follows the repo a NEW task would land in (filter, else the All-mode
// select). Passing filter=null would fall back to the launch-repo blob and
// hide a degraded sibling you are about to create on.
const composeIsolation = computed(() =>
  isolationForProject(effectiveTarget.value, props.projects, props.workspace),
)
const composeIsolationMode = computed<TaskIsolation | null>(
  () => composeIsolation.value?.isolation_default ?? null,
)
const composeAgent = computed(() => composeIsolation.value?.agent ?? props.currentAgent ?? '')
const showIsoBanner = computed(() =>
  shouldOfferIsolationUpgrade(composeIsolation.value, isoBannerDismissed.value),
)

function dismissIsoBanner(): void {
  isoBannerDismissed.value = true
  persistIsolationBannerDismissed()
}

const SECTION_LABEL: Record<Exclude<QueueSection, 'done'>, string> = {
  attention: 'workspace.queueAttention',
  active: 'workspace.queueActive',
  ready: 'workspace.queueReady',
}
</script>

<template>
  <section class="wq-root" :aria-label="t('workspace.conversations')">
    <!-- Composer: "New task…", auto-ship, target project when unfiltered. -->
    <div class="wq-compose">
      <label v-if="filter === null && projects.length > 1" class="wq-target">
        <span class="wq-target-label">{{ t('workspace.projectTarget') }}</span>
        <select
          class="wq-target-select"
          :value="effectiveTarget"
          @change="target = ($event.target as HTMLSelectElement).value"
        >
          <option v-for="project in projects" :key="project.id" :value="project.id">
            {{ project.name }}
          </option>
        </select>
      </label>
      <TaskComposer
        ref="composer"
        :creating="creating"
        :error="createError"
        :agents="agents ?? []"
        :current-agent="composeAgent"
        :isolation="composeIsolationMode"
        @create="onCreate"
      />
    </div>

    <div class="wq-scroll">
      <!-- Said once, not on every card: agents here are not caged, and how to
           change that. Dismissing it is remembered on this machine. -->
      <aside v-if="showIsoBanner" class="wq-iso-banner">
        <p class="wq-iso-title">
          <span aria-hidden="true">🛡</span> {{ t('workspace.isolationUpgradeTitle') }}
        </p>
        <p class="wq-iso-body">
          {{
            t('workspace.isolationUpgradeBody', {
              reason: composeIsolation?.isolation_reason ?? workspace?.isolation_reason ?? '',
            })
          }}
        </p>
        <p class="wq-iso-actions">
          <a
            class="wq-iso-link"
            :href="ISOLATION_DOC_URL"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t('workspace.isolationUpgradeLink') }}
          </a>
          <button class="wq-iso-dismiss" type="button" @click="dismissIsoBanner">
            {{ t('workspace.isolationUpgradeDismiss') }}
          </button>
        </p>
      </aside>

      <p v-if="isEmpty" class="wq-empty">{{ t('workspace.treeEmpty') }}</p>

      <!-- ⚠ NEEDS YOU: the human is the bottleneck; amber carries the state. -->
      <div v-if="groups.attention.length > 0" class="wq-group">
        <h2 class="wq-head wq-head--attention">
          <span aria-hidden="true">⚠</span>
          {{ t(SECTION_LABEL.attention) }}
          <span class="wq-head-dot" aria-hidden="true" />
        </h2>
        <!-- A div, not a button: a stopped conversation nests its own
             [Resume] action (same pattern as the ready cards), hence the
             explicit role/tabindex/keydown. -->
        <div
          v-for="state in groups.attention"
          :key="keyOf(state)"
          class="wq-card wq-card--attention"
          :class="{ 'wq-card--focused': focusedKeys.includes(keyOf(state)) }"
          role="button"
          tabindex="0"
          @click="emit('open', state)"
          @keydown.enter="emit('open', state)"
          @keydown.space.prevent="emit('open', state)"
        >
          <span class="wq-card-row">
            <span class="wq-title">{{ state.record.title }}</span>
            <span
              v-if="showIso(state)"
              class="wq-iso"
              :class="`wq-iso--${isoOf(state).isolation}`"
              role="img"
              :aria-label="t(isoOf(state).labelKey)"
              :title="t(isoOf(state).hintKey)"
            />
            <span class="wq-flag">{{ t(EXECUTION_STATUS[state.record.status].labelKey) }}</span>
          </span>
          <span v-if="excerptOf(state)" class="wq-question">« {{ excerptOf(state) }} »</span>
          <span class="wq-meta">
            {{ projectName(state) }}
            <template v-if="pausedFor(state)">
              · {{ t('workspace.pausedFor', { t: pausedFor(state) }) }}
            </template>
          </span>
          <!-- T8: the offer is right here, on the card. Absent when there is
               nothing to restart — the conversation then says why. -->
          <span v-if="resumeOf(state) === 'ready'" class="wq-actions">
            <button
              class="wq-resume"
              :title="t('workspace.resumeHint')"
              @click.stop="emit('resume', state)"
            >
              {{ t('workspace.resume') }}
            </button>
          </span>
        </div>
      </div>

      <!-- IN PROGRESS: the machine works; nothing is asked of the human. -->
      <div v-if="groups.active.length > 0" class="wq-group">
        <h2 class="wq-head">{{ t(SECTION_LABEL.active) }}</h2>
        <button
          v-for="state in groups.active"
          :key="keyOf(state)"
          class="wq-card"
          :class="{ 'wq-card--focused': focusedKeys.includes(keyOf(state)) }"
          @click="emit('open', state)"
        >
          <span class="wq-card-row">
            <span
              class="wq-dot"
              :class="{ 'wq-dot--pulse': EXECUTION_STATUS[state.record.status].pulse }"
              aria-hidden="true"
            />
            <span class="wq-title">{{ state.record.title }}</span>
            <!-- One task at a time per repo: a conversation waiting its turn
                 shows WHERE it is in its project's line, so "queued" never
                 reads as "stuck". Absent on the one that is actually running. -->
            <span
              v-if="state.record.queue_position !== undefined"
              class="wq-rank"
              :title="rankHint(state, state.record.queue_position)"
            >
              {{ t('workspace.queuePosition', { n: state.record.queue_position }) }}
            </span>
            <span
              v-if="showIso(state)"
              class="wq-iso"
              :class="`wq-iso--${isoOf(state).isolation}`"
              role="img"
              :aria-label="t(isoOf(state).labelKey)"
              :title="t(isoOf(state).hintKey)"
            />
            <span class="wq-project">{{ projectName(state) }}</span>
          </span>
          <span class="wq-bar" aria-hidden="true"><span class="wq-bar-fill" /></span>
        </button>
      </div>

      <!-- READY TO SHIP: green ring, one click away. -->
      <div v-if="groups.ready.length > 0" class="wq-group">
        <h2 class="wq-head wq-head--ready">{{ t(SECTION_LABEL.ready) }}</h2>
        <!-- The WHOLE card opens the conversation (a div, not a button: it
             nests its own actions — hence the explicit role/tabindex/keydown);
             both inner buttons stop the bubble so one click emits once. -->
        <div
          v-for="state in groups.ready"
          :key="keyOf(state)"
          class="wq-card wq-card--ready"
          :class="{ 'wq-card--focused': focusedKeys.includes(keyOf(state)) }"
          role="button"
          tabindex="0"
          @click="emit('open', state)"
          @keydown.enter="emit('open', state)"
          @keydown.space.prevent="emit('open', state)"
        >
          <span class="wq-ready-open">
            <span class="wq-dot wq-dot--green" aria-hidden="true" />
            <span class="wq-title">{{ state.record.title }}</span>
            <!-- Checks semaphore: what the human sees BEFORE clicking Ship
                 (informative only, never a gate). Absent when no run exists. -->
            <span
              v-if="state.checks && checksBadge(state.checks)"
              class="wq-checks"
              :class="`wq-checks--${checksTone(state.checks)}`"
              :title="t(CHECKS_STATUS_KEY[state.checks.status])"
            >
              {{ checksBadge(state.checks) }}
            </span>
            <span
              v-if="showIso(state)"
              class="wq-iso"
              :class="`wq-iso--${isoOf(state).isolation}`"
              role="img"
              :aria-label="t(isoOf(state).labelKey)"
              :title="t(isoOf(state).hintKey)"
            />
            <span class="wq-project">{{ projectName(state) }}</span>
          </span>
          <span class="wq-actions">
            <button class="wq-ship" @click.stop="emit('ship', state)">
              {{ t('workspace.shipAction') }}
            </button>
            <button
              class="wq-diff"
              :title="t('workspace.filesTitle')"
              @click.stop="emit('open', state)"
            >
              {{ t('workspace.diffAction') }}
            </button>
          </span>
        </div>
      </div>

      <!-- DONE: history, folded — it is not work anymore. -->
      <div v-if="groups.done.length > 0" class="wq-group">
        <button
          class="wq-head wq-head--toggle"
          :aria-expanded="doneOpen"
          @click="doneOpen = !doneOpen"
        >
          <span class="wq-chevron" aria-hidden="true">{{ doneOpen ? '▾' : '▸' }}</span>
          {{ t('workspace.queueDone') }}
          <span class="wq-count">{{ groups.done.length }}</span>
        </button>
        <template v-if="doneOpen">
          <button
            v-for="state in groups.done"
            :key="keyOf(state)"
            class="wq-done"
            :class="{ 'wq-card--focused': focusedKeys.includes(keyOf(state)) }"
            @click="emit('open', state)"
          >
            <span
              class="wq-done-glyph"
              :style="{ color: EXECUTION_STATUS[state.record.status].text }"
              :title="t(EXECUTION_STATUS[state.record.status].labelKey)"
              aria-hidden="true"
            >
              {{ EXECUTION_STATUS[state.record.status].icon }}
            </span>
            <span class="wq-done-title">{{ state.record.title }}</span>
            <span class="wq-project">{{ projectName(state) }}</span>
          </button>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wq-root {
  display: flex;
  flex-direction: column;
  width: 430px;
  flex: none;
  min-height: 0;
  border-right: 1px solid var(--cs-line);
  background: var(--cs-panel);
}

.wq-compose {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--cs-line);
}

.wq-target {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wq-target-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.wq-target-select {
  flex: 1;
  min-width: 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--cs-text);
  background: var(--cs-surface-2);
  border: 1px solid var(--cs-line-2);
  border-radius: 7px;
  padding: 5px 8px;
}

.wq-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.wq-empty {
  margin: 0;
  padding: 2px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.wq-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.wq-head {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

/* Attention carries a state: this group blocks on the human. */
.wq-head--attention {
  font-weight: 700;
  color: var(--cs-amber-text);
}

.wq-head-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cs-amber-text);
  box-shadow: 0 0 8px #e8c46a99;
}

.wq-head--ready {
  color: var(--cs-green);
}

.wq-head--toggle {
  border: none;
  background: transparent;
  text-align: left;
  padding: 4px;
  margin: -4px;
  border-radius: 6px;
  cursor: pointer;
}

.wq-head--toggle:hover {
  background: var(--cs-hover);
}

.wq-chevron {
  flex: none;
  width: 10px;
  font-size: 9px;
  color: var(--cs-ghost);
}

.wq-count {
  font-weight: 400;
  color: var(--cs-ghost);
  font-variant-numeric: tabular-nums;
}

/* ── Isolation: one banner, then one quiet dot per card ───────────────── */
.wq-iso-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 12px;
  border: 1px solid var(--cs-line-2);
  border-left: 3px solid var(--cs-line-3);
  border-radius: 9px;
  background: var(--cs-surface);
}

.wq-iso-title {
  margin: 0;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--cs-text-2);
}

.wq-iso-body {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--cs-ghost);
}

.wq-iso-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 0 0;
}

.wq-iso-link {
  font-size: 11px;
  font-weight: 600;
  color: var(--cs-green-text);
  text-decoration: none;
}

.wq-iso-link:hover {
  text-decoration: underline;
}

.wq-iso-dismiss {
  font-family: inherit;
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--cs-line-2);
  border-radius: 5px;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
}

.wq-iso-dismiss:hover {
  border-color: var(--cs-line-3);
  color: var(--cs-text-2);
}

/* Filled green = caged; hollow = policy. Discreet on purpose: it informs,
   it does not alarm. */
.wq-iso {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  cursor: help;
}

.wq-iso--container {
  background: var(--cs-green);
}

.wq-iso--policy {
  border: 1px solid var(--cs-line-3);
}

/* ── Cards ────────────────────────────────────────────────────────────── */
.wq-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  font-family: inherit;
  padding: 12px 13px;
  border: 1px solid var(--cs-line-2);
  border-radius: 10px;
  background: var(--cs-surface);
  cursor: pointer;
}

.wq-card:hover {
  border-color: var(--cs-line-3);
}

/* The conversation currently in focus keeps a quiet marker in the queue. */
.wq-card--focused {
  box-shadow: 0 0 0 2px var(--cs-line-3);
}

.wq-card-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.wq-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wq-project {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  color: var(--cs-ghost);
}

/* Rank in the project's queue: a quiet monospace pill, never louder than the
   title it sits next to — it is a fact about waiting, not a warning. */
.wq-rank {
  flex: none;
  padding: 1px 5px;
  border: 1px solid var(--cs-line);
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--cs-ghost);
}

/* Attention card: amber ground + left rail, soft halo — the loudest thing
   on screen, because the human is what everything waits on. */
.wq-card--attention {
  background: var(--cs-amber-card);
  border-color: var(--cs-amber-line);
  border-left: 3px solid var(--cs-amber-text);
  box-shadow: 0 0 18px rgba(232, 196, 106, 0.07);
}

.wq-card--attention.wq-card--focused {
  box-shadow:
    0 0 18px rgba(232, 196, 106, 0.07),
    0 0 0 2px var(--cs-amber-line);
}

.wq-flag {
  flex: none;
  font-family: var(--font-mono);
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-amber-text);
  background: var(--cs-amber-soft);
  padding: 2px 6px;
  border-radius: 4px;
}

.wq-question {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--cs-amber-text);
  background: var(--cs-inset);
  border-radius: 6px;
  padding: 6px 9px;
  overflow-wrap: anywhere;
}

.wq-meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--cs-ghost);
}

/* Live dot + thin indeterminate bar: the agent is working right now. */
.wq-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cs-amber);
  box-shadow: var(--cs-amber-glow);
}

.wq-dot--pulse {
  animation: wq-pulse 1.6s ease-in-out infinite;
}

@keyframes wq-pulse {
  50% {
    opacity: 0.35;
  }
}

.wq-dot--green {
  background: var(--cs-green);
  box-shadow: none;
}

.wq-bar {
  display: block;
  height: 3px;
  border-radius: 2px;
  background: var(--cs-line);
  overflow: hidden;
}

.wq-bar-fill {
  display: block;
  width: 30%;
  height: 100%;
  border-radius: 2px;
  background: var(--cs-amber);
  animation: wq-slide 2.2s ease-in-out infinite;
}

@keyframes wq-slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(433%);
  }
}

/* Ready card: the green ring is the state — one click away from shipping. */
.wq-card--ready {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 13px;
  border: 1px solid var(--cs-green-ring);
  border-radius: 10px;
  background: var(--cs-surface);
}

.wq-card--ready.wq-card--focused {
  box-shadow: 0 0 0 2px var(--cs-green-ring);
}

.wq-ready-open {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  text-align: left;
  font-family: inherit;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

/* Checks mini-badge: the run's semaphore glyph, colored by its state. */
.wq-checks {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
}

.wq-checks--pass {
  color: var(--cs-green-text);
  background: var(--cs-green-soft);
}

.wq-checks--fail {
  color: var(--cs-red-text);
  background: var(--cs-red-soft);
}

.wq-checks--run,
.wq-checks--warn {
  color: var(--cs-amber-text);
  background: var(--cs-amber-soft);
}

.wq-actions {
  display: flex;
  gap: 7px;
}

.wq-ship {
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 700;
  padding: 4px 11px;
  border: none;
  border-radius: 5px;
  background: var(--cs-green);
  color: var(--cs-on-green);
  cursor: pointer;
}

.wq-ship:hover {
  background: var(--cs-green-hover);
}

.wq-diff {
  font-family: inherit;
  font-size: 11.5px;
  padding: 4px 9px;
  border: 1px solid var(--cs-line-3);
  border-radius: 5px;
  background: transparent;
  color: var(--cs-text-2);
  cursor: pointer;
}

.wq-diff:hover {
  border-color: var(--cs-muted);
}

/* Resume: an amber outline on an amber card — present, never a Ship. */
.wq-resume {
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 700;
  padding: 4px 11px;
  border: 1px solid var(--cs-amber-line);
  border-radius: 5px;
  background: transparent;
  color: var(--cs-amber-text);
  cursor: pointer;
}

.wq-resume:hover {
  border-color: var(--cs-amber);
  background: var(--cs-amber-soft);
}

/* Done rows: quiet history. */
.wq-done {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  font-family: inherit;
  padding: 8px 11px;
  border: 1px solid var(--cs-line);
  border-radius: 8px;
  background: var(--cs-panel-deep);
  cursor: pointer;
}

.wq-done:hover {
  border-color: var(--cs-line-3);
}

.wq-done-glyph {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 11px;
  font-family: var(--font-mono);
}

.wq-done-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--cs-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { usePilotPrefs } from '../../composables/usePilotPrefs'
import { extractQuickReplies } from '../../composables/useQuickReplies'
import { agentCounts, lastQuestion } from '../../composables/useTaskBoard'
import { useTasks, type ApiResult, type TaskState } from '../../composables/useTasks'
import { t, type MessageKey } from '../../i18n'
import type { TaskStatus } from '../../types'
import AgentCard from './AgentCard.vue'
import ChecksBlock from './ChecksBlock.vue'
import CriteriaBlock from './CriteriaBlock.vue'
import EvidenceBlock from './EvidenceBlock.vue'
import Lens from './Lens.vue'
import MobileList from './MobileList.vue'
import MobileThread from './MobileThread.vue'
import {
  closeLens,
  mobilePane,
  openLens,
  orderCards,
  type LensBlock,
  type LensState,
  type PilotCols,
} from './PilotLogic'
import QuestionBlock from './QuestionBlock.vue'
import RecapBlock from './RecapBlock.vue'

const props = defineProps<{
  token: string
}>()

const emit = defineEmits<{ 'switch-shell': [] }>()

const tasks = useTasks(props.token)
const { cols, shell } = usePilotPrefs()

onMounted(() => tasks.start())
onUnmounted(tasks.stop)

function onSwitchShell(): void {
  shell.value = 'classic'
  emit('switch-shell')
}

const orderedStates = computed(() => orderCards(tasks.states.value))
const counts = computed(() => agentCounts(tasks.states.value))

const COLS_OPTIONS: readonly PilotCols[] = [1, 2, 3, 4]

// ── Hydration: recap/evidence/checks, fetched once per visible task ─────
// Full event history is heavier and only ever read in two places, so unlike
// recap/evidence/checks it is NOT fetched for every card: eagerly for the
// attention cards whose question is shown inline, unopened (mirrors
// WorkspaceView's own `hydratedForQuestion`), and otherwise on demand the
// moment a card is actually opened (open-full, mobile select), mirroring
// WorkspaceView's `openConversation`. A reconnect never replays what
// happened while the stream was down, so every task's recap/evidence/checks
// ask again on a fresh `connections` tick, and whichever task is currently
// open re-asks for its events too.

const requestedHydration = new Set<string>()

function hydrateEventsIfNeeded(state: TaskState): void {
  const key = `${state.projectId}:${state.record.id}:events`
  if (!requestedHydration.has(key)) {
    requestedHydration.add(key)
    void tasks.hydrate(state.projectId, state.record.id)
  }
}

const EVENTS_EAGER_STATUSES: ReadonlySet<TaskStatus> = new Set(['waiting_for_you', 'review_ko'])

function hydrateIfNeeded(state: TaskState): void {
  const base = `${state.projectId}:${state.record.id}`
  if (state.recap === undefined && !requestedHydration.has(`${base}:recap`)) {
    requestedHydration.add(`${base}:recap`)
    void tasks.hydrateRecap(state.projectId, state.record.id)
  }
  if (state.evidence === undefined && !requestedHydration.has(`${base}:evidence`)) {
    requestedHydration.add(`${base}:evidence`)
    void tasks.hydrateEvidence(state.projectId, state.record.id)
  }
  // `checks` has no "never hydrated" sentinel of its own (it defaults to
  // `null`, same value a hydrated-but-empty task carries), unlike
  // recap/evidence: the guard Set alone decides whether this task's checks
  // were already asked for.
  if (!requestedHydration.has(`${base}:checks`)) {
    requestedHydration.add(`${base}:checks`)
    void tasks.hydrateChecks(state.projectId, state.record.id)
  }
  if (EVENTS_EAGER_STATUSES.has(state.record.status)) {
    hydrateEventsIfNeeded(state)
  }
}

watch(
  tasks.states,
  (states) => {
    for (const state of states) {
      hydrateIfNeeded(state)
    }
  },
  { immediate: true },
)

watch(tasks.connections, () => {
  requestedHydration.clear()
  for (const state of tasks.states.value) {
    hydrateIfNeeded(state)
  }
  // The currently open task (full view or mobile thread) is not necessarily
  // in the eager attention subset above (it may be a terminated task the
  // reader opened deliberately): re-fetch its events too, matching how
  // WorkspaceView's own reconnect handling re-hydrates the open conversation.
  if (expandedState.value !== null) {
    hydrateEventsIfNeeded(expandedState.value)
  }
  if (selectedState.value !== null) {
    hydrateEventsIfNeeded(selectedState.value)
  }
})

// ── Replies and actions: useTasks carries no send state of its own ──────

const sendingTaskIds = reactive(new Set<string>())

async function withSending(taskId: string, action: () => Promise<ApiResult>): Promise<void> {
  sendingTaskIds.add(taskId)
  try {
    await action()
  } finally {
    sendingTaskIds.delete(taskId)
  }
}

function sendReply(projectId: string, taskId: string, message: string): Promise<void> {
  return withSending(taskId, () => tasks.reply(projectId, taskId, message))
}

function doShip(projectId: string, taskId: string): Promise<void> {
  return withSending(taskId, () => tasks.ship(projectId, taskId))
}

function doStop(projectId: string, taskId: string): Promise<void> {
  return withSending(taskId, () => tasks.interrupt(projectId, taskId))
}

function doResume(projectId: string, taskId: string): Promise<void> {
  return withSending(taskId, () => tasks.resume(projectId, taskId))
}

function findState(taskId: string): TaskState | null {
  return tasks.states.value.find((state) => state.record.id === taskId) ?? null
}

// ── Lens: one card's block, zoomed ───────────────────────────────────────

const lensState = ref<LensState>(null)

function onOpenLens(taskId: string, block: LensBlock): void {
  lensState.value = openLens(lensState.value, taskId, block)
}

const lensTaskState = computed<TaskState | null>(() =>
  lensState.value === null ? null : findState(lensState.value.taskId),
)

const lensBlock = computed<LensBlock | null>(() => lensState.value?.block ?? null)

const LENS_BLOCK_TITLE_KEY: Record<LensBlock, MessageKey> = {
  evidence: 'pilot.evidence.title',
  recap: 'pilot.recap.title',
  checks: 'pilot.checks.title',
  criteria: 'pilot.criteria.title',
  // No dedicated title key exists for the question block: its own banner
  // phrase doubles as the lens title.
  question: 'pilot.question.waiting',
}

const lensTitle = computed(() => {
  if (lensTaskState.value === null || lensBlock.value === null) {
    return ''
  }
  return `${lensTaskState.value.record.title} · ${t(LENS_BLOCK_TITLE_KEY[lensBlock.value])}`
})

const lensQuestion = computed(() => {
  if (lensTaskState.value === null || lensTaskState.value.record.status !== 'waiting_for_you') {
    return null
  }
  return lastQuestion(lensTaskState.value.events)
})

const lensQuickReplyOptions = computed(() =>
  lensQuestion.value === null ? [] : extractQuickReplies(lensQuestion.value),
)

function onLensPick(option: string): void {
  if (lensTaskState.value === null) {
    return
  }
  void sendReply(lensTaskState.value.projectId, lensTaskState.value.record.id, option)
  lensState.value = closeLens()
}

function onLensOther(): void {
  lensState.value = closeLens()
}

// ── Open full: V1 stand-in, MobileThread large inside the same lens shell.
// The real destination (TaskConversation) is wired in a later lot. ───────

const expandedId = ref<string | null>(null)

const expandedState = computed<TaskState | null>(() =>
  expandedId.value === null ? null : findState(expandedId.value),
)

function onOpenFull(state: TaskState): void {
  expandedId.value = state.record.id
  hydrateEventsIfNeeded(state)
}

function onExpandedSend(text: string): void {
  if (expandedState.value === null) {
    return
  }
  void sendReply(expandedState.value.projectId, expandedState.value.record.id, text)
}

function onExpandedPick(option: string): void {
  onExpandedSend(option)
}

// ── Mobile: list or thread, never both ───────────────────────────────────

const selectedId = ref<string | null>(null)
const mobilePaneKind = computed(() => mobilePane(selectedId.value))
const selectedState = computed<TaskState | null>(() =>
  selectedId.value === null ? null : findState(selectedId.value),
)

function onMobileOpen(taskId: string): void {
  selectedId.value = taskId
  const target = findState(taskId)
  if (target !== null) {
    hydrateEventsIfNeeded(target)
  }
}

function onMobileSend(text: string): void {
  if (selectedState.value === null) {
    return
  }
  void sendReply(selectedState.value.projectId, selectedState.value.record.id, text)
}

function onMobilePick(option: string): void {
  onMobileSend(option)
}
</script>

<template>
  <div class="ws-root pv-root">
    <header class="pv-top">
      <div class="pv-brand">
        <span class="pv-brand-name">codesema</span>
        <span class="pv-brand-sub">{{ t('pilot.mobile.title') }}</span>
      </div>
      <div class="pv-counts">
        <span class="pv-count">
          {{ t('pilot.header.conversations', { n: orderedStates.length }) }}
        </span>
        <span v-if="counts.needsYou > 0" class="pv-count pv-count--attention">
          {{ t('workspace.needsYouBadge', { n: counts.needsYou }) }}
        </span>
        <span v-if="counts.agents > 0" class="pv-count">
          {{ t('pilot.header.working', { n: counts.agents }) }}
        </span>
      </div>
      <div class="pv-spacer" />
      <div class="pv-cols" role="group" :aria-label="t('pilot.cols.aria')">
        <button
          v-for="n in COLS_OPTIONS"
          :key="n"
          type="button"
          class="pv-cols-btn"
          :class="{ 'pv-cols-btn--on': cols === n }"
          :aria-pressed="cols === n"
          @click="cols = n"
        >
          {{ n }}
        </button>
      </div>
      <button type="button" class="pv-switch" @click="onSwitchShell">
        {{ t('pilot.toggle.classic') }}
      </button>
    </header>

    <div class="pv-grid" :data-cols="cols" :style="{ '--cols': cols }">
      <p v-if="orderedStates.length === 0" class="pv-empty">{{ t('pilot.grid.empty') }}</p>
      <AgentCard
        v-for="state in orderedStates"
        :key="`${state.projectId}:${state.record.id}`"
        :state="state"
        :sending="sendingTaskIds.has(state.record.id)"
        @open-full="onOpenFull(state)"
        @open-lens="onOpenLens(state.record.id, $event)"
        @send="(text) => sendReply(state.projectId, state.record.id, text)"
        @pick="(option) => sendReply(state.projectId, state.record.id, option)"
        @ship="doShip(state.projectId, state.record.id)"
        @stop="doStop(state.projectId, state.record.id)"
        @resume="doResume(state.projectId, state.record.id)"
      />
    </div>

    <Lens
      v-if="lensTaskState !== null && lensBlock !== null"
      :title="lensTitle"
      @close="lensState = closeLens()"
    >
      <EvidenceBlock
        v-if="lensBlock === 'evidence'"
        :task-id="lensTaskState.record.id"
        :evidence="lensTaskState.evidence ?? null"
      />
      <RecapBlock v-else-if="lensBlock === 'recap'" :recap="lensTaskState.recap ?? null" />
      <ChecksBlock v-else-if="lensBlock === 'checks'" :checks="lensTaskState.checks" />
      <CriteriaBlock
        v-else-if="lensBlock === 'criteria'"
        :criteria="lensTaskState.recap?.criteria"
      />
      <QuestionBlock
        v-else-if="lensBlock === 'question'"
        :question="lensQuestion"
        :options="lensQuickReplyOptions"
        :disabled="sendingTaskIds.has(lensTaskState.record.id)"
        @pick="onLensPick"
        @other="onLensOther"
      />
    </Lens>

    <Lens
      v-if="expandedState !== null"
      :title="expandedState.record.title"
      @close="expandedId = null"
    >
      <MobileThread
        class="pv-expanded-thread"
        :state="expandedState"
        :sending="sendingTaskIds.has(expandedState.record.id)"
        @back="expandedId = null"
        @send="onExpandedSend"
        @pick="onExpandedPick"
      />
    </Lens>

    <div class="pv-mobile">
      <MobileThread
        v-if="mobilePaneKind === 'thread' && selectedState !== null"
        :state="selectedState"
        :sending="sendingTaskIds.has(selectedState.record.id)"
        @back="selectedId = null"
        @send="onMobileSend"
        @pick="onMobilePick"
      />
      <MobileList v-else :states="orderedStates" @open="onMobileOpen" />
    </div>
  </div>
</template>

<style scoped>
.pv-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--cs-bg);
  color: var(--cs-text);
}

.pv-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 52px;
  padding: 0 18px;
  border-bottom: 1px solid var(--cs-line);
  background: var(--cs-panel);
}

.pv-brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.pv-brand-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--cs-text);
}

.pv-brand-sub {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cs-muted);
}

.pv-counts {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--cs-muted);
}

.pv-count--attention {
  color: var(--cs-amber-text);
  font-weight: 600;
}

.pv-spacer {
  flex: 1;
}

.pv-cols {
  display: inline-flex;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  overflow: hidden;
}

.pv-cols-btn {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 5px 12px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--cs-text-2);
  cursor: pointer;
}

.pv-cols-btn:hover {
  color: var(--cs-text);
}

.pv-cols-btn--on {
  background: var(--cs-green-soft);
  color: var(--cs-green-text);
}

.pv-switch {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 7px;
  border: 1px solid var(--cs-line);
  background: var(--cs-surface);
  color: var(--cs-text-2);
  cursor: pointer;
}

.pv-switch:hover {
  border-color: var(--cs-line-2);
}

.pv-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  grid-auto-rows: minmax(320px, 1fr);
  gap: 16px;
  padding: 16px;
}

.pv-grid[data-cols='1'] {
  grid-auto-rows: minmax(560px, auto);
}

.pv-empty {
  grid-column: 1 / -1;
  margin: auto;
  max-width: 360px;
  text-align: center;
  font-size: 13px;
  color: var(--cs-muted);
}

.pv-expanded-thread {
  width: min(760px, 92vw);
  height: min(720px, 86vh);
  overflow: hidden;
  border: 1px solid var(--cs-line);
  border-radius: 12px;
}

.pv-mobile {
  display: none;
  flex: 1;
  min-height: 0;
}

@media (max-width: 760px) {
  .pv-top,
  .pv-grid {
    display: none;
  }

  .pv-mobile {
    display: flex;
  }
}
</style>

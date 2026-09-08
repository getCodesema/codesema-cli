<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { usePilotPrefs } from '../../composables/usePilotPrefs'
import { agentCounts } from '../../composables/useTaskBoard'
import { taskKey, useTasks, type ApiResult, type TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { TaskStatus } from '../../types'
import ConversationsList from '../rail/ConversationsList.vue'
import { orderCards } from './PilotLogic'
import PilotThread from './PilotThread.vue'

const props = defineProps<{
  token: string
}>()

const emit = defineEmits<{ 'switch-shell': [] }>()

const tasks = useTasks(props.token)
const { shell } = usePilotPrefs()

onMounted(() => tasks.start())
onUnmounted(tasks.stop)

function onSwitchShell(): void {
  shell.value = 'classic'
  emit('switch-shell')
}

const orderedStates = computed(() => orderCards(tasks.states.value))
const counts = computed(() => agentCounts(tasks.states.value))
const projectNameById = computed(
  () => new Map(tasks.projects.value.map((project) => [project.id, project.name])),
)

// ── Hydration: recap/evidence/verification/checks, fetched once per visible
// task ─────────────────────────────────────────────────────────────────
// Full event history is heavier and only ever read in the open conversation,
// so unlike recap/evidence/verification/checks it is NOT fetched for every
// task: eagerly for the attention tasks whose question the reader is
// expected to answer next (mirrors WorkspaceView's own
// `hydratedForQuestion`), and otherwise on demand the moment a conversation
// is actually selected, mirroring WorkspaceView's `openConversation`. A
// reconnect never replays what happened while the stream was down, so every
// task's recap/evidence/verification/checks ask again on a fresh
// `connections` tick, and the open conversation re-asks for its events too.

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
  if (state.verification === undefined && !requestedHydration.has(`${base}:verification`)) {
    requestedHydration.add(`${base}:verification`)
    void tasks.hydrateVerification(state.projectId, state.record.id)
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
  // The open conversation is not necessarily in the eager attention subset
  // above (it may be a terminated task the reader opened deliberately):
  // re-fetch its events too, matching how WorkspaceView's own reconnect
  // handling re-hydrates the open conversation.
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

// ── Selection: the list on the left, the one open conversation in the middle ─

const selectedId = ref<string | null>(null)

const selectedState = computed<TaskState | null>(() =>
  selectedId.value === null ? null : findState(selectedId.value),
)

const focusedKeys = computed<string[]>(() =>
  selectedState.value === null
    ? []
    : [taskKey(selectedState.value.projectId, selectedState.value.record.id)],
)

function onSelect(state: TaskState): void {
  selectedId.value = state.record.id
  hydrateEventsIfNeeded(state)
}

function onSend(text: string): void {
  if (selectedState.value === null) {
    return
  }
  void sendReply(selectedState.value.projectId, selectedState.value.record.id, text)
}

function onPick(option: string): void {
  onSend(option)
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
      <button type="button" class="pv-switch btn" @click="onSwitchShell">
        {{ t('pilot.toggle.classic') }}
      </button>
    </header>

    <div class="pv-body" :data-selected="selectedState !== null">
      <ConversationsList
        class="pv-list"
        :states="orderedStates"
        :project-names="projectNameById"
        :focused-keys="focusedKeys"
        @select="onSelect"
        @create="onSwitchShell"
      />

      <main class="pv-stage">
        <PilotThread
          v-if="selectedState !== null"
          class="pv-thread"
          show-back
          :state="selectedState"
          :sending="sendingTaskIds.has(selectedState.record.id)"
          @back="selectedId = null"
          @send="onSend"
          @pick="onPick"
          @ship="doShip(selectedState.projectId, selectedState.record.id)"
          @stop="doStop(selectedState.projectId, selectedState.record.id)"
          @resume="doResume(selectedState.projectId, selectedState.record.id)"
        />
        <p v-else class="pv-empty empty">{{ t('pilot.grid.empty') }}</p>
      </main>
    </div>
  </div>
</template>

<style scoped>
.pv-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
}

.pv-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2ch;
  padding: calc(var(--row) / 2) 2ch;
  border-bottom: 1px solid var(--line);
}

.pv-brand {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.pv-brand-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--fg);
}

.pv-brand-sub {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.pv-counts {
  display: flex;
  align-items: center;
  gap: 2ch;
  font-size: 12px;
  color: var(--fg-dim);
}

.pv-count--attention {
  color: var(--warn);
  font-weight: 700;
}

.pv-spacer {
  flex: 1;
}

.pv-switch {
  color: var(--fg-dim);
}

.pv-switch:hover {
  color: var(--fg);
}

.pv-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.pv-list {
  flex: none;
  width: 30ch;
  min-height: 0;
}

.pv-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--row) 2ch;
}

.pv-thread {
  flex: 1;
  width: 100%;
  max-width: 100ch;
  min-height: 0;
  margin-inline: auto;
}

.pv-empty {
  max-width: 60ch;
  margin: auto;
}

/* The back button belongs to the narrow layout, where the list and the
   thread never share the screen; the same single PilotThread instance
   serves both widths, so the wide layout hides it rather than mounting a
   second thread without `show-back`. */
@media (min-width: 761px) {
  .pv-thread :deep(.pt-back) {
    display: none;
  }
}

@media (max-width: 760px) {
  .pv-list {
    width: 100%;
    border-right: 0;
  }

  .pv-stage {
    padding: 0;
  }

  .pv-body[data-selected='true'] .pv-list {
    display: none;
  }

  .pv-body[data-selected='false'] .pv-stage {
    display: none;
  }
}
</style>

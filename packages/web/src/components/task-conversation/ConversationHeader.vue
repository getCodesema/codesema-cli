<script setup lang="ts">
// The conversation's header: state glyph + title, the four offers (cleanup,
// interrupt, resume, ship), the identity chips (project · branch, isolation,
// status phrase, chronos), the blocker's own sentence, and the tab bar. The
// state is carried by `data-tone`, never by an inline colour.
import { computed, ref, watch } from 'vue'
import { isolationBadge } from '../../composables/useIsolation'
import {
  formatDuration,
  reasonDetailText,
  resumeStateOf,
  statusPhraseKey,
  type FocusTab,
  type FocusTabState,
} from '../../composables/useTaskBoard'
import type { ApiResult, TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { Project, TaskStatus } from '../../types'

const props = defineProps<{
  state: TaskState
  projectName: string
  projectKind: Project['kind']
  repoProjects: Project[]
  attach: (repoProjectId: string) => Promise<ApiResult>
  interrupt: () => Promise<ApiResult>
  resume: () => Promise<ApiResult>
  ship: () => Promise<ApiResult>
  abandon: () => Promise<ApiResult>
  tab: FocusTab
  tabs: FocusTabState[]
  diffTabLabel: string
  checksTabText: string
  checksToneClass: string
  actionError: string | null
}>()

const emit = defineEmits<{ 'pick-tab': [tab: FocusTab]; error: [message: string | null] }>()

const record = computed(() => props.state.record)
const visual = computed(() => EXECUTION_STATUS[record.value.status])
// A 'queued' task waiting for the MACHINE-wide cap gets its own phrase.
const phraseKey = computed(() =>
  statusPhraseKey(record.value, props.state.liveLoadCap?.waitingForSlot ?? false),
)
// The phrase says WHAT holds the conversation; this says what to DO about it.
const reasonDetail = computed(() => reasonDetailText(record.value))
const isolation = computed(() => isolationBadge(record.value))
const attachments = computed(() => record.value.attachments ?? [])
// Offering a repository this conversation already holds would be an action
// with nothing to do.
const attachableProjects = computed(() => {
  const held = new Set(attachments.value.map((attachment) => attachment.project_id))
  return props.repoProjects.filter((project) => !held.has(project.id))
})

const shipNotice = ref<string | null>(null)

async function run(action: () => Promise<ApiResult>): Promise<boolean> {
  emit('error', null)
  const result = await action()
  if (!result.ok) {
    emit('error', result.error)
  }
  return result.ok
}

// ── Cleanup: remove the worktree (and forked branch), two-step ────────────
const CLEANABLE: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'waiting_for_you',
  'review_ok',
  'review_ko',
  'shipped',
  'failed',
  'interrupted',
])
const canCleanup = computed(() => CLEANABLE.has(record.value.status))
const cleanupArmed = ref(false)
const cleanupBusy = ref(false)
watch(
  () => record.value.status,
  () => {
    cleanupArmed.value = false
  },
)

async function doCleanup(): Promise<void> {
  if (!cleanupArmed.value) {
    cleanupArmed.value = true
    return
  }
  cleanupArmed.value = false
  cleanupBusy.value = true
  await run(props.abandon)
  cleanupBusy.value = false
}

// 'reviewing' is deliberately ABSENT: the runner frees the slot before the
// review, so an interrupt there always 409s.
const canInterrupt = computed(() =>
  ['queued', 'running', 'waiting_for_you'].includes(record.value.status),
)

// T8. Only shown when there IS a turn to restart; 'reply' says, in words,
// that the composer is the way forward.
const resumeState = computed(() => resumeStateOf(record.value))
const resumeBusy = ref(false)

async function doResume(): Promise<void> {
  if (resumeBusy.value) {
    return
  }
  resumeBusy.value = true
  await run(props.resume)
  resumeBusy.value = false
}

async function doShip(): Promise<void> {
  shipNotice.value = null
  emit('error', null)
  const result = await props.ship()
  if (result.ok) {
    return
  }
  if (result.status === 501) {
    // T5 wires the actual push + MR creation; the button honors the contract.
    shipNotice.value = t('workspace.shipSoon')
  } else {
    emit('error', result.error)
  }
}

// ── Attach: give a scratch conversation a repo, any time, more than once ──
const attachSelection = ref('')
const attachBusy = ref(false)

async function doAttach(): Promise<void> {
  if (attachBusy.value || attachSelection.value === '') {
    return
  }
  attachBusy.value = true
  if (await run(() => props.attach(attachSelection.value))) {
    attachSelection.value = ''
  }
  attachBusy.value = false
}

async function doInterrupt(): Promise<void> {
  await run(props.interrupt)
}

const work = computed(() => formatDuration(record.value.work_ms))
const wait = computed(() =>
  record.value.wait_ms > 0 ? formatDuration(record.value.wait_ms) : null,
)
</script>

<template>
  <header class="cv-head">
    <div class="cv-conv-h conv-h">
      <div class="cv-title-row">
        <span v-if="visual.attention" class="cv-warn" aria-hidden="true">{{ G.attention }}</span>
        <span v-else class="cv-dot status" :data-tone="visual.tone" aria-hidden="true" />
        <h1 class="cv-title">{{ record.title }}</h1>
      </div>
      <span class="cv-actions act">
        <button
          v-if="canCleanup"
          class="cv-btn cv-btn--ghost-danger btn ghost"
          :class="{ 'cv-btn--armed': cleanupArmed, armed: cleanupArmed }"
          :disabled="cleanupBusy"
          :title="
            record.work_on ? t('workspace.cleanupWorktreeHint') : t('workspace.cleanupBranchHint')
          "
          @click="doCleanup"
        >
          {{
            cleanupArmed
              ? t('workspace.cleanupConfirm')
              : record.work_on
                ? t('workspace.cleanupWorktree')
                : t('workspace.cleanupBranch')
          }}
        </button>
        <button v-if="canInterrupt" class="cv-btn cv-btn--danger btn danger" @click="doInterrupt">
          {{ t('workspace.interrupt') }}
        </button>
        <button
          v-if="resumeState === 'ready'"
          class="cv-btn cv-btn--resume btn"
          :disabled="resumeBusy"
          :title="t('workspace.resumeHint')"
          @click="doResume"
        >
          {{ t('workspace.resume') }}
        </button>
        <button
          v-if="record.status === 'review_ok'"
          class="cv-btn cv-btn--ship btn"
          @click="doShip"
        >
          {{ t('workspace.ship') }}
        </button>
      </span>

      <div class="cv-sub chips">
        <template v-if="projectKind === 'scratch'">
          <span v-if="attachments.length === 0" class="cv-chip">
            {{ t('workspace.noRepoAttached') }}
          </span>
          <template v-else>
            <span v-for="attachment in attachments" :key="attachment.project_id" class="cv-chip">
              {{ attachment.name }} · <span aria-hidden="true">{{ G.branch }}</span>
              {{ attachment.branch }}
            </span>
          </template>
          <!-- Still offered once some are attached: a scratch conversation can
               take more than one. -->
          <span v-if="repoProjects.length === 0" class="cv-chip">
            {{ t('workspace.attachRepoNone') }}
          </span>
          <template v-else-if="attachableProjects.length > 0">
            <select
              v-model="attachSelection"
              class="cv-attach-select"
              :disabled="attachBusy"
              :aria-label="t('workspace.attachRepoPlaceholder')"
            >
              <option value="" disabled>{{ t('workspace.attachRepoPlaceholder') }}</option>
              <option
                v-for="repoProject in attachableProjects"
                :key="repoProject.id"
                :value="repoProject.id"
              >
                {{ repoProject.name }}
              </option>
            </select>
            <button
              type="button"
              class="cv-attach-btn btn"
              :disabled="attachBusy || attachSelection === ''"
              @click="doAttach"
            >
              {{ attachBusy ? t('workspace.attaching') : t('workspace.attachRepo') }}
            </button>
          </template>
        </template>
        <span v-else class="cv-chip">
          {{ projectName }} · <span aria-hidden="true">{{ G.branch }}</span>
          {{ record.branch || record.base }}
        </span>
        <!-- Isolation: what contains this conversation's agent. The tooltip
             carries the guarantee, so the chip itself stays one word. -->
        <span
          class="cv-chip cv-iso"
          :class="`cv-iso--${isolation.isolation}`"
          :title="t(isolation.hintKey)"
        >
          <span aria-hidden="true">{{ isolation.glyph }}</span> {{ t(isolation.labelKey) }}
        </span>
        <span class="cv-phrase" :data-tone="visual.tone">{{ t(phraseKey) }}</span>
        <span class="cv-chrono">
          <span>{{ t('workspace.workTime', { t: work }) }}</span>
          <span v-if="wait" class="cv-wait">{{ t('workspace.waitTime', { t: wait }) }}</span>
        </span>
      </div>

      <p v-if="reasonDetail" class="cv-reason">{{ reasonDetail }}</p>
      <p v-if="shipNotice" class="cv-notice">{{ shipNotice }}</p>
      <!-- Interrupted, but with nothing to restart: say it instead of showing
           a Resume that could only fail. -->
      <p v-if="resumeState === 'reply'" class="cv-notice">{{ t('workspace.resumeNothing') }}</p>
      <p v-if="actionError" class="cv-error">{{ actionError }}</p>
    </div>

    <nav class="cv-tabs tabs" :aria-label="t('workspace.conversations')">
      <button
        class="cv-tab tab"
        :class="{ 'cv-tab--active': tab === 'conversation' }"
        type="button"
        @click="emit('pick-tab', 'conversation')"
      >
        {{ t('workspace.tabConversation') }}
      </button>
      <button
        class="cv-tab tab"
        :class="{ 'cv-tab--active': tab === 'diff' }"
        type="button"
        :disabled="!tabs[1]?.enabled"
        :title="tabs[1]?.enabled ? undefined : t('workspace.noBranchYet')"
        @click="emit('pick-tab', 'diff')"
      >
        {{ diffTabLabel }}
      </button>
      <button
        class="cv-tab tab"
        :class="[checksToneClass, { 'cv-tab--active': tab === 'checks' }]"
        type="button"
        @click="emit('pick-tab', 'checks')"
      >
        {{ checksTabText }}
      </button>
    </nav>
  </header>
</template>

<style scoped>
.cv-head {
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}

.cv-conv-h {
  border-bottom: 0;
}

.cv-title-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  min-width: 0;
}

.cv-warn {
  flex: none;
  color: var(--warn);
}

/* The dot is the kit `.status` bullet: the tone colours it, and `info`
   blinks — the machine is the only thing that moves. */
.cv-dot {
  flex: none;
}

.cv-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cv-actions {
  flex: none;
  align-items: baseline;
}

.cv-btn--resume {
  color: var(--warn);
  border-color: var(--warn);
}

.cv-btn--ship {
  color: var(--ok);
  border-color: var(--ok);
  font-weight: 700;
}

.cv-btn--ghost-danger:hover:not(:disabled) {
  border-color: var(--err);
  color: var(--err);
}

.cv-sub {
  align-items: baseline;
  font-size: 12px;
}

.cv-chip {
  padding: 0 1ch;
  border: 1px solid var(--line);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Attaching a repo is an ordinary action, not a state: no colour. */
.cv-attach-select {
  font: inherit;
  font-size: 12px;
  color: var(--fg-dim);
  background: var(--bg);
  border: 1px solid var(--line);
  padding: 0 1ch;
  max-width: 24ch;
}

.cv-attach-btn {
  font-size: 12px;
  color: var(--fg-dim);
  padding: 0 1ch;
}

.cv-iso {
  cursor: help;
}

.cv-iso--container {
  color: var(--ok);
  border-color: var(--ok);
}

.cv-iso--policy {
  color: var(--fg-dim);
}

.cv-phrase {
  color: var(--tone, var(--fg-dim));
}

.cv-phrase[data-tone='idle'] {
  color: var(--fg-dim);
}

.cv-chrono {
  display: flex;
  gap: 2ch;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
}

.cv-wait {
  color: var(--fg-dim);
}

.cv-notice {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--warn);
}

/* The refusal's technical annex: the phrase above already said it in the
   reader's language, so this one stays quiet and wraps rather than shouts. */
.cv-reason {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}

.cv-error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--err);
  overflow-wrap: anywhere;
}

.cv-tabs {
  padding: 0 1ch;
}

.cv-tab {
  font: inherit;
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.cv-tab:hover:not(:disabled) {
  color: var(--fg);
}

/* The active tab is the one chosen, not the one passing: accent, not green. */
.cv-tab--active {
  color: var(--fg);
  font-weight: 700;
  border-bottom-color: var(--accent);
}

.cv-tab:disabled {
  cursor: default;
  color: var(--fg-muted);
}

/* The Checks label IS the semaphore: its glyph and colour carry the state
   (defined after --active with doubled specificity so the tone wins). */
.cv-tab.cv-tab--checks-pass {
  color: var(--ok);
}

.cv-tab.cv-tab--checks-fail {
  color: var(--err);
}

.cv-tab.cv-tab--checks-run,
.cv-tab.cv-tab--checks-warn {
  color: var(--warn);
}
</style>

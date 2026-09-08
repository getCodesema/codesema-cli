<script setup lang="ts">
// One conversation of the focus zone: the orchestrator. It owns the tabs, the
// clocks, the reply state and the review archive, and hands each surface to
// its own component — ConversationHeader (title, offers, chips, tabs),
// ConversationThread (the journal and the live streams), ConversationComposer
// (the reply) and ConversationChecks (the sandboxed run). A task in flight is
// read-only: you answer questions or interrupt, and a reply typed during a run
// is parked and delivered on hand-over.
import { computed, ref, shallowRef, watch } from 'vue'
import { checksTabLabel, checksTone, type ChecksSetupState } from '../composables/useChecks'
import type { Finding } from '../composables/useDiff'
import { focusTabs, type FocusTab } from '../composables/useTaskBoard'
import { useConversationClocks, useReplyComposer } from '../composables/useTaskConversation'
import type { ApiResult, TaskState } from '../composables/useTasks'
import { t } from '../i18n'
import type { PreviewResult, Project, ReviewRecord } from '../types'
import PreviewPanel from './PreviewPanel.vue'
import ConversationChecks from './task-conversation/ConversationChecks.vue'
import ConversationComposer from './task-conversation/ConversationComposer.vue'
import ConversationHeader from './task-conversation/ConversationHeader.vue'
import ConversationThread from './task-conversation/ConversationThread.vue'

const props = defineProps<{
  state: TaskState
  /** Display name of the conversation's repo, for the header chip. */
  projectName: string
  /** 'scratch' swaps the header's project/branch chip for a no-repo notice:
   * that project has no branch, no worktree, nothing for the agent to read. */
  projectKind: Project['kind']
  /** Registered projects of kind 'repo', for the attach picker (scratch
   * conversations only). Never pre-filtered by what this conversation
   * already carries in `state.record.attachments`. */
  repoProjects: Project[]
  reply: (message: string) => Promise<ApiResult>
  /** POST …/attach: gives a scratch conversation one more repository. */
  attach: (repoProjectId: string) => Promise<ApiResult>
  interrupt: () => Promise<ApiResult>
  /** POST …/resume: restarts the turn an interrupted conversation died on. */
  resume: () => Promise<ApiResult>
  ship: () => Promise<ApiResult>
  abandon: () => Promise<ApiResult>
  /** POST …/checks: manual (re)run of the sandboxed checks. */
  runChecks: () => Promise<ApiResult>
  /** GET …/checks into state.checks (404 = never ran, state stays null). */
  loadChecks: () => Promise<void>
  /** Agent-assisted setup state of THIS conversation's project (shared by
   * every conversation of the repo); undefined until the first GET. */
  checksSetup: ChecksSetupState | undefined
  /** GET /api/projects/:id/checks-setup into that state. */
  loadChecksSetup: () => Promise<void>
  /** POST …/checks-setup: runs the user's agent read-only (a real LLM call). */
  runChecksSetup: () => Promise<ApiResult>
  /** POST …/checks-apply: writes the proposal into .codesema/config.json. */
  applyChecksProposal: () => Promise<ApiResult>
  /** Local dismissal of the proposal — writes nothing anywhere. */
  dismissChecksProposal: () => void
}>()

const emit = defineEmits<{ 'open-review': [record: ReviewRecord] }>()

const state = computed(() => props.state)
const record = computed(() => props.state.record)
const actionError = ref<string | null>(null)

// ── Tabs: Conversation / Diff · N / Checks ────────────────────────────────
const tab = ref<FocusTab>('conversation')
const tabs = computed(() => focusTabs(record.value.branch.length > 0))

// The PreviewPanel mounts once the conversation has a branch and stays
// mounted (v-show): its single fetch feeds both the Diff tab body and the
// tab's file count. New commits remount it so the count stays honest.
const diffCount = ref<number | null>(null)
const commitCount = computed(() => props.state.events.filter((e) => e.type === 'commit').length)
const previewKey = computed(() => `${record.value.branch}#${commitCount.value}`)
const diffTabLabel = computed(() =>
  diffCount.value === null
    ? t('workspace.tabDiff')
    : t('workspace.tabDiffCount', { n: diffCount.value }, diffCount.value),
)

function pickTab(next: FocusTab): void {
  if (tabs.value.find((entry) => entry.id === next)?.enabled) {
    tab.value = next
  }
}

// A branch can disappear under the open Diff tab (cleanup): fall back.
watch(
  () => record.value.branch,
  (branch) => {
    if (branch.length === 0) {
      tab.value = 'conversation'
      diffCount.value = null
    }
  },
)

// ── Checks tab: hydrated once, on its FIRST opening ───────────────────────
// The stream keeps it fresh afterwards, so re-opening never refetches. The
// project's setup state travels with the tab: a proposal produced in another
// conversation of the same repo shows up here too.
const checks = computed(() => props.state.checks)
let checksLoaded = false
watch(tab, (next) => {
  if (next === 'checks' && !checksLoaded) {
    checksLoaded = true
    void props.loadChecks()
    void props.loadChecksSetup()
  }
})

const { slowNow, runningElapsed } = useConversationClocks(record)

// ── Reply composer ────────────────────────────────────────────────────────
const composerRef = ref<InstanceType<typeof ConversationComposer> | null>(null)
const composer = useReplyComposer({
  state,
  reply: (message) => props.reply(message),
  onError: (message) => {
    actionError.value = message
  },
  onFocus: () => {
    tab.value = 'conversation'
    composerRef.value?.focus()
  },
})

// ── Review linkage: the archived review OF THIS TASK, per turn ────────────
// GET …/tasks/:id/review serves the task's own archive. Each review_done card
// passes the ref it carries, so an old turn opens ITS review even after later
// turns moved the task's review_ref on. Records are cached by ref.
const reviewCache = new Map<string, ReviewRecord>()

async function fetchReview(archiveRef: string | null): Promise<ReviewRecord | null> {
  // Keyed by the archive actually served: a bare fetch caches under the task's
  // current review_ref, so the next turn's review would be a cache MISS.
  const key = archiveRef ?? record.value.review_ref ?? ''
  const cached = reviewCache.get(key)
  if (cached) {
    return cached
  }
  const query = new URLSearchParams({ project: props.state.projectId })
  if (archiveRef) {
    query.set('ref', archiveRef)
  }
  try {
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(record.value.id)}/review?${query.toString()}`,
    )
    if (res.status !== 200) {
      return null
    }
    const review = (await res.json()) as ReviewRecord
    reviewCache.set(key, review)
    return review
  } catch {
    // Local server stopped: the card simply keeps its degraded form.
    return null
  }
}

async function openReview(archiveRef: string | null): Promise<void> {
  actionError.value = null
  const review = await fetchReview(archiveRef)
  if (review) {
    emit('open-review', review)
  } else {
    // The archive is gone (pruned by the retention bound) or unreadable: say
    // so instead of leaving a dead button.
    actionError.value = t('workspace.reviewUnavailable')
  }
}

// ── Diff annotations: the notes of the task's latest review ───────────────
// Nothing is fetched until the Diff tab opens on a task that has a review.
// Findings carry their index as id, exactly like the review view.
const reviewFindings = shallowRef<Finding[]>([])
/** review_ref the annotations were loaded for; re-synced when a turn moves it. */
let annotatedRef: string | null | undefined

async function syncDiffFindings(): Promise<void> {
  const current = record.value.review_ref
  if (tab.value !== 'diff' || current === annotatedRef) {
    return
  }
  annotatedRef = current
  if (current === null) {
    reviewFindings.value = []
    return
  }
  const review = await fetchReview(null)
  reviewFindings.value = (review?.review.findings ?? []).map((finding, i) => ({
    ...finding,
    id: i,
  }))
}

watch([tab, () => record.value.review_ref], () => void syncDiffFindings())

function onPreviewLoaded(preview: PreviewResult): void {
  diffCount.value = preview.diffStats.files
}
</script>

<template>
  <div class="cv-root conv">
    <ConversationHeader
      :state="state"
      :project-name="projectName"
      :project-kind="projectKind"
      :repo-projects="repoProjects"
      :attach="attach"
      :interrupt="interrupt"
      :resume="resume"
      :ship="ship"
      :tab="tab"
      :tabs="tabs"
      :diff-tab-label="diffTabLabel"
      :checks-tab-text="checksTabLabel(checks)"
      :checks-tone-class="`cv-tab--checks-${checksTone(checks)}`"
      :action-error="actionError"
      @pick-tab="pickTab"
      @error="(message: string | null) => (actionError = message)"
    />

    <!-- Conversation tab: the thread scrolls, the composer stays pinned. -->
    <div v-show="tab === 'conversation'" class="cv-body">
      <ConversationThread
        :state="state"
        :slow-now="slowNow"
        :running-elapsed="runningElapsed"
        :quick-replies="composer.quickReplies.value"
        :reply-busy="composer.busy.value"
        :abandon="abandon"
        @open-review="openReview"
        @error="(message: string | null) => (actionError = message)"
        @fix="composer.prefillFix"
        @pick="composer.sendQuickReply"
        @other="composer.prefillFix"
      />
      <ConversationComposer
        ref="composerRef"
        :draft="composer.draft.value"
        :mode="composer.mode.value"
        :placeholder="composer.placeholder.value"
        :busy="composer.busy.value"
        :question-active="composer.questionActive.value"
        :pending="composer.pending.value"
        @update:draft="(value: string) => (composer.draft.value = value)"
        @send="composer.send"
        @cancel-pending="composer.cancelPending"
      />
    </div>

    <!-- Diff tab: the scoped PreviewPanel; mounted once a branch exists so
         its single fetch also labels the tab with the real file count. -->
    <div v-if="record.branch" v-show="tab === 'diff'" class="cv-diff">
      <PreviewPanel
        :key="previewKey"
        :source="{ kind: 'branch', name: record.branch }"
        :project="state.projectId"
        :findings="reviewFindings"
        @loaded="onPreviewLoaded"
      />
    </div>

    <ConversationChecks
      v-show="tab === 'checks'"
      :checks="checks"
      :commit-count="commitCount"
      :checks-setup="checksSetup"
      :slow-now="slowNow"
      :run-checks="runChecks"
      :run-checks-setup="runChecksSetup"
      :apply-checks-proposal="applyChecksProposal"
      :dismiss-checks-proposal="dismissChecksProposal"
    />
  </div>
</template>

<style scoped>
.cv-root {
  min-width: 0;
  flex: 1;
  min-height: 0;
  border: 0;
  background: var(--bg);
}

.cv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.cv-diff {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--row) 2ch;
}
</style>

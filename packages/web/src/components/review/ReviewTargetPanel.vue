<script setup lang="ts">
// The stage of the Code review category: what a merge request or a branch
// looks like when it is picked as a review target. The launch controls and
// the archived reviews are this component's own; everything below them is
// mounted as-is — ForgeDetailPanel for a merge request (body, labels,
// reviewers, checks), PreviewPanel for a branch (commits, files, per-file
// diff, computed by git alone).
import { GitBranch, Loader, Play } from '@lucide/vue'
import { computed } from 'vue'
import { sameReviewSource } from '../../composables/useWorkspaceNav'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type {
  ForgeMr,
  MrReviewMode,
  MrReviewStatus,
  ReviewArchiveSummary,
  ReviewSource,
} from '../../types'
import ForgeDetailPanel from '../forge/ForgeDetailPanel.vue'
import PreviewPanel from '../PreviewPanel.vue'

/** One discriminated prop rather than a `source` + nullable `mr` + name
 * trio: those three had to agree, nothing enforced it, and the header read
 * `source.kind` while the body read whether `mr` was null — two answers to
 * the same question, free to disagree. */
export type ReviewTarget = { kind: 'mr'; mr: ForgeMr } | { kind: 'branch'; name: string }

const props = defineProps<{
  projectId: string
  projectName: string
  target: ReviewTarget
  /** Null while the archives have not been read yet, never an empty array
   * standing in for "none": the two say different things. */
  history: ReviewArchiveSummary[] | null
  historyError: string | null
  /** The runner is process-wide: a run on ANY target disables the buttons here. */
  runStatus: MrReviewStatus | null
  starting: boolean
  startError: string | null
}>()

const emit = defineEmits<{
  run: [mode: MrReviewMode]
  'open-archive': [ref: string]
  'open-running': []
  close: []
}>()

const source = computed<ReviewSource>(() =>
  props.target.kind === 'mr'
    ? { kind: 'mr', number: props.target.mr.number }
    : { kind: 'branch', name: props.target.name },
)

const running = computed(() =>
  props.runStatus?.available === true && props.runStatus.phase === 'running'
    ? props.runStatus
    : null,
)

const runningHere = computed(
  () =>
    running.value !== null &&
    running.value.project_id === props.projectId &&
    sameReviewSource(running.value.source, source.value),
)

const modeLabel = (mode: MrReviewMode): string =>
  mode === 'dual' ? t('codeReview.modeDual') : t('codeReview.modeSimple')

/** A Record over the union rather than an interpolated key: `t` takes a bare
 * string, so a fourth verdict would render its own key on screen instead of
 * failing to compile. */
const VERDICT_KEYS: Record<ReviewArchiveSummary['verdict'], MessageKey> = {
  approve: 'verdict.approve',
  request_changes: 'verdict.request_changes',
  comment: 'verdict.comment',
}
</script>

<template>
  <section class="rtp-root">
    <header class="rtp-head">
      <span class="rtp-project">{{ projectName }}</span>
      <h1 class="rtp-title">
        <GitBranch v-if="target.kind === 'branch'" class="rtp-glyph" aria-hidden="true" />
        <span v-else class="rtp-number">#{{ target.mr.number }}</span>
        {{ target.kind === 'mr' ? target.mr.title : target.name }}
      </h1>
      <p v-if="target.kind === 'branch'" class="rtp-hint">
        {{ t('codeReview.branchTargetHint') }}
      </p>

      <div class="rtp-actions">
        <template v-if="runningHere">
          <button class="rtp-run rtp-run--live" type="button" @click="emit('open-running')">
            <Loader class="rtp-spin" aria-hidden="true" />
            {{ t('codeReview.running') }}
          </button>
        </template>
        <template v-else-if="running">
          <button class="rtp-run" type="button" @click="emit('open-running')">
            {{ t('codeReview.busyElsewhere') }}
          </button>
        </template>
        <template v-else>
          <button class="rtp-run" type="button" :disabled="starting" @click="emit('run', 'simple')">
            <Play class="rtp-glyph" aria-hidden="true" />
            {{ t('codeReview.runSimple') }}
          </button>
          <button class="rtp-run" type="button" :disabled="starting" @click="emit('run', 'dual')">
            {{ t('codeReview.runDual') }}
          </button>
        </template>
      </div>
      <p v-if="startError" class="rtp-error" role="alert">{{ startError }}</p>
    </header>

    <section class="rtp-history">
      <h2 class="rtp-history-title">{{ t('codeReview.historyTitle') }}</h2>
      <p v-if="historyError" class="rtp-error" role="alert">{{ t('codeReview.historyError') }}</p>
      <p v-else-if="history === null" class="rtp-muted">{{ t('codeReview.historyLoading') }}</p>
      <p v-else-if="history.length === 0" class="rtp-muted">{{ t('codeReview.historyEmpty') }}</p>
      <ul v-else class="rtp-archives">
        <li v-for="entry in history" :key="entry.ref">
          <button class="rtp-archive" type="button" @click="emit('open-archive', entry.ref)">
            <span class="rtp-verdict" :class="`rtp-verdict--${entry.verdict}`">
              {{ t(VERDICT_KEYS[entry.verdict]) }}
            </span>
            <span class="rtp-archive-age">{{ formatRelativeAge(entry.created_at) }}</span>
            <span class="rtp-archive-mode">{{ modeLabel(entry.mode) }}</span>
            <span class="rtp-archive-findings">
              {{ t('workspace.findingsCount', { n: entry.findings_total }, entry.findings_total) }}
            </span>
          </button>
        </li>
      </ul>
    </section>

    <div class="rtp-body">
      <ForgeDetailPanel
        v-if="target.kind === 'mr'"
        :item="{ kind: 'mr', mr: target.mr }"
        @close="emit('close')"
      />
      <PreviewPanel v-else :source="source" :project="projectId" />
    </div>
  </section>
</template>

<style scoped>
.rtp-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--cs-panel);
}

.rtp-head {
  flex: none;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--cs-line);
}

.rtp-project {
  font-size: 11px;
  color: var(--cs-muted);
}

.rtp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--cs-text);
}

.rtp-glyph {
  flex: none;
  width: 14px;
  height: 14px;
}

.rtp-number {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--cs-muted);
}

.rtp-hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--cs-muted);
}

.rtp-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.rtp-run {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--cs-line-3);
  border-radius: 6px;
  background: var(--cs-surface);
  color: var(--cs-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.rtp-run:hover:not(:disabled) {
  background: var(--cs-hover);
}

.rtp-run:disabled {
  opacity: 0.55;
  cursor: default;
}

.rtp-run:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: 1px;
}

/* Amber, not the strong attention amber: an agent is at work and nothing is
   asked of the human. */
.rtp-run--live {
  border-color: var(--cs-amber-line);
  color: var(--cs-amber-text);
}

.rtp-spin {
  width: 13px;
  height: 13px;
  animation: rtp-spin 1.2s linear infinite;
}

@keyframes rtp-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .rtp-spin {
    animation: none;
  }
}

.rtp-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--cs-red-text);
}

.rtp-history {
  flex: none;
  padding: 12px 16px;
  border-bottom: 1px solid var(--cs-line);
}

.rtp-history-title {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cs-muted);
}

.rtp-muted {
  margin: 0;
  font-size: 12px;
  color: var(--cs-muted);
}

.rtp-archives {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rtp-archive {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--cs-text-2);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.rtp-archive:hover {
  background: var(--cs-hover);
}

.rtp-archive:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: -2px;
}

.rtp-verdict {
  flex: none;
  min-width: 128px;
  font-weight: 600;
}

.rtp-verdict--approve {
  color: var(--cs-green-text);
}

.rtp-verdict--request_changes {
  color: var(--cs-red-text);
}

.rtp-verdict--comment {
  color: var(--cs-text-2);
}

.rtp-archive-age,
.rtp-archive-mode,
.rtp-archive-findings {
  color: var(--cs-muted);
}

.rtp-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
</style>

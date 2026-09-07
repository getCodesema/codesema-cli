<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { G } from '../glyphs'
import { t } from '../i18n'
import type { JudgeLive, LiveStatus, PartialReview } from '../types'
import DualConsensusMap from './DualConsensusMap.vue'
import DualJudgePanel from './DualJudgePanel.vue'
import DualLaneCard from './DualLaneCard.vue'

const props = defineProps<{
  status: LiveStatus
  partial: PartialReview | null
  partialB: PartialReview | null
  judge: JudgeLive | null
}>()

const isDual = computed(() => props.status.mode === 'dual')

const headerTitle = computed(() => {
  if (props.status.phase === 'error') {
    return t('live.errorTitle')
  }
  if (isDual.value && props.status.phase === 'judging') {
    return t('live.judgeTitle')
  }
  return t('live.title')
})

const now = ref(Date.now())
const ticker = setInterval(() => {
  now.value = Date.now()
}, 1000)
onUnmounted(() => clearInterval(ticker))

const elapsed = computed(() => {
  const secs = Math.max(0, Math.floor((now.value - Date.parse(props.status.started_at)) / 1000))
  const mm = String(Math.floor(secs / 60)).padStart(2, '0')
  const ss = String(secs % 60).padStart(2, '0')
  return `${mm}:${ss}`
})

const WAIT_PHASES = [
  'reading the diff…',
  'following the call chains…',
  'grouping changes into steps…',
  'weighing the risks…',
  'writing the story…',
  'collecting praise…',
  'sharpening the findings…',
]

const phase = computed(() => {
  const secs = Math.max(0, Math.floor((now.value - Date.parse(props.status.started_at)) / 1000))
  return WAIT_PHASES[Math.floor(secs / 7) % WAIT_PHASES.length]
})

const input = computed(() => props.status.input)
const hasPartialContent = computed(
  () =>
    !!props.partial &&
    (props.partial.findings.length > 0 ||
      !!props.partial.summary ||
      !!props.partial.verdict ||
      props.partial.stepTitles.length > 0),
)

const FILE_PREVIEW_MAX = 12
const previewFiles = computed(() => input.value?.files.slice(0, FILE_PREVIEW_MAX) ?? [])

function fileLabel(file: { path: string; previousPath?: string }): string {
  return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
}
const hiddenFilesCount = computed(() =>
  Math.max(0, (input.value?.files.length ?? 0) - FILE_PREVIEW_MAX),
)

type VerdictTone = 'go' | 'check' | 'stop'

const VERDICT_META: Record<string, { labelKey: string; v: VerdictTone }> = {
  approve: { labelKey: 'verdict.approve', v: 'go' },
  request_changes: { labelKey: 'verdict.request_changes', v: 'stop' },
  comment: { labelKey: 'verdict.comment', v: 'check' },
}
</script>

<template>
  <div class="live-root">
    <header class="live-head">
      <div class="live-head-row">
        <span v-if="status.phase !== 'error'" class="live-pulse status" data-s="running" />
        <h1 class="live-title">{{ headerTitle }}</h1>
        <span class="live-elapsed">{{ elapsed }}</span>
      </div>
      <p v-if="input" class="live-branch">
        <span class="live-branch-name">{{ input.branch }}</span>
        <span class="live-branch-arrow">→</span>
        <span class="live-branch-name">{{ input.target }}</span>
      </p>
      <p v-if="status.agent" class="live-agent">{{ status.agent }}</p>
    </header>

    <div v-if="status.phase === 'error'" class="live-error live err">
      {{ status.error }}
    </div>

    <section v-if="input" class="live-stats">
      <span class="live-chip">{{ $t('live.filesChanged', { n: input.files.length }) }}</span>
      <span class="live-chip"
        ><span class="live-add">+{{ input.additions }}</span>
        <span class="live-del">−{{ input.deletions }}</span></span
      >
      <span class="live-chip">{{ $t('live.commits', { n: input.commits.length }) }}</span>
      <span v-if="input.incremental" class="live-chip live-chip--accent">{{
        $t('live.incremental')
      }}</span>
    </section>

    <template v-if="isDual">
      <section
        class="live-dual-lanes"
        :class="{ 'live-dual-lanes--dim': status.phase === 'judging' }"
      >
        <DualLaneCard kind="reviewer" :partial="partial" :judging="status.phase === 'judging'" />
        <DualLaneCard kind="prosecutor" :partial="partialB" :judging="status.phase === 'judging'" />
      </section>

      <DualConsensusMap
        v-if="status.phase !== 'judging' && input"
        :files="input.files"
        :partial-a="partial"
        :partial-b="partialB"
      />

      <DualJudgePanel v-if="status.phase === 'judging'" :judge="judge" />
    </template>

    <template v-else>
      <template v-if="hasPartialContent && partial">
        <section
          v-if="partial.verdict || partial.summary || partial.intent"
          class="live-panel panel"
        >
          <div class="live-panel-tag">
            {{ $t('live.summary') }}
            <span
              v-if="partial.verdict"
              class="live-verdict verdict"
              :data-v="VERDICT_META[partial.verdict]?.v"
            >
              {{ $t(VERDICT_META[partial.verdict]?.labelKey ?? 'verdict.comment') }}
            </span>
          </div>
          <p v-if="partial.summary || partial.intent" class="live-summary">
            {{ partial.summary ?? partial.intent
            }}<span v-if="status.phase !== 'error'" class="live-caret" aria-hidden="true">{{
              G.cursor
            }}</span>
          </p>
        </section>

        <section v-if="partial.findings.length" class="live-panel panel">
          <div class="live-panel-tag">
            {{ $t('live.findings') }}
            <span class="live-count">{{ partial.findings.length }}</span>
          </div>
          <div class="live-findings">
            <div
              v-for="(finding, i) in partial.findings"
              :key="`${finding.file}:${finding.line ?? i}:${finding.title ?? ''}`"
              class="live-finding"
            >
              <span class="live-finding-dot sev" :data-v="finding.severity" aria-hidden="true">{{
                G.dot
              }}</span>
              <div class="live-finding-body">
                <span class="live-finding-title">{{ finding.title ?? finding.message }}</span>
                <span class="live-finding-file"
                  >{{ finding.file
                  }}<template v-if="finding.line">:{{ finding.line }}</template></span
                >
              </div>
            </div>
          </div>
        </section>

        <section v-if="partial.stepTitles.length" class="live-panel panel">
          <div class="live-panel-tag">{{ $t('live.steps') }}</div>
          <div class="live-steps">
            <span v-for="(title, i) in partial.stepTitles" :key="i" class="live-step-pill">
              <span class="live-step-index">{{ i + 1 }}</span
              >{{ title }}
            </span>
          </div>
        </section>
      </template>

      <section v-else-if="input" class="live-panel panel">
        <div class="live-panel-tag">{{ $t('app.tabFiles') }}</div>
        <div class="live-files">
          <div v-for="file in previewFiles" :key="file.path" class="live-file">
            <span class="live-file-path" :title="fileLabel(file)">{{ fileLabel(file) }}</span>
            <span class="live-file-delta"
              ><span class="live-add">+{{ file.additions }}</span>
              <span class="live-del">−{{ file.deletions }}</span></span
            >
          </div>
          <p v-if="hiddenFilesCount" class="live-file-more">
            {{ $t('live.moreFiles', { n: hiddenFilesCount }) }}
          </p>
        </div>
      </section>

      <p v-if="status.phase === 'reviewing'" class="live-waiting review-live">
        <span class="live-waiting-label status" data-s="running">
          {{ hasPartialContent ? $t('live.streaming') : $t('live.reading') }}
        </span>
        <span class="live-phase">{{ phase }}</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.live-root {
  max-width: 100ch;
  margin: 0 auto;
  padding: var(--row) 2ch;
  display: flex;
  flex-direction: column;
  gap: var(--row);
}

.live-head {
  display: flex;
  flex-direction: column;
}

.live-head-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.live-title {
  font-size: 18px;
}

.live-elapsed {
  margin-left: auto;
  color: var(--fg-dim);
}

.live-branch {
  color: var(--fg-dim);
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.live-agent {
  font-size: 12px;
  color: var(--fg-dim);
}

.live-error {
  overflow-wrap: anywhere;
}

.live-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 1ch;
}

.live-chip {
  color: var(--fg-dim);
  border: 1px solid var(--line);
  background: var(--bg-raised);
  padding: 0 1ch;
}

.live-chip--accent {
  color: var(--accent);
  border-color: var(--accent);
}

.live-add {
  color: var(--ok);
}

.live-del {
  color: var(--err);
}

.live-panel-tag {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.live-count {
  color: var(--accent);
}

.live-verdict {
  font-size: 12px;
  text-transform: none;
  letter-spacing: normal;
}

.live-summary {
  white-space: pre-wrap;
}

.live-caret {
  color: var(--accent);
  animation: blink 1s steps(2) infinite;
}

.live-findings {
  display: flex;
  flex-direction: column;
}

.live-finding {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.live-finding-dot {
  flex: none;
}

.live-finding-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.live-finding-file {
  font-size: 12px;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}

.live-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 1ch;
}

.live-step-pill {
  color: var(--fg-dim);
  border: 1px solid var(--line);
  padding: 0 1ch;
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
}

.live-step-index {
  font-size: 12px;
  color: var(--accent);
}

.live-files {
  display: flex;
  flex-direction: column;
}

.live-file {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 2ch;
}

.live-file-path {
  font-size: 12px;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}

.live-file-delta {
  font-size: 12px;
  flex: none;
}

.live-file-more {
  font-size: 12px;
  color: var(--fg-dim);
}

.live-waiting {
  align-items: baseline;
}

.live-phase {
  color: var(--fg-dim);
}

.live-dual-lanes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2ch;
}

@media (max-width: 800px) {
  .live-dual-lanes {
    grid-template-columns: 1fr;
  }
}
</style>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
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
const hiddenFilesCount = computed(() =>
  Math.max(0, (input.value?.files.length ?? 0) - FILE_PREVIEW_MAX),
)

const VERDICT_META: Record<string, { labelKey: string; cls: string }> = {
  approve: { labelKey: 'verdict.approve', cls: 'live-verdict--approve' },
  request_changes: { labelKey: 'verdict.request_changes', cls: 'live-verdict--changes' },
  comment: { labelKey: 'verdict.comment', cls: 'live-verdict--comment' },
}

const SEVERITY_DOT: Record<string, string> = {
  critical: 'var(--codesema-risk-high)',
  major: 'var(--codesema-accent)',
  minor: 'var(--codesema-risk-med)',
  info: 'var(--codesema-risk-low)',
}

function severityDot(severity?: string): string {
  return SEVERITY_DOT[severity ?? ''] ?? 'var(--codesema-ink-3)'
}
</script>

<template>
  <div class="live-root">
    <header class="live-head">
      <div class="live-head-row">
        <span v-if="status.phase !== 'error'" class="live-pulse" aria-hidden="true" />
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

    <div v-if="status.phase === 'error'" class="live-error">
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
        <section v-if="partial.verdict || partial.summary || partial.intent" class="live-panel">
          <div class="live-panel-tag">
            {{ $t('live.summary') }}
            <span
              v-if="partial.verdict"
              class="live-verdict"
              :class="VERDICT_META[partial.verdict]?.cls"
            >
              {{ $t(VERDICT_META[partial.verdict]?.labelKey ?? 'verdict.comment') }}
            </span>
          </div>
          <p v-if="partial.summary || partial.intent" class="live-summary">
            {{ partial.summary ?? partial.intent
            }}<span v-if="status.phase !== 'error'" class="live-caret" aria-hidden="true" />
          </p>
        </section>

        <section v-if="partial.findings.length" class="live-panel">
          <div class="live-panel-tag">
            {{ $t('live.findings') }}
            <span class="live-count">{{ partial.findings.length }}</span>
          </div>
          <TransitionGroup name="live-fade" tag="div" class="live-findings">
            <div
              v-for="(finding, i) in partial.findings"
              :key="`${finding.file}:${finding.line ?? i}:${finding.title ?? ''}`"
              class="live-finding"
            >
              <span
                class="live-finding-dot"
                :style="{ background: severityDot(finding.severity) }"
              />
              <div class="live-finding-body">
                <span class="live-finding-title">{{ finding.title ?? finding.message }}</span>
                <span class="live-finding-file"
                  >{{ finding.file
                  }}<template v-if="finding.line">:{{ finding.line }}</template></span
                >
              </div>
            </div>
          </TransitionGroup>
        </section>

        <section v-if="partial.stepTitles.length" class="live-panel">
          <div class="live-panel-tag">{{ $t('live.steps') }}</div>
          <div class="live-steps">
            <span v-for="(title, i) in partial.stepTitles" :key="i" class="live-step-pill">
              <span class="live-step-index">{{ i + 1 }}</span
              >{{ title }}
            </span>
          </div>
        </section>
      </template>

      <section v-else-if="input" class="live-panel">
        <div class="live-panel-tag">{{ $t('app.tabFiles') }}</div>
        <div class="live-files">
          <div v-for="file in previewFiles" :key="file.path" class="live-file">
            <span class="live-file-path">{{ file.path }}</span>
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

      <p v-if="status.phase === 'reviewing'" class="live-waiting">
        <span class="app-spinner live-spinner" aria-hidden="true" />
        {{ hasPartialContent ? $t('live.streaming') : $t('live.reading') }}
        <span class="live-phase">{{ phase }}</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.live-root {
  max-width: 760px;
  margin: 0 auto;
  padding: 48px 24px 80px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.live-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.live-head-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.live-pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--codesema-amber);
  animation: live-pulse 1.4s ease-in-out infinite;
}

@keyframes live-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(247, 144, 9, 0.55);
  }
  50% {
    box-shadow: 0 0 0 7px rgba(247, 144, 9, 0);
  }
}

.live-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
  font-family: var(--font-display);
}

.live-elapsed {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--codesema-ink-3);
  font-variant-numeric: tabular-nums;
}

.live-branch {
  margin: 0;
  font-size: 14px;
  color: var(--codesema-ink-2);
  display: flex;
  align-items: center;
  gap: 8px;
}

.live-branch-name {
  font-family: var(--font-mono);
  font-size: 13px;
}

.live-branch-arrow {
  color: var(--codesema-ink-3);
}

.live-agent {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--codesema-ink-3);
}

.live-error {
  border: 1px solid var(--codesema-risk-high);
  background: var(--codesema-risk-high-soft);
  color: var(--codesema-ink);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13.5px;
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.live-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.live-chip {
  font-size: 12.5px;
  color: var(--codesema-ink-2);
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  border-radius: 999px;
  padding: 4px 12px;
}

.live-chip--accent {
  color: var(--codesema-accent);
  border-color: var(--codesema-accent);
  background: var(--codesema-accent-soft);
}

.live-add {
  color: var(--codesema-risk-low);
}

.live-del {
  color: var(--codesema-risk-high);
}

.live-panel {
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  border-radius: 12px;
  padding: 14px 16px;
}

.live-panel-tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--codesema-ink-3);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.live-count {
  font-family: var(--font-mono);
  color: var(--codesema-accent);
}

.live-verdict {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 10px;
  border: 1px solid var(--codesema-line);
  text-transform: none;
  letter-spacing: normal;
}

.live-verdict--approve {
  color: var(--codesema-risk-low);
  border-color: var(--codesema-risk-low);
  background: var(--codesema-risk-low-soft);
}

.live-verdict--changes {
  color: var(--codesema-risk-high);
  border-color: var(--codesema-risk-high);
  background: var(--codesema-risk-high-soft);
}

.live-verdict--comment {
  color: var(--codesema-risk-med);
  border-color: var(--codesema-risk-med);
  background: var(--codesema-risk-med-soft);
}

.live-summary {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--codesema-ink);
  white-space: pre-wrap;
}

.live-caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 3px;
  vertical-align: text-bottom;
  background: var(--codesema-accent);
  animation: live-caret 0.9s steps(2) infinite;
}

@keyframes live-caret {
  50% {
    opacity: 0;
  }
}

.live-findings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.live-finding {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.live-finding-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  transform: translateY(-1px);
}

.live-finding-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.live-finding-title {
  font-size: 13.5px;
  color: var(--codesema-ink);
  line-height: 1.45;
}

.live-finding-file {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--codesema-ink-3);
  overflow-wrap: anywhere;
}

.live-fade-enter-active {
  transition:
    opacity 0.35s ease,
    transform 0.35s ease;
}

.live-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.live-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.live-step-pill {
  font-size: 12.5px;
  color: var(--codesema-ink-2);
  border: 1px solid var(--codesema-line);
  border-radius: 999px;
  padding: 4px 12px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.live-step-index {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--codesema-accent);
}

.live-files {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.live-file {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.live-file-path {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--codesema-ink-2);
  overflow-wrap: anywhere;
}

.live-file-delta {
  font-family: var(--font-mono);
  font-size: 11.5px;
  flex: none;
}

.live-file-more {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--codesema-ink-3);
}

.live-waiting {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--codesema-ink-3);
}

.live-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--codesema-line);
  border-top-color: var(--codesema-accent);
  animation: live-spin 0.8s linear infinite;
}

@keyframes live-spin {
  to {
    transform: rotate(360deg);
  }
}

.live-phase {
  color: var(--codesema-ink-2);
  font-style: italic;
}

.live-dual-lanes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.live-dual-lanes--dim {
  gap: 10px;
}

@media (max-width: 800px) {
  .live-dual-lanes {
    grid-template-columns: 1fr;
  }
}
</style>

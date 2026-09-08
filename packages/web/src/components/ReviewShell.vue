<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { collapsedByBudget, parseDiff, sameFile, type Finding } from '../composables/useDiff'
import { buildFixPrompt, isActionable } from '../composables/useFixPrompt'
import { actionableFindings } from '../composables/useFocusList'
import { buildNoteTour } from '../composables/useNoteTour'
import { useReviewProgress } from '../composables/useReviewProgress'
import { G } from '../glyphs'
import type { ReviewRecord } from '../types'
import DiffView from './DiffView.vue'
import FileTree from './FileTree.vue'
import ReviewFocusMode from './ReviewFocusMode.vue'
import ReviewPrologue from './ReviewPrologue.vue'
import StepList from './StepList.vue'
import StepRail from './StepRail.vue'
import StepReview from './StepReview.vue'

const props = defineProps<{
  record: ReviewRecord
}>()

const isClient = typeof window !== 'undefined'

const meta = computed(() => props.record.meta)
// Findings get their global index as id so note anchors survive per-step re-parsing.
const findings = computed<Finding[]>(() =>
  props.record.review.findings.map((f, i) => ({ ...f, id: i })),
)
const narrative = computed(() => props.record.review.narrative)
// check: null (contract) normalized to undefined (expected by the child components)
const steps = computed(() =>
  (narrative.value?.steps ?? []).map((ch) => ({ ...ch, check: ch.check ?? undefined })),
)
const hasSteps = computed(() => steps.value.length > 0)
const reviewFirst = computed(() => narrative.value?.review_first ?? [])

const parsedDiff = computed(() => parseDiff(props.record.diff, findings.value))
const unmatched = computed(() => parsedDiff.value.unmatched)
const filesCount = computed(() => parsedDiff.value.files.length)

const globalDelta = computed(() => {
  let add = 0
  let del = 0
  for (const f of parsedDiff.value.files) {
    add += f.addCount
    del += f.delCount
  }
  return { add, del }
})

type VerdictTone = 'go' | 'check' | 'stop'

const VERDICT_META_COMMENT = { labelKey: 'verdict.comment', v: 'check' as VerdictTone }
const VERDICT_META: Record<string, { labelKey: string; v: VerdictTone }> = {
  approve: { labelKey: 'verdict.approve', v: 'go' },
  request_changes: { labelKey: 'verdict.request_changes', v: 'stop' },
  comment: VERDICT_META_COMMENT,
}

const verdictMeta = computed(
  () => VERDICT_META[props.record.review.verdict] ?? VERDICT_META_COMMENT,
)

const actionableCount = computed(() => findings.value.filter(isActionable).length)
const focusList = computed(() => actionableFindings(findings.value))

const viewMode = ref<'explain' | 'focus'>('explain')

function setViewMode(mode: 'explain' | 'focus') {
  viewMode.value = mode
  syncHash()
}

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyFixPrompt() {
  try {
    await navigator.clipboard.writeText(buildFixPrompt(props.record))
    copied.value = true
    if (copiedTimer) {
      clearTimeout(copiedTimer)
    }
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // clipboard unavailable: no feedback
  }
}

onUnmounted(() => clearTimeout(copiedTimer))

const progressKey = `${props.record.meta.branch}:${props.record.meta.created_at}`
const { readSet, checkedSet, toggleRead, toggleChecked, markRead } = useReviewProgress(progressKey)

const activeTab = ref<'steps' | 'files'>('steps')

function selectStepsTab() {
  activeTab.value = 'steps'
  syncHash()
}
function selectFilesTab() {
  activeTab.value = 'files'
  guidedIndex.value = null
  syncHash()
}

const guidedIndex = ref<number | null>(null)
const isGuidedMode = computed(() => guidedIndex.value !== null)

function onStepSelect(index: number) {
  guidedIndex.value = index
  realignTour(index)
  syncHash()
}
function onGuidedBack() {
  guidedIndex.value = null
  tourIndex.value = null
  syncHash()
}
function onGuidedNavigate(index: number) {
  guidedIndex.value = index
  realignTour(index)
  syncHash()
}

// ── Guided note tour ────────────────────────────────────────────
const tour = computed(() => buildNoteTour(steps.value, findings.value.length))
const tourIndex = ref<number | null>(null)
const reveal = ref<{ id: number; nonce: number } | null>(null)
let revealNonce = 0

const tourStop = computed(() =>
  tourIndex.value === null ? null : (tour.value[tourIndex.value] ?? null),
)
const tourHasPrev = computed(() => tourIndex.value !== null && tourIndex.value > 0)
const tourHasNext = computed(
  () => tourIndex.value !== null && tourIndex.value < tour.value.length - 1,
)

async function applyTourStop(index: number) {
  const stop = tour.value[index]
  if (!stop) {
    return
  }
  const previous = tourStop.value
  if (previous && stop.stepIndex > previous.stepIndex) {
    markRead(previous.stepIndex)
  }
  tourIndex.value = index
  if (guidedIndex.value !== stop.stepIndex) {
    guidedIndex.value = stop.stepIndex
    syncHash()
  }
  await nextTick()
  if (stop.findingId === null) {
    if (isClient) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    return
  }
  reveal.value = { id: stop.findingId, nonce: ++revealNonce }
}

function startTour() {
  void applyTourStop(0)
}

function tourNext() {
  if (tourIndex.value === null) {
    return
  }
  if (tourHasNext.value) {
    void applyTourStop(tourIndex.value + 1)
    return
  }
  finishTour()
}

function tourPrev() {
  if (tourIndex.value !== null && tourHasPrev.value) {
    void applyTourStop(tourIndex.value - 1)
  }
}

function finishTour() {
  const stop = tourStop.value
  if (stop) {
    markRead(stop.stepIndex)
  }
  tourIndex.value = null
  guidedIndex.value = null
  syncHash()
}

/** Manual step navigation during a tour: snap the tour onto the chosen step. */
function realignTour(stepIndex: number) {
  if (tourIndex.value === null) {
    return
  }
  const at = tour.value.findIndex((s) => s.stepIndex === stepIndex && s.findingId === null)
  tourIndex.value = at >= 0 ? at : null
}

function syncHash() {
  if (!isClient) {
    return
  }
  const hash =
    viewMode.value === 'focus'
      ? '#focus'
      : activeTab.value === 'files'
        ? '#files'
        : guidedIndex.value !== null
          ? `#step-${guidedIndex.value}`
          : ''
  history.replaceState(null, '', hash || location.pathname)
}

if (isClient) {
  const m = /^#step-(\d+)$/.exec(location.hash)
  if (location.hash === '#focus') {
    viewMode.value = 'focus'
  } else if (location.hash === '#files') {
    activeTab.value = 'files'
  } else if (m && Number(m[1]) < steps.value.length) {
    guidedIndex.value = Number(m[1])
  }
}

const otherFiles = computed(() => {
  if (!hasSteps.value) {
    return []
  }
  const covered = steps.value.flatMap((ch) => ch.files)
  return parsedDiff.value.files.filter((f) => !covered.some((c) => sameFile(c, f.path)))
})

const FILES_SPLIT_KEY = 'codesema-diff-mode'

const filesDiffMode = ref<'split' | 'unified'>(
  isClient
    ? ((localStorage.getItem(FILES_SPLIT_KEY) as 'split' | 'unified') ?? 'unified')
    : 'unified',
)

function setFilesDiffMode(m: 'split' | 'unified') {
  filesDiffMode.value = m
  if (isClient) {
    localStorage.setItem(FILES_SPLIT_KEY, m)
  }
}

// Each per-file DiffView sees a single file, so it can't judge the page-wide total.
// Decide the initial collapse here from the cumulative line budget across all files.
const filesCollapsedByDefault = computed(() => collapsedByBudget(parsedDiff.value.files))

const filesCollapseKey = ref(0)
const filesAllCollapsed = computed(() => filesCollapseKey.value % 2 === 1)
function toggleFilesCollapse() {
  filesCollapseKey.value++
}

const fileScrollRefs = new Map<string, HTMLElement>()
function setFileScrollRef(path: string, el: unknown) {
  if (el instanceof HTMLElement) {
    fileScrollRefs.set(path, el)
  } else {
    fileScrollRefs.delete(path)
  }
}
function onFilePick(path: string) {
  fileScrollRefs.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <div class="sr-root">
    <header class="sr-header">
      <div class="sr-header-main">
        <h1 class="sr-title">{{ meta.title }}</h1>
        <div class="sr-branches">
          <code>{{ meta.branch }}</code>
          <span class="sr-branch-arrow">→</span>
          <code>{{ meta.target }}</code>
        </div>
        <p v-if="meta.dual" class="sr-dual-stat muted">
          {{
            $t('reviews.dualStat', {
              merged: meta.dual.merged,
              rejected: meta.dual.rejected,
              added: meta.dual.added_by_b,
            })
          }}
        </p>
      </div>
      <button
        v-if="actionableCount > 0"
        class="sr-copy-btn btn ghost"
        :class="{ 'sr-copy-btn--done': copied }"
        @click="copyFixPrompt"
      >
        {{ copied ? $t('header.copied') : $t('header.copyPrompt', { n: actionableCount }) }}
      </button>
      <button
        v-if="actionableCount > 0 && viewMode === 'explain'"
        class="sr-fix-btn btn"
        @click="setViewMode('focus')"
      >
        {{ $t('header.runFixes', { n: actionableCount }) }}
      </button>
      <span class="sr-verdict-group">
        <span
          class="sr-semaphore"
          :class="`sr-semaphore--${record.review.verdict}`"
          aria-hidden="true"
        >
          <span class="sr-sem-dot sr-sem-dot--stop">{{ G.dot }}</span>
          <span class="sr-sem-dot sr-sem-dot--check">{{ G.dot }}</span>
          <span class="sr-sem-dot sr-sem-dot--go">{{ G.dot }}</span>
        </span>
        <span class="sr-verdict verdict" :data-v="verdictMeta!.v">{{
          $t(verdictMeta!.labelKey)
        }}</span>
      </span>
    </header>

    <div class="sr-tabs tabs" role="tablist">
      <template v-if="viewMode === 'explain'">
        <button
          role="tab"
          class="sr-tab tab"
          :class="{ on: activeTab === 'steps' }"
          :aria-selected="activeTab === 'steps'"
          @click="selectStepsTab"
        >
          {{ $t('app.tabSteps') }}
          <span v-if="steps.length > 0" class="sr-tab-n n">{{ steps.length }}</span>
        </button>
        <button
          role="tab"
          class="sr-tab tab"
          :class="{ on: activeTab === 'files' }"
          :aria-selected="activeTab === 'files'"
          @click="selectFilesTab"
        >
          {{ $t('app.tabFiles') }}
          <span v-if="filesCount > 0" class="sr-tab-n n">{{ filesCount }}</span>
        </button>
      </template>
      <span class="sr-tabs-spacer" />
      <div class="sr-mode seg">
        <button
          :class="{ on: viewMode === 'explain' }"
          :aria-pressed="viewMode === 'explain'"
          @click="setViewMode('explain')"
        >
          {{ $t('mode.explain') }}
        </button>
        <button
          :class="{ on: viewMode === 'focus' }"
          :aria-pressed="viewMode === 'focus'"
          @click="setViewMode('focus')"
        >
          {{ $t('mode.focus') }}
          <span v-if="actionableCount > 0" class="sr-mode-n">{{ actionableCount }}</span>
        </button>
      </div>
      <span class="sr-tabs-delta">
        <span class="sr-add">+{{ globalDelta.add }}</span>
        <span class="sr-del">−{{ globalDelta.del }}</span>
      </span>
    </div>

    <div v-if="viewMode === 'focus'" class="sr-stage">
      <ReviewFocusMode :record="record" :list="focusList" :files="parsedDiff.files" />
    </div>

    <div v-show="viewMode === 'explain' && activeTab === 'steps'" class="sr-stage">
      <StepRail
        v-if="hasSteps"
        :steps="steps"
        :findings="findings"
        :read-set="readSet"
        :current-index="guidedIndex"
        @select="onStepSelect"
      />

      <StepReview
        v-if="isGuidedMode && hasSteps && record.diff"
        :steps="steps"
        :findings="findings"
        :diff="record.diff"
        :selected-index="guidedIndex!"
        :read-set="readSet"
        :checked-set="checkedSet"
        :reveal="reveal"
        @back="onGuidedBack"
        @toggle-read="toggleRead"
        @toggle-checked="toggleChecked"
        @navigate="onGuidedNavigate"
      />

      <template v-else>
        <div class="sr-cols">
          <div class="sr-col-left">
            <ReviewPrologue
              :prologue="narrative?.prologue"
              :review-first="reviewFirst"
              :intent="narrative?.intent"
              :confidence="narrative?.confidence"
              :summary="record.review.summary"
            />

            <div v-if="unmatched.length" class="sr-general">
              <div class="sr-general-tag">{{ $t('reviews.generalNotes') }}</div>
              <ul class="sr-general-list">
                <li v-for="(f, i) in unmatched" :key="i" class="sr-general-item">
                  <span class="sr-sev sev" :data-v="f.severity">{{ f.severity }}</span>
                  <span v-if="f.consensus" class="sr-consensus" :title="$t('finding.consensus')">
                    <span class="sr-consensus-dots" aria-hidden="true">{{ G.dot }}{{ G.dot }}</span>
                    {{ $t('finding.consensus') }}
                  </span>
                  <code v-if="f.file" class="sr-general-file"
                    >{{ f.file }}<template v-if="f.line">:{{ f.line }}</template></code
                  >
                  {{ f.message }}
                  <pre v-if="f.suggestion" class="sr-general-sugg">{{ f.suggestion }}</pre>
                </li>
              </ul>
            </div>
          </div>

          <div class="sr-col-right">
            <StepList
              :steps="steps"
              :parsed-diff="parsedDiff"
              :read-set="readSet"
              @select="onStepSelect"
            />
          </div>
        </div>

        <div v-if="!hasSteps && record.diff" class="sr-flat-diff">
          <div class="sr-general-tag">{{ $t('reviews.annotatedDiff') }}</div>
          <DiffView :files="parsedDiff.files" />
        </div>

        <div v-if="hasSteps && otherFiles.length" class="sr-flat-diff">
          <div class="sr-general-tag">{{ $t('reviews.otherChanges') }}</div>
          <DiffView :files="otherFiles" />
        </div>
      </template>
    </div>

    <div v-show="viewMode === 'explain' && activeTab === 'files'" class="sr-stage sr-files-stage">
      <div v-if="record.diff" class="sr-files-layout">
        <FileTree :files="parsedDiff.files" :findings="findings" @pick="onFilePick" />

        <div class="sr-files-right">
          <div class="sr-files-toolbar">
            <button class="sr-files-tbtn btn" @click="toggleFilesCollapse">
              {{ filesAllCollapsed ? $t('fileTree.expandAll') : $t('fileTree.collapseAll') }}
            </button>
            <div class="sr-files-seg seg">
              <button
                :class="{ on: filesDiffMode === 'unified' }"
                :aria-pressed="filesDiffMode === 'unified'"
                @click="setFilesDiffMode('unified')"
              >
                {{ $t('diffView.modeUnified') }}
              </button>
              <button
                :class="{ on: filesDiffMode === 'split' }"
                :aria-pressed="filesDiffMode === 'split'"
                @click="setFilesDiffMode('split')"
              >
                {{ $t('diffView.modeSplit') }}
              </button>
            </div>
            <span class="sr-tabs-spacer" />
            <span class="sr-tabs-delta">
              <span class="sr-add">+{{ globalDelta.add }}</span>
              <span class="sr-del">−{{ globalDelta.del }}</span>
            </span>
          </div>

          <div class="sr-files-difflist">
            <div
              v-for="file in parsedDiff.files"
              :key="file.path"
              :ref="(el) => setFileScrollRef(file.path, el)"
            >
              <DiffView
                :files="[file]"
                :mode="filesDiffMode"
                :collapse-key="filesCollapseKey"
                :initial-collapsed="filesCollapsedByDefault.has(file.path)"
                hide-toolbar
              />
            </div>
          </div>
        </div>
      </div>
      <p v-else class="sr-empty-msg empty">{{ $t('reviews.noDiff') }}</p>
    </div>

    <div
      v-if="viewMode === 'explain' && activeTab === 'steps' && hasSteps && tour.length"
      class="sr-tour"
    >
      <button v-if="tourIndex === null" class="sr-tour-start btn ghost" @click="startTour">
        <span class="sr-tour-mark" aria-hidden="true">{{ G.note }}</span>
        {{ $t('tour.start') }}
      </button>
      <template v-else>
        <button
          class="sr-tour-btn btn"
          :disabled="!tourHasPrev"
          :title="$t('tour.prev')"
          :aria-label="$t('tour.prev')"
          @click="tourPrev"
        >
          <span aria-hidden="true">{{ G.back }}</span>
        </button>
        <span class="sr-tour-count"
          >{{ tourIndex + 1 }}<span class="sr-tour-total"> / {{ tour.length }}</span></span
        >
        <button
          v-if="tourHasNext"
          class="sr-tour-btn btn"
          :title="$t('tour.next')"
          :aria-label="$t('tour.next')"
          @click="tourNext"
        >
          <span aria-hidden="true">{{ G.arrow }}</span>
        </button>
        <button
          v-else
          class="sr-tour-btn sr-tour-btn--done btn"
          :title="$t('tour.finish')"
          :aria-label="$t('tour.finish')"
          @click="tourNext"
        >
          <span aria-hidden="true">{{ G.ok }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sr-root {
  max-width: 180ch;
  margin: 0 auto;
  padding-bottom: var(--row);
}

.sr-header {
  display: flex;
  align-items: baseline;
  gap: 2ch;
  padding: var(--row) 2ch;
  border-bottom: 1px solid var(--line);
}

.sr-header-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.sr-title {
  overflow-wrap: anywhere;
}

.sr-branches {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  font-size: 12px;
  color: var(--fg-dim);
}

.sr-branches code {
  color: var(--fg-dim);
}

.sr-dual-stat {
  font-size: 12px;
}

.sr-verdict-group {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 1ch;
}

/* Miniature semaphore: exactly one light on, the off lights stay visible but dimmed. */
.sr-semaphore {
  display: flex;
  flex-direction: column;
  line-height: 0.6;
  border: 1px solid var(--line);
  padding: 2px;
}

.sr-sem-dot {
  font-size: 12px;
  color: var(--fg-muted);
}

.sr-semaphore--request_changes .sr-sem-dot--stop {
  color: var(--err);
}

.sr-semaphore--comment .sr-sem-dot--check {
  color: var(--warn);
}

.sr-semaphore--approve .sr-sem-dot--go {
  color: var(--ok);
}

.sr-verdict {
  font-size: 12px;
  font-weight: 700;
}

.sr-copy-btn,
.sr-fix-btn {
  flex-shrink: 0;
  font-size: 12px;
}

.sr-copy-btn--done {
  color: var(--ok);
  border-color: var(--ok);
}

.sr-fix-btn {
  color: var(--accent);
  border-color: var(--accent);
}

.sr-tabs {
  align-items: center;
  padding: 0 2ch;
}

.sr-tab {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  font: inherit;
}

.sr-tab:hover {
  color: var(--fg);
}

.sr-tab.on {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

.sr-tab-n {
  font-size: 12px;
}

.sr-tabs-spacer {
  flex: 1;
}

.sr-mode {
  margin-right: 2ch;
}

.sr-mode button {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  font-size: 12px;
}

.sr-mode-n {
  font-size: 12px;
  color: var(--err);
}

.sr-mode button[aria-pressed='true'] .sr-mode-n {
  color: var(--bg);
}

.sr-tabs-delta {
  font-size: 12px;
  display: inline-flex;
  gap: 1ch;
}

.sr-add {
  color: var(--ok);
}

.sr-del {
  color: var(--err);
}

.sr-stage {
  min-height: 40vh;
}

.sr-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(40ch, 56ch);
  align-items: start;
}

.sr-col-left {
  min-width: 0;
}

.sr-col-right {
  border-left: 1px solid var(--line);
  min-height: 100%;
}

@media (max-width: 900px) {
  .sr-cols {
    grid-template-columns: 1fr;
  }
  .sr-col-right {
    border-left: none;
    border-top: 1px solid var(--line);
  }
}

.sr-general {
  padding: 0 2ch var(--row);
}

.sr-general-tag {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--accent);
}

.sr-general-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.sr-general-item {
  border-left: 2px solid var(--line);
  padding-left: 1ch;
  color: var(--fg-dim);
}

.sr-sev {
  font-size: 12px;
  text-transform: uppercase;
  margin-right: 1ch;
}

.sr-consensus {
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid currentColor;
  padding: 0 1ch;
  margin-right: 1ch;
  color: var(--ok);
}

.sr-consensus-dots {
  flex-shrink: 0;
  letter-spacing: -0.1em;
}

.sr-general-file {
  font-size: 12px;
  margin-right: 1ch;
  color: var(--fg-dim);
  background: none;
  padding: 0;
}

.sr-general-sugg {
  margin: 0;
  padding: 2px 1ch;
  background: var(--bg-raised);
  border-left: 2px solid var(--ok);
  color: var(--ok);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.sr-flat-diff {
  padding: var(--row) 2ch 0;
}

.sr-files-stage {
  min-height: 60vh;
}

.sr-files-layout {
  display: flex;
  align-items: stretch;
  min-height: calc(100vh - var(--row) * 7);
}

.sr-files-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.sr-files-toolbar {
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: calc(var(--row) / 2) 2ch;
  border-bottom: 1px solid var(--line);
}

.sr-files-tbtn {
  font-size: 12px;
}

.sr-files-seg button {
  font-size: 12px;
}

.sr-files-difflist {
  padding: var(--row) 2ch;
  display: flex;
  flex-direction: column;
  gap: var(--row);
}

.sr-empty-msg {
  margin: var(--row) 2ch;
}

.sr-tour {
  position: fixed;
  bottom: var(--row);
  right: 2ch;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 1ch;
  background: var(--bg);
  border: 1px solid var(--line);
  padding: 2px 1ch;
}

.sr-tour-start {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
}

.sr-tour-start:hover {
  color: var(--fg);
  background: transparent;
}

.sr-tour-mark {
  color: var(--accent);
  flex-shrink: 0;
}

.sr-tour-btn {
  padding: 0 1ch;
  color: var(--fg-dim);
}

.sr-tour-btn--done {
  border-color: var(--ok);
  color: var(--ok);
}

.sr-tour-count {
  font-size: 12px;
  min-width: 8ch;
  text-align: center;
}

.sr-tour-total {
  color: var(--fg-dim);
}

@media (max-width: 900px) {
  .sr-files-layout {
    flex-direction: column;
  }
}
</style>

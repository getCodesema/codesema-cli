<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'
import type { Finding } from '../composables/useDiff'
import { collapsedByBudget, parseDiff, sameFile } from '../composables/useDiff'
import { actionableFindings } from '../composables/useFocusList'
import { buildFixPrompt, isActionable } from '../composables/useFixPrompt'
import { buildNoteTour } from '../composables/useNoteTour'
import { useReviewProgress } from '../composables/useReviewProgress'
import type { ReviewRecord } from '../types'
import FocusView from './FocusView.vue'
import ReviewPrologue from './ReviewPrologue.vue'
import StepList from './StepList.vue'
import StepRail from './StepRail.vue'
import StepReview from './StepReview.vue'
import DiffView from './DiffView.vue'
import FileTree from './FileTree.vue'

const props = defineProps<{
  record: ReviewRecord
}>()

const isClient = typeof window !== 'undefined'

const meta = computed(() => props.record.meta)
// Findings get their global index as id so note anchors survive per-step re-parsing.
const findings = computed<Finding[]>(() => props.record.review.findings.map((f, i) => ({ ...f, id: i })))
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

const VERDICT_META: Record<string, { labelKey: string; cls: string }> = {
  approve: { labelKey: 'verdict.approve', cls: 'sr-verdict--approve' },
  request_changes: { labelKey: 'verdict.request_changes', cls: 'sr-verdict--changes' },
  comment: { labelKey: 'verdict.comment', cls: 'sr-verdict--comment' },
}

const verdictMeta = computed(() => VERDICT_META[props.record.review.verdict] ?? VERDICT_META.comment!)

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
    if (copiedTimer) clearTimeout(copiedTimer)
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

const tourStop = computed(() => (tourIndex.value === null ? null : (tour.value[tourIndex.value] ?? null)))
const tourHasPrev = computed(() => tourIndex.value !== null && tourIndex.value > 0)
const tourHasNext = computed(() => tourIndex.value !== null && tourIndex.value < tour.value.length - 1)

async function applyTourStop(index: number) {
  const stop = tour.value[index]
  if (!stop) return
  const previous = tourStop.value
  if (previous && stop.stepIndex > previous.stepIndex) markRead(previous.stepIndex)
  tourIndex.value = index
  if (guidedIndex.value !== stop.stepIndex) {
    guidedIndex.value = stop.stepIndex
    syncHash()
  }
  await nextTick()
  if (stop.findingId === null) {
    if (isClient) window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  reveal.value = { id: stop.findingId, nonce: ++revealNonce }
}

function startTour() {
  void applyTourStop(0)
}

function tourNext() {
  if (tourIndex.value === null) return
  if (tourHasNext.value) {
    void applyTourStop(tourIndex.value + 1)
    return
  }
  finishTour()
}

function tourPrev() {
  if (tourIndex.value !== null && tourHasPrev.value) void applyTourStop(tourIndex.value - 1)
}

function finishTour() {
  const stop = tourStop.value
  if (stop) markRead(stop.stepIndex)
  tourIndex.value = null
  guidedIndex.value = null
  syncHash()
}

/** Manual step navigation during a tour: snap the tour onto the chosen step. */
function realignTour(stepIndex: number) {
  if (tourIndex.value === null) return
  const at = tour.value.findIndex((s) => s.stepIndex === stepIndex && s.findingId === null)
  tourIndex.value = at >= 0 ? at : null
}

function syncHash() {
  if (!isClient) return
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
  if (location.hash === '#focus') viewMode.value = 'focus'
  else if (location.hash === '#files') activeTab.value = 'files'
  else if (m && Number(m[1]) < steps.value.length) guidedIndex.value = Number(m[1])
}

const otherFiles = computed(() => {
  if (!hasSteps.value) return []
  const covered = steps.value.flatMap((ch) => ch.files)
  return parsedDiff.value.files.filter((f) => !covered.some((c) => sameFile(c, f.path)))
})

const FILES_SPLIT_KEY = 'codesema-diff-mode'

const filesDiffMode = ref<'split' | 'unified'>(
  isClient ? ((localStorage.getItem(FILES_SPLIT_KEY) as 'split' | 'unified') ?? 'unified') : 'unified',
)

function setFilesDiffMode(m: 'split' | 'unified') {
  filesDiffMode.value = m
  if (isClient) localStorage.setItem(FILES_SPLIT_KEY, m)
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
  if (el instanceof HTMLElement) fileScrollRefs.set(path, el)
  else fileScrollRefs.delete(path)
}
function onFilePick(path: string) {
  fileScrollRefs.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const SEV_CLS: Record<string, string> = {
  critical: 'sr-sev--high',
  major: 'sr-sev--high',
  minor: 'sr-sev--med',
  info: 'sr-sev--info',
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
      </div>
      <button
        v-if="actionableCount > 0"
        class="sr-copy-btn"
        :class="{ 'sr-copy-btn--done': copied }"
        @click="copyFixPrompt"
      >
        {{ copied ? $t('header.copied') : $t('header.copyPrompt', { n: actionableCount }) }}
      </button>
      <button
        v-if="actionableCount > 0 && viewMode === 'explain'"
        class="sr-fix-btn"
        @click="setViewMode('focus')"
      >
        {{ $t('header.runFixes', { n: actionableCount }) }}
      </button>
      <span class="sr-verdict-group">
        <span class="sr-semaphore" :class="`sr-semaphore--${record.review.verdict}`" aria-hidden="true">
          <span class="sr-sem-dot sr-sem-dot--stop" />
          <span class="sr-sem-dot sr-sem-dot--check" />
          <span class="sr-sem-dot sr-sem-dot--go" />
        </span>
        <span class="sr-verdict" :class="verdictMeta!.cls">{{ $t(verdictMeta!.labelKey) }}</span>
      </span>
    </header>

    <div class="sr-tabs" role="tablist">
      <template v-if="viewMode === 'explain'">
        <button
          role="tab"
          class="sr-tab"
          :class="{ on: activeTab === 'steps' }"
          :aria-selected="activeTab === 'steps'"
          @click="activeTab = 'steps'; syncHash()"
        >
          {{ $t('app.tabSteps') }}
          <span v-if="steps.length > 0" class="sr-tab-n">{{ steps.length }}</span>
        </button>
        <button
          role="tab"
          class="sr-tab"
          :class="{ on: activeTab === 'files' }"
          :aria-selected="activeTab === 'files'"
          @click="activeTab = 'files'; guidedIndex = null; syncHash()"
        >
          {{ $t('app.tabFiles') }}
          <span v-if="filesCount > 0" class="sr-tab-n">{{ filesCount }}</span>
        </button>
      </template>
      <span class="sr-tabs-spacer" />
      <div class="sr-mode">
        <button :class="{ on: viewMode === 'explain' }" @click="setViewMode('explain')">
          {{ $t('mode.explain') }}
        </button>
        <button :class="{ on: viewMode === 'focus' }" @click="setViewMode('focus')">
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
      <FocusView :record="record" :list="focusList" :files="parsedDiff.files" />
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
                  <span class="sr-sev" :class="SEV_CLS[f.severity] ?? 'sr-sev--info'">{{ f.severity }}</span>
                  <code v-if="f.file" class="sr-general-file">{{ f.file }}<template v-if="f.line">:{{ f.line }}</template></code>
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
        <FileTree
          :files="parsedDiff.files"
          :findings="findings"
          @pick="onFilePick"
        />

        <div class="sr-files-right">
          <div class="sr-files-toolbar">
            <button class="sr-files-tbtn" @click="toggleFilesCollapse">
              {{ filesAllCollapsed ? $t('fileTree.expandAll') : $t('fileTree.collapseAll') }}
            </button>
            <div class="sr-files-seg">
              <button :class="{ on: filesDiffMode === 'unified' }" @click="setFilesDiffMode('unified')">
                {{ $t('diffView.modeUnified') }}
              </button>
              <button :class="{ on: filesDiffMode === 'split' }" @click="setFilesDiffMode('split')">
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
      <p v-else class="codesema-muted sr-empty-msg">{{ $t('reviews.noDiff') }}</p>
    </div>

    <div v-if="viewMode === 'explain' && activeTab === 'steps' && hasSteps && tour.length" class="sr-tour">
      <button v-if="tourIndex === null" class="sr-tour-start" @click="startTour">
        <span class="sr-tour-mark">✦</span>
        {{ $t('tour.start') }}
      </button>
      <template v-else>
        <button
          class="sr-tour-btn"
          :disabled="!tourHasPrev"
          :title="$t('tour.prev')"
          :aria-label="$t('tour.prev')"
          @click="tourPrev"
        >
          ‹
        </button>
        <span class="sr-tour-count">{{ tourIndex + 1 }}<span class="sr-tour-total"> / {{ tour.length }}</span></span>
        <button
          v-if="tourHasNext"
          class="sr-tour-btn"
          :title="$t('tour.next')"
          :aria-label="$t('tour.next')"
          @click="tourNext"
        >
          ›
        </button>
        <button
          v-else
          class="sr-tour-btn sr-tour-btn--done"
          :title="$t('tour.finish')"
          :aria-label="$t('tour.finish')"
          @click="tourNext"
        >
          ✓
        </button>
      </template>
    </div>

  </div>
</template>

<style scoped>
.sr-root {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 0 60px;
}

/* ── Header ─────────────────────────────────────────────────── */
.sr-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 26px 26px 18px;
}

.sr-header-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.sr-title {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin: 0;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.sr-branches {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--codesema-ink-3);
}

.sr-branches code {
  background: var(--codesema-line-2);
  border-radius: 6px;
  padding: 2px 8px;
  color: var(--codesema-ink-2);
}

.sr-branch-arrow {
  color: var(--codesema-ink-3);
}

.sr-verdict-group {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

/* Miniature semaphore: exactly one light on, the off lights stay visible but dimmed. */
.sr-semaphore {
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--codesema-ink);
  border-radius: 7px;
  padding: 4px;
}

.sr-sem-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.sr-sem-dot--stop {
  background: var(--codesema-signal-stop);
  opacity: 0.28;
}

.sr-sem-dot--check {
  background: var(--codesema-signal-check);
  opacity: 0.32;
}

.sr-sem-dot--go {
  background: var(--codesema-signal-go);
  opacity: 0.3;
}

.sr-semaphore--request_changes .sr-sem-dot--stop {
  opacity: 1;
  box-shadow: 0 0 8px var(--codesema-signal-stop);
}

.sr-semaphore--comment .sr-sem-dot--check {
  opacity: 1;
  box-shadow: 0 0 8px var(--codesema-signal-check);
}

.sr-semaphore--approve .sr-sem-dot--go {
  opacity: 1;
  box-shadow: 0 0 8px var(--codesema-signal-go);
}

.sr-verdict {
  font-size: 12px;
  font-weight: 700;
  border-radius: 999px;
  padding: 5px 13px;
  border: 1px solid transparent;
}

.sr-verdict--approve {
  color: var(--codesema-risk-low);
  background: var(--codesema-risk-low-soft);
}

.sr-verdict--changes {
  color: var(--codesema-risk-high);
  background: var(--codesema-risk-high-soft);
}

.sr-verdict--comment {
  color: var(--codesema-amber);
  background: var(--codesema-amber-soft);
}

.sr-copy-btn {
  flex-shrink: 0;
  margin-top: 4px;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease;
}

.sr-copy-btn:hover {
  border-color: var(--codesema-ink-3);
}

.sr-copy-btn--done {
  color: var(--codesema-risk-low);
  border-color: var(--codesema-risk-low);
}

.sr-fix-btn {
  flex-shrink: 0;
  margin-top: 4px;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--codesema-accent) 45%, transparent);
  background: var(--codesema-accent-soft);
  color: var(--codesema-accent);
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.sr-fix-btn:hover {
  border-color: var(--codesema-accent);
}

/* ── Onglets ────────────────────────────────────────────────── */
.sr-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 26px;
  border-bottom: 1px solid var(--codesema-line);
}

.sr-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 10px 12px;
  margin-bottom: -1px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--codesema-ink-3);
  cursor: pointer;
  transition: color 0.12s ease;
}

.sr-tab:hover {
  color: var(--codesema-ink);
}

.sr-tab.on {
  color: var(--codesema-ink);
  border-bottom-color: var(--codesema-accent);
}

.sr-tab-n {
  font-family: var(--font-mono);
  font-size: 10.5px;
  background: var(--codesema-line-2);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--codesema-ink-3);
}

.sr-tabs-spacer {
  flex: 1;
}

.sr-mode {
  display: inline-flex;
  align-items: center;
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-radius: 9px;
  padding: 2px;
  gap: 2px;
  margin: 4px 12px 4px 0;
}

.sr-mode button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 7px;
  color: var(--codesema-ink-2);
  font-weight: 500;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
}

.sr-mode button.on {
  background: var(--codesema-ink);
  color: var(--codesema-bg);
}

.sr-mode-n {
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--codesema-risk-high);
  color: #fff;
  border-radius: 999px;
  padding: 0 6px;
}

.sr-tabs-delta {
  font-family: var(--font-mono);
  font-size: 11.5px;
  display: inline-flex;
  gap: 6px;
}

.sr-add {
  color: var(--codesema-risk-low);
}

.sr-del {
  color: var(--codesema-risk-high);
}

/* ── Stage ──────────────────────────────────────────────────── */
.sr-stage {
  min-height: 40vh;
}

/* Vue d'ensemble : 2 colonnes */
.sr-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
  gap: 0;
  align-items: start;
}

.sr-col-left {
  min-width: 0;
}

.sr-col-right {
  border-left: 1px solid var(--codesema-line);
  min-height: 100%;
}

@media (max-width: 900px) {
  .sr-cols {
    grid-template-columns: 1fr;
  }
  .sr-col-right {
    border-left: none;
    border-top: 1px solid var(--codesema-line);
  }
}

/* general notes */
.sr-general {
  padding: 0 26px 24px;
}

.sr-general-tag {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--codesema-accent);
  margin-bottom: 10px;
}

.sr-general-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sr-general-item {
  border-left: 2px solid var(--codesema-line);
  padding-left: 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--codesema-ink-2);
}

.sr-sev {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  margin-right: 8px;
}

.sr-sev--high {
  color: var(--codesema-risk-high);
}

.sr-sev--med {
  color: var(--codesema-risk-med);
}

.sr-sev--info {
  color: var(--codesema-ink-3);
}

.sr-general-file {
  font-family: var(--font-mono);
  font-size: 11px;
  margin-right: 6px;
  color: var(--codesema-ink-3);
}

.sr-general-sugg {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--codesema-risk-low-soft);
  color: var(--codesema-risk-low);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Diff plat (sans chapitres / autres fichiers) */
.sr-flat-diff {
  padding: 24px 26px 0;
}

/* ── Onglet Fichiers ────────────────────────────────────────── */
.sr-files-stage {
  min-height: 60vh;
}

.sr-files-layout {
  display: flex;
  align-items: stretch;
  min-height: calc(100vh - 160px);
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
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--codesema-line);
}

.sr-files-tbtn {
  font-size: 12px;
  padding: 6px 11px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.sr-files-tbtn:hover {
  border-color: var(--codesema-ink-3);
}

.sr-files-seg {
  display: inline-flex;
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-radius: 9px;
  padding: 2px;
  gap: 2px;
}

.sr-files-seg button {
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 7px;
  color: var(--codesema-ink-2);
  font-weight: 500;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
}

.sr-files-seg button.on {
  background: var(--codesema-ink);
  color: var(--codesema-bg);
}

.sr-files-difflist {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sr-empty-msg {
  padding: 32px 26px;
  font-size: 13px;
}

/* ── Guided note tour (floating pill) ───────────────────────── */
.sr-tour {
  position: fixed;
  bottom: 22px;
  right: 22px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-radius: 999px;
  padding: 7px 10px;
  box-shadow: 0 6px 24px color-mix(in srgb, var(--codesema-ink) 14%, transparent);
}

.sr-tour-start {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--codesema-ink-2);
  cursor: pointer;
  padding: 2px 6px;
  transition: color 0.12s ease;
}

.sr-tour-start:hover {
  color: var(--codesema-ink);
}

.sr-tour-mark {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--codesema-accent);
  color: #fff;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sr-tour-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  font-size: 15px;
  font-family: inherit;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: border-color 0.1s ease;
}

.sr-tour-btn:hover:not(:disabled) {
  border-color: var(--codesema-ink-3);
}

.sr-tour-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sr-tour-btn--done {
  border-color: var(--codesema-risk-low);
  color: var(--codesema-risk-low);
}

.sr-tour-count {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--codesema-ink);
  min-width: 52px;
  text-align: center;
}

.sr-tour-total {
  color: var(--codesema-ink-3);
  font-weight: 400;
}

@media (max-width: 900px) {
  .sr-files-layout {
    flex-direction: column;
  }
}
</style>

<script setup lang="ts">
// All optional fields (risk/take/check/rationale) have fallbacks.

import { computed, ref, watch } from 'vue'
import { parseDiff, pickFiles, sameFile, type Finding } from '../composables/useDiff'
import { G } from '../glyphs'
import { riskMeta } from '../risk'
import type { StepView } from '../types'
import DiffView from './DiffView.vue'

const props = defineProps<{
  steps: StepView[]
  findings: Finding[]
  diff: string
  selectedIndex: number
  readSet: Set<number>
  checkedSet: Set<number>
  reveal?: { id: number; nonce: number } | null
}>()

const emit = defineEmits<{
  back: []
  toggleRead: [index: number]
  toggleChecked: [index: number]
  navigate: [index: number]
}>()

const step = computed(() => props.steps[props.selectedIndex])
const stepNumber = computed(() => props.selectedIndex + 1)
const totalSteps = computed(() => props.steps.length)

const isRead = computed(() => props.readSet.has(props.selectedIndex))
const isChecked = computed(() => props.checkedSet.has(props.selectedIndex))

const canPrev = computed(() => props.selectedIndex > 0)
const canNext = computed(() => props.selectedIndex < props.steps.length - 1)

function goPrev() {
  if (canPrev.value) {
    emit('navigate', props.selectedIndex - 1)
  }
}
function goNext() {
  if (canNext.value) {
    emit('navigate', props.selectedIndex + 1)
  }
}

const fileFilter = ref('')

watch(
  () => props.selectedIndex,
  () => {
    fileFilter.value = ''
  },
)

const filteredFiles = computed(() => {
  if (!step.value) {
    return []
  }
  const q = fileFilter.value.toLowerCase().trim()
  if (!q) {
    return step.value.files
  }
  return step.value.files.filter((f) => f.toLowerCase().includes(q))
})

function shortName(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

const stepFindings = computed((): Finding[] => {
  if (!step.value) {
    return []
  }
  return step.value.finding_refs.map((i) => props.findings[i]).filter((f): f is Finding => !!f)
})

const stepFindingCount = computed(() => stepFindings.value.length)

const stepFiles = computed(() => {
  if (!step.value || !props.diff) {
    return []
  }
  const parsed = parseDiff(props.diff, stepFindings.value)
  // Findings can reference a file the step forgot to list: include it so every
  // note of the step stays reachable (guided tour scrolls to note anchors).
  const findingFiles = stepFindings.value.map((f) => f.file)
  return pickFiles(parsed.files, [...step.value.files, ...findingFiles])
})

const stepDelta = computed(() => {
  let add = 0
  let del = 0
  for (const f of stepFiles.value) {
    add += f.addCount
    del += f.delCount
  }
  return { add, del }
})

function scrollToFile(filePath: string) {
  if (typeof document === 'undefined') {
    return
  }
  // DiffView renders file headers with a data-diff-file attribute derived from the path
  const allHeaders = document.querySelectorAll<HTMLElement>('[data-diff-file]')
  for (const el of allHeaders) {
    const attr = el.dataset.diffFile ?? ''
    if (sameFile(attr, filePath) || attr.endsWith(filePath) || filePath.endsWith(attr)) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
  }
  const allMono = document.querySelectorAll<HTMLElement>('.diff-file-path')
  for (const el of allMono) {
    if (el.textContent?.includes(shortName(filePath))) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
  }
}
</script>

<template>
  <div v-if="step" class="steprev-root">
    <div class="steprev-left">
      <button class="steprev-back btn ghost" @click="emit('back')">
        <span aria-hidden="true">{{ G.back }}</span>
        {{ $t('reviews.guidedBack') }}
      </button>

      <div class="steprev-nav">
        <button
          class="steprev-radio-btn btn ghost"
          :class="{ 'steprev-radio-btn--done': isRead }"
          :title="isRead ? $t('reviews.guidedMarkUnread') : $t('reviews.guidedMarkRead')"
          :aria-pressed="isRead"
          @click="emit('toggleRead', selectedIndex)"
        >
          <span class="steprev-radio-check" aria-hidden="true">{{
            isRead ? G.ok : G.pending
          }}</span>
        </button>

        <span class="steprev-which">
          {{ $t('reviews.guidedStep') }} {{ stepNumber }}
          <span class="steprev-which-total">/ {{ totalSteps }}</span>
        </span>

        <span class="steprev-spacer" />

        <button
          class="steprev-arrow btn"
          :disabled="!canPrev"
          :title="$t('reviews.guidedPrev')"
          :aria-label="$t('reviews.guidedPrev')"
          @click="goPrev"
        >
          <span aria-hidden="true">{{ G.back }}</span>
        </button>
        <button
          class="steprev-arrow btn"
          :disabled="!canNext"
          :title="$t('reviews.guidedNext')"
          :aria-label="$t('reviews.guidedNext')"
          @click="goNext"
        >
          <span aria-hidden="true">{{ G.arrow }}</span>
        </button>
      </div>

      <h2 class="steprev-title">{{ step.title }}</h2>

      <div class="steprev-meta">
        <template v-if="step.risk && riskMeta(step.risk)">
          <span class="steprev-risk-badge risk" :data-r="riskMeta(step.risk)!.r">
            {{ $t(riskMeta(step.risk)!.label) }}
          </span>
        </template>
        <span class="steprev-delta">
          <span v-if="stepDelta.add > 0" class="steprev-delta-add">+{{ stepDelta.add }}</span>
          <span v-if="stepDelta.del > 0" class="steprev-delta-del">−{{ stepDelta.del }}</span>
        </span>
      </div>

      <p v-if="step.rationale" class="steprev-rationale">{{ step.rationale }}</p>

      <div v-if="step.check" class="steprev-towatch">
        <div class="steprev-towatch-tag">{{ $t('reviews.guidedToWatch') }}</div>
        <div class="steprev-towatch-row">
          <button
            class="steprev-check-btn btn ghost"
            :class="{ 'steprev-check-btn--done': isChecked }"
            :aria-pressed="isChecked"
            @click="emit('toggleChecked', selectedIndex)"
          >
            <span class="steprev-check-mark" aria-hidden="true">{{
              isChecked ? G.ok : G.pending
            }}</span>
          </button>
          <span class="steprev-towatch-text" @click="emit('toggleChecked', selectedIndex)">{{
            step.check
          }}</span>
        </div>
      </div>

      <div class="steprev-files">
        <div class="steprev-files-head">
          {{ $t('reviews.guidedFiles') }}
          <span class="steprev-files-count">{{ step.files.length }}</span>
        </div>
        <input
          v-model="fileFilter"
          class="steprev-filter"
          :placeholder="$t('reviews.guidedFileFilter')"
          type="text"
        />
        <div class="steprev-filelist">
          <div
            v-for="f in filteredFiles"
            :key="f"
            class="steprev-filerow"
            role="button"
            tabindex="0"
            @click="scrollToFile(f)"
            @keydown.enter="scrollToFile(f)"
          >
            <span class="steprev-fileicon" aria-hidden="true">{{ G.file }}</span>
            <span class="steprev-filename" :title="f">{{ shortName(f) }}</span>
            <span class="steprev-filepath muted">{{ f }}</span>
          </div>
          <p v-if="filteredFiles.length === 0" class="steprev-files-empty muted">
            {{ $t('reviews.guidedFileEmpty') }}
          </p>
        </div>
      </div>
    </div>

    <div class="steprev-right">
      <div class="steprev-banner">
        <span class="steprev-banner-mark" aria-hidden="true">{{ G.note }}</span>
        <div class="steprev-banner-body">
          <div class="steprev-banner-head">
            {{ $t('reviews.guidedBannerTitle') }}
            <span v-if="stepFindingCount > 0" class="steprev-banner-count">
              {{ $t('reviews.guidedBannerCount', { n: stepFindingCount }) }}
            </span>
          </div>
          <p v-if="step.take" class="steprev-banner-take">{{ step.take }}</p>
        </div>
      </div>

      <div v-if="diff" class="steprev-diff">
        <DiffView :files="stepFiles" :reveal="reveal" />
      </div>
      <p v-else class="steprev-nodiff empty">{{ $t('reviews.noDiff') }}</p>
    </div>
  </div>

  <div v-else class="steprev-empty">
    <p class="empty">{{ $t('reviews.stepsEmpty') }}</p>
  </div>
</template>

<style scoped>
.steprev-root {
  display: flex;
  align-items: flex-start;
  min-height: 0;
}

.steprev-left {
  width: 48ch;
  flex-shrink: 0;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  padding: var(--row) 2ch;
  position: sticky;
  top: 0;
  max-height: 100vh;
  overflow-y: auto;
  background: var(--bg);
}

.steprev-back {
  align-self: flex-start;
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
  padding-left: 0;
}

.steprev-back:hover {
  color: var(--accent);
  background: transparent;
}

.steprev-nav {
  display: flex;
  align-items: center;
  gap: 1ch;
}

.steprev-radio-btn {
  flex-shrink: 0;
  padding: 0 1ch;
}

.steprev-radio-btn--done {
  color: var(--ok);
}

.steprev-which {
  color: var(--fg-dim);
}

.steprev-spacer {
  flex: 1;
}

.steprev-arrow {
  padding: 0 1ch;
  color: var(--fg-dim);
}

.steprev-title {
  margin-top: var(--row);
}

.steprev-meta {
  display: flex;
  align-items: baseline;
  gap: 2ch;
  flex-wrap: wrap;
}

.steprev-risk-badge {
  font-size: 12px;
  border: 1px solid currentColor;
  padding: 0 1ch;
  color: var(--fg-dim);
}

.steprev-delta {
  display: inline-flex;
  align-items: baseline;
  gap: 1ch;
  font-size: 12px;
}

.steprev-delta-add {
  color: var(--ok);
}

.steprev-delta-del {
  color: var(--err);
}

.steprev-rationale {
  color: var(--fg-dim);
}

.steprev-towatch {
  border-left: 2px solid var(--warn);
  padding: 0 1ch;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.steprev-towatch-tag {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--warn);
}

.steprev-towatch-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  cursor: pointer;
}

.steprev-check-btn {
  flex-shrink: 0;
  padding: 0 1ch;
  color: var(--warn);
}

.steprev-check-btn--done {
  color: var(--ok);
}

.steprev-files {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.steprev-files-head {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--fg-dim);
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.steprev-files-count {
  font-size: 12px;
  color: var(--fg-dim);
}

.steprev-filter {
  width: 100%;
  min-width: 0;
}

.steprev-filelist {
  display: flex;
  flex-direction: column;
}

.steprev-filerow {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding: 0 1ch;
  cursor: pointer;
  min-width: 0;
}

.steprev-filerow:hover,
.steprev-filerow:focus-visible {
  background: var(--bg-hover);
}

.steprev-fileicon {
  color: var(--fg-muted);
  flex-shrink: 0;
}

.steprev-filename {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.steprev-filepath {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  display: none;
}

.steprev-files-empty {
  font-size: 12px;
}

.steprev-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.steprev-banner {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding: 0 1ch;
  margin: var(--row) 2ch 0;
  border-left: 2px solid var(--accent);
}

.steprev-banner-mark {
  flex-shrink: 0;
  color: var(--accent);
}

.steprev-banner-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.steprev-banner-head {
  font-weight: 700;
  display: flex;
  align-items: baseline;
  gap: 2ch;
  flex-wrap: wrap;
}

.steprev-banner-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--accent);
  border: 1px solid currentColor;
  padding: 0 1ch;
  white-space: nowrap;
  flex-shrink: 0;
}

.steprev-banner-take {
  margin-top: calc(var(--row) / 2);
}

.steprev-diff {
  padding: var(--row) 2ch;
}

.steprev-nodiff {
  margin: var(--row) 2ch;
}

.steprev-empty {
  padding: var(--row) 2ch;
}

@media (max-width: 900px) {
  .steprev-root {
    flex-direction: column;
  }
  .steprev-left {
    width: 100%;
    position: static;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
}

@media (max-width: 640px) {
  .steprev-banner {
    margin: var(--row) 1ch 0;
  }
  .steprev-diff {
    padding: var(--row) 1ch;
  }
}
</style>

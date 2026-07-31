<script setup lang="ts">
// All optional fields (risk/take/check/rationale) have fallbacks.

import { computed, ref, watch } from 'vue'
import { parseDiff, pickFiles, sameFile, type Finding } from '../composables/useDiff'
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
      <button class="steprev-back" @click="emit('back')">
        {{ $t('reviews.guidedBack') }}
      </button>

      <div class="steprev-nav">
        <button
          class="steprev-radio-btn"
          :class="{ 'steprev-radio-btn--done': isRead }"
          :title="isRead ? $t('reviews.guidedMarkUnread') : $t('reviews.guidedMarkRead')"
          @click="emit('toggleRead', selectedIndex)"
        >
          <span v-if="isRead" class="steprev-radio-check">✓</span>
        </button>

        <span class="steprev-which">
          {{ $t('reviews.guidedStep') }} {{ stepNumber }}
          <span class="steprev-which-total">/ {{ totalSteps }}</span>
        </span>

        <span class="steprev-spacer" />

        <button
          class="steprev-arrow"
          :disabled="!canPrev"
          :title="$t('reviews.guidedPrev')"
          :aria-label="$t('reviews.guidedPrev')"
          @click="goPrev"
        >
          ‹
        </button>
        <button
          class="steprev-arrow"
          :disabled="!canNext"
          :title="$t('reviews.guidedNext')"
          :aria-label="$t('reviews.guidedNext')"
          @click="goNext"
        >
          ›
        </button>
      </div>

      <h2 class="steprev-title">{{ step.title }}</h2>

      <div class="steprev-meta">
        <template v-if="step.risk && riskMeta(step.risk)">
          <span
            class="steprev-risk-badge"
            :class="[riskMeta(step.risk)!.textCls, riskMeta(step.risk)!.bgCls]"
          >
            <span class="steprev-risk-dot" :style="{ background: riskMeta(step.risk)!.dotColor }" />
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
            class="steprev-check-btn"
            :class="{ 'steprev-check-btn--done': isChecked }"
            @click="emit('toggleChecked', selectedIndex)"
          >
            <span v-if="isChecked" class="steprev-check-mark">✓</span>
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
            <span class="steprev-fileicon">▤</span>
            <span class="steprev-filename" :title="f">{{ shortName(f) }}</span>
            <span class="steprev-filepath codesema-muted">{{ f }}</span>
          </div>
          <p v-if="filteredFiles.length === 0" class="steprev-files-empty codesema-muted">
            {{ $t('reviews.guidedFileEmpty') }}
          </p>
        </div>
      </div>
    </div>

    <div class="steprev-right">
      <div class="steprev-banner">
        <span class="steprev-banner-mark">✦</span>
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
      <p v-else class="codesema-muted steprev-nodiff">{{ $t('reviews.noDiff') }}</p>
    </div>
  </div>

  <div v-else class="steprev-empty">
    <p class="codesema-muted">{{ $t('reviews.stepsEmpty') }}</p>
  </div>
</template>

<style scoped>
/* 2-column layout */
.steprev-root {
  display: flex;
  align-items: flex-start;
  min-height: 0;
}

/* left column */
.steprev-left {
  width: 384px;
  flex-shrink: 0;
  border-right: 1px solid var(--codesema-line);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 24px 26px 32px;
  position: sticky;
  top: 0;
  max-height: 100vh;
  overflow-y: auto;
  background: color-mix(in srgb, var(--codesema-panel) 60%, var(--codesema-bg));
}

/* back button */
.steprev-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--codesema-ink-3);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
  transition: color 0.12s ease;
}
.steprev-back:hover {
  color: var(--codesema-accent);
}

/* nav toggle + arrows */
.steprev-nav {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* big read toggle */
.steprev-radio-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid var(--codesema-line);
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    border-color 0.12s ease,
    background 0.12s ease;
}
.steprev-radio-btn--done {
  border-color: var(--codesema-risk-low);
  background: var(--codesema-risk-low);
}
.steprev-radio-check {
  font-size: 11px;
  color: #fff;
  line-height: 1;
  font-weight: 700;
}

.steprev-which {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--codesema-ink-2);
}
.steprev-which-total {
  color: var(--codesema-ink-3);
  font-weight: 400;
}

.steprev-spacer {
  flex: 1;
}

.steprev-arrow {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  font-size: 15px;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: border-color 0.1s ease;
  font-family: inherit;
}
.steprev-arrow:hover:not(:disabled) {
  border-color: var(--codesema-ink-3);
}
.steprev-arrow:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* step title */
.steprev-title {
  font-family: var(--font-display);
  font-size: 23px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--codesema-ink);
  margin: 16px 0 0;
  line-height: 1.15;
}

/* risk + delta meta */
.steprev-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0;
}

.steprev-risk-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
}
.steprev-risk-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.step-risk--high {
  color: var(--codesema-risk-high);
}
.step-risk-bg--high {
  background: var(--codesema-risk-high-soft);
}
.step-risk--med {
  color: var(--codesema-risk-med);
}
.step-risk-bg--med {
  background: var(--codesema-risk-med-soft);
}
.step-risk--low {
  color: var(--codesema-risk-low);
}
.step-risk-bg--low {
  background: var(--codesema-risk-low-soft);
}

.steprev-delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.steprev-delta-add {
  color: var(--codesema-risk-low);
}
.steprev-delta-del {
  color: var(--codesema-risk-high);
}

/* rationale */
.steprev-rationale {
  font-size: 13.5px;
  color: var(--codesema-ink-2);
  line-height: 1.6;
  margin: 0;
  text-wrap: pretty;
}

/* to-watch amber box */
.steprev-towatch {
  border: 1px solid color-mix(in srgb, var(--codesema-amber) 30%, transparent);
  border-radius: 10px;
  padding: 13px 14px;
  background: var(--codesema-amber-soft);
  margin-top: 18px;
}
.steprev-towatch-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--codesema-amber);
  margin-bottom: 9px;
}
.steprev-towatch-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  font-size: 13px;
  color: var(--codesema-ink);
  line-height: 1.5;
}
.steprev-check-btn {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 4px;
  border: 1.5px solid var(--codesema-amber);
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background 0.1s ease;
}
.steprev-check-btn--done {
  background: var(--codesema-amber);
}
.steprev-check-mark {
  font-size: 10px;
  color: #fff;
  font-weight: 700;
}

/* file list */
.steprev-files {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 22px;
}
.steprev-files-head {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--codesema-ink-3);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}
.steprev-files-count {
  font-size: 10.5px;
  font-weight: 500;
  background: var(--codesema-line-2);
  border-radius: 99px;
  padding: 0 6px;
  color: var(--codesema-ink-3);
}
.steprev-filter {
  width: 100%;
  border: 1px solid var(--codesema-line);
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12.5px;
  font-family: inherit;
  background: var(--codesema-panel);
  color: var(--codesema-ink);
  outline: none;
  transition: border-color 0.12s ease;
  box-sizing: border-box;
}
.steprev-filter:focus {
  border-color: var(--codesema-accent);
}
.steprev-filelist {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.steprev-filerow {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 7px;
  cursor: pointer;
  outline: none;
  transition: background 0.1s ease;
  min-width: 0;
}
.steprev-filerow:hover,
.steprev-filerow:focus-visible {
  background: color-mix(in srgb, var(--codesema-line-2) 80%, var(--codesema-bg));
}
.steprev-fileicon {
  font-size: 11px;
  color: var(--codesema-ink-3);
  flex-shrink: 0;
}
.steprev-filename {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--codesema-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.steprev-filepath {
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  display: none;
}
.steprev-files-empty {
  font-size: 12px;
  padding: 6px 0;
}

/* right column */
.steprev-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
}

/* review banner */
.steprev-banner {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 14px 16px;
  margin: 16px 20px 0;
  border: 1px solid color-mix(in srgb, var(--codesema-accent) 30%, transparent);
  border-radius: 12px;
  background: var(--codesema-accent-soft);
}
.steprev-banner-mark {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--codesema-accent);
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  font-family: var(--font-display);
  display: grid;
  place-items: center;
  letter-spacing: -0.02em;
}
.steprev-banner-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.steprev-banner-head {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--codesema-ink);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.steprev-banner-count {
  font-size: 11px;
  font-weight: 600;
  background: var(--codesema-panel);
  color: var(--codesema-accent);
  border: 1px solid color-mix(in srgb, var(--codesema-accent) 30%, transparent);
  border-radius: 999px;
  padding: 2px 9px;
  white-space: nowrap;
  flex-shrink: 0;
}
.steprev-banner-take {
  font-size: 13px;
  line-height: 1.55;
  color: var(--codesema-ink);
  margin: 6px 0 0;
  text-wrap: pretty;
}

/* diff */
.steprev-diff {
  padding: 20px 20px 60px;
}
.steprev-nodiff {
  padding: 24px;
  font-size: 13px;
}

/* empty fallback */
.steprev-empty {
  padding: 32px 24px;
  font-size: 13px;
}

/* responsive: stack below 900px */
@media (max-width: 900px) {
  .steprev-root {
    flex-direction: column;
  }
  .steprev-left {
    width: 100%;
    position: static;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid var(--codesema-line);
  }
}

/* mobile density (<= 640px) */
@media (max-width: 640px) {
  .steprev-left {
    padding: 16px 14px 24px;
  }
  .steprev-title {
    font-size: 20px;
  }
  .steprev-banner {
    margin: 14px 12px 0;
    padding: 12px 13px;
  }
  .steprev-diff {
    padding: 14px 12px 48px;
  }
}
</style>

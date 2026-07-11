<script setup lang="ts">
// All optional fields (risk/take/check/rationale) have fallbacks.

import { computed, ref, watch } from 'vue'
import type { Finding } from '../composables/useDiff'
import { parseDiff, pickFiles, sameFile } from '../composables/useDiff'
import { riskMeta } from '../risk'
import type { ChapterView } from '../types'
import DiffView from './DiffView.vue'

const props = defineProps<{
  chapters: ChapterView[]
  findings: Finding[]
  diff: string
  selectedIndex: number
  readSet: Set<number>
  checkedSet: Set<number>
}>()

const emit = defineEmits<{
  back: []
  toggleRead: [index: number]
  toggleChecked: [index: number]
  navigate: [index: number]
}>()

const chapter = computed(() => props.chapters[props.selectedIndex])
const chapterNumber = computed(() => props.selectedIndex + 1)
const totalChapters = computed(() => props.chapters.length)

const isRead = computed(() => props.readSet.has(props.selectedIndex))
const isChecked = computed(() => props.checkedSet.has(props.selectedIndex))

const canPrev = computed(() => props.selectedIndex > 0)
const canNext = computed(() => props.selectedIndex < props.chapters.length - 1)

function goPrev() {
  if (canPrev.value) emit('navigate', props.selectedIndex - 1)
}
function goNext() {
  if (canNext.value) emit('navigate', props.selectedIndex + 1)
}

const fileFilter = ref('')

watch(() => props.selectedIndex, () => {
  fileFilter.value = ''
})

const filteredFiles = computed(() => {
  if (!chapter.value) return []
  const q = fileFilter.value.toLowerCase().trim()
  if (!q) return chapter.value.files
  return chapter.value.files.filter((f) => f.toLowerCase().includes(q))
})

function shortName(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

const chapterFindings = computed((): Finding[] => {
  if (!chapter.value) return []
  return chapter.value.finding_refs
    .map((i) => props.findings[i])
    .filter((f): f is Finding => !!f)
})

const chapterFindingCount = computed(() => chapterFindings.value.length)

const chapterFiles = computed(() => {
  if (!chapter.value || !props.diff) return []
  const parsed = parseDiff(props.diff, chapterFindings.value)
  return pickFiles(parsed.files, chapter.value.files)
})

const chapterDelta = computed(() => {
  let add = 0
  let del = 0
  for (const f of chapterFiles.value) {
    add += f.addCount
    del += f.delCount
  }
  return { add, del }
})

function scrollToFile(filePath: string) {
  if (typeof document === 'undefined') return
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
  <div v-if="chapter" class="chrev-root">

    <div class="chrev-left">

      <button class="chrev-back" @click="emit('back')">
        {{ $t('reviews.guidedBack') }}
      </button>

      <div class="chrev-nav">
        <button
          class="chrev-radio-btn"
          :class="{ 'chrev-radio-btn--done': isRead }"
          :title="isRead ? $t('reviews.guidedMarkUnread') : $t('reviews.guidedMarkRead')"
          @click="emit('toggleRead', selectedIndex)"
        >
          <span v-if="isRead" class="chrev-radio-check">✓</span>
        </button>

        <span class="chrev-which">
          {{ $t('reviews.guidedChapter') }} {{ chapterNumber }}
          <span class="chrev-which-total">/ {{ totalChapters }}</span>
        </span>

        <span class="chrev-spacer" />

        <button
          class="chrev-arrow"
          :disabled="!canPrev"
          :title="$t('reviews.guidedPrev')"
          :aria-label="$t('reviews.guidedPrev')"
          @click="goPrev"
        >
          ‹
        </button>
        <button
          class="chrev-arrow"
          :disabled="!canNext"
          :title="$t('reviews.guidedNext')"
          :aria-label="$t('reviews.guidedNext')"
          @click="goNext"
        >
          ›
        </button>
      </div>

      <h2 class="chrev-title">{{ chapter.title }}</h2>

      <div class="chrev-meta">
        <template v-if="chapter.risk && riskMeta(chapter.risk)">
          <span
            class="chrev-risk-badge"
            :class="[riskMeta(chapter.risk)!.textCls, riskMeta(chapter.risk)!.bgCls]"
          >
            <span class="chrev-risk-dot" :style="{ background: riskMeta(chapter.risk)!.dotColor }" />
            {{ $t(riskMeta(chapter.risk)!.label) }}
          </span>
        </template>
        <span class="chrev-delta">
          <span v-if="chapterDelta.add > 0" class="chrev-delta-add">+{{ chapterDelta.add }}</span>
          <span v-if="chapterDelta.del > 0" class="chrev-delta-del">−{{ chapterDelta.del }}</span>
        </span>
      </div>

      <p v-if="chapter.rationale" class="chrev-rationale">{{ chapter.rationale }}</p>

      <div v-if="chapter.check" class="chrev-towatch">
        <div class="chrev-towatch-tag">{{ $t('reviews.guidedToWatch') }}</div>
        <div class="chrev-towatch-row">
          <button
            class="chrev-check-btn"
            :class="{ 'chrev-check-btn--done': isChecked }"
            @click="emit('toggleChecked', selectedIndex)"
          >
            <span v-if="isChecked" class="chrev-check-mark">✓</span>
          </button>
          <span class="chrev-towatch-text" @click="emit('toggleChecked', selectedIndex)">{{ chapter.check }}</span>
        </div>
      </div>

      <div class="chrev-files">
        <div class="chrev-files-head">
          {{ $t('reviews.guidedFiles') }}
          <span class="chrev-files-count">{{ chapter.files.length }}</span>
        </div>
        <input
          v-model="fileFilter"
          class="chrev-filter"
          :placeholder="$t('reviews.guidedFileFilter')"
          type="text"
        />
        <div class="chrev-filelist">
          <div
            v-for="f in filteredFiles"
            :key="f"
            class="chrev-filerow"
            role="button"
            tabindex="0"
            @click="scrollToFile(f)"
            @keydown.enter="scrollToFile(f)"
          >
            <span class="chrev-fileicon">▤</span>
            <span class="chrev-filename" :title="f">{{ shortName(f) }}</span>
            <span class="chrev-filepath nolyra-muted">{{ f }}</span>
          </div>
          <p v-if="filteredFiles.length === 0" class="chrev-files-empty nolyra-muted">
            {{ $t('reviews.guidedFileEmpty') }}
          </p>
        </div>
      </div>

    </div>

    <div class="chrev-right">

      <div class="chrev-banner">
        <span class="chrev-banner-mark">✦</span>
        <div class="chrev-banner-body">
          <div class="chrev-banner-head">
            {{ $t('reviews.guidedBannerTitle') }}
            <span v-if="chapterFindingCount > 0" class="chrev-banner-count">
              {{ $t('reviews.guidedBannerCount', { n: chapterFindingCount }) }}
            </span>
          </div>
          <p v-if="chapter.take" class="chrev-banner-take">{{ chapter.take }}</p>
        </div>
      </div>

      <div v-if="diff" class="chrev-diff">
        <DiffView :files="chapterFiles" />
      </div>
      <p v-else class="nolyra-muted chrev-nodiff">{{ $t('reviews.noDiff') }}</p>

    </div>

  </div>

  <div v-else class="chrev-empty">
    <p class="nolyra-muted">{{ $t('reviews.chaptersEmpty') }}</p>
  </div>
</template>

<style scoped>
/* 2-column layout */
.chrev-root {
  display: flex;
  align-items: flex-start;
  min-height: 0;
}

/* left column */
.chrev-left {
  width: 384px;
  flex-shrink: 0;
  border-right: 1px solid var(--nolyra-line);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 24px 26px 32px;
  position: sticky;
  top: 0;
  max-height: 100vh;
  overflow-y: auto;
  background: color-mix(in srgb, var(--nolyra-panel) 60%, var(--nolyra-bg));
}

/* back button */
.chrev-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--nolyra-ink-3);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
  transition: color 0.12s ease;
}
.chrev-back:hover {
  color: var(--nolyra-accent);
}

/* nav toggle + arrows */
.chrev-nav {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* big read toggle */
.chrev-radio-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid var(--nolyra-line);
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.chrev-radio-btn--done {
  border-color: var(--nolyra-risk-low);
  background: var(--nolyra-risk-low);
}
.chrev-radio-check {
  font-size: 11px;
  color: #fff;
  line-height: 1;
  font-weight: 700;
}

.chrev-which {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--nolyra-ink-2);
}
.chrev-which-total {
  color: var(--nolyra-ink-3);
  font-weight: 400;
}

.chrev-spacer {
  flex: 1;
}

.chrev-arrow {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid var(--nolyra-line);
  background: var(--nolyra-panel);
  color: var(--nolyra-ink-2);
  font-size: 15px;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: border-color 0.1s ease;
  font-family: inherit;
}
.chrev-arrow:hover:not(:disabled) {
  border-color: var(--nolyra-ink-3);
}
.chrev-arrow:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* chapter title */
.chrev-title {
  font-family: var(--font-display);
  font-size: 23px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--nolyra-ink);
  margin: 16px 0 0;
  line-height: 1.15;
}

/* risk + delta meta */
.chrev-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0;
}

.chrev-risk-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
}
.chrev-risk-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.chapter-risk--high { color: var(--nolyra-risk-high); }
.chapter-risk-bg--high { background: var(--nolyra-risk-high-soft); }
.chapter-risk--med { color: var(--nolyra-risk-med); }
.chapter-risk-bg--med { background: var(--nolyra-risk-med-soft); }
.chapter-risk--low { color: var(--nolyra-risk-low); }
.chapter-risk-bg--low { background: var(--nolyra-risk-low-soft); }

.chrev-delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.chrev-delta-add { color: var(--nolyra-risk-low); }
.chrev-delta-del { color: var(--nolyra-risk-high); }

/* rationale */
.chrev-rationale {
  font-size: 13.5px;
  color: var(--nolyra-ink-2);
  line-height: 1.6;
  margin: 0;
  text-wrap: pretty;
}

/* to-watch amber box */
.chrev-towatch {
  border: 1px solid color-mix(in srgb, var(--nolyra-amber) 30%, transparent);
  border-radius: 10px;
  padding: 13px 14px;
  background: var(--nolyra-amber-soft);
  margin-top: 18px;
}
.chrev-towatch-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--nolyra-amber);
  margin-bottom: 9px;
}
.chrev-towatch-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  font-size: 13px;
  color: var(--nolyra-ink);
  line-height: 1.5;
}
.chrev-check-btn {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 4px;
  border: 1.5px solid var(--nolyra-amber);
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background 0.1s ease;
}
.chrev-check-btn--done {
  background: var(--nolyra-amber);
}
.chrev-check-mark {
  font-size: 10px;
  color: #fff;
  font-weight: 700;
}

/* file list */
.chrev-files {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 22px;
}
.chrev-files-head {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--nolyra-ink-3);
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}
.chrev-files-count {
  font-size: 10.5px;
  font-weight: 500;
  background: var(--nolyra-line-2);
  border-radius: 99px;
  padding: 0 6px;
  color: var(--nolyra-ink-3);
}
.chrev-filter {
  width: 100%;
  border: 1px solid var(--nolyra-line);
  border-radius: 8px;
  padding: 8px 11px;
  font-size: 12.5px;
  font-family: inherit;
  background: var(--nolyra-panel);
  color: var(--nolyra-ink);
  outline: none;
  transition: border-color 0.12s ease;
  box-sizing: border-box;
}
.chrev-filter:focus {
  border-color: var(--nolyra-accent);
}
.chrev-filelist {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.chrev-filerow {
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
.chrev-filerow:hover,
.chrev-filerow:focus-visible {
  background: color-mix(in srgb, var(--nolyra-line-2) 80%, var(--nolyra-bg));
}
.chrev-fileicon {
  font-size: 11px;
  color: var(--nolyra-ink-3);
  flex-shrink: 0;
}
.chrev-filename {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--nolyra-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.chrev-filepath {
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  display: none;
}
.chrev-files-empty {
  font-size: 12px;
  padding: 6px 0;
}

/* right column */
.chrev-right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
}

/* review banner */
.chrev-banner {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 14px 16px;
  margin: 16px 20px 0;
  border: 1px solid color-mix(in srgb, var(--nolyra-accent) 30%, transparent);
  border-radius: 12px;
  background: var(--nolyra-accent-soft);
}
.chrev-banner-mark {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--nolyra-accent);
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  font-family: var(--font-display);
  display: grid;
  place-items: center;
  letter-spacing: -0.02em;
}
.chrev-banner-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.chrev-banner-head {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--nolyra-ink);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.chrev-banner-count {
  font-size: 11px;
  font-weight: 600;
  background: var(--nolyra-panel);
  color: var(--nolyra-accent);
  border: 1px solid color-mix(in srgb, var(--nolyra-accent) 30%, transparent);
  border-radius: 999px;
  padding: 2px 9px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chrev-banner-take {
  font-size: 13px;
  line-height: 1.55;
  color: var(--nolyra-ink);
  margin: 6px 0 0;
  text-wrap: pretty;
}

/* diff */
.chrev-diff {
  padding: 20px 20px 60px;
}
.chrev-nodiff {
  padding: 24px;
  font-size: 13px;
}

/* empty fallback */
.chrev-empty {
  padding: 32px 24px;
  font-size: 13px;
}

/* responsive: stack below 900px */
@media (max-width: 900px) {
  .chrev-root {
    flex-direction: column;
  }
  .chrev-left {
    width: 100%;
    position: static;
    max-height: none;
    border-right: none;
    border-bottom: 1px solid var(--nolyra-line);
  }
}

/* mobile density (<= 640px) */
@media (max-width: 640px) {
  .chrev-left { padding: 16px 14px 24px; }
  .chrev-title { font-size: 20px; }
  .chrev-banner { margin: 14px 12px 0; padding: 12px 13px; }
  .chrev-diff { padding: 14px 12px 48px; }
}
</style>

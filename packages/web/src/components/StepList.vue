<script setup lang="ts">
// Deltas are computed from parsedDiff (prop), never from the agent.
// risk/take/check are optional; findingCount may be 0.

import { computed } from 'vue'
import type { ParsedDiff } from '../composables/useDiff'
import { sameFile } from '../composables/useDiff'
import { riskMeta } from '../risk'
import type { ChapterView } from '../types'

const props = defineProps<{
  chapters: ChapterView[]
  parsedDiff: ParsedDiff
  readSet?: Set<number>
}>()

const emit = defineEmits<{
  select: [index: number]
}>()

function chapterDelta(ch: ChapterView): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const chFile of ch.files) {
    const diffFile = props.parsedDiff.files.find((df) => sameFile(df.path, chFile))
    if (!diffFile) continue
    add += diffFile.addCount
    del += diffFile.delCount
  }
  return { add, del }
}

const firstUnreadIndex = computed(() => {
  const readSet = props.readSet ?? new Set<number>()
  for (let i = 0; i < props.chapters.length; i++) {
    if (!readSet.has(i)) return i
  }
  return -1
})

function isRead(index: number): boolean {
  return props.readSet?.has(index) ?? false
}

function onCardClick(index: number) {
  emit('select', index)
}
</script>

<template>
  <div class="chlist-root">

    <div class="chlist-header">
      <span class="chlist-title">{{ $t('reviews.chaptersTitle') }}</span>
      <span class="chlist-by">· {{ $t('reviews.chaptersBy') }}</span>
    </div>

    <div class="chlist-cards">
      <div
        v-for="(ch, i) in chapters"
        :key="i"
        class="chlist-card"
        :class="{ 'chlist-card--read': isRead(i) }"
        role="button"
        tabindex="0"
        @click="onCardClick(i)"
        @keydown.enter="onCardClick(i)"
        @keydown.space.prevent="onCardClick(i)"
      >
        <div class="chlist-card-top">
          <span class="chlist-radio" :class="{ 'chlist-radio--done': isRead(i) }">
            <span v-if="isRead(i)" class="chlist-radio-check">✓</span>
          </span>

          <div class="chlist-card-main">
            <div class="chlist-card-title">
              <span class="chlist-card-num">{{ i + 1 }}</span>
              <span>{{ ch.title }}</span>
            </div>

            <div class="chlist-card-meta">
              <template v-if="ch.risk && riskMeta(ch.risk)">
                <span
                  class="chlist-risk-badge"
                  :class="[riskMeta(ch.risk)!.textCls, riskMeta(ch.risk)!.bgCls]"
                >
                  <span
                    class="chlist-risk-dot"
                    :style="{ background: riskMeta(ch.risk)!.dotColor }"
                  />
                  {{ $t(riskMeta(ch.risk)!.label) }}
                </span>
              </template>

              <span class="chlist-delta">
                <template v-if="chapterDelta(ch).add > 0">
                  <span class="chlist-delta-add">+{{ chapterDelta(ch).add }}</span>
                </template>
                <template v-if="chapterDelta(ch).del > 0">
                  <span class="chlist-delta-del">−{{ chapterDelta(ch).del }}</span>
                </template>
              </span>

              <span class="chlist-files-count">
                ▤ {{ $t('reviews.chaptersFiles', { n: ch.files.length }) }}
              </span>

              <span v-if="ch.finding_refs.length > 0" class="chlist-findings-count">
                💬 {{ $t('reviews.chaptersFindings', { n: ch.finding_refs.length }) }}
              </span>
            </div>
          </div>

          <button
            v-if="i === firstUnreadIndex"
            class="chlist-cta"
            @click.stop="onCardClick(i)"
          >
            {{ $t('reviews.chaptersStart') }}
          </button>
        </div>

      </div>
    </div>

    <p v-if="chapters.length === 0" class="chlist-empty nolyra-muted">
      {{ $t('reviews.chaptersEmpty') }}
    </p>

  </div>
</template>

<style scoped>
.chlist-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 24px 22px;
}

/* header */
.chlist-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.chlist-title {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--nolyra-ink-3);
}

.chlist-by {
  font-size: 11px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--nolyra-ink-3);
}

/* cards */
.chlist-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chlist-card {
  border: 1px solid var(--nolyra-line);
  border-radius: 11px;
  background: var(--nolyra-panel);
  padding: 14px 15px;
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
  outline: none;
}

.chlist-card:hover {
  border-color: var(--nolyra-ink-3);
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.05);
}

.chlist-card:focus-visible {
  outline: 2px solid var(--nolyra-accent);
  outline-offset: 2px;
}

.chlist-card--read {
  opacity: 0.6;
}

.chlist-card--read:hover {
  opacity: 0.8;
}

/* main row */
.chlist-card-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* radio check */
.chlist-radio {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--nolyra-line);
  display: grid;
  place-items: center;
  margin-top: 1px;
  background: transparent;
  flex-shrink: 0;
}

.chlist-radio--done {
  border-color: var(--nolyra-risk-low);
  background: var(--nolyra-risk-low);
}

.chlist-radio-check {
  font-size: 9px;
  color: #fff;
  line-height: 1;
  font-weight: 700;
}

/* body */
.chlist-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.chlist-card-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--nolyra-ink);
  line-height: 1.35;
}

.chlist-card-num {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 400;
  color: var(--nolyra-ink-3);
  flex-shrink: 0;
}

/* meta */
.chlist-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 11px;
  margin-top: 9px;
}

/* risk badge */
.chlist-risk-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
}

.chlist-risk-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.chapter-risk--high {
  color: var(--nolyra-risk-high);
}
.chapter-risk-bg--high {
  background: var(--nolyra-risk-high-soft);
}
.chapter-risk--med {
  color: var(--nolyra-risk-med);
}
.chapter-risk-bg--med {
  background: var(--nolyra-risk-med-soft);
}
.chapter-risk--low {
  color: var(--nolyra-risk-low);
}
.chapter-risk-bg--low {
  background: var(--nolyra-risk-low-soft);
}

/* delta */
.chlist-delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.chlist-delta-add {
  color: var(--nolyra-risk-low);
}

.chlist-delta-del {
  color: var(--nolyra-risk-high);
}

/* files / notes */
.chlist-files-count,
.chlist-findings-count {
  font-size: 11.5px;
  color: var(--nolyra-ink-3);
}

/* cta */
.chlist-cta {
  flex-shrink: 0;
  align-self: center;
  padding: 8px 13px;
  border-radius: 8px;
  border: 0;
  background: var(--nolyra-accent);
  /* dark ink on orange: ~7.6:1 contrast, white capped at 2.6:1 (AA = 4.5:1) */
  color: var(--nolyra-bg);
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.12s ease;
}

.chlist-cta:hover {
  filter: brightness(1.05);
}

/* empty */
.chlist-empty {
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}
</style>

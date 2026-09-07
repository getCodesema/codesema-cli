<script setup lang="ts">
// review_first comes from the parent (narrative); all fields optional, never throws on missing data.

import { computed } from 'vue'
import { G } from '../glyphs'

type KeyChange = { title: string; detail: string }
type ReviewFirstItem = {
  point: string
  risk: 'high' | 'medium' | 'low'
  step_ref: number | null
  file: string | null
}

const props = defineProps<{
  // v2 prologue fields
  prologue?:
    | {
        why?: string
        what?: string
        key_changes?: KeyChange[]
      }
    | null
    | undefined
  reviewFirst?: ReviewFirstItem[] | null
  // v1 fallback
  intent?: string | null | undefined
  confidence?: string | null | undefined
  summary?: string | null
}>()

const hasPrologue = computed(
  () => !!(props.prologue?.why || props.prologue?.what || props.prologue?.key_changes?.length),
)

// Minimal markdown rendering (code spans, HTML-escaped) with no external dependency.
function renderInline(text: string): string {
  if (!text) {
    return ''
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code class="prologue-inline-code">$1</code>')
}
</script>

<template>
  <div class="prologue-root">
    <template v-if="hasPrologue">
      <section v-if="prologue?.why" class="prologue-block">
        <div class="prologue-block-tag">{{ $t('reviews.prologue.why') }}</div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <p class="prologue-block-body" v-html="renderInline(prologue.why)" />
      </section>

      <section v-if="prologue?.what" class="prologue-block">
        <div class="prologue-block-tag">{{ $t('reviews.prologue.what') }}</div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <p class="prologue-block-body" v-html="renderInline(prologue.what)" />
      </section>

      <section v-if="prologue?.key_changes?.length" class="prologue-block">
        <div class="prologue-block-tag">{{ $t('reviews.prologue.keyChanges') }}</div>
        <ul class="prologue-keys">
          <li v-for="(kc, i) in prologue.key_changes" :key="i" class="prologue-key-item">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span class="prologue-key-title" v-html="renderInline(kc.title)" />
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span v-if="kc.detail" class="prologue-key-detail" v-html="renderInline(kc.detail)" />
          </li>
        </ul>
      </section>

      <section v-if="reviewFirst?.length" class="prologue-block">
        <div class="prologue-block-tag">{{ $t('reviews.prologue.reviewFirst') }}</div>
        <div class="prologue-focus">
          <div v-for="(item, i) in reviewFirst" :key="i" class="prologue-focus-row">
            <span class="prologue-focus-dot" :data-r="item.risk" aria-hidden="true">{{
              G.dot
            }}</span>
            <div class="prologue-focus-content">
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span class="prologue-focus-title" v-html="renderInline(item.point)" />
            </div>
          </div>
        </div>
      </section>
    </template>

    <template v-else>
      <section v-if="intent" class="prologue-block">
        <div class="prologue-block-tag">{{ $t('reviews.intent') }}</div>
        <p class="prologue-block-body prologue-block-body--preformatted">{{ intent }}</p>
        <p
          v-if="confidence"
          class="prologue-confidence"
          :class="{
            'prologue-confidence--high': confidence === 'high',
            'prologue-confidence--med': confidence === 'medium',
            'prologue-confidence--low': confidence === 'low',
          }"
        >
          {{ $t('reviews.confidence') }} ·
          {{
            confidence === 'high'
              ? $t('reviews.confidenceHigh')
              : confidence === 'low'
                ? $t('reviews.confidenceLow')
                : $t('reviews.confidenceMedium')
          }}
        </p>
      </section>

      <section v-if="summary" class="prologue-block">
        <div class="prologue-block-tag">{{ $t('reviews.summary') }}</div>
        <p class="prologue-block-body prologue-block-body--preformatted">{{ summary }}</p>
      </section>

      <p v-if="!intent && !summary" class="prologue-empty empty">
        {{ $t('reviews.prologue.empty') }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.prologue-root {
  display: flex;
  flex-direction: column;
  gap: var(--row);
  padding: var(--row) 2ch;
}

.prologue-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.prologue-block-tag {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--accent);
}

.prologue-block-body {
  font-size: 18px;
}

.prologue-block-body--preformatted {
  white-space: pre-wrap;
}

:deep(.prologue-inline-code) {
  font-family: var(--font);
  background: var(--bg-raised);
  padding: 0 0.5ch;
  color: var(--accent);
}

.prologue-keys {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.prologue-key-item {
  display: flex;
  flex-direction: column;
  padding-left: 2ch;
  position: relative;
}

.prologue-key-item::before {
  content: '▪';
  position: absolute;
  left: 0;
  color: var(--accent);
}

.prologue-key-title {
  display: block;
  font-weight: 700;
}

.prologue-key-detail {
  display: block;
  color: var(--fg-dim);
}

.prologue-focus {
  display: flex;
  flex-direction: column;
}

.prologue-focus-row {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.prologue-focus-dot {
  flex-shrink: 0;
  color: var(--warn);
}

.prologue-focus-dot[data-r='high'] {
  color: var(--err);
}

.prologue-focus-dot[data-r='low'] {
  color: var(--ok);
}

.prologue-focus-content {
  flex: 1;
  min-width: 0;
}

.prologue-focus-title {
  display: block;
  font-weight: 700;
}

.prologue-confidence {
  font-size: 12px;
}

.prologue-confidence--high {
  color: var(--ok);
}

.prologue-confidence--med {
  color: var(--warn);
}

.prologue-confidence--low {
  color: var(--err);
}

.prologue-empty {
  margin-top: var(--row);
}
</style>

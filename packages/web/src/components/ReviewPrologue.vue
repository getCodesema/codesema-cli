<script setup lang="ts">
// review_first comes from the parent (narrative); all fields optional, never throws on missing data.

import { computed } from 'vue'

type KeyChange = { title: string; detail: string }
type ReviewFirstItem = {
  point: string
  risk: 'high' | 'medium' | 'low'
  chapter_ref: number | null
  file: string | null
}

const props = defineProps<{
  // v2 prologue fields
  prologue?: {
    why?: string
    what?: string
    key_changes?: KeyChange[]
  } | null
  reviewFirst?: ReviewFirstItem[] | null
  // v1 fallback
  intent?: string | null
  confidence?: string | null
  summary?: string | null
}>()

const RISK_DOT: Record<string, string> = {
  high: 'var(--nolyra-risk-high)',
  medium: 'var(--nolyra-risk-med)',
  low: 'var(--nolyra-risk-low)',
}

function riskDotColor(risk: string): string {
  return RISK_DOT[risk] ?? RISK_DOT.medium!
}

const hasPrologue = computed(() =>
  !!(props.prologue?.why || props.prologue?.what || props.prologue?.key_changes?.length),
)

// Minimal markdown rendering (code spans, HTML-escaped) with no external dependency.
function renderInline(text: string): string {
  if (!text) return ''
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
          <div
            v-for="(item, i) in reviewFirst"
            :key="i"
            class="prologue-focus-row"
          >
            <span
              class="prologue-focus-dot"
              :style="{ background: riskDotColor(item.risk) }"
            />
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

      <p v-if="!intent && !summary" class="prologue-empty nolyra-muted">
        {{ $t('reviews.prologue.empty') }}
      </p>

    </template>

  </div>
</template>

<style scoped>
.prologue-root {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 24px 26px;
}

.prologue-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.prologue-block-tag {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--nolyra-accent);
  margin-bottom: 0;
}

.prologue-block-body {
  font-size: 14.5px;
  line-height: 1.62;
  color: var(--nolyra-ink);
  margin: 0;
  text-wrap: pretty;
}

.prologue-block-body--preformatted {
  white-space: pre-wrap;
}

:deep(.prologue-inline-code) {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--nolyra-line-2);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--nolyra-accent);
}

.prologue-keys {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.prologue-key-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 16px;
  position: relative;
}

.prologue-key-item::before {
  content: "";
  position: absolute;
  left: 0;
  top: 7px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--nolyra-accent);
}

.prologue-key-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--nolyra-ink);
  line-height: 1.4;
}

.prologue-key-detail {
  display: block;
  font-size: 13px;
  color: var(--nolyra-ink-2);
  line-height: 1.5;
  margin-top: 2px;
}

.prologue-focus {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.prologue-focus-row {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}

.prologue-focus-dot {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
}

.prologue-focus-content {
  flex: 1;
  min-width: 0;
}

.prologue-focus-title {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--nolyra-ink);
  line-height: 1.5;
}

.prologue-confidence {
  font-size: 11.5px;
  margin: 0;
}

.prologue-confidence--high {
  color: var(--nolyra-risk-low);
}

.prologue-confidence--med {
  color: var(--nolyra-risk-med);
}

.prologue-confidence--low {
  color: var(--nolyra-risk-high);
}

.prologue-empty {
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}
</style>

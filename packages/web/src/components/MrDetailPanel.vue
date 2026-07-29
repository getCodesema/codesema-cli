<script setup lang="ts">
import type { ForgeMr } from '../types'

defineProps<{ mr: ForgeMr; running: boolean; runError?: string | null }>()
const emit = defineEmits<{ back: []; run: [mode: 'simple' | 'dual'] }>()
</script>

<template>
  <div class="mrd-root">
    <button class="mrd-back-btn" @click="emit('back')">{{ $t('mrs.detailBack') }}</button>

    <section class="mrd-section">
      <span class="mrd-eyebrow codesema-muted">{{ $t('mrs.detailTitle') }} {{ $t('mrs.number', { n: mr.number }) }}</span>
      <h1 class="mrd-title">{{ mr.title }}</h1>

      <dl class="mrd-fields">
        <div class="mrd-field">
          <dt class="codesema-muted">{{ $t('mrs.detailAuthor') }}</dt>
          <dd>{{ mr.author }}</dd>
        </div>
        <div class="mrd-field">
          <dt class="codesema-muted">{{ $t('mrs.detailSource') }}</dt>
          <dd class="mrd-branch">{{ mr.sourceBranch }}</dd>
        </div>
        <div class="mrd-field">
          <dt class="codesema-muted">{{ $t('mrs.detailTarget') }}</dt>
          <dd class="mrd-branch">{{ mr.targetBranch }}</dd>
        </div>
      </dl>

      <div class="mrd-actions">
        <button class="mrd-run-btn" :disabled="running" @click="emit('run', 'simple')">
          {{ $t('mrs.runReview') }}
        </button>
        <button class="mrd-run-btn" :disabled="running" @click="emit('run', 'dual')">
          {{ $t('mrs.runDualReview') }}
        </button>
        <a class="mrd-link-btn" :href="mr.url" target="_blank" rel="noopener noreferrer">
          {{ $t('mrs.detailOpenInForge') }}
        </a>
      </div>
      <p v-if="runError" class="mrd-error">{{ runError }}</p>
    </section>
  </div>
</template>

<style scoped>
.mrd-root {
  max-width: 640px;
  margin: 0 auto;
  padding: 32px 20px 60px;
}

.mrd-back-btn {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  cursor: pointer;
  margin-bottom: 20px;
  transition: border-color 0.12s ease;
}

.mrd-back-btn:hover {
  border-color: var(--codesema-ink-3);
}

.mrd-section {
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line);
  border-radius: 12px;
  padding: 24px;
}

.mrd-eyebrow {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.mrd-title {
  font-size: 19px;
  font-weight: 700;
  color: var(--codesema-ink);
  margin: 6px 0 20px;
  line-height: 1.4;
}

.mrd-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 22px;
}

.mrd-field {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}

.mrd-field dt {
  flex-shrink: 0;
  width: 120px;
  font-weight: 600;
}

.mrd-field dd {
  margin: 0;
  color: var(--codesema-ink);
}

.mrd-branch {
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.mrd-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.mrd-run-btn {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.mrd-run-btn:hover:not(:disabled) {
  border-color: var(--codesema-ink-3);
}

.mrd-run-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.mrd-link-btn {
  display: inline-block;
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--codesema-accent) 45%, transparent);
  background: var(--codesema-accent-soft);
  color: var(--codesema-accent);
  text-decoration: none;
  transition: border-color 0.12s ease;
}

.mrd-link-btn:hover {
  border-color: var(--codesema-accent);
}

.mrd-error {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--codesema-risk-high);
}
</style>

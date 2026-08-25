<script setup lang="ts">
import { computed } from 'vue'
import type { ForgeMr, LocalBranch, ReviewSource } from '../types'
import MrMetaRail from './mr/MrMetaRail.vue'
import PreviewPanel from './PreviewPanel.vue'

export type DetailSource = { kind: 'mr'; mr: ForgeMr } | { kind: 'branch'; branch: LocalBranch }

const props = defineProps<{ source: DetailSource; running: boolean; runError?: string | null }>()
const emit = defineEmits<{ back: []; run: [mode: 'simple' | 'dual'] }>()

const reviewSource = computed<ReviewSource>(() =>
  props.source.kind === 'mr'
    ? { kind: 'mr', number: props.source.mr.number }
    : { kind: 'branch', name: props.source.branch.name },
)
</script>

<template>
  <div class="mrd-root">
    <button class="mrd-back-btn" @click="emit('back')">{{ $t('mrs.detailBack') }}</button>

    <section class="mrd-section">
      <template v-if="source.kind === 'mr'">
        <span class="mrd-eyebrow codesema-muted"
          >{{ $t('mrs.detailTitle') }} {{ $t('mrs.number', { n: source.mr.number }) }}</span
        >
        <h1 class="mrd-title">{{ source.mr.title }}</h1>

        <dl class="mrd-fields">
          <div class="mrd-field">
            <dt class="codesema-muted">{{ $t('mrs.detailAuthor') }}</dt>
            <dd>{{ source.mr.author }}</dd>
          </div>
          <div class="mrd-field">
            <dt class="codesema-muted">{{ $t('mrs.detailSource') }}</dt>
            <dd class="mrd-branch">{{ source.mr.sourceBranch }}</dd>
          </div>
          <div class="mrd-field">
            <dt class="codesema-muted">{{ $t('mrs.detailTarget') }}</dt>
            <dd class="mrd-branch">{{ source.mr.targetBranch }}</dd>
          </div>
        </dl>
      </template>
      <template v-else>
        <span class="mrd-eyebrow codesema-muted">{{ $t('branches.detailTitle') }}</span>
        <h1 class="mrd-title mrd-title-mono">{{ source.branch.name }}</h1>

        <dl class="mrd-fields">
          <div class="mrd-field">
            <dt class="codesema-muted">{{ $t('branches.lastCommit') }}</dt>
            <dd>{{ source.branch.subject }} ({{ source.branch.lastCommitRelative }})</dd>
          </div>
          <div v-if="source.branch.worktreePath" class="mrd-field">
            <dt class="codesema-muted">{{ $t('branches.inWorktree') }}</dt>
            <dd class="mrd-branch">{{ source.branch.worktreePath }}</dd>
          </div>
        </dl>
      </template>

      <div class="mrd-actions">
        <button class="mrd-run-btn" :disabled="running" @click="emit('run', 'simple')">
          {{ $t('mrs.runReview') }}
        </button>
        <button class="mrd-run-btn" :disabled="running" @click="emit('run', 'dual')">
          {{ $t('mrs.runDualReview') }}
        </button>
        <a
          v-if="source.kind === 'mr'"
          class="mrd-link-btn"
          :href="source.mr.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ $t('mrs.detailOpenInForge') }}
        </a>
      </div>
      <p v-if="runError" class="mrd-error">{{ runError }}</p>
    </section>

    <section v-if="source.kind === 'mr'" class="mrd-section mrd-rail">
      <MrMetaRail :mr="source.mr" />
    </section>

    <section class="mrd-section mrd-preview">
      <PreviewPanel :source="reviewSource" />
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

.mrd-title-mono {
  font-family: var(--font-mono);
  font-size: 16px;
}

.mrd-rail {
  margin-top: 20px;
}

.mrd-preview {
  margin-top: 20px;
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

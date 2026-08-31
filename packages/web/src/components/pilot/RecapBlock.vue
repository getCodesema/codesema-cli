<script setup lang="ts">
import { computed } from 'vue'
import { t, type MessageKey } from '../../i18n'
import { renderMarkdown } from '../../markdown'
import type { RecapRecord, RecapTestStatus } from '../../types'

const props = defineProps<{
  recap?: RecapRecord | null
}>()

const pending = computed(() => props.recap == null)
const summaryHtml = computed(() => (props.recap ? renderMarkdown(props.recap.summary) : ''))

/** Every RecapTestStatus mapped onto an EXISTING i18n word, no key of its own
 * exists for a recap test row, so this reuses the per-check words (shared
 * with the sandboxed checks tab) plus the two whole-run phrases for the
 * synthetic 'unconfigured'/'error' entry a recap's tests[] can carry. */
const RECAP_TEST_STATUS_KEY: Record<RecapTestStatus, MessageKey> = {
  passed: 'workspace.checkPassed',
  failed: 'workspace.checkFailed',
  timeout: 'workspace.checkTimeout',
  skipped: 'workspace.checkSkipped',
  unconfigured: 'workspace.checksStatusUnconfigured',
  error: 'workspace.checksStatusError',
}
</script>

<template>
  <section class="rcb-root">
    <h3 class="rcb-title">{{ t('pilot.recap.title') }}</h3>
    <p v-if="pending" class="rcb-pending">{{ t('pilot.recap.pending') }}</p>
    <template v-else-if="recap">
      <!-- eslint-disable-next-line vue/no-v-html: renderMarkdown escapes everything first -->
      <div class="rcb-summary rcb-md" v-html="summaryHtml" />
      <div v-if="recap.changes.length > 0" class="rcb-section">
        <h4 class="rcb-section-title">{{ t('pilot.recap.changes') }}</h4>
        <ul class="rcb-list">
          <li v-for="(change, i) in recap.changes" :key="i">{{ change }}</li>
        </ul>
      </div>
      <div v-if="recap.decisions.length > 0" class="rcb-section">
        <h4 class="rcb-section-title">{{ t('pilot.recap.decisions') }}</h4>
        <ul class="rcb-list">
          <li v-for="(decision, i) in recap.decisions" :key="i">{{ decision }}</li>
        </ul>
      </div>
      <div v-if="recap.files.length > 0" class="rcb-section">
        <h4 class="rcb-section-title">{{ t('pilot.recap.files') }}</h4>
        <ul class="rcb-list rcb-list--mono">
          <li v-for="file in recap.files" :key="file">{{ file }}</li>
        </ul>
      </div>
      <div v-if="recap.tests.length > 0" class="rcb-section">
        <h4 class="rcb-section-title">{{ t('pilot.recap.tests') }}</h4>
        <ul class="rcb-list rcb-list--mono">
          <li v-for="(test, i) in recap.tests" :key="i">
            {{ test.command }} : {{ t(RECAP_TEST_STATUS_KEY[test.status]) }}
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.rcb-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rcb-title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.rcb-pending {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-muted);
}

.rcb-summary {
  font-size: 13px;
  line-height: 1.55;
  color: var(--cs-text);
}

.rcb-section-title {
  margin: 0 0 4px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.rcb-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--cs-text);
}

.rcb-list--mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.rcb-md :deep(p),
.rcb-md :deep(ul),
.rcb-md :deep(ol),
.rcb-md :deep(pre) {
  margin: 0 0 8px;
}

.rcb-md :deep(:last-child) {
  margin-bottom: 0;
}

.rcb-md :deep(h2),
.rcb-md :deep(h3) {
  margin: 12px 0 6px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--cs-text);
}

.rcb-md :deep(h2:first-child),
.rcb-md :deep(h3:first-child) {
  margin-top: 0;
}

.rcb-md :deep(ul),
.rcb-md :deep(ol) {
  padding-left: 20px;
}

.rcb-md :deep(li) {
  margin: 2px 0;
}

.rcb-md :deep(code) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--cs-green-text);
  white-space: pre-wrap;
}

.rcb-md :deep(pre) {
  padding: 9px 11px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  overflow-x: auto;
}

.rcb-md :deep(pre code) {
  color: var(--cs-text);
}

.rcb-md :deep(a) {
  color: var(--cs-green-hover);
}
</style>

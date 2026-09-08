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
      <dl class="rcb-sections kvs">
        <template v-if="recap.changes.length > 0">
          <dt class="rcb-section-title">{{ t('pilot.recap.changes') }}</dt>
          <dd>
            <ul class="rcb-list">
              <li v-for="(change, i) in recap.changes" :key="i">{{ change }}</li>
            </ul>
          </dd>
        </template>
        <template v-if="recap.decisions.length > 0">
          <dt class="rcb-section-title">{{ t('pilot.recap.decisions') }}</dt>
          <dd>
            <ul class="rcb-list">
              <li v-for="(decision, i) in recap.decisions" :key="i">{{ decision }}</li>
            </ul>
          </dd>
        </template>
        <template v-if="recap.files.length > 0">
          <dt class="rcb-section-title">{{ t('pilot.recap.files') }}</dt>
          <dd>
            <ul class="rcb-list rcb-list--mono">
              <li v-for="file in recap.files" :key="file">{{ file }}</li>
            </ul>
          </dd>
        </template>
        <template v-if="recap.tests.length > 0">
          <dt class="rcb-section-title">{{ t('pilot.recap.tests') }}</dt>
          <dd>
            <ul class="rcb-list rcb-list--mono">
              <li v-for="(test, i) in recap.tests" :key="i">
                {{ test.command }} : {{ t(RECAP_TEST_STATUS_KEY[test.status]) }}
              </li>
            </ul>
          </dd>
        </template>
      </dl>
    </template>
  </section>
</template>

<style scoped>
.rcb-root {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.rcb-title {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.rcb-pending {
  margin: 0;
  color: var(--fg-dim);
}

.rcb-summary {
  color: var(--fg);
}

.rcb-section-title {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.rcb-list {
  margin: 0;
  padding-left: 2ch;
  color: var(--fg);
}

.rcb-list--mono {
  font-size: 12px;
}

.rcb-md :deep(p),
.rcb-md :deep(ul),
.rcb-md :deep(ol),
.rcb-md :deep(pre) {
  margin: 0 0 calc(var(--row) / 2);
}

.rcb-md :deep(:last-child) {
  margin-bottom: 0;
}

.rcb-md :deep(h2),
.rcb-md :deep(h3) {
  margin: var(--row) 0 calc(var(--row) / 2);
  font-size: var(--fs);
  font-weight: 700;
  color: var(--fg);
}

.rcb-md :deep(h2:first-child),
.rcb-md :deep(h3:first-child) {
  margin-top: 0;
}

.rcb-md :deep(ul),
.rcb-md :deep(ol) {
  padding-left: 2ch;
}

.rcb-md :deep(code) {
  font-size: 12px;
  color: var(--ok);
  white-space: pre-wrap;
}

.rcb-md :deep(pre) {
  padding: calc(var(--row) / 2) 1ch;
  background: var(--bg-raised);
  overflow-x: auto;
}

.rcb-md :deep(pre code) {
  color: var(--fg);
}

.rcb-md :deep(a) {
  color: var(--accent);
}
</style>

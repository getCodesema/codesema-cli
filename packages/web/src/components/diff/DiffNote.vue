<script setup lang="ts">
import type { Finding, FindingKind, FindingSeverity } from '../../composables/useDiff'
import { t, type MessageKey } from '../../i18n'

defineProps<{ finding: Finding }>()

const KIND_LABEL_KEYS: Record<FindingKind, MessageKey> = {
  security: 'diffView.kindSecurity',
  perf: 'diffView.kindPerf',
  convention: 'diffView.kindConvention',
  design: 'diffView.kindDesign',
  praise: 'diffView.kindPraise',
  why: 'diffView.kindWhy',
}

const SEVERITY_LABEL_KEYS: Record<FindingSeverity, MessageKey> = {
  critical: 'diffView.sevCritical',
  major: 'diffView.sevMajor',
  minor: 'diffView.sevMinor',
  info: 'diffView.sevInfo',
}

function kindLabel(kind: FindingKind): string {
  return t(KIND_LABEL_KEYS[kind])
}

function severityLabel(severity: FindingSeverity): string {
  return t(SEVERITY_LABEL_KEYS[severity])
}

function richParts(s: string): { text: string; isCode: boolean }[] {
  return s.split(/(`[^`]+`)/g).map((p) => ({
    text: p.startsWith('`') && p.endsWith('`') ? p.slice(1, -1) : p,
    isCode: p.startsWith('`') && p.endsWith('`'),
  }))
}
</script>

<template>
  <div class="note nlr-note" :data-kind="finding.kind" :data-finding-id="finding.id">
    <div class="h">
      <span v-if="finding.kind" class="kind nlr-kind">{{ kindLabel(finding.kind) }}</span>
      <span class="sev" :data-v="finding.severity">{{ severityLabel(finding.severity) }}</span>
      <span v-if="finding.title" class="t nlr-note-title">
        <template v-for="(part, j) in richParts(finding.title)" :key="j">
          <code v-if="part.isCode">{{ part.text }}</code>
          <template v-else>{{ part.text }}</template>
        </template>
      </span>
      <span class="who nlr-name">{{
        finding.consensus ? t('finding.consensus') : t('note.author')
      }}</span>
    </div>
    <p class="nlr-note-body">
      <template v-for="(part, j) in richParts(finding.message)" :key="j">
        <code v-if="part.isCode">{{ part.text }}</code>
        <template v-else>{{ part.text }}</template>
      </template>
    </p>
    <template v-if="finding.suggestion">
      <span class="muted nlr-sugg-head">{{ t('diffView.suggestionLabel') }}</span>
      <pre class="nlr-sugg-code">{{ finding.suggestion }}</pre>
    </template>
  </div>
</template>

<style scoped>
.nlr-sugg-head {
  font-size: 12px;
}

.nlr-note--flash {
  border-color: var(--accent);
}
</style>

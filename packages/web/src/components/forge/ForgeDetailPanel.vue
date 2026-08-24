<script setup lang="ts">
// The forge board's detail panel: always visible, not conditioned on a
// selection, with a clean empty state while nothing is selected in the list
// panel (see ForgeBoard.vue). Once something is selected, it reuses the
// existing presentational cards (ForgeIssueCard / MrCard) with a close
// action and the external "open in forge" link that used to live on every
// list item; a richer detail view is a later lot.
import { computed } from 'vue'
import { t } from '../../i18n'
import MrCard from '../mr/MrCard.vue'
import ForgeIssueCard from './ForgeIssueCard.vue'
import type { ForgeDetailItem } from './ForgeLogic'

const props = defineProps<{ item: ForgeDetailItem | null }>()

const emit = defineEmits<{ close: [] }>()

const title = computed(() => {
  if (props.item === null) {
    return null
  }
  return props.item.kind === 'issue' ? props.item.issue.title : props.item.mr.title
})
const url = computed(() => {
  if (props.item === null) {
    return null
  }
  return props.item.kind === 'issue' ? props.item.issue.url : props.item.mr.url
})
</script>

<template>
  <div class="fdp-root">
    <template v-if="item !== null">
      <header class="fdp-head">
        <h2 class="fdp-title">{{ t('forge.detailTitle') }}</h2>
        <a
          class="fdp-open"
          :href="url ?? undefined"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="t('forge.openItemAria', { title })"
        >
          <span aria-hidden="true">↗</span>
        </a>
        <button
          type="button"
          class="fdp-close"
          :aria-label="t('forge.detailClose')"
          @click="emit('close')"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>
      <ForgeIssueCard v-if="item.kind === 'issue'" :issue="item.issue" />
      <MrCard v-else :mr="item.mr" />
    </template>
    <p v-else class="fdp-empty">{{ t('forge.detailEmpty') }}</p>
  </div>
</template>

<style scoped>
.fdp-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
}

.fdp-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fdp-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--cs-text);
}

.fdp-open,
.fdp-close {
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-family: inherit;
  line-height: 1;
  border: 1px solid var(--cs-line-2);
  border-radius: 7px;
  background: var(--cs-surface);
  color: var(--cs-muted);
  text-decoration: none;
  cursor: pointer;
}

.fdp-open:hover,
.fdp-close:hover {
  border-color: var(--cs-line-3);
  color: var(--cs-text-2);
}

.fdp-empty {
  margin: auto;
  text-align: center;
  font-size: 12px;
  color: var(--cs-ghost);
  max-width: 220px;
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import {
  CHECK_GLYPH,
  CHECK_STATUS_KEY,
  CHECKS_STATUS_KEY,
  checksTone,
} from '../../composables/useChecks'
import { t } from '../../i18n'
import type { TaskChecks } from '../../types'

const props = defineProps<{
  checks?: TaskChecks | null
}>()

const tone = computed(() => checksTone(props.checks ?? null))
</script>

<template>
  <section class="ckb-root">
    <h3 class="ckb-title">{{ t('pilot.checks.title') }}</h3>
    <p v-if="checks == null" class="ckb-empty">{{ t('workspace.checksNeverRan') }}</p>
    <template v-else>
      <p class="ckb-verdict" :class="`ckb-verdict--${tone}`">
        {{ t(CHECKS_STATUS_KEY[checks.status]) }}
      </p>
      <ul v-if="checks.checks.length > 0" class="ckb-list checks">
        <li
          v-for="(check, i) in checks.checks"
          :key="`${check.command}-${i}`"
          class="ckb-row check-row"
          :data-s="check.status"
        >
          <span class="ckb-glyph g" aria-hidden="true">{{ CHECK_GLYPH[check.status] }}</span>
          <span class="ckb-command">{{ check.command }}</span>
          <span class="ckb-status r">{{ t(CHECK_STATUS_KEY[check.status]) }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.ckb-root {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.ckb-title {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.ckb-empty {
  margin: 0;
  color: var(--fg-dim);
}

.ckb-verdict {
  margin: 0;
  font-weight: 700;
  color: var(--fg-dim);
}

.ckb-verdict--pass {
  color: var(--ok);
}

.ckb-verdict--fail {
  color: var(--err);
}

.ckb-verdict--warn {
  color: var(--warn);
}

.ckb-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ckb-row {
  grid-template-columns: 2ch 1fr auto;
}

.ckb-command {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>

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
      <ul v-if="checks.checks.length > 0" class="ckb-list">
        <li v-for="(check, i) in checks.checks" :key="`${check.command}-${i}`" class="ckb-row">
          <span class="ckb-glyph" :class="`ckb-glyph--${check.status}`" aria-hidden="true">{{
            CHECK_GLYPH[check.status]
          }}</span>
          <span class="ckb-command">{{ check.command }}</span>
          <span class="ckb-status">{{ t(CHECK_STATUS_KEY[check.status]) }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.ckb-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ckb-title {
  margin: 0;
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.ckb-empty {
  margin: 0;
  font-size: var(--fs);
  color: var(--fg-dim);
}

.ckb-verdict {
  margin: 0;
  font-size: var(--fs);
  font-weight: 600;
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
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ckb-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.ckb-glyph {
  flex: none;
  font-family: var(--font);
  color: var(--fg-dim);
}

.ckb-glyph--passed {
  color: var(--ok);
}

.ckb-glyph--failed,
.ckb-glyph--timeout {
  color: var(--err);
}

.ckb-command {
  font-family: var(--font);
  color: var(--fg);
  overflow-wrap: anywhere;
}

.ckb-status {
  margin-left: auto;
  flex: none;
  color: var(--fg-dim);
}
</style>

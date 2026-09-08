<script setup lang="ts">
import { G } from '../glyphs'
import { t } from '../i18n'
import { PALETTES, usePalette, type Contrast } from '../theme'

// Client-only preference: lives in this browser's localStorage, never in the
// repo config, so it is deliberately outside the settings load/save cycle.
const { palette, contrast } = usePalette()

withDefaults(
  defineProps<{
    /** Rail shape: a select plus a two-button segment, no panel around it. */
    compact?: boolean
    /** Rail is collapsed to its icon track: only the swap button fits. */
    collapsed?: boolean
  }>(),
  { compact: false, collapsed: false },
)

const emit = defineEmits<{ expand: [] }>()

const CONTRASTS: readonly {
  id: Contrast
  label: 'settings.contrastAa' | 'settings.contrastAaa'
}[] = [
  { id: 'aa', label: 'settings.contrastAa' },
  { id: 'aaa', label: 'settings.contrastAaa' },
]
</script>

<template>
  <button
    v-if="compact && collapsed"
    type="button"
    class="tp-swap"
    :title="t('settings.paletteLabel')"
    :aria-label="t('settings.paletteLabel')"
    @click="emit('expand')"
  >
    <span aria-hidden="true">{{ G.swap }}</span>
  </button>

  <div v-else-if="compact" class="tp-compact">
    <select v-model="palette" class="tp-select" :aria-label="t('settings.paletteLabel')">
      <option v-for="option in PALETTES" :key="option.id" :value="option.id">
        {{ option.label }}
      </option>
    </select>
    <div class="seg tp-contrast" role="group" :aria-label="t('settings.contrastLabel')">
      <button
        v-for="option in CONTRASTS"
        :key="option.id"
        type="button"
        :aria-pressed="contrast === option.id"
        @click="contrast = option.id"
      >
        {{ t(option.label) }}
      </button>
    </div>
  </div>

  <section v-else class="panel tp-root">
    <span class="panel-title left">{{ t('settings.themeTitle') }}</span>
    <p class="muted">{{ t('settings.themeHint') }}</p>
    <div class="tp-groups">
      <div class="seg palettes" role="group" :aria-label="t('settings.paletteLabel')">
        <button
          v-for="option in PALETTES"
          :key="option.id"
          type="button"
          :aria-pressed="palette === option.id"
          @click="palette = option.id"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="seg" role="group" :aria-label="t('settings.contrastLabel')">
        <button
          v-for="option in CONTRASTS"
          :key="option.id"
          type="button"
          :aria-pressed="contrast === option.id"
          @click="contrast = option.id"
        >
          {{ t(option.label) }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tp-root {
  display: flex;
  flex-direction: column;
  gap: var(--row);
}

.tp-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 2ch var(--row);
  align-items: start;
}

.tp-compact {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: calc(var(--row) / 2) 1ch;
}

.tp-select {
  flex: 1;
  min-width: 0;
  font: inherit;
  padding: 0 1ch;
}

.tp-contrast {
  flex: none;
}

.tp-contrast button {
  padding: 0 1ch;
  font-size: 12px;
}

.tp-swap {
  display: block;
  width: 100%;
  font: inherit;
  border: none;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 2px 1ch;
}

.tp-swap:hover {
  color: var(--fg);
}
</style>

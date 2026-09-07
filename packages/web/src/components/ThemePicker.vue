<script setup lang="ts">
import { PALETTES, usePalette, type Contrast } from '../theme'

// Client-only preference: lives in this browser's localStorage, never in the
// repo config, so it is deliberately outside the settings load/save cycle.
const { palette, contrast } = usePalette()

const CONTRASTS: readonly {
  id: Contrast
  label: 'settings.contrastAa' | 'settings.contrastAaa'
}[] = [
  { id: 'aa', label: 'settings.contrastAa' },
  { id: 'aaa', label: 'settings.contrastAaa' },
]
</script>

<template>
  <section class="panel tp-root">
    <span class="panel-title left">{{ $t('settings.themeTitle') }}</span>
    <p class="muted">{{ $t('settings.themeHint') }}</p>
    <div class="tp-groups">
      <div class="seg palettes" role="group" :aria-label="$t('settings.paletteLabel')">
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
      <div class="seg" role="group" :aria-label="$t('settings.contrastLabel')">
        <button
          v-for="option in CONTRASTS"
          :key="option.id"
          type="button"
          :aria-pressed="contrast === option.id"
          @click="contrast = option.id"
        >
          {{ $t(option.label) }}
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
</style>

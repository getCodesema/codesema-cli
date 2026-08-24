<script setup lang="ts">
// Shared accordion chrome for one Issue Radar list (issues or pull requests):
// a foldable header with its count and, when the forge capped the list, an
// explicit caveat line, never silence on a truncated result. The controls
// row (sort / status filter / labels) and the item list are slots: this
// component owns no fetch, no filter, no sort, only the fold state display.
defineProps<{
  label: string
  /** Null when the count is not actually known yet (loading, transport error,
   * forge unavailable): never a fabricated 0 that would read as "empty". */
  count: number | null
  /** Set only when the forge's own `truncated` flag is true; null otherwise. */
  truncatedHint: string | null
  open: boolean
}>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()
</script>

<template>
  <section class="ra-root">
    <button class="ra-head" :aria-expanded="open" @click="emit('update:open', !open)">
      <span class="ra-chevron" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="ra-label">{{ label }}</span>
      <span v-if="count !== null" class="ra-count">{{ count }}</span>
    </button>
    <p v-if="truncatedHint" class="ra-truncated">{{ truncatedHint }}</p>
    <template v-if="open">
      <div v-if="$slots.filters || $slots.labels" class="ra-controls">
        <div v-if="$slots.filters" class="ra-controls-row">
          <slot name="filters" />
        </div>
        <div v-if="$slots.labels" class="ra-controls-row">
          <slot name="labels" />
        </div>
      </div>
      <div class="ra-body">
        <slot />
      </div>
    </template>
  </section>
</template>

<style scoped>
.ra-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ra-head {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  font-family: inherit;
  padding: 4px;
  margin: -4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.ra-head:hover {
  background: var(--cs-hover);
}

.ra-chevron {
  flex: none;
  width: 10px;
  font-size: 10px;
  color: var(--cs-ghost);
}

.ra-label {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--cs-text);
}

.ra-count {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--cs-ghost);
  font-variant-numeric: tabular-nums;
}

.ra-truncated {
  margin: -4px 0 0;
  padding-left: 18px;
  font-size: 11px;
  color: var(--cs-ghost);
}

.ra-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ra-controls-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ra-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>

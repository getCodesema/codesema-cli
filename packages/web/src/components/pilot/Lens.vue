<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { t } from '../../i18n'

defineProps<{
  title: string
  flush?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const closeButton = ref<HTMLButtonElement | null>(null)

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  closeButton.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="pl-lens"
      role="dialog"
      aria-modal="true"
      :aria-label="t('pilot.lens.aria')"
      @click="emit('close')"
    >
      <div class="pl-lens-bar" @click.stop>
        <button
          ref="closeButton"
          class="pl-lens-close btn ghost"
          type="button"
          @click="emit('close')"
        >
          {{ t('pilot.lens.close') }}
        </button>
        <span class="pl-lens-title">{{ title }}</span>
      </div>
      <div class="pl-lens-body">
        <div class="pl-lens-slot" :class="flush ? 'pl-lens-slot--flush' : 'panel'" @click.stop>
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pl-lens {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  display: grid;
  grid-template-rows: calc(var(--row) * 2) 1fr;
}

.pl-lens-bar {
  display: flex;
  align-items: center;
  gap: 2ch;
  padding: 0 2ch;
  color: var(--fg-dim);
}

.pl-lens-close {
  color: var(--fg-dim);
  border-color: var(--line);
}

.pl-lens-close:hover {
  color: var(--fg);
}

.pl-lens-title {
  color: var(--fg);
  font-weight: 700;
}

.pl-lens-body {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  place-items: center;
  padding: 0 2ch var(--row);
  min-height: 0;
}

.pl-lens-slot {
  width: min(1100px, 100%);
  min-width: 0;
  max-height: 100%;
  overflow: auto;
  background: var(--bg);
}

.pl-lens-slot--flush {
  width: auto;
  overflow: visible;
  padding: 0;
  border: 0;
  background: transparent;
}
</style>

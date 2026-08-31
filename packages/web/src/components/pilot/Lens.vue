<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { t } from '../../i18n'

defineProps<{
  title: string
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
        <button ref="closeButton" class="pl-lens-close" type="button" @click="emit('close')">
          {{ t('pilot.lens.close') }}
        </button>
        <span class="pl-lens-title">{{ title }}</span>
      </div>
      <div class="pl-lens-body">
        <div class="pl-lens-slot" @click.stop>
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
  background: color-mix(in srgb, var(--cs-bg) 78%, transparent);
  backdrop-filter: blur(4px);
  display: grid;
  grid-template-rows: 44px 1fr;
}

.pl-lens-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px;
  color: var(--cs-text-2);
}

.pl-lens-close {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border: 1px solid var(--cs-line-3);
  border-radius: 8px;
  background: transparent;
  color: var(--cs-text-2);
  cursor: pointer;
}

.pl-lens-close:hover {
  color: var(--cs-text);
  border-color: var(--cs-line-2);
}

.pl-lens-close:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: 2px;
}

.pl-lens-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--cs-text);
}

.pl-lens-body {
  display: grid;
  place-items: center;
  padding: 0 24px 24px;
  min-height: 0;
}

.pl-lens-slot {
  min-width: 0;
  max-width: 100%;
  max-height: 100%;
}
</style>

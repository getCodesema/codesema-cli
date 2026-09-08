<script setup lang="ts">
import { G } from '../../glyphs'
import { t } from '../../i18n'

defineProps<{
  options: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{ pick: [option: string]; other: [] }>()
</script>

<template>
  <div v-if="options.length > 0" class="qr-quick qr">
    <button
      v-for="option in options"
      :key="option"
      class="qr-opt btn"
      type="button"
      :disabled="disabled"
      @click="emit('pick', option)"
    >
      {{ G.arrow }} {{ option }}
    </button>
    <button class="qr-other" type="button" @click="emit('other')">
      {{ t('workspace.quickReplyOther') }}
    </button>
  </div>
</template>

<style scoped>
/* Amber: answering IS the pending human action. The kit's own `.qr .btn`
   look, kept scoped because the option buttons carry their BEM class alone. */
.qr-opt,
.qr-other {
  font: inherit;
  padding: 2px 2ch;
  border: 1px solid var(--warn);
  background: transparent;
  color: var(--warn);
  cursor: pointer;
  overflow-wrap: anywhere;
  text-align: left;
}

.qr-opt:hover:not(:disabled) {
  background: var(--bg-hover);
}

.qr-opt:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.qr-other {
  border-color: transparent;
  color: var(--fg-dim);
}

.qr-other:hover {
  color: var(--fg);
}
</style>

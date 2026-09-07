<script setup lang="ts">
import { t } from '../../i18n'

defineProps<{
  options: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{ pick: [option: string]; other: [] }>()
</script>

<template>
  <div v-if="options.length > 0" class="qr-quick">
    <button
      v-for="option in options"
      :key="option"
      class="qr-opt"
      type="button"
      :disabled="disabled"
      @click="emit('pick', option)"
    >
      → {{ option }}
    </button>
    <button class="qr-other" type="button" @click="emit('other')">
      {{ t('workspace.quickReplyOther') }}
    </button>
  </div>
</template>

<style scoped>
/* ── Quick replies ────────────────────────────────────────────────────── */
.qr-quick {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}

/* Amber: answering IS the pending human action. */
.qr-opt {
  font-size: var(--fs);
  font-weight: 600;
  font-family: inherit;
  padding: 8px 14px;
  border: 1px solid var(--warn);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--warn);
  cursor: pointer;
  overflow-wrap: anywhere;
  text-align: left;
}

.qr-opt:hover:not(:disabled) {
  border-color: var(--warn);
}

.qr-opt:disabled {
  opacity: 0.5;
  cursor: default;
}

.qr-other {
  font-size: var(--fs);
  font-family: inherit;
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
}

.qr-other:hover {
  color: var(--fg);
}
</style>

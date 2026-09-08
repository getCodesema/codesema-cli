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
      class="qr-opt btn ghost"
      type="button"
      :disabled="disabled"
      @click="emit('pick', option)"
    >
      {{ G.arrow }} {{ option }}
    </button>
    <button class="qr-other btn ghost" type="button" @click="emit('other')">
      {{ t('workspace.quickReplyOther') }}
    </button>
  </div>
</template>

<style scoped>
/* A suggested answer is an offer, not a state: no tone colour, only the
   kit's ghost button. */
.qr-opt,
.qr-other {
  overflow-wrap: anywhere;
  text-align: left;
}

.qr-opt:hover:not(:disabled),
.qr-other:hover {
  color: var(--fg);
}
</style>

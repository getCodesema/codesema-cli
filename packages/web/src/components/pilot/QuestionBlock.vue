<script setup lang="ts">
import { t } from '../../i18n'
import QuickReplies from '../composer/QuickReplies.vue'

defineProps<{
  question: string | null
  options: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{ pick: [option: string]; other: [] }>()
</script>

<template>
  <div v-if="question !== null" class="qsb-root">
    <p class="qsb-banner">{{ t('pilot.question.waiting') }}</p>
    <p class="qsb-question">{{ question }}</p>
    <QuickReplies
      :options="options"
      :disabled="disabled"
      @pick="emit('pick', $event)"
      @other="emit('other')"
    />
  </div>
</template>

<style scoped>
.qsb-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--warn);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.qsb-banner {
  margin: 0;
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--warn);
}

.qsb-question {
  margin: 0;
  font-size: var(--fs);
  line-height: 1.5;
  color: var(--fg);
}
</style>

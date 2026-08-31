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
  border: 1px solid var(--cs-amber-line);
  border-radius: 8px;
  background: var(--cs-amber-soft);
}

.qsb-banner {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-amber-text);
}

.qsb-question {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--cs-text);
}
</style>

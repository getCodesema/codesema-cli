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
  <div v-if="question !== null" class="qsb-root question">
    <p class="qsb-banner">{{ t('pilot.question.waiting') }}</p>
    <p class="qsb-question q">{{ question }}</p>
    <QuickReplies
      :options="options"
      :disabled="disabled"
      @pick="emit('pick', $event)"
      @other="emit('other')"
    />
  </div>
</template>

<style scoped>
.qsb-banner {
  margin: 0;
  font-size: 12px;
  color: var(--warn);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.qsb-question {
  margin: 0;
  color: var(--fg);
  overflow-wrap: anywhere;
}
</style>

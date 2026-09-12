<script setup lang="ts">
// Une session agent = UNE ligne du rail : pastille de statut, nom de RÔLE
// (projet), horodatage. Jamais le titre du ticket ni la commande CLI.
import { computed } from 'vue'
import { agentRoleName } from '../../agent-label'
import { queueSectionOf } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { t } from '../../i18n'
import { formatConversationTimestamp } from './ConversationsLogic'

const props = defineProps<{
  state: TaskState
  /** Nom du projet — identité du rôle (session) dans le rail. */
  projectName: string
}>()

const visual = computed(() => EXECUTION_STATUS[props.state.record.status])
const finished = computed(() => queueSectionOf(props.state.record.status) === 'done')
const label = computed(
  () =>
    agentRoleName({ projectName: props.projectName, record: props.state.record }) ??
    t('workspace.agentLabel'),
)
const age = computed(() => formatConversationTimestamp(props.state.record.updated_at))
</script>

<template>
  <span class="cvr-root" :data-tone="visual.tone" :data-finished="finished">
    <span class="cvr-dot status" :data-tone="visual.tone" aria-hidden="true" />
    <span class="cvr-title" :title="label">{{ label }}</span>
    <span class="cvr-age">{{ age }}</span>
  </span>
</template>

<style scoped>
.cvr-root {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 1ch;
  align-items: baseline;
  min-width: 0;
  width: 100%;
}

.cvr-dot {
  flex: none;
  align-self: start;
  margin-top: 0.35em;
}

.cvr-dot::before {
  line-height: 1;
}

/* Une seule ligne : le nom de rôle, puis coupe. */
.cvr-title {
  min-width: 0;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cvr-root[data-finished='true'] .cvr-title {
  color: var(--fg-dim);
}

.cvr-age {
  color: var(--fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>

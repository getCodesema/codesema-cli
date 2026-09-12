<script setup lang="ts">
// Une session agent = UNE ligne du rail : pastille de statut, nom de RÔLE
// (projet), snippet d'activité, horodatage. Jamais le titre du ticket ni la
// commande CLI.
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
const snippet = computed(() => t(visual.value.phraseKey))
const age = computed(() => formatConversationTimestamp(props.state.record.updated_at))
</script>

<template>
  <span class="cvr-root" :data-tone="visual.tone" :data-finished="finished">
    <span class="cvr-avatar" :data-tone="visual.tone" aria-hidden="true" />
    <span class="cvr-main">
      <span class="cvr-line">
        <span class="cvr-title" :title="label">{{ label }}</span>
        <span class="cvr-age">{{ age }}</span>
      </span>
      <span class="cvr-snippet">{{ snippet }}</span>
    </span>
  </span>
</template>

<style scoped>
.cvr-root {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.75rem;
  align-items: flex-start;
  min-width: 0;
  width: 100%;
}

.cvr-avatar {
  flex: none;
  width: 1.65rem;
  height: 1.65rem;
  margin-top: 0.1rem;
  border-radius: var(--radius-pill);
  background: var(--tone, var(--fg-muted));
}

.cvr-main {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.cvr-line {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.75rem;
  align-items: baseline;
  min-width: 0;
}

/* Une seule ligne : le nom de rôle, puis coupe. */
.cvr-title {
  min-width: 0;
  color: var(--fg);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cvr-root[data-finished='true'] .cvr-title {
  color: var(--fg-dim);
  font-weight: 400;
}

.cvr-age {
  color: var(--fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cvr-snippet {
  min-width: 0;
  color: var(--fg-dim);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

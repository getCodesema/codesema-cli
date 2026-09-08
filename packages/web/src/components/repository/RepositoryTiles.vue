<script setup lang="ts">
// Four KPI tiles above the repository's branch table: total branches,
// worktrees, active conversations, and conversations waiting on the human.
// Pure presentation, no interaction of its own.
import type { RepositoryTiles } from '../../composables/useRepository'
import { t } from '../../i18n'

defineProps<{ tiles: RepositoryTiles }>()
</script>

<template>
  <div class="rpt-root">
    <div class="rpt-tile">
      <span class="rpt-label">{{ t('repository.tileBranches') }}</span>
      <span class="rpt-value">{{ tiles.branchCount }}</span>
    </div>
    <div class="rpt-tile">
      <span class="rpt-label">{{ t('repository.tileWorktrees') }}</span>
      <span class="rpt-value">{{ tiles.worktreeCount }}</span>
    </div>
    <div class="rpt-tile">
      <span class="rpt-label">{{ t('repository.tileConversations') }}</span>
      <span class="rpt-value">{{ tiles.activeConversationCount }}</span>
    </div>
    <div class="rpt-tile" :class="{ 'rpt-tile--attention': tiles.waitingOnYouCount > 0 }">
      <span class="rpt-label">{{ t('repository.tileNeedsYou') }}</span>
      <span class="rpt-value">{{ tiles.waitingOnYouCount }}</span>
    </div>
  </div>
</template>

<style scoped>
.rpt-root {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1ch;
}

.rpt-tile {
  display: flex;
  flex-direction: column;
  padding: calc(var(--row) / 2) 2ch;
  border: 1px solid var(--line);
}

.rpt-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.rpt-value {
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}

.rpt-tile--attention {
  border-color: var(--warn);
}

.rpt-tile--attention .rpt-value {
  color: var(--warn);
}
</style>

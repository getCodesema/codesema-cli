<script setup lang="ts">
// The stage's segment of the workspace header band: the same height and the
// same hairline as the rail and list headers next to it, so the three
// columns read as ONE line across the desk. It carries only what is about
// the workspace as a whole and about nothing on screen in particular — the
// live signals, right-aligned.
//
// The brand lives in the rail header and the settings entry in the rail
// footer: neither is repeated here.
//
// The search lives in the list column too: each list searches its own corpus
// (conversations, repositories), and a header field on top of them would be
// a second box searching an overlapping third thing. Cmd/Ctrl+K is owned by
// the shell, which focuses whichever list is up.
//
// Plus, since T2.7/D9, the one place the workspace says it cannot reach a
// forge. It sits HERE and not next to a list, because the fact is about the
// workspace, not about one panel: a silent header with an empty issue list
// underneath is exactly the ambiguity D9 exists to remove.
import { computed } from 'vue'
import { forgeUnavailableKey } from '../composables/useProjects'
import { G } from '../glyphs'
import { t } from '../i18n'
import type { WorkspaceInfo } from '../types'

const props = defineProps<{
  /** Conversations blocked on the human (bell badge count). */
  needsYou: number
  /** Agents currently working: running + reviewing. */
  agents: number
  /**
   * Workspace facts of the card being looked at (GET /api/projects). Null
   * while they have not been fetched — which is UNKNOWN, not "the forge is
   * fine": the badge below stays away in both cases, and only an explicit
   * `forge_available: false` makes it appear.
   */
  workspace?: WorkspaceInfo | null
}>()

/** Null when the forge answers, and null when nothing is known about it. */
const forgeReasonKey = computed(() => forgeUnavailableKey(props.workspace ?? null))

const emit = defineEmits<{ 'open-oldest-waiting': [] }>()
</script>

<template>
  <header class="wh-root appbar">
    <div class="wh-gap" />

    <div class="wh-right cells">
      <!--
        Never a silence: when the server says the forge is unreachable, the
        header names it AND names why, with the hint spelling out what still
        works and what does not (D9's two lists).
      -->
      <span
        v-if="forgeReasonKey"
        class="wh-forge cell warn"
        role="status"
        :title="t('workspace.forgeUnavailableHint')"
      >
        <span aria-hidden="true">{{ G.attention }}</span>
        {{ t('workspace.forgeUnavailable') }} — {{ t(forgeReasonKey) }}
      </span>
      <!-- Amber attention: at least one agent is blocked on the human. -->
      <button
        v-if="needsYou > 0"
        class="wh-bell cell warn"
        type="button"
        :title="t('workspace.openOldestWaiting')"
        @click="emit('open-oldest-waiting')"
      >
        <span aria-hidden="true">{{ G.attention }}</span>
        {{ t('workspace.needsYouBadge', { n: needsYou }) }}
      </button>
      <span class="wh-agents cell">
        <span class="wh-agents-dot status" :data-s="agents > 0 ? 'running' : 'idle'" />
        {{ t('workspace.agentsCount', { n: agents }) }}
      </span>
    </div>
  </header>
</template>

<style scoped>
/* One band with the rail and list headers: the same height, and the same
   single hairline under it — never a frame of its own. */
.wh-root {
  flex: none;
  grid-template-columns: 1fr auto;
  height: calc(var(--row) + 4px);
  border: 0;
  border-bottom: 1px solid var(--line);
}

.wh-gap {
  min-width: 0;
}

.wh-right {
  justify-content: flex-end;
}

.wh-forge {
  cursor: help;
}
</style>

<script setup lang="ts">
// Global workspace app bar: brand + WORKSPACE label, and the live signals on
// the right — the amber "N agents need you" cell (visible only when N > 0,
// clicking it opens the conversation that has waited the longest) and the
// "N agents" counter (running + reviewing, blinking dot while at least one
// run is live). No avatar, per the maquette.
//
// The search lives in the list column, not here: each list searches its own
// corpus (conversations, repositories), and a header field on top of them
// would be a second box searching an overlapping third thing. Cmd/Ctrl+K is owned by
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
  /** Settings overlay is open: the button reads as back. */
  settingsOpen?: boolean
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

const emit = defineEmits<{ 'open-oldest-waiting': []; settings: [] }>()
</script>

<template>
  <header class="wh-root appbar">
    <div class="wh-brand brand">
      <span class="wh-brand-name">codesema</span>
      <span class="wh-brand-sub">{{ t('workspace.title') }}</span>
    </div>

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
      <button
        class="wh-settings cell"
        type="button"
        :aria-pressed="settingsOpen === true"
        @click="emit('settings')"
      >
        {{ settingsOpen ? t('workspace.back') : t('nav.settings') }}
      </button>
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
.wh-root {
  flex: none;
}

.wh-brand {
  gap: 1ch;
  align-items: baseline;
}

.wh-brand-name {
  font-weight: 700;
  color: var(--fg);
}

.wh-brand-sub {
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-dim);
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

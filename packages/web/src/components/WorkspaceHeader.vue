<script setup lang="ts">
// Global 52px workspace header: brand + WORKSPACE label, and the two live
// signals on the right — the amber bell badge "N agents need you" (visible
// only when N > 0, clicking it opens the conversation that has waited the
// longest) and the "● N agents" counter (running + reviewing, amber glowing
// dot while at least one run is live). No avatar, per the maquette.
//
// The search lives in the list column, not here: each list searches its own
// corpus (conversations, repositories), and a header field on top of them
// would be a second box searching an overlapping third thing. ⌘K is owned by
// the shell, which focuses whichever list is up.
//
// Plus, since T2.7/D9, the one place the workspace says it cannot reach a
// forge. It sits HERE and not next to a list, because the fact is about the
// workspace, not about one panel: a silent header with an empty issue list
// underneath is exactly the ambiguity D9 exists to remove.
import { computed } from 'vue'
import { forgeUnavailableKey } from '../composables/useProjects'
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
  <header class="wh-root">
    <div class="wh-brand">
      <span class="wh-brand-name">codesema</span>
      <span class="wh-brand-sub">{{ t('workspace.title') }}</span>
    </div>

    <div class="wh-right">
      <!--
        Never a silence: when the server says the forge is unreachable, the
        header names it AND names why, with the hint spelling out what still
        works and what does not (D9's two lists).
      -->
      <span
        v-if="forgeReasonKey"
        class="wh-forge"
        role="status"
        :title="t('workspace.forgeUnavailableHint')"
      >
        <span aria-hidden="true">⚠</span>
        {{ t('workspace.forgeUnavailable') }} — {{ t(forgeReasonKey) }}
      </span>
      <button class="wh-settings" type="button" @click="emit('settings')">
        {{ settingsOpen ? t('workspace.back') : t('nav.settings') }}
      </button>
      <!-- Amber attention: at least one agent is blocked on the human. -->
      <button
        v-if="needsYou > 0"
        class="wh-bell"
        :title="t('workspace.openOldestWaiting')"
        @click="emit('open-oldest-waiting')"
      >
        <span aria-hidden="true">🔔</span>
        {{ t('workspace.needsYouBadge', { n: needsYou }) }}
      </button>
      <span class="wh-agents">
        <span
          class="wh-agents-dot"
          :class="{ 'wh-agents-dot--live': agents > 0 }"
          aria-hidden="true"
        />
        {{ t('workspace.agentsCount', { n: agents }) }}
      </span>
    </div>
  </header>
</template>

<style scoped>
.wh-root {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 52px;
  padding: 0 20px;
  border-bottom: 1px solid var(--cs-line);
  background: var(--cs-panel);
}

.wh-brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.wh-brand-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--cs-text);
}

.wh-brand-sub {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--cs-muted);
}

.wh-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 14px;
}

.wh-settings {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 7px;
  border: 1px solid var(--cs-line);
  background: var(--cs-surface);
  color: var(--cs-text-2);
  cursor: pointer;
}

.wh-settings:hover {
  border-color: var(--cs-line-2);
}

/* A degraded capability, not an error: stated in amber like the bell, never red. */
.wh-forge {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border: 1px solid var(--cs-amber-line);
  border-radius: 7px;
  background: var(--cs-amber-soft);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--cs-amber-text);
  cursor: help;
}

/* The bell is a STATE: amber means the human is the bottleneck right now. */
.wh-bell {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--cs-amber-soft);
  border: 1px solid var(--cs-amber-line);
  border-radius: 7px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--cs-amber-text);
  cursor: pointer;
}

.wh-bell:hover {
  border-color: var(--cs-amber);
}

.wh-agents {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--cs-muted);
}

.wh-agents-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cs-dot-idle);
}

/* Glow only while at least one run is actually live. */
.wh-agents-dot--live {
  background: var(--cs-amber);
  box-shadow: var(--cs-amber-glow);
}
</style>

<script setup lang="ts">
// Global 52px workspace header: brand + WORKSPACE label, the search field
// (⌘K focuses it, its query filters the work queue), and the two live
// signals on the right — the amber bell badge "N agents need you" (visible
// only when N > 0, clicking it opens the conversation that has waited the
// longest) and the "● N agents" counter (running + reviewing, amber glowing
// dot while at least one run is live). No avatar, per the maquette.
import { onMounted, onUnmounted, ref } from 'vue'
import { t } from '../i18n'

defineProps<{
  /** Conversations blocked on the human (bell badge count). */
  needsYou: number
  /** Agents currently working: running + reviewing. */
  agents: number
}>()

const query = defineModel<string>('query', { default: '' })

const emit = defineEmits<{ 'open-oldest-waiting': [] }>()

const searchInput = ref<HTMLInputElement | null>(null)

/** ⌘K / Ctrl+K focuses the search from anywhere in the workspace. */
function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchInput.value?.focus()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <header class="wh-root">
    <div class="wh-brand">
      <span class="wh-brand-name">codesema</span>
      <span class="wh-brand-sub">{{ t('workspace.title') }}</span>
    </div>

    <div class="wh-search">
      <span class="wh-search-glyph" aria-hidden="true">⌕</span>
      <input
        ref="searchInput"
        v-model="query"
        class="wh-search-input"
        type="search"
        :placeholder="t('workspace.searchPlaceholder')"
        :aria-label="t('workspace.searchPlaceholder')"
        spellcheck="false"
      />
      <span class="wh-search-kbd" aria-hidden="true">⌘K</span>
    </div>

    <div class="wh-right">
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

.wh-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 24px;
  padding: 0 12px;
  width: 300px;
  background: var(--cs-surface-2);
  border: 1px solid var(--cs-line-2);
  border-radius: 7px;
}

.wh-search-glyph {
  color: var(--cs-muted);
  font-size: 13px;
}

.wh-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--cs-text);
  font-family: inherit;
  font-size: 12.5px;
  padding: 7px 0;
  outline: none;
}

.wh-search-input::placeholder {
  color: var(--cs-muted);
}

.wh-search-kbd {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  color: var(--cs-ghost);
}

.wh-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 14px;
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

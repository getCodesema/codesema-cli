<script setup lang="ts">
// The category rail (zone 1 of the 3-zone workspace layout): a switch
// between conversations/repositories, a collapse toggle, and a settings
// entry. All state (category, collapsed, needsYou) is owned by the parent
// (WorkspaceView.vue persists it) — this component is purely presentational.
// Rows are kit `.proj` rows: the current one is named by `aria-current` and
// reads as a filled row, never as a border. `border: none` stays explicit on
// every native <button>, since this project imports no Tailwind preflight to
// reset the browser's own default (see styles/base.css).
import {
  FolderGit2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
} from '@lucide/vue'
import type { NavCategory } from '../../composables/useWorkspaceNav'
import { t } from '../../i18n'

defineProps<{
  category: NavCategory
  collapsed: boolean
  /** Conversations that need the human, all projects: the badge on the
   * Conversations row. Null when not known yet — never a fabricated 0. */
  needsYou: number | null
}>()

const emit = defineEmits<{
  'update:category': [category: NavCategory]
  'update:collapsed': [collapsed: boolean]
  settings: []
}>()
</script>

<template>
  <nav class="wnr-root rail" :class="{ 'wnr-root--collapsed': collapsed }">
    <div class="wnr-header rail-h" :class="{ 'wnr-header--collapsed': collapsed }">
      <div class="wnr-brand">
        <span class="wnr-brand-mark" aria-hidden="true">C</span>
        <span v-if="!collapsed" class="wnr-brand-name">codesema</span>
      </div>
      <button
        type="button"
        class="wnr-toggle"
        :title="collapsed ? t('rail.expand') : t('rail.collapse')"
        :aria-label="collapsed ? t('rail.expand') : t('rail.collapse')"
        @click="emit('update:collapsed', !collapsed)"
      >
        <PanelLeftOpen v-if="collapsed" class="wnr-toggle-icon" aria-hidden="true" />
        <PanelLeftClose v-else class="wnr-toggle-icon" aria-hidden="true" />
      </button>
    </div>

    <div class="wnr-categories">
      <button
        type="button"
        class="wnr-cat proj"
        :class="{ 'wnr-cat--active': category === 'conversations' }"
        :aria-current="category === 'conversations'"
        :aria-pressed="category === 'conversations'"
        :title="t('rail.conversations')"
        :aria-label="collapsed ? t('rail.conversations') : undefined"
        @click="emit('update:category', 'conversations')"
      >
        <span class="wnr-icon-slot">
          <MessageSquare class="wnr-row-icon" aria-hidden="true" />
        </span>
        <span v-if="!collapsed" class="wnr-cat-label">{{ t('rail.conversations') }}</span>
        <span v-if="needsYou !== null && needsYou > 0" class="wnr-count-pill">{{ needsYou }}</span>
      </button>

      <button
        type="button"
        class="wnr-cat proj"
        :class="{ 'wnr-cat--active': category === 'repositories' }"
        :aria-current="category === 'repositories'"
        :aria-pressed="category === 'repositories'"
        :title="t('rail.repositories')"
        :aria-label="collapsed ? t('rail.repositories') : undefined"
        @click="emit('update:category', 'repositories')"
      >
        <span class="wnr-icon-slot">
          <FolderGit2 class="wnr-row-icon" aria-hidden="true" />
        </span>
        <span v-if="!collapsed" class="wnr-cat-label">{{ t('rail.repositories') }}</span>
      </button>

      <button
        type="button"
        class="wnr-cat proj"
        :class="{ 'wnr-cat--active': category === 'codeReview' }"
        :aria-current="category === 'codeReview'"
        :aria-pressed="category === 'codeReview'"
        :title="t('rail.codeReview')"
        :aria-label="collapsed ? t('rail.codeReview') : undefined"
        @click="emit('update:category', 'codeReview')"
      >
        <span class="wnr-icon-slot">
          <ShieldCheck class="wnr-row-icon" aria-hidden="true" />
        </span>
        <span v-if="!collapsed" class="wnr-cat-label">{{ t('rail.codeReview') }}</span>
      </button>
    </div>

    <div class="wnr-spacer" />

    <div class="wnr-footer">
      <button
        type="button"
        class="wnr-settings proj"
        :title="t('nav.settings')"
        :aria-label="collapsed ? t('nav.settings') : undefined"
        @click="emit('settings')"
      >
        <span class="wnr-icon-slot">
          <Settings class="wnr-row-icon" aria-hidden="true" />
        </span>
        <span v-if="!collapsed" class="wnr-settings-label">{{ t('nav.settings') }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.wnr-root {
  width: 215px;
  flex: none;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.wnr-root--collapsed {
  width: 56px;
}

.wnr-header {
  gap: 1ch;
}

.wnr-header--collapsed {
  flex-direction: column;
  height: auto;
  padding: calc(var(--row) / 2) 1ch;
}

.wnr-brand {
  display: flex;
  align-items: center;
  gap: 1ch;
  min-width: 0;
}

.wnr-brand-mark {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3ch;
  border: 1px solid var(--ok);
  color: var(--ok);
  font-weight: 700;
}

.wnr-brand-name {
  color: var(--fg);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wnr-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 1ch;
}

.wnr-toggle-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.wnr-categories {
  display: flex;
  flex-direction: column;
}

/* Rows follow the kit `.proj` anatomy; only the icon slot is local. */
.wnr-cat,
.wnr-settings {
  grid-template-columns: 2ch 1fr auto;
  align-items: center;
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--fg-dim);
  border: none;
  background: transparent;
}

/* The current row is named by `aria-current` and styled by the kit; the icon
   accents with it. */
.wnr-cat--active .wnr-row-icon {
  color: var(--ok);
}

.wnr-icon-slot {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wnr-row-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.wnr-cat-label,
.wnr-settings-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The one count in the rail: amber, since it names the state "the human is
   needed" (DESIGN doctrine: colour is a state). */
.wnr-count-pill {
  margin-left: auto;
  flex: none;
  color: var(--warn);
  font-variant-numeric: tabular-nums;
}

.wnr-spacer {
  flex: 1;
}

.wnr-footer {
  border-top: 1px solid var(--line);
}

.wnr-root--collapsed .wnr-cat,
.wnr-root--collapsed .wnr-settings {
  grid-template-columns: 1fr;
  justify-items: center;
  padding: 2px 1ch;
}

.wnr-root--collapsed .wnr-count-pill {
  margin-left: 0;
}
</style>

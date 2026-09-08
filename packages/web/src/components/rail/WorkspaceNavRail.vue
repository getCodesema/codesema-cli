<script setup lang="ts">
// The category rail (zone 1 of the 3-zone workspace layout): a switch
// between conversations/repositories, a collapse toggle, the theme picker
// and a settings entry. All state (category, collapsed, needsYou) is owned
// by the parent (WorkspaceView.vue persists it) — this component is purely
// presentational. Its header is one band of the same height as the list and
// stage headers, so the three columns share a single hairline. Rows are kit
// `.proj` rows: the current one is named by `aria-current` and reads as a
// filled row with an accent edge, never as a box. `border: none` stays
// explicit on every native <button>, since this project imports no Tailwind
// preflight to reset the browser's own default (see styles/base.css).
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
import ThemePicker from '../ThemePicker.vue'

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
      <span v-if="!collapsed" class="wnr-brand">code<i>sema</i></span>
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

    <div class="wnr-footer">
      <div class="wnr-theme">
        <ThemePicker compact :collapsed="collapsed" @expand="emit('update:collapsed', false)" />
      </div>
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
  width: 30ch;
  flex: none;
  min-height: 0;
  overflow: hidden;
}

.wnr-root--collapsed {
  width: 56px;
}

/* One band with the list and stage headers: same height, one hairline. */
.wnr-header {
  flex: none;
  gap: 1ch;
}

.wnr-header--collapsed {
  justify-content: center;
  padding: 0 1ch;
}

.wnr-brand {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
  font-weight: 700;
}

.wnr-brand i {
  font-style: normal;
  color: var(--ok);
}

.wnr-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  border: none;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0 1ch;
}

.wnr-toggle:hover {
  color: var(--fg);
}

.wnr-toggle-icon {
  flex: none;
  width: 1em;
  height: 1em;
}

.wnr-categories {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* Rows follow the kit `.proj` anatomy: a 2ch glyph column, then the label.
   The accent edge is always drawn, transparent until the row is current, so
   the label never shifts by two pixels when the category changes. */
.wnr-cat,
.wnr-settings {
  grid-template-columns: 2ch 1fr auto;
  align-items: center;
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--fg-dim);
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
}

.wnr-cat[aria-current='true'] {
  border-left-color: var(--accent);
}

/* The current row is named by `aria-current` and styled by the kit; the icon
   follows the label out of the dim. */
.wnr-cat--active .wnr-row-icon {
  color: var(--fg);
}

.wnr-icon-slot {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wnr-row-icon {
  flex: none;
  width: 1em;
  height: 1em;
  color: var(--fg-dim);
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

.wnr-footer {
  flex: none;
  border-top: 1px solid var(--line);
}

.wnr-theme {
  padding: calc(var(--row) / 2) 1ch calc(var(--row) / 2) 2ch;
}

.wnr-root--collapsed .wnr-theme {
  padding: calc(var(--row) / 2) 1ch;
}

.wnr-footer .wnr-settings {
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

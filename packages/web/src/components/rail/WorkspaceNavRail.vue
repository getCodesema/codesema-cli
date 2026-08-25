<script setup lang="ts">
// The category rail (zone 1 of the 3-zone workspace layout): a switch
// between conversations/repositories, a collapse toggle, and a settings
// entry. All state (category, collapsed, needsYou) is owned by the parent
// (WorkspaceView.vue persists it) — this component is purely presentational.
// Visual language mirrors ProjectsNav.vue: active rows get a tinted fill,
// never a border, and their icon accents with them (rows without a real
// icon are the only exemption, and every row here has one). `border: none`
// stays explicit on every native <button>, since this project imports no
// Tailwind preflight to reset the browser's own default (see style.css).
import { FolderGit2, MessageSquare, PanelLeftClose, PanelLeftOpen, Settings } from '@lucide/vue'
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
  <nav class="wnr-root" :class="{ 'wnr-root--collapsed': collapsed }">
    <div class="wnr-header" :class="{ 'wnr-header--collapsed': collapsed }">
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
        class="wnr-cat"
        :class="{ 'wnr-cat--active': category === 'conversations' }"
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
        class="wnr-cat"
        :class="{ 'wnr-cat--active': category === 'repositories' }"
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
    </div>

    <div class="wnr-spacer" />

    <div class="wnr-footer">
      <button
        type="button"
        class="wnr-settings"
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
  display: flex;
  flex-direction: column;
  width: 215px;
  flex: none;
  min-height: 0;
  padding: 12px 8px;
  gap: 4px;
  background: var(--cs-panel);
  border-right: 1px solid var(--cs-line);
  overflow-x: hidden;
  overflow-y: auto;
  transition: width var(--cs-duration-base) var(--cs-ease-in);
}

.wnr-root--collapsed {
  width: 56px;
}

.wnr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 4px 12px;
  border-bottom: 1px solid var(--cs-line);
}

.wnr-header--collapsed {
  flex-direction: column;
  gap: 10px;
}

.wnr-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.wnr-brand-mark {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--cs-green-soft);
  color: var(--cs-green-text);
  font-size: 13px;
  font-weight: 700;
}

.wnr-brand-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wnr-toggle {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.wnr-toggle:hover {
  background: var(--cs-hover);
  color: var(--cs-text-2);
}

.wnr-toggle-icon {
  flex: none;
  width: 16px;
  height: 16px;
}

.wnr-categories {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
}

/* Same 36px/8px-12px/8px-radius/14px-500-20 anatomy as every nav row in
   ProjectsNav.vue's own menu. `border: none` stays explicit: see the file
   header note on Tailwind preflight. */
.wnr-cat,
.wnr-settings {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--cs-text-2);
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.wnr-cat:hover,
.wnr-settings:hover {
  background: var(--cs-hover);
}

/* Active state: tinted fill + text only, no border or side bar — same
   doctrine as ProjectsNav.vue's own active rows. */
.wnr-cat--active {
  background: var(--cs-green-soft);
  color: var(--cs-text);
  font-weight: 600;
}

.wnr-cat--active .wnr-row-icon {
  color: var(--cs-green-text);
}

.wnr-icon-slot {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.wnr-row-icon {
  flex: none;
  width: 16px;
  height: 16px;
}

.wnr-cat-label,
.wnr-settings-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The one pastille that carries a colored fill: amber, since it names the
   state "the human is needed" (DESIGN doctrine: color is a state). */
.wnr-count-pill {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  background: var(--cs-amber-soft);
  color: var(--cs-amber-text);
}

.wnr-spacer {
  flex: 1;
}

.wnr-footer {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--cs-line);
}

.wnr-root--collapsed .wnr-cat,
.wnr-root--collapsed .wnr-settings {
  justify-content: center;
  padding: 8px;
}

.wnr-root--collapsed .wnr-count-pill {
  margin-left: 0;
}
</style>

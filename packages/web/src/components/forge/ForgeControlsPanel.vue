<script setup lang="ts">
// The forge board's controls panel. For now this is only the section switch
// (issues vs pull requests, replacing the old two-open-accordions layout
// from ForgeBoard.vue) and this panel's own collapse toggle. Sort/status
// filter/label chips stay where they already work, in the list panel; a
// richer controls panel is a later lot.
//
// Collapsed: not just a bare toggle button. The whole 48px band shows the
// project name in vertical, top-to-bottom writing mode, truncated to the
// band's height, and the ENTIRE band is the reopen control (not a small
// icon tucked in a corner). Below the shell's own 640px width (the same
// breakpoint the three panels stack at, reused here rather than a separate
// one), the band flips to a short horizontal bar at the top, text no longer
// rotated.
import { t } from '../../i18n'
import type { ForgeSection } from './ForgePrefs'

defineProps<{
  activeSection: ForgeSection
  collapsed: boolean
  projectName: string
}>()

const emit = defineEmits<{
  'update:activeSection': [section: ForgeSection]
  'update:collapsed': [collapsed: boolean]
}>()
</script>

<template>
  <div class="fcp-root" :class="{ 'fcp-root--collapsed': collapsed }">
    <!-- Collapsed: the whole band is the reopen control, carrying the
         project name, no separate small toggle button. -->
    <button
      v-if="collapsed"
      type="button"
      class="fcp-band"
      :aria-label="t('forge.controlsExpand')"
      :aria-expanded="false"
      :title="projectName"
      @click="emit('update:collapsed', false)"
    >
      <span class="fcp-band-name">{{ projectName }}</span>
    </button>

    <template v-else>
      <button
        type="button"
        class="fcp-collapse"
        :aria-label="t('forge.controlsCollapse')"
        :aria-expanded="true"
        @click="emit('update:collapsed', true)"
      >
        <span aria-hidden="true">«</span>
      </button>

      <nav class="fcp-nav" :aria-label="t('forge.sectionNavAria')">
        <button
          type="button"
          class="fcp-nav-item"
          :class="{ 'fcp-nav-item--on': activeSection === 'issues' }"
          :aria-pressed="activeSection === 'issues'"
          @click="emit('update:activeSection', 'issues')"
        >
          {{ t('forge.issuesTitle') }}
        </button>
        <button
          type="button"
          class="fcp-nav-item"
          :class="{ 'fcp-nav-item--on': activeSection === 'mrs' }"
          :aria-pressed="activeSection === 'mrs'"
          @click="emit('update:activeSection', 'mrs')"
        >
          {{ t('forge.mrsTitle') }}
        </button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.fcp-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px;
}

.fcp-root--collapsed {
  padding: 0;
}

.fcp-collapse {
  align-self: flex-end;
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid var(--cs-line-2);
  border-radius: 7px;
  background: var(--cs-surface);
  color: var(--cs-muted);
  cursor: pointer;
}

.fcp-collapse:hover {
  border-color: var(--cs-line-3);
  color: var(--cs-text-2);
}

/* Collapsed band: the whole 48px-wide strip is the reopen control, no
   separate small button. Text runs vertically, top-to-bottom, truncated to
   whatever height the band actually gets. */
.fcp-band {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 0;
  border: none;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.fcp-band:hover {
  background: var(--cs-hover);
  color: var(--cs-text-2);
}

.fcp-band-name {
  writing-mode: vertical-rl;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-height: 100%;
  font-size: 12.5px;
  font-weight: 600;
}

/* Below the shell's own 640px (the panels' own stacking breakpoint, see
   ForgeBoard.vue): the band becomes a short horizontal bar at the top,
   the name no longer rotated. */
@container fb-shell (max-width: 640px) {
  .fcp-band {
    width: 100%;
    height: 48px;
    padding: 0 14px;
    justify-content: flex-start;
  }

  .fcp-band-name {
    writing-mode: horizontal-tb;
    max-height: none;
    max-width: 100%;
  }
}

.fcp-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fcp-nav-item {
  text-align: left;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 7px 10px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-surface);
  color: var(--cs-muted);
  cursor: pointer;
}

.fcp-nav-item:hover {
  border-color: var(--cs-line-3);
}

/* The active section is a state: colored, per the doctrine. */
.fcp-nav-item--on {
  border-color: var(--cs-green-ring);
  background: var(--cs-green-soft);
  color: var(--cs-text);
}
</style>

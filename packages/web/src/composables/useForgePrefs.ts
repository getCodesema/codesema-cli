// The forge board's UI preferences, lifted out of ForgeBoard.vue so that the
// rail and the board can read the same blob while living in different parts
// of the tree.
//
// Why they had to move: the rail is PERMANENT. It carries the project menu
// whether or not a board is up, and only grows its filter sections when one
// is. Leaving the preferences inside the board would have meant the rail's
// own collapsed state and width lived inside a component that does not
// always exist, so the menu would jump every time a project was picked.
//
// This is a factory, not a singleton: one call, one blob. Two callers would
// each get their own state, which is what you want if a second board ever
// opens side by side, and never the silent coupling a module-level ref gives.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ForgeSortKey, MrStateFilter } from '../components/forge/ForgeLogic'
import {
  FORGE_CONTROLS_COLLAPSED_WIDTH,
  readForgePrefs,
  writeForgePrefs,
  type ForgePrefs,
  type ForgeSection,
} from '../components/forge/ForgePrefs'

export type ForgePrefsStore = {
  /** The whole blob, for the fields read directly (label arrays). */
  prefs: Ref<ForgePrefs>
  activeSection: Ref<ForgeSection>
  railWidth: Ref<number>
  railCollapsed: Ref<boolean>
  listWidth: Ref<number>
  issuesSort: Ref<ForgeSortKey>
  mrsSort: Ref<ForgeSortKey>
  mrsFilter: Ref<MrStateFilter>
  /** The rail's width ON SCREEN: pinned to the collapsed band while
   * collapsed, since `railWidth` holds the width to restore on expand. */
  railPanelWidth: ComputedRef<number>
  toggleIssueLabel: (label: string) => void
  toggleMrLabel: (label: string) => void
  clearIssueFilters: () => void
  clearMrFilters: () => void
}

export function useForgePrefs(): ForgePrefsStore {
  const prefs = ref(readForgePrefs())

  watch(prefs, (next) => writeForgePrefs(next), { deep: true })

  /** One field of the blob as a read/write ref: every write replaces the
   * whole blob, which is what the deep watcher above persists. */
  function field<K extends keyof ForgePrefs>(key: K): Ref<ForgePrefs[K]> {
    return computed({
      get: () => prefs.value[key],
      set: (value: ForgePrefs[K]) => (prefs.value = { ...prefs.value, [key]: value }),
    })
  }

  function toggle(key: 'issuesLabels' | 'mrsLabels', label: string): void {
    const current = prefs.value[key]
    const next = current.includes(label)
      ? current.filter((entry) => entry !== label)
      : [...current, label]
    prefs.value = { ...prefs.value, [key]: next }
  }

  const railWidth = field('controlsWidth')
  const railCollapsed = field('controlsCollapsed')

  return {
    prefs,
    activeSection: field('activeSection'),
    railWidth,
    railCollapsed,
    listWidth: field('listWidth'),
    issuesSort: field('issuesSort'),
    mrsSort: field('mrsSort'),
    mrsFilter: field('mrsFilter'),
    railPanelWidth: computed(() =>
      railCollapsed.value ? FORGE_CONTROLS_COLLAPSED_WIDTH : railWidth.value,
    ),
    toggleIssueLabel: (label) => toggle('issuesLabels', label),
    toggleMrLabel: (label) => toggle('mrsLabels', label),
    // Releases the only filter dimension issues have (labels): the fix
    // offered on the "your filter matches nothing" state.
    clearIssueFilters: () => (prefs.value = { ...prefs.value, issuesLabels: [] }),
    // Releases both MR filter dimensions at once.
    clearMrFilters: () => (prefs.value = { ...prefs.value, mrsFilter: 'all', mrsLabels: [] }),
  }
}

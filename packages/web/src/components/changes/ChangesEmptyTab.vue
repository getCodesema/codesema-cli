<script setup lang="ts">
// Generic "nothing to show here" body for a section tab (fiche 14 §7,
// "Onglet vide": icon and text, 48px vertical padding). Shared by the two
// places this panel needs it: the files section with zero changed files,
// and the checks section's placeholder (this lot builds the tab's own
// fraction/glyph indicator, not a full check-run list, see ChangesPanel.vue).
import type { Component } from 'vue'

defineProps<{ icon: Component; text: string }>()
</script>

<template>
  <div class="cet-root">
    <component :is="icon" class="cet-icon" aria-hidden="true" />
    <p class="cet-text">{{ text }}</p>
  </div>
</template>

<style scoped>
.cet-root {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 16px;
  text-align: center;
}

.cet-icon {
  width: 20px;
  height: 20px;
  color: var(--cs-ghost);
}

.cet-text {
  margin: 0;
  font-size: 13px;
  color: var(--cs-muted);
}
</style>

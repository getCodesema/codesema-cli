<script setup lang="ts">
import { AlertTriangle, Check, X } from '@lucide/vue'
import type { Component } from 'vue'
import type { ReferencePill, ReferencePillGlyph } from './ConversationsLogic'

defineProps<{
  pill: ReferencePill
}>()

const CHECKS_ICONS: Partial<Record<ReferencePillGlyph, Component>> = {
  x: X,
  'alert-triangle': AlertTriangle,
  check: Check,
}
</script>

<template>
  <span class="cc-pill" :class="`cc-pill--${pill.tone}`">
    <span v-if="pill.glyph === 'dot'" class="cc-dot" aria-hidden="true" />
    <component :is="CHECKS_ICONS[pill.glyph]" v-else class="cc-pill-icon" aria-hidden="true" />
    <span class="cc-pill-text">{{ pill.text }}</span>
  </span>
</template>

<style scoped>
.cc-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--cs-line-2);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--cs-muted);
  background: color-mix(in srgb, var(--cs-surface-2) 60%, transparent);
  white-space: nowrap;
}

.cc-pill-icon {
  flex: none;
  width: 10px;
  height: 10px;
}

.cc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

.cc-pill--red {
  color: var(--cs-red-text);
  border-color: var(--cs-red-line);
  background: var(--cs-red-soft);
}

.cc-pill--amber {
  color: var(--cs-amber-text);
  border-color: var(--cs-amber-line);
  background: var(--cs-amber-soft);
}

.cc-pill--green {
  color: var(--cs-green-text);
  border-color: var(--cs-green-ring);
  background: var(--cs-green-soft);
}
</style>

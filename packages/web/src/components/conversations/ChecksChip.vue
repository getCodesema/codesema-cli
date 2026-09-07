<script setup lang="ts">
import { AlertTriangle, Check, X } from '@lucide/vue'
import type { Component } from 'vue'
import type { StatusTone } from '../../execution-status'
import { G } from '../../glyphs'
import type { ReferencePill, ReferencePillGlyph, ReferencePillTone } from './ConversationsLogic'

defineProps<{
  pill: ReferencePill
}>()

const CHECKS_ICONS: Partial<Record<ReferencePillGlyph, Component>> = {
  x: X,
  'alert-triangle': AlertTriangle,
  check: Check,
}

const CHECKS_TONES: Record<ReferencePillTone, StatusTone> = {
  red: 'err',
  amber: 'warn',
  green: 'ok',
}
</script>

<template>
  <span class="cc-pill badge" :class="`cc-pill--${pill.tone}`" :data-tone="CHECKS_TONES[pill.tone]">
    <span v-if="pill.glyph === 'dot'" class="cc-dot" aria-hidden="true">{{ G.dot }}</span>
    <component :is="CHECKS_ICONS[pill.glyph]" v-else class="cc-pill-icon" aria-hidden="true" />
    <span class="cc-pill-text">{{ pill.text }}</span>
  </span>
</template>

<style scoped>
.cc-pill {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  border-color: var(--line);
  white-space: nowrap;
}

/* The state tone is the ONE thing that colours this chip: one attribute, no
   per-tone class of its own reaching for a token. */
.cc-pill[data-tone] {
  color: var(--tone);
  border-color: var(--tone);
}

.cc-pill-icon {
  flex: none;
  width: 1em;
  height: 1em;
}
</style>

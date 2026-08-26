<script setup lang="ts">
// Shared card gabarit for foldable journal events (fiche 15, sections 2-3): a
// full-width header row (chevron, state icon, title, truncated detail, an
// optional right-pinned token) that discloses a monospace body on click.
//
// The source repeats this shell across eleven near-identical files, two of
// them byte-for-byte the same container (fiche 15 section 2). Every future
// event card composes THIS one instead of copying a twelfth: the mapping
// (which tone, which icon, which body text) is the card-specific part, the
// shell is not.
import { ChevronRight } from '@lucide/vue'
import { computed, ref, type Component } from 'vue'
import {
  EVENT_CARD_BACKGROUND_COLOR,
  EVENT_CARD_BORDER_COLOR,
  EVENT_CARD_ICON_COLOR,
  type EventCardTone,
} from './EventCard'

const props = defineProps<{
  tone?: EventCardTone
  /**
   * State icon (13px). WHICH glyph is the caller's judgment, see fiche 15
   * section 3 names a triangle for the anomalous, an arrow for the routine,
   * layers for a synthesis, information otherwise. This template only
   * colors whatever icon it is given, by tone; it does not choose one.
   */
  icon?: Component
  /** Demi-gras, never truncated (fiche 15 section 3): keep it short at the
   * call site instead of relying on this template to clip it. */
  title: string
  detail?: string | null
  /** Right-pinned monospace chip, e.g. a short id or a count. */
  token?: string | null
  /**
   * Initial fold state, decided by the CALLER from the outcome it is about
   * to render (fiche 15 section 6): a card announcing a failure passes
   * `true` so it opens itself; one announcing success passes `false` (the
   * default) and stays folded. The fold is the reader's own toggle from
   * then on: this prop only seeds the first render.
   */
  defaultOpen?: boolean
}>()

const open = ref(props.defaultOpen ?? false)

const toneValue = computed(() => props.tone ?? 'neutral')
const iconColor = computed(() => EVENT_CARD_ICON_COLOR[toneValue.value])
const borderColor = computed(() => EVENT_CARD_BORDER_COLOR[toneValue.value])
const backgroundColor = computed(() => EVENT_CARD_BACKGROUND_COLOR[toneValue.value])
</script>

<template>
  <div class="ec-root" :style="{ borderColor, background: backgroundColor }">
    <button
      v-if="$slots.default"
      type="button"
      class="ec-head"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ChevronRight class="ec-chevron" :class="{ 'ec-chevron--open': open }" aria-hidden="true" />
      <component
        :is="icon"
        v-if="icon"
        class="ec-icon"
        :style="{ color: iconColor }"
        aria-hidden="true"
      />
      <span class="ec-title">{{ title }}</span>
      <span v-if="detail" class="ec-detail">{{ detail }}</span>
      <span v-if="token" class="ec-token">{{ token }}</span>
    </button>
    <!-- No body to disclose: a static row, never a button that could open
         nothing (fiche 15's cards are all foldable, but a shared shell must
         also serve a caller with no expanded content to offer). -->
    <div v-else class="ec-head ec-head--static">
      <component
        :is="icon"
        v-if="icon"
        class="ec-icon"
        :style="{ color: iconColor }"
        aria-hidden="true"
      />
      <span class="ec-title">{{ title }}</span>
      <span v-if="detail" class="ec-detail">{{ detail }}</span>
      <span v-if="token" class="ec-token">{{ token }}</span>
    </div>
    <!-- Only the chevron animates; the body mounts/unmounts outright (fiche
         15 section 6): animating the height of a card inserted mid-thread
         would shove everything below it while the reader is scrolling. -->
    <div v-if="$slots.default && open" class="ec-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ec-root {
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-surface);
  overflow: hidden;
}

.ec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.ec-head--static {
  cursor: default;
}

.ec-chevron {
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--cs-ghost);
  transition: transform 150ms ease;
}

.ec-chevron--open {
  transform: rotate(90deg);
}

.ec-icon {
  flex: none;
  width: 13px;
  height: 13px;
}

.ec-title {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--cs-text);
}

/* Truncated and dimmed, unlike the title beside it. */
.ec-detail {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 20px;
  color: var(--cs-text-2);
  opacity: 0.75;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ec-token {
  flex: none;
  margin-left: auto;
  padding: 2px 7px;
  border: 1px solid var(--cs-line-2);
  border-radius: 5px;
  background: var(--cs-surface-2);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--cs-text-2);
}

.ec-body {
  padding: 12px;
  border-top: 1px solid var(--cs-line);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 20px;
  color: var(--cs-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

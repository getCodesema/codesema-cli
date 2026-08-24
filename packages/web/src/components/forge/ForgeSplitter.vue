<script setup lang="ts">
// A draggable, keyboard-operable divider between two forge board panels,
// following the WAI-ARIA "window splitter" pattern: drag to resize the
// panel on its left, ArrowLeft/ArrowRight move it by one notch, Enter recalls
// its default width. All the actual math is pure (ForgeLogic.ts): this
// component only wires pointer/keyboard events to it and reflects the result
// as an ARIA separator. Collapse (if the caller offers one) and the panel
// content itself are owned elsewhere: this is only a width controller.
import { ref } from 'vue'
import { widthAfterDrag, widthAfterKey } from './ForgeLogic'

const props = defineProps<{
  modelValue: number
  min: number
  max: number
  defaultWidth: number
  ariaLabel: string
}>()

const emit = defineEmits<{ 'update:modelValue': [width: number] }>()

const dragging = ref(false)
let dragStartX = 0
let dragStartWidth = 0

function onPointerDown(event: PointerEvent): void {
  dragging.value = true
  dragStartX = event.clientX
  dragStartWidth = props.modelValue
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) {
    return
  }
  emit(
    'update:modelValue',
    widthAfterDrag(dragStartWidth, event.clientX - dragStartX, props.min, props.max),
  )
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging.value) {
    return
  }
  dragging.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
}

function onKeydown(event: KeyboardEvent): void {
  const next = widthAfterKey(event.key, props.modelValue, {
    min: props.min,
    max: props.max,
    defaultWidth: props.defaultWidth,
  })
  if (next === null) {
    return
  }
  event.preventDefault()
  emit('update:modelValue', next)
}
</script>

<template>
  <div
    class="fs-handle"
    :class="{ 'fs-handle--active': dragging }"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="ariaLabel"
    :aria-valuenow="Math.round(modelValue)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
  />
</template>

<style scoped>
/* Neutral at rest, per the doctrine: only hover/focus lighten it, never a
 * color, since a divider carries no state of its own. */
.fs-handle {
  flex: none;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  border-left: 1px solid var(--cs-line-2);
  touch-action: none;
}

.fs-handle:hover,
.fs-handle--active {
  border-left-color: var(--cs-line-3);
  background: var(--cs-hover);
}
</style>

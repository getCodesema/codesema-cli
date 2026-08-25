<script lang="ts">
/**
 * Pure predicate behind the sticky nav band's title echo, extracted for
 * direct unit testing: IntersectionObserver itself is not observable
 * under the SSR-only test harness (see ForgeDetailPanel.test.ts). Takes
 * the callback's entries array (only ever one entry here, one observed
 * target) and decides whether the compact echo should show: true once the
 * title band has left the scroll container entirely, false otherwise
 * (including the initial "no entries yet" case, so the echo starts hidden).
 */
export function shouldShowTitleEcho(entries: readonly { isIntersecting: boolean }[]): boolean {
  const entry = entries[entries.length - 1]
  return entry !== undefined && !entry.isIntersecting
}
</script>

<script setup lang="ts">
// The forge board's detail panel: always visible, not conditioned on a
// selection, with a clean empty state while nothing is selected in the list
// panel (see ForgeBoard.vue). Two columns once something is selected: a
// flexible body (title, raw description) and a fixed-width metadata rail.
// The MR rail reuses MrMetaRail.vue as-is; an issue's rail is built inline
// here since ForgeIssue carries only labels and dates, not the reviewer/
// milestone/mergeable fields MrMetaRail depends on.
//
// The head is three bands, not one. A sticky nav band (back + a compact
// title echo) pinned to the top of the scroll container; the real title,
// which scrolls away normally with no cap on its lines; and a toolbar band
// (state + actions) sticky right under the nav band on narrow widths,
// static once the panel is wide enough that the echo matters less. The
// echo's visibility is driven by an IntersectionObserver on the title band
// itself, rooted at the scroll container with a zero threshold: a
// pixel-based scroll-offset trigger would be wrong the moment the title
// wraps to more than one line.
import {
  CircleCheck,
  CircleDot,
  Clock,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Tag,
  X,
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import MrMetaRail from '../mr/MrMetaRail.vue'
import type { ForgeDetailItem } from './ForgeLogic'
import {
  hasPathologicalMarkdownShape,
  MAX_FORGE_MARKDOWN_LENGTH,
  renderForgeMarkdown,
} from './ForgeMarkdown'
import { linkifyForgeReferences } from './ForgeReferenceLinks'
import { labelPillStyle } from './LabelColor'

const props = defineProps<{ item: ForgeDetailItem | null }>()

const emit = defineEmits<{ close: [] }>()

// ── Sticky nav band: title echo, toggled by an IntersectionObserver on the
// title band below. Set up only from client lifecycle hooks (onMounted,
// and a non-immediate watch), never eagerly during setup(): setup() itself
// runs during SSR, where `IntersectionObserver` does not exist. ──────────
const scrollRootEl = ref<HTMLElement | null>(null)
const titleSentinelEl = ref<HTMLElement | null>(null)
const showTitleEcho = ref(false)
let titleObserver: IntersectionObserver | null = null

function disconnectTitleObserver(): void {
  titleObserver?.disconnect()
  titleObserver = null
}

function connectTitleObserver(): void {
  disconnectTitleObserver()
  if (scrollRootEl.value === null || titleSentinelEl.value === null) {
    return
  }
  titleObserver = new IntersectionObserver(
    (entries) => {
      showTitleEcho.value = shouldShowTitleEcho(entries)
    },
    { root: scrollRootEl.value, threshold: 0 },
  )
  titleObserver.observe(titleSentinelEl.value)
}

onMounted(connectTitleObserver)
onBeforeUnmount(disconnectTitleObserver)

// Handles selection appearing/disappearing after the panel is already
// mounted (the common case: picking or closing an item in the list). The
// initial-mount case (an item already selected when the panel first
// renders) is covered by onMounted above instead.
watch(
  () => props.item !== null,
  async (hasItem) => {
    if (!hasItem) {
      disconnectTitleObserver()
      showTitleEcho.value = false
      return
    }
    await nextTick()
    connectTitleObserver()
  },
)

const title = computed(() => {
  if (props.item === null) {
    return null
  }
  return props.item.kind === 'issue' ? props.item.issue.title : props.item.mr.title
})
const url = computed(() => {
  if (props.item === null) {
    return null
  }
  return props.item.kind === 'issue' ? props.item.issue.url : props.item.mr.url
})
const number = computed(() => {
  if (props.item === null) {
    return null
  }
  return props.item.kind === 'issue' ? props.item.issue.number : props.item.mr.number
})

/** `''` (an issue's real, description-less body) and MR's `null` both read
 * as "nothing to show" here. */
const description = computed(() => {
  if (props.item === null) {
    return null
  }
  const body = props.item.kind === 'issue' ? props.item.issue.body : props.item.mr.body
  return body === null || body === '' ? null : body
})

/**
 * A body past `MAX_FORGE_MARKDOWN_LENGTH` is truncated before it ever
 * reaches the renderer, never silently: the panel says so, with a link to
 * read the rest on the forge. `#123` references are rewritten to links
 * first (ForgeReferenceLinks.ts, against the current item's own URL), on
 * the already-truncated text: the length limit governs what the reader
 * sees, not the reference rewrite's own tiny expansion of it.
 */
const linkifiedDescription = computed(() => {
  if (description.value === null) {
    return null
  }
  const bounded = description.value.slice(0, MAX_FORGE_MARKDOWN_LENGTH)
  return linkifyForgeReferences(bounded, url.value ?? '')
})

const isDescriptionTruncated = computed(
  () => description.value !== null && description.value.length > MAX_FORGE_MARKDOWN_LENGTH,
)

/**
 * True when the text that would reach the renderer is shaped like one of
 * the two constructs `renderForgeMarkdown` refuses to parse (see
 * `hasPathologicalMarkdownShape`): computed independently here, rather
 * than inferred from `descriptionHtml`'s output, so the panel can show a
 * notice that names what happened instead of a silent fallback to raw
 * text. Distinct from `isDescriptionTruncated`: one says "there was more",
 * the other says "what's here could not be rendered as written".
 */
const isDescriptionShapeAbnormal = computed(
  () =>
    linkifiedDescription.value !== null &&
    hasPathologicalMarkdownShape(linkifiedDescription.value.markdown),
)

/**
 * Sanitized HTML for `description`, from the same truncated, linkified
 * text `isDescriptionShapeAbnormal` checked. A forge body is untrusted
 * content, so this is the only place its raw text is ever interpreted as
 * markup.
 */
const descriptionHtml = computed(() => {
  if (linkifiedDescription.value === null) {
    return null
  }
  const { markdown, references } = linkifiedDescription.value
  return renderForgeMarkdown(markdown, references)
})

type BadgeVariant = 'open' | 'draft' | 'merged' | 'closed'

/**
 * Open is green, draft is a muted neutral, closed is red, merged is lavender
 * (never green: a merged MR whose checks failed would otherwise show green
 * for two contradictory reasons). An issue only ever carries open/closed.
 */
const badge = computed<{ variant: BadgeVariant; labelKey: MessageKey } | null>(() => {
  const item = props.item
  if (item === null) {
    return null
  }
  if (item.kind === 'issue') {
    return item.issue.state === 'open'
      ? { variant: 'open', labelKey: 'mrs.card.stateOpen' }
      : { variant: 'closed', labelKey: 'mrs.card.stateClosed' }
  }
  const { state, isDraft } = item.mr
  if (state === null) {
    return null
  }
  if (state === 'open' && isDraft === true) {
    return { variant: 'draft', labelKey: 'mrs.card.stateDraft' }
  }
  if (state === 'open') {
    return { variant: 'open', labelKey: 'mrs.card.stateOpen' }
  }
  if (state === 'merged') {
    return { variant: 'merged', labelKey: 'mrs.card.stateMerged' }
  }
  return { variant: 'closed', labelKey: 'mrs.card.stateClosed' }
})

// ── Issue rail: labels + dates only, ForgeIssue has no reviewer/milestone
// fields for MrMetaRail's other sections to render. ──────────────────────
const issueLabels = computed(() => (props.item?.kind === 'issue' ? props.item.issue.labels : []))
const issueOpenedAge = computed(() =>
  props.item?.kind === 'issue' ? formatRelativeAge(props.item.issue.createdAt) : '',
)
const issueUpdatedAge = computed(() =>
  props.item?.kind === 'issue' ? formatRelativeAge(props.item.issue.updatedAt) : '',
)
</script>

<template>
  <div class="fdp-root">
    <div v-if="item !== null" class="fdp-columns">
      <div ref="scrollRootEl" class="fdp-main">
        <header class="fdp-head" :aria-label="t('forge.detailTitle')">
          <!-- Band 1: sticky nav. Back control, always present, plus a
               compact title echo that fades in once the real title (band 2)
               has scrolled entirely out of view. -->
          <div class="fdp-nav">
            <!-- A CROSS, not a back arrow. This button closes the panel:
                 the list it would "go back" to is the column right next to
                 it, still on screen, so an arrow would promise a navigation
                 that does not happen and contradict its own label. -->
            <button
              type="button"
              class="fdp-back"
              :aria-label="t('forge.detailClose')"
              @click="emit('close')"
            >
              <X class="fdp-back-icon" aria-hidden="true" />
            </button>
            <span
              class="fdp-title-echo"
              :class="{ 'fdp-title-echo--visible': showTitleEcho }"
              aria-hidden="true"
              >{{ title }}</span
            >
          </div>

          <!-- Band 2: the real title. Scrolls normally, no line cap; the
               observed sentinel for the nav band's echo. -->
          <div ref="titleSentinelEl" class="fdp-title-band">
            <h2 class="fdp-title">{{ title }}</h2>
          </div>

          <!-- Band 3: toolbar. Sticky right under the nav band on narrow
               widths, static (scrolls with the body) once wide. -->
          <div class="fdp-toolbar">
            <div class="fdp-badge-row">
              <span v-if="badge" class="fdp-state" :class="`fdp-state--${badge.variant}`">
                <GitPullRequest
                  v-if="item.kind === 'mr' && badge.variant === 'open'"
                  class="fdp-state-icon"
                  aria-hidden="true"
                />
                <GitPullRequestDraft
                  v-else-if="item.kind === 'mr' && badge.variant === 'draft'"
                  class="fdp-state-icon"
                  aria-hidden="true"
                />
                <GitMerge
                  v-else-if="item.kind === 'mr' && badge.variant === 'merged'"
                  class="fdp-state-icon"
                  aria-hidden="true"
                />
                <GitPullRequestClosed
                  v-else-if="item.kind === 'mr'"
                  class="fdp-state-icon"
                  aria-hidden="true"
                />
                <CircleDot
                  v-else-if="badge.variant === 'open'"
                  class="fdp-state-icon"
                  aria-hidden="true"
                />
                <CircleCheck v-else class="fdp-state-icon" aria-hidden="true" />
                {{ t(badge.labelKey) }}
              </span>
              <a
                class="fdp-number"
                :href="url ?? undefined"
                target="_blank"
                rel="noopener noreferrer"
                >{{ t('mrs.number', { n: number }) }}</a
              >
            </div>
            <a
              class="fdp-open"
              :href="url ?? undefined"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="t('forge.openItemAria', { title })"
            >
              <ExternalLink class="fdp-open-icon" aria-hidden="true" />
              {{ t('forge.detailOpenLabel') }}
            </a>
          </div>
        </header>

        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="descriptionHtml !== null" class="fdp-md" v-html="descriptionHtml" />
        <p v-else class="fdp-description-empty">{{ t('forge.detailDescriptionEmpty') }}</p>
        <p v-if="isDescriptionShapeAbnormal" class="fdp-md-truncated">
          {{ t('forge.detailDescriptionShapeAbnormal') }}
          <a :href="url ?? undefined" target="_blank" rel="noopener noreferrer">{{
            t('forge.detailDescriptionTruncatedLink')
          }}</a>
        </p>
        <p v-else-if="isDescriptionTruncated" class="fdp-md-truncated">
          {{ t('forge.detailDescriptionTruncated') }}
          <a :href="url ?? undefined" target="_blank" rel="noopener noreferrer">{{
            t('forge.detailDescriptionTruncatedLink')
          }}</a>
        </p>
      </div>

      <div class="fdp-rail" role="region" :aria-label="t('forge.detailRailAria')">
        <MrMetaRail v-if="item.kind === 'mr'" :mr="item.mr" />
        <div v-else class="fdp-issue-rail">
          <section class="fdp-issue-rail-section">
            <h3 class="fdp-issue-rail-heading">
              <Tag class="fdp-issue-rail-heading-icon" aria-hidden="true" />
              <span>{{ t('mrs.rail.labels') }}</span>
            </h3>
            <p v-if="issueLabels.length === 0" class="fdp-issue-rail-empty">
              {{ t('mrs.rail.labelsEmpty') }}
            </p>
            <ul v-else class="fdp-issue-rail-chips">
              <li
                v-for="label in issueLabels"
                :key="label.name"
                class="fdp-issue-rail-label-chip"
                :style="labelPillStyle(label.color)"
              >
                {{ label.name }}
              </li>
            </ul>
          </section>
          <section class="fdp-issue-rail-section">
            <h3 class="fdp-issue-rail-heading">
              <Clock class="fdp-issue-rail-heading-icon" aria-hidden="true" />
              <span>{{ t('mrs.rail.dates') }}</span>
            </h3>
            <dl class="fdp-issue-rail-defs">
              <div class="fdp-issue-rail-def-row">
                <dt>{{ t('mrs.rail.openedAt', { age: issueOpenedAge }) }}</dt>
              </div>
              <div class="fdp-issue-rail-def-row">
                <dt>{{ t('mrs.rail.updatedAt', { age: issueUpdatedAge }) }}</dt>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>
    <p v-else class="fdp-empty">{{ t('forge.detailEmpty') }}</p>
  </div>
</template>

<style scoped>
.fdp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.fdp-columns {
  display: flex;
  align-items: stretch;
  gap: 24px;
  height: 100%;
  min-height: 0;
}

.fdp-main {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 16px;
}

.fdp-rail {
  flex: 0 0 236px;
  width: 236px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 16px;
}

@container fb-shell (min-width: 900px) {
  .fdp-main,
  .fdp-rail {
    padding-left: 24px;
    padding-right: 24px;
  }
}

@container fb-shell (max-width: 640px) {
  .fdp-columns {
    flex-direction: column;
  }

  .fdp-rail {
    flex: none;
    width: 100%;
  }
}

.fdp-head {
  display: flex;
  flex-direction: column;
  /* Shared sticky offset: the nav band's own min-height, reused as the
     toolbar band's sticky top so it docks flush under the nav band rather
     than at a second, hand-picked number that could drift out of sync. */
  --fdp-nav-h: 44px;
}

/* ── Band 1: sticky nav (back + title echo) ───────────────────────────── */
.fdp-nav {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: var(--fdp-nav-h);
  background: var(--cs-bg);
}

.fdp-back {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  padding: 4px 6px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.fdp-back:hover {
  border-color: var(--cs-line-3);
  color: var(--cs-text-2);
}

.fdp-back-icon {
  width: 14px;
  height: 14px;
}

/* Hidden by default, faded in once the title band (band 2) has scrolled
   entirely out of view (see the IntersectionObserver in the script). A
   plain opacity transition, deliberately not a keyframe animation with a
   fill mode: the global reduced-motion guard (style.css) clamps transition
   duration for users who asked for less motion, which only works because
   nothing here would freeze on a held keyframe. */
.fdp-title-echo {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 600;
  color: var(--cs-text);
  opacity: 0;
  transition: opacity 150ms ease;
}

.fdp-title-echo--visible {
  opacity: 1;
}

/* ── Band 2: the title itself, scrolls normally ───────────────────────── */
.fdp-title-band {
  padding: 16px 0 12px;
}

@container fb-shell (min-width: 640px) {
  .fdp-title-band {
    padding: 20px 0 0;
  }
}

.fdp-title {
  margin: 0;
  font-size: 27px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--cs-text);
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* ── Band 3: toolbar, sticky right under the nav band on narrow widths,
   static (scrolls with the body) once wide ───────────────────────────── */
.fdp-toolbar {
  position: sticky;
  top: var(--fdp-nav-h);
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  background: var(--cs-bg);
}

@container fb-shell (min-width: 640px) {
  .fdp-toolbar {
    position: static;
    padding: 16px 0;
  }
}

.fdp-badge-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--cs-muted);
}

.fdp-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
}

.fdp-state-icon {
  flex: none;
  width: 12px;
  height: 12px;
}

.fdp-state--open {
  color: var(--cs-green-text);
  background: var(--cs-green-soft);
}

.fdp-state--draft {
  color: var(--cs-muted);
  background: var(--cs-line-2);
}

.fdp-state--closed {
  color: var(--cs-red-text);
  background: var(--cs-red-soft);
}

.fdp-state--merged {
  color: var(--cs-lavender);
  background: var(--cs-lavender-soft);
}

.fdp-number {
  font-family: var(--font-mono);
  color: var(--cs-ghost);
  text-decoration: none;
}

.fdp-number:hover {
  color: var(--cs-green-text);
}

.fdp-open {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  padding: 4px 10px;
  border: none;
  border-radius: 8px;
  background: var(--cs-green);
  color: var(--cs-on-green);
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}

.fdp-open:hover {
  background: var(--cs-green-hover);
}

.fdp-open-icon {
  flex: none;
  width: 13px;
  height: 13px;
}

.fdp-md {
  margin: 20px 0 0;
  overflow-wrap: anywhere;
  color: var(--cs-text-2);
}

.fdp-md p {
  margin: 4px 0;
  line-height: 24px;
}

.fdp-md h1 {
  font-size: 20px;
  font-weight: 700;
}

.fdp-md h2 {
  font-size: 18px;
  font-weight: 700;
}

.fdp-md h3 {
  font-size: 16px;
  font-weight: 600;
}

.fdp-md h4 {
  font-size: 14px;
  font-weight: 600;
}

.fdp-md h5 {
  font-size: 14px;
  font-weight: 500;
}

.fdp-md h6 {
  font-size: 13px;
  font-weight: 500;
  color: var(--cs-muted);
}

.fdp-md code {
  font-family: var(--font-mono);
  background: var(--cs-surface);
  color: var(--cs-green-text);
  padding: 2px 6px;
  border-radius: 4px;
}

.fdp-md pre {
  background: var(--cs-surface);
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
}

.fdp-md pre code {
  background: transparent;
  color: inherit;
  padding: 0;
  border-radius: 0;
}

.fdp-md blockquote {
  margin: 0;
  border-left: 3px solid var(--cs-green-text);
  padding-left: 12px;
  color: var(--cs-muted);
  font-style: italic;
}

.fdp-md a {
  color: var(--cs-green-text);
  text-decoration: underline;
  text-decoration-style: solid;
  text-decoration-color: color-mix(in srgb, var(--cs-green-text) 40%, transparent);
}

.fdp-md a:hover {
  text-decoration-color: var(--cs-green-text);
}

.fdp-md a.fdp-md-ref {
  text-decoration-style: dotted;
}

.fdp-md ul,
.fdp-md ol {
  padding-left: 32px;
}

.fdp-md li + li {
  margin-top: 4px;
}

.fdp-md-fallback {
  white-space: pre-wrap;
}

.fdp-md-truncated {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--cs-ghost);
}

.fdp-md-truncated a {
  color: var(--cs-green-text);
  text-decoration: underline;
}

.fdp-description-empty {
  margin: 20px 0 0;
  color: var(--cs-ghost);
}

.fdp-empty {
  margin: auto;
  text-align: center;
  font-size: 12px;
  color: var(--cs-ghost);
  max-width: 220px;
}

/* ── Issue rail: same visual patron as MrMetaRail.vue's sections, kept as
   a small independent set of classes since ForgeIssue has too little data
   for MrMetaRail's own sections to make sense. ────────────────────────── */
.fdp-issue-rail {
  display: flex;
  flex-direction: column;
  font-size: 12.5px;
}

.fdp-issue-rail-section {
  padding-bottom: 14px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--cs-line-2);
}

.fdp-issue-rail-section:last-child {
  padding-bottom: 0;
  margin-bottom: 0;
  border-bottom: none;
}

.fdp-issue-rail-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-muted);
}

.fdp-issue-rail-heading-icon {
  flex: none;
  width: 12px;
  height: 12px;
}

.fdp-issue-rail-empty {
  margin: 0;
  color: var(--cs-ghost);
}

.fdp-issue-rail-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.fdp-issue-rail-label-chip {
  --lp-rest-bg: var(--cs-line-2);

  font-weight: 500;
  color: var(--cs-text-2);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--lp-rest-bg);
}

.fdp-issue-rail-defs {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fdp-issue-rail-def-row dt {
  color: var(--cs-text);
}
</style>

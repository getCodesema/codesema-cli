<script setup lang="ts">
// The forge board's detail panel: always visible, not conditioned on a
// selection, with a clean empty state while nothing is selected in the list
// panel (see ForgeBoard.vue). Two columns once something is selected: a
// flexible body (title, raw description) and a fixed-width metadata rail.
// The MR rail reuses MrMetaRail.vue as-is; an issue's rail is built inline
// here since ForgeIssue carries only labels and dates, not the reviewer/
// milestone/mergeable fields MrMetaRail depends on.
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
import { computed } from 'vue'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import MrMetaRail from '../mr/MrMetaRail.vue'
import type { ForgeDetailItem } from './ForgeLogic'
import { labelPillStyle } from './LabelColor'

const props = defineProps<{ item: ForgeDetailItem | null }>()

const emit = defineEmits<{ close: [] }>()

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
      <div class="fdp-main">
        <header class="fdp-head" :aria-label="t('forge.detailTitle')">
          <div class="fdp-head-main">
            <h2 class="fdp-title">{{ title }}</h2>
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
          </div>
          <div class="fdp-head-actions">
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
            <button
              type="button"
              class="fdp-close"
              :aria-label="t('forge.detailClose')"
              @click="emit('close')"
            >
              <X class="fdp-close-icon" aria-hidden="true" />
            </button>
          </div>
        </header>

        <p v-if="description" class="fdp-description">{{ description }}</p>
        <p v-else class="fdp-description-empty">{{ t('forge.detailDescriptionEmpty') }}</p>
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
  align-items: flex-start;
  gap: 12px;
}

.fdp-head-main {
  flex: 1;
  min-width: 0;
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

.fdp-badge-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
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

.fdp-head-actions {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 8px;
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

.fdp-close {
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

.fdp-close:hover {
  border-color: var(--cs-line-3);
  color: var(--cs-text-2);
}

.fdp-close-icon {
  width: 14px;
  height: 14px;
}

.fdp-description {
  margin: 20px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--cs-text-2);
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

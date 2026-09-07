<script setup lang="ts">
// The Checks tab: the sandboxed run of the worktree (containerized
// typecheck/tests/lint), one row per check with a foldable output tail, the
// manual re-run, and the agent-assisted setup card — which writes nothing
// without an explicit Apply.
import { computed, ref } from 'vue'
import {
  CHECK_GLYPH,
  CHECK_STATUS_KEY,
  CHECKS_STATUS_KEY,
  checksHeadVerified,
  checksSetupCard,
  checksSetupErrorText,
  checksSourceLabel,
  checksTone,
  COMMAND_DIFF_GLYPH,
  shortSha,
  type ChecksSetupState,
  type ChecksTone,
} from '../../composables/useChecks'
import { formatDuration, timeAgo } from '../../composables/useTaskBoard'
import type { ApiResult } from '../../composables/useTasks'
import type { StatusTone } from '../../execution-status'
import { t } from '../../i18n'
import type { TaskChecks } from '../../types'

const props = defineProps<{
  checks: TaskChecks | null
  /** A run needs a commit to verify; the server 409s the guard anyway. */
  commitCount: number
  /** Agent-assisted setup state of the project; undefined until the first GET. */
  checksSetup: ChecksSetupState | undefined
  /** Slow clock (epoch ms) of the conversation, for the "il y a X" stamp. */
  slowNow: number
  runChecks: () => Promise<ApiResult>
  runChecksSetup: () => Promise<ApiResult>
  applyChecksProposal: () => Promise<ApiResult>
  dismissChecksProposal: () => void
}>()

const TONE: Record<ChecksTone, StatusTone> = {
  none: 'idle',
  run: 'info',
  pass: 'ok',
  fail: 'err',
  warn: 'warn',
}
const tone = computed(() => TONE[checksTone(props.checks)])
const running = computed(() => props.checks?.status === 'running')
const canRun = computed(() => props.commitCount > 0 && !running.value)
const busy = ref(false)
const error = ref<string | null>(null)

async function doRunChecks(): Promise<void> {
  if (!canRun.value || busy.value) {
    return
  }
  busy.value = true
  error.value = null
  const result = await props.runChecks()
  busy.value = false
  if (!result.ok) {
    error.value = result.error
  }
}

/** "detected: lefthook" chip — silent when the run carries no provenance. */
const sourceText = computed(() => checksSourceLabel(props.checks))

/** "il y a X" stamp of the verified head (finished, else started). */
const stamp = computed(() => {
  const current = props.checks
  return current === null ? null : timeAgo(current.finished_at ?? current.started_at, props.slowNow)
})

// ── Agent-assisted setup: propose a plan, apply it on an explicit click ────
// The plan in force, as far as this tab can honestly tell: the commands the
// last run actually executed.
const setupCard = computed(() =>
  checksSetupCard(props.checksSetup, props.checks?.checks.map((check) => check.command) ?? []),
)
const setupBusy = ref(false)
const setupError = ref<string | null>(null)

async function runSetup(action: () => Promise<ApiResult>): Promise<void> {
  if (setupBusy.value) {
    return
  }
  setupBusy.value = true
  setupError.value = null
  const result = await action()
  setupBusy.value = false
  if (!result.ok) {
    setupError.value = checksSetupErrorText(result.status, result.error)
  }
}

function dismissProposal(): void {
  setupError.value = null
  props.dismissChecksProposal()
}
</script>

<template>
  <div class="cv-checks">
    <div class="cv-checks-bar">
      <template v-if="checks">
        <span class="cv-checks-badge badge" :data-tone="tone">
          <span v-if="running" class="cv-checks-dot status" data-tone="info" aria-hidden="true" />
          {{ t(CHECKS_STATUS_KEY[checks.status]) }}
        </span>
        <span v-if="checksHeadVerified(checks)" class="cv-checks-head">
          {{ t('workspace.checksHeadVerified', { sha: shortSha(checks.head_sha) })
          }}<template v-if="stamp"> · {{ stamp }}</template>
        </span>
        <!-- Where the plan came from; silent unless the server says so. -->
        <span v-if="sourceText" class="cv-checks-source">{{ sourceText }}</span>
      </template>
      <span v-else class="cv-checks-none">{{ t('workspace.checksNeverRan') }}</span>
      <button
        class="cv-btn cv-checks-rerun btn"
        type="button"
        :disabled="!canRun || busy"
        :title="commitCount === 0 ? t('workspace.checksNoCommitHint') : undefined"
        @click="doRunChecks"
      >
        {{ checks ? t('workspace.checksRerun') : t('workspace.checksRunNow') }}
      </button>
    </div>

    <p v-if="error" class="cv-error">{{ error }}</p>
    <!-- Runner-level failure (no container engine…): the readable message. -->
    <p v-if="checks?.status === 'error' && checks.error" class="cv-checks-broken">
      {{ checks.error }}
    </p>
    <!-- Unconfigured (or never ran): say how to configure / when it runs. -->
    <p v-if="checks?.status === 'unconfigured'" class="cv-checks-hint">
      {{ t('workspace.checksUnconfiguredHint') }}
    </p>
    <p v-else-if="!checks" class="cv-checks-hint">{{ t('workspace.checksAutoHint') }}</p>

    <!-- Agent-assisted setup. Prominent while nothing is configured; once a
         plan exists it shrinks to the discreet link below the list. Nothing
         is EVER written without the explicit "Apply" click. -->
    <section
      v-if="setupCard.mode !== 'offer' || !setupCard.discreet"
      class="cv-setup"
      :class="`cv-setup--${setupCard.mode}`"
    >
      <template v-if="setupCard.mode === 'offer'">
        <p class="cv-setup-intro">{{ t('workspace.checksSetupIntro') }}</p>
        <button
          class="cv-btn cv-setup-cta btn"
          type="button"
          :disabled="setupBusy"
          @click="runSetup(props.runChecksSetup)"
        >
          {{ t(setupCard.actionKey) }}
        </button>
      </template>

      <!-- A real LLM call: say it, and keep the signal honest. -->
      <template v-else-if="setupCard.mode === 'running'">
        <p class="cv-setup-running">
          <span class="cv-checks-dot status" data-tone="info" aria-hidden="true" />
          {{ t('workspace.checksSetupRunning') }}
        </p>
        <p class="cv-setup-hint">{{ t('workspace.checksSetupRunningHint') }}</p>
      </template>

      <template v-else-if="setupCard.mode === 'error'">
        <p class="cv-setup-error">{{ setupCard.error ?? t('workspace.checksStatusError') }}</p>
        <button
          class="cv-btn cv-setup-cta btn"
          type="button"
          :disabled="setupBusy"
          @click="runSetup(props.runChecksSetup)"
        >
          {{ t(setupCard.actionKey) }}
        </button>
      </template>

      <template v-else-if="setupCard.proposal">
        <h3 class="cv-setup-title">
          {{
            setupCard.mode === 'applied'
              ? t('workspace.checksSetupAppliedTitle')
              : t('workspace.checksSetupProposalTitle')
          }}
        </h3>
        <dl class="cv-setup-plan kv">
          <dt>{{ t('workspace.checksSetupImage') }}</dt>
          <dd>
            <code>{{ setupCard.proposal.image }}</code>
          </dd>
          <dt>{{ t('workspace.checksSetupInstall') }}</dt>
          <dd>
            <code v-if="setupCard.proposal.install">{{ setupCard.proposal.install }}</code>
            <span v-else class="cv-setup-muted muted">{{
              t('workspace.checksSetupNoInstall')
            }}</span>
          </dd>
          <dt>{{ t('workspace.checksSetupCommands') }}</dt>
          <dd>
            <ul class="cv-setup-cmds">
              <li v-for="(command, i) in setupCard.proposal.commands" :key="i">
                <code>{{ command }}</code>
              </li>
            </ul>
          </dd>
          <dt>{{ t('workspace.checksSetupNetwork') }}</dt>
          <dd>
            {{
              setupCard.proposal.network
                ? t('workspace.checksSetupNetworkInstall')
                : t('workspace.checksSetupNetworkNone')
            }}
          </dd>
          <dt>{{ t('workspace.checksSetupTimeout') }}</dt>
          <dd>
            {{ t('workspace.checksSetupTimeoutValue', { n: setupCard.proposal.timeoutSeconds }) }}
          </dd>
        </dl>

        <p v-if="setupCard.proposal.rationale" class="cv-setup-rationale">
          <span class="cv-setup-rationale-label">{{ t('workspace.checksSetupRationale') }}</span>
          {{ setupCard.proposal.rationale }}
        </p>

        <!-- Regeneration over an existing plan: current vs proposed. -->
        <template v-if="setupCard.diff.length > 0">
          <h4 class="cv-setup-subtitle">{{ t('workspace.checksSetupCompare') }}</h4>
          <ul class="cv-setup-diff">
            <li v-for="(row, i) in setupCard.diff" :key="i" :class="`cv-setup-diff--${row.state}`">
              <span class="cv-setup-diff-glyph" aria-hidden="true">
                {{ COMMAND_DIFF_GLYPH[row.state] }}
              </span>
              <code>{{ row.command }}</code>
              <span class="cv-setup-diff-state">{{
                row.state === 'kept'
                  ? t('workspace.checksSetupDiffKept')
                  : row.state === 'added'
                    ? t('workspace.checksSetupDiffAdded')
                    : t('workspace.checksSetupDiffRemoved')
              }}</span>
            </li>
          </ul>
        </template>

        <template v-if="setupCard.mode === 'applied'">
          <p class="cv-setup-hint">{{ t('workspace.checksSetupAppliedHint') }}</p>
          <button
            class="cv-setup-link"
            type="button"
            :disabled="setupBusy"
            @click="runSetup(props.runChecksSetup)"
          >
            {{ t(setupCard.actionKey) }}
          </button>
        </template>
        <div v-else class="cv-setup-actions">
          <button
            class="cv-btn cv-setup-apply btn primary"
            type="button"
            :disabled="setupBusy"
            @click="runSetup(props.applyChecksProposal)"
          >
            {{ t('workspace.checksSetupApply') }}
          </button>
          <button
            class="cv-btn cv-setup-dismiss btn ghost"
            type="button"
            :disabled="setupBusy"
            @click="dismissProposal"
          >
            {{ t('workspace.checksSetupDismiss') }}
          </button>
        </div>
      </template>

      <p v-if="setupError" class="cv-error">{{ setupError }}</p>
    </section>

    <ul v-if="checks && checks.checks.length > 0" class="cv-check-list checks">
      <li
        v-for="(check, i) in checks.checks"
        :key="i"
        class="cv-check check-row"
        :data-s="check.status"
      >
        <span
          class="cv-check-glyph g"
          :title="t(CHECK_STATUS_KEY[check.status])"
          aria-hidden="true"
        >
          {{ CHECK_GLYPH[check.status] }}
        </span>
        <code class="cv-check-cmd">{{ check.command }}</code>
        <span class="cv-check-meta r">
          {{ t(CHECK_STATUS_KEY[check.status])
          }}<template v-if="check.exit_code !== null">
            · {{ t('workspace.checksExitCode', { n: check.exit_code }) }}</template
          ><template v-if="check.duration_ms > 0">
            · {{ formatDuration(check.duration_ms) }}</template
          >
        </span>
        <details v-if="check.tail.trim().length > 0" class="cv-check-tail">
          <summary class="cv-check-tail-summary">{{ t('workspace.checksTail') }}</summary>
          <pre class="cv-check-pre log">{{ check.tail }}</pre>
        </details>
      </li>
    </ul>

    <!-- A plan already runs: the agent setup stays a discreet regeneration. -->
    <div v-if="setupCard.mode === 'offer' && setupCard.discreet" class="cv-setup-foot">
      <button
        class="cv-setup-link"
        type="button"
        :disabled="setupBusy"
        @click="runSetup(props.runChecksSetup)"
      >
        {{ t(setupCard.actionKey) }}
      </button>
      <p v-if="setupError" class="cv-error">{{ setupError }}</p>
    </div>
  </div>
</template>

<style scoped>
.cv-checks {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--row) 2ch;
  display: flex;
  flex-direction: column;
  gap: var(--row);
}

.cv-checks-bar {
  display: flex;
  align-items: baseline;
  gap: 2ch;
  flex-wrap: wrap;
}

.cv-checks-badge {
  font-weight: 700;
}

.cv-checks-dot {
  margin-right: 1ch;
}

.cv-checks-head,
.cv-checks-none,
.cv-checks-source {
  font-size: 12px;
  color: var(--fg-dim);
}

.cv-checks-source {
  border: 1px solid var(--line);
  padding: 0 1ch;
}

.cv-checks-rerun {
  margin-left: auto;
  color: var(--fg-dim);
}

.cv-checks-hint {
  margin: 0;
  color: var(--fg-dim);
}

/* The runner's own failure message (e.g. no container engine installed). */
.cv-checks-broken {
  margin: 0;
  color: var(--warn);
  overflow-wrap: anywhere;
}

.cv-error {
  margin: 0;
  color: var(--err);
  overflow-wrap: anywhere;
}

/* ── Agent-assisted setup: the validation card ─────────────────────────── */
.cv-setup {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  border: 1px solid var(--line);
  padding: calc(var(--row) / 2) 1ch;
}

/* A proposal is a decision waiting on the reader: give it the amber border. */
.cv-setup--review {
  border-color: var(--warn);
}

.cv-setup--applied {
  border-color: var(--ok);
}

.cv-setup-intro,
.cv-setup-hint,
.cv-setup-rationale {
  margin: 0;
  color: var(--fg-dim);
}

.cv-setup-title {
  margin: 0;
  font-size: var(--fs);
  font-weight: 700;
  color: var(--fg);
}

.cv-setup-subtitle {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--fg-dim);
}

.cv-setup-cta {
  align-self: flex-start;
  color: var(--fg-dim);
}

.cv-setup-running {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  margin: 0;
  color: var(--info);
}

.cv-setup-error {
  margin: 0;
  color: var(--err);
  overflow-wrap: anywhere;
}

.cv-setup-plan {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0 2ch;
  margin: 0;
  font-size: 12px;
}

.cv-setup-plan dt {
  color: var(--fg-dim);
}

.cv-setup-plan dd {
  margin: 0;
  min-width: 0;
  color: var(--fg);
  overflow-wrap: anywhere;
}

.cv-setup-cmds,
.cv-setup-diff {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.cv-setup-diff li {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  min-width: 0;
}

.cv-setup-diff-glyph {
  flex: none;
  width: 2ch;
  text-align: center;
  font-weight: 700;
}

.cv-setup-diff-state {
  margin-left: auto;
  flex: none;
  font-size: 12px;
  color: var(--fg-dim);
}

.cv-setup-diff--added .cv-setup-diff-glyph {
  color: var(--ok);
}

.cv-setup-diff--removed .cv-setup-diff-glyph,
.cv-setup-diff--removed code {
  color: var(--err);
}

.cv-setup-diff--kept .cv-setup-diff-glyph,
.cv-setup-diff--kept code {
  color: var(--fg-dim);
}

.cv-setup-rationale-label {
  color: var(--fg-dim);
  margin-right: 1ch;
}

.cv-setup-actions {
  display: flex;
  gap: 1ch;
}

/* Discreet entry point once a plan already runs. */
.cv-setup-foot {
  display: flex;
  flex-direction: column;
}

.cv-setup-link {
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--fg-dim);
  cursor: pointer;
  text-decoration: underline dotted;
}

.cv-setup-link:hover:enabled {
  color: var(--fg);
}

.cv-setup-link:disabled {
  cursor: default;
}

.cv-check-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.cv-check-cmd {
  min-width: 0;
  font-size: 12px;
  color: var(--fg);
  overflow-wrap: anywhere;
}

.cv-check-meta {
  flex: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.cv-check-tail-summary {
  cursor: pointer;
  list-style: none;
  font-size: 12px;
  color: var(--fg-dim);
}

.cv-check-tail-summary::-webkit-details-marker {
  display: none;
}

.cv-check-tail-summary::before {
  content: '▸ ';
}

.cv-check-tail[open] .cv-check-tail-summary::before {
  content: '▾ ';
}

/* The captured stdout+stderr tail: mono, inset, scrolls on its own. */
.cv-check-pre {
  margin: calc(var(--row) / 2) 0 0;
  padding: 2px 1ch;
  background: var(--bg);
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--fg-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: calc(var(--row) * 12);
  overflow-y: auto;
}
</style>

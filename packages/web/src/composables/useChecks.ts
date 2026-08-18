// Pure derivations of the sandboxed-checks state (checks.json mirror): the
// tab label semaphore, pass/fail aggregates, the queue mini-badge and the
// 'checks' journal line. Components only compose these functions (bun:test).

import { t, type MessageKey } from '../i18n'
import type {
  TaskCheck,
  TaskChecks,
  TaskChecksSource,
  TaskCheckStatus,
  TaskEventData,
} from '../types'
import type { EventTone } from './useTaskBoard'

/** Visual tone of the Checks tab label (and the queue badge). */
export type ChecksTone = 'none' | 'run' | 'pass' | 'fail' | 'warn'

const TONE_BY_STATUS: Record<TaskChecks['status'], ChecksTone> = {
  running: 'run',
  passed: 'pass',
  failed: 'fail',
  // The runner itself broke (no container engine…): neither pass nor fail.
  error: 'warn',
  unconfigured: 'none',
}

export function checksTone(checks: Pick<TaskChecks, 'status'> | null): ChecksTone {
  return checks === null ? 'none' : TONE_BY_STATUS[checks.status]
}

const TAB_SUFFIX: Record<ChecksTone, string> = {
  none: '',
  run: ' …',
  pass: ' ✓',
  fail: ' ✗',
  warn: ' ⚠',
}

/** The tab IS the semaphore: "Checks ✓" green / "Checks ✗" red / "Checks …"
 * while running; bare "Checks" when nothing ran or nothing is configured. */
export function checksTabLabel(checks: Pick<TaskChecks, 'status'> | null): string {
  return `${t('workspace.tabChecks')}${TAB_SUFFIX[checksTone(checks)]}`
}

/** Queue mini-badge glyph; null = no badge (never ran / unconfigured). */
export function checksBadge(checks: Pick<TaskChecks, 'status'> | null): string | null {
  const suffix = TAB_SUFFIX[checksTone(checks)].trim()
  return suffix === '' ? null : suffix
}

/** passed/failed aggregates; a timeout counts as failed, skipped as neither. */
export function checksCounts(checks: readonly Pick<TaskCheck, 'status'>[]): {
  passed: number
  failed: number
} {
  let passed = 0
  let failed = 0
  for (const check of checks) {
    if (check.status === 'passed') {
      passed++
    } else if (check.status === 'failed' || check.status === 'timeout') {
      failed++
    }
  }
  return { passed, failed }
}

const int = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0

/** One journal line for a 'checks' event ({ status, passed, failed }):
 * "Checks — 3 passed" on go, "Checks — 1 failed" on stop. */
export function checksEventLine(data: TaskEventData): { tone: EventTone; text: string } {
  switch (data.status) {
    case 'passed': {
      const n = int(data.passed)
      return { tone: 'go', text: t('workspace.checksEvPassed', { n }, n) }
    }
    case 'failed': {
      const n = int(data.failed)
      return { tone: 'stop', text: t('workspace.checksEvFailed', { n }, n) }
    }
    case 'error':
      return { tone: 'stop', text: t('workspace.checksEvError') }
    case 'unconfigured':
      return { tone: 'idle', text: t('workspace.checksEvUnconfigured') }
    default:
      // A status this bundle does not know: label only, never a crash.
      return { tone: 'idle', text: t('workspace.evChecks') }
  }
}

/** Global status phrase of the tab body's badge. */
export const CHECKS_STATUS_KEY: Record<TaskChecks['status'], MessageKey> = {
  running: 'workspace.checksStatusRunning',
  passed: 'workspace.checksStatusPassed',
  failed: 'workspace.checksStatusFailed',
  error: 'workspace.checksStatusError',
  unconfigured: 'workspace.checksStatusUnconfigured',
}

/** Per-check row: status glyph + localized word. */
export const CHECK_GLYPH: Record<TaskCheckStatus, string> = {
  passed: '✓',
  failed: '✗',
  timeout: '⏱',
  skipped: '–',
}

export const CHECK_STATUS_KEY: Record<TaskCheckStatus, MessageKey> = {
  passed: 'workspace.checkPassed',
  failed: 'workspace.checkFailed',
  timeout: 'workspace.checkTimeout',
  skipped: 'workspace.checkSkipped',
}

/** Short display form of the verified head commit. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

// ── Plan provenance (optional server field) ───────────────────────────────
// The server labels WHERE the executed plan came from: the repo's .codesema
// config, its own lefthook/CI declarations, or the lockfile scripts. The
// field is optional — a checks.json written before it existed, or a run that
// resolved no plan, carries none and simply shows nothing.

const CHECKS_SOURCE_KEY: Record<TaskChecksSource, MessageKey> = {
  config: 'workspace.checksSourceConfig',
  lefthook: 'workspace.checksSourceLefthook',
  ci: 'workspace.checksSourceCi',
  scripts: 'workspace.checksSourceScripts',
}

/** Localized "detected: lefthook" chip, or null when the server says nothing
 * (or says something this bundle does not know — never render a raw token). */
export function checksSourceLabel(checks: Pick<TaskChecks, 'source'> | null): string | null {
  const source = checks?.source
  if (typeof source !== 'string') {
    return null
  }
  const key = CHECKS_SOURCE_KEY[source as TaskChecksSource]
  return key === undefined ? null : t(key)
}

// ── Agent-assisted setup (/api/projects/:id/checks-setup) ─────────────────
// The user's agent reads the repo files codesema already collected and answers
// a checks plan. That plan is a PROPOSAL: nothing is ever written to
// .codesema/config.json without an explicit apply. Everything below is pure —
// the composable owns the fetches, the component only renders these results.

export type ChecksProposal = {
  image: string
  /** Dependency install step; null = none. */
  install: string | null
  commands: string[]
  /** True: only the install step gets network access, checks never do. */
  network: boolean
  timeoutSeconds: number
  rationale: string
}

export type ChecksSetupStatus = 'idle' | 'running' | 'ready' | 'error'

export type ChecksSetupState = {
  status: ChecksSetupStatus
  proposal: ChecksProposal | null
  error: string | null
  /** Config the server reports as already written, when it exposes one; also
   * filled locally with the proposal this client just applied. */
  current: ChecksProposal | null
  /** Set right after a successful apply: the card confirms what was written. */
  applied: boolean
}

export const IDLE_CHECKS_SETUP: ChecksSetupState = {
  status: 'idle',
  proposal: null,
  error: null,
  current: null,
  applied: false,
}

// These bounds MIRROR the server's (packages/cli/src/checks-setup.ts and its
// DEFAULT_CHECK_TIMEOUT_SECONDS): the server is the source of truth and a
// looser client would accept a plan the server itself would have trimmed.
const PROPOSAL_IMAGE_MAX = 200
const PROPOSAL_COMMAND_MAX = 300
const PROPOSAL_COMMANDS_MAX = 8
const PROPOSAL_RATIONALE_MAX = 500
/** The server's error sentence is not a proposal field: its own bound. */
const PROPOSAL_ERROR_MAX = 500
const TIMEOUT_MIN = 30
const TIMEOUT_MAX = 3600
const TIMEOUT_DEFAULT = 300

const trimmed = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

const SETUP_STATUSES: ReadonlySet<string> = new Set(['idle', 'running', 'ready', 'error'])

/**
 * Client-side revalidation of a proposal received over HTTP or SSE. The server
 * sanitizes it too; this is defense in depth AND the only thing standing
 * between a malformed frame and a card that claims a plan it cannot show.
 * Null when the payload carries neither an image nor a single command.
 */
export function sanitizeChecksProposal(raw: unknown): ChecksProposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const p = raw as Record<string, unknown>
  const image = trimmed(p.image, PROPOSAL_IMAGE_MAX)
  const commands = Array.isArray(p.commands)
    ? p.commands
        .map((command) => trimmed(command, PROPOSAL_COMMAND_MAX))
        .filter((command) => command !== '')
        .slice(0, PROPOSAL_COMMANDS_MAX)
    : []
  if (image === '' || commands.length === 0) {
    return null
  }
  const install = trimmed(p.install, PROPOSAL_COMMAND_MAX)
  const timeout = Number.isInteger(p.timeoutSeconds)
    ? (p.timeoutSeconds as number)
    : TIMEOUT_DEFAULT
  return {
    image,
    install: install === '' ? null : install,
    commands,
    network: p.network === true,
    timeoutSeconds: Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, timeout)),
    rationale: trimmed(p.rationale, PROPOSAL_RATIONALE_MAX),
  }
}

/**
 * Tolerant parse of GET /api/projects/:id/checks-setup and of the
 * 'checks_proposal' SSE frame. Accepts BOTH shapes on purpose: the state
 * envelope ({ status, proposal?, error?, current? }) and a bare proposal
 * object — a frame that carries only the plan still reads as "ready".
 */
export function parseChecksSetup(raw: unknown): ChecksSetupState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return IDLE_CHECKS_SETUP
  }
  const body = raw as Record<string, unknown>
  const current = sanitizeChecksProposal(body.current)
  if (!SETUP_STATUSES.has(String(body.status))) {
    // Bare proposal (or junk): a valid plan is ready, anything else is idle.
    const proposal = sanitizeChecksProposal(body)
    return proposal === null
      ? { ...IDLE_CHECKS_SETUP, current }
      : { status: 'ready', proposal, error: null, current, applied: false }
  }
  const proposal = sanitizeChecksProposal(body.proposal)
  const status = body.status as ChecksSetupStatus
  return {
    // 'ready' without a usable plan would show an empty card: stay idle.
    status: status === 'ready' && proposal === null ? 'idle' : status,
    proposal,
    error: trimmed(body.error, PROPOSAL_ERROR_MAX) || null,
    current,
    applied: false,
  }
}

/**
 * Folds a freshly parsed state (GET or SSE) into the one this client holds.
 * Applying CONSUMES the proposal server-side, which immediately broadcasts an
 * 'idle' state: taken literally that frame would erase the confirmation the
 * user is reading. An idle frame therefore never overwrites a local apply —
 * anything else (a new run, a new proposal, an error) does.
 */
export function mergeChecksSetup(
  previous: ChecksSetupState | undefined,
  incoming: ChecksSetupState,
): ChecksSetupState {
  if (previous?.applied === true && incoming.status === 'idle') {
    // Keep a `current` the server does expose, it beats our local copy.
    return { ...previous, current: incoming.current ?? previous.current }
  }
  return incoming
}

export type CommandDiffState = 'kept' | 'added' | 'removed'
export type CommandDiffRow = { command: string; state: CommandDiffState }

export const COMMAND_DIFF_GLYPH: Record<CommandDiffState, string> = {
  kept: '=',
  added: '+',
  removed: '−',
}

/**
 * Current plan vs proposed plan, as one list: the proposed commands in their
 * order (kept or added), then the current ones the proposal drops.
 */
export function commandDiffRows(
  current: readonly string[],
  proposed: readonly string[],
): CommandDiffRow[] {
  const currentSet = new Set(current)
  const proposedSet = new Set(proposed)
  const rows: CommandDiffRow[] = proposed.map((command) => ({
    command,
    state: currentSet.has(command) ? 'kept' : 'added',
  }))
  for (const command of current) {
    if (!proposedSet.has(command)) {
      rows.push({ command, state: 'removed' })
    }
  }
  return rows
}

/** What the setup zone of the Checks tab renders right now. */
export type ChecksSetupMode = 'offer' | 'running' | 'review' | 'error' | 'applied'

export type ChecksSetupCard = {
  mode: ChecksSetupMode
  /** i18n key of the primary action (offer and error modes). */
  actionKey: MessageKey
  /** A plan already exists: the entry point stays a discreet regeneration. */
  discreet: boolean
  /** The plan to render: the proposal under review, the applied config. */
  proposal: ChecksProposal | null
  error: string | null
  /** Non-empty only when there is a current plan to compare against. */
  diff: CommandDiffRow[]
}

function setupMode(state: ChecksSetupState): ChecksSetupMode {
  if (state.applied) {
    return 'applied'
  }
  if (state.status === 'running' || state.status === 'error') {
    return state.status
  }
  // 'ready' is only a review when a renderable plan came with it.
  return state.status === 'ready' && state.proposal !== null ? 'review' : 'offer'
}

/** The plan the card renders: the proposal under review, the applied config. */
function setupPlan(state: ChecksSetupState, mode: ChecksSetupMode): ChecksProposal | null {
  if (mode === 'applied') {
    return state.current
  }
  return mode === 'review' ? state.proposal : null
}

function setupDiff(current: readonly string[], proposal: ChecksProposal | null): CommandDiffRow[] {
  // Nothing in force yet: a first plan is not a change, it IS the plan.
  if (proposal === null || current.length === 0) {
    return []
  }
  return commandDiffRows(current, proposal.commands)
}

/** A failed run retries; over an existing plan the entry point regenerates. */
function setupActionKey(mode: ChecksSetupMode, discreet: boolean): MessageKey {
  if (mode === 'error') {
    return 'workspace.checksSetupRetry'
  }
  return discreet ? 'workspace.checksSetupRegenerate' : 'workspace.checksSetupCta'
}

/**
 * Derives the setup card from the project's setup state and the commands of
 * the plan currently in force (the server's `current`, else what the last run
 * actually executed). Undefined state = never fetched: offer the setup.
 */
export function checksSetupCard(
  setup: ChecksSetupState | undefined,
  currentCommands: readonly string[] = [],
): ChecksSetupCard {
  const state = setup ?? IDLE_CHECKS_SETUP
  const current = state.current?.commands ?? currentCommands
  // No plan in force: the setup is the headline action, not a footnote.
  const discreet = current.length > 0
  const mode = setupMode(state)
  const proposal = setupPlan(state, mode)
  return {
    mode,
    actionKey: setupActionKey(mode, discreet),
    discreet,
    proposal,
    error: mode === 'error' ? state.error : null,
    diff: setupDiff(current, mode === 'review' ? proposal : null),
  }
}

/** Readable failure of a setup/apply POST: the two contract statuses get a
 * real sentence, anything else shows the server's own message. */
export function checksSetupErrorText(status: number, error: string): string {
  if (status === 501) {
    return t('workspace.checksSetupNoAgent')
  }
  if (status === 409) {
    return t('workspace.checksSetupBusy')
  }
  return error
}

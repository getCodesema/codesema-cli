import { describe, expect, test } from 'bun:test'
import type { TaskCheck } from '../types'
import {
  checksBadge,
  checksCounts,
  checksEventLine,
  checksSetupCard,
  checksSetupErrorText,
  checksSourceLabel,
  checksTabLabel,
  checksTone,
  commandDiffRows,
  IDLE_CHECKS_SETUP,
  mergeChecksSetup,
  parseChecksSetup,
  sanitizeChecksProposal,
  shortSha,
  type ChecksSetupState,
} from './useChecks'

const check = (status: TaskCheck['status']): Pick<TaskCheck, 'status'> => ({ status })

describe('checksTabLabel', () => {
  test('never ran or unconfigured stays a bare label', () => {
    expect(checksTabLabel(null)).toBe('Checks')
    expect(checksTabLabel({ status: 'unconfigured' })).toBe('Checks')
  })

  test('the label is the semaphore: … while running, ✓ green, ✗ red', () => {
    expect(checksTabLabel({ status: 'running' })).toBe('Checks …')
    expect(checksTabLabel({ status: 'passed' })).toBe('Checks ✓')
    expect(checksTabLabel({ status: 'failed' })).toBe('Checks ✗')
  })

  test('a broken runner is a warning, never a pass or a fail', () => {
    expect(checksTabLabel({ status: 'error' })).toBe('Checks ⚠')
    expect(checksTone({ status: 'error' })).toBe('warn')
  })
})

describe('checksBadge', () => {
  test('no badge when nothing ran or nothing is configured', () => {
    expect(checksBadge(null)).toBeNull()
    expect(checksBadge({ status: 'unconfigured' })).toBeNull()
  })

  test('one glyph per state', () => {
    expect(checksBadge({ status: 'running' })).toBe('…')
    expect(checksBadge({ status: 'passed' })).toBe('✓')
    expect(checksBadge({ status: 'failed' })).toBe('✗')
    expect(checksBadge({ status: 'error' })).toBe('⚠')
  })
})

describe('checksCounts', () => {
  test('timeouts count as failures, skipped counts as neither', () => {
    const counts = checksCounts([
      check('passed'),
      check('passed'),
      check('failed'),
      check('timeout'),
      check('skipped'),
    ])
    expect(counts).toEqual({ passed: 2, failed: 2 })
  })

  test('an empty run aggregates to zero on both sides', () => {
    expect(checksCounts([])).toEqual({ passed: 0, failed: 0 })
  })
})

describe('checksEventLine', () => {
  test('a green run reads its passed count (no window: English catalog)', () => {
    expect(checksEventLine({ status: 'passed', passed: 3, failed: 0 })).toEqual({
      tone: 'go',
      text: 'Checks — 3 passed',
    })
  })

  test('a red run reads its failed count', () => {
    expect(checksEventLine({ status: 'failed', passed: 2, failed: 1 })).toEqual({
      tone: 'stop',
      text: 'Checks — 1 failed',
    })
  })

  test('error stops, unconfigured stays idle', () => {
    expect(checksEventLine({ status: 'error' }).tone).toBe('stop')
    expect(checksEventLine({ status: 'unconfigured' }).tone).toBe('idle')
  })

  test('an unknown status or malformed counts degrade, never crash', () => {
    expect(checksEventLine({})).toEqual({ tone: 'idle', text: 'Checks' })
    expect(checksEventLine({ status: 'passed', passed: 'three' }).text).toBe('Checks — 0 passed')
  })
})

describe('shortSha', () => {
  test('displays the 7-char short form', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
    expect(shortSha('abc')).toBe('abc')
  })
})

describe('checksSourceLabel', () => {
  test('labels a provenance the bundle knows (no window: English catalog)', () => {
    expect(checksSourceLabel({ source: 'lefthook' })).toBe('detected: lefthook')
    expect(checksSourceLabel({ source: 'scripts' })).toBe('detected: scripts')
  })

  test('an absent or unknown source renders nothing, never a raw token', () => {
    expect(checksSourceLabel(null)).toBeNull()
    expect(checksSourceLabel({})).toBeNull()
    expect(checksSourceLabel({ source: 'nix-flake' })).toBeNull()
  })
})

const rawProposal = {
  image: 'oven/bun:1',
  install: 'bun install --frozen-lockfile',
  commands: ['bun run typecheck', 'bun test'],
  network: true,
  timeoutSeconds: 600,
  rationale: 'lefthook pre-push runs both',
}

describe('sanitizeChecksProposal', () => {
  test('keeps a well-formed plan as it stands', () => {
    expect(sanitizeChecksProposal(rawProposal)).toEqual({
      image: 'oven/bun:1',
      install: 'bun install --frozen-lockfile',
      commands: ['bun run typecheck', 'bun test'],
      network: true,
      timeoutSeconds: 600,
      rationale: 'lefthook pre-push runs both',
    })
  })

  test('a plan without an image or without a command is not renderable', () => {
    expect(sanitizeChecksProposal({ ...rawProposal, image: '  ' })).toBeNull()
    expect(sanitizeChecksProposal({ ...rawProposal, commands: [] })).toBeNull()
    expect(sanitizeChecksProposal({ ...rawProposal, commands: 'bun test' })).toBeNull()
    expect(sanitizeChecksProposal(null)).toBeNull()
    expect(sanitizeChecksProposal(['bun test'])).toBeNull()
  })

  test('drops empty commands, defaults network to false and empties a missing install', () => {
    const proposal = sanitizeChecksProposal({
      image: 'node:22',
      commands: ['npm test', '  ', 42],
    })
    expect(proposal?.commands).toEqual(['npm test'])
    expect(proposal?.network).toBe(false)
    expect(proposal?.install).toBeNull()
    expect(proposal?.rationale).toBe('')
  })

  test('clamps the timeout into the contract window', () => {
    expect(sanitizeChecksProposal({ ...rawProposal, timeoutSeconds: 1 })?.timeoutSeconds).toBe(30)
    expect(sanitizeChecksProposal({ ...rawProposal, timeoutSeconds: 99_999 })?.timeoutSeconds).toBe(
      3600,
    )
    // The fallback is the SERVER's default (DEFAULT_CHECK_TIMEOUT_SECONDS).
    expect(sanitizeChecksProposal({ ...rawProposal, timeoutSeconds: 'ten' })?.timeoutSeconds).toBe(
      300,
    )
  })

  test('truncates a rationale that would flood the card', () => {
    const long = sanitizeChecksProposal({ ...rawProposal, rationale: 'x'.repeat(900) })
    expect(long?.rationale.length).toBe(500)
  })

  test('image, command and list bounds mirror the server', () => {
    const proposal = sanitizeChecksProposal({
      image: `oven/bun:${'x'.repeat(400)}`,
      commands: Array.from({ length: 20 }, (_, i) => `bun run check-${i} ${'y'.repeat(400)}`),
    })
    expect(proposal?.image.length).toBe(200)
    expect(proposal?.commands.length).toBe(8)
    expect(proposal?.commands[0]?.length).toBe(300)
  })
})

describe('parseChecksSetup', () => {
  test('reads the state envelope of the GET endpoint', () => {
    const state = parseChecksSetup({ status: 'ready', proposal: rawProposal })
    expect(state.status).toBe('ready')
    expect(state.proposal?.commands).toEqual(['bun run typecheck', 'bun test'])
    expect(state.applied).toBe(false)
  })

  test("'ready' without a usable plan degrades to idle instead of an empty card", () => {
    expect(parseChecksSetup({ status: 'ready', proposal: { image: 'node:22' } }).status).toBe(
      'idle',
    )
  })

  test('a bare proposal frame still reads as ready', () => {
    const state = parseChecksSetup(rawProposal)
    expect(state.status).toBe('ready')
    expect(state.proposal?.image).toBe('oven/bun:1')
  })

  test('keeps the running state and its error, and picks up a current config', () => {
    expect(parseChecksSetup({ status: 'running' })).toEqual({
      status: 'running',
      proposal: null,
      error: null,
      current: null,
      applied: false,
    })
    expect(parseChecksSetup({ status: 'error', error: 'agent timed out' }).error).toBe(
      'agent timed out',
    )
    expect(parseChecksSetup({ status: 'idle', current: rawProposal }).current?.image).toBe(
      'oven/bun:1',
    )
  })

  test('junk degrades to idle, never a crash', () => {
    expect(parseChecksSetup(null)).toEqual(IDLE_CHECKS_SETUP)
    expect(parseChecksSetup('nope')).toEqual(IDLE_CHECKS_SETUP)
    expect(parseChecksSetup({ status: 'exploded' })).toEqual(IDLE_CHECKS_SETUP)
  })
})

describe('commandDiffRows', () => {
  test('proposed order first (kept/added), then what the plan drops', () => {
    expect(
      commandDiffRows(['bun test', 'bun run lint'], ['bun run typecheck', 'bun test']),
    ).toEqual([
      { command: 'bun run typecheck', state: 'added' },
      { command: 'bun test', state: 'kept' },
      { command: 'bun run lint', state: 'removed' },
    ])
  })

  test('no current plan means everything is an addition', () => {
    expect(commandDiffRows([], ['bun test'])).toEqual([{ command: 'bun test', state: 'added' }])
  })
})

const setup = (over: Partial<ChecksSetupState>): ChecksSetupState => ({
  ...IDLE_CHECKS_SETUP,
  ...over,
})

describe('mergeChecksSetup', () => {
  test('the idle frame the server broadcasts on apply keeps the confirmation', () => {
    const current = sanitizeChecksProposal(rawProposal)
    const applied = setup({ applied: true, current })
    expect(mergeChecksSetup(applied, parseChecksSetup({ status: 'idle' }))).toEqual(applied)
  })

  test('a new run, proposal or error always wins over the confirmation', () => {
    const applied = setup({ applied: true, current: sanitizeChecksProposal(rawProposal) })
    expect(mergeChecksSetup(applied, parseChecksSetup({ status: 'running' })).status).toBe(
      'running',
    )
    const errored = mergeChecksSetup(applied, parseChecksSetup({ status: 'error', error: 'x' }))
    expect(errored.status).toBe('error')
    expect(errored.applied).toBe(false)
  })

  test('without a local apply the incoming state simply replaces the old one', () => {
    const incoming = parseChecksSetup({ status: 'idle' })
    expect(mergeChecksSetup(undefined, incoming)).toEqual(incoming)
    expect(mergeChecksSetup(setup({ status: 'running' }), incoming)).toEqual(incoming)
  })
})

describe('checksSetupCard', () => {
  test('nothing fetched and nothing configured: the prominent offer', () => {
    const card = checksSetupCard(undefined, [])
    expect(card.mode).toBe('offer')
    expect(card.discreet).toBe(false)
    expect(card.actionKey).toBe('workspace.checksSetupCta')
  })

  test('a plan already runs: the offer becomes a discreet regeneration', () => {
    const card = checksSetupCard(undefined, ['bun test'])
    expect(card.mode).toBe('offer')
    expect(card.discreet).toBe(true)
    expect(card.actionKey).toBe('workspace.checksSetupRegenerate')
  })

  test('the agent call is its own mode (a spinner, not an empty card)', () => {
    expect(checksSetupCard(setup({ status: 'running' })).mode).toBe('running')
  })

  test('a proposal is reviewed and compared against the running plan', () => {
    const proposal = sanitizeChecksProposal(rawProposal)
    const card = checksSetupCard(setup({ status: 'ready', proposal }), ['bun test', 'bun run lint'])
    expect(card.mode).toBe('review')
    expect(card.proposal?.image).toBe('oven/bun:1')
    expect(card.diff).toEqual([
      { command: 'bun run typecheck', state: 'added' },
      { command: 'bun test', state: 'kept' },
      { command: 'bun run lint', state: 'removed' },
    ])
  })

  test('the server-reported current config wins over what the last run executed', () => {
    const proposal = sanitizeChecksProposal(rawProposal)
    const current = sanitizeChecksProposal({ ...rawProposal, commands: ['bun test'] })
    const card = checksSetupCard(setup({ status: 'ready', proposal, current }), ['make check'])
    expect(card.diff).toEqual([
      { command: 'bun run typecheck', state: 'added' },
      { command: 'bun test', state: 'kept' },
    ])
  })

  test('a first-time proposal shows no comparison list', () => {
    const proposal = sanitizeChecksProposal(rawProposal)
    expect(checksSetupCard(setup({ status: 'ready', proposal }), []).diff).toEqual([])
  })

  test('after an apply the card confirms the written config', () => {
    const current = sanitizeChecksProposal(rawProposal)
    const card = checksSetupCard(setup({ applied: true, current }), ['bun test'])
    expect(card.mode).toBe('applied')
    expect(card.proposal?.commands).toEqual(['bun run typecheck', 'bun test'])
    expect(card.diff).toEqual([])
  })

  test('a failed run offers a retry and carries the message', () => {
    const card = checksSetupCard(setup({ status: 'error', error: 'agent timed out' }))
    expect(card.mode).toBe('error')
    expect(card.actionKey).toBe('workspace.checksSetupRetry')
    expect(card.error).toBe('agent timed out')
  })
})

describe('checksSetupErrorText', () => {
  test('the two contract statuses get a real sentence', () => {
    expect(checksSetupErrorText(501, 'not implemented')).toContain('No agent is configured')
    expect(checksSetupErrorText(409, 'conflict')).toContain('already in progress')
  })

  test('anything else keeps the server message', () => {
    expect(checksSetupErrorText(500, 'boom')).toBe('boom')
    expect(checksSetupErrorText(0, 'Failed to fetch')).toBe('Failed to fetch')
  })
})

import { describe, expect, test } from 'bun:test'
import { TASK_TURNS_MAX, TICKS_PER_USD, type CostBasis, type TaskTurn } from './contract.js'
import {
  CENTS_PER_USD,
  createCostMeter,
  DERIVED_TICKS_PER_TOKEN_PER_CENT,
  foldTurnCost,
  harnessTicks,
  lowerBoundTicks,
  MAX_TURN_USD,
  normalizeModelId,
  partnerPlatformEnv,
  partnerPlatformModel,
  PRICED_MODELS,
  PRICES,
  selectPriceRow,
  TICKS_PER_TOKEN_PER_CENT,
  TOKENS_PER_MTOK,
  totalCost,
  turnCostOf,
  usdToTicks,
  ZERO_COUNTERS,
  type CostCounters,
  type CostDegradation,
  type PriceRow,
  type SettledCost,
} from './cost.js'

const AT = '2026-08-19T10:00:00.000Z'

const turn = (cost?: number, basis?: CostBasis): TaskTurn => ({
  prompt: 'p',
  response: null,
  question: null,
  started_at: AT,
  ended_at: null,
  ...(cost === undefined ? {} : { cost_ticks: cost }),
  ...(basis === undefined ? {} : { cost_basis: basis }),
})

const counters = (c: Partial<CostCounters>): CostCounters => ({ ...ZERO_COUNTERS, ...c })

/** Ticks of a lower bound that must exist; fails loudly instead of silently skipping. */
const bound = (model: string, c: Partial<CostCounters>, at = AT): number => {
  const result = lowerBoundTicks(model, counters(c), at)
  if (!('ticks' in result)) {
    throw new Error(`expected a priced lower bound for ${model}, got miss:${result.miss}`)
  }
  return result.ticks
}

describe('cost unit', () => {
  test('one tick is 1e-10 USD, and the per-token rate derives from it', () => {
    expect(TICKS_PER_USD).toBe(10_000_000_000)
    expect(1 / TICKS_PER_USD).toBe(1e-10)
    // The literal used by the arithmetic still says what the unit says.
    expect(TICKS_PER_TOKEN_PER_CENT).toBe(DERIVED_TICKS_PER_TOKEN_PER_CENT)
    expect(TICKS_PER_TOKEN_PER_CENT).toBe(TICKS_PER_USD / CENTS_PER_USD / TOKENS_PER_MTOK)
  })

  test('a published input rate lands on the published dollar amount', () => {
    // Claude Opus 5: $5 / MTok base input.
    expect(bound('claude-opus-5', { input: TOKENS_PER_MTOK })).toBe(5 * TICKS_PER_USD)
    // Claude Haiku 4.5: $1 / MTok base input, $0.10 / MTok cache read.
    expect(bound('claude-haiku-4-5', { input: TOKENS_PER_MTOK })).toBe(TICKS_PER_USD)
    expect(bound('claude-haiku-4-5', { cacheRead: TOKENS_PER_MTOK })).toBe(TICKS_PER_USD / 10)
  })
})

describe('usdToTicks — the module’s ONLY float to integer step', () => {
  test('a USD amount becomes whole ticks', () => {
    expect(usdToTicks(1)).toBe(TICKS_PER_USD)
    expect(usdToTicks(0)).toBe(0)
    expect(usdToTicks(0.0184604)).toBe(184_604_000)
  })

  test('anything that is not a bounded, finite, non-negative amount is UNKNOWN', () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0.01,
      MAX_TURN_USD + 1,
      '1.5',
      null,
      undefined,
      {},
    ]) {
      expect(usdToTicks(bad)).toBeNull()
    }
  })

  test('the bound keeps every accepted amount an exact integer', () => {
    const ticks = usdToTicks(MAX_TURN_USD)
    expect(ticks).toBe(MAX_TURN_USD * TICKS_PER_USD)
    expect(Number.isSafeInteger(ticks)).toBe(true)
  })
})

describe('normalizeModelId', () => {
  test('strips the first-party dated snapshot, and nothing else', () => {
    expect(normalizeModelId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5')
    expect(normalizeModelId('  CLAUDE-Opus-5  ')).toBe('claude-opus-5')
    expect(normalizeModelId('claude-opus-5')).toBe('claude-opus-5')
  })

  test('partner packaging is a SIGNAL, never erased', () => {
    // Erasing it would let a Bedrock id match a first-party row and be billed
    // at a price list that is not the one invoicing this run.
    expect(normalizeModelId('us.anthropic.claude-opus-4-5-20251101-v1:0')).toBe(
      'us.anthropic.claude-opus-4-5-20251101-v1:0',
    )
    expect(normalizeModelId('claude-sonnet-5@20260401')).toBe('claude-sonnet-5@20260401')
  })
})

describe('partner platforms', () => {
  test('the environment switches are detected, and only when truthy', () => {
    expect(partnerPlatformEnv({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('CLAUDE_CODE_USE_BEDROCK')
    expect(partnerPlatformEnv({ CLAUDE_CODE_USE_VERTEX: 'true' })).toBe('CLAUDE_CODE_USE_VERTEX')
    expect(partnerPlatformEnv({})).toBeNull()
    expect(partnerPlatformEnv({ CLAUDE_CODE_USE_BEDROCK: '0' })).toBeNull()
    expect(partnerPlatformEnv({ CLAUDE_CODE_USE_BEDROCK: 'false' })).toBeNull()
    expect(partnerPlatformEnv({ CLAUDE_CODE_USE_BEDROCK: '' })).toBeNull()
  })

  test('the partner SHAPES of a model id are detected', () => {
    expect(partnerPlatformModel('us.anthropic.claude-opus-4-5-20251101-v1:0')).toBe(true)
    expect(partnerPlatformModel('eu.anthropic.claude-sonnet-5')).toBe(true)
    expect(partnerPlatformModel('anthropic.claude-sonnet-5-v1:0')).toBe(true)
    expect(partnerPlatformModel('claude-sonnet-5@20260401')).toBe(true)
    // First-party ids, dated snapshot included, are not partner shapes.
    expect(partnerPlatformModel('claude-sonnet-5')).toBe(false)
    expect(partnerPlatformModel('claude-opus-4-5-20251101')).toBe(false)
  })
})

describe('price table', () => {
  test('every rate is a whole number of cents per MTok — the table holds no float', () => {
    expect(PRICES.length).toBeGreaterThan(0)
    for (const row of PRICES) {
      for (const rate of [
        row.input_cents_per_mtok,
        row.cache_read_cents_per_mtok,
        row.cache_write_5m_cents_per_mtok,
        row.cache_write_1h_cents_per_mtok,
      ]) {
        expect(Number.isSafeInteger(rate)).toBe(true)
        expect(rate).toBeGreaterThan(0)
        // And it converts to a whole ticks-per-token rate.
        expect(Number.isSafeInteger(rate * TICKS_PER_TOKEN_PER_CENT)).toBe(true)
      }
    }
  })

  test('the published cache multipliers hold on every row, in integer arithmetic', () => {
    // https://platform.claude.com/docs/en/about-claude/pricing — prompt caching:
    // cache read 0.1x base input, 5-minute write 1.25x, 1-hour write 2x.
    for (const row of PRICES) {
      const input = row.input_cents_per_mtok
      expect(row.cache_read_cents_per_mtok * 10).toBe(input)
      expect(row.cache_write_5m_cents_per_mtok * 4).toBe(input * 5)
      expect(row.cache_write_1h_cents_per_mtok).toBe(input * 2)
    }
  })

  test('the rows published for each model match the pricing page', () => {
    // Base input, $ / MTok, read 2026-08-19. Sonnet 5 is $2: its launch price
    // is now the standard one and the September increase was cancelled.
    const published: Record<string, number> = {
      'claude-fable-5': 1_000,
      'claude-mythos-5': 1_000,
      'claude-opus-5': 500,
      'claude-opus-4-8': 500,
      'claude-opus-4-7': 500,
      'claude-opus-4-6': 500,
      'claude-opus-4-5': 500,
      'claude-sonnet-5': 200,
      'claude-sonnet-4-6': 300,
      'claude-sonnet-4-5': 300,
      'claude-haiku-4-5': 100,
    }
    expect(PRICED_MODELS.toSorted()).toEqual(Object.keys(published).toSorted())
    for (const row of PRICES) {
      expect(row.input_cents_per_mtok).toBe(published[row.model] as number)
    }
  })

  test('every model the table declares IS priceable at the current date', () => {
    for (const model of PRICED_MODELS) {
      expect(bound(model, { input: 1_000 })).toBeGreaterThan(0)
    }
  })
})

describe('selectPriceRow — validity windows', () => {
  const rows: readonly PriceRow[] = [
    {
      model: 'm-intro',
      until: '2026-08-31',
      input_cents_per_mtok: 200,
      cache_read_cents_per_mtok: 20,
      cache_write_5m_cents_per_mtok: 250,
      cache_write_1h_cents_per_mtok: 400,
    },
    {
      model: 'm-intro',
      from: '2026-09-01',
      input_cents_per_mtok: 300,
      cache_read_cents_per_mtok: 30,
      cache_write_5m_cents_per_mtok: 375,
      cache_write_1h_cents_per_mtok: 600,
    },
    {
      model: 'm-orphan',
      until: '2026-01-31',
      input_cents_per_mtok: 100,
      cache_read_cents_per_mtok: 10,
      cache_write_5m_cents_per_mtok: 125,
      cache_write_1h_cents_per_mtok: 200,
    },
  ]

  const rate = (model: string, at: string): number | string => {
    const found = selectPriceRow(rows, model, at)
    return 'row' in found ? found.row.input_cents_per_mtok : found.miss
  }

  test('the row in force on the day the TURN started wins, both ends inclusive', () => {
    expect(rate('m-intro', '2026-08-19T10:00:00.000Z')).toBe(200)
    expect(rate('m-intro', '2026-08-31T23:59:59.000Z')).toBe(200)
    expect(rate('m-intro', '2026-09-01T00:00:00.000Z')).toBe(300)
    expect(rate('m-intro', '2027-01-01T00:00:00.000Z')).toBe(300)
  })

  test('an ended window with NO successor is expired, never stretched', () => {
    expect(rate('m-orphan', '2026-01-31T23:00:00.000Z')).toBe(100)
    expect(rate('m-orphan', '2026-02-01T00:00:00.000Z')).toBe('expired')
  })

  test('a model with no row at all is unpriced — a distinct cause from expired', () => {
    expect(rate('m-absent', AT)).toBe('unpriced')
  })

  test('a stamp that is not a date is its OWN cause, and prices nothing', () => {
    // Never confused with "this model has no row": the model IS in the table.
    expect(rate('m-intro', 'not-a-date')).toBe('undated')
    expect(rate('m-intro', '')).toBe('undated')
    // A model with no row at all still reads as unpriced, stamp or no stamp.
    expect(rate('m-absent', '')).toBe('unpriced')
  })
})

describe('lowerBoundTicks', () => {
  test('input and the three cache lines are billed, each at its own rate', () => {
    const input = bound('claude-opus-5', { input: 1_000 })
    const read = bound('claude-opus-5', { cacheRead: 1_000 })
    const w5 = bound('claude-opus-5', { cacheWrite5m: 1_000 })
    const w1h = bound('claude-opus-5', { cacheWrite1h: 1_000 })
    // Four DIFFERENT rates, in published order.
    expect(read).toBeLessThan(input)
    expect(input).toBeLessThan(w5)
    expect(w5).toBeLessThan(w1h)
    expect(
      bound('claude-opus-5', {
        input: 1_000,
        cacheRead: 1_000,
        cacheWrite5m: 1_000,
        cacheWrite1h: 1_000,
      }),
    ).toBe(input + read + w5 + w1h)
  })

  test('there is NO output rate: output cannot be billed even by accident', () => {
    // The counters type has no output field at all, and the table no output
    // rate — which is exactly what makes the figure a structural lower bound.
    expect(Object.keys(ZERO_COUNTERS).toSorted()).toEqual([
      'cacheRead',
      'cacheWrite1h',
      'cacheWrite5m',
      'input',
    ])
    for (const row of PRICES) {
      expect(Object.keys(row).some((key) => key.includes('output'))).toBe(false)
    }
  })

  test('counts that are not counts are unusable — a distinct cause, never a 0', () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      const result = lowerBoundTicks('claude-opus-5', counters({ input: bad }), AT)
      expect(result).toEqual({ miss: 'counters' })
    }
  })

  test('a genuinely idle response costs a truthful 0', () => {
    expect(bound('claude-opus-5', {})).toBe(0)
  })
})

describe('harnessTicks', () => {
  test('modelUsage is rounded PER MODEL, then the integers are summed', () => {
    expect(
      harnessTicks({
        subtype: 'success',
        total_cost_usd: 0.03,
        modelUsage: {
          'claude-opus-5': { costUSD: 0.0184604 },
          'claude-haiku-4-5': { costUSD: 0.0000001 },
        },
      }),
    ).toEqual({ ticks: 184_604_000 + 1_000 })
  })

  test('one unusable entry voids the WHOLE map: total_cost_usd is complete', () => {
    // A partial per-model sum is not a smaller estimate, it is a wrong one.
    expect(
      harnessTicks({
        subtype: 'success',
        total_cost_usd: 0.03,
        modelUsage: {
          'claude-opus-5': { costUSD: 0.0184604 },
          'claude-haiku-4-5': { costUSD: 'unknown' },
        },
      }),
    ).toEqual({ ticks: 300_000_000 })
  })

  test('without modelUsage, total_cost_usd alone is read', () => {
    expect(harnessTicks({ subtype: 'success', total_cost_usd: 0.0184604 })).toEqual({
      ticks: 184_604_000,
    })
    expect(harnessTicks({ subtype: 'success', total_cost_usd: 0.0184604, modelUsage: {} })).toEqual(
      { ticks: 184_604_000 },
    )
  })

  test('a 0 from a CRASHED frame is UNKNOWN, never free', () => {
    // A crashed session emits error_during_execution with every cost field
    // zeroed; reading it would report a turn that ran as costing nothing.
    expect(
      harnessTicks({
        subtype: 'error_during_execution',
        total_cost_usd: 0,
        modelUsage: { 'claude-opus-5': { costUSD: 0 } },
      }),
    ).toEqual({ miss: 'frame' })
    // A frame calling itself a success AND flagging an error contradicts
    // itself; neither half is trustworthy.
    expect(harnessTicks({ subtype: 'success', is_error: true, total_cost_usd: 0.5 })).toEqual({
      miss: 'frame',
    })
    expect(harnessTicks({})).toEqual({ miss: 'frame' })
  })

  test('a BUDGET-CUT frame is complete and is read, is_error and all', () => {
    // The docs are explicit: on error_max_budget_usd, total_cost_usd and
    // modelUsage include the response that crossed the budget (only `usage`
    // leaves it out). Refusing it would throw away the one complete figure
    // such a run produces.
    expect(
      harnessTicks({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.25 }),
    ).toEqual({ ticks: 2_500_000_000 })
  })

  test('a success frame reporting a real 0 keeps its truthful 0', () => {
    expect(harnessTicks({ subtype: 'success', total_cost_usd: 0 })).toEqual({ ticks: 0 })
  })

  test('a complete frame with an unusable amount is its OWN cause', () => {
    // Distinct from 'frame': the run ended normally and still reported a
    // figure nobody can use, which is worth a journal line.
    for (const total_cost_usd of [-1, 'lots', Number.NaN, MAX_TURN_USD + 1, null]) {
      expect(harnessTicks({ subtype: 'success', total_cost_usd })).toEqual({ miss: 'amount' })
    }
  })

  test('a frame that names NO cost offers nothing to read, and is not an anomaly', () => {
    // Distinct again: nothing to report, the lower bound simply takes over.
    expect(harnessTicks({ subtype: 'success' })).toEqual({ miss: 'frame' })
  })
})

/** A meter wired to record everything it publishes. */
const meter = (options: { env?: Record<string, string | undefined>; at?: string } = {}) => {
  const costs: (SettledCost | null)[] = []
  const degraded: CostDegradation[] = []
  const m = createCostMeter(
    {
      onCost: (cost) => costs.push(cost),
      onDegraded: (d) => degraded.push(d),
    },
    { at: options.at ?? AT, env: options.env ?? {} },
  )
  return { costs, degraded, m }
}

describe('createCostMeter — order of authority', () => {
  test('1. a partner platform gets NO figure at all, not even the harness’s', () => {
    const { costs, degraded, m } = meter({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } })
    m.response('msg_1', 'claude-opus-5', counters({ input: 1_000 }))
    m.result({ subtype: 'success', total_cost_usd: 0.5 })
    expect(m.settle()).toBeNull()
    expect(costs).toEqual([])
    expect(degraded).toEqual([{ cause: 'partner_platform', signal: 'CLAUDE_CODE_USE_BEDROCK' }])
  })

  test('1. a partner-SHAPED model id is the same signal, mid-stream', () => {
    const { costs, degraded, m } = meter()
    m.response('msg_1', 'us.anthropic.claude-opus-4-5-20251101-v1:0', counters({ input: 1_000 }))
    m.result({ subtype: 'success', total_cost_usd: 0.5 })
    expect(m.settle()).toBeNull()
    expect(costs).toEqual([])
    expect(degraded[0]?.cause).toBe('partner_platform')
  })

  test('2. a usable result frame wins over the lower bound', () => {
    const { m } = meter()
    m.response('msg_1', 'claude-opus-5', counters({ input: 1_000 }))
    m.result({ subtype: 'success', total_cost_usd: 0.5, modelUsage: {} })
    expect(m.settle()).toEqual({ ticks: 5_000_000_000, basis: 'harness' })
  })

  test('3. no usable result frame: the lower bound stands, and says so', () => {
    const { m } = meter()
    m.response('msg_1', 'claude-opus-5', counters({ input: 1_000, cacheRead: 10_000 }))
    m.result({ subtype: 'error_during_execution', total_cost_usd: 0 })
    expect(m.settle()).toEqual({
      ticks: bound('claude-opus-5', { input: 1_000, cacheRead: 10_000 }),
      basis: 'lower_bound',
    })
  })

  test('4. nothing usable at all: absent, with the cause named', () => {
    const { costs, degraded, m } = meter()
    m.response('msg_1', 'some-other-model', counters({ input: 1_000 }))
    expect(m.settle()).toBeNull()
    expect(costs).toEqual([])
    expect(degraded).toEqual([{ cause: 'model_unpriced', model: 'some-other-model' }])
  })

  test('an empty stream leaves no figure: unknown, not 0', () => {
    const { m } = meter()
    expect(m.settle()).toBeNull()
  })
})

describe('createCostMeter — deduplication by message id', () => {
  test('the frames of ONE API response are charged once', () => {
    const { m } = meter()
    const usage = counters({ input: 1_000, cacheRead: 20_000 })
    // Claude Code emits one frame per content block, all repeating the same
    // usage for the same message id.
    m.response('msg_01', 'claude-opus-5', usage)
    m.response('msg_01', 'claude-opus-5', usage)
    m.response('msg_01', 'claude-opus-5', usage)
    expect(m.settle()).toEqual({
      ticks: bound('claude-opus-5', { input: 1_000, cacheRead: 20_000 }),
      basis: 'lower_bound',
    })
  })

  test('distinct responses accumulate', () => {
    const { m } = meter()
    m.response('msg_01', 'claude-opus-5', counters({ input: 1_000 }))
    m.response('msg_02', 'claude-opus-5', counters({ input: 500 }))
    expect(m.settle()?.ticks).toBe(bound('claude-opus-5', { input: 1_500 }))
  })

  test('an unidentified frame cannot be deduplicated and is counted as it comes', () => {
    const { m } = meter()
    m.response(null, 'claude-opus-5', counters({ input: 1_000 }))
    m.response(null, 'claude-opus-5', counters({ input: 1_000 }))
    expect(m.settle()?.ticks).toBe(bound('claude-opus-5', { input: 2_000 }))
  })
})

describe('createCostMeter — what it publishes as it goes', () => {
  test('a figure already published is RETRACTED when a later frame voids it', () => {
    const { costs, m } = meter()
    m.response('a', 'claude-opus-5', counters({ input: 1_000 }))
    expect(costs).toEqual([
      { ticks: bound('claude-opus-5', { input: 1_000 }), basis: 'lower_bound' },
    ])
    // The bound stops being a bound on the WHOLE turn: a caller holding the
    // previous figure must be told, or a killed turn would persist a partial
    // sum as if it were the turn's cost.
    m.response('b', 'some-other-model', counters({ input: 1_000 }))
    expect(costs.at(-1)).toBeNull()
    expect(m.settle()).toBeNull()
  })

  test('a partner platform seen MID-STREAM retracts what was published', () => {
    const { costs, m } = meter()
    m.response('a', 'claude-opus-5', counters({ input: 1_000 }))
    expect(costs.at(-1)).not.toBeNull()
    m.response('b', 'us.anthropic.claude-opus-4-5-20251101-v1:0', counters({ input: 10 }))
    expect(costs.at(-1)).toBeNull()
    expect(m.settle()).toBeNull()
  })

  test('an unchanged figure is not republished, and silence stays silence', () => {
    const { costs, m } = meter()
    // Nothing priceable ever: no stream of nulls, just nothing.
    m.response('a', 'some-other-model', counters({ input: 10 }))
    m.response('b', 'another-unknown', counters({ input: 10 }))
    expect(costs).toEqual([])
    // And a repeated response publishes nothing new either.
    const { costs: costs2, m: m2 } = meter()
    m2.response('x', 'claude-opus-5', counters({ input: 1_000 }))
    m2.response('x', 'claude-opus-5', counters({ input: 1_000 }))
    expect(costs2).toHaveLength(1)
  })
})

describe('createCostMeter — degradations', () => {
  test('one line per distinct subject, not one per frame', () => {
    const { degraded, m } = meter()
    m.response('a', 'some-other-model', counters({ input: 10 }))
    m.response('b', 'some-other-model', counters({ input: 10 }))
    m.response('c', 'another-unknown', counters({ input: 10 }))
    expect(degraded).toEqual([
      { cause: 'model_unpriced', model: 'some-other-model' },
      { cause: 'model_unpriced', model: 'another-unknown' },
    ])
  })

  test('an expired price is reported AS expired, never as "no price on record"', () => {
    const rows: readonly PriceRow[] = [
      {
        model: 'm-gone',
        until: '2026-01-31',
        input_cents_per_mtok: 100,
        cache_read_cents_per_mtok: 10,
        cache_write_5m_cents_per_mtok: 125,
        cache_write_1h_cents_per_mtok: 200,
      },
    ]
    const degraded: CostDegradation[] = []
    const m = createCostMeter({ onDegraded: (d) => degraded.push(d) }, { at: AT, env: {}, rows })
    m.response('a', 'm-gone', counters({ input: 10 }))
    expect(m.settle()).toBeNull()
    expect(degraded).toEqual([{ cause: 'price_expired', model: 'm-gone', at: AT }])
  })

  test('unusable counters are reported AS unusable', () => {
    const { degraded, m } = meter()
    m.response('a', 'claude-opus-5', counters({ input: -5 }))
    expect(m.settle()).toBeNull()
    expect(degraded).toEqual([{ cause: 'counters_unusable', model: 'claude-opus-5' }])
  })

  test('one broken response voids the BOUND, but the harness figure still stands', () => {
    const { m } = meter()
    m.response('a', 'claude-opus-5', counters({ input: 1_000 }))
    m.response('b', 'some-other-model', counters({ input: 1_000 }))
    // The bound is no longer a bound on the whole turn, so it is not published.
    expect(m.settle()).toBeNull()
    m.result({ subtype: 'success', total_cost_usd: 0.25 })
    expect(m.settle()).toEqual({ ticks: 2_500_000_000, basis: 'harness' })
  })
})

describe('createCostMeter — structural cross-check', () => {
  test('bound <= harness holds silently on real figures', () => {
    const { degraded, m } = meter()
    m.response('a', 'claude-haiku-4-5', counters({ input: 10, cacheRead: 18_134 }))
    m.result({ subtype: 'success', total_cost_usd: 0.0184604 })
    expect(degraded).toEqual([])
  })

  test('a bound ABOVE the harness figure is impossible: it raises cost_drift', () => {
    const { degraded, m } = meter()
    // A million input tokens on Opus 5 is $5; the harness claims one cent.
    m.response('a', 'claude-opus-5', counters({ input: TOKENS_PER_MTOK }))
    m.result({ subtype: 'success', total_cost_usd: 0.01 })
    expect(degraded).toEqual([
      { cause: 'drift', lowerBoundTicks: 5 * TICKS_PER_USD, harnessTicks: 100_000_000 },
    ])
  })

  test('drift is informative, never blocking: the harness figure still wins', () => {
    const { m } = meter()
    m.response('a', 'claude-opus-5', counters({ input: TOKENS_PER_MTOK }))
    m.result({ subtype: 'success', total_cost_usd: 0.01 })
    expect(m.settle()).toEqual({ ticks: 100_000_000, basis: 'harness' })
  })
})

describe('golden frames — figures measured on a real run', () => {
  // One assistant frame as Claude Code emitted it, and the result frame that
  // closed the same turn. These numbers are transcribed, not computed.
  const REAL = { input: 10, output: 53, cacheWrite1h: 8_186, cacheRead: 18_134 }
  const REAL_HARNESS_USD = 0.0184604

  test('the lower bound of the real frame is exactly what the table says', () => {
    // haiku-4-5, cents/MTok: input 100, cache read 10, 1h write 200.
    //   10 x 100 x 100        =     100 000
    //   18 134 x 10 x 100     =  18 134 000
    //   8 186 x 200 x 100     = 163 720 000
    const expected = 100_000 + 18_134_000 + 163_720_000
    expect(expected).toBe(181_954_000)
    expect(
      bound('claude-haiku-4-5', {
        input: REAL.input,
        cacheRead: REAL.cacheRead,
        cacheWrite1h: REAL.cacheWrite1h,
      }),
    ).toBe(expected)
  })

  test('the harness figure of the same turn converts to whole ticks', () => {
    expect(usdToTicks(REAL_HARNESS_USD)).toBe(184_604_000)
  })

  test('the gap between the two IS the output the bound cannot bill', () => {
    // 53 output tokens x $5 / MTok = 2 650 000 ticks — the bound plus the
    // output is the harness figure to the tick, which is what "structural
    // lower bound" means in practice.
    const lower = bound('claude-haiku-4-5', {
      input: REAL.input,
      cacheRead: REAL.cacheRead,
      cacheWrite1h: REAL.cacheWrite1h,
    })
    const output = REAL.output * 500 * TICKS_PER_TOKEN_PER_CENT
    const harness = usdToTicks(REAL_HARNESS_USD) as number
    expect(output).toBe(2_650_000)
    expect(lower + output).toBe(harness)
    expect(lower).toBeLessThan(harness)
  })

  test('the whole frame through the meter: bound, then harness, no drift', () => {
    const { costs, degraded, m } = meter()
    m.response('msg_01K', 'claude-haiku-4-5', counters(REAL))
    // Every content block of the SAME response repeats the same usage.
    m.response('msg_01K', 'claude-haiku-4-5', counters(REAL))
    m.response('msg_01K', 'claude-haiku-4-5', counters(REAL))
    expect(costs).toEqual([{ ticks: 181_954_000, basis: 'lower_bound' }])
    m.result({
      subtype: 'success',
      total_cost_usd: REAL_HARNESS_USD,
      modelUsage: { 'claude-haiku-4-5': { costUSD: REAL_HARNESS_USD } },
    })
    expect(m.settle()).toEqual({ ticks: 184_604_000, basis: 'harness' })
    expect(degraded).toEqual([])
  })
})

/** Ticks charged per token, from a rate in cents per MTok. */
const perToken = (cents: bigint): bigint => cents * 100n

describe('integer property over 1 000 draws', () => {
  /**
   * The published base-input rates, in whole cents per MTok, transcribed HERE
   * from the pricing page — independently of the module's own table. The
   * expectation below is rebuilt from them in BigInt arithmetic, which is what
   * makes this property test bite. Verified by mutating the module on purpose:
   *
   *   - move any shipped rate (x10 on one row)  -> FAILS;
   *   - drop the message-id deduplication       -> FAILS (each response is fed
   *     several times here, exactly as the stream repeats it);
   *   - let a non-integer escape the arithmetic -> FAILS (a fractional tick
   *     cannot become a BigInt).
   *
   * What it deliberately does NOT claim: that a float-based path would be
   * caught by its VALUE. Below `MAX_TURN_USD` a double is exact to far less
   * than one tick, so an intermediate float that still rounds to the same
   * integer is indistinguishable — and harmless. What matters, and what is
   * tested, is that nothing fractional ever reaches a record.
   */
  const PUBLISHED_INPUT_CENTS: Record<string, bigint> = {
    'claude-fable-5': 1_000n,
    'claude-mythos-5': 1_000n,
    'claude-opus-5': 500n,
    'claude-opus-4-8': 500n,
    'claude-opus-4-7': 500n,
    'claude-opus-4-6': 500n,
    'claude-opus-4-5': 500n,
    'claude-sonnet-5': 200n,
    'claude-sonnet-4-6': 300n,
    'claude-sonnet-4-5': 300n,
    'claude-haiku-4-5': 100n,
  }

  /** Published multipliers, as exact integer ratios: 0.1x, 1.25x, 2x. */
  const expectedTicks = (model: string, c: CostCounters): bigint => {
    const input = PUBLISHED_INPUT_CENTS[model] as bigint
    return (
      BigInt(c.input) * perToken(input) +
      BigInt(c.cacheRead) * perToken(input / 10n) +
      BigInt(c.cacheWrite5m) * perToken((input * 5n) / 4n) +
      BigInt(c.cacheWrite1h) * perToken(input * 2n)
    )
  }

  test('1 000 draws: the meter’s figure equals an independently computed integer', () => {
    // Deterministic PRNG (mulberry32): a property test that reproduces.
    let seed = 0x9e3779b9
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
    const count = (max: number): number => Math.floor(rand() * max)

    let priced = 0
    let unpriced = 0
    for (let draw = 0; draw < 1_000; draw++) {
      const model = pick([...PRICED_MODELS, 'gpt-not-a-claude-model', 'claude-from-the-future-9'])
      const responses = 1 + count(3)
      const { costs, degraded, m } = meter()
      let expected = 0n
      for (let r = 0; r < responses; r++) {
        const c = counters({
          input: count(1_000_000),
          cacheRead: count(1_000_000),
          cacheWrite5m: count(200_000),
          cacheWrite1h: count(200_000),
        })
        // The SAME response, repeated the way the stream repeats it: only the
        // first occurrence may be charged.
        const repeats = 1 + count(4)
        for (let i = 0; i < repeats; i++) {
          m.response(`msg_${draw}_${r}`, model, c)
        }
        if (model in PUBLISHED_INPUT_CENTS) {
          expected += expectedTicks(model, c)
        }
      }
      const settled = m.settle()
      if (!(model in PUBLISHED_INPUT_CENTS)) {
        unpriced++
        expect(settled).toBeNull()
        expect(costs).toEqual([])
        expect(degraded).toEqual([{ cause: 'model_unpriced', model }])
        continue
      }
      priced++
      expect(settled).not.toBeNull()
      const ticks = settled?.ticks as number
      expect(settled?.basis).toBe('lower_bound')
      // Integer end to end: a fractional value cannot become a BigInt, and a
      // value off by any factor cannot equal the independent expectation.
      expect(Number.isSafeInteger(ticks)).toBe(true)
      expect(ticks).toBeGreaterThanOrEqual(0)
      expect(BigInt(ticks)).toBe(expected)
      // And it survives the round trip that actually happens on disk.
      expect(JSON.parse(JSON.stringify(ticks))).toBe(ticks)
    }
    // The draw actually exercised both branches.
    expect(priced).toBeGreaterThan(0)
    expect(unpriced).toBeGreaterThan(0)
  })
})

describe('totalCost', () => {
  test('the total is exactly the sum of the priced turns, with its coverage', () => {
    expect(totalCost([turn(1_000, 'harness'), turn(2_500, 'harness'), turn(7, 'harness')])).toEqual(
      { kind: 'total', ticks: 3_507, turns: 3, basis: 'harness' },
    )
  })

  test('one lower-bound turn makes the WHOLE total a lower bound', () => {
    expect(totalCost([turn(1_000, 'harness'), turn(2_000, 'lower_bound')])).toEqual({
      kind: 'total',
      ticks: 3_000,
      turns: 2,
      basis: 'lower_bound',
    })
  })

  test('a turn missing half the fact is not counted at all', () => {
    // Figure and provenance are one fact in two keys: half of it is no cost.
    // The sanitizer already refuses to produce such a turn; totalCost and
    // turnCostOf agree about it anyway, which is what keeps a resumed turn
    // from being replaced instead of added to.
    expect(totalCost([turn(1_000, 'harness'), turn(2_000)])).toEqual({
      kind: 'total',
      ticks: 1_000,
      turns: 1,
      basis: 'harness',
    })
  })

  test('no turn priced: the total is unknown, not 0', () => {
    expect(totalCost([])).toEqual({ kind: 'none' })
    expect(totalCost([turn(), turn()])).toEqual({ kind: 'none' })
  })

  test('a truthful zero on every turn still totals zero, not unknown', () => {
    expect(totalCost([turn(0, 'harness'), turn(0, 'harness')])).toEqual({
      kind: 'total',
      ticks: 0,
      turns: 2,
      basis: 'harness',
    })
  })

  test('partly priced: the coverage says how many turns the figure covers', () => {
    expect(totalCost([turn(1_000, 'harness'), turn(), turn(2_000, 'harness')])).toEqual({
      kind: 'total',
      ticks: 3_000,
      turns: 2,
      basis: 'harness',
    })
  })

  test('a corrupt turn value is ignored rather than propagated', () => {
    const broken = { ...turn(), cost_ticks: 1.5 } as TaskTurn
    expect(totalCost([turn(1_000, 'harness'), broken])).toEqual({
      kind: 'total',
      ticks: 1_000,
      turns: 1,
      basis: 'harness',
    })
  })

  test('a sum past the exact integer range is UNREPRESENTABLE, not absent', () => {
    const huge = Math.floor(Number.MAX_SAFE_INTEGER / 2)
    expect(
      totalCost([turn(huge, 'harness'), turn(huge, 'harness'), turn(huge, 'harness')]),
    ).toEqual({ kind: 'unrepresentable', turns: 3 })
  })

  test('coverage never exceeds the turns the record will actually keep', () => {
    // sanitizeTaskRecord keeps the first TASK_TURNS_MAX turns; a total over
    // more of them would be wrong twice — too many turns AND too many ticks.
    const turns = Array.from({ length: TASK_TURNS_MAX + 10 }, () => turn(10, 'harness'))
    expect(totalCost(turns)).toEqual({
      kind: 'total',
      ticks: TASK_TURNS_MAX * 10,
      turns: TASK_TURNS_MAX,
      basis: 'harness',
    })
  })
})

describe('foldTurnCost — one turn, several attempts', () => {
  const harness = (ticks: number): SettledCost => ({ ticks, basis: 'harness' })
  const lower = (ticks: number): SettledCost => ({ ticks, basis: 'lower_bound' })

  test('an attempt that measured NOTHING changes nothing', () => {
    // It cannot prove the turn was free: the turn is left alone.
    expect(foldTurnCost(harness(1_000), null)).toEqual({ kind: 'unchanged' })
    expect(foldTurnCost(null, null)).toEqual({ kind: 'unchanged' })
  })

  test('the first measurement is taken as it stands', () => {
    expect(foldTurnCost(null, lower(1_000))).toEqual({ kind: 'set', cost: lower(1_000) })
  })

  test('a second attempt ADDS: the turn really burned both', () => {
    // The harness reports each run independently and provides no session-level
    // total, so a resumed attempt's figure never contains the killed one's.
    expect(foldTurnCost(harness(1_000), harness(400))).toEqual({
      kind: 'set',
      cost: harness(1_400),
    })
  })

  test('one lower-bound part drags the whole turn to lower_bound', () => {
    expect(foldTurnCost(harness(1_000), lower(400))).toEqual({ kind: 'set', cost: lower(1_400) })
    expect(foldTurnCost(lower(1_000), harness(400))).toEqual({ kind: 'set', cost: lower(1_400) })
    expect(foldTurnCost(lower(1_000), lower(400))).toEqual({ kind: 'set', cost: lower(1_400) })
  })

  test('a measurement that is not a figure is refused, on EITHER branch', () => {
    // Exported pure function: a caller must not be able to write a NaN onto a
    // record, and a negative must never SUBTRACT from what is already there.
    // -0 is in the list because it satisfies both isSafeInteger and >= 0, so
    // nothing else would catch it.
    for (const ticks of [Number.NaN, Number.POSITIVE_INFINITY, -5, 1.5, -0]) {
      expect(foldTurnCost(null, { ticks, basis: 'harness' })).toEqual({ kind: 'unchanged' })
      expect(foldTurnCost(harness(1_000), { ticks, basis: 'harness' })).toEqual({
        kind: 'unchanged',
      })
    }
    // A basis nobody can name is not a provenance either.
    expect(foldTurnCost(null, { ticks: 10, basis: 'invoice' as CostBasis })).toEqual({
      kind: 'unchanged',
    })
  })

  test('an unusable figure ALREADY on the turn is replaced, not added to', () => {
    expect(foldTurnCost({ ticks: -1, basis: 'harness' }, lower(400))).toEqual({
      kind: 'set',
      cost: lower(400),
    })
  })

  test('a sum out of exact range keeps the figure recorded AND says so', () => {
    // The turn still carries a usable figure afterwards, so the record total
    // stays an ordinary total: this is the only place it can be reported.
    expect(foldTurnCost(harness(Number.MAX_SAFE_INTEGER), harness(10))).toEqual({
      kind: 'unrepresentable',
      kept: harness(Number.MAX_SAFE_INTEGER),
      dropped: harness(10),
    })
  })
})

describe('turnCostOf — one reader for both halves of the fact', () => {
  test('a turn carrying both halves reads as a cost', () => {
    expect(turnCostOf(turn(1_000, 'harness'))).toEqual({ ticks: 1_000, basis: 'harness' })
  })

  test('a negative zero is not a figure', () => {
    expect(turnCostOf({ ...turn(), cost_ticks: -0, cost_basis: 'harness' })).toBeNull()
    // A truthful positive zero still is one.
    expect(turnCostOf(turn(0, 'harness'))).toEqual({ ticks: 0, basis: 'harness' })
  })

  test('half a fact is no fact: either half missing reads as nothing', () => {
    // A figure whose provenance nobody can name cannot be interpreted, and a
    // provenance with no figure describes nothing.
    expect(turnCostOf(turn(1_000))).toBeNull()
    expect(turnCostOf({ ...turn(), cost_basis: 'harness' })).toBeNull()
    expect(turnCostOf(turn())).toBeNull()
  })

  test('totalCost reads exactly the same thing, so the two never disagree', () => {
    // Disagreement here is what silently REPLACES a figure instead of adding
    // to it when a killed turn is resumed.
    const half = turn(4_000)
    expect(turnCostOf(half)).toBeNull()
    expect(totalCost([half])).toEqual({ kind: 'none' })
    expect(totalCost([turn(1_000, 'harness'), half])).toEqual({
      kind: 'total',
      ticks: 1_000,
      turns: 1,
      basis: 'harness',
    })
  })
})

// What a turn cost, and — just as important — WHO says so.
//
// A cost carried by a record is a claim, so every figure this module produces
// declares its provenance (`CostBasis`) and refuses to produce one at all when
// no honest answer exists. Absence means UNKNOWN and never 0.
//
// Pure module: hard-coded tables, integer arithmetic, no I/O, no network and
// NO CLOCK — the date a price is looked up at and the environment a run used
// are both passed in, so the same inputs always produce the same figure.

import { TASK_TURNS_MAX, TICKS_PER_USD, type CostBasis, type TaskTurn } from './contract.js'

/* ------------------------------------------------------------------------ *
 * The one float -> integer conversion of this module
 * ------------------------------------------------------------------------ */

/**
 * The harness reports its estimate in USD, as a float. Ticks are integers, so
 * exactly ONE rounding step exists in this module and it lives here, isolated
 * and guarded, rather than being scattered across the call sites.
 *
 * Everything else — the fallback table, the per-turn sums, the record total —
 * is integer arithmetic that never goes near a float.
 *
 * Refuses (null = UNKNOWN) anything that is not a finite USD amount in
 * [0, MAX_TURN_USD]: a NaN, an infinity, a negative, or a figure so large it
 * could not be an amount a single turn spent. The bound also keeps the product
 * far inside the safe-integer range (1e5 USD x 1e10 ticks = 1e15 < 9.007e15).
 */
export const MAX_TURN_USD = 100_000

export function usdToTicks(usd: unknown): number | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_TURN_USD) {
    return null
  }
  const ticks = Math.round(usd * TICKS_PER_USD)
  return Number.isSafeInteger(ticks) ? ticks : null
}

/* ------------------------------------------------------------------------ *
 * Partner-operated platforms
 * ------------------------------------------------------------------------ */

/**
 * Amazon Bedrock and Google Cloud invoice their own price lists, which this
 * build does not carry and must not guess. A run on either is therefore
 * reported with NO cost at all — not the fallback table's figure, and not even
 * the harness's own estimate, which is itself computed from a first-party
 * table. A number from the wrong price list is worse than no number.
 *
 * Two independent signals, either is enough:
 *   - the RUN's environment switched the platform on (CLAUDE_CODE_USE_BEDROCK
 *     / CLAUDE_CODE_USE_VERTEX). "The run's environment" means the one the
 *     process that actually executes the agent will see, which the caller
 *     passes in — this module never reads `process.env`. That distinction is
 *     load-bearing: a caged turn only ever sees the handful of variables the
 *     container is given, so the host's own switches must not reach here or
 *     every caged turn would be declared partner-billed while the agent inside
 *     was billing first-party;
 *   - the model id has a partner SHAPE: a Bedrock namespace
 *     (`us.anthropic.…`), a Bedrock version suffix (`-v1:0`) or a Vertex
 *     dated suffix (`@20251101`). This one travels ON the stream, so it works
 *     identically on both paths and is what actually catches a real
 *     Bedrock/Vertex run.
 */
export const PARTNER_ENV_VARS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const

export type RunEnv = Readonly<Record<string, string | undefined>>

export function partnerPlatformEnv(env: RunEnv): string | null {
  for (const name of PARTNER_ENV_VARS) {
    const value = env[name]
    // Claude Code reads these as "set to something truthy"; '0'/'false'/''
    // leave the first-party path in place.
    if (value && value !== '0' && value.toLowerCase() !== 'false') {
      return name
    }
  }
  return null
}

/** Bedrock namespace (with or without a region profile), Bedrock version suffix, Vertex @date suffix. */
const PARTNER_SHAPES: readonly RegExp[] = [
  /^([a-z0-9-]+\.)?anthropic\./,
  /-v\d+:\d+$/,
  /@\d{8}$/,
] as const

export function partnerPlatformModel(model: string): boolean {
  const id = model.trim().toLowerCase()
  return PARTNER_SHAPES.some((shape) => shape.test(id))
}

/**
 * Model ids arrive from the stream with a first-party dated SNAPSHOT suffix
 * (`claude-opus-4-5-20251101`) that names the same priced model as the bare
 * id, so only that suffix is stripped.
 *
 * Partner packaging is deliberately NOT stripped: those forms are a SIGNAL
 * that the invoice comes from someone else (see `partnerPlatformModel`), and
 * erasing them would let a Bedrock id quietly match a first-party row.
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/-\d{8}$/, '')
}

/* ------------------------------------------------------------------------ *
 * Fallback price table — a STRUCTURAL LOWER BOUND, not an invoice
 * ------------------------------------------------------------------------ *
 *
 * WHAT THIS TABLE BILLS
 *   - base input tokens;
 *   - cache READS (`cache_read_input_tokens`);
 *   - cache WRITES, 5-minute and 1-hour, read from
 *     `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`.
 *
 * WHAT IT CANNOT BILL, BY CONSTRUCTION
 *   - OUTPUT tokens. There is no output rate in this table AT ALL, on purpose:
 *     Claude Code's per-message `output_tokens` is documented as a placeholder
 *     (the count the API had reported at `message_start`, repeated on every
 *     message of the same response), so it is not a quantity anyone can price
 *     frame by frame. A missing rate cannot be applied by accident.
 *   - SUBAGENT usage. The stream marks a subagent's frames with
 *     `parent_tool_use_id`, and the parser feeding this table drops those
 *     before they ever reach it (the official cost-tracking guide skips the
 *     same frames when summing per-step usage). So the exclusion is a filter
 *     that exists, not an assumption about what the stream contains.
 *   - server-tool surcharges (web search at $10 / 1 000 searches, code
 *     execution container-hours), the Batch discount, the 1.1x data-residency
 *     multiplier, fast mode's premium rate.
 *
 * Every omitted line item is POSITIVE, so the figure this table produces is a
 * genuine LOWER BOUND on the turn: the real bill is this or more, never less.
 * That is what `cost_basis: 'lower_bound'` states out loud, and it is why this
 * table is only ever the FALLBACK — the harness's own estimate, when a result
 * frame carries one, is the nominal figure.
 *
 * SOURCE
 *   https://platform.claude.com/docs/en/about-claude/pricing — "Model
 *   pricing" and "Prompt caching", read 2026-08-19. All four rates are whole
 *   CENTS per million tokens for every published price, so the table itself
 *   contains no float. The published cache multipliers (read 0.1x, 5-minute
 *   write 1.25x, 1-hour write 2x of base input) are locked by a test against
 *   every row, in integer arithmetic.
 *
 * SCOPE
 *   Anthropic FIRST-PARTY rates only, for the models this build can be pointed
 *   at. Models retired everywhere but Bedrock and Google Cloud are absent on
 *   purpose: a run there is a partner-platform run, which is refused a figure
 *   before the table is ever consulted.
 *
 * MAINTENANCE
 *   A model with no row is not priced at zero, it is priced NOT AT ALL.
 *   Adding a row is the only way a new model gets a figure.
 */

export type PriceRow = {
  /** Normalized model id (see `normalizeModelId`). */
  model: string
  /**
   * Validity window of the rate, INCLUSIVE on both ends, as ISO dates.
   * `from` absent = valid since forever; `until` absent = still current.
   * A row whose window has ended and that has no successor is NOT silently
   * reused: the model reads as expired (see `selectPriceRow`).
   */
  from?: string
  until?: string
  /** USD cents per million BASE INPUT tokens (integer). */
  input_cents_per_mtok: number
  /** USD cents per million CACHE READ tokens (integer, 0.1x base input). */
  cache_read_cents_per_mtok: number
  /** USD cents per million 5-MINUTE CACHE WRITE tokens (integer, 1.25x). */
  cache_write_5m_cents_per_mtok: number
  /** USD cents per million 1-HOUR CACHE WRITE tokens (integer, 2x). */
  cache_write_1h_cents_per_mtok: number
}

/**
 * Rows are written cheapest-key-first and grouped by published rate. Several
 * rows may name the same model with disjoint windows; `selectPriceRow` picks
 * the one covering the turn's start.
 *
 * Claude Sonnet 5 carries ONE row on purpose. Its $2 / $10 launch pricing was
 * announced as introductory through 2026-08-31, but the pricing page now
 * states verbatim that it "is now the standard price" and that "the previously
 * scheduled increase to $3/$15 per million input/output tokens on September 1,
 * 2026 will not occur". Writing the successor row anyway would overcharge
 * every Sonnet 5 turn from September onwards by 50%, which is exactly the kind
 * of invented figure this module exists to prevent. The window MECHANISM stays
 * (see `selectPriceRow`) and is exercised by its own tests: the day a rate
 * really does change, the successor row is one line.
 */
export const PRICES: readonly PriceRow[] = Object.freeze([
  // $10 / MTok input — Claude Fable 5, Claude Mythos 5.
  {
    model: 'claude-fable-5',
    input_cents_per_mtok: 1_000,
    cache_read_cents_per_mtok: 100,
    cache_write_5m_cents_per_mtok: 1_250,
    cache_write_1h_cents_per_mtok: 2_000,
  },
  {
    model: 'claude-mythos-5',
    input_cents_per_mtok: 1_000,
    cache_read_cents_per_mtok: 100,
    cache_write_5m_cents_per_mtok: 1_250,
    cache_write_1h_cents_per_mtok: 2_000,
  },
  // $5 / MTok input — the Opus line.
  {
    model: 'claude-opus-5',
    input_cents_per_mtok: 500,
    cache_read_cents_per_mtok: 50,
    cache_write_5m_cents_per_mtok: 625,
    cache_write_1h_cents_per_mtok: 1_000,
  },
  {
    model: 'claude-opus-4-8',
    input_cents_per_mtok: 500,
    cache_read_cents_per_mtok: 50,
    cache_write_5m_cents_per_mtok: 625,
    cache_write_1h_cents_per_mtok: 1_000,
  },
  {
    model: 'claude-opus-4-7',
    input_cents_per_mtok: 500,
    cache_read_cents_per_mtok: 50,
    cache_write_5m_cents_per_mtok: 625,
    cache_write_1h_cents_per_mtok: 1_000,
  },
  {
    model: 'claude-opus-4-6',
    input_cents_per_mtok: 500,
    cache_read_cents_per_mtok: 50,
    cache_write_5m_cents_per_mtok: 625,
    cache_write_1h_cents_per_mtok: 1_000,
  },
  {
    model: 'claude-opus-4-5',
    input_cents_per_mtok: 500,
    cache_read_cents_per_mtok: 50,
    cache_write_5m_cents_per_mtok: 625,
    cache_write_1h_cents_per_mtok: 1_000,
  },
  // $3 / MTok input — Sonnet 4.6 and 4.5.
  {
    model: 'claude-sonnet-4-6',
    input_cents_per_mtok: 300,
    cache_read_cents_per_mtok: 30,
    cache_write_5m_cents_per_mtok: 375,
    cache_write_1h_cents_per_mtok: 600,
  },
  {
    model: 'claude-sonnet-4-5',
    input_cents_per_mtok: 300,
    cache_read_cents_per_mtok: 30,
    cache_write_5m_cents_per_mtok: 375,
    cache_write_1h_cents_per_mtok: 600,
  },
  // $2 / MTok input — Sonnet 5 (launch price, now the standard one).
  {
    model: 'claude-sonnet-5',
    input_cents_per_mtok: 200,
    cache_read_cents_per_mtok: 20,
    cache_write_5m_cents_per_mtok: 250,
    cache_write_1h_cents_per_mtok: 400,
  },
  // $1 / MTok input — Haiku 4.5.
  {
    model: 'claude-haiku-4-5',
    input_cents_per_mtok: 100,
    cache_read_cents_per_mtok: 10,
    cache_write_5m_cents_per_mtok: 125,
    cache_write_1h_cents_per_mtok: 200,
  },
])

/** The model ids this build knows how to price, for tests and diagnostics. */
export const PRICED_MODELS: readonly string[] = Object.freeze([
  ...new Set(PRICES.map((row) => row.model)),
])

/** Cents in one US dollar. */
export const CENTS_PER_USD = 100
/** Tokens in the unit the published prices use. */
export const TOKENS_PER_MTOK = 1_000_000

/**
 * Ticks charged per single token, per cent per million tokens. Written as the
 * literal it is so that no division ever runs, with its derivation stated:
 *
 *   ticks/token = cents/MTok x (TICKS_PER_USD / CENTS_PER_USD) / TOKENS_PER_MTOK
 *               = cents/MTok x (1e10 / 1e2) / 1e6
 *               = cents/MTok x 100
 *
 * A test locks the literal against that derivation, so the two can never drift
 * apart in silence.
 */
export const TICKS_PER_TOKEN_PER_CENT = 100

/**
 * The derivation itself, computed from the contract's own unit. Never used by
 * the arithmetic — it exists so a test can assert that the literal above still
 * says what the unit says, the day the unit or the table's denomination moves.
 */
export const DERIVED_TICKS_PER_TOKEN_PER_CENT = TICKS_PER_USD / CENTS_PER_USD / TOKENS_PER_MTOK

/**
 * Why no price could be applied. Each cause is DISTINCT and reported as
 * itself: "this model has no row" and "this turn carries no readable date"
 * send a maintainer to two different places, and a catch-all would send them
 * to the wrong one.
 */
export type PriceMiss = 'unpriced' | 'expired' | 'undated'

export type PriceLookup = { row: PriceRow } | { miss: PriceMiss }

/**
 * ISO date of an instant, for window comparison. Windows are written as plain
 * dates and compared as strings: ISO-8601 sorts lexicographically, so no Date
 * arithmetic (and no timezone) enters the decision. An unparseable stamp is
 * refused rather than replaced by "now" — this module has no clock.
 */
function isoDay(at: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(at.trim())
  return match?.[1] ?? null
}

/**
 * The row that priced `model` on the day `at`, among `rows`.
 *
 * - no row for the model at all             -> { miss: 'unpriced' }
 * - a stamp that is not a date              -> { miss: 'undated' }
 * - rows exist but none covers that day     -> { miss: 'expired' }
 *
 * A window is NEVER stretched to cover a turn outside it: an out-of-window
 * rate is a wrong rate, and the caller says so out loud instead of billing it.
 * ('expired' names the case that actually happens — a rate that ran out with no
 * successor written yet; a turn dated BEFORE every known window lands there
 * too, and the journal message covers both without claiming the wrong one.)
 *
 * The model is checked before the date on purpose: with a model this build
 * cannot price, "no row" is the fact that matters whatever the stamp says.
 */
export function selectPriceRow(rows: readonly PriceRow[], model: string, at: string): PriceLookup {
  const id = normalizeModelId(model)
  const candidates = rows.filter((row) => row.model === id)
  if (candidates.length === 0) {
    return { miss: 'unpriced' }
  }
  const day = isoDay(at)
  if (day === null) {
    return { miss: 'undated' }
  }
  const row = candidates.find(
    (candidate) =>
      (candidate.from === undefined || day >= candidate.from) &&
      (candidate.until === undefined || day <= candidate.until),
  )
  return row ? { row } : { miss: 'expired' }
}

/* ------------------------------------------------------------------------ *
 * The lower bound
 * ------------------------------------------------------------------------ */

/**
 * The billable counters of ONE API response, as the stream reports them.
 * Output tokens are absent by design: see the table header.
 */
export type CostCounters = {
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export const ZERO_COUNTERS: CostCounters = Object.freeze({
  input: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
})

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0

const countable = (c: CostCounters): boolean =>
  isCount(c.input) && isCount(c.cacheRead) && isCount(c.cacheWrite5m) && isCount(c.cacheWrite1h)

export type LowerBound = { ticks: number } | { miss: PriceMiss | 'counters' }

/**
 * Lower bound of what one API response cost, in ticks (1 tick = 1e-10 USD).
 *
 * FORMULA, integer end to end — no float ever holds an intermediate value, so
 * there is no rounding step to lose:
 *
 *   ticks = input        x (input_cents_per_mtok          x 100)
 *         + cacheRead    x (cache_read_cents_per_mtok     x 100)
 *         + cacheWrite5m x (cache_write_5m_cents_per_mtok x 100)
 *         + cacheWrite1h x (cache_write_1h_cents_per_mtok x 100)
 *
 * where `cents_per_mtok x 100` is the exact ticks-per-token rate derived from
 * the unit above. Every operand is a non-negative safe integer; the result is
 * checked for exactness anyway, and an inexact one is reported as unusable
 * counters rather than as a number that is almost right.
 */
export function lowerBoundTicks(
  model: string,
  counters: CostCounters,
  at: string,
  rows: readonly PriceRow[] = PRICES,
): LowerBound {
  if (!countable(counters)) {
    return { miss: 'counters' }
  }
  const lookup = selectPriceRow(rows, model, at)
  if ('miss' in lookup) {
    return lookup
  }
  const { row } = lookup
  const ticks =
    counters.input * (row.input_cents_per_mtok * TICKS_PER_TOKEN_PER_CENT) +
    counters.cacheRead * (row.cache_read_cents_per_mtok * TICKS_PER_TOKEN_PER_CENT) +
    counters.cacheWrite5m * (row.cache_write_5m_cents_per_mtok * TICKS_PER_TOKEN_PER_CENT) +
    counters.cacheWrite1h * (row.cache_write_1h_cents_per_mtok * TICKS_PER_TOKEN_PER_CENT)
  return Number.isSafeInteger(ticks) ? { ticks } : { miss: 'counters' }
}

/* ------------------------------------------------------------------------ *
 * The harness's own estimate
 * ------------------------------------------------------------------------ */

/**
 * The shape of a Claude Code `result` frame, as far as cost is concerned. Read
 * defensively: every field is `unknown` until proven otherwise.
 */
export type ResultFrame = {
  subtype?: unknown
  is_error?: unknown
  total_cost_usd?: unknown
  modelUsage?: unknown
}

/**
 * Result subtypes whose cost fields are COMPLETE and can be read.
 *
 * - `success`: the ordinary end of a run.
 * - `error_max_budget_usd`: the run was cut for crossing its budget, and the
 *   documentation is explicit that `total_cost_usd` and `modelUsage` INCLUDE
 *   the response that crossed it (only `usage` leaves it out). Refusing this
 *   frame would throw away the one complete figure a budget-cut run produces.
 *
 * Every other error subtype is refused: `error_during_execution` after a crash
 * may carry every cost field ZEROED, and a 0 from a frame like that means
 * UNKNOWN, never "this turn was free".
 */
const COMPLETE_RESULT_SUBTYPES: ReadonlySet<string> = new Set(['success', 'error_max_budget_usd'])

/**
 * Sum of `modelUsage[].costUSD` in ticks, or null when the map cannot be
 * trusted whole.
 *
 * EACH model's amount is rounded to ticks on its own and the INTEGERS are
 * summed — rounding once per model and adding integers, never adding floats
 * and rounding the drift at the end.
 *
 * One unusable entry voids the WHOLE map: a sum missing one of its terms is
 * not a smaller estimate, it is a wrong one, and `total_cost_usd` on the same
 * frame is complete. Partial beats nothing is exactly the reasoning that
 * produces silently-too-low bills.
 */
function modelUsageTicks(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return null
  }
  const entries = Object.values(usage as Record<string, unknown>)
  if (entries.length === 0) {
    return null
  }
  let total = 0
  for (const entry of entries) {
    const ticks =
      entry && typeof entry === 'object'
        ? usdToTicks((entry as { costUSD?: unknown }).costUSD)
        : null
    if (ticks === null) {
      return null
    }
    total += ticks
  }
  return Number.isSafeInteger(total) ? total : null
}

/**
 * What the harness itself says the turn cost.
 *
 * - `{ ticks }`            — a usable figure;
 * - `{ miss: 'frame' }`    — this frame offers no cost to read: its subtype is
 *                            one whose figures may be incomplete (a crashed or
 *                            otherwise failed run), or it simply carries no
 *                            cost field at all. Normal, and not worth a
 *                            journal line: the lower bound takes over;
 * - `{ miss: 'amount' }`   — the frame DID offer a figure and that figure is
 *                            not a usable one (NaN, infinite, negative, or
 *                            beyond `MAX_TURN_USD`). That is a real anomaly
 *                            and gets named in the journal.
 *
 * `total_cost_usd` and `modelUsage[].costUSD` are computed by Claude Code from
 * a price table bundled in its build — the same epistemic class as our own
 * counters, and the only figure that covers SUBAGENTS and output tokens. That
 * is why it is the nominal source. It remains an ESTIMATE, never an invoice:
 * the documentation says so, and so does `cost_basis: 'harness'`.
 */
export type HarnessCost = { ticks: number } | { miss: 'frame' | 'amount' }

export function harnessTicks(frame: ResultFrame): HarnessCost {
  const subtype = typeof frame.subtype === 'string' ? frame.subtype : ''
  if (!COMPLETE_RESULT_SUBTYPES.has(subtype)) {
    return { miss: 'frame' }
  }
  // A frame that calls itself a success AND flags an error contradicts itself;
  // a budget-cut frame legitimately flags one, and its figures still stand.
  if (subtype === 'success' && frame.is_error === true) {
    return { miss: 'frame' }
  }
  // A frame that names no cost at all offers nothing to read — that is not a
  // broken amount, and it must not be reported as one (older harnesses, and
  // every stream that simply does not carry the field).
  if (frame.total_cost_usd === undefined && frame.modelUsage === undefined) {
    return { miss: 'frame' }
  }
  const ticks = modelUsageTicks(frame.modelUsage) ?? usdToTicks(frame.total_cost_usd)
  return ticks === null ? { miss: 'amount' } : { ticks }
}

/* ------------------------------------------------------------------------ *
 * The per-turn meter
 * ------------------------------------------------------------------------ */

/** Why a turn ends up with no cost, or with a cost worth commenting on. */
export type CostDegradation =
  | { cause: 'partner_platform'; signal: string }
  | { cause: 'model_unpriced'; model: string }
  | { cause: 'price_expired'; model: string; at: string }
  | { cause: 'turn_undated'; model: string; at: string }
  | { cause: 'counters_unusable'; model: string }
  | { cause: 'harness_amount_unusable'; subtype: string }
  | { cause: 'drift'; lowerBoundTicks: number; harnessTicks: number }
  | { cause: 'turn_unrepresentable'; keptTicks: number; droppedTicks: number }
  | { cause: 'total_unrepresentable'; turns: number }

/** A figure and where it comes from; the two never travel apart. */
export type SettledCost = { ticks: number; basis: CostBasis }

export type CostMeterHandlers = {
  /**
   * BEST figure known for the turn so far, republished at every change — as
   * the lower bound accrues, when the harness's estimate supersedes it, and
   * `null` when what was published stops being true (a later frame that cannot
   * be priced voids the bound; a partner platform seen mid-stream voids
   * everything). A turn killed mid-flight therefore leaves the caller holding
   * exactly what was still defensible, and never a stale figure.
   */
  onCost?: (cost: SettledCost | null) => void
  /** A degradation, once per distinct cause+subject. Neutral, never an error. */
  onDegraded?: (degradation: CostDegradation) => void
}

export type CostMeterOptions = {
  /**
   * When the TURN started, ISO. Selects the price row: a turn is billed at the
   * rate in force while it ran, never at "the rate now". This module has no
   * clock precisely so that this stays the caller's explicit choice.
   */
  at: string
  /** The environment the agent actually ran with, for partner detection. */
  env: RunEnv
  /** Test seam: the price table to use. Defaults to the shipped one. */
  rows?: readonly PriceRow[]
}

export type CostMeter = {
  /**
   * One API RESPONSE's usage, identified by its `message.id`. Claude Code
   * emits several assistant frames per response — one per content block, all
   * carrying the SAME id and the SAME usage — so a response is counted once
   * and repeats are dropped. An unidentified frame cannot be deduplicated and
   * is counted as it comes.
   */
  response: (messageId: string | null, model: string, counters: CostCounters) => void
  /** The closing `result` frame: the harness's own figure, if it has one. */
  result: (frame: ResultFrame) => void
  /** Best figure for the turn, or null when nothing honest can be said. */
  settle: () => SettledCost | null
}

/**
 * Each way of missing a price is reported AS ITSELF: an expired rate is not a
 * missing model, and unusable counters are neither. A catch-all message here
 * is exactly how a reader ends up chasing the wrong cause.
 */
function missDegradation(miss: PriceMiss | 'counters', model: string, at: string): CostDegradation {
  const named = model || '(unnamed)'
  if (miss === 'expired') {
    return { cause: 'price_expired', model: named, at }
  }
  if (miss === 'undated') {
    return { cause: 'turn_undated', model: named, at }
  }
  if (miss === 'counters') {
    return { cause: 'counters_unusable', model: named }
  }
  return { cause: 'model_unpriced', model: named }
}

const sameCost = (a: SettledCost | null, b: SettledCost | null): boolean =>
  a === null || b === null ? a === b : a.ticks === b.ticks && a.basis === b.basis

/**
 * Per-turn cost bookkeeping, driven by whoever reads the provider's stream.
 *
 * ORDER OF AUTHORITY, deterministic — exactly one branch wins:
 *   1. partner-operated platform  -> NO cost at all, degradation reported;
 *   2. usable `result` frame      -> the harness's estimate, 'harness';
 *   3. otherwise                  -> the table's lower bound, 'lower_bound';
 *   4. nothing usable             -> absent, degradation reported.
 */
export function createCostMeter(handlers: CostMeterHandlers, options: CostMeterOptions): CostMeter {
  const rows = options.rows ?? PRICES
  /** Ticks accumulated from the deduplicated responses so far. */
  let bound = 0
  /** True once at least one response was priced: 0 with no response is UNKNOWN. */
  let bounded = false
  /** Flipped by the first response that could not be priced, and never back. */
  let boundBroken = false
  /** The harness's figure, once a usable result frame carried one. */
  let harness: number | null = null
  /** Message ids already counted: one API response is one charge. */
  const countedResponses = new Set<string>()
  /** Degradations already reported: one journal line per distinct subject. */
  const reported = new Set<string>()

  const partnerSignal = partnerPlatformEnv(options.env)
  /** Set for the whole turn by the first partner signal seen; never unset. */
  let partner: string | null = partnerSignal

  const report = (degradation: CostDegradation, key: string): void => {
    if (reported.has(key)) {
      return
    }
    reported.add(key)
    handlers.onDegraded?.(degradation)
  }

  /** The current best answer — the order of authority, in one place. */
  const best = (): SettledCost | null => {
    if (partner) {
      return null
    }
    if (harness !== null) {
      return { ticks: harness, basis: 'harness' }
    }
    return bounded && !boundBroken ? { ticks: bound, basis: 'lower_bound' } : null
  }

  /** `undefined` = nothing published yet, which is not the same as `null`. */
  let published: SettledCost | null | undefined

  /**
   * Publishes the best answer when it CHANGED — including a change to "none",
   * which is how a figure already handed to the caller gets retracted. Silent
   * when nothing changed, and silent while there has never been anything to
   * say: an unpriced turn does not need a stream of nulls to stay unpriced.
   */
  const publish = (): void => {
    const now = best()
    if (published === undefined ? now === null : sameCost(published, now)) {
      return
    }
    published = now
    handlers.onCost?.(now)
  }

  const goPartner = (signal: string): void => {
    partner = signal
    report({ cause: 'partner_platform', signal }, 'partner_platform')
    // Anything already published stops being true the moment we learn the
    // invoice is somebody else's.
    publish()
  }

  if (partnerSignal) {
    goPartner(partnerSignal)
  }

  return {
    response(messageId, model, counters) {
      if (partner) {
        return
      }
      if (partnerPlatformModel(model)) {
        goPartner(model.trim().toLowerCase())
        return
      }
      if (messageId) {
        if (countedResponses.has(messageId)) {
          return
        }
        countedResponses.add(messageId)
      }
      const result = lowerBoundTicks(model, counters, options.at, rows)
      if ('miss' in result) {
        boundBroken = true
        const id = normalizeModelId(model)
        report(missDegradation(result.miss, id, options.at), `${result.miss}:${id}`)
        // What was published stops being a bound on the WHOLE turn here, so it
        // is retracted rather than left standing as a partial sum.
        publish()
        return
      }
      bounded = true
      bound += result.ticks
      publish()
    },

    result(frame) {
      if (partner) {
        return
      }
      const estimate = harnessTicks(frame)
      if ('miss' in estimate) {
        if (estimate.miss === 'amount') {
          // The frame WAS one whose cost fields are complete, and the amount
          // on it still is not usable. Falling back to the bound is right, but
          // saying nothing would hide a broken figure upstream.
          const subtype = typeof frame.subtype === 'string' ? frame.subtype : '(unnamed)'
          report({ cause: 'harness_amount_unusable', subtype }, `harness_amount:${subtype}`)
        }
        return
      }
      const ticks = estimate.ticks
      harness = ticks
      // Structural cross-check: the table bills a STRICT SUBSET of what the
      // harness bills, so the bound can never legitimately exceed it. When it
      // does, one of the two is wrong and the journal says so — informative,
      // never blocking, and the harness's figure still stands (it is the one
      // that covers output and subagents).
      if (bounded && !boundBroken && bound > ticks) {
        report(
          { cause: 'drift', lowerBoundTicks: bound, harnessTicks: ticks },
          `drift:${bound}:${ticks}`,
        )
      }
      publish()
    },

    settle: best,
  }
}

/* ------------------------------------------------------------------------ *
 * The task total
 * ------------------------------------------------------------------------ */

export type TaskCost = {
  /** Sum of the covered turns' ticks. */
  ticks: number
  /** HOW MANY turns that sum covers — a total is only as complete as this. */
  turns: number
  /**
   * 'harness' only when EVERY covered turn is itself 'harness'. One turn on
   * the fallback table (or carrying no provenance at all) makes the whole
   * total a lower bound, because that is what it then is.
   */
  basis: CostBasis
}

/**
 * Outcome of totalling a task, with its two failure modes told APART:
 *
 * - 'total'            — a figure, its coverage and its provenance;
 * - 'none'             — not one turn carries a cost. Unknown, not free, and
 *                        nothing to report beyond what each turn already said;
 * - 'unrepresentable'  — turns DO carry costs but their sum leaves the exact
 *                        integer range. That is not "no cost": it is a total
 *                        this schema cannot state, and it gets said out loud
 *                        rather than looking like an unpriced task.
 */
export type TaskCostResult =
  ({ kind: 'total' } & TaskCost) | { kind: 'none' } | { kind: 'unrepresentable'; turns: number }

/**
 * A figure with no readable provenance, or the reverse, is not a cost.
 *
 * `-0` is refused alongside the obvious rejects: it satisfies both
 * `Number.isSafeInteger` and `>= 0`, so nothing else would catch it, and a
 * negative zero on a money field is a value nobody meant to write.
 */
const usableCost = (cost: SettledCost | null): cost is SettledCost =>
  cost !== null &&
  Number.isSafeInteger(cost.ticks) &&
  cost.ticks >= 0 &&
  !Object.is(cost.ticks, -0) &&
  (cost.basis === 'harness' || cost.basis === 'lower_bound')

/**
 * What a turn claims to have cost — THE single reader of those two fields.
 *
 * `cost_ticks` and `cost_basis` are one fact in two keys and are only ever
 * read together: a figure whose provenance nobody can name cannot be
 * interpreted (is it an estimate of the whole run, or a floor over input and
 * cache?), and a provenance with no figure describes nothing. Everything that
 * reads a turn's cost goes through here, so no two callers can ever disagree
 * about whether a given turn carries one — which is exactly the disagreement
 * that would silently drop a figure when folding a re-run attempt.
 */
export function turnCostOf(turn: TaskTurn): SettledCost | null {
  if (turn.cost_ticks === undefined || turn.cost_basis === undefined) {
    return null
  }
  const cost = { ticks: turn.cost_ticks, basis: turn.cost_basis }
  return usableCost(cost) ? cost : null
}

/**
 * The task's running total: the SUM of the `cost_ticks` its turns carry.
 *
 * A task whose turns are only PARTLY priced totals what is known and says how
 * many turns that is (`turns`). The turns that could not be priced already
 * said so in the journal, so the gap is stated somewhere; what must never
 * happen is the opposite — an unpriced turn silently counted as costing zero.
 *
 * Only the FIRST `TASK_TURNS_MAX` turns are summed, which is exactly the set
 * `sanitizeTaskRecord` keeps: a coverage claiming more turns than the record
 * will hold, over a figure including turns it will drop, would be wrong twice.
 */
export function totalCost(turns: readonly TaskTurn[]): TaskCostResult {
  let ticks = 0
  let covered = 0
  let allHarness = true
  for (const turn of turns.slice(0, TASK_TURNS_MAX)) {
    const cost = turnCostOf(turn)
    if (cost === null) {
      continue
    }
    ticks += cost.ticks
    covered++
    if (cost.basis !== 'harness') {
      allHarness = false
    }
  }
  if (covered === 0) {
    return { kind: 'none' }
  }
  if (!Number.isSafeInteger(ticks)) {
    return { kind: 'unrepresentable', turns: covered }
  }
  return { kind: 'total', ticks, turns: covered, basis: allHarness ? 'harness' : 'lower_bound' }
}

/**
 * Folds ONE attempt's measurement into what a turn already carries.
 *
 * A turn can be attempted several times: `resume()` re-runs the very turn a
 * Ctrl-C or a crash cut short, in place. Two rules follow, and they are the
 * same on the success path and on the failure path — the whole point is that
 * neither erases what the other measured:
 *
 *  - an attempt that measured NOTHING changes nothing. It cannot prove the
 *    turn was free, so the figure a previous attempt recorded stands.
 *  - an attempt that measured something ADDS to what is there. The turn really
 *    did burn both attempts, so the sum is the honest reading, and the
 *    provenance falls back to 'lower_bound' as soon as either part is one — a
 *    sum is never more authoritative than its weakest term.
 *
 * Adding is right because the two figures are DISJOINT: the harness reports
 * each run independently ("Each query() call within a session reports its own
 * cost independently", and it provides no session-level total), so a resumed
 * attempt's estimate never contains the killed attempt's. Within a single
 * attempt nothing is added at all — the meter keeps the best answer and
 * republishes it, so this function sees one figure per attempt.
 *
 * Both operands are validated, on both branches: this is an exported pure
 * function, and a caller passing a NaN, an infinity, a fraction or a negative
 * must not be able to write one onto a record, nor SUBTRACT from a figure
 * already there.
 */
export type TurnCostFold =
  /** Leave the turn exactly as it is. */
  | { kind: 'unchanged' }
  /** Write this cost onto the turn. */
  | { kind: 'set'; cost: SettledCost }
  /**
   * Both parts are real, and their sum leaves the exact integer range. The
   * turn KEEPS what it had — replacing it with a wrong number would be worse —
   * and the caller is told, because nothing downstream can notice on its own:
   * the turn still carries a usable figure, so the record total stays a
   * perfectly ordinary total and would report nothing.
   */
  | { kind: 'unrepresentable'; kept: SettledCost; dropped: SettledCost }

export function foldTurnCost(
  current: SettledCost | null,
  measured: SettledCost | null,
): TurnCostFold {
  if (!usableCost(measured)) {
    return { kind: 'unchanged' }
  }
  if (!usableCost(current)) {
    return { kind: 'set', cost: measured }
  }
  const ticks = current.ticks + measured.ticks
  if (!Number.isSafeInteger(ticks)) {
    return { kind: 'unrepresentable', kept: current, dropped: measured }
  }
  return {
    kind: 'set',
    cost: {
      ticks,
      basis:
        current.basis === 'harness' && measured.basis === 'harness' ? 'harness' : 'lower_bound',
    },
  }
}

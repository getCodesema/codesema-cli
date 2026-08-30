import { describe, expect, test } from 'bun:test'
import {
  RECAP_CHANGE_MAX,
  RECAP_CHANGES_MAX,
  RECAP_DECISION_MAX,
  RECAP_DECISIONS_MAX,
  RECAP_FILE_PATH_MAX,
  RECAP_FILES_MAX,
  RECAP_MR_URL_MAX,
  RECAP_SUMMARY_MAX,
  RECAP_TEST_COMMAND_MAX,
  RECAP_TESTS_MAX,
  recapRecordSchema,
  sanitizeRecap,
  type RecapRecord,
} from './recap.js'
import {
  acceptanceCriterionId,
  CRITERION_VERDICT_EVIDENCE_MAX,
  TICKET_CRITERIA_MAX,
} from './ticket.js'

// --- Fixtures ----------------------------------------------------------------

const CID_A = acceptanceCriterionId('WHEN a ticket is launched THE SYSTEM SHALL lint its body')
const CID_B = acceptanceCriterionId('WHEN a section is missing THE SYSTEM SHALL name that section')

const FULL_RECORD: RecapRecord = {
  version: 1,
  summary: 'Added the recap schema and its deterministic generator.',
  changes: ['Added RecapRecord to the contract', 'Added the generator'],
  decisions: ['Calqué le récap sur ReviewRecord'],
  files: ['packages/contract/src/recap.ts', 'packages/cli/src/task-recap.ts'],
  tests: [
    { command: 'bun test', status: 'passed' },
    { command: 'bun run lint', status: 'failed' },
  ],
  criteria: [
    { criterion_id: CID_A, status: 'met', evidence: 'the diff shows RecapRecord' },
    { criterion_id: CID_B, status: 'unclear' },
  ],
  tokens: 12_345,
  cost_ticks: 42,
  cost_basis: 'lower_bound',
  branch: 'codesema/task-recap-schema',
  mr_url: 'https://github.com/getCodesema/codesema-cli/pull/1',
}

// --- Round 4, mineur: the published bounds are constants a bare
// `'x'.repeat(CONST + N)` / `toHaveLength(CONST)` test never pins — it
// compares the output to the very constant that produced it, so muting
// RECAP_SUMMARY_MAX from 4_000 to 40_000 leaves every such test green. At
// least one LITERAL assertion locks the numbers down.

test('published bounds are locked to their literal values', () => {
  expect(RECAP_SUMMARY_MAX).toBe(4_000)
  expect(RECAP_CHANGE_MAX).toBe(500)
  expect(RECAP_CHANGES_MAX).toBe(64)
  expect(RECAP_DECISION_MAX).toBe(500)
  expect(RECAP_DECISIONS_MAX).toBe(64)
  expect(RECAP_FILE_PATH_MAX).toBe(1_000)
  expect(RECAP_FILES_MAX).toBe(1_000)
  expect(RECAP_TEST_COMMAND_MAX).toBe(500)
  expect(RECAP_TESTS_MAX).toBe(64)
  expect(RECAP_MR_URL_MAX).toBe(2_000)
})

// --- sanitizeRecap: whitelist and truncate, never throw ----------------------

describe('sanitizeRecap', () => {
  test('a valid, full record round-trips unchanged', () => {
    expect(sanitizeRecap(structuredClone(FULL_RECORD))).toEqual(FULL_RECORD)
  })

  test('a minimal record (only the required fields) is honest about the rest', () => {
    const minimal = {
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
    }
    expect(sanitizeRecap(minimal)).toEqual({
      version: 1,
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      branch: 'main',
    })
  })

  test('non-object input never throws and returns null', () => {
    for (const raw of [null, undefined, 42, 'x', [], Symbol('x'), true]) {
      expect(() => sanitizeRecap(raw)).not.toThrow()
      expect(sanitizeRecap(raw)).toBeNull()
    }
  })

  test('a record with no usable branch is null: branch is the recap identity', () => {
    for (const raw of [{}, { branch: '' }, { branch: '   ' }, { branch: 42 }, { branch: null }]) {
      expect(sanitizeRecap(raw)).toBeNull()
    }
  })

  test('unknown top-level fields are dropped (whitelist)', () => {
    const withExtra = { ...structuredClone(FULL_RECORD), evil: 'payload', __proto__: { x: 1 } }
    expect(Object.keys(sanitizeRecap(withExtra) ?? {})).not.toContain('evil')
  })

  test('hostile entry never throws: wrong types everywhere, null and undefined', () => {
    const hostile = {
      version: 999,
      summary: 42,
      changes: 'not-an-array',
      decisions: [1, 2, { x: 1 }, null],
      files: null,
      tests: [{ command: 42, status: 'passed' }, { command: 'ok', status: 'BOGUS' }, null, 'x'],
      criteria: 'not-an-array',
      tokens: -5,
      cost_ticks: 3.5,
      cost_basis: 'made_up',
      branch: 'main',
      mr_url: 12345,
    }
    expect(() => sanitizeRecap(hostile)).not.toThrow()
    const out = sanitizeRecap(hostile)
    expect(out).not.toBeNull()
    expect(out?.version).toBe(1)
    expect(out?.summary).toBe('') // 42 is not a string
    expect(out?.changes).toEqual([]) // not an array
    expect(out?.decisions).toEqual([]) // every entry unusable
    expect(out?.files).toEqual([]) // null -> empty
    // Every tests[] entry above is individually unusable (bad command type,
    // unknown status, non-object, bare string): the whole list drops to empty.
    expect(out?.tests).toEqual([])
    expect(out?.criteria).toBeUndefined()
    expect(out?.tokens).toBeUndefined() // negative
    expect(out?.cost_ticks).toBeUndefined() // pair drops together (float + unknown basis)
    expect(out?.cost_basis).toBeUndefined()
    expect(out?.mr_url).toBeUndefined() // not a string
  })

  test('tests[]: an unrecognized command or status entry is dropped, not the whole list', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [
        { command: 'bun test', status: 'passed' },
        { command: 42, status: 'passed' }, // bad command: dropped
        { command: 'bun run lint', status: 'BOGUS' }, // bad status: dropped
        { command: '', status: 'passed' }, // empty command: dropped
      ],
    })
    expect(out?.tests).toEqual([{ command: 'bun test', status: 'passed' }])
  })

  test('tests[]: unconfigured and error are kept — the whole-run states a checker must name', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [
        { command: '(no checks configured for this repo)', status: 'unconfigured' },
        { command: 'container engine unavailable', status: 'error' },
      ],
    })
    expect(out?.tests).toEqual([
      { command: '(no checks configured for this repo)', status: 'unconfigured' },
      { command: 'container engine unavailable', status: 'error' },
    ])
  })

  test('criteria[].status outside the enum degrades to unclear, never to met', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: [{ criterion_id: CID_A, status: 'DEFINITELY_MET' }],
    })
    expect(out?.criteria).toEqual([{ criterion_id: CID_A, status: 'unclear' }])
  })

  test('criteria[]: an entry with an invented id is discarded outright', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: [
        { criterion_id: 'ac-deadbeefdead', status: 'met' }, // well-formed but unresolvable — kept: format is all this layer can check
        { criterion_id: 'not-even-shaped-like-one', status: 'met' }, // discarded
      ],
    })
    expect(out?.criteria).toEqual([{ criterion_id: 'ac-deadbeefdead', status: 'met' }])
  })

  test('criteria[] that sanitizes down to nothing is OMITTED, never an empty array', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: [{ criterion_id: 'garbage', status: 'met' }],
    })
    expect(out?.criteria).toBeUndefined()
    expect('criteria' in (out as object)).toBe(false)
  })

  test('criteria[] is capped at TICKET_CRITERIA_MAX', () => {
    const many = Array.from({ length: TICKET_CRITERIA_MAX + 5 }, (_, i) => ({
      criterion_id: acceptanceCriterionId(`WHEN case ${i} happens THE SYSTEM SHALL react`),
      status: 'met',
    }))
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: many,
    })
    expect(out?.criteria).toHaveLength(TICKET_CRITERIA_MAX)
  })

  test('cost: a negative, float or non-numeric cost_ticks drops the pair, never a lying 0', () => {
    for (const bad of [-1, 3.5, 'ten', null, Number.NaN, -0]) {
      const out = sanitizeRecap({
        branch: 'main',
        summary: '',
        changes: [],
        decisions: [],
        files: [],
        tests: [],
        cost_ticks: bad,
        cost_basis: 'harness',
      })
      expect(out?.cost_ticks).toBeUndefined()
      expect(out?.cost_basis).toBeUndefined()
    }
  })

  test('cost: a valid cost_ticks with an unnamed basis drops the pair too', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      cost_ticks: 100,
      cost_basis: 'made_up',
    })
    expect(out?.cost_ticks).toBeUndefined()
    expect(out?.cost_basis).toBeUndefined()
  })

  test('tokens: a negative or non-integer count is absent, not zero', () => {
    for (const bad of [-1, 3.5, 'many', null, Number.NaN]) {
      const out = sanitizeRecap({
        branch: 'main',
        summary: '',
        changes: [],
        decisions: [],
        files: [],
        tests: [],
        tokens: bad,
      })
      expect(out?.tokens).toBeUndefined()
    }
  })

  test('mr_url: blank or whitespace-only is omitted, never an empty string', () => {
    for (const blank of ['', '   ']) {
      const out = sanitizeRecap({
        branch: 'main',
        summary: '',
        changes: [],
        decisions: [],
        files: [],
        tests: [],
        mr_url: blank,
      })
      expect(out?.mr_url).toBeUndefined()
    }
  })

  test('strings and lists are truncated to their published bounds', () => {
    const out = sanitizeRecap({
      branch: 'x'.repeat(1_000),
      summary: 'x'.repeat(RECAP_SUMMARY_MAX + 500),
      changes: Array.from({ length: RECAP_CHANGES_MAX + 20 }, (_, i) => `change ${i}`),
      decisions: Array.from({ length: RECAP_DECISIONS_MAX + 20 }, (_, i) => `decision ${i}`),
      files: Array.from({ length: RECAP_FILES_MAX + 20 }, (_, i) => `file-${i}.ts`),
      tests: Array.from({ length: RECAP_TESTS_MAX + 20 }, (_, i) => ({
        command: `cmd-${i}`,
        status: 'passed',
      })),
      mr_url: `https://example.com/${'x'.repeat(RECAP_MR_URL_MAX + 500)}`,
    })
    expect(out?.summary).toHaveLength(RECAP_SUMMARY_MAX)
    expect(out?.changes).toHaveLength(RECAP_CHANGES_MAX)
    expect(out?.decisions).toHaveLength(RECAP_DECISIONS_MAX)
    expect(out?.files).toHaveLength(RECAP_FILES_MAX)
    expect(out?.tests).toHaveLength(RECAP_TESTS_MAX)
    expect((out?.mr_url ?? '').length).toBe(RECAP_MR_URL_MAX)
  })

  test('one over-long change string is truncated, not dropped', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: ['y'.repeat(RECAP_CHANGE_MAX + 200)],
      decisions: ['z'.repeat(RECAP_DECISION_MAX + 200)],
      files: [],
      tests: [{ command: 'c'.repeat(RECAP_TEST_COMMAND_MAX + 200), status: 'passed' }],
    })
    expect(out?.changes?.[0]).toHaveLength(RECAP_CHANGE_MAX)
    expect(out?.decisions?.[0]).toHaveLength(RECAP_DECISION_MAX)
    expect(out?.tests?.[0]?.command).toHaveLength(RECAP_TEST_COMMAND_MAX)
  })

  test('files[] path is truncated to its bound', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: ['p'.repeat(RECAP_FILE_PATH_MAX + 200)],
      tests: [],
    })
    expect(out?.files?.[0]).toHaveLength(RECAP_FILE_PATH_MAX)
  })

  test('truncation is code-point aware: an astral character is never split into a lone surrogate', () => {
    // Each '😀' is ONE code point and TWO UTF-16 units. A `.slice()` cut at an
    // odd unit count would leave a lone surrogate at the boundary; cutCodePoints never does.
    const emoji = '\u{1F600}'.repeat(RECAP_SUMMARY_MAX)
    const out = sanitizeRecap({
      branch: 'main',
      summary: emoji,
      changes: [`c-${emoji}`],
      decisions: [],
      files: [],
      tests: [],
    })
    expect(out?.summary.length).toBeGreaterThan(0)
    expect([...(out?.summary ?? '')]).toHaveLength(RECAP_SUMMARY_MAX)
    // A lone high surrogate at the very end is exactly what a unit-counted
    // cut produces and a code-point-counted one never does.
    expect(/[\uD800-\uDBFF]$/.test(out?.summary ?? '')).toBe(false)
    expect(/[\uD800-\uDBFF]$/.test(out?.changes?.[0] ?? '')).toBe(false)
  })

  // Round 2, majeur 1 (data layer): CommonMark treats a lone CR as a line
  // terminator exactly like LF and CRLF. Round 1's fix normalized `\r\n?` in
  // `str()`'s predecessor, but the coordinator's own recipe (`sectionText`'s
  // `raw.replace(/\r\n?/g, '\n')`) misses the lone-CR case too if copied
  // verbatim — this pins that `str()` normalizes ALL three forms.
  test('a lone CR in summary/changes/decisions is normalized to LF, not left as a bare CR', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: 'first\r\rsecond\r\nthird\nfourth',
      changes: ['a\rb'],
      decisions: ['c\rd'],
      files: [],
      tests: [],
    })
    expect(out?.summary).toBe('first\n\nsecond\nthird\nfourth')
    expect(out?.summary).not.toContain('\r')
    expect(out?.changes?.[0]).toBe('a\nb')
    expect(out?.decisions?.[0]).toBe('c\nd')
  })

  test('criteria[]: a repeated criterion_id collapses onto its FIRST occurrence, even when the verdicts disagree', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: [
        { criterion_id: CID_A, status: 'met', evidence: 'first pass' },
        { criterion_id: CID_A, status: 'unmet', evidence: 'contradicts the first' },
      ],
    })
    expect(out?.criteria).toEqual([{ criterion_id: CID_A, status: 'met', evidence: 'first pass' }])
  })

  // D26: `question` flows through `sanitizeCriterionVerdict` (ticket.ts),
  // which `sanitizeRecapCriterion` delegates to before adding `text` — no
  // change needed in THIS module's own code, only proof it actually happens.
  test('criteria[]: question (D26) survives alongside the denormalized text', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: [
        {
          criterion_id: CID_A,
          status: 'unclear',
          question: 'does this match the sibling helper?',
          text: 'WHEN the helper is added THE SYSTEM SHALL match the existing style',
        },
      ],
    })
    expect(out?.criteria).toEqual([
      {
        criterion_id: CID_A,
        status: 'unclear',
        question: 'does this match the sibling helper?',
        text: 'WHEN the helper is added THE SYSTEM SHALL match the existing style',
      },
    ])
  })

  test('tests[]: a synthetic entry round-trips its flag; a real one never gains it', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [
        {
          command: '(no checks configured for this repo)',
          status: 'unconfigured',
          synthetic: true,
        },
        { command: 'bun test', status: 'passed' },
      ],
    })
    expect(out?.tests).toEqual([
      { command: '(no checks configured for this repo)', status: 'unconfigured', synthetic: true },
      { command: 'bun test', status: 'passed' },
    ])
  })

  test('tests[].synthetic is only ever true — a faked value drops the key rather than passing through', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [{ command: 'bun test', status: 'passed', synthetic: 'yes' }],
    })
    expect(out?.tests?.[0]).toEqual({ command: 'bun test', status: 'passed' })
  })

  // --- Round 4, majeur 1: branch, mr_url, files[], tests[].command and
  // criteria[].text are MONO-LINE BY CONSTRUCTION — `line()` maps EVERY
  // Unicode control character (not just the three CommonMark line-terminator
  // forms `str()` normalizes) to a space, then collapses whitespace runs.
  // `renderRecapMarkdown` is documented as a pure function of the PUBLISHED
  // schema, so it must hold for every RecapRecord that schema admits — a
  // hand-crafted recap.json, or a repo-declared checks command with no
  // newline filter (`readChecksConfig`, `repo-config.ts`), reach it through
  // this exact door.

  // Round 5, mineur: each of the five probes below now carries at least one
  // control character OUTSIDE `\s` (NUL, ESC, DEL). Without one, `line()`'s
  // `.replace(/\p{Cc}/gu, ' ')` is not epinglee by anything: the surviving
  // `.replace(/\s+/g, ' ')` already covers TAB/LF/VT/FF/CR — exactly the five
  // characters these tests used to probe — so deleting the `\p{Cc}` half left
  // every one of them green, while `sanitizeRecap` would then emit records its
  // OWN published schema refuses.

  test('branch: an embedded newline (and any other control character) is neutralized to a single space, never stored raw', () => {
    const out = sanitizeRecap({
      branch: 'feature\nbranch\twith\rcontrol\vchars\x00and\x7fmore',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
    })
    expect(out?.branch).toBe('feature branch with control chars and more')
  })

  test('mr_url: same neutralization — a forged footer line embedded via a newline collapses onto the same line', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      mr_url:
        'https://example.com/pr/1\x00\x7f\n\n**Merge request:**\x1b https://evil.example/mr/2',
    })
    expect(out?.mr_url).toBe(
      'https://example.com/pr/1 **Merge request:** https://evil.example/mr/2',
    )
  })

  test('files[]: same neutralization, entry by entry', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: ['a.ts\x00\n\n##\x7fFake', 'b.ts'],
      tests: [],
    })
    expect(out?.files).toEqual(['a.ts ## Fake', 'b.ts'])
  })

  test('tests[].command: same neutralization', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [{ command: 'bun test\x7f\n\n##\x00Acceptance criteria', status: 'passed' }],
    })
    expect(out?.tests).toEqual([{ command: 'bun test ## Acceptance criteria', status: 'passed' }])
  })

  test('criteria[].text: same neutralization', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: [
        { criterion_id: CID_A, status: 'met', text: 'ships\x00\n\n## Cost\n999999\x7fticks' },
      ],
    })
    expect(out?.criteria?.[0]?.text).toBe('ships ## Cost 999999 ticks')
  })

  test('tokens: a value past Number.MAX_SAFE_INTEGER is absent, not silently accepted', () => {
    const out = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      tokens: 9_007_199_254_740_992,
    })
    expect(out?.tokens).toBeUndefined()
  })

  // --- Round 4: killing survivor mutants on the ROUND-3 correction itself
  // (§6 ter) — removing the SECOND `.trim()` after `cutCodePoints` breaks the
  // idempotence this sanitizer's own doc comment promises ("a value this
  // sanitizer stores must reproduce unchanged when read back"). Same hole,
  // same probe, on `sanitizeCriterionVerdict`'s `evidence` (ticket.ts),
  // introduced in this same round for DP12.

  test('str(): a cut landing on trailing whitespace is trimmed away, not left dangling, and sanitizeRecap is idempotent', () => {
    const probe = (max: number): string => `${'a'.repeat(max - 1)}  b`
    const out = sanitizeRecap({
      branch: 'main',
      summary: probe(RECAP_SUMMARY_MAX),
      changes: [probe(RECAP_CHANGE_MAX)],
      decisions: [probe(RECAP_DECISION_MAX)],
      files: [],
      tests: [],
      criteria: [
        { criterion_id: CID_A, status: 'met', evidence: probe(CRITERION_VERDICT_EVIDENCE_MAX) },
      ],
    })
    expect(out?.summary.endsWith(' ')).toBe(false)
    expect(out?.changes?.[0]?.endsWith(' ')).toBe(false)
    expect(out?.decisions?.[0]?.endsWith(' ')).toBe(false)
    expect(out?.criteria?.[0]?.evidence?.endsWith(' ')).toBe(false)
    // Idempotence: re-sanitizing an already-sanitized record is a no-op.
    expect(sanitizeRecap(structuredClone(out))).toEqual(out)
  })
})

// --- The published schema -----------------------------------------------------

describe('recapRecordSchema', () => {
  test('declares a draft 2020-12 schema with its own id', () => {
    expect(recapRecordSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(recapRecordSchema.$id).toBe('https://codesema.com/schemas/recap-record.json')
  })

  test('every $ref resolves to a defined $def', () => {
    const refs: string[] = []
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          refs.push(value)
        } else {
          walk(value)
        }
      }
    }
    walk(recapRecordSchema)
    const defs = new Set(Object.keys(recapRecordSchema.$defs))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(defs.has(ref.replace('#/$defs/', ''))).toBe(true)
    }
  })

  test('every required key exists in properties', () => {
    const props = new Set(Object.keys(recapRecordSchema.properties))
    for (const key of recapRecordSchema.required) {
      expect(props.has(key)).toBe(true)
    }
    // Same check one level down, in every $def that declares its own `required`.
    for (const def of Object.values(recapRecordSchema.$defs)) {
      const d = def as { required?: readonly string[]; properties?: Record<string, unknown> }
      const defProps = new Set(Object.keys(d.properties ?? {}))
      for (const key of d.required ?? []) {
        expect(defProps.has(key)).toBe(true)
      }
    }
  })
})

// --- Cross test: sanitizeRecap output validates against the schema -----------
// Deliberately tiny and local, like ticket.test.ts's own validator: it covers
// exactly the keywords recapRecordSchema uses, so this proves the SCHEMA
// against the SANITIZER, not a library's leniency. This is the one automatic
// verrou against the "field added to the sanitizer, not the schema" drift the
// ticket's own design.md names as its top risk.

type Schema = Record<string, unknown>

function deref(schema: Schema, root: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') {
    return schema
  }
  const defs = (root.$defs ?? {}) as Record<string, Schema>
  const key = ref.replace('#/$defs/', '')
  const target = Object.hasOwn(defs, key) ? (defs[key] ?? {}) : {}
  // Draft 2020-12: `$ref` is a plain assertion — a SIBLING keyword on the same
  // schema object still applies, resolving the ref must not discard it.
  // recapRecordSchema never actually pairs `$ref` with a sibling today; the
  // merge exists so a validator claiming to prove this schema does not become
  // a silent lie the day it does.
  const { $ref: _drop, ...siblings } = schema
  return { ...target, ...siblings }
}

/**
 * Draft 2020-12 compares instances by JSON VALUE, key-order independent;
 * `JSON.stringify` is not. Canonicalizing first keeps `uniqueItems` below from
 * being LAXER than the spec it stands in for.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item))
  }
  if (value && typeof value === 'object') {
    const sorted = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1))
    return Object.fromEntries(sorted.map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function validateString(node: string, s: Schema, path: string): string[] {
  const errors: string[] = []
  const length = [...node].length
  if (typeof s.maxLength === 'number' && length > s.maxLength) {
    errors.push(`${path}: maxLength`)
  }
  if (typeof s.minLength === 'number' && length < s.minLength) {
    errors.push(`${path}: minLength`)
  }
  if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(node)) {
    errors.push(`${path}: pattern`)
  }
  return errors
}

function validateNumber(
  node: number,
  s: Schema,
  path: string,
  kind: 'number' | 'integer',
): string[] {
  const errors: string[] = []
  if (kind === 'integer' && !Number.isInteger(node)) {
    errors.push(`${path}: type`)
  }
  if (typeof s.minimum === 'number' && node < s.minimum) {
    errors.push(`${path}: minimum`)
  }
  // Round 4, mineur: recapRecordSchema now declares `maximum` on tokens/
  // cost_ticks — this local validator asserts nothing it does not check
  // (see `validate`'s own "asserts nothing" guard, below), so a `maximum`
  // keyword it silently ignored would be exactly that kind of lie by
  // omission, one level up from the schema itself.
  if (typeof s.maximum === 'number' && node > s.maximum) {
    errors.push(`${path}: maximum`)
  }
  return errors
}

function validateArray(node: unknown[], s: Schema, root: Schema, path: string): string[] {
  const errors: string[] = []
  if (typeof s.maxItems === 'number' && node.length > s.maxItems) {
    errors.push(`${path}: maxItems`)
  }
  if (typeof s.minItems === 'number' && node.length < s.minItems) {
    errors.push(`${path}: minItems`)
  }
  if (s.uniqueItems === true) {
    const seen = new Set(node.map((item) => JSON.stringify(canonical(item))))
    if (seen.size !== node.length) {
      errors.push(`${path}: uniqueItems`)
    }
  }
  const items = s.items as Schema | undefined
  if (items) {
    node.forEach((item, i) => errors.push(...validate(item, items, root, `${path}[${i}]`)))
  }
  return errors
}

function validateObject(node: object, s: Schema, root: Schema, path: string): string[] {
  const errors: string[] = []
  const record = node as Record<string, unknown>
  const properties = (s.properties ?? {}) as Record<string, Schema>
  for (const key of (s.required ?? []) as string[]) {
    // Object.hasOwn, NOT `key in record`: `in` walks the prototype chain, so
    // a required 'toString' would read as present on ANY object.
    if (!Object.hasOwn(record, key)) {
      errors.push(`${path}.${key}: required`)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    // Object.hasOwn, NOT `properties[key]`: a bracket lookup for a key like
    // 'constructor', 'toString' or '__proto__' resolves to the INHERITED
    // Object.prototype member — truthy — so `additionalProperties: false`
    // would never fire for exactly the keys most worth catching.
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (!child) {
      if (s.additionalProperties === false) {
        errors.push(`${path}.${key}: additionalProperties`)
      }
      continue
    }
    errors.push(...validate(value, child, root, `${path}.${key}`))
  }
  return errors
}

function validate(node: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  const s = deref(schema, root)
  const hasAssertion = 'const' in s || 'enum' in s || typeof s.type === 'string'
  if (!hasAssertion) {
    // A schema node that asserts NOTHING accepts every value that reaches
    // it — the silent hole this validator exists to refuse, not to
    // reproduce: drop `type` from a $def by accident and every instance
    // would validate, including an invented status. Fail LOUDLY here
    // instead of quietly proving nothing.
    throw new Error(`recapRecordSchema validator: '${path}' asserts nothing (no type/const/enum)`)
  }
  const errors: string[] = []
  if ('const' in s && node !== s.const) {
    errors.push(`${path}: const`)
  }
  if (Array.isArray(s.enum) && !s.enum.includes(node)) {
    errors.push(`${path}: enum`)
  }
  if (typeof s.type === 'string') {
    if (s.type === 'string') {
      errors.push(...(typeof node === 'string' ? validateString(node, s, path) : [`${path}: type`]))
    } else if (s.type === 'integer') {
      errors.push(
        ...(typeof node === 'number'
          ? validateNumber(node, s, path, 'integer')
          : [`${path}: type`]),
      )
    } else if (s.type === 'array') {
      errors.push(...(Array.isArray(node) ? validateArray(node, s, root, path) : [`${path}: type`]))
    } else if (s.type === 'object') {
      errors.push(
        ...(node && typeof node === 'object' && !Array.isArray(node)
          ? validateObject(node, s, root, path)
          : [`${path}: type`]),
      )
    }
  }
  return errors
}

function validateAgainstSchema(value: unknown, schema: Schema): string[] {
  return validate(value, schema, schema)
}

const schemaErrors = (value: unknown): string[] =>
  validateAgainstSchema(value, recapRecordSchema as unknown as Schema)

describe('cross test: sanitizeRecap output validates against recapRecordSchema', () => {
  test('the full nominal record validates', () => {
    expect(schemaErrors(sanitizeRecap(structuredClone(FULL_RECORD)))).toEqual([])
  })

  test('the minimal record (required fields only) validates', () => {
    const minimal = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
    })
    expect(schemaErrors(minimal)).toEqual([])
  })

  test('a record degraded by an unconfigured checks run validates', () => {
    const degraded = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [{ command: '(no checks configured for this repo)', status: 'unconfigured' }],
    })
    expect(schemaErrors(degraded)).toEqual([])
  })

  test('a record whose criteria degraded to unclear validates', () => {
    const degraded = sanitizeRecap({
      branch: 'main',
      summary: '',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      criteria: [{ criterion_id: CID_A, status: 'NOT_A_REAL_STATUS' }],
    })
    expect(schemaErrors(degraded)).toEqual([])
  })

  test('hostile input, once sanitized, still validates', () => {
    const hostile = sanitizeRecap({
      version: 'not-1',
      summary: { nested: true },
      changes: 'not-an-array',
      decisions: [1, null, {}],
      files: 42,
      tests: [{ command: 1, status: 'x' }, null, 'x'],
      criteria: 'nope',
      tokens: -1,
      cost_ticks: 'lots',
      cost_basis: 42,
      branch: 'main',
      mr_url: {},
    })
    expect(schemaErrors(hostile)).toEqual([])
  })

  test('sanitizeRecap never produces a value the schema rejects, across a spread of degraded shapes', () => {
    const cases: unknown[] = [
      { branch: 'b' },
      { branch: 'b', criteria: [] },
      { branch: 'b', tokens: 0 },
      { branch: 'b', cost_ticks: 0, cost_basis: 'harness' },
      { branch: 'b', mr_url: 'https://example.com/pr/1' },
      { branch: 'b', tests: [{ command: 'boom', status: 'error' }] },
      { branch: 'b', tests: [{ command: 'synthetic one', status: 'error', synthetic: true }] },
    ]
    for (const raw of cases) {
      expect(schemaErrors(sanitizeRecap(raw))).toEqual([])
    }
  })
})

// --- Reverse cross test: the schema must not accept MORE than sanitizeRecap
// would ever produce. The forward direction (above) proves every sanitizer
// output is schema-valid; on its own that lets the schema be arbitrarily
// LOOSER than the sanitizer and still pass. A recap.json that validates
// against the published schema but that the one sanctioned reader
// (sanitizeRecap) refuses or silently reshapes is the asymmetric drift this
// ticket's own design.md names as its top risk, from the other side.

describe('reverse cross test: the schema is not looser than what sanitizeRecap actually accepts', () => {
  const BASE = {
    version: 1,
    summary: '',
    changes: [],
    decisions: [],
    files: [],
    tests: [],
    branch: 'main',
  }

  test('an empty branch is schema-invalid — sanitizeRecap refuses the WHOLE record for it', () => {
    expect(schemaErrors({ ...BASE, branch: '' })).not.toEqual([])
  })

  test('an empty criteria[] is schema-invalid — sanitizeRecap never emits one (absence only)', () => {
    expect(schemaErrors({ ...BASE, criteria: [] })).not.toEqual([])
  })

  test('an empty test command is schema-invalid — sanitizeRecap drops such an entry outright', () => {
    expect(schemaErrors({ ...BASE, tests: [{ command: '', status: 'passed' }] })).not.toEqual([])
  })

  test('an empty mr_url is schema-invalid — sanitizeRecap omits the key instead of blanking it', () => {
    expect(schemaErrors({ ...BASE, mr_url: '' })).not.toEqual([])
  })

  test('two criteria[] entries sharing an id AND every other field are schema-invalid (uniqueItems)', () => {
    const dup = { criterion_id: CID_A, status: 'met' }
    expect(schemaErrors({ ...BASE, criteria: [dup, { ...dup }] })).not.toEqual([])
  })

  // Round 2, majeur 3: minLength: 1 on array items and on the two optional
  // criterionVerdict strings. Without it, a schema-valid document can name
  // a file/change/decision/text/evidence that the sanctioned reader
  // (sanitizeRecap) silently drops or omits on the way back in.
  test('an empty changes[] entry is schema-invalid — sanitizeStringList drops it outright', () => {
    expect(schemaErrors({ ...BASE, changes: [''] })).not.toEqual([])
  })

  test('an empty decisions[] entry is schema-invalid — sanitizeStringList drops it outright', () => {
    expect(schemaErrors({ ...BASE, decisions: [''] })).not.toEqual([])
  })

  test('an empty files[] entry is schema-invalid — sanitizeStringList drops it outright', () => {
    expect(schemaErrors({ ...BASE, files: [''] })).not.toEqual([])
  })

  test('an empty criteria[].text is schema-invalid — the sanitizer never emits an empty text key', () => {
    expect(
      schemaErrors({ ...BASE, criteria: [{ criterion_id: CID_A, status: 'met', text: '' }] }),
    ).not.toEqual([])
  })

  test('an empty criteria[].evidence is schema-invalid — the sanitizer never emits an empty evidence key', () => {
    expect(
      schemaErrors({ ...BASE, criteria: [{ criterion_id: CID_A, status: 'met', evidence: '' }] }),
    ).not.toEqual([])
  })

  test('an empty criteria[].question is schema-invalid (D26) — the sanitizer never emits an empty question key', () => {
    expect(
      schemaErrors({
        ...BASE,
        criteria: [{ criterion_id: CID_A, status: 'unclear', question: '' }],
      }),
    ).not.toEqual([])
  })

  // --- Round 4, majeur 3: `minLength: 1` alone let a WHITESPACE-ONLY string
  // through — every one of the eight locations below is trimmed (str/line)
  // before the sanitizer checks for emptiness, so a schema that stopped at
  // '' left a document the sanctioned reader silently reshapes on the way
  // back in. NON_BLANK / NON_BLANK_MONO_LINE close that gap.

  test('a whitespace-only branch is schema-invalid — sanitizeRecap trims it to empty and refuses the WHOLE record', () => {
    expect(schemaErrors({ ...BASE, branch: '   ' })).not.toEqual([])
  })

  test('a whitespace-only test command is schema-invalid — sanitizeRecap trims and drops such an entry outright', () => {
    expect(schemaErrors({ ...BASE, tests: [{ command: '   ', status: 'passed' }] })).not.toEqual([])
  })

  test('a whitespace-only mr_url is schema-invalid — sanitizeRecap omits the key instead of blanking it', () => {
    expect(schemaErrors({ ...BASE, mr_url: '   ' })).not.toEqual([])
  })

  test('a whitespace-only changes[] entry is schema-invalid — sanitizeStringList drops it outright', () => {
    expect(schemaErrors({ ...BASE, changes: ['   '] })).not.toEqual([])
  })

  test('a whitespace-only decisions[] entry is schema-invalid — sanitizeStringList drops it outright', () => {
    expect(schemaErrors({ ...BASE, decisions: ['   '] })).not.toEqual([])
  })

  test('a whitespace-only files[] entry is schema-invalid — sanitizeLineList drops it outright', () => {
    expect(schemaErrors({ ...BASE, files: ['   '] })).not.toEqual([])
  })

  test('a whitespace-only criteria[].text is schema-invalid — the sanitizer never emits a whitespace-only text key', () => {
    expect(
      schemaErrors({ ...BASE, criteria: [{ criterion_id: CID_A, status: 'met', text: '   ' }] }),
    ).not.toEqual([])
  })

  test('a whitespace-only criteria[].evidence is schema-invalid — the sanitizer never emits a whitespace-only evidence key', () => {
    expect(
      schemaErrors({
        ...BASE,
        criteria: [{ criterion_id: CID_A, status: 'met', evidence: '   ' }],
      }),
    ).not.toEqual([])
  })

  // --- Round 4, majeur 1: an embedded line terminator in one of the five
  // mono-line fields is schema-invalid — `sanitizeRecap`'s `line()` never
  // stores one raw, so a schema that accepted one would be looser than the
  // sanctioned reader.

  test('an embedded newline in branch is schema-invalid — sanitizeRecap collapses it to a space, never stores one raw', () => {
    expect(schemaErrors({ ...BASE, branch: 'main\nbranch' })).not.toEqual([])
  })

  test('an embedded newline in mr_url is schema-invalid, for the same reason', () => {
    expect(schemaErrors({ ...BASE, mr_url: 'https://example.com/pr\n/1' })).not.toEqual([])
  })

  test('an embedded newline in a files[] entry is schema-invalid, for the same reason', () => {
    expect(schemaErrors({ ...BASE, files: ['a.ts\nb.ts'] })).not.toEqual([])
  })

  test('an embedded newline in tests[].command is schema-invalid, for the same reason', () => {
    expect(
      schemaErrors({ ...BASE, tests: [{ command: 'bun test\n## Fake', status: 'passed' }] }),
    ).not.toEqual([])
  })

  test('an embedded newline in criteria[].text is schema-invalid, for the same reason', () => {
    expect(
      schemaErrors({
        ...BASE,
        criteria: [{ criterion_id: CID_A, status: 'met', text: 'ships\non time' }],
      }),
    ).not.toEqual([])
  })

  // --- Round 5, majeur 1: the mono-line `pattern`'s own lookahead. It used to
  // reach with `.*`, and in ECMA-262 without the `s` flag — which is how a
  // JSON Schema `pattern` is compiled, `ajv` included — `.` stops at U+2028
  // (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR). Both are `Zl`/`Zp`, so
  // the refused character class did not catch them either: every control
  // character placed AFTER one was invisible to the lookahead, and a record
  // whose five mono-line fields each carried "… \n## Acceptance criteria"
  // behind a U+2028 validated clean. The published guarantee was false.

  const LS = '\u2028'
  const PS = '\u2029'

  test('MAJEUR 1 (round 5): a control character hidden BEHIND a U+2028 is schema-invalid in every one of the five mono-line fields', () => {
    const forged = (ch: string): string => `x${LS}${ch}## Acceptance criteria`
    for (const ch of ['\n', '\r', '\x00', '\x7f', '\t', '\x1b']) {
      expect(schemaErrors({ ...BASE, branch: forged(ch) })).not.toEqual([])
      expect(schemaErrors({ ...BASE, mr_url: forged(ch) })).not.toEqual([])
      expect(schemaErrors({ ...BASE, files: [forged(ch)] })).not.toEqual([])
      expect(
        schemaErrors({ ...BASE, tests: [{ command: forged(ch), status: 'passed' }] }),
      ).not.toEqual([])
      expect(
        schemaErrors({
          ...BASE,
          criteria: [{ criterion_id: CID_A, status: 'met', text: forged(ch) }],
        }),
      ).not.toEqual([])
    }
  })

  test('MAJEUR 1 (round 5): the same hole behind a U+2029, and with the control character LAST rather than mid-string', () => {
    expect(schemaErrors({ ...BASE, branch: `x${PS}\n` })).not.toEqual([])
    expect(schemaErrors({ ...BASE, branch: `x${PS}y\nz` })).not.toEqual([])
    expect(schemaErrors({ ...BASE, mr_url: `https://e.com/1${PS}\x00` })).not.toEqual([])
  })

  test('MAJEUR 1 (round 5): U+2028/U+2029 are themselves refused — `line()` folds both to a space, so admitting them would leave the schema looser than the sanctioned reader', () => {
    expect(schemaErrors({ ...BASE, branch: `main${LS}branch` })).not.toEqual([])
    expect(schemaErrors({ ...BASE, branch: `main${PS}branch` })).not.toEqual([])
    // And the sanitizer really does fold them, so the two directions agree.
    expect(sanitizeRecap({ ...BASE, branch: `main${LS}branch` })?.branch).toBe('main branch')
    expect(sanitizeRecap({ ...BASE, branch: `main${PS}branch` })?.branch).toBe('main branch')
  })

  test('MAJEUR 1 (round 5): no regression — an ordinary mono-line value, NBSP and astral characters included, still validates', () => {
    expect(schemaErrors({ ...BASE, branch: 'a' })).toEqual([])
    expect(schemaErrors({ ...BASE, branch: 'feature/x-1 (rebased)' })).toEqual([])
    expect(schemaErrors({ ...BASE, branch: 'a b' })).toEqual([])
    expect(schemaErrors({ ...BASE, files: ['src/\u{1f600}.ts'] })).toEqual([])
    expect(schemaErrors({ ...BASE, mr_url: 'https://e.com/1?a=1&b=2#x' })).toEqual([])
  })

  test('MAJEUR 1 (round 5): sanitizeRecap output for input carrying U+2028/U+2029 still validates — forward direction, same corner', () => {
    const out = sanitizeRecap({
      branch: `main${LS}branch`,
      summary: '',
      changes: [],
      decisions: [],
      files: [`a${LS}\nb.ts`],
      tests: [{ command: `x${PS}\x00y`, status: 'passed' }],
      mr_url: `https://e.com/1${LS}\r\n2`,
      criteria: [{ criterion_id: CID_A, status: 'met', text: `a${PS}\x7fb` }],
    })
    expect(schemaErrors(out)).toEqual([])
    expect(out?.files).toEqual(['a b.ts'])
  })

  // --- Round 4, mineur: Number.isSafeInteger already refuses a `tokens`/
  // `cost_ticks` past 2^53-1 on the sanitizer side (optionalNonNegativeInt) —
  // but the schema had no `maximum`, so `9007199254740992` validated as a
  // plain `integer` with no upper bound: looser than the sanctioned reader.

  test('tokens/cost_ticks: the schema accepts the max safe integer and rejects one past it', () => {
    expect(schemaErrors({ ...BASE, tokens: 9_007_199_254_740_991 })).toEqual([])
    expect(schemaErrors({ ...BASE, tokens: 9_007_199_254_740_992 })).not.toEqual([])
    expect(
      schemaErrors({ ...BASE, cost_ticks: 9_007_199_254_740_991, cost_basis: 'harness' }),
    ).toEqual([])
    expect(
      schemaErrors({ ...BASE, cost_ticks: 9_007_199_254_740_992, cost_basis: 'harness' }),
    ).not.toEqual([])
  })

  // --- Forward direction, once more: `line()`'s output for hostile control-
  // character input must still validate — the two directions must agree.

  test('sanitizeRecap output for hostile control-character input still validates against the schema', () => {
    const out = sanitizeRecap({
      branch: 'main\tbranch',
      summary: '',
      changes: [],
      decisions: [],
      files: ['a\r\nb.ts'],
      tests: [{ command: 'x\vy', status: 'passed' }],
      mr_url: 'https://e.com/1\r\n2',
      criteria: [{ criterion_id: CID_A, status: 'met', text: 'a\fb' }],
    })
    expect(schemaErrors(out)).toEqual([])
  })
})

// --- The validator's own hardening: prototype pollution, and the "asserts
// nothing" guard (majeur review, see deref/validateObject/validate above).

describe('the local validator itself: it must not lie by omission', () => {
  test('a "constructor" key is flagged as additionalProperties, not swallowed by Object.prototype', () => {
    const valid = sanitizeRecap(structuredClone(FULL_RECORD)) as unknown as Record<string, unknown>
    const polluted = { ...valid, constructor: 'payload' }
    expect(schemaErrors(polluted)).toContain('$.constructor: additionalProperties')
  })

  test('a "toString" key is flagged the same way', () => {
    const valid = sanitizeRecap(structuredClone(FULL_RECORD)) as unknown as Record<string, unknown>
    expect(schemaErrors({ ...valid, toString: 'payload' })).toContain(
      '$.toString: additionalProperties',
    )
  })

  test('"__proto__" parsed as a literal JSON key is flagged too — JSON.parse makes it a real OWN property, not a prototype write, and the validator must not treat it as inherited', () => {
    const withProto = JSON.parse(
      '{"version":1,"summary":"","changes":[],"decisions":[],"files":[],"tests":[],"branch":"main","__proto__":{"evil":true}}',
    ) as Record<string, unknown>
    expect(Object.hasOwn(withProto, '__proto__')).toBe(true) // sanity: this is an own key, not a prototype swap
    expect(schemaErrors(withProto)).toContain('$.__proto__: additionalProperties')
  })

  test('a schema node with no type/const/enum makes the validator refuse to silently pass everything', () => {
    const bogus: Schema = {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: {} }, // no type, no const, no enum: asserts nothing
    }
    expect(() => validateAgainstSchema({ status: 'ANYTHING GOES' }, bogus)).toThrow()
  })

  test('a required key present only via the prototype chain still reports as missing', () => {
    const bogus: Schema = {
      type: 'object',
      required: ['toString'],
      properties: { toString: { type: 'string' } },
    }
    expect(validateAgainstSchema({}, bogus)).toContain('$.toString: required')
  })
})

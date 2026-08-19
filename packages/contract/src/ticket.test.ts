import { describe, expect, test } from 'bun:test'
import { TASK_REASON_DETAIL_MAX } from './reasons.js'
import {
  ACCEPTANCE_CRITERIA_HEADING,
  acceptanceCriterionId,
  EARS_RESPONSE,
  EARS_TRIGGER,
  extractAcceptanceCriteria,
  formatTicketProblems,
  isAcceptanceCriterionId,
  lintCriteria,
  lintTicketBody,
  normalizeCriterionText,
  readAcceptanceCriteria,
  sanitizeAcceptanceCriteria,
  sanitizeAcceptanceCriterion,
  sanitizeTicketBody,
  TICKET_CRITERIA_MAX,
  TICKET_CRITERIA_MIN,
  TICKET_CRITERION_TEXT_MAX,
  TICKET_PROBLEM_CODES,
  TICKET_PROBLEMS_TEXT_MAX,
  TICKET_SECTION_MAX,
  TICKET_SECTIONS,
  ticketBodySchema,
  type AcceptanceCriterion,
  type TicketBody,
  type TicketLintResult,
  type TicketProblem,
  type TicketSectionHeading,
} from './ticket.js'

// --- Fixtures ---------------------------------------------------------------

const CRITERIA = [
  'WHEN a ticket is launched THE SYSTEM SHALL lint its body',
  'WHEN a section is missing THE SYSTEM SHALL name that section',
  'WHEN the body is conforming THE SYSTEM SHALL accept it',
]

type Parts = {
  context?: string
  goal?: string
  scope?: string
  criteria?: string[]
  criteriaBlock?: string
  outOfScope?: string
  omit?: TicketSectionHeading
}

function markdown(parts: Parts = {}): string {
  const criteria = parts.criteria ?? CRITERIA
  const blocks: [TicketSectionHeading, string][] = [
    ['**Context**', parts.context ?? 'Tickets are launched from the workspace.'],
    ['**Goal**', parts.goal ?? 'Freeze the ticket format once.'],
    ['**Scope**', parts.scope ?? 'packages/contract/src/ticket.ts'],
    [ACCEPTANCE_CRITERIA_HEADING, parts.criteriaBlock ?? criteria.map((c) => `- ${c}`).join('\n')],
    ['**Out of scope**', parts.outOfScope ?? 'Posting the issue on the forge.'],
  ]
  return blocks
    .filter(([heading]) => heading !== parts.omit)
    .map(([heading, block]) => `${heading}\n\n${block}`)
    .join('\n\n')
}

function lintOk(raw: string): TicketBody {
  const result = lintTicketBody(raw)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('unreachable')
  }
  return result.body
}

function lintKo(raw: unknown): TicketProblem[] {
  const result: TicketLintResult = lintTicketBody(raw)
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('unreachable')
  }
  return result.problems
}

function criteriaOk(raw: unknown): AcceptanceCriterion[] {
  const result = lintCriteria(raw)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('unreachable')
  }
  return result.criteria
}

function criteriaKo(raw: unknown): TicketProblem[] {
  const result = lintCriteria(raw)
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('unreachable')
  }
  return result.problems
}

/** A criteria block, as it appears under the heading. */
const bullets = (criteria: readonly string[]): string => criteria.map((c) => `- ${c}`).join('\n')

/** `TICKET_CRITERIA_MAX` (or `n`) distinct, conforming criteria. */
const manyCriteria = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `WHEN case ${i} happens THE SYSTEM SHALL react`)

/** Indents every non-blank line of a body, as a quoted or nested one arrives. */
const indentBody = (raw: string, prefix: string): string =>
  raw
    .split('\n')
    .map((line) => (line.trim() ? `${prefix}${line}` : line))
    .join('\n')

/** A Makefile recipe: its leading tab is syntax, four spaces is a broken file. */
const MAKEFILE = ['```make', 'target:', '\tcc -o x x.c', '```'].join('\n')

/** A fenced Python sample whose body is indented with `indent`. */
const pythonSample = (indent: string): string =>
  ['```python', 'def f():', `${indent}return 1`, '```'].join('\n')

/** `n` lines of one tab and 99 characters, under a plain opening line. */
const tabbedSection = (n: number): string =>
  ['Lines:', ...Array.from({ length: n }, () => `\t${'x'.repeat(99)}`)].join('\n')

/** A body whose `**Context**` quotes a heading inside a fenced code block. */
const fencedContext = (fence: string): string =>
  markdown({
    context: [
      'The template a ticket must follow is:',
      '',
      fence,
      '**Goal**',
      '',
      'Say what for.',
      fence,
      '',
      'That is all.',
    ].join('\n'),
  })

// --- A minimal draft 2020-12 validator, for the cross test ------------------
// Deliberately tiny and local: it covers exactly the keywords ticketBodySchema
// uses, so the cross test proves the SCHEMA, not a library's leniency.

type Schema = Record<string, unknown>

function deref(schema: Schema, root: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') {
    return schema
  }
  const defs = (root.$defs ?? {}) as Record<string, Schema>
  return defs[ref.replace('#/$defs/', '')] ?? {}
}

function validateString(node: string, s: Schema, path: string): string[] {
  const errors: string[] = []
  // Draft 2020-12 counts the length of a string in CHARACTERS — code points —
  // not in UTF-16 code units. Counting units here would make this validator
  // reject a section of 4 000 emoji that the contract's own bound accepts, and
  // the cross test would be measuring the validator instead of the schema.
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

/**
 * Draft 2020-12 compares instances by JSON VALUE, which is key-order
 * independent; `JSON.stringify` is not. Canonicalizing first keeps this
 * validator from being LAXER than the spec it stands in for — a body whose
 * criteria differ only in key order must fail `uniqueItems` here exactly as it
 * would in a real validator. Known and deliberate gap: numeric equality across
 * representations (`1` vs `1.0`), which a ticket body cannot exhibit — its only
 * number is the `version` const.
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

function validateArray(node: unknown[], s: Schema, root: Schema, path: string): string[] {
  const errors: string[] = []
  if (typeof s.maxItems === 'number' && node.length > s.maxItems) {
    errors.push(`${path}: maxItems`)
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
    if (!(key in record)) {
      errors.push(`${path}.${key}: required`)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const child = properties[key]
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

type TypeValidator = (node: unknown, s: Schema, root: Schema, path: string) => string[]

const BY_TYPE: Record<string, TypeValidator> = {
  string: (node, s, _root, path) =>
    typeof node === 'string' ? validateString(node, s, path) : [`${path}: type`],
  array: (node, s, root, path) =>
    Array.isArray(node) ? validateArray(node, s, root, path) : [`${path}: type`],
  object: (node, s, root, path) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? validateObject(node, s, root, path)
      : [`${path}: type`],
}

function validate(node: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  const s = deref(schema, root)
  const errors: string[] = []
  if ('const' in s && node !== s.const) {
    errors.push(`${path}: const`)
  }
  const check = typeof s.type === 'string' ? BY_TYPE[s.type] : undefined
  return check ? [...errors, ...check(node, s, root, path)] : errors
}

const schemaErrors = (value: unknown): string[] =>
  validate(value, ticketBodySchema as unknown as Schema, ticketBodySchema as unknown as Schema)

function omitKey(source: object, key: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) {
    if (k !== key) {
      out[k] = v
    }
  }
  return out
}

// --- Sections and bounds ----------------------------------------------------

describe('TICKET_SECTIONS', () => {
  test('publishes the five headings verbatim, in canonical order', () => {
    expect(TICKET_SECTIONS.map((s) => s.heading)).toEqual([
      '**Context**',
      '**Goal**',
      '**Scope**',
      '**Acceptance criteria**',
      '**Out of scope**',
    ])
  })

  test('every heading maps to a field of the body the sanitizer produces', () => {
    const body = sanitizeTicketBody({})
    expect(body).not.toBeNull()
    for (const section of TICKET_SECTIONS) {
      expect(Object.hasOwn(body as object, section.key)).toBe(true)
    }
  })

  test('the acceptance-criteria heading is one of the five', () => {
    expect(TICKET_SECTIONS.some((s) => s.heading === ACCEPTANCE_CRITERIA_HEADING)).toBe(true)
  })
})

describe('exported bounds', () => {
  test('are the published numbers', () => {
    expect(TICKET_SECTION_MAX).toBe(4_000)
    expect(TICKET_CRITERION_TEXT_MAX).toBe(500)
    expect(TICKET_CRITERIA_MAX).toBe(32)
    expect(TICKET_CRITERIA_MIN).toBe(3)
  })

  test('the EARS keywords are exported uppercase and verbatim', () => {
    expect(EARS_TRIGGER).toBe('WHEN')
    expect(EARS_RESPONSE).toBe('THE SYSTEM SHALL')
  })

  test('every problem code is named, so a rename breaks instead of degrading', () => {
    expect([...TICKET_PROBLEM_CODES]).toEqual([
      'body_not_text',
      'section_missing',
      'section_duplicated',
      'section_empty',
      'section_too_long',
      'criteria_not_a_list',
      'criteria_too_few',
      'criteria_too_many',
      'criteria_duplicated',
      'criterion_not_ears',
      'criterion_too_long',
    ])
  })
})

// --- Criterion ids ----------------------------------------------------------

describe('acceptanceCriterionId', () => {
  test('is shaped ac-<12 lowercase hex> and passes its own guard', () => {
    const id = acceptanceCriterionId(CRITERIA[0] ?? '')
    expect(id).toMatch(/^ac-[0-9a-f]{12}$/)
    expect(isAcceptanceCriterionId(id)).toBe(true)
  })

  test('rejects anything else as an id', () => {
    for (const value of ['', 'C1', 'ac-XYZ', 'ac-0123456789ab0', 42, null, undefined, {}]) {
      expect(isAcceptanceCriterionId(value)).toBe(false)
    }
  })

  test('the same text always yields the same id, in two different bodies', () => {
    const shared = 'WHEN the same wording appears twice THE SYSTEM SHALL give it the same id'
    const a = extractAcceptanceCriteria(
      lintOk(markdown({ criteria: [shared, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] })),
    )
    const b = extractAcceptanceCriteria(
      lintOk(
        markdown({
          context: 'A completely different ticket.',
          goal: 'Something else entirely.',
          criteria: [CRITERIA[2] ?? '', shared, CRITERIA[1] ?? ''],
        }),
      ),
    )
    const fromA = a.find((c) => c.text === shared)
    const fromB = b.find((c) => c.text === shared)
    expect(fromA?.id).toBeDefined()
    expect(fromA?.id).toBe(fromB?.id as string)
  })

  test('normalizes whitespace before hashing, so wrapping never renames a criterion', () => {
    expect(acceptanceCriterionId('  WHEN a\n\tb   THE SYSTEM SHALL c ')).toBe(
      acceptanceCriterionId('WHEN a b THE SYSTEM SHALL c'),
    )
  })

  test('different texts get different ids', () => {
    expect(acceptanceCriterionId(CRITERIA[0] ?? '')).not.toBe(
      acceptanceCriterionId(CRITERIA[1] ?? ''),
    )
  })

  test('never collides across the published ceiling of criteria', () => {
    const ids = new Set(
      Array.from({ length: TICKET_CRITERIA_MAX }, (_, i) =>
        acceptanceCriterionId(`WHEN case ${i} happens THE SYSTEM SHALL react`),
      ),
    )
    expect(ids.size).toBe(TICKET_CRITERIA_MAX)
  })
})

// The same accented sentence, spelled both ways Unicode allows. Written with
// escapes ON PURPOSE: an editor or a formatter normalizing the file would
// otherwise quietly turn these two literals into one and disarm the test.
/** Precomposed: U+00E9. */
const ACCENTED_NFC = 'WHEN une \u00e9tape \u00e9choue THE SYSTEM SHALL le dire'
/** Decomposed: 'e' + combining acute U+0301. */
const ACCENTED_NFD = 'WHEN une e\u0301tape e\u0301choue THE SYSTEM SHALL le dire'

/**
 * Concrete texts, concrete ids. These values ARE the contract: computed once
 * and cross-checked against an independent FNV-1a implementation, they freeze
 * every step of the derivation — the whitespace collapse, the NFC
 * normalization, the UTF-8 encoding, the hash, the 48-bit truncation, the
 * `ac-` prefix and the zero padding. Touch any one of them and this test fails,
 * instead of every criterion of every ticket already written being silently
 * renamed and every verdict keyed on the old id being orphaned.
 */
const GOLDEN_IDS: readonly (readonly [string, string])[] = [
  ['WHEN a ticket is launched THE SYSTEM SHALL lint its body', 'ac-1f5f4d1b3f63'],
  ['WHEN a section is missing THE SYSTEM SHALL name that section', 'ac-4c108b62eaac'],
  ['WHEN the body is conforming THE SYSTEM SHALL accept it', 'ac-6f40cb4166a3'],
  [ACCENTED_NFC, 'ac-d587c595b3b4'],
]

describe('acceptanceCriterionId — the frozen derivation', () => {
  test('pins the exact id of concrete texts (golden values)', () => {
    for (const [text, id] of GOLDEN_IDS) {
      expect(acceptanceCriterionId(text)).toBe(id)
    }
  })

  test('the golden ids are the ones a linted body actually carries', () => {
    expect(lintOk(markdown()).acceptance_criteria.map((c) => c.id)).toEqual(
      GOLDEN_IDS.slice(0, 3).map(([, id]) => id),
    )
  })

  test('NFC and NFD spellings of one sentence share one id', () => {
    // Two different strings…
    expect(ACCENTED_NFD).not.toBe(ACCENTED_NFC)
    expect(ACCENTED_NFD.length).not.toBe(ACCENTED_NFC.length)
    // …one criterion, one id: the normalization step is what makes that true,
    // and it is frozen with the rest of the derivation.
    expect(acceptanceCriterionId(ACCENTED_NFD)).toBe(acceptanceCriterionId(ACCENTED_NFC))
    expect(acceptanceCriterionId(ACCENTED_NFD)).toBe('ac-d587c595b3b4')
  })

  test('the text a criterion carries is normalized too, so id === hash(text)', () => {
    const criterion = sanitizeAcceptanceCriterion(ACCENTED_NFD)
    expect(criterion?.text).toBe(ACCENTED_NFC)
    expect(criterion?.id).toBe(acceptanceCriterionId(criterion?.text ?? ''))
  })

  test('a body written in NFD and one written in NFC extract to the same ids', () => {
    const fromNfd = extractAcceptanceCriteria(
      lintOk(markdown({ criteria: [ACCENTED_NFD, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] })),
    )
    const fromNfc = extractAcceptanceCriteria(
      lintOk(markdown({ criteria: [ACCENTED_NFC, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] })),
    )
    expect(fromNfd).toEqual(fromNfc)
  })
})

describe('stable ids (the formatRules precedent, not reproduced)', () => {
  test('inserting a criterion at the head changes no other id', () => {
    const before = extractAcceptanceCriteria(lintOk(markdown()))
    const inserted = 'WHEN a criterion is inserted first THE SYSTEM SHALL keep the others intact'
    const after = extractAcceptanceCriteria(lintOk(markdown({ criteria: [inserted, ...CRITERIA] })))

    expect(before.map((c) => c.text)).toEqual(CRITERIA)
    expect(after).toHaveLength(before.length + 1)
    expect(after[0]?.text).toBe(inserted)
    // Every pre-existing criterion keeps the exact id it already had.
    for (const criterion of before) {
      const again = after.find((c) => c.text === criterion.text)
      expect(again?.id).toBe(criterion.id)
    }
    // And only the new one carries an id nobody had seen.
    const fresh = after.filter((c) => !before.some((b) => b.id === c.id))
    expect(fresh.map((c) => c.text)).toEqual([inserted])
  })

  test('reordering the list renames nothing', () => {
    const straight = extractAcceptanceCriteria(lintOk(markdown()))
    const reversed = extractAcceptanceCriteria(
      lintOk(markdown({ criteria: CRITERIA.toReversed() })),
    )
    expect(new Set(reversed.map((c) => c.id))).toEqual(new Set(straight.map((c) => c.id)))
  })
})

// --- Lint: the happy path ---------------------------------------------------

describe('lintTicketBody — a conforming body', () => {
  test('is accepted and carries the five sections', () => {
    const body = lintOk(markdown())
    expect(body.version).toBe(1)
    expect(body.context).toBe('Tickets are launched from the workspace.')
    expect(body.goal).toBe('Freeze the ticket format once.')
    expect(body.scope).toBe('packages/contract/src/ticket.ts')
    expect(body.out_of_scope).toBe('Posting the issue on the forge.')
    expect(body.acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
  })

  test('accepts sections in any order', () => {
    const shuffled = [
      `**Out of scope**\n\nNothing.`,
      `${ACCEPTANCE_CRITERIA_HEADING}\n\n${CRITERIA.map((c) => `- ${c}`).join('\n')}`,
      `**Goal**\n\nA goal.`,
      `**Scope**\n\nA scope.`,
      `**Context**\n\nA context.`,
    ].join('\n\n')
    expect(lintOk(shuffled).context).toBe('A context.')
  })

  test('accepts CRLF line endings and normalizes them away', () => {
    const body = lintOk(markdown().replaceAll('\n', '\r\n'))
    expect(body.context).not.toContain('\r')
    expect(body.acceptance_criteria).toHaveLength(3)
  })

  test('accepts every list marker and joins wrapped lines', () => {
    const block = [
      `1. ${CRITERIA[0]}`,
      `2) ${CRITERIA[1]}`,
      `* WHEN a criterion is wrapped over two lines`,
      `  THE SYSTEM SHALL join them back together`,
    ].join('\n')
    const body = lintOk(markdown({ criteriaBlock: block }))
    expect(body.acceptance_criteria.map((c) => c.text)).toEqual([
      CRITERIA[0] ?? '',
      CRITERIA[1] ?? '',
      'WHEN a criterion is wrapped over two lines THE SYSTEM SHALL join them back together',
    ])
  })

  test('a section is matched only on its verbatim heading', () => {
    const problems = lintKo(markdown().replace('**Goal**', '## Goal'))
    expect(problems.some((p) => p.code === 'section_missing' && p.section === '**Goal**')).toBe(
      true,
    )
  })
})

// --- Lint: the refusals, each naming what is wrong --------------------------

describe('lintTicketBody — refusals name what is wrong', () => {
  test('a missing section is named, for each of the five', () => {
    for (const { heading } of TICKET_SECTIONS) {
      const problems = lintKo(markdown({ omit: heading }))
      const missing = problems.find((p) => p.code === 'section_missing')
      expect(missing?.section).toBe(heading)
      expect(missing?.message).toContain(heading)
    }
  })

  test('fewer than three criteria names the minimum', () => {
    const problems = lintKo(markdown({ criteria: CRITERIA.slice(0, 2) }))
    const tooFew = problems.find((p) => p.code === 'criteria_too_few')
    expect(tooFew).toBeDefined()
    expect(tooFew?.message).toContain(String(TICKET_CRITERIA_MIN))
    expect(tooFew?.message).toContain('2')
  })

  test('a criterion outside EARS names the criterion', () => {
    const offender = 'the ticket format is frozen'
    const problems = lintKo(
      markdown({ criteria: [CRITERIA[0] ?? '', offender, CRITERIA[2] ?? ''] }),
    )
    const notEars = problems.find((p) => p.code === 'criterion_not_ears')
    expect(notEars?.criterion).toBe(offender)
    expect(notEars?.message).toContain(offender)
    expect(notEars?.message).toContain(EARS_RESPONSE)
  })

  test('EARS keywords are case-sensitive', () => {
    const lowercase = 'when a ticket is launched the system shall lint its body'
    const problems = lintKo(
      markdown({ criteria: [lowercase, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }),
    )
    expect(problems.some((p) => p.code === 'criterion_not_ears' && p.criterion === lowercase)).toBe(
      true,
    )
  })

  test('EARS needs a condition AND a behaviour', () => {
    for (const bad of [
      'WHEN THE SYSTEM SHALL react',
      'WHEN something happens THE SYSTEM SHALL',
      'THE SYSTEM SHALL react',
      'WHEN something happens',
    ]) {
      const problems = lintKo(markdown({ criteria: [bad, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
      expect(problems.some((p) => p.code === 'criterion_not_ears' && p.criterion === bad)).toBe(
        true,
      )
    }
  })

  test('an empty section is named', () => {
    const problems = lintKo(markdown({ goal: '   ' }))
    const empty = problems.find((p) => p.code === 'section_empty')
    expect(empty?.section).toBe('**Goal**')
    expect(empty?.message).toContain('**Goal**')
  })

  test('a section repeated twice is named', () => {
    const problems = lintKo(`${markdown()}\n\n**Scope**\n\nA second scope.`)
    const duplicated = problems.find((p) => p.code === 'section_duplicated')
    expect(duplicated?.section).toBe('**Scope**')
  })

  test('a section over the bound is named with the bound', () => {
    const problems = lintKo(markdown({ context: 'x'.repeat(TICKET_SECTION_MAX + 1) }))
    const tooLong = problems.find((p) => p.code === 'section_too_long')
    expect(tooLong?.section).toBe('**Context**')
    expect(tooLong?.message).toContain(String(TICKET_SECTION_MAX))
  })

  test('a criterion over the bound is named with the bound', () => {
    const long = `WHEN ${'x'.repeat(TICKET_CRITERION_TEXT_MAX)} THE SYSTEM SHALL react`
    const problems = lintKo(markdown({ criteria: [long, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
    const tooLong = problems.find((p) => p.code === 'criterion_too_long')
    expect(tooLong?.criterion).toBe(long)
    expect(tooLong?.message).toContain(String(TICKET_CRITERION_TEXT_MAX))
  })

  test('more criteria than the ceiling names the ceiling', () => {
    const many = Array.from(
      { length: TICKET_CRITERIA_MAX + 1 },
      (_, i) => `WHEN case ${i} happens THE SYSTEM SHALL react`,
    )
    const problems = lintKo(markdown({ criteria: many }))
    const tooMany = problems.find((p) => p.code === 'criteria_too_many')
    expect(tooMany?.message).toContain(String(TICKET_CRITERIA_MAX))
  })

  test('the same criterion twice is named, because two criteria cannot share one id', () => {
    const problems = lintKo(markdown({ criteria: [...CRITERIA, CRITERIA[0] ?? ''] }))
    const duplicated = problems.find((p) => p.code === 'criteria_duplicated')
    expect(duplicated?.criterion).toBe(CRITERIA[0] ?? '')
  })

  test('a criteria section that is not a list is named', () => {
    const problems = lintKo(
      markdown({ criteriaBlock: `Here they come:\n${CRITERIA.map((c) => `- ${c}`).join('\n')}` }),
    )
    const stray = problems.find((p) => p.code === 'criteria_not_a_list')
    expect(stray?.section).toBe(ACCEPTANCE_CRITERIA_HEADING)
    expect(stray?.message).toContain('Here they come:')
  })

  test('a body that is not text is refused, never thrown on', () => {
    for (const raw of [null, undefined, 42, '', '   ', [], {}, true, Symbol('x')]) {
      const problems = lintKo(raw)
      expect(problems).toHaveLength(1)
      expect(problems[0]?.code).toBe('body_not_text')
    }
  })

  test('a body with none of the five sections names all five', () => {
    const problems = lintKo('Just a paragraph, no headings at all.')
    expect(problems.filter((p) => p.code === 'section_missing')).toHaveLength(5)
    expect(problems.map((p) => p.section)).toEqual(TICKET_SECTIONS.map((s) => s.heading))
  })
})

// --- The criteria section is a list, and ONLY a list ------------------------

describe('lintTicketBody — nothing outside the list is absorbed', () => {
  test('prose AFTER the list is refused, and lands in no criterion', () => {
    const raw = markdown({ criteriaBlock: `${bullets(CRITERIA)}\nAnd that is the whole story.` })
    const problems = lintKo(raw)
    const stray = problems.find((p) => p.code === 'criteria_not_a_list')
    expect(stray?.section).toBe(ACCEPTANCE_CRITERIA_HEADING)
    expect(stray?.message).toContain('And that is the whole story.')
    // The trailing prose never became part of a criterion — which is what used
    // to happen silently, changing the last criterion's text and hence its id.
    for (const p of problems) {
      expect(p.criterion ?? '').not.toContain('whole story')
    }
  })

  test('a blank line then prose is refused just the same', () => {
    const raw = markdown({ criteriaBlock: `${bullets(CRITERIA)}\n\nOne closing remark.` })
    const problems = lintKo(raw)
    expect(problems.some((p) => p.code === 'criteria_not_a_list')).toBe(true)
    expect(problems.find((p) => p.code === 'criteria_not_a_list')?.message).toContain(
      'One closing remark.',
    )
  })

  test('the last criterion keeps the id it has without the trailing prose', () => {
    const clean = lintOk(markdown())
    const last = clean.acceptance_criteria.at(-1)
    // Same body plus a trailing line: refused, and no problem quotes a
    // criterion whose text grew — the identity of the last one is untouched.
    const problems = lintKo(markdown({ criteriaBlock: `${bullets(CRITERIA)}\nTrailing note.` }))
    expect(problems.some((p) => p.code === 'criteria_not_a_list')).toBe(true)
    expect(acceptanceCriterionId(`${CRITERIA[2] ?? ''} Trailing note.`)).not.toBe(last?.id)
  })

  test('a second list after a paragraph is refused, naming the paragraph', () => {
    const raw = markdown({
      criteriaBlock: [
        bullets(CRITERIA.slice(0, 2)),
        '',
        'And a few more:',
        '',
        bullets([CRITERIA[2] ?? '', 'WHEN a second list appears THE SYSTEM SHALL refuse it']),
      ].join('\n'),
    })
    const problems = lintKo(raw)
    const stray = problems.filter((p) => p.code === 'criteria_not_a_list')
    expect(stray).toHaveLength(1)
    expect(stray[0]?.message).toContain('And a few more:')
    // The four items were still read as items, so the count rule saw four.
    expect(problems.some((p) => p.code === 'criteria_too_few')).toBe(false)
  })

  test('a run of stray lines is one problem, not one per line', () => {
    const raw = markdown({
      criteriaBlock: `${bullets(CRITERIA)}\n\nFirst stray line.\nSecond stray line.`,
    })
    const stray = lintKo(raw).filter((p) => p.code === 'criteria_not_a_list')
    expect(stray).toHaveLength(1)
    expect(stray[0]?.message).toContain('First stray line.')
  })

  test('an indented wrapped line is still a continuation, not a stray', () => {
    const raw = markdown({
      criteriaBlock: [
        `- ${CRITERIA[0]}`,
        `- WHEN a criterion is wrapped`,
        `  THE SYSTEM SHALL join it back`,
        `- ${CRITERIA[2]}`,
      ].join('\n'),
    })
    const body = lintOk(raw)
    expect(body.acceptance_criteria.map((c) => c.text)).toEqual([
      CRITERIA[0] ?? '',
      'WHEN a criterion is wrapped THE SYSTEM SHALL join it back',
      CRITERIA[2] ?? '',
    ])
  })
})

describe('lintTicketBody — a sub-bullet belongs to its criterion', () => {
  test('a nested bullet is attached to the criterion above, never promoted', () => {
    const raw = markdown({
      criteriaBlock: [
        `- ${CRITERIA[0]}`,
        `  - measured on the launched body`,
        `- ${CRITERIA[1]}`,
        `- ${CRITERIA[2]}`,
      ].join('\n'),
    })
    const body = lintOk(raw)
    expect(body.acceptance_criteria).toHaveLength(3)
    expect(body.acceptance_criteria[0]?.text).toBe(
      `${CRITERIA[0] ?? ''} measured on the launched body`,
    )
    // No id was minted for the fragment on its own.
    const orphan = acceptanceCriterionId('measured on the launched body')
    expect(body.acceptance_criteria.some((c) => c.id === orphan)).toBe(false)
  })

  test('deeper nesting is attached too, in reading order', () => {
    const raw = markdown({
      criteriaBlock: [
        `- ${CRITERIA[0]}`,
        `  - first detail`,
        `    - second detail`,
        `- ${CRITERIA[1]}`,
        `- ${CRITERIA[2]}`,
      ].join('\n'),
    })
    const body = lintOk(raw)
    expect(body.acceptance_criteria).toHaveLength(3)
    expect(body.acceptance_criteria[0]?.text).toBe(
      `${CRITERIA[0] ?? ''} first detail second detail`,
    )
  })

  test('a sub-bullet separated by a blank line still belongs to its criterion', () => {
    const raw = markdown({
      criteriaBlock: [
        `- ${CRITERIA[0]}`,
        ``,
        `  - a loose detail`,
        `- ${CRITERIA[1]}`,
        `- ${CRITERIA[2]}`,
      ].join('\n'),
    })
    const body = lintOk(raw)
    expect(body.acceptance_criteria).toHaveLength(3)
    expect(body.acceptance_criteria[0]?.text).toBe(`${CRITERIA[0] ?? ''} a loose detail`)
  })

  test('a sub-bullet with no criterion above it is named, never silently adopted', () => {
    const raw = markdown({
      criteriaBlock: [`  - an orphan detail`, bullets(CRITERIA)].join('\n'),
    })
    const problems = lintKo(raw)
    expect(
      problems.some((p) => p.code === 'criterion_not_ears' && p.criterion === 'an orphan detail'),
    ).toBe(true)
  })

  test('a uniformly indented list is read as one level, not as nesting', () => {
    const raw = markdown({ criteriaBlock: CRITERIA.map((c) => `  - ${c}`).join('\n') })
    expect(lintOk(raw).acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
  })

  test('an empty bullet is refused by name, never skipped in silence', () => {
    const raw = markdown({
      criteriaBlock: [`- ${CRITERIA[0]}`, '- ', `- ${CRITERIA[1]}`, `- ${CRITERIA[2]}`].join('\n'),
    })
    const problems = lintKo(raw)
    // The three real criteria are read, so the refusal is about the empty
    // bullet and nothing else — it is the one line that used to vanish.
    expect(problems.map((p) => p.code)).toEqual(['criteria_not_a_list'])
    expect(problems[0]?.message).toContain('no criterion in it')
    expect(problems[0]?.section).toBe(ACCEPTANCE_CRITERIA_HEADING)
  })

  test('a bullet holding only whitespace is refused the same way', () => {
    for (const bullet of ['-    ', '* ', '1. ', '+ ']) {
      const raw = markdown({ criteriaBlock: [bullets(CRITERIA), bullet].join('\n') })
      expect(lintKo(raw).map((p) => p.code)).toEqual(['criteria_not_a_list'])
    }
  })
})

// --- The level of the list is the LIST's, not its last line's ---------------

describe('lintTicketBody — a crooked bullet is a sibling, never a swallowed one', () => {
  const CRIT5 = manyCriteria(5)

  /** The reproduction: one bullet de-indented in the middle of a flat list. */
  const deIndented = (third: string): string =>
    [
      `  - ${CRIT5[0]}`,
      `  - ${CRIT5[1]}`,
      `${third}- ${CRIT5[2]}`,
      `  - ${CRIT5[3]}`,
      `  - ${CRIT5[4]}`,
    ].join('\n')

  test('a bullet de-indented mid-list leaves five criteria with five ids', () => {
    const body = lintOk(markdown({ criteriaBlock: deIndented(' ') }))
    expect(body.acceptance_criteria.map((c) => c.text)).toEqual(CRIT5)
    expect(new Set(body.acceptance_criteria.map((c) => c.id)).size).toBe(5)
    // Every criterion carries the id its own text derives — none was minted
    // for a concatenation, none went unminted.
    for (const text of CRIT5) {
      expect(body.acceptance_criteria.some((c) => c.id === acceptanceCriterionId(text))).toBe(true)
    }
  })

  test('a tab landing ON the nesting column is a sub-bullet, as every renderer shows it', () => {
    // In a list at level 2, the content column of an item is 4 — and a tab
    // advances to column 4. This IS a nested list, so it belongs to the
    // criterion above rather than standing next to it; the tab-indented
    // sibling cases are the ones below, where the columns actually line up.
    const body = lintOk(markdown({ criteriaBlock: deIndented('\t') }))
    expect(body.acceptance_criteria).toHaveLength(4)
    expect(body.acceptance_criteria[1]?.text).toBe(`${CRIT5[1] ?? ''} ${CRIT5[2] ?? ''}`)
  })

  test('no criterion is ever the concatenation of the ones after it', () => {
    for (const third of [' ', '']) {
      const body = lintOk(markdown({ criteriaBlock: deIndented(third) }))
      const fused = acceptanceCriterionId(`${CRIT5[2]} ${CRIT5[3]} ${CRIT5[4]}`)
      expect(body.acceptance_criteria).toHaveLength(5)
      expect(body.acceptance_criteria.some((c) => c.id === fused)).toBe(false)
      for (const criterion of body.acceptance_criteria) {
        expect(criterion.id).toBe(acceptanceCriterionId(criterion.text))
      }
    }
  })

  test('one character of extra indent is a sibling too, not a sub-bullet', () => {
    const raw = markdown({
      criteriaBlock: [`- ${CRITERIA[0]}`, ` - ${CRITERIA[1]}`, `- ${CRITERIA[2]}`].join('\n'),
    })
    expect(lintOk(raw).acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
  })

  test('a wider marker does not move the level of the list', () => {
    // `10. ` is four characters wide; the level stays where the first item put
    // it, so what follows is read against the list, not against that marker.
    const raw = markdown({
      criteriaBlock: [`- ${CRITERIA[0]}`, `10. ${CRITERIA[1]}`, `- ${CRITERIA[2]}`].join('\n'),
    })
    expect(lintOk(raw).acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
  })

  test('a real sub-bullet, at level + 2, still belongs to its criterion', () => {
    const raw = markdown({
      criteriaBlock: [
        `  - ${CRITERIA[0]}`,
        `    - a qualifying detail`,
        `  - ${CRITERIA[1]}`,
        `  - ${CRITERIA[2]}`,
      ].join('\n'),
    })
    const body = lintOk(raw)
    expect(body.acceptance_criteria).toHaveLength(3)
    expect(body.acceptance_criteria[0]?.text).toBe(`${CRITERIA[0] ?? ''} a qualifying detail`)
  })

  test('a de-indented bullet does not drag the level down for what follows', () => {
    // c3 sits at 1, then a genuine sub-bullet of c4 sits at 4: it must still
    // attach to c4, and not be read against the crooked line before it.
    const raw = markdown({
      criteriaBlock: [
        `  - ${CRIT5[0]}`,
        ` - ${CRIT5[1]}`,
        `  - ${CRIT5[2]}`,
        `    - the detail of the third`,
      ].join('\n'),
    })
    const body = lintOk(raw)
    expect(body.acceptance_criteria.map((c) => c.text)).toEqual([
      CRIT5[0] ?? '',
      CRIT5[1] ?? '',
      `${CRIT5[2] ?? ''} the detail of the third`,
    ])
  })
})

// --- Indentation is measured in columns, and the body is dedented first -----

describe('lintTicketBody — a tab is a column, not a character', () => {
  const CRIT4 = manyCriteria(4)

  /** The list, indented item by item exactly as given. */
  const indentedList = (indents: readonly string[]): string =>
    CRIT4.map((c, i) => `${indents[i] ?? ''}- ${c}`).join('\n')

  test('a list of tabs, a list of spaces and a mixed list read the same criteria', () => {
    const tabs = lintOk(markdown({ criteriaBlock: indentedList(['\t', '\t', '\t', '\t']) }))
    const spaces = lintOk(
      markdown({ criteriaBlock: indentedList(['    ', '    ', '    ', '    ']) }),
    )
    const mixed = lintOk(markdown({ criteriaBlock: indentedList(['\t', '    ', '\t', '    ']) }))
    expect(tabs.acceptance_criteria.map((c) => c.text)).toEqual(CRIT4)
    expect(spaces.acceptance_criteria).toEqual(tabs.acceptance_criteria)
    expect(mixed.acceptance_criteria).toEqual(tabs.acceptance_criteria)
  })

  test('a tabbed first item does not swallow its space-indented siblings', () => {
    // The reproduction: with a tab counted as ONE character the list level was
    // 1, every sibling typed with three or four spaces read as nested, and the
    // fused text stayed EARS-conforming — four criteria written, three ids.
    for (const sibling of ['   ', '    ']) {
      const body = lintOk(markdown({ criteriaBlock: indentedList(['\t', sibling, '\t', sibling]) }))
      expect(body.acceptance_criteria.map((c) => c.text)).toEqual(CRIT4)
      expect(new Set(body.acceptance_criteria.map((c) => c.id)).size).toBe(4)
      for (const text of CRIT4) {
        expect(body.acceptance_criteria.some((c) => c.id === acceptanceCriterionId(text))).toBe(
          true,
        )
      }
    }
  })

  test('a tab preceded by spaces lands on the tab stop, not four columns further', () => {
    // The stop is computed from where the tab STARTS: `  \t` reaches column 4
    // just like `    `, so in a list whose level is 4 it is a SIBLING. Adding a
    // flat four instead would put it at 6 — a full marker past the level — and
    // the criterion would be folded into the one above it.
    const raw = markdown({
      criteriaBlock: [`    - ${CRIT4[0]}`, `  \t- ${CRIT4[1]}`, `    - ${CRIT4[2]}`].join('\n'),
    })
    expect(lintOk(raw).acceptance_criteria.map((c) => c.text)).toEqual(CRIT4.slice(0, 3))
  })

  test('every way of reaching column four indents the same', () => {
    // The four-space item comes FIRST so it fixes the level: any lead that did
    // not land exactly on column 4 would read as nested against it, and the
    // criterion would be folded into the one above instead of standing beside.
    const reference = lintOk(
      markdown({ criteriaBlock: indentedList(['    ', '    ', '    ', '    ']) }),
    )
    for (const lead of ['\t', ' \t', '  \t', '   \t']) {
      const body = lintOk(markdown({ criteriaBlock: indentedList(['    ', lead, '    ', lead]) }))
      expect(body.acceptance_criteria).toEqual(reference.acceptance_criteria)
    }
  })

  test('a tab still nests when it lands a full marker past the level', () => {
    const raw = markdown({
      criteriaBlock: [
        `- ${CRIT4[0]}`,
        `\t- a tabbed detail`,
        `- ${CRIT4[1]}`,
        `- ${CRIT4[2]}`,
      ].join('\n'),
    })
    const body = lintOk(raw)
    expect(body.acceptance_criteria).toHaveLength(3)
    expect(body.acceptance_criteria[0]?.text).toBe(`${CRIT4[0] ?? ''} a tabbed detail`)
  })
})

describe('lintTicketBody — the body is dedented before it is read', () => {
  test('a body indented in full is read exactly like the same body at the margin', () => {
    const flat = lintOk(markdown())
    for (const prefix of ['    ', '\t', '        ', '  ']) {
      const body = lintOk(indentBody(markdown(), prefix))
      expect(body).toEqual(flat)
    }
  })

  test('a whole ticket nested inside a numbered list item is read normally', () => {
    // What a human writes when the ticket is one entry of a plan: the body is
    // that item's CONTENT, indented in full at whatever column its marker put
    // it — `1. ` at three, `10. ` at four, a hand-typed one at five.
    for (const indent of ['   ', '    ', '     ']) {
      const body = lintOk(indentBody(markdown(), indent))
      expect(body.goal).toBe('Freeze the ticket format once.')
      expect(body.acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
    }
  })

  test('a line left at the margin holds the dedent at zero, and says so by name', () => {
    // The dedent removes what is COMMON. Paste the list marker in with the body
    // and nothing is common any more: the headings stay at four columns, where
    // they are content, and every one of them is reported MISSING — the refusal
    // names all five rather than the body being half-read.
    const raw = `10. The ticket\n\n${indentBody(markdown(), '    ')}`
    expect(lintKo(raw).filter((p) => p.code === 'section_missing')).toHaveLength(5)
  })

  test('a ticket whose criteria list is indented under its heading still reads', () => {
    const raw = markdown({ criteriaBlock: CRITERIA.map((c) => `    - ${c}`).join('\n') })
    expect(lintOk(raw).acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
  })

  test('a sample indented four columns RELATIVE to the body is still ignored', () => {
    // The whole body sits at 4; the sample sits at 8. Dedenting by the common 4
    // leaves the sample at 4 — content, not markup — so it declares no section.
    const raw = indentBody(
      markdown({ context: ['The template reads:', '', '    **Goal**'].join('\n') }),
      '    ',
    )
    const body = lintOk(raw)
    expect(body.goal).toBe('Freeze the ticket format once.')
    expect(body.context).toContain('**Goal**')
  })

  test('dedenting never invents a section a body does not have', () => {
    const raw = indentBody(markdown({ omit: '**Scope**' }), '      ')
    expect(lintKo(raw).map((p) => p.code)).toEqual(['section_missing'])
  })

  test('the dedent is common to the body: a single indented line moves nothing', () => {
    const body = lintOk(markdown({ context: 'At the margin.\n\n    A quoted line.' }))
    expect(body.context).toContain('    A quoted line.')
    expect(body.goal).toBe('Freeze the ticket format once.')
  })

  test('a line whose indent mixes spaces and a tab keeps every character of content', () => {
    // Consuming whitespace, rather than slicing a count off the front, is what
    // makes it impossible to eat the first character of a line like this one.
    const content = 'IMPORTANT: never drop this line.'
    const body = lintOk(
      indentBody(markdown({ context: `At the margin.\n\n  \t${content}` }), '    '),
    )
    expect(body.context).toContain(content)
    expect(body.context).toContain(`\t${content}`)
  })

  test('a leading non-breaking space is content, and survives the dedent whole', () => {
    // It is not markdown indentation, so it neither counts as indent nor gets
    // trimmed away with it.
    const content = ' a line opening on a non-breaking space'
    const body = lintOk(indentBody(markdown({ context: `At the margin.\n\n${content}` }), '    '))
    expect(body.context).toContain(content)
  })

  test('a tab that clears the margin survives it whole', () => {
    // The body sits at 3, this line's leading whitespace is three spaces and
    // then a tab: the margin is taken out of the spaces and the tab is left
    // exactly as it was typed.
    const raw = indentBody(markdown({ context: 'At the margin.\n\nPLACEHOLDER' }), '   ').replace(
      '   PLACEHOLDER',
      '   \tA tabbed line.',
    )
    expect(lintOk(raw).context).toContain('\tA tabbed line.')
  })

  test('a tab straddling the margin resolves to the columns it still owed', () => {
    // The body sits at 2 and this line opens on a bare tab reaching column 4:
    // the margin runs through the middle of it. It becomes the two columns it
    // owed past the margin, in spaces — how CommonMark resolves a partially
    // consumed tab, and the ONE place this contract rewrites one.
    const raw = indentBody(markdown({ context: 'At the margin.\n\nPLACEHOLDER' }), '  ').replace(
      '  PLACEHOLDER',
      '\tA tabbed line.',
    )
    expect(lintOk(raw).context).toContain('  A tabbed line.')
    expect(lintOk(raw).context).not.toContain('\tA tabbed line.')
  })

  test('a blank line shorter than the margin degrades to empty, never to a negative', () => {
    const raw = indentBody(markdown({ context: 'Before.\n\nAfter.' }), '        ').replace(
      '\n\n',
      '\n  \n',
    )
    expect(() => lintTicketBody(raw)).not.toThrow()
    expect(lintOk(raw).context).toBe('Before.\n\nAfter.')
  })

  test('rounding the dedent down to a tab stop costs at most the tolerance', () => {
    // Five columns of common indent dedent by four; the headings land at one,
    // inside the three columns the "content, not markup" rule allows.
    for (const indent of ['     ', '\t ', ' \t ', '\t\t\t']) {
      expect(lintOk(indentBody(markdown(), indent)).goal).toBe('Freeze the ticket format once.')
    }
  })

  test('a blank line is dedented with its neighbours, not left standing', () => {
    // A whitespace-only line inside a fenced sample belongs to that sample:
    // leaving it at six columns while every line around it loses four would
    // store a sample the author never wrote.
    const sample = ['```', 'first', '      ', 'last', '```'].join('\n')
    const body = lintOk(indentBody(markdown({ context: `The sample:\n\n${sample}` }), '    '))
    expect(body.context).toContain('\n  \n')
    expect(body.context).not.toContain('\n      \n')
  })
})

// --- The column invariant, by brute force ------------------------------------

/**
 * The CommonMark tab stop, spelled out here so this test states its own rule
 * rather than borrowing the one it is meant to check.
 */
const column = (prefix: string): number => {
  let at = 0
  for (const character of prefix) {
    if (character === ' ') {
      at += 1
    } else if (character === '\t') {
      at += 4 - (at % 4)
    } else {
      break
    }
  }
  return at
}

/** Every whitespace prefix of at most `max` characters. */
function whitespacePrefixes(max: number): string[] {
  const out: string[] = []
  const walk = (prefix: string): void => {
    out.push(prefix)
    if (prefix.length < max) {
      walk(`${prefix} `)
      walk(`${prefix}\t`)
    }
  }
  walk('')
  return out
}

const CRIT4 = manyCriteria(4)

/** A five-section body at `bodyIndent`, whose four criteria carry their own. */
const indentedBody = (bodyIndent: string, itemIndents: readonly string[]): string =>
  [
    `${bodyIndent}**Context**`,
    '',
    `${bodyIndent}A context.`,
    '',
    `${bodyIndent}**Goal**`,
    '',
    `${bodyIndent}A goal.`,
    '',
    `${bodyIndent}**Scope**`,
    '',
    `${bodyIndent}A scope.`,
    '',
    `${bodyIndent}${ACCEPTANCE_CRITERIA_HEADING}`,
    '',
    ...itemIndents.map((indent, i) => `${indent}- ${CRIT4[i]}`),
    '',
    `${bodyIndent}**Out of scope**`,
    '',
    `${bodyIndent}Nothing.`,
  ].join('\n')

describe('indentation — two spellings of one column are one indentation', () => {
  test('every whitespace prefix reaching a column reads identically, at every base', () => {
    // Exhaustive: all 63 whitespace prefixes of up to five characters, against
    // all 15 body indents of up to three. Within a column class the list is
    // written twice — once spelled uniformly, once alternating two spellings of
    // the same column — and the two must be the SAME body. This is the column
    // invariant `indentOf(dropIndent(l, base)) === indentOf(l) - base` seen from
    // the only place it matters: what the lint answers.
    let compared = 0
    for (const bodyIndent of whitespacePrefixes(3)) {
      const byColumn = new Map<number, string[]>()
      for (const prefix of whitespacePrefixes(5)) {
        const full = `${bodyIndent}${prefix}`
        byColumn.set(column(full), [...(byColumn.get(column(full)) ?? []), full])
      }
      for (const spellings of byColumn.values()) {
        const first = spellings[0] as string
        const uniform = lintTicketBody(indentedBody(bodyIndent, [first, first, first, first]))
        for (const spelling of spellings.slice(1)) {
          const mixed = lintTicketBody(indentedBody(bodyIndent, [first, spelling, first, spelling]))
          expect(mixed).toEqual(uniform)
          compared += 1
        }
      }
    }
    expect(compared).toBeGreaterThan(200)
  })

  /** Verdict, ids and every announced number — everything a shift must not move. */
  const fingerprint = (raw: string): string => {
    const result = lintTicketBody(raw)
    if (!result.ok) {
      return `ko | ${result.problems.map((p) => `${p.code}:${p.message}`).join(' | ')}`
    }
    const { context, goal, scope, out_of_scope, acceptance_criteria } = result.body
    return `ok | ids=${acceptance_criteria.map((c) => c.id).join(',')} | len=${[
      context,
      goal,
      scope,
      out_of_scope,
    ]
      .map((section) => points(section))
      .join('/')}`
  }

  /** Every margin a body can be written at, across all four residues. */
  const MARGINS = [
    '',
    ' ',
    '  ',
    '   ',
    '    ',
    '     ',
    '      ',
    '       ',
    '        ',
    '\t',
    '\t ',
    '\t  ',
    '\t   ',
    '\t\t',
    ' \t',
    '  \t',
    '   \t',
  ]

  test('shifting a whole body sideways changes nothing it answers', () => {
    // The property the whole family of indentation defects reduces to: a body
    // and the same body written at another margin are the same ticket. Verdict,
    // criterion ids and every announced length must be identical — a margin is
    // not something the author expressed. Before the thresholds and the section
    // text were taken relative to the body's own margin, this swept 9 changed
    // verdicts out of 136; it is the test that closes the family rather than
    // one more case in it.
    const corpus: [string, string][] = [
      ['plain', markdown()],
      ['fence quoting a heading', fencedContext('```')],
      ['sample indented four relative', markdown({ context: 'Shown:\n\n    **Goal**' })],
      ['heading at relative three', markdown().replace('**Goal**', '   **Goal**')],
      [
        'nested sub-bullet',
        markdown({
          criteriaBlock: `- ${CRITERIA[0]}\n  - a detail\n- ${CRITERIA[1]}\n- ${CRITERIA[2]}`,
        }),
      ],
      ['makefile sample', markdown({ context: `The recipe:\n\n${MAKEFILE}` })],
      [
        'long context',
        markdown({ context: Array.from({ length: 69 }, () => 'y'.repeat(55)).join('\n') }),
      ],
      ['refused body', markdown({ omit: '**Scope**' })],
    ]
    let checked = 0
    for (const [label, raw] of corpus) {
      const reference = fingerprint(raw)
      for (const margin of MARGINS) {
        expect(`${label} @${JSON.stringify(margin)}: ${fingerprint(indentBody(raw, margin))}`).toBe(
          `${label} @${JSON.stringify(margin)}: ${reference}`,
        )
        checked += 1
      }
    }
    expect(checked).toBe(corpus.length * MARGINS.length)
  })

  test('a fence hiding a heading keeps hiding it at every margin', () => {
    // The margin's residue used to push the fence MARKER past the tolerance
    // without pushing the heading it hid: the fence was lost, the quoted
    // `**Out of scope**` became a real section, and a body missing that section
    // was answered `ok` — the first false `ok` this parser ever gave.
    const quoted = [
      '**Context**',
      '',
      ' ```',
      ' **Out of scope**',
      ' anything not listed above',
      ' ```',
      '',
      '**Goal**',
      '',
      'A goal.',
      '',
      '**Scope**',
      '',
      'A scope.',
      '',
      ACCEPTANCE_CRITERIA_HEADING,
      '',
      bullets(CRITERIA),
    ].join('\n')
    for (const margin of MARGINS) {
      const problems = lintKo(indentBody(quoted, margin))
      expect(
        problems.some((p) => p.code === 'section_missing' && p.section === '**Out of scope**'),
      ).toBe(true)
    }
  })

  test('a heading at relative three is read at every margin, residue three included', () => {
    for (const margin of MARGINS) {
      const raw = indentBody(markdown().replace('**Goal**', '   **Goal**'), margin)
      expect(lintOk(raw).goal).toBe('Freeze the ticket format once.')
    }
  })

  test('the length announced is the author own, at every margin', () => {
    // 69 lines of 55 characters: 3 863 the author can count. The margin used to
    // be counted with them — 69 extra columns per residue — and a section under
    // the bound was refused with a number found nowhere in its text.
    const context = Array.from({ length: 69 }, () => 'y'.repeat(55)).join('\n')
    for (const margin of MARGINS) {
      const body = lintOk(indentBody(markdown({ context }), margin))
      expect(points(body.context)).toBe(points(context))
      expect(body.context).toBe(context)
    }
  })

  test('a section over the bound announces the same number at every margin', () => {
    const context = tabbedSection(41)
    const expected = `is ${points(context)} characters long`
    for (const margin of MARGINS) {
      const tooLong = lintKo(indentBody(markdown({ context }), margin)).find(
        (p) => p.code === 'section_too_long',
      )
      expect(tooLong?.message).toContain(expected)
    }
  })

  test('four criteria written at one column stay four criteria, however spelled', () => {
    // The reported loss, verbatim: a body indented two columns, a list written
    // at column four, its items spelled both ways. With an unaligned dedent a
    // surviving tab re-anchored at column 0 and re-expanded, the two spellings
    // drifted apart, and half the list was folded into its neighbours — while
    // the fused text stayed EARS-conforming and the verdict stayed `ok`.
    for (const spelling of ['    ', '\t', '  \t', '   \t', ' \t']) {
      expect(column(spelling)).toBe(4)
      const body = lintOk(indentedBody('  ', ['    ', spelling, '    ', spelling]))
      expect(body.acceptance_criteria.map((c) => c.text)).toEqual(CRIT4)
      expect(new Set(body.acceptance_criteria.map((c) => c.id)).size).toBe(4)
    }
  })

  test('two bodies whose headings reach one column get one verdict', () => {
    for (const indent of ['    ', '\t', '  \t', '   \t', ' \t']) {
      const body = lintOk(
        indentedBody(
          indent,
          Array.from({ length: 4 }, () => `${indent}  `),
        ),
      )
      expect(body.goal).toBe('A goal.')
      expect(body.acceptance_criteria).toHaveLength(4)
    }
  })
})

// --- What the author wrote is what comes back -------------------------------

describe('lintTicketBody — the body it returns is the text the author wrote', () => {
  test('a fenced sample keeps its tabs, byte for byte', () => {
    // A Makefile recipe MUST begin with a tab; four spaces is a broken file.
    const body = lintOk(markdown({ context: `The recipe:\n\n${MAKEFILE}` }))
    expect(body.context).toContain('\tcc -o x x.c')
    expect(body.context).not.toContain('    cc -o x x.c')
  })

  test('a fenced sample keeps its tabs through a dedent too', () => {
    const body = lintOk(indentBody(markdown({ context: `The recipe:\n\n${MAKEFILE}` }), '    '))
    expect(body.context).toContain('\tcc -o x x.c')
  })

  test('two samples indented differently stay two different samples', () => {
    const tabbed = lintOk(markdown({ context: pythonSample('\t') })).context
    const spaced = lintOk(markdown({ context: pythonSample('    ') })).context
    expect(tabbed).toContain('\treturn 1')
    expect(tabbed).not.toBe(spaced)
  })

  test('a section bound counts characters, not the columns a tab occupies', () => {
    // Each line is 100 characters the author can count and 103 columns nobody
    // can. Counted in columns this section is over the bound; it is not.
    const context = tabbedSection(39)
    expect(points(context)).toBeLessThan(TICKET_SECTION_MAX)
    expect(lintOk(markdown({ context })).context).toBe(context)
  })

  test('a refusal announces the length the author can count', () => {
    const context = tabbedSection(41)
    expect(points(context)).toBeGreaterThan(TICKET_SECTION_MAX)
    const tooLong = lintKo(markdown({ context })).find((p) => p.code === 'section_too_long')
    expect(tooLong?.message).toContain(`is ${points(context)} characters long`)
  })
})

// --- Fenced code blocks -----------------------------------------------------

describe('lintTicketBody — a fenced block is code being shown, not markup', () => {
  test('a heading quoted inside a backtick fence is neither a heading nor a duplicate', () => {
    const body = lintOk(fencedContext('```'))
    expect(body.context).toContain('**Goal**')
    expect(body.context).toContain('That is all.')
    // The real section is the one outside the fence.
    expect(body.goal).toBe('Freeze the ticket format once.')
  })

  test('a tilde fence is honoured the same way', () => {
    expect(lintOk(fencedContext('~~~')).goal).toBe('Freeze the ticket format once.')
  })

  test('a longer closing fence closes, a shorter one does not', () => {
    const body = lintOk(
      markdown({
        context: [
          'Shown:',
          '',
          '````',
          '**Goal**',
          '```',
          'still inside',
          '````',
          '',
          'Done.',
        ].join('\n'),
      }),
    )
    expect(body.context).toContain('still inside')
    expect(body.goal).toBe('Freeze the ticket format once.')
  })

  test('an inline code span never opens a fence', () => {
    const body = lintOk(markdown({ context: 'Call `lintTicketBody(raw)` at admission.' }))
    expect(body.context).toContain('`lintTicketBody(raw)`')
  })

  test('an unterminated fence swallows the rest, and the sections are reported missing', () => {
    const problems = lintKo(markdown({ context: 'Shown:\n\n```\nnever closed' }))
    expect(problems.filter((p) => p.code === 'section_missing').map((p) => p.section)).toEqual([
      '**Goal**',
      '**Scope**',
      ACCEPTANCE_CRITERIA_HEADING,
      '**Out of scope**',
    ])
  })

  test('a fenced block inside the criteria section is named once, and yields no criterion', () => {
    const raw = markdown({
      criteriaBlock: [
        bullets(CRITERIA),
        '',
        '```ts',
        '- not a criterion',
        'lintTicketBody(raw)',
        '```',
      ].join('\n'),
    })
    const problems = lintKo(raw)
    const stray = problems.filter((p) => p.code === 'criteria_not_a_list')
    expect(stray).toHaveLength(1)
    expect(stray[0]?.message).toContain('```ts')
    for (const p of problems) {
      expect(p.criterion ?? '').not.toContain('not a criterion')
    }
  })

  test('a fenced sample indented under a bullet is named, not folded into the criterion', () => {
    // The criteria section is a LIST, so a fenced sample is never part of a
    // criterion whatever column it sits at — folding it in would change that
    // criterion's text, and with it the id a verdict is keyed on. This is the
    // one place the 0-3 rule does not apply, and `ANY_INDENT` says so.
    const raw = markdown({
      criteriaBlock: [
        `- ${CRITERIA[0]}`,
        '    ```ts',
        '    lintCriteria(raw)',
        '    ```',
        `- ${CRITERIA[1]}`,
        `- ${CRITERIA[2]}`,
      ].join('\n'),
    })
    const problems = lintKo(raw)
    expect(problems.map((p) => p.code)).toEqual(['criteria_not_a_list'])
    expect(problems[0]?.message).toContain('```ts')
    for (const p of problems) {
      expect(p.criterion ?? '').not.toContain('lintCriteria')
    }
  })

  test('a fence closes on a LONGER delimiter, not only on an equal one', () => {
    const body = lintOk(
      markdown({ context: ['Shown:', '', '```', '**Goal**', '````', '', 'Done.'].join('\n') }),
    )
    expect(body.context).toContain('Done.')
    expect(body.goal).toBe('Freeze the ticket format once.')
  })
})

// --- Indented code blocks are content, not markup ---------------------------

describe('lintTicketBody — four spaces of indent is a code block, not a marker', () => {
  test('a fence indented by four spaces opens nothing', () => {
    // Read as a fence, this block would never close and would swallow every
    // heading after it — a conforming ticket refused for four missing sections.
    const body = lintOk(
      markdown({
        context: ['Shown:', '', '    ```json', '    { "a": 1 }', '', 'Done.'].join('\n'),
      }),
    )
    expect(body.goal).toBe('Freeze the ticket format once.')
    expect(body.context).toContain('```json')
  })

  test('a fence indented by three spaces still opens one', () => {
    const body = lintOk(
      markdown({
        context: ['Shown:', '', '   ```', '   **Goal**', '   ```', '', 'Done.'].join('\n'),
      }),
    )
    expect(body.goal).toBe('Freeze the ticket format once.')
    expect(body.context).toContain('**Goal**')
  })

  test('a CLOSING fence indented up to three columns closes; at four it does not', () => {
    // CommonMark 0.31.2 § 4.5: the closing fence may be indented up to three
    // spaces. At four it is content, so the block stays open and swallows every
    // heading after it — which is what the refusal must then name. Reading it as
    // a closer instead would end the sample early and let the `**Goal**` it
    // quotes declare a section the author never wrote.
    for (const closer of ['```', ' ```', '  ```', '   ```']) {
      const body = lintOk(
        markdown({ context: ['sample:', '', '```md', '**Goal**', closer, '', 'Done.'].join('\n') }),
      )
      expect(body.goal).toBe('Freeze the ticket format once.')
      expect(body.context).toContain('Done.')
    }
    const problems = lintKo(
      markdown({ context: ['sample:', '', '```md', '**Goal**', '    ```'].join('\n') }),
    )
    expect(problems.filter((p) => p.code === 'section_missing').map((p) => p.section)).toEqual([
      '**Goal**',
      '**Scope**',
      ACCEPTANCE_CRITERIA_HEADING,
      '**Out of scope**',
    ])
  })

  test('the closing-fence tolerance is relative to the body margin too', () => {
    for (const margin of ['', '  ', '    ', '\t']) {
      const raw = indentBody(
        markdown({ context: ['sample:', '', '```md', '**Goal**', '    ```'].join('\n') }),
        margin,
      )
      expect(lintKo(raw).filter((p) => p.code === 'section_missing')).toHaveLength(4)
    }
  })

  test('a heading quoted inside an indented block declares no section', () => {
    const problems = lintKo(
      markdown({
        omit: '**Goal**',
        context: ['The template reads:', '', '    **Goal**', '', 'Done.'].join('\n'),
      }),
    )
    // The only **Goal** left in the body is the indented, quoted one: it is
    // content, so the section is reported missing rather than conjured up.
    expect(problems.some((p) => p.code === 'section_missing' && p.section === '**Goal**')).toBe(
      true,
    )
    expect(problems.some((p) => p.code === 'section_duplicated')).toBe(false)
  })

  test('the indented block does not become a duplicate of a real section', () => {
    const body = lintOk(
      markdown({ context: ['The template reads:', '', '    **Goal**'].join('\n') }),
    )
    expect(body.goal).toBe('Freeze the ticket format once.')
    expect(body.context).toContain('**Goal**')
  })
})

// --- The bounds, from both sides --------------------------------------------

describe('lintTicketBody — the bounds, on both sides of the line', () => {
  test(`exactly ${TICKET_CRITERIA_MIN} criteria is accepted, one fewer is refused`, () => {
    const exact = manyCriteria(TICKET_CRITERIA_MIN)
    expect(lintOk(markdown({ criteria: exact })).acceptance_criteria).toHaveLength(
      TICKET_CRITERIA_MIN,
    )
    const under = manyCriteria(TICKET_CRITERIA_MIN - 1)
    expect(lintKo(markdown({ criteria: under })).map((p) => p.code)).toEqual(['criteria_too_few'])
  })

  test(`exactly ${TICKET_CRITERIA_MAX} criteria is accepted, one more is refused`, () => {
    const exact = manyCriteria(TICKET_CRITERIA_MAX)
    expect(lintOk(markdown({ criteria: exact })).acceptance_criteria).toHaveLength(
      TICKET_CRITERIA_MAX,
    )
    const over = manyCriteria(TICKET_CRITERIA_MAX + 1)
    expect(lintKo(markdown({ criteria: over })).map((p) => p.code)).toEqual(['criteria_too_many'])
  })

  test('a section exactly at the bound is accepted, one code point over is refused', () => {
    const exact = 'x'.repeat(TICKET_SECTION_MAX)
    expect(lintOk(markdown({ context: exact })).context).toHaveLength(TICKET_SECTION_MAX)
    const over = 'x'.repeat(TICKET_SECTION_MAX + 1)
    expect(lintKo(markdown({ context: over })).map((p) => p.code)).toEqual(['section_too_long'])
  })

  test('a criterion exactly at the bound is accepted, one code point over is refused', () => {
    const head = `${EARS_TRIGGER} it is exactly at the bound ${EARS_RESPONSE} `
    const exact = head + 'y'.repeat(TICKET_CRITERION_TEXT_MAX - head.length)
    expect(exact).toHaveLength(TICKET_CRITERION_TEXT_MAX)
    const kept = lintOk(markdown({ criteria: [exact, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
    expect(kept.acceptance_criteria[0]?.text).toBe(exact)

    const over = `${exact}y`
    expect(over).toHaveLength(TICKET_CRITERION_TEXT_MAX + 1)
    expect(
      lintKo(markdown({ criteria: [over, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] })).map(
        (p) => p.code,
      ),
    ).toEqual(['criterion_too_long'])
  })
})

// --- Bounds are counted in CODE POINTS, not UTF-16 code units ---------------

/** Length in code points, spelled out here so the tests state their own unit. */
const points = (text: string): number => [...text].length
/**
 * True when no half of a surrogate pair was left stranded. Under the `u` flag a
 * well-formed pair is ONE code point outside `Cs`, so any `Cs` left is a lone
 * surrogate — the ill-formed string a cut through the middle of a pair leaves.
 */
const wellFormed = (text: string): boolean => !/\p{Cs}/u.test(text)

describe('the published bounds are counted in code points', () => {
  const ROCKET = '🚀'
  const GLOBE = '🌍'

  test('one emoji is one character of a criterion, not two', () => {
    expect(ROCKET).toHaveLength(2)
    expect(points(ROCKET)).toBe(1)
  })

  test('a criterion of exactly the bound in emoji is accepted, not refused as too long', () => {
    const head = `${EARS_TRIGGER} it is written in emoji ${EARS_RESPONSE} `
    const exact = head + ROCKET.repeat(TICKET_CRITERION_TEXT_MAX - points(head))
    expect(points(exact)).toBe(TICKET_CRITERION_TEXT_MAX)
    // …and comfortably over the bound if one counted code units instead.
    expect(exact.length).toBeGreaterThan(TICKET_CRITERION_TEXT_MAX)
    const body = lintOk(markdown({ criteria: [exact, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
    expect(body.acceptance_criteria[0]?.text).toBe(exact)
  })

  test('one emoji over the bound is refused, and the refusal counts in code points', () => {
    const head = `${EARS_TRIGGER} it is written in emoji ${EARS_RESPONSE} `
    const over = head + ROCKET.repeat(TICKET_CRITERION_TEXT_MAX + 1 - points(head))
    const problems = lintKo(markdown({ criteria: [over, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
    expect(problems.map((p) => p.code)).toEqual(['criterion_too_long'])
    expect(problems[0]?.message).toContain(`is ${TICKET_CRITERION_TEXT_MAX + 1} characters long`)
  })

  test('a section of exactly the bound in emoji is kept whole', () => {
    const exact = ROCKET.repeat(TICKET_SECTION_MAX)
    expect(points(exact)).toBe(TICKET_SECTION_MAX)
    expect(lintOk(markdown({ context: exact })).context).toBe(exact)
    expect(sanitizeTicketBody({ context: exact })?.context).toBe(exact)
  })

  test('a truncated criterion is always well formed, never a stranded surrogate', () => {
    const over = ROCKET.repeat(TICKET_CRITERION_TEXT_MAX + 10)
    const text = normalizeCriterionText(over)
    expect(points(text)).toBe(TICKET_CRITERION_TEXT_MAX)
    expect(wellFormed(text)).toBe(true)
    expect(sanitizeAcceptanceCriterion(over)?.text).toBe(text)
  })

  test('a truncated section is always well formed too', () => {
    const context = sanitizeTicketBody({
      context: ROCKET.repeat(TICKET_SECTION_MAX + 10),
    })?.context
    expect(points(context ?? '')).toBe(TICKET_SECTION_MAX)
    expect(wellFormed(context ?? '')).toBe(true)
  })

  test('two criteria differing only in an astral character keep two ids', () => {
    // Both are exactly at the bound in code points, and one code unit past it.
    // Cut by code units, each would end on a stranded half of a surrogate pair,
    // both would encode through U+FFFD, and the two would collapse onto ONE id.
    const head = `${EARS_TRIGGER} astral ${EARS_RESPONSE} `
    const pad = 'x'.repeat(TICKET_CRITERION_TEXT_MAX - points(head) - 2)
    const a = `${head}${pad}${ROCKET}!`
    const b = `${head}${pad}${GLOBE}!`
    expect(points(a)).toBe(TICKET_CRITERION_TEXT_MAX)
    expect(a.length).toBe(TICKET_CRITERION_TEXT_MAX + 1)
    const criteria = criteriaOk([a, b, CRITERIA[0] ?? ''])
    expect(criteria.map((c) => c.text)).toEqual([a, b, CRITERIA[0] ?? ''])
    expect(new Set(criteria.map((c) => c.id)).size).toBe(3)
    for (const criterion of criteria) {
      expect(wellFormed(criterion.text)).toBe(true)
      expect(criterion.id).toBe(acceptanceCriterionId(criterion.text))
    }
  })
})

// --- Cutting at a bound leaves a value the sanitizer reproduces -------------

describe('a truncated value is one the sanitizer would produce again', () => {
  test('a criterion cut at the bound never keeps a trailing space', () => {
    const head = `${EARS_TRIGGER} words ${EARS_RESPONSE} `
    const filler = 'a'.repeat(TICKET_CRITERION_TEXT_MAX - points(head) - 1)
    // The character sitting exactly ON the bound is a space.
    const raw = `${head}${filler} tail beyond the bound`
    const text = normalizeCriterionText(raw)
    expect(text.endsWith(' ')).toBe(false)
    expect(points(text)).toBe(TICKET_CRITERION_TEXT_MAX - 1)
    // The stored text is what the id was derived from — still true after a cut.
    const criterion = sanitizeAcceptanceCriterion(raw)
    expect(criterion?.text).toBe(text)
    expect(criterion?.id).toBe(acceptanceCriterionId(criterion?.text ?? ''))
    // …and normalizing it again changes nothing: one character, one meaning.
    expect(normalizeCriterionText(text)).toBe(text)
    expect(sanitizeAcceptanceCriterion(criterion)).toEqual(criterion)
  })

  test('a section cut at the bound never keeps trailing whitespace', () => {
    const raw = `${'b'.repeat(TICKET_SECTION_MAX - 1)} tail beyond the bound`
    const context = sanitizeTicketBody({ context: raw })?.context
    expect(context?.endsWith(' ')).toBe(false)
    expect(points(context ?? '')).toBe(TICKET_SECTION_MAX - 1)
    expect(sanitizeTicketBody({ context })?.context).toBe(context)
  })

  test('the sanitizer is idempotent on a body it just truncated', () => {
    const once = sanitizeTicketBody({
      context: `${'b'.repeat(TICKET_SECTION_MAX - 1)} tail`,
      goal: '🚀'.repeat(TICKET_SECTION_MAX + 3),
      acceptance_criteria: [
        `${'a'.repeat(TICKET_CRITERION_TEXT_MAX - 1)} tail`,
        '🚀'.repeat(TICKET_CRITERION_TEXT_MAX + 3),
      ],
    })
    expect(once).not.toBeNull()
    expect(sanitizeTicketBody(JSON.parse(JSON.stringify(once)))).toEqual(once)
    for (const criterion of once?.acceptance_criteria ?? []) {
      expect(criterion.id).toBe(acceptanceCriterionId(criterion.text))
    }
    expect(schemaErrors(once)).toEqual([])
  })
})

// --- Whitespace and markers, in full ----------------------------------------

describe('whitespace and list markers', () => {
  test('a non-breaking space is whitespace, so the same wording keeps one id', () => {
    const plain = `${EARS_TRIGGER} a case happens ${EARS_RESPONSE} react`
    const nbsp = `${EARS_TRIGGER} a\u00a0case happens ${EARS_RESPONSE} react`
    expect(nbsp).not.toBe(plain)
    expect(acceptanceCriterionId(nbsp)).toBe(acceptanceCriterionId(plain))
    // …and the text stored carries the ordinary space, not the exotic one.
    expect(sanitizeAcceptanceCriterion(nbsp)?.text).toBe(plain)
  })

  test('a non-breaking space in the body lands as an ordinary space', () => {
    const nbsp = `${EARS_TRIGGER} a\u00a0case happens ${EARS_RESPONSE} react`
    const body = lintOk(markdown({ criteria: [nbsp, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
    expect(body.acceptance_criteria[0]?.text).toBe(
      `${EARS_TRIGGER} a case happens ${EARS_RESPONSE} react`,
    )
    expect(body.acceptance_criteria[0]?.text).not.toContain('\u00a0')
  })

  test('the + marker is a list item, like - and *', () => {
    const raw = markdown({ criteriaBlock: CRITERIA.map((c) => `+ ${c}`).join('\n') })
    expect(lintOk(raw).acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
  })

  test('every marker the contract accepts reads the same list', () => {
    const markers = ['-', '*', '+']
    const raw = markdown({
      criteriaBlock: CRITERIA.map((c, i) => `${markers[i] ?? '-'} ${c}`).join('\n'),
    })
    expect(lintOk(raw).acceptance_criteria.map((c) => c.text)).toEqual(CRITERIA)
  })
})

// --- Messages stay bounded --------------------------------------------------

describe('problem messages and the reason they build', () => {
  test('the not-EARS message truncates the criterion, like the too-long one does', () => {
    const long = 'z'.repeat(TICKET_CRITERION_TEXT_MAX * 3)
    const problems = lintKo(markdown({ criteria: [long, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
    for (const code of ['criterion_not_ears', 'criterion_too_long'] as const) {
      const found = problems.find((p) => p.code === code)
      expect(found).toBeDefined()
      expect(found?.message).toContain('…')
      expect(found?.message).not.toContain('z'.repeat(TICKET_CRITERION_TEXT_MAX + 1))
      expect((found?.message ?? '').length).toBeLessThan(TICKET_CRITERION_TEXT_MAX + 120)
    }
  })

  test('the formatted reason is bounded, with a visible truncation marker', () => {
    const wordy = Array.from(
      { length: TICKET_CRITERIA_MAX + 1 },
      (_, i) => `criterion number ${i} states nothing a machine could ever check by itself`,
    )
    const reason = formatTicketProblems(lintKo(markdown({ criteria: wordy })))
    expect(reason).toHaveLength(TICKET_PROBLEMS_TEXT_MAX)
    expect(reason.endsWith('…')).toBe(true)
  })

  test('a short reason is left exactly as it reads', () => {
    const reason = formatTicketProblems(lintKo(markdown({ omit: '**Scope**' })))
    expect(reason.length).toBeLessThan(TICKET_PROBLEMS_TEXT_MAX)
    expect(reason.endsWith('…')).toBe(false)
    expect(reason).toBe('missing section **Scope** [section_missing]')
  })

  test('the reason bound is the detail bound a refusal has to fit into', () => {
    // Declared in ticket.ts to keep the module import-free; locked here to the
    // value it mirrors, exactly as reasons.ts does with the event bound.
    expect(TICKET_PROBLEMS_TEXT_MAX).toBe(TASK_REASON_DETAIL_MAX)
  })

  test('the EARS rule is built from the exported keywords, not a second copy', () => {
    const built = `${EARS_TRIGGER} the keywords are the definition ${EARS_RESPONSE} accept this`
    const body = lintOk(markdown({ criteria: [built, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] }))
    expect(body.acceptance_criteria[0]?.text).toBe(built)
    for (const half of [
      `${EARS_TRIGGER} something happens the system reacts`,
      `something happens ${EARS_RESPONSE} react`,
    ]) {
      expect(
        lintKo(markdown({ criteria: [half, CRITERIA[1] ?? '', CRITERIA[2] ?? ''] })).some(
          (p) => p.code === 'criterion_not_ears' && p.criterion === half,
        ),
      ).toBe(true)
    }
  })
})

describe('lintTicketBody — determinism', () => {
  test('the same body yields the same problems, in the same order', () => {
    const raw = markdown({
      omit: '**Out of scope**',
      criteria: ['not ears at all', CRITERIA[1] ?? ''],
      goal: '  ',
    })
    const first = lintKo(raw)
    const second = lintKo(raw)
    expect(second).toEqual(first)
    // Sections in canonical order first, then the criteria in list order.
    expect(first.map((p) => p.code)).toEqual([
      'section_empty',
      'section_missing',
      'criteria_too_few',
      'criterion_not_ears',
    ])
  })

  test('the same conforming body yields the same body object', () => {
    const raw = markdown()
    expect(lintOk(raw)).toEqual(lintOk(raw))
  })

  test('problems come out in canonical section order', () => {
    const problems = lintKo('**Scope**\n\nA scope.')
    expect(problems.filter((p) => p.code === 'section_missing').map((p) => p.section)).toEqual([
      '**Context**',
      '**Goal**',
      '**Acceptance criteria**',
      '**Out of scope**',
    ])
  })
})

describe('formatTicketProblems', () => {
  test('keeps every readable message and appends its code, never replacing it', () => {
    const problems = lintKo(markdown({ omit: '**Out of scope**', criteria: CRITERIA.slice(0, 2) }))
    const reason = formatTicketProblems(problems)
    for (const p of problems) {
      expect(reason).toContain(p.message)
      expect(reason).toContain(`[${p.code}]`)
    }
    expect(reason).toContain('**Out of scope**')
    expect(reason).toContain(String(TICKET_CRITERIA_MIN))
  })

  test('an empty list formats to an empty reason', () => {
    expect(formatTicketProblems([])).toBe('')
  })
})

// --- D6: the lint gates the LAUNCH, not the draft ---------------------------

// Stand-in for the CLI admission: the wiring into POST /api/tasks belongs to
// its own ticket, this is the contract that wiring will call.
function admit(raw: unknown): { launched: true } | { launched: false; reason: string } {
  const result = lintTicketBody(raw)
  return result.ok
    ? { launched: true }
    : { launched: false, reason: formatTicketProblems(result.problems) }
}

describe('D6 — the lint applies to the ticket launched, not to the one being written', () => {
  test('a launch with a non-conforming body is refused WITH its reason', () => {
    const refusal = admit(markdown({ criteria: CRITERIA.slice(0, 1) }))
    expect(refusal.launched).toBe(false)
    if (refusal.launched) {
      throw new Error('unreachable')
    }
    expect(refusal.reason).not.toBe('')
    expect(refusal.reason).toContain('acceptance criteria')
    expect(refusal.reason).toContain('[criteria_too_few]')
  })

  test('a draft is never linted implicitly: reading it back refuses nothing', () => {
    // What the browser holds while a human types: two criteria, no EARS, one
    // section still blank. The tolerant read-back path must accept it — only
    // lintTicketBody gates, and only when something is launched.
    const draft = {
      context: 'Half-written.',
      goal: '',
      scope: '',
      acceptance_criteria: ['it should work', 'and be fast'],
      out_of_scope: '',
    }
    const body = sanitizeTicketBody(draft)
    expect(body).not.toBeNull()
    expect(body?.acceptance_criteria).toHaveLength(2)
    expect(extractAcceptanceCriteria(body)).toHaveLength(2)
    // …while the very same draft, launched, is refused.
    expect(lintTicketBody(JSON.stringify(draft)).ok).toBe(false)
  })

  test('the author fixes the body and retries: the second attempt is accepted', () => {
    const refused = admit(markdown({ omit: '**Scope**' }))
    expect(refused.launched).toBe(false)
    expect(admit(markdown()).launched).toBe(true)
  })
})

// --- extractAcceptanceCriteria ---------------------------------------------

describe('extractAcceptanceCriteria', () => {
  test('turns the section into one entry per list item, in body order', () => {
    const criteria = extractAcceptanceCriteria(lintOk(markdown()))
    expect(criteria.map((c) => c.text)).toEqual(CRITERIA)
    for (const criterion of criteria) {
      expect(criterion.id).toBe(acceptanceCriterionId(criterion.text))
    }
  })

  test('returns a fresh array of fresh objects', () => {
    const body = lintOk(markdown())
    const criteria = extractAcceptanceCriteria(body)
    criteria.pop()
    const first = criteria[0]
    if (first) {
      first.text = 'mutated'
    }
    expect(body.acceptance_criteria).toHaveLength(3)
    expect(body.acceptance_criteria[0]?.text).toBe(CRITERIA[0] ?? '')
  })

  test('is tolerant: anything unreadable yields an empty list, never a throw', () => {
    for (const raw of [null, undefined, 42, 'text', [], {}, { acceptance_criteria: 'nope' }]) {
      expect(extractAcceptanceCriteria(raw)).toEqual([])
    }
  })
})

// --- readAcceptanceCriteria: "none" is not "could not read" -----------------

describe('readAcceptanceCriteria', () => {
  test('a body that simply has no criteria answers absent', () => {
    const bodies: unknown[] = [
      sanitizeTicketBody({}),
      { context: 'Half a ticket.' },
      { acceptance_criteria: [] },
      { acceptance_criteria: null },
      { acceptance_criteria: undefined },
    ]
    for (const body of bodies) {
      const read = readAcceptanceCriteria(body)
      expect(read.status).toBe('absent')
      expect(read.criteria).toEqual([])
      expect(read.dropped).toBe(0)
    }
  })

  test('a body whose criteria cannot be read answers unreadable', () => {
    const bodies: unknown[] = [
      null,
      undefined,
      'a string',
      42,
      ['an', 'array'],
      { acceptance_criteria: 'nope' },
      { acceptance_criteria: 7 },
      { acceptance_criteria: [null, '   ', {}, { text: 42 }] },
    ]
    for (const body of bodies) {
      expect(readAcceptanceCriteria(body).status).toBe('unreadable')
      expect(readAcceptanceCriteria(body).criteria).toEqual([])
    }
  })

  test('a readable list answers listed, and counts what it had to drop', () => {
    const read = readAcceptanceCriteria({
      acceptance_criteria: [CRITERIA[0] ?? '', ` ${CRITERIA[0] ?? ''} `, 42, CRITERIA[1] ?? ''],
    })
    expect(read.status).toBe('listed')
    expect(read.criteria.map((c) => c.text)).toEqual([CRITERIA[0] ?? '', CRITERIA[1] ?? ''])
    // One duplicate collapsed, one entry unreadable: the degradation is stated,
    // not swallowed (invariant n° 2).
    expect(read.dropped).toBe(2)
  })

  test('the two failures are told apart, which is the whole point', () => {
    // A gate reading `[]` from both could not tell "this ticket has no criteria"
    // — which an agent may be asked to draft — from "these criteria are
    // corrupt", which must never pass as satisfied.
    expect(readAcceptanceCriteria({ acceptance_criteria: [] }).status).toBe('absent')
    expect(readAcceptanceCriteria({ acceptance_criteria: 'nope' }).status).toBe('unreadable')
    expect(extractAcceptanceCriteria({ acceptance_criteria: [] })).toEqual([])
    expect(extractAcceptanceCriteria({ acceptance_criteria: 'nope' })).toEqual([])
  })

  test('extractAcceptanceCriteria is exactly its criteria, on every input', () => {
    const inputs: unknown[] = [
      lintOk(markdown()),
      {},
      { acceptance_criteria: [CRITERIA[0] ?? '', 42] },
      { acceptance_criteria: 'nope' },
      null,
      42,
    ]
    for (const raw of inputs) {
      expect(extractAcceptanceCriteria(raw)).toEqual(readAcceptanceCriteria(raw).criteria)
    }
  })

  test('never throws, whatever it is handed', () => {
    const junk = [null, undefined, 42, true, Symbol('x'), 10n, () => 'x', new Date(), [], {}]
    for (const raw of junk) {
      expect(() => readAcceptanceCriteria(raw)).not.toThrow()
      expect(() => readAcceptanceCriteria({ acceptance_criteria: raw })).not.toThrow()
    }
  })

  test('returns fresh objects a consumer cannot write back through', () => {
    const body = lintOk(markdown())
    const read = readAcceptanceCriteria(body)
    read.criteria.pop()
    const first = read.criteria[0]
    if (first) {
      first.text = 'mutated'
    }
    expect(body.acceptance_criteria).toHaveLength(3)
    expect(body.acceptance_criteria[0]?.text).toBe(CRITERIA[0] ?? '')
  })
})

// --- lintCriteria: the same rules, on a bare list ---------------------------

describe('lintCriteria', () => {
  test('accepts a conforming list and returns it structured', () => {
    const criteria = criteriaOk(CRITERIA)
    expect(criteria.map((c) => c.text)).toEqual(CRITERIA)
    for (const criterion of criteria) {
      expect(criterion.id).toBe(acceptanceCriterionId(criterion.text))
      expect(isAcceptanceCriterionId(criterion.id)).toBe(true)
    }
  })

  test('accepts the structured form and bare strings alike', () => {
    expect(criteriaOk(CRITERIA.map((text) => ({ text })))).toEqual(criteriaOk(CRITERIA))
    // An id on the way in is a claim, not a fact: it is recomputed.
    expect(criteriaOk(CRITERIA.map((text) => ({ id: 'C1', text })))).toEqual(criteriaOk(CRITERIA))
  })

  test('fewer than the minimum is refused, naming the minimum', () => {
    const problems = criteriaKo(CRITERIA.slice(0, 2))
    expect(problems.map((p) => p.code)).toEqual(['criteria_too_few'])
    expect(problems[0]?.message).toContain(String(TICKET_CRITERIA_MIN))
    expect(problems[0]?.section).toBe(ACCEPTANCE_CRITERIA_HEADING)
  })

  test('a criterion outside EARS is refused, naming the criterion', () => {
    const offender = 'the criteria are revised'
    const problems = criteriaKo([offender, CRITERIA[1] ?? '', CRITERIA[2] ?? ''])
    const notEars = problems.find((p) => p.code === 'criterion_not_ears')
    expect(notEars?.criterion).toBe(offender)
    expect(notEars?.message).toContain(offender)
  })

  test('a duplicate is refused, naming it', () => {
    const problems = criteriaKo([...CRITERIA, ` ${CRITERIA[0] ?? ''} `])
    expect(problems.find((p) => p.code === 'criteria_duplicated')?.criterion).toBe(
      CRITERIA[0] ?? '',
    )
  })

  test(`exactly ${TICKET_CRITERIA_MAX} is accepted, one more is refused`, () => {
    expect(criteriaOk(manyCriteria(TICKET_CRITERIA_MAX))).toHaveLength(TICKET_CRITERIA_MAX)
    expect(criteriaKo(manyCriteria(TICKET_CRITERIA_MAX + 1)).map((p) => p.code)).toEqual([
      'criteria_too_many',
    ])
  })

  test('a criterion exactly at the text bound is accepted, one over is refused', () => {
    const head = `${EARS_TRIGGER} it is exactly at the bound ${EARS_RESPONSE} `
    const exact = head + 'y'.repeat(TICKET_CRITERION_TEXT_MAX - head.length)
    expect(criteriaOk([exact, CRITERIA[1] ?? '', CRITERIA[2] ?? ''])[0]?.text).toBe(exact)
    expect(
      criteriaKo([`${exact}y`, CRITERIA[1] ?? '', CRITERIA[2] ?? '']).map((p) => p.code),
    ).toEqual(['criterion_too_long'])
  })

  test('anything that is not a list is refused with its own code, never a throw', () => {
    for (const raw of [null, undefined, 42, 'a string', {}, true, Symbol('x')]) {
      expect(() => lintCriteria(raw)).not.toThrow()
      const problems = criteriaKo(raw)
      expect(problems).toHaveLength(1)
      expect(problems[0]?.code).toBe('criteria_not_a_list')
      expect(problems[0]?.section).toBe(ACCEPTANCE_CRITERIA_HEADING)
      expect(problems[0]?.message).toContain('must be a list')
    }
    // …and the refusal says what arrived instead, in words.
    expect(criteriaKo(null)[0]?.message).toContain('null')
    expect(criteriaKo(undefined)[0]?.message).toContain('nothing')
    expect(criteriaKo('a string')[0]?.message).toContain('a string')
  })

  test('an empty list is refused as too few, never as an empty success', () => {
    expect(criteriaKo([]).map((p) => p.code)).toEqual(['criteria_too_few'])
  })

  test('an unreadable entry is REFUSED by name and position, never filtered out', () => {
    // Three good criteria plus two unreadable entries: filtering the two away
    // would let this pass as a conforming list of three — a verdict on a list
    // the caller never submitted.
    const problems = criteriaKo([CRITERIA[0] ?? '', 42, CRITERIA[1] ?? '', null, CRITERIA[2] ?? ''])
    expect(problems.map((p) => p.code)).toEqual(['criteria_not_a_list', 'criteria_not_a_list'])
    expect(problems[0]?.message).toContain('acceptance criterion 2')
    expect(problems[0]?.message).toContain('a number')
    expect(problems[1]?.message).toContain('acceptance criterion 4')
    expect(problems[1]?.message).toContain('null')
  })

  test('every unreadable shape is named for what it is', () => {
    const cases: [unknown, string][] = [
      [null, 'null'],
      [undefined, 'nothing'],
      [42, 'a number'],
      ['   ', 'a string'],
      [{ text: 42 }, 'an object'],
      [[], 'an array'],
      [true, 'a boolean'],
    ]
    for (const [entry, named] of cases) {
      const problems = criteriaKo([...CRITERIA, entry])
      expect(problems[0]?.code).toBe('criteria_not_a_list')
      expect(problems[0]?.message).toContain(named)
    }
  })

  test('the count rule sees only what was actually readable', () => {
    const problems = criteriaKo([CRITERIA[0] ?? '', null, null])
    expect(problems.map((p) => p.code)).toEqual([
      'criteria_not_a_list',
      'criteria_not_a_list',
      'criteria_too_few',
    ])
    expect(problems.at(-1)?.message).toContain('1 acceptance criteria found')
  })

  test('the refusal renders as the same readable reason a launch gets', () => {
    const reason = formatTicketProblems(criteriaKo(CRITERIA.slice(0, 1)))
    expect(reason).toContain('acceptance criteria')
    expect(reason).toContain('[criteria_too_few]')
  })

  test('a bare list and the same list inside a body get the very same verdict', () => {
    const lists: string[][] = [
      CRITERIA,
      CRITERIA.slice(0, 2),
      ['not ears at all', CRITERIA[1] ?? '', CRITERIA[2] ?? ''],
      [...CRITERIA, CRITERIA[0] ?? ''],
      manyCriteria(TICKET_CRITERIA_MAX + 1),
    ]
    for (const list of lists) {
      const fromBody = lintTicketBody(markdown({ criteria: list }))
      const fromList = lintCriteria(list)
      expect(fromList.ok).toBe(fromBody.ok)
      if (fromList.ok && fromBody.ok) {
        expect(fromList.criteria).toEqual(fromBody.body.acceptance_criteria)
      } else if (!fromList.ok && !fromBody.ok) {
        expect(fromList.problems).toEqual(fromBody.problems)
      }
    }
  })

  test('is deterministic, like the body lint', () => {
    const list = ['not ears', CRITERIA[1] ?? '']
    expect(lintCriteria(list)).toEqual(lintCriteria(list))
  })
})

// --- sanitizeTicketBody -----------------------------------------------------

describe('sanitizeTicketBody', () => {
  test('rejects a non-object cleanly, without throwing', () => {
    for (const raw of [null, undefined, 'a string', ['an', 'array'], 42, true, Symbol('x')]) {
      expect(() => sanitizeTicketBody(raw)).not.toThrow()
      expect(sanitizeTicketBody(raw)).toBeNull()
    }
  })

  test('drops unknown fields and fills missing sections honestly', () => {
    const body = sanitizeTicketBody({ context: 'Ctx', surprise: 'dropped', version: 99 })
    expect(body).toEqual({
      version: 1,
      context: 'Ctx',
      goal: '',
      scope: '',
      acceptance_criteria: [],
      out_of_scope: '',
    })
  })

  test('never throws on arbitrary values in every field', () => {
    const junk = [null, undefined, 42, true, {}, [], () => 'x', Symbol('s'), 10n, new Date()]
    for (const value of junk) {
      const raw: Record<string, unknown> = {}
      for (const section of TICKET_SECTIONS) {
        raw[section.key] = value
      }
      expect(() => sanitizeTicketBody(raw)).not.toThrow()
      const body = sanitizeTicketBody(raw)
      expect(body?.context).toBe('')
      expect(body?.acceptance_criteria).toEqual([])
    }
  })

  test('a section exactly at the bound is kept intact', () => {
    const exact = 'x'.repeat(TICKET_SECTION_MAX)
    expect(sanitizeTicketBody({ context: exact })?.context).toBe(exact)
  })

  test('a section one code point over the bound is truncated to the bound', () => {
    const over = 'x'.repeat(TICKET_SECTION_MAX + 1)
    const context = sanitizeTicketBody({ context: over })?.context
    expect(context).toHaveLength(TICKET_SECTION_MAX)
    expect(context).toBe('x'.repeat(TICKET_SECTION_MAX))
  })

  test('a criterion exactly at the bound is kept, one over is truncated', () => {
    const exact = 'y'.repeat(TICKET_CRITERION_TEXT_MAX)
    const over = 'y'.repeat(TICKET_CRITERION_TEXT_MAX + 1)
    const body = sanitizeTicketBody({ acceptance_criteria: [exact, over] })
    expect(body?.acceptance_criteria[0]?.text).toBe(exact)
    // Truncated to the same text as the first, hence the same id: the
    // deduplication that follows is the honest consequence, not a loss.
    expect(body?.acceptance_criteria).toHaveLength(1)
    expect(
      sanitizeTicketBody({ acceptance_criteria: [over] })?.acceptance_criteria[0]?.text,
    ).toHaveLength(TICKET_CRITERION_TEXT_MAX)
  })

  test('exactly the maximum number of criteria is kept', () => {
    const exact = Array.from(
      { length: TICKET_CRITERIA_MAX },
      (_, i) => `WHEN case ${i} happens THE SYSTEM SHALL react`,
    )
    expect(sanitizeTicketBody({ acceptance_criteria: exact })?.acceptance_criteria).toHaveLength(
      TICKET_CRITERIA_MAX,
    )
  })

  test('one criterion over the maximum drops the extra, without throwing', () => {
    const over = Array.from(
      { length: TICKET_CRITERIA_MAX + 1 },
      (_, i) => `WHEN case ${i} happens THE SYSTEM SHALL react`,
    )
    const criteria = sanitizeTicketBody({ acceptance_criteria: over })?.acceptance_criteria
    expect(criteria).toHaveLength(TICKET_CRITERIA_MAX)
    expect(criteria?.at(-1)?.text).toContain(`case ${TICKET_CRITERIA_MAX - 1} `)
  })

  test('a lying id is recomputed from the text it claims to name', () => {
    const text = CRITERIA[0] ?? ''
    const body = sanitizeTicketBody({ acceptance_criteria: [{ id: 'C1', text }] })
    expect(body?.acceptance_criteria[0]?.id).toBe(acceptanceCriterionId(text))
    expect(isAcceptanceCriterionId(body?.acceptance_criteria[0]?.id)).toBe(true)
  })

  test('duplicate criteria collapse onto their first occurrence', () => {
    const body = sanitizeTicketBody({
      acceptance_criteria: [CRITERIA[0] ?? '', ` ${CRITERIA[0] ?? ''} `, CRITERIA[1] ?? ''],
    })
    expect(body?.acceptance_criteria.map((c) => c.text)).toEqual([
      CRITERIA[0] ?? '',
      CRITERIA[1] ?? '',
    ])
  })

  test('does not enforce the lint: a non-EARS, too-short list survives read-back', () => {
    const body = sanitizeTicketBody({ acceptance_criteria: ['it works'] })
    expect(body?.acceptance_criteria.map((c) => c.text)).toEqual(['it works'])
  })

  test('a body from the lint round-trips through the sanitizer unchanged', () => {
    const body = lintOk(markdown())
    expect(sanitizeTicketBody(JSON.parse(JSON.stringify(body)))).toEqual(body)
  })
})

describe('sanitizeAcceptanceCriterion / sanitizeAcceptanceCriteria', () => {
  test('accepts the structured form and a bare string alike', () => {
    const text = CRITERIA[0] ?? ''
    expect(sanitizeAcceptanceCriterion(text)).toEqual(sanitizeAcceptanceCriterion({ text }))
  })

  test('drops what carries no text, never throwing', () => {
    for (const raw of [null, undefined, '', '   ', 42, [], {}, { text: 7 }, Symbol('x')]) {
      expect(() => sanitizeAcceptanceCriterion(raw)).not.toThrow()
      expect(sanitizeAcceptanceCriterion(raw)).toBeNull()
    }
  })

  test('a non-array list is an empty list', () => {
    for (const raw of [null, undefined, 'a', 42, {}]) {
      expect(sanitizeAcceptanceCriteria(raw)).toEqual([])
    }
  })

  test('normalizeCriterionText collapses, trims and truncates', () => {
    expect(normalizeCriterionText('  a \n\t b  ')).toBe('a b')
    expect(normalizeCriterionText('z'.repeat(TICKET_CRITERION_TEXT_MAX + 10))).toHaveLength(
      TICKET_CRITERION_TEXT_MAX,
    )
    expect(normalizeCriterionText(42)).toBe('')
  })
})

// --- The published schema ---------------------------------------------------

describe('ticketBodySchema', () => {
  test('declares a draft 2020-12 schema with its own id in the family', () => {
    expect(ticketBodySchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(ticketBodySchema.$id).toBe('https://codesema.com/schemas/ticket-body.json')
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
    walk(ticketBodySchema)
    const defs = new Set(Object.keys(ticketBodySchema.$defs))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(defs.has(ref.replace('#/$defs/', ''))).toBe(true)
    }
  })

  test('top-level required keys all exist in properties', () => {
    const props = new Set(Object.keys(ticketBodySchema.properties))
    for (const key of ticketBodySchema.required) {
      expect(props.has(key)).toBe(true)
    }
  })

  test('its properties are exactly the body fields the sanitizer produces', () => {
    expect(Object.keys(ticketBodySchema.properties).toSorted()).toEqual(
      Object.keys(sanitizeTicketBody({}) as object).toSorted(),
    )
  })

  test('the bounds it publishes ARE the exported constants', () => {
    expect(ticketBodySchema.$defs.section.maxLength).toBe(TICKET_SECTION_MAX)
    expect(ticketBodySchema.$defs.criterion.properties.text.maxLength).toBe(
      TICKET_CRITERION_TEXT_MAX,
    )
    expect(ticketBodySchema.properties.acceptance_criteria.maxItems).toBe(TICKET_CRITERIA_MAX)
  })

  test('validates exactly what the sanitizer produces', () => {
    const inputs: unknown[] = [
      {},
      lintOk(markdown()),
      { context: 'x'.repeat(TICKET_SECTION_MAX + 50) },
      { acceptance_criteria: Array.from({ length: TICKET_CRITERIA_MAX + 5 }, (_, i) => `c ${i}`) },
      { acceptance_criteria: [{ id: 'C1', text: 'z'.repeat(TICKET_CRITERION_TEXT_MAX + 3) }] },
      { context: 42, goal: null, scope: [], acceptance_criteria: 'nope', out_of_scope: {} },
      { acceptance_criteria: ['dup', 'dup', ' dup '] },
      // Astral: bounds are code points on both sides, or the cross test would
      // be measuring the validator rather than the schema.
      { context: '🚀'.repeat(TICKET_SECTION_MAX + 7) },
      { acceptance_criteria: ['🚀'.repeat(TICKET_CRITERION_TEXT_MAX + 7)] },
      JSON.parse(JSON.stringify(lintOk(markdown({ criteria: CRITERIA.toReversed() })))),
    ]
    for (const raw of inputs) {
      const body = sanitizeTicketBody(raw)
      expect(body).not.toBeNull()
      expect(schemaErrors(body)).toEqual([])
    }
  })

  test('rejects what the sanitizer would never produce', () => {
    const valid = lintOk(markdown())
    const cases: [string, unknown][] = [
      ['unknown property', { ...valid, surprise: true }],
      ['missing section', omitKey(valid, 'out_of_scope')],
      ['wrong version', { ...valid, version: 2 }],
      ['section over the bound', { ...valid, context: 'x'.repeat(TICKET_SECTION_MAX + 1) }],
      ['non-string section', { ...valid, goal: 12 }],
      ['positional id', { ...valid, acceptance_criteria: [{ id: 'C1', text: CRITERIA[0] ?? '' }] }],
      [
        'criterion over the bound',
        {
          ...valid,
          acceptance_criteria: [
            {
              id: acceptanceCriterionId('z'),
              text: 'z'.repeat(TICKET_CRITERION_TEXT_MAX + 1),
            },
          ],
        },
      ],
      [
        'empty criterion text',
        { ...valid, acceptance_criteria: [{ id: acceptanceCriterionId(''), text: '' }] },
      ],
      [
        'unknown criterion field',
        {
          ...valid,
          acceptance_criteria: [{ ...(valid.acceptance_criteria[0] as AcceptanceCriterion), n: 1 }],
        },
      ],
      [
        'duplicate criteria',
        {
          ...valid,
          acceptance_criteria: [
            valid.acceptance_criteria[0] as AcceptanceCriterion,
            valid.acceptance_criteria[0] as AcceptanceCriterion,
          ],
        },
      ],
      [
        'too many criteria',
        {
          ...valid,
          acceptance_criteria: Array.from({ length: TICKET_CRITERIA_MAX + 1 }, (_, i) => ({
            id: acceptanceCriterionId(`c ${i}`),
            text: `c ${i}`,
          })),
        },
      ],
    ]
    const accepted = cases.filter(([, value]) => schemaErrors(value).length === 0)
    expect(accepted.map(([label]) => label)).toEqual([])
  })

  test('uniqueItems is compared by JSON value, key order included', () => {
    // Draft 2020-12 compares instances by value: the same criterion written
    // with its two keys swapped is the SAME item, and the pair is refused.
    const valid = lintOk(markdown())
    const first = valid.acceptance_criteria[0] as AcceptanceCriterion
    const swapped = { text: first.text, id: first.id }
    expect(JSON.stringify(swapped)).not.toBe(JSON.stringify(first))
    expect(schemaErrors({ ...valid, acceptance_criteria: [first, swapped] })).toEqual([
      '$.acceptance_criteria: uniqueItems',
    ])
  })

  test('uniqueItems CANNOT express id uniqueness; the sanitizer is what does', () => {
    const valid = lintOk(markdown())
    const first = valid.acceptance_criteria[0] as AcceptanceCriterion
    // Two entries sharing an id while differing in text. Draft 2020-12 has no
    // "unique by property" keyword and cannot state that `id` is a function of
    // `text`, so the SCHEMA accepts this — a documented limit, not an oversight.
    const shared = {
      ...valid,
      acceptance_criteria: [first, { id: first.id, text: 'a completely different wording' }],
    }
    expect(schemaErrors(shared)).toEqual([])
    // The guarantee a per-criterion verdict needs is made on the producing
    // side: the sanitizer recomputes every id from its text and dedups on it,
    // so what codesema writes never carries two criteria sharing one id.
    const out = sanitizeTicketBody(shared)?.acceptance_criteria ?? []
    expect(out).toHaveLength(2)
    expect(new Set(out.map((c) => c.id)).size).toBe(2)
    expect(out[1]?.id).toBe(acceptanceCriterionId('a completely different wording'))
  })

  test('every list the sanitizer produces has pairwise distinct ids', () => {
    const inputs: unknown[] = [
      { acceptance_criteria: [CRITERIA[0] ?? '', CRITERIA[0] ?? '', ` ${CRITERIA[0] ?? ''}\n`] },
      {
        acceptance_criteria: [
          { id: 'ac-000000000000', text: 'a' },
          { id: 'ac-000000000000', text: 'b' },
        ],
      },
      { acceptance_criteria: manyCriteria(TICKET_CRITERIA_MAX + 5) },
      {
        acceptance_criteria: [
          'x'.repeat(TICKET_CRITERION_TEXT_MAX + 1),
          'x'.repeat(TICKET_CRITERION_TEXT_MAX + 9),
        ],
      },
      lintOk(markdown()),
    ]
    for (const raw of inputs) {
      const criteria = sanitizeTicketBody(raw)?.acceptance_criteria ?? []
      expect(new Set(criteria.map((c) => c.id)).size).toBe(criteria.length)
      expect(schemaErrors(sanitizeTicketBody(raw))).toEqual([])
    }
  })
})

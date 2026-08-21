import { describe, expect, test } from 'bun:test'
import {
  CRITERION_VERDICT_EVIDENCE_MAX,
  detectDiffSecrets,
  groundCriterionVerdicts,
  groundReview,
  parseEvidenceAnchor,
  parseEvidenceAnchors,
  reviewRecordSchema,
  sanitizeFindings,
  sanitizeNarrative,
  sanitizeRecord,
  sanitizeReview,
  TICKET_CRITERIA_MAX,
  type CriterionVerdict,
  type Finding,
  type SanitizedReview,
} from './index.js'

describe('sanitizeReview', () => {
  test('empty input: safe defaults', () => {
    expect(sanitizeReview({})).toEqual({
      verdict: 'comment',
      summary: '',
      findings: [],
      narrative: null,
    })
    expect(sanitizeReview(null)).toEqual({
      verdict: 'comment',
      summary: '',
      findings: [],
      narrative: null,
    })
    expect(sanitizeReview('junk')).toEqual({
      verdict: 'comment',
      summary: '',
      findings: [],
      narrative: null,
    })
  })

  test('valid verdicts kept, unknown ones become comment', () => {
    expect(sanitizeReview({ verdict: 'approve' }).verdict).toBe('approve')
    expect(sanitizeReview({ verdict: 'request_changes' }).verdict).toBe('request_changes')
    expect(sanitizeReview({ verdict: 'LGTM!!' }).verdict).toBe('comment')
  })

  test('summary: trim + truncation to 2000', () => {
    expect(sanitizeReview({ summary: '  ok  ' }).summary).toBe('ok')
    expect(sanitizeReview({ summary: 'x'.repeat(3000) }).summary.length).toBe(2000)
  })

  test('files_reviewed: strings and { path } entries normalized, trimmed, deduped, absent otherwise', () => {
    const r = sanitizeReview({
      files_reviewed: [
        ' a.ts ',
        { path: 'b.ts', status: 'clean' },
        'a.ts',
        { status: 'clean' },
        42,
        '',
      ],
    })
    expect(r.files_reviewed).toEqual([
      { path: 'a.ts', status: 'clean' },
      { path: 'b.ts', status: 'clean' },
    ])
    expect(sanitizeReview({}).files_reviewed).toBeUndefined()
    expect(sanitizeReview({ files_reviewed: 'a.ts' }).files_reviewed).toBeUndefined()
  })

  test('files_reviewed: status recomputed from findings, the declaration is never trusted', () => {
    const r = sanitizeReview({
      findings: [{ file: 'b.ts', message: 'boom', severity: 'major' }],
      files_reviewed: [
        { path: 'a.ts', status: 'findings' },
        { path: 'b.ts', status: 'clean' },
      ],
    })
    expect(r.files_reviewed).toEqual([
      { path: 'a.ts', status: 'clean' },
      { path: 'b.ts', status: 'findings' },
    ])
  })

  test('files_reviewed: a file carrying a finding but missing from the declaration is appended', () => {
    const r = sanitizeReview({
      findings: [{ file: 'c.ts', message: 'boom', severity: 'major' }],
      files_reviewed: ['a.ts'],
    })
    expect(r.files_reviewed).toEqual([
      { path: 'a.ts', status: 'clean' },
      { path: 'c.ts', status: 'findings' },
    ])
  })

  test('files_reviewed: capped at 500 entries', () => {
    const many = sanitizeReview({
      files_reviewed: Array.from({ length: 600 }, (_, i) => `f${i}.ts`),
    })
    expect(many.files_reviewed?.length).toBe(500)
  })
})

describe('sanitizeFindings', () => {
  test('invalid items ignored, file+message required', () => {
    expect(sanitizeFindings('nope')).toEqual([])
    expect(sanitizeFindings([null, 42, { file: 'a.ts' }, { message: 'm' }])).toEqual([])
  })

  test('unknown severity: info, unknown kind: absent', () => {
    const [f] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'blocker', kind: 'typo' },
    ])
    expect(f?.severity).toBe('info')
    expect(f?.kind).toBeUndefined()
  })

  test('invalid line ignored, endLine < line ignored', () => {
    const [f] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'minor', line: -3, endLine: 9 },
    ])
    expect(f?.line).toBeUndefined()
    expect(f?.endLine).toBeUndefined()
    const [g] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'minor', line: 10, endLine: 4 },
    ])
    expect(g?.line).toBe(10)
    expect(g?.endLine).toBeUndefined()
  })

  test('consensus kept only when strictly true', () => {
    const [f] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'minor', consensus: true },
    ])
    expect(f?.consensus).toBe(true)
    const [g] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'minor', consensus: 'yes' },
    ])
    expect(g?.consensus).toBeUndefined()
    const [h] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'minor' }])
    expect(h?.consensus).toBeUndefined()
  })

  test('praise and why findings are forced to info severity', () => {
    const [praise] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'critical', kind: 'praise' },
    ])
    expect(praise?.severity).toBe('info')
    const [why] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'major', kind: 'why' }])
    expect(why?.severity).toBe('info')
    const [bug] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'critical', kind: 'security' },
    ])
    expect(bug?.severity).toBe('critical')
  })

  test('title/suggestion truncated', () => {
    const [f] = sanitizeFindings([
      {
        file: 'a.ts',
        message: 'm',
        severity: 'minor',
        title: 't'.repeat(500),
        suggestion: 's'.repeat(9000),
      },
    ])
    expect(f?.title?.length).toBe(200)
    expect(f?.suggestion?.length).toBe(4000)
  })

  test('file truncated', () => {
    const [f] = sanitizeFindings([{ file: 'f'.repeat(9000), message: 'm', severity: 'minor' }])
    expect(f?.file.length).toBe(500)
  })
})

describe('sanitizeNarrative', () => {
  test('non-object or empty: null', () => {
    expect(sanitizeNarrative(null, 0)).toBeNull()
    expect(sanitizeNarrative({ steps: [], intent: '' }, 0)).toBeNull()
  })

  test('step without title ignored, finding_refs bounded and deduplicated', () => {
    const n = sanitizeNarrative(
      {
        intent: 'i',
        steps: [
          { title: '', files: [] },
          { title: 'Ch', files: ['a.ts', 7], finding_refs: [0, 0, 2, -1, 99] },
        ],
      },
      3,
    )
    expect(n?.steps).toHaveLength(1)
    expect(n?.steps[0]?.files).toEqual(['a.ts'])
    expect(n?.steps[0]?.finding_refs).toEqual([0, 2])
  })

  test('invalid risk absent, null check kept', () => {
    const n = sanitizeNarrative({ steps: [{ title: 'Ch', risk: 'extreme', check: null }] }, 0)
    expect(n?.steps[0]?.risk).toBeUndefined()
    expect(n?.steps[0]?.check).toBeNull()
  })

  test('review_first: capped at 4, default risk medium, step_ref bounded', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      point: `p${i}`,
      risk: 'weird',
      step_ref: i,
    }))
    const n = sanitizeNarrative({ steps: [{ title: 'Ch' }], review_first: items }, 0)
    expect(n?.review_first).toHaveLength(4)
    expect(n?.review_first[0]).toEqual({ point: 'p0', risk: 'medium', step_ref: 0, file: null })
    expect(n?.review_first[1]?.step_ref).toBeNull()
  })

  test('legacy archives: chapters and chapter_ref accepted as steps and step_ref', () => {
    const n = sanitizeNarrative(
      {
        intent: 'i',
        chapters: [{ title: 'Legacy group', files: ['a.ts'] }],
        review_first: [{ point: 'p', risk: 'high', chapter_ref: 0 }],
      },
      0,
    )
    expect(n?.steps).toHaveLength(1)
    expect(n?.steps[0]?.title).toBe('Legacy group')
    expect(n?.review_first[0]?.step_ref).toBe(0)
  })

  test('steps win over legacy chapters when both are present', () => {
    const n = sanitizeNarrative({ steps: [{ title: 'New' }], chapters: [{ title: 'Old' }] }, 0)
    expect(n?.steps.map((s) => s.title)).toEqual(['New'])
  })

  test('prologue without why/what absent, key_changes capped at 5 and title required', () => {
    expect(
      sanitizeNarrative({ steps: [{ title: 'Ch' }], prologue: {} }, 0)?.prologue,
    ).toBeUndefined()
    const kcs = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, detail: 'd' }))
    const n = sanitizeNarrative(
      {
        steps: [{ title: 'Ch' }],
        prologue: { why: 'w', key_changes: [...kcs, { detail: 'orphan' }] },
      },
      0,
    )
    expect(n?.prologue?.key_changes).toHaveLength(5)
  })
})

describe('sanitizeRecord', () => {
  test('non-object input → null', () => {
    expect(sanitizeRecord(null)).toBeNull()
    expect(sanitizeRecord('junk')).toBeNull()
  })

  test('missing meta fields default to empty strings, created_at is filled', () => {
    const record = sanitizeRecord({ meta: { branch: 'feat' } })
    expect(record?.meta.branch).toBe('feat')
    expect(record?.meta.title).toBe('')
    expect(record?.meta.created_at.length).toBeGreaterThan(0)
  })

  test('head_sha kept only when a non-empty string', () => {
    expect(sanitizeRecord({ meta: { head_sha: 'abc' } })?.meta.head_sha).toBe('abc')
    expect(sanitizeRecord({ meta: { head_sha: 123 } })?.meta.head_sha).toBeUndefined()
    expect(sanitizeRecord({ meta: {} })?.meta.head_sha).toBeUndefined()
  })

  test('review is sanitized, commits and diff are coerced', () => {
    const record = sanitizeRecord({
      commits: ['a', 2, 'b'],
      diff: 42,
      review: { verdict: 'approve' },
    })
    expect(record?.commits).toEqual(['a', 'b'])
    expect(record?.diff).toBe('')
    expect(record?.review.verdict).toBe('approve')
  })

  test('dual stats kept when they are non-negative integers, dropped otherwise', () => {
    const dual = { merged: 2, rejected: 1, added_by_b: 3 }
    expect(sanitizeRecord({ meta: { dual } })?.meta.dual).toEqual(dual)
    expect(
      sanitizeRecord({ meta: { dual: { merged: -1, rejected: 0, added_by_b: 0 } } })?.meta.dual,
    ).toBeUndefined()
    expect(sanitizeRecord({ meta: { dual: 'yes' } })?.meta.dual).toBeUndefined()
    expect(sanitizeRecord({ meta: {} })?.meta.dual).toBeUndefined()
  })
})

function diffFor(path: string, added: string[] = []): string {
  const body = added.map((l) => `+${l}`).join('\n')
  return `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}\n`
}

describe('detectDiffSecrets', () => {
  test('non-string or empty input: no matches', () => {
    expect(detectDiffSecrets('')).toEqual([])
    expect(detectDiffSecrets(undefined as unknown as string)).toEqual([])
  })

  test('a clean diff has no matches', () => {
    expect(detectDiffSecrets(diffFor('src/app.ts', ['const answer = 42']))).toEqual([])
  })

  test('sensitive filenames are flagged, placeholders are not', () => {
    expect(detectDiffSecrets(diffFor('.env', ['A=1']))).toContainEqual({
      file: '.env',
      reason: 'filename',
      detail: '.env',
    })
    expect(detectDiffSecrets(diffFor('config/db.pem', ['x']))[0]?.reason).toBe('filename')
    expect(detectDiffSecrets(diffFor('service/id_rsa', ['x']))[0]?.reason).toBe('filename')
    expect(
      detectDiffSecrets(diffFor('.env.local', ['A=1'])).some((m) => m.reason === 'filename'),
    ).toBe(true)
    expect(detectDiffSecrets(diffFor('.env.example', ['A=1']))).toEqual([])
  })

  test('credentials in content are flagged on added and removed lines', () => {
    const added = detectDiffSecrets(diffFor('src/app.ts', ['const k = "AKIAIOSFODNN7EXAMPLE"']))
    expect(added).toContainEqual({
      file: 'src/app.ts',
      reason: 'content',
      detail: 'an AWS access key id',
    })
    const removedSecret =
      'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const k = "sk-ant-0123456789ABCDEFGHIJ"\n+const k = readEnv()\n'
    expect(detectDiffSecrets(removedSecret)).toContainEqual({
      file: 'src/app.ts',
      reason: 'content',
      detail: 'an Anthropic API key',
    })
  })

  test('duplicate hits for the same file, reason and detail are collapsed', () => {
    const diff = diffFor('src/app.ts', ['a = "AKIAIOSFODNN7EXAMPLE"', 'b = "AKIAIOSFODNN7EXAMPLE"'])
    expect(detectDiffSecrets(diff)).toHaveLength(1)
  })

  test('a GNU-style tab suffix on marker lines is stripped from the path', () => {
    const diff =
      '--- a/.env\t2026-07-14 00:00:00\n+++ b/.env\t2026-07-14 00:00:00\n@@ -1 +1 @@\n-A=1\n+A=2\n'
    expect(detectDiffSecrets(diff)).toContainEqual({
      file: '.env',
      reason: 'filename',
      detail: '.env',
    })
  })

  test('a marker line stuffed with tabs and a stray carriage return parses in linear time', () => {
    const hostile = `--- a/x\n+++ ${'\t'.repeat(60_000)}\r\n@@ -0,0 +1 @@\n+1\n`
    const start = performance.now()
    detectDiffSecrets(hostile)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

const GROUND_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,4 +10,6 @@ export function login() {',
  ' line10',
  '+line11',
  '+line12',
  ' line13',
  ' line14',
  ' line15',
  '@@ -40,2 +42,2 @@',
  ' line42',
  '-old line',
  '+line43',
  'diff --git a/docs/removed.md b/docs/removed.md',
  'deleted file mode 100644',
  '--- a/docs/removed.md',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-a',
  '-b',
  '-c',
].join('\n')

function reviewWith(
  findings: Finding[],
  overrides: Partial<SanitizedReview> = {},
): SanitizedReview {
  return { verdict: 'comment', summary: 's', findings, narrative: null, ...overrides }
}

describe('groundReview', () => {
  test('finding on a file absent from the diff is dropped and reported', () => {
    const ghost: Finding = { file: 'src/ghost.ts', line: 3, severity: 'major', message: 'm' }
    const kept: Finding = { file: 'src/auth.ts', line: 11, severity: 'minor', message: 'm' }
    const { review, report } = groundReview(reviewWith([ghost, kept]), GROUND_DIFF)
    expect(review.findings).toEqual([kept])
    expect(report.dropped).toEqual([ghost])
  })

  test('line outside every hunk is de-anchored, finding kept', () => {
    const { review, report } = groundReview(
      reviewWith([
        { file: 'src/auth.ts', line: 99, endLine: 100, severity: 'major', message: 'm' },
      ]),
      GROUND_DIFF,
    )
    expect(review.findings).toEqual([{ file: 'src/auth.ts', severity: 'major', message: 'm' }])
    expect(report.deanchored).toHaveLength(1)
  })

  test('line inside a hunk is untouched, including the second hunk', () => {
    const findings: Finding[] = [
      { file: 'src/auth.ts', line: 10, severity: 'minor', message: 'm' },
      { file: 'src/auth.ts', line: 43, severity: 'minor', message: 'm' },
    ]
    const { review, report } = groundReview(reviewWith(findings), GROUND_DIFF)
    expect(review.findings).toEqual(findings)
    expect(report.dropped).toEqual([])
    expect(report.deanchored).toEqual([])
  })

  test('endLine past the hunk is stripped while a valid line is kept', () => {
    const { review } = groundReview(
      reviewWith([{ file: 'src/auth.ts', line: 14, endLine: 30, severity: 'minor', message: 'm' }]),
      GROUND_DIFF,
    )
    expect(review.findings[0]?.line).toBe(14)
    expect(review.findings[0]?.endLine).toBeUndefined()
  })

  test('deleted file: file-level finding kept, line anchor removed', () => {
    const { review, report } = groundReview(
      reviewWith([
        { file: 'docs/removed.md', severity: 'info', kind: 'why', message: 'm' },
        { file: 'docs/removed.md', line: 2, severity: 'minor', message: 'm' },
      ]),
      GROUND_DIFF,
    )
    expect(review.findings).toHaveLength(2)
    expect(review.findings[1]?.line).toBeUndefined()
    expect(report.dropped).toEqual([])
    expect(report.deanchored).toHaveLength(1)
  })

  test('duplicates (same file, line, kind) merge into the first with the highest severity', () => {
    const { review, report } = groundReview(
      reviewWith([
        { file: 'src/auth.ts', line: 11, severity: 'minor', kind: 'security', message: 'first' },
        {
          file: 'src/auth.ts',
          line: 11,
          severity: 'critical',
          kind: 'security',
          message: 'louder duplicate',
        },
        {
          file: 'src/auth.ts',
          line: 11,
          severity: 'minor',
          kind: 'perf',
          message: 'different kind, kept',
        },
      ]),
      GROUND_DIFF,
    )
    expect(review.findings).toHaveLength(2)
    expect(review.findings[0]?.message).toBe('first')
    expect(review.findings[0]?.severity).toBe('critical')
    expect(report.merged).toBe(1)
  })

  test('duplicate merge keeps the consensus flag from either copy', () => {
    const { review } = groundReview(
      reviewWith([
        { file: 'src/auth.ts', line: 11, severity: 'major', kind: 'design', message: 'first' },
        {
          file: 'src/auth.ts',
          line: 11,
          severity: 'minor',
          kind: 'design',
          message: 'duplicate',
          consensus: true,
        },
      ]),
      GROUND_DIFF,
    )
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]?.consensus).toBe(true)
    expect(review.findings[0]?.severity).toBe('major')
  })

  test('findings without a line are never merged', () => {
    const { review, report } = groundReview(
      reviewWith([
        { file: 'src/auth.ts', severity: 'minor', kind: 'design', message: 'one' },
        { file: 'src/auth.ts', severity: 'minor', kind: 'design', message: 'two' },
      ]),
      GROUND_DIFF,
    )
    expect(review.findings).toHaveLength(2)
    expect(report.merged).toBe(0)
  })

  test('narrative finding_refs are remapped after drops and merges', () => {
    const narrative = {
      intent: 'i',
      confidence: 'high' as const,
      steps: [
        {
          title: 'Step',
          rationale: 'r',
          files: ['src/auth.ts'],
          finding_refs: [0, 1, 2, 3],
        },
      ],
      review_first: [],
    }
    const { review } = groundReview(
      reviewWith(
        [
          { file: 'src/ghost.ts', severity: 'major', message: 'dropped' },
          { file: 'src/auth.ts', line: 11, severity: 'minor', kind: 'perf', message: 'kept first' },
          {
            file: 'src/auth.ts',
            line: 11,
            severity: 'minor',
            kind: 'perf',
            message: 'merged into 1',
          },
          { file: 'src/auth.ts', line: 43, severity: 'minor', message: 'kept last' },
        ],
        { narrative },
      ),
      GROUND_DIFF,
    )
    expect(review.findings).toHaveLength(2)
    expect(review.narrative?.steps[0]?.finding_refs).toEqual([0, 1])
  })

  test('approve with a surviving critical finding escalates to request_changes', () => {
    const { review, report } = groundReview(
      reviewWith([{ file: 'src/auth.ts', line: 11, severity: 'critical', message: 'm' }], {
        verdict: 'approve',
      }),
      GROUND_DIFF,
    )
    expect(review.verdict).toBe('request_changes')
    expect(report.verdict_escalated).toBe(true)
  })

  test('approve stays approve when the only critical finding was dropped', () => {
    const { review, report } = groundReview(
      reviewWith([{ file: 'src/ghost.ts', severity: 'critical', message: 'm' }], {
        verdict: 'approve',
      }),
      GROUND_DIFF,
    )
    expect(review.verdict).toBe('approve')
    expect(report.verdict_escalated).toBe(false)
  })

  test('unparseable diff: review returned unchanged', () => {
    const findings: Finding[] = [
      { file: 'src/ghost.ts', line: 1, severity: 'critical', message: 'm' },
    ]
    const input = reviewWith(findings, { verdict: 'approve' })
    const { review, report } = groundReview(input, 'not a diff at all')
    expect(review).toEqual(input)
    expect(report.dropped).toEqual([])
    expect(report.verdict_escalated).toBe(false)
  })

  test('a deanchored finding still marks its file as findings', () => {
    const { review } = groundReview(
      reviewWith([{ file: 'src/auth.ts', line: 99999, severity: 'major', message: 'm' }], {
        files_reviewed: [
          { path: 'src/auth.ts', status: 'findings' },
          { path: 'docs/removed.md', status: 'clean' },
        ],
      }),
      GROUND_DIFF,
    )
    expect(review.findings).toHaveLength(1)
    expect(review.files_reviewed).toEqual([
      { path: 'src/auth.ts', status: 'findings' },
      { path: 'docs/removed.md', status: 'clean' },
    ])
  })

  test('files_reviewed statuses follow the surviving findings after a drop', () => {
    const { review } = groundReview(
      reviewWith([{ file: 'src/ghost.ts', severity: 'major', message: 'dropped with its file' }], {
        files_reviewed: [{ path: 'src/ghost.ts', status: 'findings' }],
      }),
      GROUND_DIFF,
    )
    expect(review.findings).toEqual([])
    expect(review.files_reviewed).toEqual([{ path: 'src/ghost.ts', status: 'clean' }])
  })

  test('files_reviewed stays absent when the reviewer declared nothing', () => {
    const { review } = groundReview(
      reviewWith([{ file: 'src/auth.ts', line: 11, severity: 'minor', message: 'm' }]),
      GROUND_DIFF,
    )
    expect(review.files_reviewed).toBeUndefined()
  })
})

describe('reviewRecordSchema', () => {
  test('declares a draft 2020-12 schema with an id', () => {
    expect(reviewRecordSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(reviewRecordSchema.$id).toContain('review-record')
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
    walk(reviewRecordSchema)
    const defs = new Set(Object.keys(reviewRecordSchema.$defs))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(defs.has(ref.replace('#/$defs/', ''))).toBe(true)
    }
  })

  // The schema declares `additionalProperties: false` on the review object, so
  // a key the sanitizer can PRODUCE but the schema does not DECLARE makes a
  // legitimate record invalid. Derived from a real sanitizer output rather than
  // from a hand-kept list, so a field added to one side and not the other is
  // what turns this red.
  test('every key sanitizeReview can produce is declared by the review schema', () => {
    const produced = sanitizeReview({
      verdict: 'approve',
      summary: 's',
      findings: [{ file: 'a.ts', message: 'm', severity: 'major', line: 1 }],
      narrative: { intent: 'i', steps: [], review_first: [] },
      files_reviewed: ['a.ts'],
      criteria: [{ criterion_id: 'ac-000000000001', status: 'met', evidence: 'a.ts:1 x' }],
    })
    const declared = new Set(Object.keys(reviewRecordSchema.$defs.review.properties))
    expect(Object.keys(produced).length).toBeGreaterThan(4)
    for (const key of Object.keys(produced)) {
      expect(declared.has(key)).toBe(true)
    }
  })

  test('top-level required keys all exist in properties', () => {
    const props = new Set(Object.keys(reviewRecordSchema.properties))
    for (const key of reviewRecordSchema.required) {
      expect(props.has(key)).toBe(true)
    }
  })
})

// --- DP12 / T3.2: per-criterion verdicts on the review record ---------------

const AC_A = 'ac-000000000001'
const AC_B = 'ac-000000000002'

describe('sanitizeReview criteria (DP12)', () => {
  test('a readable list survives, deduplicated on criterion_id, first occurrence wins', () => {
    const review = sanitizeReview({
      criteria: [
        { criterion_id: AC_A, status: 'met', evidence: 'src/auth.ts:11 does it' },
        { criterion_id: AC_A, status: 'unmet' },
        { criterion_id: AC_B, status: 'unmet' },
      ],
    })
    expect(review.criteria).toEqual([
      { criterion_id: AC_A, status: 'met', evidence: 'src/auth.ts:11 does it' },
      { criterion_id: AC_B, status: 'unmet' },
    ])
  })

  test('an out-of-enum status degrades to unclear, never to met', () => {
    const review = sanitizeReview({ criteria: [{ criterion_id: AC_A, status: 'partial' }] })
    expect(review.criteria).toEqual([{ criterion_id: AC_A, status: 'unclear' }])
  })

  test('an id the model invented is discarded, never reconstructed', () => {
    const review = sanitizeReview({
      criteria: [
        { criterion_id: 'criterion 1', status: 'met' },
        { criterion_id: AC_B, status: 'met' },
      ],
    })
    expect(review.criteria).toEqual([{ criterion_id: AC_B, status: 'met' }])
  })

  test('absence, a non-array and a list where nothing survives all OMIT the key', () => {
    expect(sanitizeReview({}).criteria).toBeUndefined()
    expect(sanitizeReview({ criteria: 'all good' }).criteria).toBeUndefined()
    expect(
      sanitizeReview({ criteria: [null, 3, { criterion_id: 'nope' }] }).criteria,
    ).toBeUndefined()
  })

  test('sanitizeRecord carries the list back off disk (the whitelist keeps it)', () => {
    const record = sanitizeRecord({
      version: 1,
      meta: {},
      commits: [],
      diff: '',
      review: { verdict: 'approve', criteria: [{ criterion_id: AC_A, status: 'met' }] },
    })
    expect(record?.review.criteria).toEqual([{ criterion_id: AC_A, status: 'met' }])
  })
})

describe('parseEvidenceAnchor', () => {
  test('reads the path:line an evidence opens with, prose and all', () => {
    expect(parseEvidenceAnchor('src/auth.ts:11 — the guard is added here')).toEqual({
      file: 'src/auth.ts',
      line: 11,
    })
  })

  test('no anchor at all, a zero line and an unrepresentable one are all null', () => {
    expect(parseEvidenceAnchor('the guard is added')).toBeNull()
    expect(parseEvidenceAnchor('src/auth.ts:0 nope')).toBeNull()
    expect(parseEvidenceAnchor('src/auth.ts:99999999999999999999 nope')).toBeNull()
    expect(parseEvidenceAnchor(undefined)).toBeNull()
    expect(parseEvidenceAnchor(42)).toBeNull()
  })
})

describe('groundCriterionVerdicts', () => {
  const met = (evidence?: string): CriterionVerdict => ({
    criterion_id: AC_A,
    status: 'met',
    ...(evidence !== undefined ? { evidence } : {}),
  })

  test('an evidence anchored inside a hunk survives untouched', () => {
    const verdict = met('src/auth.ts:11 — added here')
    const { verdicts, report } = groundCriterionVerdicts([verdict], GROUND_DIFF)
    expect(verdicts).toEqual([verdict])
    expect(report.dropped_evidence).toEqual([])
    expect(report.demoted).toEqual([])
  })

  test('an evidence on a file absent from the diff is removed and the status falls to unclear', () => {
    const verdict = met('src/ghost.ts:3 — invented')
    const { verdicts, report } = groundCriterionVerdicts([verdict], GROUND_DIFF)
    expect(verdicts).toEqual([{ criterion_id: AC_A, status: 'unclear' }])
    expect(report.dropped_evidence).toEqual([verdict])
    expect(report.demoted).toEqual([verdict])
  })

  test('an evidence on a diff file but outside every hunk is removed too', () => {
    const verdict = met('src/auth.ts:99 — outside the hunks')
    const { verdicts } = groundCriterionVerdicts([verdict], GROUND_DIFF)
    expect(verdicts).toEqual([{ criterion_id: AC_A, status: 'unclear' }])
  })

  test('a met with no evidence at all falls to unclear: a positive claim needs proof', () => {
    const { verdicts, report } = groundCriterionVerdicts([met()], GROUND_DIFF)
    expect(verdicts).toEqual([{ criterion_id: AC_A, status: 'unclear' }])
    // Nothing was dropped — there was nothing to drop — but it WAS demoted.
    expect(report.dropped_evidence).toEqual([])
    expect(report.demoted).toEqual([met()])
  })

  test('an unmet that claimed nothing keeps its status; one whose claim was false does not', () => {
    const bare: CriterionVerdict = { criterion_id: AC_B, status: 'unmet' }
    const claiming: CriterionVerdict = {
      criterion_id: AC_A,
      status: 'unmet',
      evidence: 'src/ghost.ts:3 — invented',
    }
    const { verdicts } = groundCriterionVerdicts([bare, claiming], GROUND_DIFF)
    expect(verdicts).toEqual([bare, { criterion_id: AC_A, status: 'unclear' }])
  })

  test('an unindexable diff never throws and takes every met down to unclear', () => {
    const { verdicts, report } = groundCriterionVerdicts(
      [met('src/auth.ts:11 — added here'), { criterion_id: AC_B, status: 'unmet' }],
      'not a diff at all',
    )
    expect(report.diff_unreadable).toBe(true)
    expect(verdicts).toEqual([
      { criterion_id: AC_A, status: 'unclear' },
      { criterion_id: AC_B, status: 'unmet' },
    ])
  })

  test('a non-string diff degrades instead of throwing', () => {
    expect(() =>
      groundCriterionVerdicts([met('src/auth.ts:11 x')], null as unknown as string),
    ).not.toThrow()
  })
})

// --- T3.2 round 2, majeur 1(a): what we agree to READ as an anchor ----------
// The first version of `EVIDENCE_ANCHOR_RE` demanded a bare `path:line` at the
// very start of the evidence. An independent campaign over 28 plausible
// spellings grounded 8: the SAME criterion with the SAME proof flipped from
// `met` to `unclear` because the model wrapped the path in backticks, or
// because it quoted the path the way the diff itself prints it (`b/src/a.ts`).
// The table below is that campaign, kept as a test.
//
// RECOGNITION widened; SEVERITY did not. The bottom half of the table is the
// half that must keep failing: every anchor is still checked against the diff,
// and one that points nowhere still takes its `met` down to `unclear`.

const ANCHOR_DIFF = [
  'diff --git a/src/gate.ts b/src/gate.ts',
  '--- a/src/gate.ts',
  '+++ b/src/gate.ts',
  '@@ -10,4 +10,6 @@',
  ' line10',
  '+line11',
  '+line12',
  ' line13',
  'diff --git a/src/my file.ts b/src/my file.ts',
  '--- a/src/my file.ts',
  '+++ b/src/my file.ts',
  '@@ -1,1 +1,2 @@',
  ' one',
  '+two',
  'diff --git a/docs/gone.md b/docs/gone.md',
  'deleted file mode 100644',
  '--- a/docs/gone.md',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
].join('\n')

/** Whether an evidence proves a `met` against `ANCHOR_DIFF` — the only question that matters. */
function grounds(evidence: string): boolean {
  const { verdicts } = groundCriterionVerdicts(
    [{ criterion_id: AC_A, status: 'met', evidence }],
    ANCHOR_DIFF,
  )
  return verdicts[0]?.status === 'met'
}

describe('evidence anchors: recognition is loose', () => {
  const READ: [string, string][] = [
    ['a bare path:line, the form the prompt asks for', 'src/gate.ts:11 — the gate lands here'],
    ['backticked, the form a model reaches for', '`src/gate.ts:11` — the gate lands here'],
    ['double quoted', '"src/gate.ts:11" — the gate lands here'],
    ['single quoted', "'src/gate.ts:11' — the gate lands here"],
    ['the b/ side, which the diff prints literally', 'b/src/gate.ts:11 — here'],
    ['the a/ side', 'a/src/gate.ts:11 — here'],
    ['a ./ prefix', './src/gate.ts:11 — here'],
    ['an absolute path, resolved by suffix', '/home/me/repo/src/gate.ts:11 — here'],
    ['a path with a space, inside delimiters', '`src/my file.ts:2` — here'],
    ['the :L spelling', 'src/gate.ts:L11 — here'],
    ['the #L spelling', 'src/gate.ts#L11 — here'],
    ['the "line N" spelling', 'src/gate.ts line 11 — here'],
    ['a comma before the line', 'src/gate.ts, line 11 — here'],
    ['prose in front of the anchor', 'the guard is added at src/gate.ts:11'],
    ['a markdown bullet in front', '- src/gate.ts:11 — here'],
    ['the anchor on the second line', 'I read the diff:\nsrc/gate.ts:11 — here'],
    ['a line range', 'src/gate.ts:11-14 — here'],
    ['parentheses around it', 'the gate (src/gate.ts:11) lands here'],
    ['square brackets around it', '[src/gate.ts:11] here'],
    ['bold markdown around it', '**src/gate.ts:11** here'],
    ['a trailing colon after the line', 'src/gate.ts:11: the gate lands here'],
    ['the hunk’s second added line', 'src/gate.ts:12 — here'],
  ]

  for (const [name, evidence] of READ) {
    test(`grounds: ${name}`, () => {
      expect(grounds(evidence)).toBe(true)
    })
  }

  test('a bare path with a space is NOT read — the split would be a guess', () => {
    // The one deliberate refusal of the table above. Undelimited, there is no
    // way to tell `src/my file.ts:2` from a path `file.ts:2` preceded by the
    // word "my", and guessing is how a formatting rule turns into a wrong
    // verdict. Delimited, the same path grounds (see the table).
    expect(grounds('src/my file.ts:2 — here')).toBe(false)
    expect(grounds('`src/my file.ts:2` — here')).toBe(true)
  })

  test('a space in the path is read only when the delimited span IS the anchor', () => {
    // Where the `^…$` on `ANCHOR_WHOLE_SPAN_RE` earns its keep. A span that is
    // exactly an anchor says, by its delimiters, where the path stops — so a
    // space inside it is part of the path. A span that also holds prose says
    // nothing of the kind, and reading the greediest path out of it would be
    // the same guess this suite refuses one test up. Outside delimiters the
    // loose scan still applies, which is why `src/gate.ts:11` grounds either
    // way; only the SPACE case can tell the two rules apart.
    expect(grounds('`a/src/my file.ts:2`')).toBe(true)
    expect(grounds('`a/src/my file.ts:2 — the added line`')).toBe(false)
    // …and no severity was lost on the way: a spaceless path in a talkative
    // span is still found, by the loose scan.
    expect(grounds('`a/src/gate.ts:11 — the added line`')).toBe(true)
  })
})

describe('evidence anchors: severity is not', () => {
  const REFUSED: [string, string][] = [
    ['a line outside every hunk of a file that IS in the diff', 'src/gate.ts:99 — nope'],
    ['a file the diff does not carry', 'src/ghost.ts:11 — nope'],
    ['no anchor at all, however convinced the prose sounds', 'I checked and it is definitely done'],
    ['a line number of zero', 'src/gate.ts:0 — nope'],
    ['a line number too large to be an integer', 'src/gate.ts:99999999999999999999 — nope'],
    ['a deleted file: there is no new-file line to point at', 'docs/gone.md:1 — nope'],
    ['a path the real one is not a /-boundary suffix of', 'notsrc/gate.ts:11 — nope'],
    ['a suffix that is not at a / boundary either way', 'gate.ts:11 — nope'],
  ]

  for (const [name, evidence] of REFUSED) {
    test(`refuses: ${name}`, () => {
      expect(grounds(evidence)).toBe(false)
    })
  }

  test('one readable anchor among several is enough, and none of them skips the diff', () => {
    // Several candidates are all tried — that is recognition. Every one of
    // them is still checked — that is severity.
    expect(grounds('src/ghost.ts:1 or maybe src/gate.ts:11')).toBe(true)
    expect(grounds('src/ghost.ts:1 or maybe src/gate.ts:99')).toBe(false)
  })
})

describe('evidence anchors: which file an over-qualified path names', () => {
  // Two files whose paths are /-boundary suffixes of one another. An
  // over-qualified anchor matches BOTH, so the tie-break decides which file's
  // hunks the line is checked against — and checking it against the wrong
  // file's hunks is a severity leak, not a formatting nicety.
  const NESTED_DIFF = [
    'diff --git a/src/gate.ts b/src/gate.ts',
    '--- a/src/gate.ts',
    '+++ b/src/gate.ts',
    '@@ -10,1 +10,2 @@',
    ' line10',
    '+line11',
    'diff --git a/pkg/src/gate.ts b/pkg/src/gate.ts',
    '--- a/pkg/src/gate.ts',
    '+++ b/pkg/src/gate.ts',
    '@@ -40,1 +40,2 @@',
    ' line40',
    '+line41',
  ].join('\n')

  const groundsNested = (evidence: string): boolean =>
    groundCriterionVerdicts([{ criterion_id: AC_A, status: 'met', evidence }], NESTED_DIFF)
      .verdicts[0]?.status === 'met'

  test('the LONGEST matching diff path wins, so the line is checked against the right file', () => {
    expect(groundsNested('/home/me/repo/pkg/src/gate.ts:41 — here')).toBe(true)
  })

  test('…and it does not fall back to the shorter path when the line is not there', () => {
    // `src/gate.ts` also matches this anchor by suffix, and line 11 IS in its
    // hunk — resolving to it would ground an evidence against a file the
    // reviewer did not name.
    expect(groundsNested('/home/me/repo/pkg/src/gate.ts:11 — here')).toBe(false)
  })
})

describe('parseEvidenceAnchors', () => {
  test('returns every coordinate an evidence claims, in order', () => {
    expect(parseEvidenceAnchors('see `a.ts:1` and then b.ts#L2, plus c.ts line 3')).toEqual([
      { file: 'a.ts', line: 1 },
      { file: 'a.ts', line: 1 },
      { file: 'b.ts', line: 2 },
      { file: 'c.ts', line: 3 },
    ])
  })

  test('an evidence that claims none is an empty list, never a throw', () => {
    expect(parseEvidenceAnchors('nothing here')).toEqual([])
    expect(parseEvidenceAnchors(undefined)).toEqual([])
    expect(parseEvidenceAnchors(42)).toEqual([])
    expect(parseEvidenceAnchors('')).toEqual([])
  })

  test('the list is bounded, so a pathological evidence cannot blow up the grounding', () => {
    const many = Array.from({ length: 200 }, (_, i) => `a.ts:${i + 1}`).join(' ')
    expect(parseEvidenceAnchors(many).length).toBeLessThanOrEqual(32)
  })

  test('prose punctuation is stripped off both ends of the path', () => {
    expect(parseEvidenceAnchors('(src/a.ts:1), [b.ts:2]; *c.ts:3*')).toEqual([
      { file: 'src/a.ts', line: 1 },
      { file: 'b.ts', line: 2 },
      { file: 'c.ts', line: 3 },
    ])
    // `.` and `_` are paths, not prose: stripping them would break both of these.
    expect(parseEvidenceAnchors('./src/a.ts:1 and _internal/b.ts:2')).toEqual([
      { file: './src/a.ts', line: 1 },
      { file: '_internal/b.ts', line: 2 },
    ])
    // A path that is punctuation and nothing else is no path at all.
    expect(parseEvidenceAnchors('):1')).toEqual([])
  })

  test('a long run of closing parens is stripped in one pass, not quadratically', () => {
    // The guard on the shape of the stripper, not on the machine it runs on.
    // `/[,;)\]}>*~]+$/` walked the whole run again from every position: 10 000
    // parens took 72 ms, 20 000 took 276 ms, 40 000 took 1 094 ms. The 200 000
    // below would have taken ~28 s. The scan that replaced it is under a
    // millisecond, so a full second still leaves a hundredfold margin under the
    // load of a parallel suite.
    const evidence = `${')'.repeat(200_000)}a.ts:12`
    const started = performance.now()
    const anchors = parseEvidenceAnchors(evidence)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.line).toBe(12)
  })
})

// --- The published review schema, checked against its own sanitizer ---------
// Round 2, mineur 3: `reviewRecordSchema` had NO validation test at all — the
// `criterionVerdict` $def's id pattern, its evidence bounds and its `minItems`
// could each be deleted with the whole suite still green. Its twin
// `recapRecordSchema` has carried a hand-written validator and both cross
// directions since round 2 of its own ticket, and both schemas publish the SAME
// `criterionVerdict` for the same DP12. The pattern existed; this applies it.
//
// Deliberately local and tiny, like recap.test.ts's own: it covers exactly the
// keywords reviewRecordSchema uses, so it proves the SCHEMA against the
// SANITIZER rather than a library's leniency.

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
  // schema object still applies, so resolving the ref must not discard it.
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

function typeMatches(node: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return node === null
    case 'string':
      return typeof node === 'string'
    case 'boolean':
      return typeof node === 'boolean'
    case 'integer':
      return typeof node === 'number' && Number.isInteger(node)
    case 'array':
      return Array.isArray(node)
    case 'object':
      return !!node && typeof node === 'object' && !Array.isArray(node)
    default:
      return false
  }
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
  if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(node)) {
    errors.push(`${path}: pattern`)
  }
  return errors
}

function validateNumber(node: number, s: Schema, path: string): string[] {
  return typeof s.minimum === 'number' && node < s.minimum ? [`${path}: minimum`] : []
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
    // Object.hasOwn, NOT `key in record`: `in` walks the prototype chain, so a
    // required 'toString' would read as present on ANY object.
    if (!Object.hasOwn(record, key)) {
      errors.push(`${path}.${key}: required`)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    // Object.hasOwn, NOT `properties[key]`: a bracket lookup for 'constructor',
    // 'toString' or '__proto__' resolves to the INHERITED Object.prototype
    // member — truthy — so `additionalProperties: false` would never fire for
    // exactly the keys most worth catching.
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
  const types =
    typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : []
  const hasAssertion = 'const' in s || 'enum' in s || types.length > 0 || Array.isArray(s.anyOf)
  if (!hasAssertion) {
    // A schema node that asserts NOTHING accepts every value that reaches it —
    // the silent hole this validator exists to refuse, not to reproduce: drop
    // `type` from a $def by accident and every instance would validate,
    // including an invented status. Fail LOUDLY here instead of quietly
    // proving nothing.
    throw new Error(`reviewRecordSchema validator: '${path}' asserts nothing`)
  }
  const errors: string[] = []
  if ('const' in s && node !== s.const) {
    errors.push(`${path}: const`)
  }
  if (Array.isArray(s.enum) && !s.enum.includes(node)) {
    errors.push(`${path}: enum`)
  }
  if (Array.isArray(s.anyOf)) {
    const branches = s.anyOf as Schema[]
    if (!branches.some((branch) => validate(node, branch, root, path).length === 0)) {
      errors.push(`${path}: anyOf`)
    }
  }
  if (types.length === 0) {
    return errors
  }
  if (!types.some((type) => typeMatches(node, type))) {
    errors.push(`${path}: type`)
    return errors
  }
  if (typeof node === 'string') {
    errors.push(...validateString(node, s, path))
  } else if (typeof node === 'number') {
    errors.push(...validateNumber(node, s, path))
  } else if (Array.isArray(node)) {
    errors.push(...validateArray(node, s, root, path))
  } else if (node && typeof node === 'object') {
    errors.push(...validateObject(node, s, root, path))
  }
  return errors
}

const schemaErrors = (value: unknown): string[] =>
  validate(value, reviewRecordSchema as unknown as Schema, reviewRecordSchema as unknown as Schema)

const RECORD_META = {
  title: 't',
  branch: 'feature/x',
  target: 'develop',
  merge_base: 'abc123',
  repo_root: '/repo',
  created_at: '2026-01-01T00:00:00.000Z',
}

/** A schema-valid skeleton the reverse tests below vary ONE key of at a time. */
const RECORD_BASE = {
  version: 1,
  meta: RECORD_META,
  commits: [],
  diff: '',
  review: { verdict: 'approve', summary: '', findings: [], narrative: null },
}

const withCriteria = (criteria: unknown): unknown => ({
  ...RECORD_BASE,
  review: { ...RECORD_BASE.review, criteria },
})

describe('cross test: sanitizeRecord output validates against reviewRecordSchema', () => {
  test('a full record — narrative, findings, files_reviewed, criteria, dual — validates', () => {
    const record = sanitizeRecord({
      version: 1,
      meta: { ...RECORD_META, head_sha: 'def456', dual: { merged: 1, rejected: 0, added_by_b: 2 } },
      commits: ['feat: a'],
      diff: GROUND_DIFF,
      review: {
        verdict: 'request_changes',
        summary: 's',
        findings: [
          {
            file: 'src/auth.ts',
            line: 11,
            endLine: 12,
            severity: 'major',
            kind: 'design',
            title: 't',
            message: 'm',
            suggestion: 'do this',
            consensus: true,
          },
        ],
        narrative: {
          intent: 'i',
          confidence: 'medium',
          prologue: { why: 'w', what: 'w', key_changes: [{ title: 't', detail: 'd' }] },
          steps: [
            {
              title: 't',
              rationale: 'r',
              files: ['src/auth.ts'],
              finding_refs: [0],
              risk: 'low',
              take: 'k',
              check: null,
            },
          ],
          review_first: [{ point: 'p', risk: 'high', step_ref: 0, file: 'src/auth.ts' }],
        },
        files_reviewed: ['src/auth.ts', { path: 'docs/removed.md', status: 'clean' }],
        criteria: [
          { criterion_id: AC_A, status: 'met', evidence: 'src/auth.ts:11 — added here' },
          { criterion_id: AC_B, status: 'unmet' },
        ],
      },
    })
    expect(schemaErrors(record)).toEqual([])
  })

  test('the minimal record — everything the sanitizer defaults — validates', () => {
    expect(schemaErrors(sanitizeRecord({}))).toEqual([])
  })

  test('hostile input, once sanitized, still validates', () => {
    const hostile = sanitizeRecord({
      version: 'not-1',
      meta: 'nope',
      commits: [1, null, 'feat: real'],
      diff: 42,
      review: {
        verdict: 'ship-it',
        summary: { nested: true },
        findings: 'lots',
        narrative: 'a story',
        files_reviewed: [1, {}],
        criteria: [{ criterion_id: AC_A, status: 'partial', evidence: '   ' }, null, 'x'],
      },
    })
    expect(schemaErrors(hostile)).toEqual([])
  })
})

// --- Reverse cross test: the schema must not accept MORE than the sanitizer
// would ever produce. The forward direction above proves every sanitizer output
// is schema-valid; on its own that lets the schema be arbitrarily LOOSER and
// still pass — a review.json that validates against the published schema but
// that the one sanctioned reader (`sanitizeReview`) refuses or silently
// reshapes. This is the direction the three surviving mutants lived in.

describe('reverse cross test: reviewRecordSchema is not looser than sanitizeReview', () => {
  test('an empty criteria[] is schema-invalid — the sanitizer OMITS the key instead', () => {
    // `sanitizeReview` never writes `criteria: []`: absence is how "this review
    // judged no criteria" is said.
    expect(schemaErrors(withCriteria([]))).not.toEqual([])
    expect(sanitizeReview({ criteria: [] }).criteria).toBeUndefined()
  })

  test('an id outside the ac-<12 hex> shape is schema-invalid — the sanitizer DISCARDS it', () => {
    for (const criterion_id of [
      'nope',
      'ac-',
      'ac-0123456789ab0',
      'ac-0123456789a',
      'AC-0123456789AB',
      'ac-0123456789ag',
    ]) {
      expect(schemaErrors(withCriteria([{ criterion_id, status: 'met' }]))).not.toEqual([])
      expect(
        sanitizeReview({ criteria: [{ criterion_id, status: 'met' }] }).criteria,
      ).toBeUndefined()
    }
  })

  test('a status outside the closed enum is schema-invalid — the sanitizer degrades it to unclear', () => {
    expect(schemaErrors(withCriteria([{ criterion_id: AC_A, status: 'partial' }]))).not.toEqual([])
    expect(
      sanitizeReview({ criteria: [{ criterion_id: AC_A, status: 'partial' }] }).criteria,
    ).toEqual([{ criterion_id: AC_A, status: 'unclear' }])
  })

  test('an evidence past the published bound is schema-invalid — the sanitizer TRUNCATES to it', () => {
    const tooLong = 'x'.repeat(CRITERION_VERDICT_EVIDENCE_MAX + 1)
    expect(
      schemaErrors(withCriteria([{ criterion_id: AC_A, status: 'met', evidence: tooLong }])),
    ).not.toEqual([])
    expect(
      schemaErrors(
        withCriteria([
          {
            criterion_id: AC_A,
            status: 'met',
            evidence: 'x'.repeat(CRITERION_VERDICT_EVIDENCE_MAX),
          },
        ]),
      ),
    ).toEqual([])
  })

  test('an empty or whitespace-only evidence is schema-invalid — the sanitizer OMITS the key', () => {
    for (const evidence of ['', '   ', '\n\t ']) {
      expect(
        schemaErrors(withCriteria([{ criterion_id: AC_A, status: 'met', evidence }])),
      ).not.toEqual([])
      expect(
        sanitizeReview({ criteria: [{ criterion_id: AC_A, status: 'met', evidence }] }).criteria,
      ).toEqual([{ criterion_id: AC_A, status: 'met' }])
    }
  })

  test('a criteria[] longer than a ticket is schema-invalid — the sanitizer caps it', () => {
    const many = Array.from({ length: TICKET_CRITERIA_MAX + 1 }, (_, i) => ({
      criterion_id: `ac-${String(i).padStart(12, '0')}`,
      status: 'met',
    }))
    expect(schemaErrors(withCriteria(many))).not.toEqual([])
    expect(sanitizeReview({ criteria: many }).criteria).toHaveLength(TICKET_CRITERIA_MAX)
  })

  test('two byte-identical criteria entries are schema-invalid — the sanitizer dedups', () => {
    const entry = { criterion_id: AC_A, status: 'met' }
    expect(schemaErrors(withCriteria([entry, { ...entry }]))).not.toEqual([])
    expect(sanitizeReview({ criteria: [entry, { ...entry }] }).criteria).toHaveLength(1)
  })

  test('a key the criterionVerdict $def does not declare is schema-invalid — the sanitizer drops it', () => {
    expect(
      schemaErrors(withCriteria([{ criterion_id: AC_A, status: 'met', confidence: 0.9 }])),
    ).not.toEqual([])
    expect(
      sanitizeReview({ criteria: [{ criterion_id: AC_A, status: 'met', confidence: 0.9 }] })
        .criteria,
    ).toEqual([{ criterion_id: AC_A, status: 'met' }])
  })

  test('a criterionVerdict missing criterion_id or status is schema-invalid', () => {
    expect(schemaErrors(withCriteria([{ criterion_id: AC_A }]))).not.toEqual([])
    expect(schemaErrors(withCriteria([{ status: 'met' }]))).not.toEqual([])
  })

  test('the review object itself still refuses an undeclared key and a bad verdict', () => {
    // The guard is on the WHOLE record, not only on the $def this round fixed:
    // a validator that only ever looked at `criteria` would prove nothing about
    // the rest of a schema nobody had tested either.
    expect(
      schemaErrors({ ...RECORD_BASE, review: { ...RECORD_BASE.review, completion_percent: 100 } }),
    ).not.toEqual([])
    expect(
      schemaErrors({ ...RECORD_BASE, review: { ...RECORD_BASE.review, verdict: 'ship-it' } }),
    ).not.toEqual([])
    expect(schemaErrors({ ...RECORD_BASE, version: 2 })).not.toEqual([])
  })
})

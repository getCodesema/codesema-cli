import { describe, expect, test } from 'bun:test'
import {
  detectDiffSecrets,
  groundReview,
  reviewRecordSchema,
  sanitizeFindings,
  sanitizeNarrative,
  sanitizeRecord,
  sanitizeReview,
  type Finding,
  type SanitizedReview,
} from './index.js'

describe('sanitizeReview', () => {
  test('empty input: safe defaults', () => {
    expect(sanitizeReview({})).toEqual({ verdict: 'comment', summary: '', findings: [], narrative: null })
    expect(sanitizeReview(null)).toEqual({ verdict: 'comment', summary: '', findings: [], narrative: null })
    expect(sanitizeReview('junk')).toEqual({ verdict: 'comment', summary: '', findings: [], narrative: null })
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
      files_reviewed: [' a.ts ', { path: 'b.ts', status: 'clean' }, 'a.ts', { status: 'clean' }, 42, ''],
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
    const many = sanitizeReview({ files_reviewed: Array.from({ length: 600 }, (_, i) => `f${i}.ts`) })
    expect(many.files_reviewed?.length).toBe(500)
  })
})

describe('sanitizeFindings', () => {
  test('invalid items ignored, file+message required', () => {
    expect(sanitizeFindings('nope')).toEqual([])
    expect(sanitizeFindings([null, 42, { file: 'a.ts' }, { message: 'm' }])).toEqual([])
  })

  test('unknown severity: info, unknown kind: absent', () => {
    const [f] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'blocker', kind: 'typo' }])
    expect(f?.severity).toBe('info')
    expect(f?.kind).toBeUndefined()
  })

  test('invalid line ignored, endLine < line ignored', () => {
    const [f] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'minor', line: -3, endLine: 9 }])
    expect(f?.line).toBeUndefined()
    expect(f?.endLine).toBeUndefined()
    const [g] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'minor', line: 10, endLine: 4 }])
    expect(g?.line).toBe(10)
    expect(g?.endLine).toBeUndefined()
  })

  test('consensus kept only when strictly true', () => {
    const [f] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'minor', consensus: true }])
    expect(f?.consensus).toBe(true)
    const [g] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'minor', consensus: 'yes' }])
    expect(g?.consensus).toBeUndefined()
    const [h] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'minor' }])
    expect(h?.consensus).toBeUndefined()
  })

  test('praise and why findings are forced to info severity', () => {
    const [praise] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'critical', kind: 'praise' }])
    expect(praise?.severity).toBe('info')
    const [why] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'major', kind: 'why' }])
    expect(why?.severity).toBe('info')
    const [bug] = sanitizeFindings([{ file: 'a.ts', message: 'm', severity: 'critical', kind: 'security' }])
    expect(bug?.severity).toBe('critical')
  })

  test('title/suggestion truncated', () => {
    const [f] = sanitizeFindings([
      { file: 'a.ts', message: 'm', severity: 'minor', title: 't'.repeat(500), suggestion: 's'.repeat(9000) },
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
    const items = Array.from({ length: 6 }, (_, i) => ({ point: `p${i}`, risk: 'weird', step_ref: i }))
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
    expect(sanitizeNarrative({ steps: [{ title: 'Ch' }], prologue: {} }, 0)?.prologue).toBeUndefined()
    const kcs = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, detail: 'd' }))
    const n = sanitizeNarrative({ steps: [{ title: 'Ch' }], prologue: { why: 'w', key_changes: [...kcs, { detail: 'orphan' }] } }, 0)
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
    const record = sanitizeRecord({ commits: ['a', 2, 'b'], diff: 42, review: { verdict: 'approve' } })
    expect(record?.commits).toEqual(['a', 'b'])
    expect(record?.diff).toBe('')
    expect(record?.review.verdict).toBe('approve')
  })

  test('dual stats kept when they are non-negative integers, dropped otherwise', () => {
    const dual = { merged: 2, rejected: 1, added_by_b: 3 }
    expect(sanitizeRecord({ meta: { dual } })?.meta.dual).toEqual(dual)
    expect(sanitizeRecord({ meta: { dual: { merged: -1, rejected: 0, added_by_b: 0 } } })?.meta.dual).toBeUndefined()
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
    expect(detectDiffSecrets(diffFor('.env', ['A=1']))).toContainEqual({ file: '.env', reason: 'filename', detail: '.env' })
    expect(detectDiffSecrets(diffFor('config/db.pem', ['x']))[0]?.reason).toBe('filename')
    expect(detectDiffSecrets(diffFor('service/id_rsa', ['x']))[0]?.reason).toBe('filename')
    expect(detectDiffSecrets(diffFor('.env.local', ['A=1'])).some((m) => m.reason === 'filename')).toBe(true)
    expect(detectDiffSecrets(diffFor('.env.example', ['A=1']))).toEqual([])
  })

  test('credentials in content are flagged on added and removed lines', () => {
    const added = detectDiffSecrets(diffFor('src/app.ts', ['const k = "AKIAIOSFODNN7EXAMPLE"']))
    expect(added).toContainEqual({ file: 'src/app.ts', reason: 'content', detail: 'an AWS access key id' })
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
    const diff = '--- a/.env\t2026-07-14 00:00:00\n+++ b/.env\t2026-07-14 00:00:00\n@@ -1 +1 @@\n-A=1\n+A=2\n'
    expect(detectDiffSecrets(diff)).toContainEqual({ file: '.env', reason: 'filename', detail: '.env' })
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

function reviewWith(findings: Finding[], overrides: Partial<SanitizedReview> = {}): SanitizedReview {
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
      reviewWith([{ file: 'src/auth.ts', line: 99, endLine: 100, severity: 'major', message: 'm' }]),
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
        { file: 'src/auth.ts', line: 11, severity: 'critical', kind: 'security', message: 'louder duplicate' },
        { file: 'src/auth.ts', line: 11, severity: 'minor', kind: 'perf', message: 'different kind, kept' },
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
        { file: 'src/auth.ts', line: 11, severity: 'minor', kind: 'design', message: 'duplicate', consensus: true },
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
          { file: 'src/auth.ts', line: 11, severity: 'minor', kind: 'perf', message: 'merged into 1' },
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
      reviewWith([{ file: 'src/auth.ts', line: 11, severity: 'critical', message: 'm' }], { verdict: 'approve' }),
      GROUND_DIFF,
    )
    expect(review.verdict).toBe('request_changes')
    expect(report.verdict_escalated).toBe(true)
  })

  test('approve stays approve when the only critical finding was dropped', () => {
    const { review, report } = groundReview(
      reviewWith([{ file: 'src/ghost.ts', severity: 'critical', message: 'm' }], { verdict: 'approve' }),
      GROUND_DIFF,
    )
    expect(review.verdict).toBe('approve')
    expect(report.verdict_escalated).toBe(false)
  })

  test('unparseable diff: review returned unchanged', () => {
    const findings: Finding[] = [{ file: 'src/ghost.ts', line: 1, severity: 'critical', message: 'm' }]
    const input = reviewWith(findings, { verdict: 'approve' })
    const { review, report } = groundReview(input, 'not a diff at all')
    expect(review).toEqual(input)
    expect(report.dropped).toEqual([])
    expect(report.verdict_escalated).toBe(false)
  })

  test('a deanchored finding still marks its file as findings', () => {
    const { review } = groundReview(
      reviewWith(
        [{ file: 'src/auth.ts', line: 99999, severity: 'major', message: 'm' }],
        {
          files_reviewed: [
            { path: 'src/auth.ts', status: 'findings' },
            { path: 'docs/removed.md', status: 'clean' },
          ],
        },
      ),
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
      reviewWith(
        [{ file: 'src/ghost.ts', severity: 'major', message: 'dropped with its file' }],
        { files_reviewed: [{ path: 'src/ghost.ts', status: 'findings' }] },
      ),
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
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value)
        else walk(value)
      }
    }
    walk(reviewRecordSchema)
    const defs = new Set(Object.keys(reviewRecordSchema.$defs))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(defs.has(ref.replace('#/$defs/', ''))).toBe(true)
  })

  test('top-level required keys all exist in properties', () => {
    const props = new Set(Object.keys(reviewRecordSchema.properties))
    for (const key of reviewRecordSchema.required) expect(props.has(key)).toBe(true)
  })
})

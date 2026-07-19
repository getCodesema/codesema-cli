import { describe, expect, test } from 'bun:test'
import type { Finding, SanitizedReview } from './contract.js'
import {
  assembleDualReview,
  dedupeExactCrossLane,
  judgeCommandFor,
  judgeInstructions,
  parsePartialJudge,
  prosecutorInstructions,
  sanitizeJudgeOutput,
  worstVerdict,
} from './dual.js'

function reviewWith(findings: Finding[], overrides: Partial<SanitizedReview> = {}): SanitizedReview {
  return { verdict: 'comment', summary: 'summary A', findings, narrative: null, ...overrides }
}

describe('judgeCommandFor', () => {
  test('claude: model swapped for sonnet', () => {
    expect(judgeCommandFor('claude -p --model opus --effort high')).toBe('claude -p --model sonnet --effort high')
  })

  test('claude without a model flag: sonnet appended', () => {
    expect(judgeCommandFor('claude -p')).toBe('claude -p --model sonnet')
  })

  test('claude: --model=value form swapped too, never doubled', () => {
    expect(judgeCommandFor('claude -p --model=opus --effort high')).toBe('claude -p --model sonnet --effort high')
    expect(judgeCommandFor('codex exec -m=gpt-5.6-sol -')).toBe('codex exec -m gpt-5.5 -')
  })

  test('codex: model swapped, stdin marker stays last', () => {
    expect(judgeCommandFor('codex exec -m gpt-5.6-sol -')).toBe('codex exec -m gpt-5.5 -')
    expect(judgeCommandFor('codex exec -')).toBe('codex exec -m gpt-5.5 -')
  })

  test('gemini: mid-tier model', () => {
    expect(judgeCommandFor('gemini -m gemini-3-pro-preview')).toBe('gemini -m gemini-2.5-pro')
  })

  test('custom command unchanged', () => {
    expect(judgeCommandFor('opencode run "$(cat)"')).toBe('opencode run "$(cat)"')
  })
})

describe('sanitizeJudgeOutput', () => {
  test('valid decisions kept, ids bounded by the candidate counts', () => {
    const out = sanitizeJudgeOutput(
      {
        summary: 'merged',
        decisions: [
          { id: 'A0', action: 'keep' },
          { id: 'B1', action: 'reject', reason: 'disproved by the diff' },
          { id: 'A9', action: 'keep' },
          { id: 'C0', action: 'keep' },
          { id: 'B0', action: 'nuke' },
        ],
      },
      2,
      2,
    )
    expect(out.summary).toBe('merged')
    expect(out.decisions).toEqual([
      { id: 'A0', action: 'keep' },
      { id: 'B1', action: 'reject', reason: 'disproved by the diff' },
    ])
  })

  test('duplicate_of validated and self-references dropped', () => {
    const out = sanitizeJudgeOutput(
      {
        decisions: [
          { id: 'B0', action: 'keep', duplicate_of: 'A1' },
          { id: 'B1', action: 'keep', duplicate_of: 'B1' },
          { id: 'A0', action: 'keep', duplicate_of: 'Z9' },
        ],
      },
      2,
      2,
    )
    expect(out.decisions[0]).toEqual({ id: 'B0', action: 'keep', duplicate_of: 'A1' })
    expect(out.decisions[1]).toEqual({ id: 'B1', action: 'keep' })
    expect(out.decisions[2]).toEqual({ id: 'A0', action: 'keep' })
  })

  test('garbage input: empty decisions', () => {
    expect(sanitizeJudgeOutput('junk', 1, 1).decisions).toEqual([])
    expect(sanitizeJudgeOutput({ decisions: 'none' }, 1, 1).decisions).toEqual([])
  })

  test('duplicate_of closing a cycle is dropped, decision kept', () => {
    const out = sanitizeJudgeOutput(
      {
        decisions: [
          { id: 'A0', action: 'keep', duplicate_of: 'B0' },
          { id: 'B0', action: 'keep', duplicate_of: 'A0' },
          { id: 'A1', action: 'keep', duplicate_of: 'B1' },
          { id: 'B1', action: 'keep', duplicate_of: 'A0' },
        ],
      },
      2,
      2,
    )
    expect(out.decisions).toEqual([
      { id: 'A0', action: 'keep', duplicate_of: 'B0' },
      { id: 'B0', action: 'keep' },
      { id: 'A1', action: 'keep', duplicate_of: 'B1' },
      { id: 'B1', action: 'keep', duplicate_of: 'A0' },
    ])
  })

  test('longer duplicate_of cycles are broken at the closing link', () => {
    const out = sanitizeJudgeOutput(
      {
        decisions: [
          { id: 'A0', action: 'keep', duplicate_of: 'B0' },
          { id: 'B0', action: 'keep', duplicate_of: 'A1' },
          { id: 'A1', action: 'keep', duplicate_of: 'A0' },
        ],
      },
      2,
      1,
    )
    expect(out.decisions[2]).toEqual({ id: 'A1', action: 'keep' })
  })
})

describe('worstVerdict', () => {
  test('request_changes dominates, then comment, then approve', () => {
    expect(worstVerdict('approve', 'request_changes')).toBe('request_changes')
    expect(worstVerdict('comment', 'approve')).toBe('comment')
    expect(worstVerdict('approve', 'approve')).toBe('approve')
  })
})

describe('assembleDualReview', () => {
  const a0: Finding = { file: 'src/x.ts', line: 5, severity: 'major', kind: 'design', message: 'A0 issue' }
  const a1: Finding = { file: 'src/x.ts', line: 9, severity: 'minor', kind: 'convention', message: 'A1 nit' }
  const b0: Finding = { file: 'src/x.ts', line: 5, severity: 'critical', kind: 'design', message: 'B0 same as A0' }
  const b1: Finding = { file: 'src/y.ts', line: 2, severity: 'major', kind: 'perf', message: 'B1 new issue' }

  test('duplicates merge into the A finding with consensus and the highest severity', () => {
    const { review, stats } = assembleDualReview(
      reviewWith([a0, a1], { verdict: 'approve' }),
      reviewWith([b0, b1], { verdict: 'comment', summary: 'summary B' }),
      {
        summary: 'judge summary',
        decisions: [
          { id: 'A0', action: 'keep' },
          { id: 'A1', action: 'keep' },
          { id: 'B0', action: 'keep', duplicate_of: 'A0' },
          { id: 'B1', action: 'keep' },
        ],
      },
    )
    expect(review.findings).toHaveLength(3)
    expect(review.findings[0]).toEqual({ ...a0, severity: 'critical', consensus: true })
    expect(review.findings[1]).toEqual(a1)
    expect(review.findings[2]).toEqual(b1)
    expect(review.summary).toBe('judge summary')
    expect(review.verdict).toBe('comment')
    expect(stats).toEqual({ merged: 1, rejected: 0, added_by_b: 1 })
  })

  test('rejected findings are dropped, except security ones', () => {
    const secure: Finding = { file: 'src/x.ts', line: 5, severity: 'major', kind: 'security', message: 'injection' }
    const { review, stats } = assembleDualReview(
      reviewWith([a0, secure]),
      reviewWith([b1]),
      {
        decisions: [
          { id: 'A0', action: 'reject', reason: 'not a real problem' },
          { id: 'A1', action: 'reject', reason: 'the judge cannot silence security' },
          { id: 'B0', action: 'reject', reason: 'noise' },
        ],
      },
    )
    expect(review.findings).toEqual([secure])
    expect(stats.rejected).toBe(2)
  })

  test('candidates without a decision are kept', () => {
    const { review } = assembleDualReview(reviewWith([a0]), reviewWith([b1]), { decisions: [] })
    expect(review.findings).toEqual([a0, b1])
  })

  test('judge severity recalibration applies to the kept representative', () => {
    const { review } = assembleDualReview(reviewWith([a0]), reviewWith([]), {
      decisions: [{ id: 'A0', action: 'keep', severity: 'minor' }],
    })
    expect(review.findings[0]?.severity).toBe('minor')
  })

  test('narrative finding_refs remapped after rejections and B additions', () => {
    const narrative = {
      intent: 'i',
      confidence: 'high' as const,
      steps: [{ title: 'S', rationale: 'r', files: ['src/x.ts'], finding_refs: [0, 1] }],
      review_first: [],
    }
    const { review } = assembleDualReview(
      reviewWith([a0, a1], { narrative }),
      reviewWith([b1]),
      {
        decisions: [
          { id: 'A0', action: 'reject', reason: 'noise' },
          { id: 'A1', action: 'keep' },
          { id: 'B0', action: 'keep' },
        ],
      },
    )
    expect(review.findings).toEqual([a1, b1])
    expect(review.narrative?.steps[0]?.finding_refs).toEqual([0])
  })

  test('A duplicate of B: the judge-kept B finding wins, as a merge, not an addition', () => {
    const { review, stats } = assembleDualReview(reviewWith([a0]), reviewWith([b0]), {
      decisions: [{ id: 'A0', action: 'keep', duplicate_of: 'B0' }],
    })
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]?.message).toBe('B0 same as A0')
    expect(review.findings[0]?.severity).toBe('critical')
    expect(review.findings[0]?.consensus).toBe(true)
    expect(stats).toEqual({ merged: 1, rejected: 0, added_by_b: 0 })
  })

  test('narrative refs follow an A finding merged into a judge-kept B finding', () => {
    const narrative = {
      intent: 'i',
      confidence: 'high' as const,
      steps: [{ title: 'S', rationale: 'r', files: ['src/x.ts'], finding_refs: [0, 1] }],
      review_first: [],
    }
    const { review } = assembleDualReview(reviewWith([a0, a1], { narrative }), reviewWith([b0]), {
      decisions: [{ id: 'A0', action: 'keep', duplicate_of: 'B0' }],
    })
    expect(review.findings.map((f) => f.message)).toEqual(['A1 nit', 'B0 same as A0'])
    expect(review.narrative?.steps[0]?.finding_refs).toEqual([1, 0])
  })

  test('empty judge summary falls back to reviewer A summary', () => {
    const { review } = assembleDualReview(reviewWith([a0]), reviewWith([]), { decisions: [] })
    expect(review.summary).toBe('summary A')
  })

  test('a lane whose findings were all rejected no longer drives the verdict', () => {
    const { review } = assembleDualReview(
      reviewWith([], { verdict: 'approve' }),
      reviewWith([b1], { verdict: 'request_changes' }),
      { decisions: [{ id: 'B0', action: 'reject', reason: 'noise' }] },
    )
    expect(review.findings).toEqual([])
    expect(review.verdict).toBe('approve')
  })

  test('both lanes wiped by the judge: neutral comment verdict', () => {
    const { review } = assembleDualReview(
      reviewWith([a0], { verdict: 'request_changes' }),
      reviewWith([b1], { verdict: 'request_changes' }),
      {
        decisions: [
          { id: 'A0', action: 'reject', reason: 'noise' },
          { id: 'B0', action: 'reject', reason: 'noise' },
        ],
      },
    )
    expect(review.findings).toEqual([])
    expect(review.verdict).toBe('comment')
  })

  test('security member becomes the representative when the judge rejected the group root', () => {
    const secure: Finding = { file: 'src/x.ts', line: 5, severity: 'major', kind: 'security', message: 'injection' }
    const { review } = assembleDualReview(reviewWith([a0]), reviewWith([secure]), {
      decisions: [
        { id: 'A0', action: 'reject', reason: 'noise' },
        { id: 'B0', action: 'keep', duplicate_of: 'A0' },
      ],
    })
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]?.kind).toBe('security')
    expect(review.findings[0]?.message).toBe('injection')
    expect(review.findings[0]?.consensus).toBe(true)
  })

  test('merged review carries the union of both lanes files_reviewed, findings status winning', () => {
    const { review } = assembleDualReview(
      reviewWith([], {
        files_reviewed: [
          { path: 'a.ts', status: 'clean' },
          { path: 'b.ts', status: 'findings' },
        ],
      }),
      reviewWith([], {
        files_reviewed: [
          { path: 'b.ts', status: 'clean' },
          { path: 'c.ts', status: 'clean' },
        ],
      }),
      { decisions: [] },
    )
    expect(review.files_reviewed).toEqual([
      { path: 'a.ts', status: 'clean' },
      { path: 'b.ts', status: 'findings' },
      { path: 'c.ts', status: 'clean' },
    ])
  })

  test('files_reviewed stays absent when neither lane reported it', () => {
    const { review } = assembleDualReview(reviewWith([]), reviewWith([]), { decisions: [] })
    expect(review.files_reviewed).toBeUndefined()
  })

  test('a pre-tagged consensus finding survives a judge failure fallback', () => {
    const tagged: Finding = { ...a0, consensus: true }
    const { review } = assembleDualReview(reviewWith([tagged]), reviewWith([]), { decisions: [] })
    expect(review.findings).toEqual([tagged])
  })

  test('explicitly kept member survives when the judge rejected the group root', () => {
    const { review, stats } = assembleDualReview(reviewWith([a0]), reviewWith([b0]), {
      decisions: [
        { id: 'A0', action: 'reject', reason: 'noise' },
        { id: 'B0', action: 'keep', duplicate_of: 'A0' },
      ],
    })
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]?.message).toBe('B0 same as A0')
    expect(review.findings[0]?.consensus).toBe(true)
    expect(stats.rejected).toBe(0)
    expect(stats.merged).toBe(1)
  })
})

describe('dedupeExactCrossLane', () => {
  const anchored: Finding = { file: 'src/x.ts', line: 5, severity: 'major', kind: 'design', message: 'A side' }

  test('exact file+line+kind duplicate: B copy removed, A copy tagged consensus with max severity', () => {
    const twin: Finding = { ...anchored, severity: 'critical', message: 'B side' }
    const other: Finding = { file: 'src/y.ts', line: 2, severity: 'minor', kind: 'perf', message: 'B only' }
    const { a, b, merged } = dedupeExactCrossLane(reviewWith([anchored]), reviewWith([twin, other]))
    expect(a.findings).toEqual([{ ...anchored, severity: 'critical', consensus: true }])
    expect(b.findings).toEqual([other])
    expect(merged).toBe(1)
  })

  test('different line or kind: nothing merges', () => {
    const shifted: Finding = { ...anchored, line: 6 }
    const otherKind: Finding = { ...anchored, kind: 'perf' }
    const { a, b, merged } = dedupeExactCrossLane(reviewWith([anchored]), reviewWith([shifted, otherKind]))
    expect(a.findings).toEqual([anchored])
    expect(b.findings).toEqual([shifted, otherKind])
    expect(merged).toBe(0)
  })

  test('unanchored findings never merge', () => {
    const fileLevel: Finding = { file: 'src/x.ts', severity: 'major', kind: 'design', message: 'no line' }
    const { a, b, merged } = dedupeExactCrossLane(reviewWith([fileLevel]), reviewWith([{ ...fileLevel }]))
    expect(a.findings).toEqual([fileLevel])
    expect(b.findings).toEqual([{ ...fileLevel }])
    expect(merged).toBe(0)
  })
})

describe('prompt hardening', () => {
  test('prosecutor prompt carries sweep, scenario, severity and coverage rules', () => {
    const p = prosecutorInstructions('English')
    expect(p).toContain('files_reviewed')
    expect(p).toContain('every hunk of every file')
    expect(p).toContain('failure scenario')
    expect(p).toContain('no maximum number of findings')
    expect(p).toContain('critical = data loss')
    expect(p).toContain('omit "line" rather than guessing')
    expect(p).toContain('settle EVERY file explicitly')
    expect(p).toContain('"status": "clean" | "findings"')
    expect(p).toContain('REFUTE every finding')
    expect(p).toContain('HUNT them first')
    expect(p).toContain('[Cn]')
  })

  test('prosecutor verdict is scoped to what the input can prove', () => {
    const p = prosecutorInstructions('English')
    expect(p).toContain('weighs ONLY what you could verify in the provided input')
    expect(p).toContain('never lowers the verdict')
  })

  test('judge prompt requires citing the disproving diff lines and shares the severity scale', () => {
    const j = judgeInstructions('English')
    expect(j).toContain('cite the exact diff line')
    expect(j).toContain('critical = data loss')
  })
})

describe('parsePartialJudge', () => {
  test('complete decision objects extracted from a truncated stream', () => {
    const text = '{"summary":"s","decisions":[{"id":"A0","action":"keep"},{"id":"B0","action":"reject","reason":"no"},{"id":"B1","act'
    const partial = parsePartialJudge(text, 2, 2)
    expect(partial?.decisions).toEqual([
      { id: 'A0', action: 'keep' },
      { id: 'B0', action: 'reject', reason: 'no' },
    ])
  })

  test('no decisions yet: null', () => {
    expect(parsePartialJudge('{"summary":"thinking', 1, 1)).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import type { EvidenceRecord, ProofIntent } from './contract.js'
import { buildProofChapter } from './task-proof-chapter.js'

function baseInput() {
  return {
    uiFiles: [] as string[],
    otherCount: 0,
    intent: null as ProofIntent | null,
    evidence: null as EvidenceRecord | null,
    declared: false,
  }
}

describe('buildProofChapter', () => {
  test('the mandatory heading, grid and output requirement are always present', () => {
    const chapter = buildProofChapter(baseInput())
    expect(chapter).toContain('Visual proof (MANDATORY chapter)')
    expect(chapter).toContain('"screenshot" naming the pages')
    expect(chapter).toContain('"journey" naming the spec')
    expect(chapter).toContain('"none", with the reason stated')
    expect(chapter).toContain('doubt: proof, not "none"')
    expect(chapter).toContain('"proof_review"')
    expect(chapter).toContain('"kind": "design"')
    expect(chapter).toContain('"severity": "major"')
  })

  test('lists the touched UI files, or "none" when there are none', () => {
    expect(buildProofChapter(baseInput())).toContain('UI files touched by this diff: none')
    expect(
      buildProofChapter({ ...baseInput(), uiFiles: ['src/App.vue', 'src/Foo.tsx'] }),
    ).toContain('UI files touched by this diff: src/App.vue, src/Foo.tsx')
  })

  test('reports the count of other, non-UI files touched', () => {
    expect(buildProofChapter({ ...baseInput(), otherCount: 3 })).toContain('other files touched: 3')
  })

  test('undeclared: states plainly that the turn never declared a proof', () => {
    const chapter = buildProofChapter({ ...baseInput(), declared: false, intent: null })
    expect(chapter).toContain('declaration: the agent did not declare a proof this turn')
  })

  test('declared none: states the kind and the reason', () => {
    const chapter = buildProofChapter({
      ...baseInput(),
      declared: true,
      intent: { kind: 'none', reason: 'pure refactor, no rendered difference' },
    })
    expect(chapter).toContain(
      'declaration: kind=none, reason: "pure refactor, no rendered difference"',
    )
  })

  test('declared screenshot: states the pages', () => {
    const chapter = buildProofChapter({
      ...baseInput(),
      declared: true,
      intent: { kind: 'screenshot', reason: 'new settings row', pages: ['/settings', '/profile'] },
    })
    expect(chapter).toContain(
      'declaration: kind=screenshot pages: /settings, /profile, reason: "new settings row"',
    )
  })

  test('declared journey: states the spec', () => {
    const chapter = buildProofChapter({
      ...baseInput(),
      declared: true,
      intent: { kind: 'journey', reason: 'multi-step checkout', journey: 'tests/checkout.spec.ts' },
    })
    expect(chapter).toContain(
      'declaration: kind=journey spec: tests/checkout.spec.ts, reason: "multi-step checkout"',
    )
  })

  test('no evidence for this commit: states it plainly', () => {
    const chapter = buildProofChapter({ ...baseInput(), evidence: null })
    expect(chapter).toContain('proof produced: no proof for this commit')
  })

  test('evidence present: states the status and every item', () => {
    const evidence: EvidenceRecord = {
      version: 1,
      status: 'passed',
      reason: null,
      head_sha: 'a'.repeat(40),
      items: [
        {
          kind: 'screenshot',
          path: 'p0.png',
          bytes: 1234,
          turn: 2,
          created_at: '2026-08-01T00:00:00.000Z',
        },
        {
          kind: 'video',
          path: 'v0.webm',
          bytes: 5678,
          turn: 2,
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    }
    const chapter = buildProofChapter({ ...baseInput(), evidence })
    expect(chapter).toContain('proof produced: status=passed')
    expect(chapter).toContain('kind=screenshot bytes=1234 turn=2')
    expect(chapter).toContain('kind=video bytes=5678 turn=2')
  })

  test('a failed or declined proof carries its reason', () => {
    const evidence: EvidenceRecord = {
      version: 1,
      status: 'failed',
      reason: 'replay timed out after 120000ms',
      head_sha: 'a'.repeat(40),
      items: [],
    }
    const chapter = buildProofChapter({ ...baseInput(), evidence })
    expect(chapter).toContain('status=failed')
    expect(chapter).toContain('reason: replay timed out after 120000ms')
  })
})

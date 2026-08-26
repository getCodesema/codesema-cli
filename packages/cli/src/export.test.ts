import { afterEach, describe, expect, test } from 'bun:test'
import { sanitizeRecord } from './contract.js'
import { renderMarkdown } from './export.js'
import { setLanguage } from './i18n.js'

afterEach(() => setLanguage(null))

function record(review: Record<string, unknown>) {
  const sanitized = sanitizeRecord({
    meta: { branch: 'feat/x', target: 'develop' },
    review,
  })
  expect(sanitized).not.toBeNull()
  return sanitized!
}

describe('renderMarkdown', () => {
  test('labels every verdict distinctly', () => {
    setLanguage('en')
    expect(renderMarkdown(record({ verdict: 'approve', summary: 's' }))).toContain('Approved')
    expect(renderMarkdown(record({ verdict: 'request_changes', summary: 's' }))).toContain(
      'Changes requested',
    )
    expect(renderMarkdown(record({ verdict: 'comment', summary: 's' }))).toContain('Comment')
  })

  test('renders findings with their anchor, badge, title and suggestion', () => {
    setLanguage('en')
    const markdown = renderMarkdown(
      record({
        verdict: 'request_changes',
        summary: 'needs work',
        findings: [
          {
            file: 'src/a.ts',
            line: 3,
            endLine: 5,
            severity: 'major',
            kind: 'security',
            title: 'T',
            message: 'M',
            suggestion: 'S',
          },
          { file: 'src/b.ts', severity: 'info', message: 'bare' },
        ],
      }),
    )
    expect(markdown).toContain('### 1. `src/a.ts:3-5` — major / security')
    expect(markdown).toContain('**T**')
    expect(markdown).toContain('```suggestion\nS\n```')
    expect(markdown).toContain('### 2. `src/b.ts` — info')
    expect(markdown).toContain('needs work')
  })

  test('renders the full narrative: intent, prologue, review-first list and steps', () => {
    setLanguage('en')
    const markdown = renderMarkdown(
      record({
        verdict: 'approve',
        summary: 's',
        findings: [{ file: 'src/a.ts', severity: 'minor', message: 'M' }],
        narrative: {
          intent: 'Ship the thing',
          confidence: 'high',
          prologue: {
            why: 'Because',
            what: 'A change',
            key_changes: [{ title: 'K1', detail: 'D1' }, { title: 'K2' }],
          },
          review_first: [
            { point: 'Check the lock', risk: 'high', step_ref: null, file: 'src/a.ts' },
            { point: 'Then the rest', risk: 'medium', step_ref: null, file: null },
          ],
          steps: [
            {
              title: 'S1',
              risk: 'low',
              rationale: 'R',
              take: 'TK',
              check: 'C',
              files: ['src/a.ts'],
              finding_refs: [0],
            },
            { title: 'S2', files: [], finding_refs: [] },
          ],
        },
      }),
    )
    expect(markdown).toContain('**Intent:** Ship the thing')
    expect(markdown).toContain('**Why:** Because')
    expect(markdown).toContain('**What:** A change')
    expect(markdown).toContain('- **K1** — D1')
    expect(markdown).toContain('- **K2**')
    expect(markdown).toContain('1. **[high]** Check the lock (`src/a.ts`)')
    expect(markdown).toContain('2. **[medium]** Then the rest')
    expect(markdown).toContain('### 1. S1')
    expect(markdown).toContain('> TK')
    expect(markdown).toContain('- [ ]')
    expect(markdown).toContain('#1')
    expect(markdown).toContain('### 2. S2')
  })
})

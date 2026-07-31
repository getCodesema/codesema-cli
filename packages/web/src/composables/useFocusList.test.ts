import { describe, expect, test } from 'bun:test'
import { parseDiff, type Finding } from './useDiff'
import { actionableFindings, excerptFor } from './useFocusList'

function finding(partial: Partial<Finding>): Finding {
  return { file: 'src/a.ts', severity: 'minor', message: 'm', ...partial }
}

describe('actionableFindings', () => {
  test('keeps only actionable findings, worst severity first, stable within a tier', () => {
    const findings: Finding[] = [
      finding({ id: 0, severity: 'minor', title: 'first minor' }),
      finding({ id: 1, severity: 'info' }),
      finding({ id: 2, severity: 'critical' }),
      finding({ id: 3, severity: 'major', kind: 'praise' }),
      finding({ id: 4, severity: 'minor', title: 'second minor' }),
      finding({ id: 5, severity: 'major' }),
    ]
    expect(actionableFindings(findings).map((f) => f.id)).toEqual([2, 5, 0, 4])
  })
})

const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,8 +1,9 @@
 line one
 line two
-old three
+new three
+new four
 line five
 line six
 line seven
 line eight
`

describe('excerptFor', () => {
  test('returns a window of rows around the finding line, anchored on the new file side', () => {
    const parsed = parseDiff(DIFF, [])
    const rows = excerptFor(parsed.files, finding({ line: 3 }), 2)
    expect(rows).not.toBeNull()
    expect(rows!.map((r) => r.c)).toEqual([
      'line two',
      'old three',
      'new three',
      'new four',
      'line five',
    ])
  })

  test('extends the window to endLine', () => {
    const parsed = parseDiff(DIFF, [])
    const rows = excerptFor(parsed.files, finding({ line: 3, endLine: 5 }), 1)
    expect(rows!.map((r) => r.c)).toEqual([
      'old three',
      'new three',
      'new four',
      'line five',
      'line six',
    ])
  })

  test('null when the line is outside the hunks', () => {
    const parsed = parseDiff(DIFF, [])
    expect(excerptFor(parsed.files, finding({ line: 99 }), 0)).toBeNull()
  })

  test('null without a line anchor or when the file is not in the diff', () => {
    const parsed = parseDiff(DIFF, [])
    expect(excerptFor(parsed.files, finding({}))).toBeNull()
    expect(excerptFor(parsed.files, finding({ file: 'src/missing.ts', line: 3 }))).toBeNull()
  })
})

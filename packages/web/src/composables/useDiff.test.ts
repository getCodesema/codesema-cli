import { describe, expect, test } from 'bun:test'
import { collapsedByBudget, parseDiff, pickFiles, sameFile, toSplit, type Finding } from './useDiff'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0000000..1111111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 ctx1
-old line
+new line
+added line
 ctx2
diff --git a/b.txt b/b.txt
new file mode 100644
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@
+hello
+world
`

function finding(over: Partial<Finding> = {}): Finding {
  return { file: 'src/a.ts', severity: 'minor', message: 'm', ...over }
}

describe('parseDiff', () => {
  test('files, counters and line numbering', () => {
    const { files } = parseDiff(DIFF)
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'b.txt'])
    expect(files[0]).toMatchObject({ addCount: 2, delCount: 1 })
    expect(files[1]).toMatchObject({ addCount: 2, delCount: 0 })
    const rows = files[0]!.rows
    expect(rows[1]).toMatchObject({ kind: 'ctx', oldNo: 10, newNo: 10 })
    expect(rows[2]).toMatchObject({ kind: 'del', oldNo: 11, newNo: null })
    expect(rows[3]).toMatchObject({ kind: 'add', oldNo: null, newNo: 11 })
    expect(rows[5]).toMatchObject({ kind: 'ctx', oldNo: 12, newNo: 13 })
  })

  test('findings: added line -> byLine, deleted line -> negative key, outside diff -> topFindings, unknown file -> unmatched', () => {
    const onAdd = finding({ line: 11 })
    const noLine = finding({ line: 999 })
    const wrongFile = finding({ file: 'zzz.go' })
    const { files, unmatched } = parseDiff(DIFF, [onAdd, noLine, wrongFile])
    expect(files[0]!.byLine[11]).toEqual([onAdd])
    expect(files[0]!.topFindings).toEqual([noLine])
    expect(unmatched).toEqual([wrongFile])
    // deleted file: no newNo matches, so attachment falls back to the negative key (-oldNo)
    const deleted = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`
    const onDel = finding({ file: 'gone.txt', line: 2, message: 'del' })
    const onlyDel = parseDiff(deleted, [onDel])
    expect(onlyDel.files[0]!.path).toBe('gone.txt')
    expect(onlyDel.files[0]!.byLine[-2]).toEqual([onDel])
  })

  test('gaps: before the first hunk and notes attached to hunks', () => {
    const { files } = parseDiff(DIFF, [finding({ line: 11 })])
    const blocks = files[0]!.hunks
    expect(blocks[0]).toEqual({ gap: 9 })
    const rowsBlock = blocks[1] as { rows: { n: number | null; note?: Finding }[] }
    expect(rowsBlock.rows.find((r) => r.n === 11)?.note?.message).toBe('m')
  })
})

describe('sameFile / pickFiles', () => {
  test('sameFile: exact match and path suffix', () => {
    expect(sameFile('src/a.ts', 'src/a.ts')).toBe(true)
    expect(sameFile('repo/src/a.ts', 'src/a.ts')).toBe(true)
    expect(sameFile('src/a.ts', 'b.ts')).toBe(false)
  })

  test('pickFiles: order of only, dedup, missing entries ignored', () => {
    const { files } = parseDiff(DIFF)
    const picked = pickFiles(files, ['b.txt', 'src/a.ts', 'b.txt', 'missing.md'])
    expect(picked.map((f) => f.path)).toEqual(['b.txt', 'src/a.ts'])
  })
})

describe('toSplit', () => {
  test('positional del/add pairing and note emitted after the block', () => {
    const note = finding()
    const rows = [
      { t: 'ctx' as const, o: 1, n: 1, c: 'a' },
      { t: 'del' as const, o: 2, n: null, c: 'b' },
      { t: 'add' as const, o: null, n: 2, c: 'B', note },
      { t: 'add' as const, o: null, n: 3, c: 'C' },
    ]
    const split = toSplit(rows)
    expect(split[0]).toMatchObject({ kind: 'ctx' })
    expect(split[1]).toMatchObject({ kind: 'chg', left: { c: 'b' }, right: { c: 'B' } })
    expect(split[2]).toMatchObject({ kind: 'chg', left: null, right: { c: 'C' } })
    expect(split[3]).toEqual({ kind: 'note', note })
  })
})

describe('collapsedByBudget', () => {
  const file = (path: string, lines: number) => ({ path, addCount: lines, delCount: 0 })

  test('a file above the big-file threshold is collapsed even when first', () => {
    expect(collapsedByBudget([file('big.ts', 501), file('small.ts', 10)])).toEqual(
      new Set(['big.ts']),
    )
  })

  test('a file exactly at the big-file threshold stays expanded', () => {
    expect(collapsedByBudget([file('edge.ts', 500)])).toEqual(new Set())
  })

  test('the file crossing the page budget stays expanded, the following ones collapse', () => {
    const files = [file('a.ts', 60), file('b.ts', 50), file('c.ts', 1), file('d.ts', 1)]
    expect(collapsedByBudget(files, 500, 100)).toEqual(new Set(['c.ts', 'd.ts']))
  })

  test('a collapsed big file still consumes the page budget', () => {
    const mediums = [1, 2, 3, 4, 5].map((i) => file(`m${i}.ts`, 450))
    expect(collapsedByBudget([file('big.ts', 501), ...mediums])).toEqual(
      new Set(['big.ts', 'm5.ts']),
    )
  })
})

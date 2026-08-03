// Hand-copied mirror of FindingSeverity/FindingKind (packages/cli/src/contract.ts).
// Nothing enforces alignment at compile time: update both sides together.
export type FindingSeverity = 'critical' | 'major' | 'minor' | 'info'
export type FindingKind = 'security' | 'perf' | 'convention' | 'design' | 'praise' | 'why'

export type Finding = {
  file: string
  line?: number
  endLine?: number
  severity: FindingSeverity
  kind?: FindingKind
  title?: string
  message: string
  suggestion?: string
  /** Dual review: true when both independent reviewers raised this finding. */
  consensus?: boolean
  /** UI-assigned global index (position in record.review.findings), not part of the contract. */
  id?: number
}

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta'
export type DiffRow = {
  kind: DiffRowKind
  oldNo: number | null
  newNo: number | null
  text: string
}

export type HunkLine = {
  t: 'add' | 'del' | 'ctx'
  o: number | null
  n: number | null
  c: string
  note?: Finding | undefined
}

export type HunkGap = { gap: number }

export type HunkBlock = { rows: HunkLine[] } | HunkGap

export type SplitRowKind = 'ctx' | 'chg' | 'note'

export type SplitRow =
  | { kind: 'ctx'; left: HunkLine; right: HunkLine }
  | { kind: 'chg'; left: HunkLine | null; right: HunkLine | null }
  | { kind: 'note'; note: Finding }

/** Turns a HunkLine array into split-view rows using positional pairing
 *  (del[k] <-> add[k] within consecutive blocks); notes are emitted after their paired block. */
export function toSplit(rows: HunkLine[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    if (!r) {
      break
    }
    if (r.t === 'ctx') {
      out.push({ kind: 'ctx', left: r, right: r })
      i++
      continue
    }
    const dels: HunkLine[] = []
    const adds: HunkLine[] = []
    const notes: Finding[] = []
    while (i < rows.length) {
      const rr = rows[i]
      if (!rr || rr.t === 'ctx') {
        break
      }
      if (rr.t === 'del') {
        dels.push(rr)
      } else {
        adds.push(rr)
      }
      if (rr.note) {
        notes.push(rr.note)
      }
      i++
    }
    const m = Math.max(dels.length, adds.length)
    for (let k = 0; k < m; k++) {
      out.push({ kind: 'chg', left: dels[k] ?? null, right: adds[k] ?? null })
    }
    for (const nt of notes) {
      out.push({ kind: 'note', note: nt })
    }
  }
  return out
}

export type DiffFile = {
  path: string
  rows: DiffRow[]
  topFindings: Finding[]
  byLine: Record<number, Finding[]>
  hunks: HunkBlock[]
  addCount: number
  delCount: number
}
export type ParsedDiff = { files: DiffFile[]; unmatched: Finding[] }

function stripPrefix(p: string): string {
  const t = p.trim()
  if (t.startsWith('a/') || t.startsWith('b/')) {
    return t.slice(2)
  }
  return t
}

export function sameFile(a: string, b: string): boolean {
  if (a === b) {
    return true
  }
  return a.endsWith('/' + b) || b.endsWith('/' + a)
}

// A large file starts collapsed, and so does any file past the cumulative line
// budget already rendered. Without this, an MR with many medium files (none over
// BIG_FILE_LINES) mounts tens of thousands of DOM nodes at once on first render.
export const BIG_FILE_LINES = 500
export const PAGE_LINE_BUDGET = 2000

/** Paths of files to collapse upfront, based on their size and the cumulative budget. */
export function collapsedByBudget(
  files: { path: string; addCount: number; delCount: number }[],
  bigFileLines = BIG_FILE_LINES,
  pageBudget = PAGE_LINE_BUDGET,
): Set<string> {
  const collapsed = new Set<string>()
  let cumulative = 0
  for (const file of files) {
    const lines = file.addCount + file.delCount
    if (lines > bigFileLines || cumulative > pageBudget) {
      collapsed.add(file.path)
    }
    cumulative += lines
  }
  return collapsed
}

/** Subset of parsed files matching `only`, in the order of `only`. */
export function pickFiles(files: DiffFile[], only: string[]): DiffFile[] {
  const picked: DiffFile[] = []
  for (const p of only) {
    const f = files.find((df) => sameFile(df.path, p))
    if (f && !picked.includes(f)) {
      picked.push(f)
    }
  }
  return picked
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(diff: string, findings: Finding[] = []): ParsedDiff {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  let pendingOld: string | null = null

  for (const raw of (diff ?? '').split('\n')) {
    if (raw.startsWith('--- ')) {
      pendingOld = stripPrefix(raw.slice(4))
      continue
    }
    if (raw.startsWith('+++ ')) {
      const newPath = stripPrefix(raw.slice(4))
      const path = newPath !== '/dev/null' ? newPath : (pendingOld ?? newPath)
      current = { path, rows: [], topFindings: [], byLine: {}, hunks: [], addCount: 0, delCount: 0 }
      files.push(current)
      oldNo = 0
      newNo = 0
      continue
    }
    if (
      raw.startsWith('diff --git') ||
      raw.startsWith('index ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity') ||
      raw.startsWith('rename ') ||
      raw.startsWith('copy ')
    ) {
      continue
    }
    if (!current) {
      continue
    }

    const m = HUNK_RE.exec(raw)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[2])
      current.rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw })
      continue
    }
    const c = raw[0]
    if (c === '+') {
      current.rows.push({ kind: 'add', oldNo: null, newNo, text: raw })
      newNo++
    } else if (c === '-') {
      current.rows.push({ kind: 'del', oldNo, newNo: null, text: raw })
      oldNo++
    } else if (c === '\\') {
      current.rows.push({ kind: 'meta', oldNo: null, newNo: null, text: raw })
    } else {
      current.rows.push({ kind: 'ctx', oldNo, newNo, text: raw })
      oldNo++
      newNo++
    }
  }

  const unmatched: Finding[] = []
  for (const f of findings) {
    const file = files.find((df) => sameFile(df.path, f.file))
    if (!file) {
      unmatched.push(f)
      continue
    }
    if (f.line != null && file.rows.some((r) => r.newNo === f.line)) {
      ;(file.byLine[f.line] ??= []).push(f)
    } else if (f.line != null && file.rows.some((r) => r.oldNo === f.line && r.newNo === null)) {
      // Finding on a deleted line: indexed by a negative key so it doesn't collide
      // with newNo keys (always > 0).
      ;(file.byLine[-f.line] ??= []).push(f)
    } else {
      file.topFindings.push(f)
    }
  }

  for (const file of files) {
    file.hunks = buildHunks(file.rows, file.byLine)
    for (const row of file.rows) {
      if (row.kind === 'add') {
        file.addCount++
      } else if (row.kind === 'del') {
        file.delCount++
      }
    }
  }

  return { files, unmatched }
}

/**
 * Turns a file's raw DiffRow[] into HunkBlock[]:
 * - gap before the first hunk if it doesn't start at line 1 (omitted context lines)
 * - gap between hunks (unchanged lines omitted between them)
 * - findings attached to their line as notes
 */
export function buildHunks(rows: DiffRow[], byLine: Record<number, Finding[]> = {}): HunkBlock[] {
  const result: HunkBlock[] = []
  let currentLines: HunkLine[] = []
  let prevHunkLastNewLine: number | null = null
  let prevHunkLastOldLine: number | null = null

  function flushLines() {
    if (currentLines.length > 0) {
      result.push({ rows: currentLines })
      currentLines = []
    }
  }

  for (const row of rows) {
    if (row.kind === 'hunk') {
      flushLines()

      const hunkMatch = HUNK_RE.exec(row.text)
      if (hunkMatch) {
        const hunkOldStart = Number(hunkMatch[1])
        const hunkNewStart = Number(hunkMatch[2])

        if (prevHunkLastNewLine === null) {
          if (hunkNewStart > 1) {
            result.push({ gap: hunkNewStart - 1 })
          }
        } else {
          const lastOld = prevHunkLastOldLine ?? 0
          const gapSize = hunkOldStart - lastOld - 1
          if (gapSize > 0) {
            result.push({ gap: gapSize })
          }
        }
        prevHunkLastOldLine = hunkOldStart - 1
        prevHunkLastNewLine = hunkNewStart - 1
      }
      continue
    }

    if (row.kind === 'meta') {
      continue
    }

    const t: 'add' | 'del' | 'ctx' = row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'ctx'

    const hunkLine: HunkLine = {
      t,
      o: row.oldNo,
      n: row.newNo,
      c: row.text.slice(1),
    }

    // Attach the finding note to its line: add/ctx lines use a positive key (newNo),
    // del lines use a negative key (-oldNo).
    if (row.newNo != null && byLine[row.newNo]?.length) {
      hunkLine.note = byLine[row.newNo]?.[0]
    } else if (row.kind === 'del' && row.oldNo != null && byLine[-row.oldNo]?.length) {
      hunkLine.note = byLine[-row.oldNo]?.[0]
    }

    if (row.kind !== 'add') {
      if (row.oldNo != null) {
        prevHunkLastOldLine = row.oldNo
      }
    }
    if (row.kind !== 'del') {
      if (row.newNo != null) {
        prevHunkLastNewLine = row.newNo
      }
    }

    currentLines.push(hunkLine)
  }

  flushLines()
  return result
}

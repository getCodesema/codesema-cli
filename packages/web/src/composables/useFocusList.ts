import { sameFile, type DiffFile, type Finding, type HunkLine } from './useDiff'
import { isActionable } from './useFixPrompt'

const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 }

/** Findings worth fixing, worst severity first (stable within a severity tier). */
export function actionableFindings(findings: Finding[]): Finding[] {
  return findings
    .filter(isActionable)
    .toSorted((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
}

/** Anchor lookup mirrors parseDiff: new-file lines first, deleted lines as fallback. */
function findAnchor(file: DiffFile, line: number): { rows: HunkLine[]; idx: number } | null {
  for (const block of file.hunks) {
    if (!('rows' in block)) {
      continue
    }
    const idx = block.rows.findIndex((row) => row.n === line)
    if (idx >= 0) {
      return { rows: block.rows, idx }
    }
  }
  for (const block of file.hunks) {
    if (!('rows' in block)) {
      continue
    }
    const idx = block.rows.findIndex((row) => row.t === 'del' && row.o === line)
    if (idx >= 0) {
      return { rows: block.rows, idx }
    }
  }
  return null
}

/** Diff rows around the finding's anchor (through endLine when present), or null when unanchorable. */
export function excerptFor(files: DiffFile[], finding: Finding, context = 4): HunkLine[] | null {
  if (finding.line == null) {
    return null
  }
  const file = files.find((f) => sameFile(f.path, finding.file))
  if (!file) {
    return null
  }
  const anchor = findAnchor(file, finding.line)
  if (!anchor) {
    return null
  }
  const { rows, idx } = anchor
  const endLine = finding.endLine ?? finding.line
  let endIdx = idx
  for (let i = idx; i < rows.length; i++) {
    if (rows[i]?.n === endLine) {
      endIdx = i
      break
    }
  }
  return rows.slice(Math.max(0, idx - context), Math.min(rows.length, endIdx + context + 1))
}

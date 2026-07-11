// Parseur de diff unifié → structure rendable (fichiers / hunks / lignes), avec
// rattachement des findings à la bonne ligne. Partagé entre DiffView et le shell.

export type Finding = {
  file: string
  line?: number
  endLine?: number
  severity: string
  kind?: 'security' | 'perf' | 'convention' | 'design' | 'praise' | 'why'
  title?: string
  message: string
  suggestion?: string
}

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta'
export type DiffRow = { kind: DiffRowKind; oldNo: number | null; newNo: number | null; text: string }

// ── Hunk structuré (après groupement + gaps) ────────────────────────────────

/** Ligne diff enrichie pour le rendu (note rattachée) */
export type HunkLine = {
  t: 'add' | 'del' | 'ctx'
  o: number | null
  n: number | null
  c: string
  note?: Finding
}

/** Bloc gap entre hunks */
export type HunkGap = { gap: number }

/** Un hunk = tableau de HunkLine, ou un gap */
export type HunkBlock = { rows: HunkLine[] } | HunkGap

// ── Ligne split (après toSplit) ──────────────────────────────────────────────

export type SplitRowKind = 'ctx' | 'chg' | 'note'

export type SplitRow =
  | { kind: 'ctx'; left: HunkLine; right: HunkLine }
  | { kind: 'chg'; left: HunkLine | null; right: HunkLine | null }
  | { kind: 'note'; note: Finding }

/** Transforme un tableau de HunkLine en rows split-view (algo appariement positionnel
 *  del[k] ↔ add[k] par blocs consécutifs, notes émises après le bloc apparié). */
export function toSplit(rows: HunkLine[]): SplitRow[] {
  const out: SplitRow[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]!
    if (r.t === 'ctx') {
      out.push({ kind: 'ctx', left: r, right: r })
      i++
      continue
    }
    const dels: HunkLine[] = []
    const adds: HunkLine[] = []
    const notes: Finding[] = []
    while (i < rows.length) {
      const rr = rows[i]!
      if (rr.t === 'ctx') break
      if (rr.t === 'del') dels.push(rr)
      else adds.push(rr)
      if (rr.note) notes.push(rr.note)
      i++
    }
    const m = Math.max(dels.length, adds.length)
    for (let k = 0; k < m; k++) {
      out.push({ kind: 'chg', left: dels[k] ?? null, right: adds[k] ??  null })
    }
    for (const nt of notes) out.push({ kind: 'note', note: nt })
  }
  return out
}

export type DiffFile = {
  path: string
  rows: DiffRow[]
  topFindings: Finding[]
  byLine: Record<number, Finding[]>
  /** Hunks structurés avec gaps intercalés */
  hunks: HunkBlock[]
  /** Nb lignes ajoutées dans ce fichier */
  addCount: number
  /** Nb lignes supprimées dans ce fichier */
  delCount: number
}
export type ParsedDiff = { files: DiffFile[]; unmatched: Finding[] }

function stripPrefix(p: string): string {
  const t = p.trim()
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2)
  return t
}

export function sameFile(a: string, b: string): boolean {
  if (a === b) return true
  return a.endsWith('/' + b) || b.endsWith('/' + a)
}

/** Sous-ensemble de fichiers parsés correspondant à `only`, dans l'ordre de `only`. */
export function pickFiles(files: DiffFile[], only: string[]): DiffFile[] {
  const picked: DiffFile[] = []
  for (const p of only) {
    const f = files.find((df) => sameFile(df.path, p))
    if (f && !picked.includes(f)) picked.push(f)
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
    if (!current) continue

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
      // Finding sur une ligne supprimée (del) : indexé par clé négative pour ne pas
      // entrer en collision avec les clés newNo (toujours > 0).
      ;(file.byLine[-f.line] ??= []).push(f)
    } else {
      file.topFindings.push(f)
    }
  }

  // Construire les hunks structurés avec gaps et compteurs add/del
  for (const file of files) {
    file.hunks = buildHunks(file.rows, file.byLine)
    for (const row of file.rows) {
      if (row.kind === 'add') file.addCount++
      else if (row.kind === 'del') file.delCount++
    }
  }

  return { files, unmatched }
}

/**
 * Transforme les DiffRow bruts d'un fichier en HunkBlock[] avec :
 * - gap avant le premier hunk si la ligne de départ > 1 (lignes de contexte omises)
 * - gap entre chaque hunk (lignes inchangées omises entre les deux)
 * - notes (findings) rattachées à leur ligne
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
          // Gap avant le premier hunk si la MR ne commence pas à la ligne 1
          if (hunkNewStart > 1) {
            result.push({ gap: hunkNewStart - 1 })
          }
        } else {
          // Gap entre deux hunks = lignes inchangées entre la fin du hunk précédent et le début de celui-ci
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

    if (row.kind === 'meta') continue

    const t: 'add' | 'del' | 'ctx' =
      row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'ctx'

    const hunkLine: HunkLine = {
      t,
      o: row.oldNo,
      n: row.newNo,
      c: row.text.slice(1),
    }

    // Rattacher la note de finding à la ligne.
    // Lignes add/ctx : clé positive = newNo. Lignes del : clé négative = -oldNo.
    if (row.newNo != null && byLine[row.newNo]?.length) {
      hunkLine.note = byLine[row.newNo]![0]
    } else if (row.kind === 'del' && row.oldNo != null && byLine[-row.oldNo]?.length) {
      hunkLine.note = byLine[-row.oldNo]![0]
    }

    if (row.kind !== 'add') {
      if (row.oldNo != null) prevHunkLastOldLine = row.oldNo
    }
    if (row.kind !== 'del') {
      if (row.newNo != null) prevHunkLastNewLine = row.newNo
    }

    currentLines.push(hunkLine)
  }

  flushLines()
  return result
}

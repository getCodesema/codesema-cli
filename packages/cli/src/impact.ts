import { tryGit } from './git.js'

export type SymbolChangeKind = 'added' | 'removed' | 'modified'

export type ChangedSymbol = {
  name: string
  file: string
  change: SymbolChangeKind
}

export type ImpactSymbol = {
  name: string
  changed_in: string
  change: SymbolChangeKind
  used_at: string[]
}

export type ImpactCandidates = {
  note: string
  symbols: ImpactSymbol[]
  imported_by: Record<string, string[]>
}

const IMPACT_NOTE = 'best-effort, static text matches only, non exhaustive'
const MIN_NAME_LENGTH = 3
const MAX_SYMBOLS = 20
const MAX_USED_AT_PER_SYMBOL = 20
const MAX_IMPORTERS_PER_FILE = 15
const GENERIC_BASENAMES = new Set([
  'index',
  'main',
  'mod',
  'lib',
  'app',
  'utils',
  'types',
  'setup',
  'config',
  '__init__',
])

const TS_JS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])

const TS_JS_DECLARATIONS = [
  /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
]

const PYTHON_DECLARATIONS = [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/]

function declarationPatterns(file: string): RegExp[] {
  const dot = file.lastIndexOf('.')
  if (dot < 0) {
    return []
  }
  const ext = file.slice(dot + 1).toLowerCase()
  if (TS_JS_EXTENSIONS.has(ext)) {
    return TS_JS_DECLARATIONS
  }
  if (ext === 'py') {
    return PYTHON_DECLARATIONS
  }
  return []
}

function isUsableName(name: string): boolean {
  return name.length >= MIN_NAME_LENGTH && !name.startsWith('_')
}

function parseDiffPath(raw: string): string | null {
  const path = raw.trim()
  if (path === '/dev/null') {
    return null
  }
  if (path.startsWith('a/') || path.startsWith('b/')) {
    return path.slice(2)
  }
  return path
}

export function diffFilePaths(diff: string): string[] {
  const files: string[] = []
  let minusPath: string | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      minusPath = parseDiffPath(line.slice(4))
    } else if (line.startsWith('+++ ')) {
      const file = parseDiffPath(line.slice(4)) ?? minusPath
      if (file && !files.includes(file)) {
        files.push(file)
      }
    }
  }
  return files
}

export function changedSymbolsFromDiff(diff: string): ChangedSymbol[] {
  const symbols: ChangedSymbol[] = []
  let file: string | null = null
  let patterns: RegExp[] = []
  let minusPath: string | null = null
  let sides = new Map<string, { minus: boolean; plus: boolean }>()

  const flush = () => {
    if (file) {
      for (const [name, side] of sides) {
        const change: SymbolChangeKind =
          side.minus && side.plus ? 'modified' : side.plus ? 'added' : 'removed'
        symbols.push({ name, file, change })
      }
    }
    sides = new Map()
  }

  const record = (content: string, side: 'minus' | 'plus') => {
    for (const pattern of patterns) {
      const name = pattern.exec(content)?.[1]
      if (!name || !isUsableName(name)) {
        continue
      }
      const entry = sides.get(name) ?? { minus: false, plus: false }
      entry[side] = true
      sides.set(name, entry)
    }
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      file = null
      patterns = []
      minusPath = null
    } else if (line.startsWith('--- ')) {
      minusPath = parseDiffPath(line.slice(4))
    } else if (line.startsWith('+++ ')) {
      file = parseDiffPath(line.slice(4)) ?? minusPath
      patterns = file ? declarationPatterns(file) : []
    } else if (file && patterns.length > 0) {
      if (line.startsWith('+')) {
        record(line.slice(1), 'plus')
      } else if (line.startsWith('-')) {
        record(line.slice(1), 'minus')
      }
    }
  }
  flush()
  return symbols
}

function grepUsages(name: string, excludes: string[], cwd: string): string[] {
  const out = tryGit(
    ['grep', '-n', '--word-regexp', '--fixed-strings', '-e', name, '--', '.', ...excludes],
    cwd,
  )
  if (!out) {
    return []
  }
  const usages: string[] = []
  for (const line of out.split('\n')) {
    const match = /^(.+?):(\d+):/.exec(line)
    if (!match) {
      continue
    }
    usages.push(`${match[1]}:${match[2]}`)
    if (usages.length >= MAX_USED_AT_PER_SYMBOL) {
      break
    }
  }
  return usages
}

function grepImporters(file: string, excludes: string[], cwd: string): string[] {
  const basename = file.split('/').pop() ?? file
  const stem = basename.replace(/\.[^.]+$/, '')
  if (stem.length < MIN_NAME_LENGTH || GENERIC_BASENAMES.has(stem.toLowerCase())) {
    return []
  }
  const out = tryGit(
    ['grep', '-n', '--word-regexp', '--fixed-strings', '-e', stem, '--', '.', ...excludes],
    cwd,
  )
  if (!out) {
    return []
  }
  const importers: string[] = []
  for (const line of out.split('\n')) {
    const match = /^(.+?):\d+:(.*)$/.exec(line)
    if (!match || match[1] === undefined || match[2] === undefined) {
      continue
    }
    if (!/\b(import|require|from|include|use)\b/.test(match[2])) {
      continue
    }
    if (!importers.includes(match[1])) {
      importers.push(match[1])
    }
    if (importers.length >= MAX_IMPORTERS_PER_FILE) {
      break
    }
  }
  return importers
}

export function buildImpactCandidates(diff: string, cwd: string): ImpactCandidates | null {
  const diffFiles = diffFilePaths(diff)
  const excludes = diffFiles.map((f) => `:(exclude)${f}`)

  const symbols: ImpactSymbol[] = []
  const candidates = changedSymbolsFromDiff(diff)
    .filter((s) => s.change !== 'added')
    .slice(0, MAX_SYMBOLS)
  for (const symbol of candidates) {
    const usedAt = grepUsages(symbol.name, excludes, cwd)
    if (usedAt.length > 0) {
      symbols.push({
        name: symbol.name,
        changed_in: symbol.file,
        change: symbol.change,
        used_at: usedAt,
      })
    }
  }

  const importedBy: Record<string, string[]> = {}
  for (const file of diffFiles) {
    if (declarationPatterns(file).length === 0) {
      continue
    }
    const importers = grepImporters(file, excludes, cwd)
    if (importers.length > 0) {
      importedBy[file] = importers
    }
  }

  if (symbols.length === 0 && Object.keys(importedBy).length === 0) {
    return null
  }
  return { note: IMPACT_NOTE, symbols, imported_by: importedBy }
}

import { execFile } from 'node:child_process'
import { detectForgeHint, tryGit } from './git.js'

export type ForgeMr = {
  number: number
  title: string
  author: string
  sourceBranch: string
  targetBranch: string
  updatedAt: string
  url: string
}

export type ForgeMrsResult = { available: true; mrs: ForgeMr[] } | { available: false; reason: 'no-remote' | 'no-cli' | 'cli-error' }

const GH_JSON_FIELDS = 'number,title,author,headRefName,baseRefName,updatedAt,url'
const EXEC_TIMEOUT_MS = 8000

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function readRecordProp(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

/** Parses and validates `gh pr list --json ...` output; null on any shape mismatch. */
export function parseGhMrList(raw: string): ForgeMr[] | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null

  const mrs: ForgeMr[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) return null
    const e = entry as Record<string, unknown>
    const author = readRecordProp(e, 'author')
    const login = typeof author === 'object' && author !== null ? readRecordProp(author as Record<string, unknown>, 'login') : undefined
    if (
      typeof e.number !== 'number' ||
      !isNonEmptyString(e.title) ||
      !isNonEmptyString(login) ||
      !isNonEmptyString(e.headRefName) ||
      !isNonEmptyString(e.baseRefName) ||
      !isIsoTimestamp(e.updatedAt) ||
      !isNonEmptyString(e.url)
    ) {
      return null
    }
    mrs.push({
      number: e.number,
      title: e.title,
      author: login,
      sourceBranch: e.headRefName,
      targetBranch: e.baseRefName,
      updatedAt: e.updatedAt,
      url: e.url,
    })
  }
  return mrs
}

/** Parses and validates `glab mr list --output json` output; null on any shape mismatch. */
export function parseGlabMrList(raw: string): ForgeMr[] | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null

  const mrs: ForgeMr[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) return null
    const e = entry as Record<string, unknown>
    const author = readRecordProp(e, 'author')
    const username = typeof author === 'object' && author !== null ? readRecordProp(author as Record<string, unknown>, 'username') : undefined
    if (
      typeof e.iid !== 'number' ||
      !isNonEmptyString(e.title) ||
      !isNonEmptyString(username) ||
      !isNonEmptyString(e.source_branch) ||
      !isNonEmptyString(e.target_branch) ||
      !isIsoTimestamp(e.updated_at) ||
      !isNonEmptyString(e.web_url)
    ) {
      return null
    }
    mrs.push({
      number: e.iid,
      title: e.title,
      author: username,
      sourceBranch: e.source_branch,
      targetBranch: e.target_branch,
      updatedAt: e.updated_at,
      url: e.web_url,
    })
  }
  return mrs
}

type CliOutcome = { kind: 'ok'; stdout: string } | { kind: 'missing' } | { kind: 'error' }

/**
 * Distinct from git.ts's tryExec: that helper collapses "binary missing" and
 * "command failed" into the same null, which is fine for its fallback-chain use
 * but loses the distinction the /api/mrs "no-cli" vs "cli-error" reason needs.
 * Runs async (unlike tryExec/git.ts) so a slow or hanging forge CLI never blocks
 * the HTTP server's event loop while a request is in flight.
 */
function runForgeCli(cmd: string, args: string[], cwd: string): Promise<CliOutcome> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve((err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' })
        return
      }
      resolve({ kind: 'ok', stdout })
    })
  })
}

type Candidate = { cli: string; args: string[]; parse: (raw: string) => ForgeMr[] | null }

export async function listOpenMrs(cwd: string): Promise<ForgeMrsResult> {
  const hasRemote = tryGit(['remote', 'get-url', 'origin'], cwd) !== null
  if (!hasRemote) return { available: false, reason: 'no-remote' }

  const hint = detectForgeHint(cwd)
  const candidates: Candidate[] = []
  if (hint !== 'gitlab') candidates.push({ cli: 'gh', args: ['pr', 'list', '--json', GH_JSON_FIELDS], parse: parseGhMrList })
  if (hint !== 'github') candidates.push({ cli: 'glab', args: ['mr', 'list', '--output', 'json'], parse: parseGlabMrList })

  let sawCliError = false
  for (const candidate of candidates) {
    const outcome = await runForgeCli(candidate.cli, candidate.args, cwd)
    if (outcome.kind === 'missing') continue
    if (outcome.kind === 'error') {
      sawCliError = true
      continue
    }
    const mrs = candidate.parse(outcome.stdout)
    if (mrs === null) {
      sawCliError = true
      continue
    }
    return { available: true, mrs }
  }
  return { available: false, reason: sawCliError ? 'cli-error' : 'no-cli' }
}

// `codesema review` : tout-en-un. Onboarding au premier run, sélection
// interactive de la branche, puis web ouvert immédiatement pendant que l'agent
// IA (l'abonnement de l'utilisateur, aucun LLM embarqué) review en arrière-plan.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAgent } from './agent.js'
import { pickBranch } from './branches.js'
import { ensureWorkDir, loadConfig } from './config.js'
import { isAncestor, repoRoot } from './git.js'
import { openBrowser } from './open.js'
import { parsePartialReview } from './partial.js'
import type { PrepInput } from './prep.js'
import { mrDiff, prep } from './prep.js'
import { archiveRecord, findPreviousReview, resolveRecord } from './record.js'
import type { LiveSession } from './serve.js'
import { createSession, startServer } from './serve.js'
import { isInteractive } from './tui.js'
import { dim, printBanner, startSpinner } from './ui.js'
import { AGENT_DEFS, defaultCommand, detectAgents, runOnboarding } from './wizard.js'

const REVIEW_INSTRUCTIONS = `You are a senior code reviewer. Review the merge request provided in the <input> block below (JSON: branch, target, commits, files, and the full unified diff). Do NOT use any tools; base your review ONLY on the provided input. Then output the review as a single JSON object and NOTHING else (no prose, no code fences).

Review guidelines:
- Judge the change on: correctness, regressions and breaking changes, security, error handling, missing tests, and whether it matches its stated intent (inferred from the branch name and commit messages). Ground EVERY finding in the diff; never speculate. The diff shows ONLY the changed files: NEVER claim that something is absent from the repository — turn such doubts into a chapter "check" question instead.
- If the input has non-null custom_instructions, apply them on top of these guidelines; they win on conflicts.
- Language: write all human-readable text (summary, messages, narrative) in the language of the commit messages when clearly identifiable, otherwise in English. Keep code identifiers and file paths verbatim.

Output JSON shape (exactly these fields):
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "concise human summary",
  "findings": [
    {
      "file": "path from the diff",
      "line": <new-file line number from the @@ headers, when anchorable>,
      "endLine": <optional, only for multi-line suggestions>,
      "severity": "critical" | "major" | "minor" | "info",
      "kind": "security" | "perf" | "convention" | "design" | "praise" | "why",
      "title": "short title",
      "message": "one short plain sentence: what is wrong and what it breaks in practice, then the fix. A junior must understand it on first read.",
      "suggestion": "optional corrected code, verbatim replacement, only for trivial self-contained fixes"
    }
  ],
  "narrative": {
    "intent": "1-3 sentences on what this MR tries to accomplish",
    "confidence": "high" | "medium" | "low",
    "prologue": {
      "why": "the problem this MR addresses (max 3 sentences)",
      "what": "what it concretely changes (max 3 sentences)",
      "key_changes": [{ "title": "short label", "detail": "one sentence" }]
    },
    "chapters": [
      {
        "title": "concise chapter name",
        "rationale": "the PURPOSE of the chapter",
        "files": ["ordered diff paths"],
        "finding_refs": [<0-based indices into findings>],
        "risk": "high" | "medium" | "low",
        "take": "your opinion on the chapter (max 2 sentences)",
        "check": "one question the human should verify, or omit"
      }
    ],
    "review_first": [
      { "point": "what to check and why it is risky (one sentence)", "risk": "high" | "medium" | "low", "chapter_ref": <0-based chapter index>, "file": "path" }
    ]
  }
}

Rules for the narrative:
- chapters: ORDERED logical groups (NOT alphabetical): foundations first (migrations, shared types, contracts), then business logic, then surface (routes, UI).
- review_first: 2-4 hot spots ordered by risk, highest first.
- You MUST produce praise findings when the code deserves it; reserve severity "info" for praise/why findings.
- Do NOT approve changes you cannot justify; prefer "request_changes" when impact is unclear.
- Output the top-level fields in this exact order: "verdict", "summary", "findings", "narrative" (the review is displayed live while you write it).`

const INCREMENTAL_INSTRUCTIONS = `An earlier review of this SAME merge request exists. Instead of the full diff, you are given:
- <previous_review>: the review produced when HEAD was at the commit indicated below
- <incremental_diff>: what changed on the branch since that review

UPDATE the previous review into a new COMPLETE review of the whole MR:
- Remove findings that the incremental changes fix or make obsolete.
- Keep still-relevant findings as they are (same file/line anchors), unless the incremental diff moved that code.
- Add findings for problems introduced by the incremental diff, grounded in it.
- Update verdict, summary and narrative (prologue, chapters, review_first) so they describe the whole MR after these changes; keep the chapter structure stable when possible.
Output the FULL updated review JSON (exact same schema), and NOTHING else.`

/** Prompt incrémental si une review archivée de cette branche couvre un ancêtre strict du head reviewé. */
function buildIncrementalPrompt(input: PrepInput, cwd: string): { prompt: string; sinceSha: string } | null {
  const previous = findPreviousReview(cwd, input.branch, input.target)
  const since = previous?.meta.head_sha
  if (!previous || !since) return null
  if (since === input.head_sha) return null
  if (!isAncestor(since, input.head_sha, cwd)) return null
  const incrementalDiff = mrDiff(`${since}..${input.head_sha}`, cwd)
  if (!incrementalDiff.trim()) return null

  const { diff: _fullDiff, ...inputMeta } = input
  const prompt = [
    REVIEW_INSTRUCTIONS,
    INCREMENTAL_INSTRUCTIONS,
    `Previous review done at commit: ${since}`,
    `<input>\n${JSON.stringify(inputMeta, null, 2)}\n</input>`,
    `<previous_review>\n${JSON.stringify(previous.review, null, 2)}\n</previous_review>`,
    `<incremental_diff>\n${incrementalDiff}\n</incremental_diff>`,
    'Output ONLY the JSON object now.',
  ].join('\n\n')
  return { prompt, sinceSha: since }
}

function detectAgentCommand(cwd: string): string {
  const [first] = detectAgents(cwd)
  if (first) return defaultCommand(first)
  throw new Error(
    `no supported agent CLI found on PATH (looked for: ${AGENT_DEFS.map((d) => d.bin).join(', ')}) — pass one with --agent '<command>' (it receives the full prompt on stdin and must print the review JSON on stdout)`,
  )
}

/** Extrait l'objet JSON de la sortie agent (tolère fences et prose autour). */
export function extractReviewJson(raw: string): string {
  let fallback: string | null = null
  for (const candidate of jsonCandidates(raw.trim())) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    if ('verdict' in (parsed as Record<string, unknown>)) return candidate
    fallback ??= candidate
  }
  if (fallback) return fallback
  throw new Error('the agent did not return a JSON review (raw output saved to .codesema/agent-output.txt)')
}

/** Candidats par priorité : sortie entière, contenu des fences, chaque objet {…} balancé. */
function* jsonCandidates(s: string): Generator<string> {
  yield s
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (m[1]) yield m[1].trim()
  }
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const end = balancedEnd(s, i)
    if (end > i) yield s.slice(i, end + 1)
  }
}

/** Index de la '}' fermant l'objet ouvert à `start`, en respectant strings et échappements. */
function balancedEnd(s: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const DEFAULT_TIMEOUT_S = 900
const PARTIAL_PARSE_INTERVAL_MS = 400

function createPartialForwarder(session: LiveSession): (text: string) => void {
  let lastParse = 0
  return (text: string) => {
    const now = Date.now()
    if (now - lastParse < PARTIAL_PARSE_INTERVAL_MS) return
    lastParse = now
    const partial = parsePartialReview(text)
    if (partial) session.setPartial(partial)
  }
}

export async function review(opts: {
  branch?: string
  target?: string
  agent?: string
  port?: number
  timeout?: number
  full?: boolean
  open: boolean
  interactive?: boolean
  cwd: string
}): Promise<void> {
  printBanner()
  const cwd = repoRoot(opts.cwd)
  const config = loadConfig(cwd)

  let agentCommand = opts.agent ?? config.agent
  if (!agentCommand && isInteractive()) {
    agentCommand = (await runOnboarding(cwd)) ?? undefined
    if (agentCommand) console.log('')
  }
  agentCommand ??= detectAgentCommand(cwd)

  let branch = opts.branch
  if (!branch && opts.interactive !== false && isInteractive()) {
    const picked = await pickBranch(cwd)
    if (picked === null) return
    branch = picked
  }

  const input = prep({ branch, target: opts.target ?? config.target, cwd, quiet: true })
  const dir = ensureWorkDir(input.repo_root)

  const incremental = opts.full ? null : buildIncrementalPrompt(input, input.repo_root)
  const prompt =
    incremental?.prompt ??
    `${REVIEW_INSTRUCTIONS}\n\n<input>\n${JSON.stringify(input, null, 2)}\n</input>\n\nOutput ONLY the JSON object now.`

  const additions = input.files.reduce((n, f) => n + f.additions, 0)
  const deletions = input.files.reduce((n, f) => n + f.deletions, 0)
  console.log(`  ${input.branch} → ${input.target} ${dim(`(${input.target_source})`)}`)
  console.log(`  ${input.files.length} files ${dim(`+${additions} −${deletions}`)} · ${input.commits.length} commits`)
  if (incremental) {
    console.log(`  ${dim(`incremental: updating the review done at ${incremental.sinceSha.slice(0, 8)} — pass --full to start over`)}`)
  }

  const session = createSession()
  session.setAgent(agentCommand)
  session.setInput({
    branch: input.branch,
    target: input.target,
    commits: input.commits,
    files: input.files,
    additions,
    deletions,
    incremental: Boolean(incremental),
  })

  const { url } = await startServer(session, { port: opts.port ?? config.port })
  console.log(`  ${url} ${dim('— live, findings appear as the agent works')}`)
  console.log('')
  if (opts.open) openBrowser(url)

  const shortCmd = agentCommand.length > 40 ? `${agentCommand.slice(0, 37)}…` : agentCommand
  const spinner = startSpinner(`reviewing with ${shortCmd}`)

  let out: string
  try {
    out = await runAgent({
      command: agentCommand,
      prompt,
      cwd: input.repo_root,
      timeoutMs: (opts.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
      onText: createPartialForwarder(session),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    spinner.stop('  ✘ agent run failed')
    session.setError(message)
    console.error(`codesema: agent run failed: ${message}`)
    console.log(`  ${url} still up — Ctrl+C to stop`)
    process.exitCode = 1
    return
  }

  let record
  try {
    const json = extractReviewJson(out)
    writeFileSync(join(dir, 'review.json'), json)
    record = resolveRecord({ cwd: input.repo_root }).record
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    spinner.stop('  ✘ unusable agent output')
    writeFileSync(join(dir, 'agent-output.txt'), out)
    session.setError(message)
    console.error(`codesema: ${message}`)
    console.log(`  ${url} still up — Ctrl+C to stop`)
    process.exitCode = 1
    return
  }

  const savedPath = archiveRecord(record, input.repo_root)
  session.setDone(record)

  const findingsCount = record.review.findings.length
  spinner.stop(`  ✔ review ready — ${findingsCount} finding${findingsCount === 1 ? '' : 's'} · ${record.review.verdict}`)
  console.log(`  ${dim(`archived: ${savedPath}`)}`)
  console.log('')
  console.log(`  ${url}`)
  console.log('  Ctrl+C to stop')
}

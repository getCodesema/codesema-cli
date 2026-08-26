// Ticket drafting: turns a forge issue or a free-form prompt into a ticket
// body conforming to the contract's grammar (ticket.ts), using the
// configured agent as a one-shot writer rather than an interactive session.
// Two publish paths share the same drafting core: `draftAndPublishTicket`
// (one ticket, `POST /tickets`, driven by `codesema brain ticket`) and
// `draftAndSubmitTicketRequest` (one ticket, `POST /ticket-requests/:id/tickets`,
// driven by the daemon against a brain-issued `ArmTicketRequest`).

import { runAgent } from './agent.js'
import {
  brainErrorMessage,
  brainRemoteUrl,
  createTicket,
  failTicketRequest,
  submitTicketRequestTickets,
} from './brain-client.js'
import { loadConfig } from './config.js'
import {
  ACCEPTANCE_CRITERIA_HEADING,
  EARS_RESPONSE,
  EARS_TRIGGER,
  formatTicketProblems,
  lintTicketBody,
  TICKET_CRITERIA_MAX,
  TICKET_CRITERIA_MIN,
  TICKET_SECTIONS,
  type ArmIssueRef,
  type ArmTicket,
  type ArmTicketRequest,
  type TicketProblem,
} from './contract.js'
import { getIssue } from './forge-issues.js'
import { tryGit } from './git.js'
import { loadSyncCredentials } from './sync.js'

/** No provider-specific flag needed beyond this: every AGENT_DEFS base command (wizard.ts) already reads a prompt on stdin and writes plain text to stdout. */
const DEFAULT_DRAFT_COMMAND = 'claude -p --output-format text'
const DRAFT_ABSOLUTE_CAP_MS = 5 * 60_000
/** One initial attempt, one retry with the lint's own reasons folded into the prompt. */
const DRAFT_MAX_ATTEMPTS = 2

const FIRST_HEADING = TICKET_SECTIONS[0].heading

const EXAMPLE_TICKET_BODY = `**Context**

Tickets are launched from the workspace.

**Goal**

Freeze the ticket format once.

**Scope**

packages/contract/src/ticket.ts

**Acceptance criteria**

- WHEN a ticket is launched THE SYSTEM SHALL lint its body
- WHEN a section is missing THE SYSTEM SHALL name that section
- WHEN the body is conforming THE SYSTEM SHALL accept it

**Out of scope**

Posting the issue on the forge.`

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The harness this repo/machine is configured to use for review and tasks; the fixed default when nothing is. */
function resolveDraftCommand(cwd: string): string {
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], cwd)
  return loadConfig(repoRoot).agent || DEFAULT_DRAFT_COMMAND
}

function grammarInstructions(): string {
  const sections = TICKET_SECTIONS.map(({ heading }) =>
    heading === ACCEPTANCE_CRITERIA_HEADING
      ? `${heading}\n\n- ${EARS_TRIGGER} <trigger> ${EARS_RESPONSE} <response>\n(repeat: ${TICKET_CRITERIA_MIN} to ${TICKET_CRITERIA_MAX} lines total, each starting with "${EARS_TRIGGER}" and containing "${EARS_RESPONSE}" verbatim)`
      : `${heading}\n\n<prose, non-empty>`,
  ).join('\n\n')
  return `Output ONLY the ticket body below, nothing before it and nothing after it, no markdown code fence around it. Five sections, in this exact order, each heading alone on its own line, verbatim:\n\n${sections}`
}

function buildDraftPrompt(input: { title?: string | undefined; promptContext: string }): string {
  const titleInstruction = input.title
    ? ''
    : `Start your answer with exactly one line \`TITLE: <a short, specific title, under 100 characters>\`, then a blank line, then the ticket body.\n\n`
  const requestLabel = input.title ? ` ("${input.title}")` : ''
  return [
    'You are drafting a ticket body for an autonomous coding agent that will implement it unattended, with no further back-and-forth.',
    grammarInstructions(),
    'Example of a fully valid ticket body:',
    EXAMPLE_TICKET_BODY,
    `${titleInstruction}Draft a ticket for the following request${requestLabel}:`,
    input.promptContext,
  ].join('\n\n')
}

function buildRetryPrompt(previousPrompt: string, problems: readonly TicketProblem[]): string {
  return [
    previousPrompt,
    'Your previous answer was rejected for these reasons:',
    formatTicketProblems(problems),
    'Output a corrected ticket body, same format, same rules, fixing every reason above.',
  ].join('\n\n')
}

/**
 * Splits a raw agent answer into an optional `TITLE: …` line and the ticket
 * body proper. The body is taken from the FIRST heading onward: an agent that
 * ignored the "nothing before it" instruction still yields a usable body as
 * long as the five sections themselves are intact, since the grammar is
 * self-delimiting from that point to the end of the answer.
 */
function extractDraft(raw: string): { title: string | null; body: string } {
  const idx = raw.indexOf(FIRST_HEADING)
  if (idx < 0) {
    return { title: null, body: raw.trim() }
  }
  const before = raw.slice(0, idx)
  const body = raw.slice(idx).trim()
  const titleMatch = /TITLE:\s*(.+)/i.exec(before)
  const title = titleMatch?.[1]?.trim()
  return { title: title ? title : null, body }
}

export type DraftResult = { ok: true; title: string; body: string } | { ok: false; reason: string }

export type DraftSeams = { runAgentFn?: typeof runAgent }

/**
 * The shared drafting core: runs the configured harness once, lints the
 * result, and on a rejection retries exactly once with the lint's own
 * problems appended to the prompt. `input.title` known (an issue's own title,
 * or `--title`) skips asking the agent to invent one; unset (a ticket
 * request's bare prompt) asks for a `TITLE:` line too.
 */
export async function draftTicketBody(
  input: { cwd: string; title?: string | undefined; promptContext: string },
  seams: DraftSeams = {},
): Promise<DraftResult> {
  const runAgentFn = seams.runAgentFn ?? runAgent
  const command = resolveDraftCommand(input.cwd)
  let prompt = buildDraftPrompt(input)
  let lastProblems: readonly TicketProblem[] = []
  let lastRaw = ''

  for (let attempt = 1; attempt <= DRAFT_MAX_ATTEMPTS; attempt++) {
    let raw: string
    try {
      raw = await runAgentFn({
        command,
        prompt,
        cwd: input.cwd,
        absoluteCapMs: DRAFT_ABSOLUTE_CAP_MS,
      })
    } catch (err) {
      return { ok: false, reason: `drafting agent failed: ${errorMessage(err)}` }
    }
    lastRaw = raw
    const extracted = extractDraft(raw)
    const title = input.title ?? extracted.title
    if (!title) {
      prompt = `${prompt}\n\nYour previous answer did not start with the required \`TITLE: …\` line. Follow the instructions exactly and try again.`
      continue
    }
    const lint = lintTicketBody(extracted.body)
    if (lint.ok) {
      return { ok: true, title, body: extracted.body }
    }
    lastProblems = lint.problems
    if (attempt < DRAFT_MAX_ATTEMPTS) {
      prompt = buildRetryPrompt(prompt, lint.problems)
    }
  }

  return {
    ok: false,
    reason:
      lastProblems.length > 0
        ? `the drafting agent could not produce a conforming ticket: ${formatTicketProblems(lastProblems)}`
        : `the drafting agent did not produce a usable ticket body (missing the TITLE line): ${lastRaw.slice(0, 200)}`,
  }
}

export type DraftAndPublishInput =
  | { kind: 'issue'; cwd: string; issueNumber: number }
  | { kind: 'prompt'; cwd: string; title: string; prompt: string }

export type PublishResult = { ok: true; ticket: ArmTicket } | { ok: false; reason: string }

/** `codesema brain ticket`: draft one ticket and publish it with `POST /tickets`. */
export async function draftAndPublishTicket(
  input: DraftAndPublishInput,
  seams: DraftSeams & { fetchImpl?: typeof fetch } = {},
): Promise<PublishResult> {
  const fetchImpl = seams.fetchImpl ?? fetch
  const creds = loadSyncCredentials()
  if (!creds) {
    return { ok: false, reason: 'not connected to a brain: run `codesema brain connect` first' }
  }
  const remoteUrl = brainRemoteUrl(input.cwd)
  if (!remoteUrl) {
    return { ok: false, reason: 'this workspace has no git origin remote' }
  }

  let title: string
  let promptContext: string
  let sourceIssue: ArmIssueRef | undefined

  if (input.kind === 'issue') {
    const issueResult = await getIssue({ cwd: input.cwd, number: input.issueNumber })
    if (!issueResult.available) {
      const detail = issueResult.detail ? ` (${issueResult.detail})` : ''
      return {
        ok: false,
        reason: `could not read issue #${input.issueNumber}: ${issueResult.reason}${detail}`,
      }
    }
    title = issueResult.issue.title
    promptContext = `Issue #${issueResult.issue.number}: ${issueResult.issue.title}\n\n${issueResult.issue.body}`
    sourceIssue = { iid: String(issueResult.issue.number), url: issueResult.issue.url }
  } else {
    title = input.title
    promptContext = input.prompt
  }

  const drafted = await draftTicketBody({ cwd: input.cwd, title, promptContext }, seams)
  if (!drafted.ok) {
    return { ok: false, reason: drafted.reason }
  }

  const created = await createTicket(
    creds,
    {
      remoteUrl,
      title: drafted.title,
      body: drafted.body,
      ...(sourceIssue ? { sourceIssue } : {}),
    },
    fetchImpl,
  )
  if (!created.ok) {
    return { ok: false, reason: brainErrorMessage(created.error) }
  }
  return { ok: true, ticket: created.data }
}

export type TicketRequestDraftResult =
  { ok: true; tickets: ArmTicket[] } | { ok: false; reason: string }

/**
 * The daemon's path for an already-claimed `ArmTicketRequest`: draft one
 * ticket from `request.prompt` and submit it with
 * `POST /ticket-requests/:id/tickets`. A drafting or submission failure calls
 * `failTicketRequest` (best-effort: its own failure does not change the
 * outcome reported here) so the brain does not keep the request stuck
 * claimed by a run that gave up on it.
 */
export async function draftAndSubmitTicketRequest(
  request: ArmTicketRequest,
  cwd: string,
  seams: DraftSeams & { fetchImpl?: typeof fetch } = {},
): Promise<TicketRequestDraftResult> {
  const fetchImpl = seams.fetchImpl ?? fetch
  const creds = loadSyncCredentials()
  if (!creds) {
    return { ok: false, reason: 'not connected to a brain' }
  }

  const drafted = await draftTicketBody({ cwd, promptContext: request.prompt }, seams)
  if (!drafted.ok) {
    await failTicketRequest(creds, request.id, drafted.reason, fetchImpl)
    return { ok: false, reason: drafted.reason }
  }

  const submitted = await submitTicketRequestTickets(
    creds,
    request.id,
    [{ title: drafted.title, body: drafted.body }],
    fetchImpl,
  )
  if (!submitted.ok) {
    const reason = brainErrorMessage(submitted.error)
    await failTicketRequest(creds, request.id, reason, fetchImpl)
    return { ok: false, reason }
  }
  return { ok: true, tickets: submitted.data }
}

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listLocalBranches } from './branches.js'
import { loadGlobalConfig, saveGlobalConfig, type CodesemaConfig } from './config.js'
import { isTaskId, TASK_AGENT_MAX, type ReviewRecord } from './contract.js'
import type { JudgeDecision } from './dual.js'
import type { FixRunner } from './fix.js'
import { listOpenMrs, type ForgeMrsResult } from './forge-mrs.js'
import { t } from './i18n.js'
import type { MrReviewMode, MrReviewRunner, ReviewSource } from './mr-review-runner.js'
import type { PartialReview } from './partial.js'
import { buildFileDiff, buildPreview, parsePreviewPath, parsePreviewSource } from './preview.js'
import {
  addProject,
  discoverProjects,
  getProject,
  listProjects,
  removeProject,
} from './projects.js'
import {
  readRulesContent,
  readSyncAutoPush,
  RULES_CONTENT_MAX_BYTES,
  setSyncAutoPush,
  writeRulesContent,
} from './repo-config.js'
import { applyTaskCriteria } from './task-criteria.js'
import type { TaskActionResult } from './task-runner.js'
import type { TaskEnvelope, TaskManager } from './task-server.js'
import {
  AGENT_DEFS,
  composeCommand,
  defaultCommand,
  detectAgents,
  listAgentModels,
  parseCommandEffort,
  parseCommandModel,
  resolveKnownAgentCommand,
  type AgentDef,
} from './wizard.js'

const WEB_DIST = fileURLToPath(new URL('../web-dist', import.meta.url))

export type LivePhase = 'reviewing' | 'judging' | 'done' | 'error'
export type LiveMode = 'simple' | 'dual'

export type LiveInput = {
  branch: string
  target: string
  commits: string[]
  files: { path: string; previousPath?: string; additions: number; deletions: number }[]
  additions: number
  deletions: number
  incremental: boolean
}

export type LiveStatus = {
  phase: LivePhase
  started_at: string
  mode?: LiveMode
  agent?: string
  input?: LiveInput
  error?: string
}

export type JudgeLive = {
  total: number
  decisions: JudgeDecision[]
}

export type SessionEvent =
  | { name: 'status'; data: LiveStatus }
  | { name: 'partial'; data: PartialReview }
  | { name: 'partial_b'; data: PartialReview }
  | { name: 'judge'; data: JudgeLive }
  | { name: 'done'; data: Record<string, never> }

export type LiveSession = {
  status: () => LiveStatus
  record: () => ReviewRecord | null
  partial: () => PartialReview | null
  partialB: () => PartialReview | null
  judge: () => JudgeLive | null
  setAgent: (agent: string) => void
  setMode: (mode: LiveMode) => void
  setInput: (input: LiveInput) => void
  setPartial: (partial: PartialReview) => void
  setPartialB: (partial: PartialReview) => void
  setJudging: (total: number) => void
  setJudge: (judge: JudgeLive) => void
  setDone: (record: ReviewRecord) => void
  setError: (message: string) => void
  /** Clears record/partials/judge and returns status to a fresh 'reviewing' phase, for a new run reusing this session (e.g. an MR review). */
  reset: () => void
  subscribe: (listener: (event: SessionEvent) => void) => () => void
}

export function createSession(initial?: { record?: ReviewRecord }): LiveSession {
  const listeners = new Set<(event: SessionEvent) => void>()
  let record: ReviewRecord | null = initial?.record ?? null
  let partial: PartialReview | null = null
  let partialB: PartialReview | null = null
  let judge: JudgeLive | null = null
  let status: LiveStatus = {
    phase: record ? 'done' : 'reviewing',
    started_at: new Date().toISOString(),
  }

  const emit = (event: SessionEvent) => {
    for (const listener of listeners) {
      listener(event)
    }
  }
  const emitStatus = () => emit({ name: 'status', data: status })

  return {
    status: () => status,
    record: () => record,
    partial: () => partial,
    partialB: () => partialB,
    judge: () => judge,
    setAgent(agent) {
      status = { ...status, agent }
      emitStatus()
    },
    setMode(mode) {
      status = { ...status, mode }
      emitStatus()
    },
    setInput(input) {
      status = { ...status, input }
      emitStatus()
    },
    setPartial(next) {
      partial = next
      emit({ name: 'partial', data: next })
    },
    setPartialB(next) {
      partialB = next
      emit({ name: 'partial_b', data: next })
    },
    setJudging(total) {
      judge = { total, decisions: [] }
      status = { ...status, phase: 'judging' }
      emitStatus()
      emit({ name: 'judge', data: judge })
    },
    setJudge(next) {
      judge = next
      emit({ name: 'judge', data: next })
    },
    setDone(next) {
      record = next
      status = { ...status, phase: 'done' }
      emitStatus()
      emit({ name: 'done', data: {} })
    },
    setError(message) {
      status = { ...status, phase: 'error', error: message }
      emitStatus()
    },
    reset() {
      record = null
      partial = null
      partialB = null
      judge = null
      status = { phase: 'reviewing', started_at: new Date().toISOString() }
      emitStatus()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Whether the Host header points to loopback (hostname before the port, IPv6 in brackets). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return false
  }
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim())
  if (!match) {
    return false
  }
  return LOOPBACK_HOSTNAMES.has((match[1] ?? '').toLowerCase())
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Maps a URL pathname to an absolute file path inside root. Returns null when the
 * decoded path escapes root (traversal), carries a null byte, or is not decodable.
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) {
    return null
  }
  const resolved = resolve(root, '.' + decoded)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null
  }
  return resolved
}

const MAX_SSE_CLIENTS = 16

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  res.end(html)
}

function serveEvents(
  session: LiveSession,
  req: IncomingMessage,
  res: ServerResponse,
  onClose: () => void,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  })

  let eventId = 0
  const send = (event: SessionEvent) => {
    res.write(`event: ${event.name}\nid: ${eventId++}\ndata: ${JSON.stringify(event.data)}\n\n`)
  }

  const unsubscribe = session.subscribe(send)
  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: \n\n')
  }, 15000)

  send({ name: 'status', data: session.status() })
  const partial = session.partial()
  if (partial) {
    send({ name: 'partial', data: partial })
  }
  const partialB = session.partialB()
  if (partialB) {
    send({ name: 'partial_b', data: partialB })
  }
  const judge = session.judge()
  if (judge) {
    send({ name: 'judge', data: judge })
  }
  if (session.status().phase === 'done') {
    send({ name: 'done', data: {} })
  }

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    onClose()
  })
}

const MAX_FIX_BODY_BYTES = 64 * 1024

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0
    // Rejecting keeps the socket alive to write the response; destroying it here
    // would reset the connection before the caller's error response goes out.
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) {
        return
      }
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        return
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

type FixEndpoint = { runner: FixRunner; token: string }
type MrReviewEndpoint = { runner: MrReviewRunner; token: string }
type RepoConfigEndpoint = { cwd: string; token: string }
type TasksEndpoint = {
  manager: TaskManager
  token: string
  /** Project auto-registered from the boot repo, or null when started outside a repo. */
  currentProjectId: string | null
}

/**
 * POST /api/fix triggers an agent that EDITS the working tree, so it needs more
 * than the loopback + Host guards: a per-server random token (injected into the
 * served page, unreadable cross-origin) blocks blind CSRF posts to 127.0.0.1.
 */
async function handleFixStart(
  req: IncomingMessage,
  res: ServerResponse,
  fix: FixEndpoint | undefined,
): Promise<void> {
  if (!fix) {
    return sendJson(res, 501, { error: 'fix runner unavailable' })
  }
  if (req.headers['x-codesema-fix-token'] !== fix.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_FIX_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const findings = (body as { findings?: unknown } | null)?.findings
  if (!Array.isArray(findings) || !findings.every((n) => typeof n === 'number')) {
    return sendText(res, 400, 'bad request')
  }
  const started = fix.runner.start(findings)
  if (!started.ok) {
    return sendJson(res, started.code, { error: started.error })
  }
  return sendJson(res, 202, { ok: true })
}

const MAX_MR_REVIEW_BODY_BYTES = 1024

/** Body-level shape check for the discriminated ReviewSource; null on any mismatch. */
function parseReviewSourceBody(raw: unknown): ReviewSource | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const b = raw as { kind?: unknown; number?: unknown; name?: unknown }
  if (b.kind === 'mr' && typeof b.number === 'number' && Number.isInteger(b.number)) {
    return { kind: 'mr', number: b.number }
  }
  if (b.kind === 'branch' && typeof b.name === 'string' && b.name.length > 0) {
    return { kind: 'branch', name: b.name }
  }
  return null
}

/**
 * POST /api/mrs/review triggers an agent run (fetch or local checkout, disposable
 * worktree, review agent) that writes to the repo's .codesema/reviews, so it needs
 * the same per-server CSRF token as /api/fix (see handleFixStart). One route for
 * both an open MR and a local branch: the body's `source.kind` discriminates.
 */
async function handleMrReviewStart(
  req: IncomingMessage,
  res: ServerResponse,
  mrReview: MrReviewEndpoint | undefined,
): Promise<void> {
  if (!mrReview) {
    return sendJson(res, 501, { error: 'MR review runner unavailable' })
  }
  if (req.headers['x-codesema-mrreview-token'] !== mrReview.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_MR_REVIEW_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const b = body as { source?: unknown; mode?: unknown } | null
  const source = parseReviewSourceBody(b?.source)
  if (!source || (b?.mode !== 'simple' && b?.mode !== 'dual')) {
    return sendText(res, 400, 'bad request')
  }
  const started = await mrReview.runner.start(source, b?.mode as MrReviewMode)
  if (!started.ok) {
    return sendJson(res, started.code, { error: started.error })
  }
  return sendJson(res, 202, { ok: true })
}

const MAX_RULES_BODY_BYTES = RULES_CONTENT_MAX_BYTES + 1024
const MAX_SYNC_TOGGLE_BODY_BYTES = 1024

/**
 * PUT /api/config/* writes to the repo's .codesema/RULES.md or the global config
 * file, so it needs the same per-server CSRF token as /api/fix (see handleFixStart).
 */
async function handleRulesUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  repoConfig: RepoConfigEndpoint,
): Promise<void> {
  if (req.headers['x-codesema-config-token'] !== repoConfig.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_RULES_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const content = (body as { content?: unknown } | null)?.content
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > RULES_CONTENT_MAX_BYTES) {
    return sendText(res, 400, 'bad request')
  }
  writeRulesContent(repoConfig.cwd, content)
  return sendJson(res, 200, { ok: true })
}

async function handleSyncAutoPushUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  repoConfig: RepoConfigEndpoint,
): Promise<void> {
  if (req.headers['x-codesema-config-token'] !== repoConfig.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_SYNC_TOGGLE_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled
  if (typeof enabled !== 'boolean') {
    return sendText(res, 400, 'bad request')
  }
  setSyncAutoPush(enabled)
  return sendJson(res, 200, { ok: true, syncAutoPush: enabled })
}

async function handleConfigGet(
  res: ServerResponse,
  cwd: string,
  tasks: TasksEndpoint | undefined,
  agents: () => Promise<AgentOption[]>,
): Promise<void> {
  const body: {
    rulesContent: string
    syncAutoPush: boolean
    agent?: string
    model?: string
    effort?: string
    agents?: AgentOption[]
  } = {
    rulesContent: readRulesContent(cwd),
    syncAutoPush: readSyncAutoPush(cwd),
  }
  if (tasks) {
    body.agent = tasks.manager.defaultCommand()
    // Read back from the command itself, not the config file: the command is
    // what actually runs, and a `--agent` flag can override the stored config.
    body.model = parseCommandModel(body.agent) ?? ''
    body.effort = parseCommandEffort(body.agent) ?? ''
    body.agents = overlayConfiguredAgent(await agents(), body.agent)
  }
  return sendJson(res, 200, body)
}

async function handleConfigAgentUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  repoConfig: RepoConfigEndpoint,
  tasks: TasksEndpoint | undefined,
): Promise<void> {
  if (!tasks) {
    return sendJson(res, 501, { error: 'task manager unavailable' })
  }
  if (req.headers['x-codesema-config-token'] !== repoConfig.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_AGENT_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const payload = body as { agent?: unknown; model?: unknown; effort?: unknown } | null
  const raw = payload?.agent
  if (typeof raw !== 'string') {
    return sendText(res, 400, 'bad request')
  }
  if (payload?.model !== undefined && typeof payload.model !== 'string') {
    return sendText(res, 400, 'bad request')
  }
  if (payload?.effort !== undefined && typeof payload.effort !== 'string') {
    return sendText(res, 400, 'bad request')
  }
  const resolved = resolveKnownAgentCommand(raw)
  if (!resolved || resolved.length > TASK_AGENT_MAX) {
    return sendText(res, 400, 'bad request')
  }
  const current = loadGlobalConfig()
  const picked = resolveAgentSelection(resolved, current, payload)
  if (picked.command.length > TASK_AGENT_MAX) {
    return sendText(res, 400, 'bad request')
  }
  saveGlobalConfig(nextGlobalConfig(current, picked))
  tasks.manager.setDefaultCommand(picked.command)
  return sendJson(res, 200, {
    ok: true,
    agent: picked.command,
    model: picked.model ?? '',
    effort: picked.effort ?? '',
  })
}

type AgentSelection = {
  command: string
  def: AgentDef | undefined
  model: string | undefined
  effort: string | undefined
}

/**
 * A PUT may carry only `agent` (the wizard-composed default keeps its model),
 * or `agent` plus an explicit model/effort the settings panel just edited. An
 * empty string is a deliberate CLEAR, which is why absent and '' differ here.
 */
function resolveAgentSelection(
  resolved: string,
  current: CodesemaConfig,
  payload: { model?: unknown; effort?: unknown } | null,
): AgentSelection {
  const bin = resolved.trim().split(/\s+/)[0]?.split('/').pop() ?? ''
  const def = AGENT_DEFS.find((d) => d.bin === bin)
  let model = parseCommandModel(resolved)
  let effort = parseCommandEffort(resolved)
  const modelInput = typeof payload?.model === 'string' ? payload.model : undefined
  const effortInput = typeof payload?.effort === 'string' ? payload.effort : undefined
  if (!def || (modelInput === undefined && effortInput === undefined)) {
    return { command: resolved, def, model, effort }
  }
  model = modelInput === undefined ? (model ?? current.model) : modelInput.trim() || undefined
  effort =
    effortInput === undefined
      ? current.agentId === def.id
        ? current.effort
        : undefined
      : effortInput.trim() || undefined
  return { command: composeCommand(def, model, effort), def, model, effort }
}

function nextGlobalConfig(current: CodesemaConfig, picked: AgentSelection): CodesemaConfig {
  const next: CodesemaConfig = { ...current, agent: picked.command }
  if (picked.def) {
    next.agentId = picked.def.id
  }
  // A cleared model or effort must LEAVE the file, not linger as a stale key.
  if (picked.model) {
    next.model = picked.model
  } else {
    delete next.model
  }
  if (picked.effort) {
    next.effort = picked.effort
  } else {
    delete next.effort
  }
  return next
}

const MAX_TASK_BODY_BYTES = 64 * 1024
const MAX_AGENT_BODY_BYTES = TASK_AGENT_MAX + 1024

type AgentOption = {
  id: string
  label: string
  bin: string
  command: string
  detected: boolean
  models: string[]
  efforts: string[]
}

/**
 * `opencode models` / `grok models` are real subprocess launches that cost
 * SECONDS, and GET /api/config is hit every time the settings panel opens: the
 * response must never wait on one. The list is served from this cache (falling
 * back to the static suggestions until it is warm) while a refresh runs in the
 * background, so at worst the live ids land on the next open.
 */
const AGENT_MODELS_TTL_MS = 5 * 60 * 1000
const agentModelsCache = new Map<string, { at: number; models: string[] }>()
const agentModelsInFlight = new Set<string>()

async function refreshAgentModels(def: AgentDef, cwd: string, now: number): Promise<void> {
  const key = `${cwd}\u0000${def.id}`
  if (agentModelsInFlight.has(key)) {
    return
  }
  agentModelsInFlight.add(key)
  try {
    agentModelsCache.set(key, { at: now, models: await listAgentModels(def, cwd) })
  } catch {
    // A failed probe leaves the previous entry (or the static list) in place.
  } finally {
    agentModelsInFlight.delete(key)
  }
}

function agentModels(def: AgentDef, cwd: string, detected: boolean, now: number): string[] {
  const hit = agentModelsCache.get(`${cwd}\u0000${def.id}`)
  if (detected && (!hit || now - hit.at >= AGENT_MODELS_TTL_MS)) {
    void refreshAgentModels(def, cwd, now)
  }
  return hit ? [...hit.models] : [...def.models]
}

async function listAgentOptions(cwd: string): Promise<AgentOption[]> {
  const detected = await detectAgents(cwd)
  const ids = new Set(detected.map((def) => def.id))
  const now = Date.now()
  return AGENT_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    bin: def.bin,
    command: defaultCommand(def),
    detected: ids.has(def.id),
    models: agentModels(def, cwd, ids.has(def.id), now),
    efforts: def.efforts ? [...def.efforts] : [],
  }))
}

/** The configured command (with `-m`) replaces that provider's default row. */
export function overlayConfiguredAgent(
  agents: readonly AgentOption[],
  current: string | undefined,
): AgentOption[] {
  const trimmed = current?.trim() ?? ''
  if (!trimmed) {
    return [...agents]
  }
  const bin = trimmed.split(/\s+/)[0]?.split('/').pop() ?? ''
  return agents.map((agent) => (agent.bin === bin ? { ...agent, command: trimmed } : agent))
}

/**
 * Every task route is scoped by a MANDATORY project id (the multi-project
 * workspace: same task ids could exist in two repos). It rides the `project`
 * query param — except task creation, where it is `project_id` in the body.
 * Missing id → 400; an id that is not a registered project → 404 (from the
 * manager). This helper only enforces presence/shape of the query param.
 */
function requiredProjectParam(params: URLSearchParams): string | null {
  const id = params.get('project')
  return id && id.trim() ? id.trim() : null
}

/**
 * The repo-scoped read routes predating the multi-project workspace
 * (/api/mrs, /api/branches, /api/preview, /api/preview/diff) accept an
 * OPTIONAL `project` query param: present, the route operates on the
 * registered project's path (unknown id → 404, same convention as the task
 * routes); absent (or blank, mirroring requiredProjectParam's trim), the
 * route keeps its historical behavior and reads the launch directory.
 */
export function resolveProjectCwd(
  params: URLSearchParams,
  fallbackCwd: string,
): { cwd: string } | { error: 404 } {
  const id = params.get('project')
  if (id === null || !id.trim()) {
    return { cwd: fallbackCwd }
  }
  const project = getProject(id.trim())
  if (!project) {
    return { error: 404 }
  }
  return { cwd: project.path }
}

/**
 * The task routes drive agents that EDIT worktrees of the repo, so every
 * mutation carries the same per-server CSRF token mechanic as /api/fix (see
 * handleFixStart): x-codesema-tasks-token, injected into the served page.
 */
async function handleTaskCreate(
  req: IncomingMessage,
  res: ServerResponse,
  tasks: TasksEndpoint | undefined,
): Promise<void> {
  if (!tasks) {
    return sendJson(res, 501, { error: 'task manager unavailable' })
  }
  if (req.headers['x-codesema-tasks-token'] !== tasks.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_TASK_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const b = body as {
    project_id?: unknown
    title?: unknown
    prompt?: unknown
    autoShip?: unknown
    base?: unknown
    branch?: unknown
    target?: unknown
    issue?: unknown
    agent?: unknown
  } | null
  // T2.4: `issue` replaces `title`+`prompt` (which then become optional) — an
  // object is enough to route the request to the manager, which owns the
  // real validation (forge, project, iid, url) and its refusals.
  const issue =
    b?.issue && typeof b.issue === 'object' && !Array.isArray(b.issue)
      ? (b.issue as Record<string, unknown>)
      : null
  if (
    typeof b?.project_id !== 'string' ||
    !b.project_id.trim() ||
    (issue === null && (typeof b.title !== 'string' || typeof b.prompt !== 'string')) ||
    (b.title !== undefined && typeof b.title !== 'string') ||
    (b.prompt !== undefined && typeof b.prompt !== 'string') ||
    (b.issue !== undefined && issue === null) ||
    (b.autoShip !== undefined && typeof b.autoShip !== 'boolean') ||
    (b.base !== undefined && typeof b.base !== 'string') ||
    (b.branch !== undefined && typeof b.branch !== 'string') ||
    (b.target !== undefined && typeof b.target !== 'string') ||
    (b.agent !== undefined && typeof b.agent !== 'string')
  ) {
    return sendText(res, 400, 'bad request')
  }
  let resolvedAgent: string | undefined
  if (typeof b.agent === 'string') {
    const resolved = resolveKnownAgentCommand(b.agent)
    if (!resolved || resolved.length > TASK_AGENT_MAX) {
      return sendText(res, 400, 'bad request')
    }
    resolvedAgent = resolved
  }
  // base/branch/target are only type-checked here: the manager owns the real
  // validation (trim, length bound, option-lookalike refusal, branch
  // existence → 400, base/branch exclusivity → 400, active-conversation and
  // checked-out-elsewhere guards → 409). Same for `issue`: forge/project/iid/url
  // are handed through as `unknown` and validated by task-issue.ts.
  const created = await tasks.manager.create(b.project_id.trim(), {
    ...(typeof b.title === 'string' ? { title: b.title } : {}),
    ...(typeof b.prompt === 'string' ? { prompt: b.prompt } : {}),
    autoShip: b.autoShip ?? false,
    ...(typeof b.base === 'string' ? { base: b.base } : {}),
    ...(typeof b.branch === 'string' ? { branch: b.branch } : {}),
    ...(typeof b.target === 'string' ? { target: b.target } : {}),
    ...(resolvedAgent ? { agent: resolvedAgent } : {}),
    ...(issue
      ? {
          issue: {
            forge: issue.forge,
            project: issue.project,
            iid: issue.iid,
            url: issue.url,
          },
        }
      : {}),
  })
  if (!created.ok) {
    // existing_task_id rides along on the uniqueness 409: the web client
    // opens that conversation instead of showing a dead-end error. reason_code
    // rides along the same way, verbatim: the readable error stays the message,
    // the code is what a machine can branch on.
    return sendJson(res, created.code, {
      error: created.error,
      ...(created.existing_task_id !== undefined
        ? { existing_task_id: created.existing_task_id }
        : {}),
      ...(created.reason_code !== undefined ? { reason_code: created.reason_code } : {}),
    })
  }
  return sendJson(res, 201, created.record)
}

type TaskActionKind = 'reply' | 'ship' | 'interrupt' | 'abandon' | 'checks' | 'resume' | 'criteria'

/**
 * The mutations that carry NO request body: everything they need is already
 * on the record. 'resume' (T8) is one of them on purpose — the instruction it
 * restarts is the one the interrupted turn was given.
 */
const BODYLESS_TASK_ACTIONS: Record<
  'interrupt' | 'abandon' | 'resume',
  (
    manager: TaskManager,
    projectId: string,
    id: string,
  ) => TaskActionResult | Promise<TaskActionResult>
> = {
  interrupt: (manager, projectId, id) => manager.interrupt(projectId, id),
  abandon: (manager, projectId, id) => manager.abandon(projectId, id),
  resume: (manager, projectId, id) => manager.resume(projectId, id),
}

/**
 * Body of a task action. Success carries `queue_position` when the gesture left
 * the task WAITING (a reply or a resume behind another task of the same repo):
 * the caller renders the right thing without a round-trip, exactly like the
 * creation response. `preserved_branch` (T1.6) is set only by an abandon that
 * kept the branch instead of deleting it. A refusal carries its `reason_code`
 * next to — never instead of — the readable message, the way POST /api/tasks
 * already does.
 */
function taskActionBody(result: TaskActionResult): Record<string, unknown> {
  return result.ok
    ? {
        ok: true,
        ...(result.queue_position === undefined ? {} : { queue_position: result.queue_position }),
        ...(result.preserved_branch === undefined
          ? {}
          : { preserved_branch: result.preserved_branch }),
      }
    : { error: result.error, ...(result.reason_code ? { reason_code: result.reason_code } : {}) }
}

/** POST /api/tasks/:id/(reply|ship|interrupt|abandon|checks|resume|criteria)?project=, all under the tasks CSRF token. */
async function handleTaskAction(
  req: IncomingMessage,
  res: ServerResponse,
  tasks: TasksEndpoint | undefined,
  action: { id: string; kind: TaskActionKind; projectId: string | null },
): Promise<void> {
  if (!tasks) {
    return sendJson(res, 501, { error: 'task manager unavailable' })
  }
  if (req.headers['x-codesema-tasks-token'] !== tasks.token) {
    return sendText(res, 403, 'forbidden')
  }
  const projectId = action.projectId
  if (!projectId) {
    return sendText(res, 400, 'bad request')
  }
  if (!isTaskId(action.id)) {
    return sendText(res, 404, 'not found')
  }
  if (action.kind === 'criteria') {
    // T2.5: the ONLY path from a criteria proposal to disk. Persistence lives
    // in task-criteria.ts (loadTask/saveTask/appendTaskEvent) so this ticket
    // does not occupy a task-server.ts slot.
    let body: unknown
    try {
      body = await readJsonBody(req, MAX_TASK_BODY_BYTES)
    } catch {
      return sendText(res, 400, 'bad request')
    }
    const project = getProject(projectId)
    if (!project) {
      return sendText(res, 404, 'not found')
    }
    const result = applyTaskCriteria(project.path, action.id, body)
    return result.ok
      ? sendJson(res, 200, { ok: true, criteria: result.criteria })
      : sendJson(res, result.code, { error: result.error })
  }
  if (action.kind === 'ship') {
    // T5: push + MR creation. Success detail (MR URL, degraded-ship note)
    // travels on the SSE stream as the 'shipped' event and the record update.
    const result = await tasks.manager.ship(projectId, action.id)
    return result.ok
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, result.code, { error: result.error })
  }
  if (action.kind === 'checks') {
    // Fire-and-forget start: 202 says the run is on its way, the outcome
    // travels over SSE ('task_checks') and GET /api/tasks/:id/checks.
    const result = tasks.manager.checks(projectId, action.id)
    return result.ok
      ? sendJson(res, 202, { ok: true })
      : sendJson(res, result.code, { error: result.error })
  }
  if (action.kind !== 'reply') {
    const result = await BODYLESS_TASK_ACTIONS[action.kind](tasks.manager, projectId, action.id)
    return sendJson(res, result.ok ? 200 : result.code, taskActionBody(result))
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_TASK_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const message = (body as { message?: unknown } | null)?.message
  if (typeof message !== 'string') {
    return sendText(res, 400, 'bad request')
  }
  const result = tasks.manager.reply(projectId, action.id, message)
  return sendJson(res, result.ok ? 200 : result.code, taskActionBody(result))
}

const MAX_PROJECT_BODY_BYTES = 4 * 1024

/**
 * POST /api/projects registers a repo the workspace will drive agents in, so
 * it sits under the same tasks CSRF token as every task mutation (and DELETE
 * with it: a blind cross-site request must not be able to edit the registry).
 * The path must be an existing git repository ROOT; anything else is a 400.
 */
async function handleProjectAdd(
  req: IncomingMessage,
  res: ServerResponse,
  tasks: TasksEndpoint | undefined,
): Promise<void> {
  if (!tasks) {
    return sendJson(res, 501, { error: 'task manager unavailable' })
  }
  if (req.headers['x-codesema-tasks-token'] !== tasks.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_PROJECT_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const path = (body as { path?: unknown } | null)?.path
  if (typeof path !== 'string' || !path.trim()) {
    return sendText(res, 400, 'bad request')
  }
  const added = addProject(path.trim())
  if (!added.ok) {
    return sendJson(res, 400, { error: added.error })
  }
  return sendJson(res, 201, added.project)
}

/**
 * POST /api/projects/:id/checks-setup — asks the user's agent (read-only, no
 * tools, prompt-fed files only) to PROPOSE a checks configuration, and
 * POST /api/projects/:id/checks-apply — the only path from that proposal to
 * the repo's .codesema/config.json. Both drive an agent or write a config
 * file, so both sit under the tasks CSRF token like every other mutation.
 */
function handleChecksSetupAction(
  req: IncomingMessage,
  res: ServerResponse,
  tasks: TasksEndpoint | undefined,
  action: { id: string; kind: 'setup' | 'apply' },
): void {
  if (!tasks) {
    return sendJson(res, 501, { error: 'task manager unavailable' })
  }
  if (req.headers['x-codesema-tasks-token'] !== tasks.token) {
    return sendText(res, 403, 'forbidden')
  }
  const result =
    action.kind === 'setup'
      ? tasks.manager.checksSetup(action.id)
      : tasks.manager.checksApply(action.id)
  if (!result.ok) {
    return sendJson(res, result.code, { error: result.error })
  }
  // 202 for the setup (the agent runs in the background, the outcome travels
  // on SSE 'checks_proposal'), 200 for the apply (the file is written).
  return sendJson(res, action.kind === 'setup' ? 202 : 200, { ok: true })
}

/** DELETE /api/projects/:id — unregisters ONLY: the repo on disk is never touched. */
function handleProjectRemove(
  req: IncomingMessage,
  res: ServerResponse,
  tasks: TasksEndpoint | undefined,
  id: string,
): void {
  if (!tasks) {
    return sendJson(res, 501, { error: 'task manager unavailable' })
  }
  if (req.headers['x-codesema-tasks-token'] !== tasks.token) {
    return sendText(res, 403, 'forbidden')
  }
  if (!removeProject(id)) {
    return sendText(res, 404, 'not found')
  }
  return sendJson(res, 200, { ok: true })
}

/**
 * GET /api/tasks/events: ONE SSE stream for every conversation of every
 * registered project, each frame an envelope {project_id, task_id, event} (a
 * per-task EventSource would blow through MAX_SSE_CLIENTS on the first task
 * grid). On connect the current state is replayed as one 'task' frame per
 * existing record — ALL projects — so a late or reconnecting client rebuilds
 * its whole board without a separate fetch.
 */
function serveTaskEvents(
  manager: TaskManager,
  req: IncomingMessage,
  res: ServerResponse,
  onClose: () => void,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  })

  let eventId = 0
  const send = (envelope: TaskEnvelope) => {
    res.write(
      `event: ${envelope.event.name}\nid: ${eventId++}\ndata: ${JSON.stringify(envelope)}\n\n`,
    )
  }

  const unsubscribe = manager.subscribe(send)
  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: \n\n')
  }, 15000)

  for (const { project, records } of manager.listAll()) {
    for (const record of records) {
      send({ project_id: project.id, task_id: record.id, event: { name: 'task', data: record } })
    }
  }

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    onClose()
  })
}

async function handleMrsList(
  res: ServerResponse,
  cwd: string,
  listMrs: (cwd: string) => Promise<ForgeMrsResult>,
): Promise<void> {
  const result = await listMrs(cwd)
  sendJson(res, 200, result)
}

/** GET /api/preview?source=mr&number=N | ?source=branch&name=X: deterministic (no agent) MR/branch preview. */
async function handlePreview(
  res: ServerResponse,
  cwd: string,
  params: URLSearchParams,
): Promise<void> {
  const source = parsePreviewSource(params)
  if (!source) {
    return sendText(res, 400, 'bad request')
  }
  try {
    const preview = await buildPreview(cwd, source)
    return sendJson(res, 200, preview)
  } catch (err) {
    return sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) })
  }
}

/** GET /api/preview/diff?source=...&path=<file>: diff of a single file from the preview's own file list,
 *  capped in size (see PREVIEW_DIFF_MAX_CHARS); `path` is only ever used as a git pathspec, never as a
 *  filesystem path. */
async function handlePreviewDiff(
  res: ServerResponse,
  cwd: string,
  params: URLSearchParams,
): Promise<void> {
  const source = parsePreviewSource(params)
  const path = parsePreviewPath(params)
  if (!source || !path) {
    return sendText(res, 400, 'bad request')
  }
  try {
    const result = await buildFileDiff(cwd, source, path)
    return sendJson(res, 200, result)
  } catch (err) {
    return sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function serveStaticFile(res: ServerResponse, pathname: string): Promise<void> {
  const filePath = resolveStaticPath(WEB_DIST, pathname)
  if (!filePath) {
    return sendText(res, 404, 'not found')
  }
  let content: Buffer
  try {
    content = await readFile(filePath)
  } catch {
    return sendText(res, 404, 'not found')
  }
  const mime = MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff' })
  res.end(content)
}

const TASK_ACTION_RE =
  /^\/api\/tasks\/([^/]+)\/(reply|ship|interrupt|abandon|checks|resume|criteria)$/
const TASK_GET_RE = /^\/api\/tasks\/([^/]+)$/
const TASK_CHECKS_RE = /^\/api\/tasks\/([^/]+)\/checks$/
const TASK_REVIEW_RE = /^\/api\/tasks\/([^/]+)\/review$/
const PROJECT_DELETE_RE = /^\/api\/projects\/([^/]+)$/
const PROJECT_CHECKS_SETUP_RE = /^\/api\/projects\/([^/]+)\/checks-setup$/
const PROJECT_CHECKS_APPLY_RE = /^\/api\/projects\/([^/]+)\/checks-apply$/

function createRequestHandler(handlerOpts: {
  session: LiveSession
  indexHtml: string
  cwd: string
  configToken: string
  listMrs: (cwd: string) => Promise<ForgeMrsResult>
  fix?: FixEndpoint | undefined
  mrReview?: MrReviewEndpoint | undefined
  tasks?: TasksEndpoint | undefined
}) {
  const { session, indexHtml, cwd, configToken, listMrs, fix, mrReview, tasks } = handlerOpts
  // One cap for BOTH streams (review session + tasks): each browser tab holds
  // at most one of each, the cap only guards against runaway clients.
  let sseClients = 0
  const repoConfig: RepoConfigEndpoint = { cwd, token: configToken }
  const listAgents = (): Promise<AgentOption[]> => listAgentOptions(cwd)

  return (req: IncomingMessage, res: ServerResponse): void => {
    // The server only binds to loopback, but a malicious site could still reach
    // 127.0.0.1 via DNS rebinding (a domain that later resolves to loopback) and
    // read the diff/review. Accept only requests whose Host header is loopback, so
    // a rebound domain is rejected.
    if (!isLoopbackHost(req.headers.host)) {
      return sendText(res, 403, 'forbidden')
    }

    let pathname: string
    let searchParams: URLSearchParams
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      pathname = url.pathname
      searchParams = url.searchParams
    } catch {
      return sendText(res, 400, 'bad request')
    }

    if (req.method === 'POST') {
      if (pathname === '/api/fix') {
        return void handleFixStart(req, res, fix)
      }
      if (pathname === '/api/mrs/review') {
        return void handleMrReviewStart(req, res, mrReview)
      }
      if (pathname === '/api/tasks') {
        return void handleTaskCreate(req, res, tasks)
      }
      if (pathname === '/api/projects') {
        return void handleProjectAdd(req, res, tasks)
      }
      const checksSetupPost = PROJECT_CHECKS_SETUP_RE.exec(pathname)
      if (checksSetupPost?.[1]) {
        return handleChecksSetupAction(req, res, tasks, { id: checksSetupPost[1], kind: 'setup' })
      }
      const checksApplyPost = PROJECT_CHECKS_APPLY_RE.exec(pathname)
      if (checksApplyPost?.[1]) {
        return handleChecksSetupAction(req, res, tasks, { id: checksApplyPost[1], kind: 'apply' })
      }
      const taskAction = TASK_ACTION_RE.exec(pathname)
      if (taskAction?.[1] && taskAction[2]) {
        return void handleTaskAction(req, res, tasks, {
          id: taskAction[1],
          kind: taskAction[2] as TaskActionKind,
          projectId: requiredProjectParam(searchParams),
        })
      }
      return sendText(res, 405, 'method not allowed')
    }
    if (req.method === 'DELETE') {
      const projectDelete = PROJECT_DELETE_RE.exec(pathname)
      if (projectDelete?.[1]) {
        return handleProjectRemove(req, res, tasks, projectDelete[1])
      }
      return sendText(res, 405, 'method not allowed')
    }
    if (req.method === 'PUT') {
      if (pathname === '/api/config/rules') {
        return void handleRulesUpdate(req, res, repoConfig)
      }
      if (pathname === '/api/config/sync-auto-push') {
        return void handleSyncAutoPushUpdate(req, res, repoConfig)
      }
      if (pathname === '/api/config/agent') {
        return void handleConfigAgentUpdate(req, res, repoConfig, tasks)
      }
      return sendText(res, 405, 'method not allowed')
    }
    if (req.method !== 'GET') {
      return sendText(res, 405, 'method not allowed')
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/status') {
        return sendJson(res, 200, { ...session.status(), partial: session.partial() })
      }
      if (pathname === '/api/review') {
        const record = session.record()
        if (!record) {
          return sendJson(res, 202, session.status())
        }
        return sendJson(res, 200, record)
      }
      if (pathname === '/api/config') {
        return void handleConfigGet(res, cwd, tasks, listAgents)
      }
      if (
        pathname === '/api/mrs' ||
        pathname === '/api/branches' ||
        pathname === '/api/preview' ||
        pathname === '/api/preview/diff'
      ) {
        const scoped = resolveProjectCwd(searchParams, cwd)
        if ('error' in scoped) {
          return sendText(res, 404, 'not found')
        }
        if (pathname === '/api/mrs') {
          return void handleMrsList(res, scoped.cwd, listMrs)
        }
        if (pathname === '/api/branches') {
          return sendJson(res, 200, listLocalBranches(scoped.cwd))
        }
        if (pathname === '/api/preview') {
          return void handlePreview(res, scoped.cwd, searchParams)
        }
        return void handlePreviewDiff(res, scoped.cwd, searchParams)
      }
      if (pathname === '/api/fix/status') {
        if (!fix) {
          return sendJson(res, 200, { available: false })
        }
        return sendJson(res, 200, fix.runner.status())
      }
      if (pathname === '/api/mrs/review/status') {
        if (!mrReview) {
          return sendJson(res, 200, { available: false })
        }
        return sendJson(res, 200, mrReview.runner.status())
      }
      if (pathname === '/api/events') {
        if (sseClients >= MAX_SSE_CLIENTS) {
          return sendText(res, 503, 'too many event streams')
        }
        sseClients++
        return serveEvents(session, req, res, () => {
          sseClients--
        })
      }
      if (pathname === '/api/projects') {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        // Isolation is per project (T1.4). Each registry entry carries its
        // own overlay; `workspace` stays the launch-repo (or global) facts
        // for older UIs. selectProject is client-local, so the UI reads
        // `project.isolation` for the active card instead of refetching.
        return sendJson(res, 200, {
          projects: listProjects().map((project) => ({
            ...project,
            isolation: tasks.manager.workspaceInfo(project.id),
          })),
          current: tasks.currentProjectId,
          workspace: tasks.manager.workspaceInfo(tasks.currentProjectId),
        })
      }
      if (pathname === '/api/projects/discover') {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        // Read-only, launch-directory scoped: the same loopback + Host guards
        // as every other GET protect it; there is nothing to mutate.
        return sendJson(res, 200, { candidates: discoverProjects(cwd) })
      }
      if (pathname === '/api/tasks') {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        const projectId = requiredProjectParam(searchParams)
        if (!projectId) {
          return sendText(res, 400, 'bad request')
        }
        const records = tasks.manager.list(projectId)
        if (!records) {
          return sendText(res, 404, 'not found')
        }
        return sendJson(res, 200, records)
      }
      if (pathname === '/api/tasks/events') {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        if (sseClients >= MAX_SSE_CLIENTS) {
          return sendText(res, 503, 'too many event streams')
        }
        sseClients++
        return serveTaskEvents(tasks.manager, req, res, () => {
          sseClients--
        })
      }
      const checksSetupGet = PROJECT_CHECKS_SETUP_RE.exec(pathname)
      if (checksSetupGet?.[1]) {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        // Read-only view of an in-memory proposal: no token, same guards as
        // every other GET. 404 = unknown project (never "no proposal", which
        // is the legitimate 'idle' state).
        const state = tasks.manager.checksSetupStatus(checksSetupGet[1])
        return state ? sendJson(res, 200, state) : sendText(res, 404, 'not found')
      }
      const taskChecksGet = TASK_CHECKS_RE.exec(pathname)
      if (taskChecksGet?.[1]) {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        const projectId = requiredProjectParam(searchParams)
        if (!projectId) {
          return sendText(res, 400, 'bad request')
        }
        // 404 covers unknown project, unknown/malformed task id AND a task
        // whose checks never ran: the file simply is not there yet.
        const checks = isTaskId(taskChecksGet[1])
          ? tasks.manager.getChecks(projectId, taskChecksGet[1])
          : null
        if (!checks) {
          return sendText(res, 404, 'not found')
        }
        return sendJson(res, 200, checks)
      }
      const taskReviewGet = TASK_REVIEW_RE.exec(pathname)
      if (taskReviewGet?.[1]) {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        const projectId = requiredProjectParam(searchParams)
        if (!projectId) {
          return sendText(res, 400, 'bad request')
        }
        // Read-only like the other task GETs: no token. 'ref' selects the
        // archive of one PAST turn (the path its review_done event carries);
        // the manager rejects anything outside the project's reviews dir.
        // 404 covers unknown project/task, no review yet AND a pruned archive.
        const review = isTaskId(taskReviewGet[1])
          ? tasks.manager.getReview(projectId, taskReviewGet[1], searchParams.get('ref'))
          : null
        if (!review) {
          return sendText(res, 404, 'not found')
        }
        return sendJson(res, 200, review)
      }
      const taskGet = TASK_GET_RE.exec(pathname)
      if (taskGet?.[1]) {
        if (!tasks) {
          return sendJson(res, 501, { error: 'task manager unavailable' })
        }
        const projectId = requiredProjectParam(searchParams)
        if (!projectId) {
          return sendText(res, 400, 'bad request')
        }
        // isTaskId screens user input before it ever reaches a path join; the
        // manager rechecks, this is just the earliest honest 404.
        const found = isTaskId(taskGet[1]) ? tasks.manager.get(projectId, taskGet[1]) : null
        if (!found) {
          return sendText(res, 404, 'not found')
        }
        return sendJson(res, 200, found)
      }
      return sendText(res, 404, 'not found')
    }

    if (pathname === '/') {
      return sendHtml(res, indexHtml)
    }
    void serveStaticFile(res, pathname)
  }
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  startPort: number,
): Promise<{ server: Server; port: number }> {
  for (let port = startPort; port < startPort + 20; port++) {
    const server = createServer(handler)
    const ok = await new Promise<boolean>((resolveListen) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close()
        if (err.code !== 'EADDRINUSE') {
          console.error(err.message)
        }
        resolveListen(false)
      })
      server.listen(port, '127.0.0.1', () => resolveListen(true))
    })
    if (ok) {
      return { server, port }
    }
  }
  throw new Error(t('serve.noFreePort', { start: startPort, end: startPort + 19 }))
}

export async function startServer(
  session: LiveSession,
  opts: {
    cwd: string
    port?: number | undefined
    locale?: string | undefined
    fixRunner?: FixRunner | undefined
    mrReviewRunner?: MrReviewRunner | undefined
    taskManager?: TaskManager | undefined
    /** Project auto-registered from the boot repo (GET /api/projects `current`). */
    currentProjectId?: string | null | undefined
    /** Test seam for GET /api/mrs (same shape as mr-review-runner's); defaults to the real forge CLI probe. */
    listMrs?: ((cwd: string) => Promise<ForgeMrsResult>) | undefined
  },
): Promise<{ url: string; port: number; stop: () => Promise<void> }> {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    throw new Error(t('serve.noWebUi', { path: WEB_DIST }))
  }
  const configToken = randomBytes(16).toString('hex')
  const fix: FixEndpoint | undefined = opts.fixRunner
    ? { runner: opts.fixRunner, token: randomBytes(16).toString('hex') }
    : undefined
  const mrReview: MrReviewEndpoint | undefined = opts.mrReviewRunner
    ? { runner: opts.mrReviewRunner, token: randomBytes(16).toString('hex') }
    : undefined
  const tasks: TasksEndpoint | undefined = opts.taskManager
    ? {
        manager: opts.taskManager,
        token: randomBytes(16).toString('hex'),
        currentProjectId: opts.currentProjectId ?? null,
      }
    : undefined
  const bootScript = [
    `window.__CODESEMA_LOCALE__=${JSON.stringify(opts.locale ?? 'en')}`,
    `window.__CODESEMA_CONFIG_TOKEN__=${JSON.stringify(configToken)}`,
    ...(fix ? [`window.__CODESEMA_FIX_TOKEN__=${JSON.stringify(fix.token)}`] : []),
    ...(mrReview ? [`window.__CODESEMA_MRREVIEW_TOKEN__=${JSON.stringify(mrReview.token)}`] : []),
    ...(tasks ? [`window.__CODESEMA_TASKS_TOKEN__=${JSON.stringify(tasks.token)}`] : []),
  ].join(';')
  const indexHtml = readFileSync(join(WEB_DIST, 'index.html'), 'utf8').replace(
    '</head>',
    `<script>${bootScript}</script></head>`,
  )

  const { server, port } = await listen(
    createRequestHandler({
      session,
      indexHtml,
      cwd: opts.cwd,
      configToken,
      listMrs: opts.listMrs ?? listOpenMrs,
      fix,
      mrReview,
      tasks,
    }),
    opts.port ?? 4400,
  )
  const stop = () =>
    new Promise<void>((resolveClose) => {
      server.closeAllConnections()
      server.close(() => resolveClose())
    })
  return { url: `http://localhost:${port}`, port, stop }
}

/**
 * The runbook proposal: what a read-only agent is asked, how its answer is
 * whitelisted, and how the accepted runbook is written to the repository
 * (`.codesema/runbook.json`). Calque of checks-setup.ts. Lot C4 implements it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.js'
import { extractProposalJson, type SetupFile } from './checks-setup.js'
import {
  canonicalRunbookJson,
  isRunbookRelativePath,
  RUNBOOK_COMMAND_MAX,
  RUNBOOK_COMMANDS_MAX,
  RUNBOOK_EGRESS_MAX,
  RUNBOOK_HOST_MAX,
  RUNBOOK_IMAGE_MAX,
  RUNBOOK_PATHS_MAX,
  RUNBOOK_VERSION,
  sanitizeRunbookConfig,
  type RunbookConfig,
} from './contract.js'

export const RUNBOOK_FILE = '.codesema/runbook.json'

/** Tail kept of a retry's previous failure: enough context, never the whole log. */
export const PREVIOUS_FAILURE_MAX_CHARS = 4_000

export type RunbookProposalInput = {
  /** Files collected by `collectSetupFiles` (package manifests, lockfiles, compose, CI). */
  files: readonly SetupFile[]
  /** Tail of the previous failed execution, when the proposal is a retry. */
  previousFailure: string | null
  /** The image the runner would boot by default (resolved base image). */
  defaultImage: string
}

function runbookSetupInstructions(defaultImage: string): string {
  return `You propose the RUNBOOK of a repository for codesema: how it is installed, started and tested inside an isolated microVM, so the same steps can be REPLAYED later without the agent that proposed them.

Answer with ONE JSON object and NOTHING else:
{"version":1,"image":"...","install":["..."],"services":{"host_up":["..."],"compose_file":"..." or null},"healthchecks":["..."],"tests":["..."],"egress":["..."],"depends_on_files":["..."]}

Rules:
- version: always 1.
- image: an existing public OCI image, or "${defaultImage}" when nothing more specific is needed. If services.host_up or services.compose_file is set, the image MUST ship dockerd (the VM has no Docker of its own): pick a docker:dind-like image in that case.
- install: commands run ONCE in the base VM before its snapshot (dependency install, build steps the tests need).
- services.host_up: commands started at boot, in order, before the healthchecks run (e.g. "dockerd", "docker compose up -d"). Empty when nothing needs to run in the background.
- services.compose_file: the compose file's path, relative to the repository root, or null when there is none.
- healthchecks: commands retried until they exit 0 (or the runner's deadline) before the tests run.
- tests: 1 or more commands that must ALL exit 0 for the verdict to be green. Never empty.
- egress: the exact domain names the install and services steps need, beyond the runner's defaults (examples: registry.npmjs.org, deb.debian.org, registry-1.docker.io, auth.docker.io, production.cloudflare.docker.com). One fully qualified hostname per entry: no wildcard, no scheme, no port. The tests never get network access.
- depends_on_files: repository-relative paths whose change invalidates this runbook (lockfiles, the compose file, test configs, package.json).

Every command is a single shell line, relative to the repository root. Refused outright: sudo, piping a download into a shell ("curl ... | sh"), "rm -rf /", any absolute path, and any command spanning more than one line. Installing a tool belongs in the image, not in a command.

You have NO tools and NO filesystem access: the files below are everything you get, already read for you and truncated. Do not ask questions, do not explain outside the JSON. Output the JSON object now.`
}

/** The complete prompt: instructions, the previous failure when retrying, then the files verbatim. */
export function buildRunbookSetupPrompt(input: RunbookProposalInput): string {
  const parts = [runbookSetupInstructions(input.defaultImage)]
  if (input.previousFailure) {
    const tail = input.previousFailure.slice(-PREVIOUS_FAILURE_MAX_CHARS)
    parts.push(`<previous_failure>\n${tail}\n</previous_failure>`)
  }
  for (const file of input.files) {
    parts.push(`<file path="${file.path.replace(/"/g, "'")}">\n${file.content}\n</file>`)
  }
  return parts.join('\n\n')
}

export type RunbookProposalRejection = { ok: false; reason: string }
export type RunbookProposalAccepted = { ok: true; runbook: RunbookConfig }
type FieldResult<T> = { ok: true; value: T } | RunbookProposalRejection

/** Duplicated from contract.ts (private there): the same image reference shape. */
const RUNBOOK_IMAGE_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(:[0-9]{1,5})?(\/[a-zA-Z0-9._-]+)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$/
/** Duplicated from contract.ts (private there): one exact, lowercase, fully qualified host. */
const RUNBOOK_HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const SUDO_RE = /\bsudo\b/
const PIPE_TO_SHELL_RE = /\|\s*(sh|bash)\b/
const RM_RF_ROOT_RE = /\brm\s+-rf\s+\//
const NEWLINE_RE = /[\r\n]/

/**
 * Catches an absolute path even when it is not its own whitespace-delimited
 * token: glued onto a flag ("--output=/etc/x"), an env var assignment
 * ("FOO=/etc/x cmd"), a quoted argument ('"/etc/x"'), or a host:path pair
 * ("user@host:/etc/x"). A colon immediately followed by "//" is a URL scheme
 * (http://, ssh://...), not a path, and is deliberately excluded so a normal
 * healthcheck URL still passes.
 */
const ABSOLUTE_PATH_RE = /(?:^|[\s='"])\/|:\/(?!\/)/

function hasAbsolutePathToken(command: string): boolean {
  return ABSOLUTE_PATH_RE.test(command)
}

function validateImage(raw: unknown): FieldResult<string> {
  const image = typeof raw === 'string' ? raw.trim() : ''
  if (!image || image.length > RUNBOOK_IMAGE_MAX || !RUNBOOK_IMAGE_RE.test(image)) {
    return { ok: false, reason: `invalid image reference: ${JSON.stringify(raw)}` }
  }
  return { ok: true, value: image }
}

function validateCommands(raw: unknown, label: string): FieldResult<string[]> {
  if (raw === undefined) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `${label} must be an array of commands` }
  }
  const commands: string[] = []
  for (const item of raw) {
    if (commands.length >= RUNBOOK_COMMANDS_MAX) {
      break
    }
    if (typeof item !== 'string') {
      return { ok: false, reason: `${label} entries must be strings` }
    }
    const command = item.trim()
    if (!command) {
      continue
    }
    if (command.length > RUNBOOK_COMMAND_MAX) {
      return {
        ok: false,
        reason: `${label} command exceeds ${RUNBOOK_COMMAND_MAX} characters: ${command}`,
      }
    }
    if (NEWLINE_RE.test(command)) {
      return {
        ok: false,
        reason: `${label} command must be a single line: ${JSON.stringify(command)}`,
      }
    }
    if (SUDO_RE.test(command)) {
      return { ok: false, reason: `${label} command must not use sudo: ${command}` }
    }
    if (PIPE_TO_SHELL_RE.test(command)) {
      return { ok: false, reason: `${label} command must not pipe into a shell: ${command}` }
    }
    if (RM_RF_ROOT_RE.test(command)) {
      return {
        ok: false,
        reason: `${label} command must not remove the root filesystem: ${command}`,
      }
    }
    if (hasAbsolutePathToken(command)) {
      return {
        ok: false,
        reason: `${label} command must not reference an absolute path: ${command}`,
      }
    }
    commands.push(command)
  }
  return { ok: true, value: commands }
}

function validateEgress(raw: unknown): FieldResult<string[]> {
  if (raw === undefined) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'egress must be an array of hostnames' }
  }
  const hosts: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (hosts.length >= RUNBOOK_EGRESS_MAX) {
      break
    }
    if (typeof item !== 'string') {
      return { ok: false, reason: 'egress entries must be strings' }
    }
    const host = item.trim().toLowerCase()
    if (!host) {
      continue
    }
    if (host.length > RUNBOOK_HOST_MAX || !RUNBOOK_HOST_RE.test(host)) {
      return { ok: false, reason: `egress must be exact hostnames, not ${JSON.stringify(item)}` }
    }
    if (!seen.has(host)) {
      seen.add(host)
      hosts.push(host)
    }
  }
  return { ok: true, value: hosts }
}

function validatePaths(raw: unknown, label: string): FieldResult<string[]> {
  if (raw === undefined) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `${label} must be an array of paths` }
  }
  const paths: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (paths.length >= RUNBOOK_PATHS_MAX) {
      break
    }
    if (typeof item !== 'string') {
      return { ok: false, reason: `${label} entries must be strings` }
    }
    if (!isRunbookRelativePath(item)) {
      return { ok: false, reason: `${label} path outside the worktree: ${JSON.stringify(item)}` }
    }
    if (!seen.has(item)) {
      seen.add(item)
      paths.push(item)
    }
  }
  return { ok: true, value: paths }
}

function validateComposeFile(raw: unknown): FieldResult<string | null> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'services.compose_file must be a string or null' }
  }
  if (!isRunbookRelativePath(raw)) {
    return {
      ok: false,
      reason: `services.compose_file outside the worktree: ${JSON.stringify(raw)}`,
    }
  }
  return { ok: true, value: raw }
}

/**
 * Whitelists an agent's proposal: bounds, exact egress hosts, worktree-relative
 * paths, an image the runner accepts, at least one test. Everything else is a
 * rejection with a readable reason the agent gets back.
 */
export function sanitizeRunbookProposal(
  raw: unknown,
): RunbookProposalAccepted | RunbookProposalRejection {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'agent output must be text' }
  }
  const parsed = extractProposalJson(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'no JSON object found in the agent output' }
  }
  const p = parsed as Record<string, unknown>
  if (p.version !== RUNBOOK_VERSION) {
    return { ok: false, reason: `unsupported runbook version, expected ${RUNBOOK_VERSION}` }
  }

  const image = validateImage(p.image)
  if (!image.ok) {
    return image
  }
  const install = validateCommands(p.install, 'install')
  if (!install.ok) {
    return install
  }
  const services =
    p.services && typeof p.services === 'object' && !Array.isArray(p.services)
      ? (p.services as Record<string, unknown>)
      : {}
  const hostUp = validateCommands(services.host_up, 'services.host_up')
  if (!hostUp.ok) {
    return hostUp
  }
  const composeFile = validateComposeFile(services.compose_file)
  if (!composeFile.ok) {
    return composeFile
  }
  const healthchecks = validateCommands(p.healthchecks, 'healthchecks')
  if (!healthchecks.ok) {
    return healthchecks
  }
  const tests = validateCommands(p.tests, 'tests')
  if (!tests.ok) {
    return tests
  }
  if (tests.value.length === 0) {
    return { ok: false, reason: 'runbook must include at least one test command' }
  }
  const egress = validateEgress(p.egress)
  if (!egress.ok) {
    return egress
  }
  const dependsOnFiles = validatePaths(p.depends_on_files, 'depends_on_files')
  if (!dependsOnFiles.ok) {
    return dependsOnFiles
  }

  const candidate: RunbookConfig = {
    version: RUNBOOK_VERSION,
    image: image.value,
    install: install.value,
    services: { host_up: hostUp.value, compose_file: composeFile.value },
    healthchecks: healthchecks.value,
    tests: tests.value,
    egress: egress.value,
    depends_on_files: dependsOnFiles.value,
  }
  const runbook = sanitizeRunbookConfig(candidate)
  if (!runbook) {
    return { ok: false, reason: 'runbook failed final validation' }
  }
  return { ok: true, runbook }
}

/** Atomic write of `.codesema/runbook.json` (temp file + rename), returns the runbook sha (16 hex). */
export function writeRunbookConfig(worktree: string, runbook: RunbookConfig): string {
  writeJsonAtomic(join(worktree, RUNBOOK_FILE), runbook)
  return runbookSha(runbook)
}

/** Reads and revalidates `.codesema/runbook.json`; null when absent or invalid. */
export function readRunbookConfig(worktree: string): RunbookConfig | null {
  let raw: string
  try {
    raw = readFileSync(join(worktree, RUNBOOK_FILE), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return sanitizeRunbookConfig(parsed)
}

/** sha256 of `canonicalRunbookJson(runbook)`, first 16 hex: the `runbook_sha` both repositories agree on. */
export function runbookSha(runbook: RunbookConfig): string {
  return createHash('sha256').update(canonicalRunbookJson(runbook)).digest('hex').slice(0, 16)
}

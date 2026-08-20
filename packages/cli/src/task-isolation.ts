// Container isolation: the WHOLE agent turn of a task runs inside its own
// container ("its box"), so the agent gets full Bash rights without those
// rights ever touching the host. This is the primary isolation mode; the
// policy mode (host + CLI hardening flags) is the fallback.
//
// What the cage is made of:
// - a BASE image resolved from the repo itself (devcontainer core → the checks
//   detection image → node:26), so the agent works in the environment the
//   project already describes for humans;
// - an AGENT image derived from it (non-root user at the host's uid + git +
//   claude-code),
//   tagged by content hash and built once;
// - a per-workspace INTERNAL network plus one squid container as the only way
//   out: CONNECT to the allowlisted domains, nothing else;
// - a per-task named volume as the agent's HOME (claude credentials copied in
//   once, provider sessions persisted across turns);
// - the task worktree as the ONLY host path mounted (rw), everything else of
//   the machine is simply absent.
//
// Doctrine, same as the checks engine: nothing is ever interpolated into a
// HOST shell — execFile/spawn with an argv array only. The command string
// runs under `sh -lc` INSIDE the container, where it can do no harm beyond
// the mount. Git credentials never enter the cage: the runner still commits
// the worktree from the host, and the repo's git directory is exposed to the
// box READ-ONLY (container-git.ts) so the agent can see what it changed
// without being able to rewrite a single ref.

import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_KILL_GRACE_MS,
  AGENT_SETTLE_GRACE_MS,
  AGENT_WATCHDOG_DEFAULTS,
  AgentWatchdogError,
  armStreamWatchdog,
  knownAgent,
  systemClock,
  watchdogMessage,
  type AgentClock,
  type AgentHeartbeat,
  type AgentWatchdogCause,
  type WatchdogBudgets,
} from './agent.js'
import type { IsolationMode } from './config.js'
import { gitSafeDirectoryEnvArgs, prepareContainerGit } from './container-git.js'
import { isTaskId, type TaskIsolation } from './contract.js'
import { t } from './i18n.js'
import type { ChecksConfig } from './repo-config.js'
import { detectContainerRuntime, resolveChecksPlan, type ExecResult } from './task-checks.js'

// --- constants -------------------------------------------------------------

/** Last-resort base image when the repo says nothing about its environment. */
export const DEFAULT_BASE_IMAGE = 'node:26'

/**
 * Domains the caged agent may reach when the workspace configures none: the
 * strict minimum for the agent to work, and nothing else — no package
 * registry, no github, no arbitrary host it could be talked into posting the
 * repository to.
 *
 * `platform.claude.com` is not decoration: Claude Code's documented network
 * requirements put OAuth token exchange, refresh and revocation on that host
 * (code.claude.com/docs/en/network-config), so a cage that allowed only
 * api.anthropic.com would work until the copied credentials expired and then
 * fail in a way nobody could diagnose.
 */
export const DEFAULT_ISOLATION_ALLOWED_DOMAINS: readonly string[] = [
  'api.anthropic.com',
  'platform.claude.com',
]

/**
 * Canonical's Squid image, pinned (there is no Docker Official squid image).
 * Tag verified against the registry (docker.io/ubuntu/squid, 2026-08).
 */
export const EGRESS_PROXY_IMAGE = 'ubuntu/squid:6.6-24.04_beta'

/** Port squid listens on inside the proxy container. */
export const EGRESS_PROXY_PORT = 3128

/** Worktree mount point inside the cage; the agent's cwd. */
export const CAGE_WORK_DIR = '/work'

/** HOME of the non-root user the agent runs as. */
export const CAGE_HOME_DIR = '/home/agent'

/** Default install of the agent CLI into the image; injectable (tests, smoke runs). */
export const DEFAULT_CLAUDE_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code'

/** Bun bases have no npm: BUN_INSTALL puts the binary on the shared PATH. */
export const BUN_CLAUDE_INSTALL_COMMAND =
  'BUN_INSTALL=/usr/local bun install -g @anthropic-ai/claude-code'

/**
 * Git is not optional equipment for the agent: reading the diff, the log and
 * the state its previous turn left behind is half of what it does in a task
 * worktree. `node:` ships it, `node:*-slim`, `*-alpine` and plenty of
 * hand-rolled devcontainer images do not — and the cage would then hand the
 * agent a repository it can see but not question.
 *
 * Nothing is assumed about the distribution: the base is ASKED what package
 * manager it has (the same shape as the useradd/adduser probe above), and an
 * image that has none fails the build with a sentence a human can act on
 * rather than silently producing a git-less box.
 */
export const GIT_INSTALL_COMMAND = [
  'if command -v git >/dev/null 2>&1; then exit 0; fi',
  'if command -v apt-get >/dev/null 2>&1; then',
  '  apt-get update && apt-get install -y --no-install-recommends git && apt-get clean; exit $?;',
  'fi',
  'if command -v apk >/dev/null 2>&1; then apk add --no-cache git; exit $?; fi',
  'if command -v microdnf >/dev/null 2>&1; then microdnf install -y git; exit $?; fi',
  'if command -v dnf >/dev/null 2>&1; then dnf install -y git; exit $?; fi',
  'if command -v yum >/dev/null 2>&1; then yum install -y git; exit $?; fi',
  'if command -v zypper >/dev/null 2>&1; then zypper --non-interactive install git; exit $?; fi',
  'if command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm git; exit $?; fi',
  'echo "codesema: this base image ships no git and no package manager to install one' +
    ' (tried apt-get, apk, microdnf, dnf, yum, zypper, pacman) — add git to the image your' +
    ' .devcontainer or checks config points at" >&2',
  'exit 1',
].join('\n')

/**
 * The non-root user of the cage — REUSED from the base image when the host's
 * uid is already taken there, created only when it is free.
 *
 * The bug this shape exists for: the previous recipe always tried to CREATE a
 * user with the host's uid/gid. That works on a shadow/glibc base (`useradd -o`
 * tolerates a duplicate uid) and is impossible on a busybox/alpine one — there
 * is no `groupadd`, `addgroup -g 1000` fails because the official `node` image
 * already owns gid 1000, and busybox `adduser` has no `-o` to allow a duplicate
 * uid. Every fallback of the chain failed in cascade ("adduser: unknown group
 * agent", then "adduser: uid '1000' in use") and the cage image could not be
 * built on ANY alpine base.
 *
 * So the base is ASKED what it already has, exactly like the git probe below.
 * The common case is not an accident: images that ship a non-root user put it
 * at uid 1000, which IS the host uid of most single-user machines, so reusing
 * it is both correct and free. A user is created only when nothing owns that
 * uid, with the shadow and busybox spellings chosen by probe instead of chained
 * as a "|| maybe this one works" pile that hides which step really failed.
 *
 * The final USER is NUMERIC (`uid:gid`): the reused user's name is only known
 * INSIDE the build, and a Dockerfile cannot carry a value computed by a RUN
 * into its USER instruction. Numeric is what the kernel checks anyway, and a
 * passwd entry for that uid exists in both branches, so whatever looks the name
 * up still finds one. HOME stays CAGE_HOME_DIR whatever the reused user's own
 * home is (`/home/node` on a node base): that is the path the per-task home
 * volume is mounted at (containerRunArgs, bootstrapAgentHome), and the ENV wins
 * over the passwd entry.
 *
 * Failure stays loud: a base where the uid is free and no user can be created
 * is a base where the agent would end up root, which is not a cage.
 */
export function agentUserCommand(uid: number, gid: number): string {
  return [
    'set -e',
    // getent first (it also sees an NSS-only passwd), /etc/passwd as the
    // fallback for a base too small to have it.
    `existing=$(getent passwd ${uid} 2>/dev/null | cut -d: -f1 || true)`,
    `if [ -z "$existing" ]; then`,
    `  existing=$(awk -F: -v u=${uid} '$3 == u { print $1; exit }' /etc/passwd 2>/dev/null || true)`,
    'fi',
    'if [ -n "$existing" ]; then',
    `  echo "codesema: uid ${uid} already belongs to '$existing' in this base image — reusing it"`,
    'else',
    `  group=$(awk -F: -v g=${gid} '$3 == g { print $1; exit }' /etc/group 2>/dev/null || true)`,
    '  if [ -z "$group" ]; then',
    `    if command -v groupadd >/dev/null 2>&1; then groupadd -g ${gid} agent;`,
    `    elif command -v addgroup >/dev/null 2>&1; then addgroup -g ${gid} agent;`,
    '    else',
    `      echo "codesema: this base image has neither groupadd nor addgroup, so the cage cannot` +
      ` own gid ${gid} — add a non-root user to the image your .devcontainer or checks config` +
      ` points at" >&2`,
    '      exit 1',
    '    fi',
    '    group=agent',
    '  fi',
    '  if command -v useradd >/dev/null 2>&1; then',
    `    useradd -m -d ${CAGE_HOME_DIR} -u ${uid} -g ${gid} -s /bin/sh agent`,
    '  elif command -v adduser >/dev/null 2>&1; then',
    `    adduser -D -h ${CAGE_HOME_DIR} -u ${uid} -G "$group" -s /bin/sh agent`,
    '  else',
    `    echo "codesema: this base image has neither useradd nor adduser, so the caged agent would` +
      ` run as root — add a non-root user to the image your .devcontainer or checks config points` +
      ` at" >&2`,
    '    exit 1',
    '  fi',
    'fi',
    `mkdir -p ${CAGE_HOME_DIR} ${CAGE_WORK_DIR}`,
    `chown -R ${uid}:${gid} ${CAGE_HOME_DIR}`,
  ].join('\n')
}

/** Resource ceiling of one caged turn. */
export const CAGE_MEMORY = '4g'
export const CAGE_CPUS = '2'

/**
 * Provider variables forwarded into the cage BY NAME (`-e NAME`), never by
 * value: a value in argv would be readable in `ps` on the host. Anything else
 * in the user's environment stays out — same doctrine as agentEnv.
 */
export const CAGE_FORWARDED_ENV: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
]

/** Deterministic per-task container name: interrupt/timeout kill it by name. */
export function agentContainerName(taskId: string): string {
  return `codesema-task-${taskId}`
}

/** Per-task HOME volume: credentials bootstrapped once, sessions kept across turns. */
export function agentHomeVolume(taskId: string): string {
  return `codesema-home-${taskId}`
}

/**
 * Docker/podman label key stamped on every HOME volume THIS process creates,
 * with the OS user's numeric id as its value (Décision, T1.9 review round 1):
 * a machine with several `docker`-group users sharing one daemon has no
 * other way to tell "idle, ours" from "idle, a colleague's" — a name alone
 * (`codesema-home-<id>`) says nothing about who made it. The boot sweep
 * reads it back to refuse ever touching a volume owned by a DIFFERENT uid.
 */
export const HOME_VOLUME_OWNER_LABEL = 'codesema.workspace'

/** Stable per-OS-user id for the label above; 0 on a platform with no uid (never Linux/macOS with docker). */
export function workspaceOwnerId(): string {
  return String(process.getuid?.() ?? 0)
}

// --- exec seam -------------------------------------------------------------

/**
 * Host-side process runner, injectable in tests (unit tests NEVER run docker).
 * Superset of the checks engine's ExecFn: adds stdin (`input`) so a secret can
 * be piped into an ephemeral container instead of appearing in argv, and an
 * env override for the client itself.
 */
export type IsolationExecFn = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>

const EXEC_MAX_BUFFER = 4 * 1024 * 1024

/** Real exec: execFile only (argv array, no shell). Never rejects. */
const defaultExec: IsolationExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: EXEC_MAX_BUFFER,
        ...(opts.env ? { env: opts.env } : {}),
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, timedOut: false, failure: null })
          return
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
        if (e.killed || e.signal) {
          resolve({ code: null, stdout, stderr, timedOut: true, failure: null })
          return
        }
        if (typeof e.code === 'number') {
          resolve({ code: e.code, stdout, stderr, timedOut: false, failure: null })
          return
        }
        resolve({ code: null, stdout, stderr, timedOut: false, failure: e.message })
      },
    )
    if (opts.input !== undefined && child.stdin) {
      // A client that dies early closes stdin: without a handler the EPIPE
      // would take the whole workspace process down.
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input)
    }
  })

// --- base image resolution (pure) -----------------------------------------

/** Where the base image of the cage came from — reported, never guessed twice. */
export type BaseImageSource =
  'devcontainer-image' | 'devcontainer-dockerfile' | 'checks' | 'default'

export type BaseImage = {
  source: BaseImageSource
  /** Image reference used as FROM; null when the base must be built first. */
  image: string | null
  /** Dockerfile path RELATIVE to the worktree, when the base is built. */
  dockerfile: string | null
  /** Build context, relative to the worktree (the devcontainer folder). */
  context: string | null
  /** devcontainer postCreateCommand, only when it is a simple string. */
  postCreate: string | null
}

export type BaseImageInput = {
  /** Raw .devcontainer/devcontainer.json content, null when absent/unreadable. */
  devcontainer: string | null
  /** Image the checks detection would use for this repo, null when it detects nothing. */
  checksImage: string | null
}

/** An image ref goes verbatim into a generated `FROM`: keep it boring or drop it. */
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/

/** A devcontainer Dockerfile path stays INSIDE the devcontainer folder. */
const DOCKERFILE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

/** A postCreateCommand is a shell line, not a script: bounded and single-line. */
const POST_CREATE_MAX = 500

/**
 * Tolerant JSON parse for devcontainer.json: the format is JSONC (line and
 * block comments, trailing commas are common in the wild). Comment stripping
 * is string-aware so a `//` inside a value survives. Null on anything that is
 * not a JSON object — an unparseable devcontainer simply does not contribute.
 */
export function parseJsonc(raw: string): Record<string, unknown> | null {
  let out = ''
  let inString = false
  let escaped = false
  let i = 0
  while (i < raw.length) {
    const char = raw[i] ?? ''
    if (inString) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      i++
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      i++
      continue
    }
    if (char === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') {
        i++
      }
      continue
    }
    if (char === '/' && raw[i + 1] === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        i++
      }
      i += 2
      continue
    }
    out += char
    i++
  }
  // Trailing commas before } or ] (outside strings — the pass above kept
  // strings intact, so a comma inside one is not followed by a bare brace).
  const cleaned = out.replace(/,(\s*[}\]])/g, '$1')
  try {
    const value: unknown = JSON.parse(cleaned)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const fallbackBase = (input: BaseImageInput): BaseImage => {
  const checks = input.checksImage?.trim() ?? ''
  if (checks && IMAGE_REF_RE.test(checks)) {
    return {
      source: 'checks',
      image: checks,
      dockerfile: null,
      context: null,
      postCreate: null,
    }
  }
  return {
    source: 'default',
    image: DEFAULT_BASE_IMAGE,
    dockerfile: null,
    context: null,
    postCreate: null,
  }
}

/**
 * PURE base-image resolution, in the documented order:
 *   1. the CORE of .devcontainer/devcontainer.json — an `image`, or a
 *      `build.dockerfile` relative to the devcontainer folder, plus a simple
 *      STRING postCreateCommand;
 *   2. the image the checks detection picked for this repo;
 *   3. `DEFAULT_BASE_IMAGE` — node:26.
 *
 * Everything the core does not cover (features, docker-compose, an array or
 * object postCreateCommand, a build context outside the devcontainer folder)
 * makes the whole devcontainer be IGNORED — cleanly, falling through to (2).
 * Honouring half a devcontainer would build an environment the project never
 * described.
 */
export function resolveBaseImage(input: BaseImageInput): BaseImage {
  const raw = input.devcontainer
  if (!raw) {
    return fallbackBase(input)
  }
  const dc = parseJsonc(raw)
  if (!dc) {
    return fallbackBase(input)
  }
  // Out of the supported core: a compose stack or features would need the
  // devcontainer CLI to be honest about what it builds.
  if (dc.dockerComposeFile !== undefined) {
    return fallbackBase(input)
  }
  const features = dc.features
  if (features && typeof features === 'object' && Object.keys(features).length > 0) {
    return fallbackBase(input)
  }
  // Only a simple string is supported; an array/object form is a whole
  // lifecycle description, not one shell line.
  const post = dc.postCreateCommand
  if (post !== undefined && typeof post !== 'string') {
    return fallbackBase(input)
  }
  const postCreate = typeof post === 'string' ? post.trim().replace(/\s+/g, ' ') : ''
  if (postCreate.length > POST_CREATE_MAX) {
    return fallbackBase(input)
  }
  const image = typeof dc.image === 'string' ? dc.image.trim() : ''
  if (image) {
    if (!IMAGE_REF_RE.test(image)) {
      return fallbackBase(input)
    }
    return {
      source: 'devcontainer-image',
      image,
      dockerfile: null,
      context: null,
      postCreate: postCreate || null,
    }
  }
  const build = dc.build
  if (build && typeof build === 'object' && !Array.isArray(build)) {
    const b = build as Record<string, unknown>
    // A custom context cannot be honoured without reproducing devcontainer's
    // path semantics: fall through rather than build the wrong thing.
    if (b.context !== undefined && b.context !== '.') {
      return fallbackBase(input)
    }
    const dockerfile = typeof b.dockerfile === 'string' ? b.dockerfile.trim() : ''
    if (
      dockerfile &&
      DOCKERFILE_PATH_RE.test(dockerfile) &&
      !dockerfile.split('/').includes('..')
    ) {
      return {
        source: 'devcontainer-dockerfile',
        image: null,
        dockerfile: `.devcontainer/${dockerfile}`,
        context: '.devcontainer',
        postCreate: postCreate || null,
      }
    }
  }
  return fallbackBase(input)
}

/** Disk side of the resolution: reads the devcontainer, asks the checks detection. */
export function readBaseImageInputs(
  worktree: string,
  config?: ChecksConfig | null,
): BaseImageInput {
  let devcontainer: string | null = null
  for (const candidate of [
    join(worktree, '.devcontainer', 'devcontainer.json'),
    join(worktree, '.devcontainer.json'),
  ]) {
    try {
      devcontainer = readFileSync(candidate, 'utf8')
      break
    } catch {
      devcontainer = null
    }
  }
  let checksImage: string | null = null
  try {
    checksImage =
      resolveChecksPlan({
        worktree,
        ...(config !== undefined ? { config } : {}),
      })?.image ?? null
  } catch {
    checksImage = null
  }
  return { devcontainer, checksImage }
}

// --- agent image -----------------------------------------------------------

/** Shell-quoted safely by construction: JSON exec form, never a bare RUN line. */
const runLine = (command: string): string => `RUN ["sh","-lc",${JSON.stringify(command)}]`

/** npm on most bases, bun on a bun base — the seam exists so tests pin it. */
export function defaultInstallCommand(baseRef: string): string {
  return /(^|\/)bun(:|$)/.test(baseRef)
    ? BUN_CLAUDE_INSTALL_COMMAND
    : DEFAULT_CLAUDE_INSTALL_COMMAND
}

export type AgentDockerfileInput = {
  /** Fully resolved FROM reference (a plain image, or the pre-built base tag). */
  baseRef: string
  /** claude-code installation, run as root so the binary lands on the shared PATH. */
  installCommand: string
  /** devcontainer postCreateCommand, or null. */
  postCreate: string | null
  /** uid/gid the caged turn runs as: the host's, so the bind-mounted worktree stays writable. */
  uid: number
  gid: number
}

/**
 * The generated agent image. The turn runs under the HOST's uid/gid — reusing
 * the base's own non-root user when it already owns that uid (agentUserCommand)
 * — so files written in the mounted worktree belong to the human who owns the
 * repo, and podman gets --userns=keep-id at run time to match.
 *
 * A base where that uid is free and no user can be created fails the BUILD,
 * loudly: an image where the agent would end up root is not a cage. A base
 * without git — and without any way to get it — fails it the same way: an agent
 * that cannot read the worktree's history is not the agent the task was
 * recorded with.
 *
 * Order is load-bearing: the user setup, the git install and the claude-code
 * install all run as ROOT, before the final USER, so the binaries land on the
 * shared PATH and the package manager can write.
 */
export function generateAgentDockerfile(input: AgentDockerfileInput): string {
  const { uid, gid } = input
  const lines = [
    '# Generated by codesema — agent cage image, do not edit.',
    `FROM ${input.baseRef}`,
    'USER root',
    runLine(agentUserCommand(uid, gid)),
    runLine(GIT_INSTALL_COMMAND),
    runLine(input.installCommand),
  ]
  if (input.postCreate) {
    // BEST EFFORT: a devcontainer postCreateCommand usually expects the
    // project checked out (it is not, at build time). It may prepare useful
    // tooling, it must never be able to break the cage itself.
    lines.push(runLine(`${input.postCreate} || echo 'codesema: postCreateCommand failed'`))
  }
  lines.push(
    `ENV HOME=${CAGE_HOME_DIR}`,
    `WORKDIR ${CAGE_WORK_DIR}`,
    // Numeric: the reused user's NAME is only known inside the build.
    `USER ${uid}:${gid}`,
    '',
  )
  return lines.join('\n')
}

/** codesema-agent:<12 hex of sha256(base + dockerfile + host claude version)>. */
export function agentImageTag(baseRef: string, dockerfile: string, claudeVersion: string): string {
  const hash = createHash('sha256')
    .update(`${baseRef} ${dockerfile} ${claudeVersion}`)
    .digest('hex')
    .slice(0, 12)
  return `codesema-agent:${hash}`
}

export type BuildAgentImageOptions = {
  worktree: string
  base: BaseImage
  /** Host claude version, folded into the tag: a CLI upgrade rebuilds the cage. */
  claudeVersion: string
  runtime: string
  execFn?: IsolationExecFn
  /** Test/smoke seam; defaults to defaultInstallCommand(base). */
  installCommand?: string
  uid?: number
  gid?: number
  timeoutMs?: number
}

/** Build budget: pulling a base and installing a global npm package is slow. */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000

/** tag → in-flight/settled build. A rejected build is evicted so the next turn retries. */
const imageBuilds = new Map<string, Promise<string>>()

/** Everything memoized per process (builds, proxies, homes, probes). Tests call it in beforeEach. */
export function resetIsolationCaches(): void {
  imageBuilds.clear()
  proxies.clear()
  startedProxies.clear()
  homes.clear()
  podmanProbes.clear()
  cachedRuntime = null
  cachedClaudeVersion = null
}

function buildFailure(result: ExecResult): string {
  const detail = (result.failure ?? `${result.stdout}${result.stderr}`).trim()
  return detail.slice(-1500) || `exit code ${String(result.code)}`
}

/**
 * Builds (once) the agent image derived from the resolved base and returns
 * its tag. A devcontainer Dockerfile base is built first, under its own tag,
 * then used as the FROM of the agent image.
 *
 * Rejects with a readable error when the build fails: container isolation is
 * then UNAVAILABLE for that task, and the turn fails saying so. It never
 * silently degrades to running on the host — the record promised a cage.
 */
export async function buildAgentImage(opts: BuildAgentImageOptions): Promise<string> {
  const exec = opts.execFn ?? defaultExec
  const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS
  const uid = opts.uid ?? process.getuid?.() ?? 1000
  const gid = opts.gid ?? process.getgid?.() ?? 1000

  let baseRef = opts.base.image ?? ''
  let baseTag: string | null = null
  if (!baseRef) {
    const dockerfile = opts.base.dockerfile ?? ''
    const context = opts.base.context ?? '.'
    const hash = createHash('sha256')
      .update(`${opts.worktree} ${dockerfile}`)
      .digest('hex')
      .slice(0, 12)
    baseTag = `codesema-base:${hash}`
    baseRef = baseTag
    const built = await exec(
      opts.runtime,
      ['build', '-f', join(opts.worktree, dockerfile), '-t', baseTag, join(opts.worktree, context)],
      { timeoutMs },
    )
    if (built.code !== 0) {
      throw new Error(t('isolation.buildFailed', { error: buildFailure(built) }))
    }
  }

  const dockerfile = generateAgentDockerfile({
    baseRef,
    installCommand: opts.installCommand ?? defaultInstallCommand(baseRef),
    postCreate: opts.base.postCreate,
    uid,
    gid,
  })
  const tag = agentImageTag(baseRef, dockerfile, opts.claudeVersion)
  const cached = imageBuilds.get(tag)
  if (cached) {
    return cached
  }
  const build = (async () => {
    const dir = join(tmpdir(), `codesema-agent-image-${tag.split(':')[1] ?? 'x'}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'Dockerfile')
    writeFileSync(path, dockerfile)
    // Empty context: everything the image needs comes from the base and the
    // install command, so nothing of the repo is ever copied INTO the image.
    const result = await exec(opts.runtime, ['build', '-f', path, '-t', tag, dir], { timeoutMs })
    if (result.code !== 0) {
      throw new Error(t('isolation.buildFailed', { error: buildFailure(result) }))
    }
    return tag
  })()
  imageBuilds.set(tag, build)
  build.catch(() => imageBuilds.delete(tag))
  return build
}

// --- egress proxy ----------------------------------------------------------

export type EgressProxy = {
  /** Internal (no route out) network the agent container joins. */
  network: string
  /**
   * Ordinary bridge network the proxy is STARTED on — that is its route out.
   * A user-defined bridge, never the runtime's default: rootless podman
   * defaults to pasta, whose containers `network connect` flatly refuses.
   */
  egressNetwork: string
  /** Squid container name; reachable from the internal network by that name. */
  container: string
  /** Value of HTTP_PROXY/HTTPS_PROXY inside the cage. */
  url: string
  /** Host path of the generated squid.conf, mounted read-only. */
  configPath: string
}

/**
 * squid.conf from an allowlist: CONNECT to :443 on the listed domains, and
 * nothing else — no plain HTTP proxying, no other port, no other host. The
 * domains are already sanitized (config.ts) and re-checked here: what goes
 * into this file is never arbitrary text.
 *
 * Each domain is emitted ONLY in its leading-dot form, which squid matches
 * against the apex AND every subdomain. Emitting both forms is not redundant
 * but FATAL: squid refuses the whole file ("'.x.com' is a subdomain of
 * 'x.com' … Bungled squid.conf") and the proxy never starts, which would take
 * container isolation down with it. Verified against squid 6.13.
 */
export function buildSquidConfig(domains: readonly string[]): string {
  const clean = domains.filter((d) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d))
  const lines = [
    '# Generated by codesema — task egress allowlist.',
    `http_port ${EGRESS_PROXY_PORT}`,
    'acl SSL_ports port 443',
    'acl CONNECT method CONNECT',
    ...clean.map((domain) => `acl allowed dstdomain .${domain}`),
    'http_access deny !CONNECT',
    'http_access deny CONNECT !SSL_ports',
    ...(clean.length > 0 ? ['http_access allow CONNECT allowed'] : []),
    'http_access deny all',
    'cache deny all',
    'access_log stdio:/dev/stdout',
    'pid_filename none',
    '',
  ]
  return lines.join('\n')
}

/** Proxies started BY THIS PROCESS, torn down on workspace shutdown. */
const startedProxies = new Set<string>()
/** allowlist hash → in-flight/settled proxy. */
const proxies = new Map<string, Promise<EgressProxy>>()

const inspectOk = async (
  exec: IsolationExecFn,
  runtime: string,
  kind: 'network' | 'container' | 'volume',
  name: string,
): Promise<boolean> => {
  const probe = await exec(runtime, [kind, 'inspect', name], { timeoutMs: 20_000 })
  return probe.code === 0
}

export type EnsureEgressProxyOptions = {
  runtime: string
  execFn?: IsolationExecFn
  /** Effective allowlist; defaults to DEFAULT_ISOLATION_ALLOWED_DOMAINS. */
  allowedDomains?: readonly string[]
  /** Directory the generated squid.conf is written to; defaults to a tmp dir. */
  configDir?: string
}

/**
 * Idempotent: creates the two networks and the squid container if they are not
 * there, reuses them otherwise. The proxy is NOT started on the internal
 * network — that would leave it with no route out either. It is started on a
 * dedicated bridge network and then CONNECTED to the internal one, so the
 * agent container can reach the proxy and nothing else.
 *
 * That dedicated bridge is not decoration: on rootless podman the default
 * network mode is pasta, and `podman network connect` rejects a pasta
 * container outright ('"pasta" is not supported: invalid network mode'), so a
 * proxy started on the default network could never join the internal one.
 */
export async function ensureEgressProxy(opts: EnsureEgressProxyOptions): Promise<EgressProxy> {
  const exec = opts.execFn ?? defaultExec
  const domains = [...(opts.allowedDomains ?? DEFAULT_ISOLATION_ALLOWED_DOMAINS)]
  const config = buildSquidConfig(domains)
  const id = createHash('sha256').update(config).digest('hex').slice(0, 8)
  const cached = proxies.get(id)
  if (cached) {
    return cached
  }
  const network = `codesema-net-${id}`
  const egressNetwork = `codesema-egress-${id}`
  const container = `codesema-proxy-${id}`
  const started = (async (): Promise<EgressProxy> => {
    const dir = opts.configDir ?? join(tmpdir(), `codesema-proxy-${id}`)
    mkdirSync(dir, { recursive: true })
    const configPath = join(dir, 'squid.conf')
    writeFileSync(configPath, config)
    const ensureNetwork = async (name: string, internal: boolean): Promise<void> => {
      if (await inspectOk(exec, opts.runtime, 'network', name)) {
        return
      }
      const created = await exec(
        opts.runtime,
        ['network', 'create', ...(internal ? ['--internal'] : []), name],
        { timeoutMs: 60_000 },
      )
      if (created.code !== 0) {
        throw new Error(t('isolation.proxyFailed', { error: buildFailure(created) }))
      }
    }
    await ensureNetwork(network, true)
    await ensureNetwork(egressNetwork, false)
    if (!(await inspectOk(exec, opts.runtime, 'container', container))) {
      const run = await exec(
        opts.runtime,
        [
          'run',
          '-d',
          '--rm',
          '--name',
          container,
          '--network',
          egressNetwork,
          '-v',
          `${configPath}:/etc/squid/squid.conf:ro`,
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '512m',
          EGRESS_PROXY_IMAGE,
        ],
        { timeoutMs: 300_000 },
      )
      if (run.code !== 0) {
        throw new Error(t('isolation.proxyFailed', { error: buildFailure(run) }))
      }
      const connected = await exec(opts.runtime, ['network', 'connect', network, container], {
        timeoutMs: 60_000,
      })
      if (connected.code !== 0) {
        throw new Error(t('isolation.proxyFailed', { error: buildFailure(connected) }))
      }
      startedProxies.add(container)
    }
    return {
      network,
      egressNetwork,
      container,
      url: `http://${container}:${EGRESS_PROXY_PORT}`,
      configPath,
    }
  })()
  proxies.set(id, started)
  started.catch(() => proxies.delete(id))
  return started
}

/**
 * Workspace shutdown: stops the proxies THIS process started (and drops their
 * networks). Best effort by contract — a leftover container must never keep
 * the workspace from exiting.
 */
export async function teardownEgressProxy(opts: {
  runtime: string | null
  execFn?: IsolationExecFn
}): Promise<void> {
  const runtime = opts.runtime
  const exec = opts.execFn ?? defaultExec
  const containers = [...startedProxies]
  startedProxies.clear()
  const settled = [...proxies.values()].map((p) => p.catch(() => null))
  proxies.clear()
  if (!runtime) {
    return
  }
  for (const container of containers) {
    await exec(runtime, ['rm', '-f', container], { timeoutMs: 30_000 }).catch(() => null)
  }
  for (const proxy of await Promise.all(settled)) {
    if (proxy) {
      for (const net of [proxy.network, proxy.egressNetwork]) {
        await exec(runtime, ['network', 'rm', net], { timeoutMs: 30_000 }).catch(() => null)
      }
      try {
        rmSync(proxy.configPath, { force: true })
      } catch {
        // The tmp file outliving the process is harmless.
      }
    }
  }
}

// --- agent HOME volume -----------------------------------------------------

/** What the bootstrap did about the agent's credentials — reported, never assumed. */
export type HomeCredentials = 'oauth-token' | 'copied' | 'missing' | 'already-bootstrapped'

export type AgentHome = { volume: string; credentials: HomeCredentials }

export type BootstrapAgentHomeOptions = {
  runtime: string
  taskId: string
  /** Agent image: the ephemeral bootstrap container runs as its non-root user. */
  image: string
  execFn?: IsolationExecFn
  env?: NodeJS.ProcessEnv
  /** Host credentials file; defaults to ~/.claude/.credentials.json. */
  credentialsPath?: string
  /** Resolved podman-ness; probed from the binary when absent. */
  podman?: boolean
}

const homes = new Map<string, Promise<AgentHome>>()

/** podman maps the host user to a container uid: keep-id makes it the SAME uid. */
export function isPodman(runtime: string): boolean {
  return /(^|\/)podman$/.test(runtime)
}

/** runtime name → what the binary actually reported. */
const podmanProbes = new Map<string, Promise<boolean | null>>()

/**
 * Is this runtime really podman? The binary NAME cannot answer it: a very
 * common setup — and the one this was found on — is rootless podman exposed as
 * `docker` through the emulation shim, where the runtime IS podman and still
 * needs --userns=keep-id for the bind-mounted worktree to stay writable.
 * Without it the agent's uid maps to a foreign host uid and every write into
 * /work fails with EACCES. So ask the binary what it is.
 */
export async function runtimeIsPodman(
  runtime: string,
  execFn?: IsolationExecFn,
): Promise<boolean | null> {
  if (isPodman(runtime)) {
    return true
  }
  const probe = async (): Promise<boolean | null> => {
    const exec = execFn ?? defaultExec
    const result = await exec(runtime, ['--version'], { timeoutMs: 20_000 })
    // T1.9 review round 4, MAJEUR 3: a probe that did not RUN answers null,
    // never `false`. `false` reads as "this is docker", a positive fact, and
    // the orphaned-volume sweep spends it on choosing which label format to
    // ask for — under podman the wrong choice makes every foreign owner label
    // unreadable, and an unreadable label is what now lets a volume through.
    // A binary that could not answer must abstain instead.
    if (result.code !== 0) {
      return null
    }
    return /podman/i.test(`${result.stdout}${result.stderr}`)
  }
  if (execFn) {
    return probe()
  }
  const cached = podmanProbes.get(runtime)
  if (cached) {
    return cached
  }
  const started = probe()
  podmanProbes.set(runtime, started)
  // A memo that is only ever written and never cleared would freeze a single
  // transient failure (a daemon still starting at boot, an EMFILE burst) for
  // the entire life of the workspace process. Only an ANSWER is worth
  // remembering; ignorance is re-asked.
  void started.then(
    (value) => {
      if (value === null) {
        podmanProbes.delete(runtime)
      }
    },
    () => podmanProbes.delete(runtime),
  )
  return started
}

const usernsArgs = (podman: boolean): string[] => (podman ? ['--userns=keep-id'] : [])

/**
 * Creates the task's HOME volume and seeds it ONCE. With
 * CLAUDE_CODE_OAUTH_TOKEN in the environment nothing is copied (the token is
 * forwarded per run); otherwise the host's ~/.claude/.credentials.json is
 * piped into the volume through an ephemeral container — on STDIN, so the
 * secret never appears in an argv the whole machine can read in `ps`.
 *
 * Bootstrapping is what the volume's existence means: an existing volume is
 * left strictly alone, which is also how a claude session survives from one
 * turn to the next.
 */
export async function bootstrapAgentHome(opts: BootstrapAgentHomeOptions): Promise<AgentHome> {
  const cached = homes.get(opts.taskId)
  if (cached) {
    return cached
  }
  const exec = opts.execFn ?? defaultExec
  const env = opts.env ?? process.env
  const volume = agentHomeVolume(opts.taskId)
  const run = (async (): Promise<AgentHome> => {
    if (await inspectOk(exec, opts.runtime, 'volume', volume)) {
      return { volume, credentials: 'already-bootstrapped' }
    }
    const created = await exec(
      opts.runtime,
      ['volume', 'create', '--label', `${HOME_VOLUME_OWNER_LABEL}=${workspaceOwnerId()}`, volume],
      { timeoutMs: 60_000 },
    )
    if (created.code !== 0) {
      throw new Error(t('isolation.homeFailed', { error: buildFailure(created) }))
    }
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { volume, credentials: 'oauth-token' }
    }
    const path = opts.credentialsPath ?? join(homedir(), '.claude', '.credentials.json')
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      // No credentials to copy: the cage still runs, and claude inside it says
      // it is unauthenticated — far better than pretending we seeded something.
      return { volume, credentials: 'missing' }
    }
    const seeded = await exec(
      opts.runtime,
      [
        'run',
        '--rm',
        '-i',
        '-v',
        `${volume}:${CAGE_HOME_DIR}`,
        '--network',
        'none',
        '--security-opt',
        'no-new-privileges',
        // `?? false` on purpose, and ONLY here: an unanswered probe on the RUN
        // path means no --userns=keep-id, the long-standing behavior, and the
        // worst case is an EACCES the turn reports. Nothing is destroyed. The
        // sweep, which destroys, abstains instead.
        ...usernsArgs(opts.podman ?? (await runtimeIsPodman(opts.runtime, opts.execFn)) ?? false),
        opts.image,
        'sh',
        '-lc',
        `umask 077; mkdir -p ${CAGE_HOME_DIR}/.claude && cat > ${CAGE_HOME_DIR}/.claude/.credentials.json`,
      ],
      { timeoutMs: 120_000, input: content },
    )
    if (seeded.code !== 0) {
      throw new Error(t('isolation.homeFailed', { error: buildFailure(seeded) }))
    }
    return { volume, credentials: 'copied' }
  })()
  homes.set(opts.taskId, run)
  run.catch(() => homes.delete(opts.taskId))
  return run
}

/**
 * Named, never thrown: the whole point of this result is that a caller at
 * termination (ship, abandon) can report the outcome and move on — never
 * retry, never fail the task over it (D-rule of T1.9: a `volume rm` that
 * fails takes nothing and refuses nothing, so it carries no D2 code, only a
 * readable name).
 */
export type ReleaseAgentHomeResult =
  | { released: true }
  | { released: false; reason: 'no-runtime' }
  | { released: false; reason: 'rm-failed'; detail: string }

export type ReleaseAgentHomeOptions = {
  taskId: string
  /** Resolved runtime; probed via isolationRuntime(execFn) when absent. */
  runtime?: string
  execFn?: IsolationExecFn
}

/**
 * Releases the task's HOME volume at termination (ship, abandon), through the
 * SAME seam as the rest of isolation — `execFile` argv, never a runtime
 * binary named by the caller. Best-effort by contract: a volume that could
 * not be removed here is exactly what the boot sweep (sweepOrphanedHomeVolumes)
 * rattraps on the next start, so this NEVER throws — every outcome, runtime
 * absent included, comes back as data.
 */
export async function releaseAgentHome(
  opts: ReleaseAgentHomeOptions,
): Promise<ReleaseAgentHomeResult> {
  const exec = opts.execFn ?? defaultExec
  const runtime = opts.runtime ?? (await isolationRuntime(opts.execFn))
  if (!runtime) {
    return { released: false, reason: 'no-runtime' }
  }
  const volume = agentHomeVolume(opts.taskId)
  const removed = await exec(runtime, ['volume', 'rm', volume], { timeoutMs: 30_000 })
  if (removed.code !== 0) {
    // A task can reach ship/abandon having never run a single caged turn (a
    // question turn, an interrupt before the first one, `isolation:'container'`
    // decided but never exercised): bootstrapAgentHome was then never called,
    // and NOTHING was ever created for `volume rm` to fail on. Reported as
    // 'released' rather than as a failure — a "no such volume" from the
    // runtime is not a degradation here, it is the honest reading of "there
    // was nothing to release" (false negative fixed, T1.9 review round 1,
    // Mineur 6).
    //
    // Matched on the `rm` attempt's own message rather than a separate
    // `inspect` beforehand (the first fix here did exactly that, and it
    // traded the false negative for a false POSITIVE: an `inspect` failing
    // for an unrelated reason — the daemon momentarily busy, a permission
    // hiccup — is not proof the volume never existed, yet was read as
    // 'released: true' all the same, masking a real removal failure). Docker
    // and podman both say so, in slightly different words, in the SAME `rm`
    // response, so no second round trip — and no second TOCTOU window — is
    // needed to tell the two apart.
    if (/no such volume/i.test(removed.stderr) || /no such volume/i.test(removed.stdout)) {
      return { released: true }
    }
    return { released: false, reason: 'rm-failed', detail: buildFailure(removed) }
  }
  // The bootstrap memo would otherwise answer 'already-bootstrapped' for a
  // volume this process just deleted — harmless in practice (ship/abandon are
  // terminal, no turn runs again on this taskId) but wrong to leave standing.
  homes.delete(opts.taskId)
  return { released: true }
}

/** Prefix every task's HOME volume carries — the sweep's only identification (Décision 1). */
const HOME_VOLUME_PREFIX = 'codesema-home-'

/**
 * One HOME volume as the sweep sees it: the task id its name encodes, and who
 * (if anyone) labeled it as theirs. `ownerLabel === null` means the runtime's
 * own label filter did not return this volume — a positive statement that it
 * carries no `codesema.workspace` label, NEVER the result of a label we
 * failed to read (see listHomeVolumeEntries).
 */
type HomeVolumeEntry = { id: string; ownerLabel: string | null }

/** First `value` of `key=value` in a comma-joined DOCKER `--format '{{.Labels}}'` string. */
function labelValue(labels: string, key: string): string | null {
  for (const pair of labels.split(',')) {
    const eq = pair.indexOf('=')
    if (eq !== -1 && pair.slice(0, eq) === key) {
      return pair.slice(eq + 1)
    }
  }
  return null
}

/**
 * Label-value template for the FILTERED listing below.
 *
 * T1.9 review round 3, MAJEUR 2: docker's `{{.Labels}}` renders the
 * `k=v,k2=v2` form `labelValue` parses — podman's renders a Go map's default
 * `map[k:v k2:v2]` string instead (verified live, podman 5.7.0), which
 * contains no `=` before any comma and made `labelValue` return null for
 * EVERY volume under podman, including ones this very build just labeled.
 * `{{index .Labels "key"}}` extracts the value directly regardless of how the
 * whole map would print, and is verified portable on podman (renders the bare
 * value) — so podman gets that format, docker keeps the comma-joined one
 * `labelValue` already handles correctly.
 */
const ownerLabelFormat = (podman: boolean): string =>
  podman ? `{{.Name}}\t{{index .Labels "${HOME_VOLUME_OWNER_LABEL}"}}` : '{{.Name}}\t{{.Labels}}'

/**
 * HOME volumes on the runtime, with who (if anyone) labeled each as theirs.
 * Null when the inventory could not be read — no runtime, a listing that
 * failed, or one whose output does not have the shape it was asked for. The
 * caller must NOT read null as "no volumes": deleting on the strength of a
 * list it never actually saw would wipe volumes it merely failed to
 * enumerate.
 *
 * A name whose suffix is not a valid 12-hex task id — `codesema-home-`,
 * `codesema-home-not-an-id`, a path-traversal attempt, a `-backup` suffix
 * tacked onto a real one — is DROPPED rather than coerced: this sweep only
 * ever acts on ids it can trust round-trip through `agentHomeVolume`.
 *
 * T1.9 review round 4, MAJEUR 3 — why TWO listings and not one. The owner
 * label is no longer a gate (round 3 made it an exclusion: a volume labeled
 * for a DIFFERENT uid is spared, an unlabeled one is swept, which is the
 * whole point of Décision 1). That inversion turned every way of FAILING to
 * read a label into a licence to delete: a line the runtime truncated, or a
 * template that rendered nothing, both came back as `ownerLabel === null` —
 * indistinguishable from "carries no label" — and another uid's volume went.
 * So absence of a label is now established POSITIVELY, by asking the runtime
 * itself which volumes carry it (`--filter label=…`, supported by docker and
 * verified on podman 5.7.0): a volume the filtered listing did not return
 * carries no such label, full stop. Nothing about that conclusion depends on
 * parsing a string.
 *
 * And a line of the FILTERED listing that does not have the arity it was
 * asked for (no tab) cannot be attributed to a volume at all — it names one
 * the runtime just told us IS labeled, and reading it as anything else would
 * be exactly the bug above. That is an inventory read that failed: null, and
 * the sweep does not run.
 */
async function listHomeVolumeEntries(
  runtime: string,
  exec: IsolationExecFn,
  podman: boolean,
): Promise<HomeVolumeEntry[] | null> {
  const all = await exec(runtime, ['volume', 'ls', '--format', '{{.Name}}'], { timeoutMs: 30_000 })
  if (all.code !== 0) {
    return null
  }
  const labeled = await exec(
    runtime,
    [
      'volume',
      'ls',
      '--filter',
      `label=${HOME_VOLUME_OWNER_LABEL}`,
      '--format',
      ownerLabelFormat(podman),
    ],
    { timeoutMs: 30_000 },
  )
  // A failure HERE is never "nobody labeled anything": it is the same
  // unreadable inventory as above, and it must cancel the sweep rather than
  // let every foreign volume read as unlabeled.
  if (labeled.code !== 0) {
    return null
  }
  const owners = new Map<string, string>()
  for (const line of labeled.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const tab = trimmed.indexOf('\t')
    if (tab === -1) {
      return null
    }
    const rest = trimmed.slice(tab + 1).trim()
    // `?? rest` and not `?? null`: this volume IS labeled (the runtime's own
    // filter returned it), so a value this parser cannot make sense of must
    // stay a value — one that will not match our owner id, hence excluded —
    // and must never collapse into "unlabeled", which would sweep it.
    const value = podman ? rest : (labelValue(rest, HOME_VOLUME_OWNER_LABEL) ?? rest)
    owners.set(trimmed.slice(0, tab), value)
  }
  const entries: HomeVolumeEntry[] = []
  for (const line of all.stdout.split('\n')) {
    const name = line.trim()
    if (!name.startsWith(HOME_VOLUME_PREFIX)) {
      continue
    }
    const id = name.slice(HOME_VOLUME_PREFIX.length)
    if (!isTaskId(id)) {
      continue
    }
    entries.push({ id, ownerLabel: owners.get(name) ?? null })
  }
  return entries
}

export type HomeVolumeSweepOutcome = {
  /** Task ids whose orphaned volume was removed. */
  removed: string[]
  /**
   * One readable line per action or failure, for the boot's notice channel —
   * NEVER the task journal (DP9): a volume this sweep names has no live task
   * directory left to write into, `appendTaskEvent`'s `mkdirSync` would
   * either resurrect one or race the very deletion this sweep is reporting.
   */
  notices: string[]
}

export type HomeVolumeSweepOptions = {
  /** Every task id any KNOWN project record still claims (all registered projects, not just one), taken as a SNAPSHOT before the (slow) runtime round trips below. */
  claimedIds: ReadonlySet<string>
  /**
   * Re-verified immediately before EACH removal — closes the race between the
   * `claimedIds` snapshot above and the runtime round trips (`volume ls` then
   * one `volume rm` per candidate), which can together take long enough for a
   * brand-new task (or a brand-new registered project) to exist without ever
   * having been in the snapshot. `null` means the inventory could not be
   * rebuilt just now (same Risk-1 reasoning as the initial snapshot): every
   * remaining candidate is left in place rather than trusted on a stale read.
   * Absent entirely (unit tests, callers with no live registry to re-read):
   * the initial snapshot is the only check.
   */
  recheckClaimedIds?: () => ReadonlySet<string> | null
  runtime?: string
  execFn?: IsolationExecFn
}

/**
 * Boot sweep of orphaned HOME volumes (Décision 1, design.md: identified by
 * NAME, never by label — 0.12 volumes carry none, and recovering exactly
 * those is the point of the sweep). A volume is removed when its id is
 * claimed by NO record of NO known project (Risk 1), whether or not it
 * carries this workspace user's ownership label — an UNLABELED volume is the
 * common, expected, pre-T1.9 case, not a reason to hold back.
 *
 * T1.9 review round 3, MAJEUR 3: an earlier round gated unlabeled volumes
 * behind an opt-in `sweepUnlabeled` flag that was never wired to any config
 * key or CLI flag anywhere in the codebase — under the shipped default, this
 * sweep could not recover a SINGLE 0.12 volume, which is the one thing
 * Décision 1 exists to do, and the notice it emitted advertised an opt-in
 * that did not exist. Removed rather than wired: design.md never asked for
 * label-gated recovery, and the one label-based protection design.md's own
 * Risk 1 discussion never anticipated but is still worth keeping — a volume
 * labeled for a DIFFERENT known uid is never touched, claimed or not, since
 * this daemon may be shared by several `docker`-group users with no shared
 * registry to tell their tasks apart — survives untouched below: it only
 * ever excludes a volume that CARRIES a foreign label, never one with none.
 *
 * Never throws (Risk 2's sibling rule for the boot path): a runtime that
 * cannot be reached, or a listing/removal that fails, comes back as a named
 * notice, and the boot proceeds either way.
 */
export async function sweepOrphanedHomeVolumes(
  opts: HomeVolumeSweepOptions,
): Promise<HomeVolumeSweepOutcome> {
  const exec = opts.execFn ?? defaultExec
  const runtime = opts.runtime ?? (await isolationRuntime(opts.execFn))
  if (!runtime) {
    return {
      removed: [],
      notices: ['no container runtime detected — the orphaned HOME volume sweep did not run'],
    }
  }
  // T1.9 review round 4, MAJEUR 3: podman-ness decides WHICH label template
  // the listing below asks for, and asking for the wrong one is how a foreign
  // owner label becomes unreadable. A probe that could not answer therefore
  // stops the sweep instead of guessing 'docker' — an orphaned volume
  // surviving until the next boot costs disk; another uid's volume deleted on
  // a guess costs their agent's home.
  const podman = await runtimeIsPodman(runtime, opts.execFn)
  if (podman === null) {
    return {
      removed: [],
      notices: [
        `could not determine whether ${runtime} is podman (its --version probe failed) — the orphaned HOME volume sweep did not run`,
      ],
    }
  }
  const entries = await listHomeVolumeEntries(runtime, exec, podman)
  if (entries === null) {
    return {
      removed: [],
      notices: ['could not list HOME volumes — the orphaned volume sweep did not run'],
    }
  }
  const owner = workspaceOwnerId()
  const removed: string[] = []
  const notices: string[] = []
  for (const { id, ownerLabel } of entries) {
    if (ownerLabel !== null && ownerLabel !== owner) {
      // Someone else's volume on the same daemon: never ours to judge.
      // Unlabeled (ownerLabel === null) is the common pre-T1.9 case and
      // falls straight through to the orphan check below — see this
      // function's own doc comment (MAJEUR 3).
      continue
    }
    if (opts.claimedIds.has(id)) {
      continue
    }
    if (opts.recheckClaimedIds) {
      const fresh = opts.recheckClaimedIds()
      if (fresh === null) {
        notices.push(
          `orphaned HOME volume ${agentHomeVolume(id)} left in place: the claimed-id inventory could not be re-verified right before removing it`,
        )
        continue
      }
      if (fresh.has(id)) {
        continue
      }
    }
    const volume = agentHomeVolume(id)
    const result = await exec(runtime, ['volume', 'rm', volume], { timeoutMs: 30_000 })
    if (result.code === 0) {
      removed.push(id)
      notices.push(`orphaned HOME volume ${volume} removed at boot: no task record claims it`)
    } else {
      notices.push(`orphaned HOME volume ${volume} could not be removed: ${buildFailure(result)}`)
    }
  }
  return { removed, notices }
}

// --- the caged turn --------------------------------------------------------

/** Same shape as the runner's TaskSession, duplicated to avoid an import cycle. */
export type CagedSession = { kind: 'new' | 'resume'; id: string }

/**
 * Per-turn agent command INSIDE the cage. Same stream/session flags as the
 * host path (taskCommandFor), but the policy hardening is replaced by
 * --dangerously-skip-permissions: the container IS the guarantee, so the
 * agent gets its full toolset — including Bash — within it. Nothing here
 * restricts settings or MCP: a hostile repo file can only reach the cage.
 */
export function containerTaskCommandFor(
  command: string,
  opts: { session: CagedSession | null },
): string {
  let cmd = command
  if (!/^claude(\s|$)/.test(command)) {
    return cmd
  }
  if (!/(^|\s)--dangerously-skip-permissions(\s|$)/.test(cmd)) {
    cmd += ' --dangerously-skip-permissions'
  }
  if (
    /(^|\s)(-p|--print)(\s|$)/.test(cmd) &&
    !cmd.includes('--output-format') &&
    !cmd.includes('--input-format')
  ) {
    cmd += ' --output-format stream-json --include-partial-messages --verbose'
  }
  if (opts.session) {
    cmd +=
      opts.session.kind === 'new'
        ? ` --session-id ${opts.session.id}`
        : ` --resume ${opts.session.id}`
  }
  return cmd
}

export type ContainerRunSpec = {
  runtime: string
  name: string
  image: string
  worktree: string
  homeVolume: string
  network: string
  proxyUrl: string
  /** Agent command line, run under `sh -lc` INSIDE the container. */
  command: string
  /** Provider variable NAMES forwarded from the host env (values stay out of argv). */
  forwardEnv: readonly string[]
  /**
   * READ-ONLY `-v` arguments exposing the repo's git directory to the box
   * (container-git.ts). Absent when the worktree needs none — a plain checkout
   * already carries its `.git` inside the mount.
   */
  gitMounts?: readonly string[]
  memory?: string
  cpus?: string
  /**
   * Resolved podman-ness. Defaults to the NAME heuristic, which is wrong for a
   * podman exposed as `docker`: real callers pass the probed value.
   */
  podman?: boolean
}

/**
 * The exact argv of a caged turn. Note what is NOT here: no --privileged, no
 * docker socket, no host path other than the worktree and the repo's git
 * directory (read-only), no capability added.
 */
export function containerRunArgs(spec: ContainerRunSpec): string[] {
  const proxy = spec.proxyUrl
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    spec.name,
    '--network',
    spec.network,
    '-v',
    `${spec.worktree}:${CAGE_WORK_DIR}:rw`,
    '-w',
    CAGE_WORK_DIR,
    '-v',
    `${spec.homeVolume}:${CAGE_HOME_DIR}`,
    ...(spec.gitMounts ?? []),
    ...gitSafeDirectoryEnvArgs(CAGE_WORK_DIR),
    '-e',
    `HTTP_PROXY=${proxy}`,
    '-e',
    `HTTPS_PROXY=${proxy}`,
    '-e',
    `http_proxy=${proxy}`,
    '-e',
    `https_proxy=${proxy}`,
    '-e',
    'NO_PROXY=localhost,127.0.0.1',
    '-e',
    'no_proxy=localhost,127.0.0.1',
    ...spec.forwardEnv.flatMap((name) => ['-e', name]),
    '--cpus',
    spec.cpus ?? CAGE_CPUS,
    '--memory',
    spec.memory ?? CAGE_MEMORY,
    '--security-opt',
    'no-new-privileges',
    ...usernsArgs(spec.podman ?? isPodman(spec.runtime)),
    spec.image,
    'sh',
    '-lc',
    spec.command,
  ]
}

export type ContainerSpawnOptions = {
  file: string
  args: string[]
  /**
   * The AGENT command line running inside the box (not the runtime argv):
   * says whether the stdout coming back can be decoded as claude JSONL, which
   * is what the watchdog reads its tool signals from.
   */
  command: string
  /** Turn prompt, written to the container's stdin. */
  input: string
  /** Last-resort ceiling; the watchdog is what detects a dead run (effectiveAbsoluteCapMs). */
  timeoutMs: number
  signal?: AbortSignal | undefined
  /** Cumulative stdout, same contract as runAgent's onText. */
  onText?: ((text: string) => void) | undefined
  /** Kills the container by NAME: killing the client alone leaves it running. */
  onKill: () => void
  /** Watchdog budgets (D3 defaults when absent) — the caged turn gets the same guard as the host one. */
  watchdog?: WatchdogBudgets | undefined
  /** Liveness beat, one per heartbeat period. */
  onHeartbeat?: ((beat: AgentHeartbeat) => void) | undefined
  /** Test seams: injected clock and process spawn (no real container, no real wait). */
  clock?: AgentClock | undefined
  spawnProcessFn?: ContainerProcessSpawnFn | undefined
}

/** Process seam of the real container spawn: tests hand back a recording double. */
export type ContainerProcessSpawnFn = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess

/** Streaming spawn seam: tests replace it, unit tests never spawn a container. */
export type ContainerSpawnFn = (opts: ContainerSpawnOptions) => Promise<string>

/**
 * Bounded wait between the container kill and signalling the CLIENT: `docker
 * kill` has to reach the engine and the client usually exits on its own once
 * the container is gone. Signalling the client first would orphan the box.
 */
export const CONTAINER_KILL_GRACE_MS = 5_000

/**
 * Real spawn: argv array, NO shell on the host. The caged turn carries the
 * same semantic watchdog as the host one (runAgent): silence with no tool out,
 * or a tool that never comes back, kills the run with `inactivity_timeout` —
 * the cage is the DEFAULT path whenever a runtime exists, so leaving it
 * unwatched would leave the bug the watchdog exists to fix in place.
 *
 * The kill escalation is ordered and every step is bounded: close stdin → kill
 * the CONTAINER by name (the client dying alone leaves the agent running in
 * its box) → wait → SIGTERM the client → wait → SIGKILL it → close stdout →
 * wait → settle anyway. stdout stays open until the very end so the agent's
 * last words survive its death, and the final settle exists because no signal
 * is a guarantee: a promise that never settles turns Ctrl-C into a hang.
 */
export const spawnContainer: ContainerSpawnFn = (opts) =>
  new Promise((resolve, reject) => {
    const clock = opts.clock ?? systemClock
    const spawnProcessFn = opts.spawnProcessFn ?? spawn
    const child = spawnProcessFn(opts.file, opts.args, { stdio: ['pipe', 'pipe', 'inherit'] })
    const stdin = child.stdin
    const stdout = child.stdout
    stdin?.on('error', () => {})

    let out = ''
    let capped = false
    let aborted = false
    let killing = false
    let settled = false
    let cut: { cause: AgentWatchdogCause; elapsedMs: number } | null = null
    let capCancel: (() => void) | null = null
    let stepCancel: (() => void) | null = null

    const stopTimers = (): void => {
      armed.stop()
      capCancel?.()
      stepCancel?.()
      capCancel = null
      stepCancel = null
    }
    const finish = (outcome: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      stopTimers()
      opts.signal?.removeEventListener('abort', onAbort)
      outcome()
    }
    const settleFromState = (code: number | null): void => {
      // A watchdog cut owns the outcome: a human hitting Stop during the kill
      // is reacting to it, not causing it, and overwriting the cause would
      // lose the reason code and the resumable status that goes with it.
      if (cut) {
        reject(new AgentWatchdogError(cut.cause, watchdogMessage(cut.cause, cut.elapsedMs)))
      } else if (aborted) {
        reject(new Error(t('agent.interrupted')))
      } else if (capped) {
        reject(new Error(t('agent.timeout', { s: Math.round(opts.timeoutMs / 1000) })))
      } else if (code === 0) {
        resolve(out)
      } else {
        reject(new Error(t('agent.exitCode', { code })))
      }
    }
    const killClient = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    }
    const escalateKill = (): void => {
      if (killing) {
        return
      }
      killing = true
      // Nothing left for the budgets to say, and a beat during the death
      // throes would only claim life where there is none.
      armed.stop()
      // 1. stdin: already closed in today's flow (the prompt is written and
      //    stdin ended as soon as the run starts), kept first because the
      //    order is the contract — EOF is the gentlest way to ask an agent to
      //    leave, and the guard above absorbs a redundant close.
      try {
        stdin?.end()
      } catch {
        // already gone
      }
      // 2. the container, by NAME: the box is what holds the agent.
      opts.onKill()
      stepCancel = clock.setTimer(() => {
        // 3. the client, once the box has had its chance to take it down.
        killClient('SIGTERM')
        stepCancel = clock.setTimer(() => {
          // 4. a client that ignored SIGTERM, and only then 5. stdout.
          killClient('SIGKILL')
          try {
            stdout?.destroy()
          } catch {
            // stream already gone
          }
          // 6. no signal is a promise the process is gone; report anyway.
          stepCancel = clock.setTimer(() => {
            stepCancel = null
            finish(() => settleFromState(null))
          }, AGENT_SETTLE_GRACE_MS)
        }, AGENT_KILL_GRACE_MS)
      }, CONTAINER_KILL_GRACE_MS)
    }

    const armed = armStreamWatchdog({
      command: opts.command,
      // The cage's stdout is relayed raw to the caller (runTaskTurn owns the
      // TEXT parser); this watchdog keeps its own count-only reader.
      callerDecodes: false,
      budgets: opts.watchdog ?? AGENT_WATCHDOG_DEFAULTS,
      clock,
      ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
      onExpire: (cause, elapsedMs) => {
        if (killing) {
          return
        }
        cut = { cause, elapsedMs }
        escalateKill()
      },
    })

    capCancel = clock.setTimer(() => {
      capCancel = null
      if (killing) {
        return
      }
      capped = true
      escalateKill()
    }, opts.timeoutMs)

    function onAbort(): void {
      aborted = true
      escalateKill()
    }
    if (opts.signal?.aborted) {
      onAbort()
    } else {
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    }
    stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      out += chunk
      armed.push(chunk)
      opts.onText?.(out)
    })
    child.on('error', (err) => {
      finish(() => reject(err))
    })
    child.on('close', (code: number | null) => {
      finish(() => settleFromState(code))
    })
    stdin?.write(opts.input)
    stdin?.end()
  })

let cachedRuntime: Promise<string | null> | null = null

/** Detected once per process for the real exec; an injected exec always re-probes. */
export function isolationRuntime(execFn?: IsolationExecFn): Promise<string | null> {
  if (execFn) {
    return detectContainerRuntime(execFn)
  }
  cachedRuntime ??= detectContainerRuntime(defaultExec)
  return cachedRuntime
}

let cachedClaudeVersion: Promise<string> | null = null

/** Host claude version, part of the image tag: upgrading the CLI rebuilds the cage. */
export function hostClaudeVersion(execFn?: IsolationExecFn): Promise<string> {
  const probe = async (): Promise<string> => {
    const exec = execFn ?? defaultExec
    const result = await exec('claude', ['--version'], { timeoutMs: 20_000 })
    return result.code === 0 ? result.stdout.trim().slice(0, 100) || 'unknown' : 'unknown'
  }
  if (execFn) {
    return probe()
  }
  cachedClaudeVersion ??= probe()
  return cachedClaudeVersion
}

export type RunContainerTurnOptions = {
  taskId: string
  /** The task worktree: the only host path the cage ever sees. */
  worktree: string
  /** Raw agent command line to run inside the cage (already flagged). */
  command: string
  prompt: string
  /** Last-resort ceiling; the watchdog is what detects a dead run (effectiveAbsoluteCapMs). */
  timeoutMs: number
  /** Watchdog budgets (D3 defaults when absent): the caged turn is watched like the host one. */
  watchdog?: WatchdogBudgets | undefined
  /** Liveness beat, one per heartbeat period. */
  onHeartbeat?: ((beat: AgentHeartbeat) => void) | undefined
  /** Injected clock (test seam): no test ever waits out a budget. */
  clock?: AgentClock | undefined
  /** Effective egress allowlist. */
  allowedDomains?: readonly string[]
  /** Repo checks config, used by the base-image resolution. */
  checksConfig?: ChecksConfig | null
  signal?: AbortSignal | undefined
  onText?: ((text: string) => void) | undefined
  env?: NodeJS.ProcessEnv
  /** Test seams — unit tests NEVER touch a real runtime. */
  execFn?: IsolationExecFn
  spawnFn?: ContainerSpawnFn
  installCommand?: string
  claudeVersion?: string
  runtime?: string
}

/**
 * Runs ONE agent turn in its own container and resolves the raw stdout — the
 * same contract as runAgent, so the task runner's stream-json parser is fed
 * unchanged. Everything the cage needs is prepared here and memoized: image
 * build, egress proxy, HOME volume.
 *
 * Rejects with a readable message when the cage cannot be built. It never
 * falls back to the host: a task recorded as 'container' either runs caged or
 * fails saying why.
 */
export async function runContainerTurn(opts: RunContainerTurnOptions): Promise<string> {
  const exec = opts.execFn ?? defaultExec
  const runtime = opts.runtime ?? (await isolationRuntime(opts.execFn))
  if (!runtime) {
    throw new Error(t('isolation.noRuntime'))
  }
  // Run path: an unanswered probe degrades to "not podman" (no keep-id) as it
  // always has — see the bootstrap's own note. Only the destructive sweep
  // treats null as a reason to stop.
  const podman = (await runtimeIsPodman(runtime, opts.execFn)) ?? false
  const base = resolveBaseImage(readBaseImageInputs(opts.worktree, opts.checksConfig ?? undefined))
  const image = await buildAgentImage({
    worktree: opts.worktree,
    base,
    claudeVersion: opts.claudeVersion ?? (await hostClaudeVersion(opts.execFn)),
    runtime,
    ...(opts.execFn ? { execFn: opts.execFn } : {}),
    ...(opts.installCommand !== undefined ? { installCommand: opts.installCommand } : {}),
  })
  const proxy = await ensureEgressProxy({
    runtime,
    ...(opts.execFn ? { execFn: opts.execFn } : {}),
    ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
  })
  const home = await bootstrapAgentHome({
    runtime,
    taskId: opts.taskId,
    image,
    podman,
    ...(opts.execFn ? { execFn: opts.execFn } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  })
  const env = opts.env ?? process.env
  const name = agentContainerName(opts.taskId)
  // A task worktree is a LINKED worktree: without this its `.git` points at a
  // host path the cage cannot see, and every git command inside dies with
  // "not a git repository".
  const git = prepareContainerGit({ worktree: opts.worktree, workDir: CAGE_WORK_DIR })
  const args = containerRunArgs({
    runtime,
    podman,
    name,
    image,
    worktree: opts.worktree,
    homeVolume: home.volume,
    network: proxy.network,
    proxyUrl: proxy.url,
    command: opts.command,
    forwardEnv: CAGE_FORWARDED_ENV.filter((key) => env[key]),
    ...(git ? { gitMounts: git.mountArgs } : {}),
  })
  const spawnFn = opts.spawnFn ?? spawnContainer
  return spawnFn({
    file: runtime,
    args,
    // The AGENT command, not the runtime argv: the watchdog reads its tool
    // signals from what comes back on stdout, which this describes.
    command: opts.command,
    input: opts.prompt,
    timeoutMs: opts.timeoutMs,
    ...(opts.watchdog ? { watchdog: opts.watchdog } : {}),
    ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onText ? { onText: opts.onText } : {}),
    onKill: () => {
      void exec(runtime, ['kill', name], { timeoutMs: 20_000 }).catch(() => null)
    },
  })
}

// --- boot probe ------------------------------------------------------------

/**
 * What the workspace knows about the cage at boot. `available` is the
 * EFFECTIVE availability for new tasks (a workspace configured 'policy'
 * reports false with that as the reason): the UI badge and the creation path
 * read the same answer.
 */
export type IsolationProbe = {
  available: boolean
  /** Isolation a task created now would get. */
  mode: TaskIsolation
  /** Always set: the fallback to policy is never silent. */
  reason: string
  configured: IsolationMode
  runtime: string | null
}

export type ProbeIsolationOptions = {
  configured: IsolationMode
  /** Configured agent command: the cage image only provides claude-code. */
  command: string
  /**
   * When true, skip the "cage only ships claude-code" check. T1.4 probes the
   * RUNTIME once at boot (machine-wide) and binds the agent/mode per project
   * at task creation via `overlayIsolationProbe`. Default false: a direct
   * caller still gets the honest agent-reason.
   */
  ignoreAgent?: boolean
  execFn?: IsolationExecFn
}

/**
 * Boot probe: is a container runtime there, does it answer, and can the cage
 * run the configured agent at all? Deliberately cheap (no image build): a
 * build failure later fails that task loudly, it does not silently downgrade
 * the whole workspace.
 */
export async function probeIsolation(opts: ProbeIsolationOptions): Promise<IsolationProbe> {
  const configured = opts.configured
  const deny = (reason: string): IsolationProbe => ({
    available: false,
    mode: 'policy',
    reason,
    configured,
    runtime: null,
  })
  if (configured === 'policy') {
    return deny(t('isolation.reasonConfigured'))
  }
  if (!opts.ignoreAgent && knownAgent(opts.command) !== 'claude') {
    return deny(t('isolation.reasonAgent', { command: opts.command }))
  }
  const runtime = await isolationRuntime(opts.execFn)
  if (!runtime) {
    return deny(t('isolation.reasonNoRuntime'))
  }
  const exec = opts.execFn ?? defaultExec
  // `docker --version` answers with no daemon at all: only `info` proves the
  // engine is actually reachable.
  const info = await exec(runtime, ['info'], { timeoutMs: 30_000 })
  if (info.code !== 0) {
    return {
      ...deny(t('isolation.reasonUnreachable', { runtime })),
      runtime,
    }
  }
  return {
    available: true,
    mode: 'container',
    reason: t('isolation.reasonReady', { runtime }),
    configured,
    runtime,
  }
}

/**
 * Re-bind a machine-level isolation probe (is a runtime reachable?) to one
 * project's configured mode and agent command. The boot probe no longer
 * carries the launch repo's isolation/agent, so two projects can disagree
 * on container vs policy without one poisoning the other (T1.4).
 *
 * Pure: no I/O. The machine probe is the injectable seam.
 */
export function overlayIsolationProbe(
  machine: IsolationProbe,
  opts: { configured: IsolationMode; command: string },
): IsolationProbe {
  const { configured, command } = opts
  if (configured === 'policy') {
    return {
      available: false,
      mode: 'policy',
      reason: t('isolation.reasonConfigured'),
      configured,
      runtime: machine.runtime,
    }
  }
  if (knownAgent(command) !== 'claude') {
    return {
      available: false,
      mode: 'policy',
      reason: t('isolation.reasonAgent', { command }),
      configured,
      runtime: machine.runtime,
    }
  }
  if (!machine.runtime) {
    return {
      available: false,
      mode: 'policy',
      reason: machine.reason,
      configured,
      runtime: null,
    }
  }
  if (!machine.available) {
    return {
      available: false,
      mode: 'policy',
      reason: machine.reason,
      configured,
      runtime: machine.runtime,
    }
  }
  return {
    available: true,
    mode: 'container',
    reason: machine.reason,
    configured,
    runtime: machine.runtime,
  }
}

/** Isolation a task gets at creation, and why. Null result = refuse the creation. */
export function resolveTaskIsolation(probe: IsolationProbe): {
  isolation: TaskIsolation
  reason: string
} | null {
  if (probe.configured === 'container' && !probe.available) {
    return null
  }
  if (probe.configured === 'policy') {
    return { isolation: 'policy', reason: probe.reason }
  }
  return probe.available
    ? { isolation: 'container', reason: probe.reason }
    : { isolation: 'policy', reason: probe.reason }
}

/** True when the workspace holds a resolved probe saying the cage is usable. */
export function isolationDefaults(probe: IsolationProbe): {
  isolation_available: boolean
  isolation_default: TaskIsolation
} {
  return { isolation_available: probe.available, isolation_default: probe.mode }
}

/** The probe a workspace starts from when nothing probed yet (tests, plain servers). */
export const UNPROBED_ISOLATION: IsolationProbe = {
  available: false,
  mode: 'policy',
  reason: 'container isolation was not probed',
  configured: 'policy',
  runtime: null,
}

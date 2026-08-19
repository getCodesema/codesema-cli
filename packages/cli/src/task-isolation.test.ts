import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  AGENT_KILL_GRACE_MS,
  AGENT_SETTLE_GRACE_MS,
  agentReasonCode,
  AgentWatchdogError,
  type AgentClock,
  type AgentHeartbeat,
  type WatchdogBudgets,
} from './agent.js'
import {
  CAGE_GIT_COMMON_DIR,
  containerGitStateDir,
  gitPointerContent,
  prepareContainerGit,
  resolveWorktreeGitLink,
} from './container-git.js'
import type { ExecResult } from './task-checks.js'
import {
  agentContainerName,
  agentHomeVolume,
  agentImageTag,
  agentUserCommand,
  bootstrapAgentHome,
  buildAgentImage,
  buildSquidConfig,
  BUN_CLAUDE_INSTALL_COMMAND,
  CAGE_FORWARDED_ENV,
  CONTAINER_KILL_GRACE_MS,
  containerRunArgs,
  containerTaskCommandFor,
  DEFAULT_BASE_IMAGE,
  DEFAULT_CLAUDE_INSTALL_COMMAND,
  DEFAULT_ISOLATION_ALLOWED_DOMAINS,
  defaultInstallCommand,
  EGRESS_PROXY_IMAGE,
  ensureEgressProxy,
  generateAgentDockerfile,
  GIT_INSTALL_COMMAND,
  parseJsonc,
  probeIsolation,
  resetIsolationCaches,
  resolveBaseImage,
  resolveTaskIsolation,
  runContainerTurn,
  runtimeIsPodman,
  spawnContainer,
  teardownEgressProxy,
  type BaseImage,
  type ContainerSpawnOptions,
  type IsolationExecFn,
  type IsolationProbe,
} from './task-isolation.js'

// --- rigs -----------------------------------------------------------------

const cleanups: string[] = []

beforeEach(() => {
  // Builds, proxies and home volumes are memoized per PROCESS: a test must
  // never inherit another test's cage.
  resetIsolationCaches()
})

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  resetIsolationCaches()
})

function makeDir(prefix = 'codesema-isolation-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/**
 * A real repo plus a LINKED worktree — the exact shape every task gets, and
 * the one whose `.git` is a pointer FILE aimed at a path outside the mount.
 */
function makeLinkedWorktree(): { repo: string; worktree: string } {
  const root = makeDir('codesema-isolation-git-')
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const run = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  }
  run(['init', '-b', 'main'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init'])
  const worktree = join(root, 'wt')
  run(['worktree', 'add', worktree, '-b', 'codesema/task-x'])
  return { repo, worktree }
}

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  failure: null,
  ...over,
})

type Call = { file: string; args: string[]; input?: string | undefined }

/** Scripted exec: records every host-side call, answers by rule, spawns NOTHING. */
function fakeExec(respond: (call: Call) => ExecResult = () => ok()): {
  calls: Call[]
  exec: IsolationExecFn
} {
  const calls: Call[] = []
  const exec: IsolationExecFn = (file, args, opts) => {
    const call: Call = { file, args, input: opts.input }
    calls.push(call)
    return Promise.resolve(respond(call))
  }
  return { calls, exec }
}

const argsOf = (calls: Call[], ...head: string[]): string[][] =>
  calls.filter((call) => head.every((token, i) => call.args[i] === token)).map((call) => call.args)

const plainBase = (over: Partial<BaseImage> = {}): BaseImage => ({
  source: 'default',
  image: DEFAULT_BASE_IMAGE,
  dockerfile: null,
  context: null,
  postCreate: null,
  ...over,
})

// --- base image resolution (pure) -----------------------------------------

describe('resolveBaseImage', () => {
  test('devcontainer image field wins over everything', () => {
    const base = resolveBaseImage({
      devcontainer: JSON.stringify({
        name: 'API',
        image: 'mcr.microsoft.com/devcontainers/typescript-node:1-22',
      }),
      checksImage: 'oven/bun:1',
    })
    expect(base.source).toBe('devcontainer-image')
    expect(base.image).toBe('mcr.microsoft.com/devcontainers/typescript-node:1-22')
    expect(base.dockerfile).toBeNull()
    expect(base.postCreate).toBeNull()
  })

  test('devcontainer build.dockerfile is resolved inside .devcontainer/ with its postCreateCommand', () => {
    const base = resolveBaseImage({
      devcontainer: `{
        // The image this project builds for humans.
        "name": "workspace",
        "build": { "dockerfile": "Dockerfile", "context": "." },
        "postCreateCommand": "apt-get update && apt-get install -y ripgrep",
      }`,
      checksImage: 'node:22',
    })
    expect(base.source).toBe('devcontainer-dockerfile')
    expect(base.image).toBeNull()
    expect(base.dockerfile).toBe('.devcontainer/Dockerfile')
    expect(base.context).toBe('.devcontainer')
    expect(base.postCreate).toBe('apt-get update && apt-get install -y ripgrep')
  })

  test('a dockerfile in a subfolder of .devcontainer stays supported', () => {
    const base = resolveBaseImage({
      devcontainer: JSON.stringify({ build: { dockerfile: 'images/Dockerfile.dev' } }),
      checksImage: null,
    })
    expect(base.dockerfile).toBe('.devcontainer/images/Dockerfile.dev')
  })

  test('features: the whole devcontainer is ignored, cleanly, down to the checks image', () => {
    const base = resolveBaseImage({
      devcontainer: JSON.stringify({
        image: 'node:22-bookworm',
        features: { 'ghcr.io/devcontainers/features/docker-in-docker:2': {} },
      }),
      checksImage: 'oven/bun:1',
    })
    expect(base.source).toBe('checks')
    expect(base.image).toBe('oven/bun:1')
  })

  test('docker-compose devcontainers fall back too', () => {
    const base = resolveBaseImage({
      devcontainer: JSON.stringify({
        dockerComposeFile: 'docker-compose.yml',
        service: 'app',
        image: 'node:22',
      }),
      checksImage: 'python:3.12',
    })
    expect(base.source).toBe('checks')
    expect(base.image).toBe('python:3.12')
  })

  test('an array or object postCreateCommand falls back rather than guess one line', () => {
    const array = resolveBaseImage({
      devcontainer: JSON.stringify({
        image: 'node:22',
        postCreateCommand: ['npm', 'install'],
      }),
      checksImage: null,
    })
    expect(array.source).toBe('default')
    const object = resolveBaseImage({
      devcontainer: JSON.stringify({
        image: 'node:22',
        postCreateCommand: { install: 'npm ci', build: 'npm run build' },
      }),
      checksImage: null,
    })
    expect(object.source).toBe('default')
  })

  test('a build context outside the devcontainer folder is not honoured', () => {
    const base = resolveBaseImage({
      devcontainer: JSON.stringify({ build: { dockerfile: 'Dockerfile', context: '..' } }),
      checksImage: 'node:22',
    })
    expect(base.source).toBe('checks')
  })

  test('a dockerfile escaping the folder, or an absolute one, is refused', () => {
    for (const dockerfile of ['../../etc/Dockerfile', '/etc/Dockerfile', '..']) {
      const base = resolveBaseImage({
        devcontainer: JSON.stringify({ build: { dockerfile } }),
        checksImage: null,
      })
      expect(base.source).toBe('default')
    }
  })

  test('an image reference that is not one (shell metacharacters) is dropped', () => {
    const base = resolveBaseImage({
      devcontainer: JSON.stringify({ image: 'node:22; rm -rf /' }),
      checksImage: null,
    })
    expect(base.source).toBe('default')
    expect(base.image).toBe(DEFAULT_BASE_IMAGE)
  })

  test('a script-sized postCreateCommand is refused', () => {
    const base = resolveBaseImage({
      devcontainer: JSON.stringify({ image: 'node:22', postCreateCommand: 'x'.repeat(2000) }),
      checksImage: null,
    })
    expect(base.source).toBe('default')
  })

  test('unparseable devcontainer.json degrades to the checks image', () => {
    const base = resolveBaseImage({ devcontainer: '{ not json at all', checksImage: 'node:22' })
    expect(base.source).toBe('checks')
  })

  test('no devcontainer, no checks detection: node:22', () => {
    const base = resolveBaseImage({ devcontainer: null, checksImage: null })
    expect(base.source).toBe('default')
    expect(base.image).toBe(DEFAULT_BASE_IMAGE)
    expect(base.postCreate).toBeNull()
  })
})

describe('parseJsonc', () => {
  test('strips comments and trailing commas, keeps them inside strings', () => {
    const parsed = parseJsonc(`{
      /* block */
      "image": "node:22", // line comment
      "name": "a // b",
      "postCreateCommand": "echo /* hi */",
    }`)
    expect(parsed?.image).toBe('node:22')
    expect(parsed?.name).toBe('a // b')
    expect(parsed?.postCreateCommand).toBe('echo /* hi */')
  })

  test('a JSON array or scalar is not a devcontainer', () => {
    expect(parseJsonc('[1,2]')).toBeNull()
    expect(parseJsonc('"nope"')).toBeNull()
  })
})

// --- agent image -----------------------------------------------------------

/** A uid/gid pair no real account owns: the "free" side of every branch below. */
const FREE_UID = 61234
const FREE_GID = 61235

type UserSetupRun = { code: number; stdout: string; stderr: string; calls: string[] }

/**
 * Runs the generated user-setup script FOR REAL, with the distro's user tools
 * replaced by stubs that only record their argv. What is asserted is then the
 * BRANCH the script takes on a given base — the bug it replaces was a chain of
 * `||` that read fine and could not work on any busybox base.
 *
 * PATH deliberately excludes /usr/sbin, where useradd/adduser/groupadd live on
 * a real machine: a probe must only ever find the stubs this rig installed.
 */
function runUserSetup(opts: { uid: number; gid: number; tools: readonly string[] }): UserSetupRun {
  const dir = makeDir('codesema-user-setup-')
  const log = join(dir, 'calls.log')
  // mkdir/chown are stubbed too: the script's paths are absolute (/home/agent,
  // /work) and a test must not touch the host's filesystem.
  for (const tool of ['mkdir', 'chown', ...opts.tools]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "${log}"\n`, {
      mode: 0o755,
    })
  }
  const done = spawnSync('sh', ['-c', agentUserCommand(opts.uid, opts.gid)], {
    encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin` },
  })
  let calls: string[] = []
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    calls = []
  }
  return { code: done.status ?? -1, stdout: done.stdout, stderr: done.stderr, calls }
}

const called = (run: UserSetupRun, tool: string): string[] =>
  run.calls.filter((line) => line.startsWith(`${tool} `))

describe('agentUserCommand', () => {
  // THE alpine bug: node:*-alpine already owns uid/gid 1000 with its `node`
  // user, busybox has no groupadd and its adduser has no -o, so a recipe that
  // insists on CREATING the host uid could not build on any alpine base.
  test('a base that already owns the host uid is reused, nothing is created', () => {
    // uid/gid 0 is the one account every machine running this test has.
    const run = runUserSetup({ uid: 0, gid: 0, tools: ['useradd', 'adduser', 'groupadd'] })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('reusing')
    expect(called(run, 'useradd')).toEqual([])
    expect(called(run, 'adduser')).toEqual([])
    expect(called(run, 'groupadd')).toEqual([])
    // The cage home is still prepared and handed to that uid.
    expect(called(run, 'mkdir').join(' ')).toContain('/home/agent /work')
    expect(called(run, 'chown').join(' ')).toContain('0:0 /home/agent')
  })

  test('a free uid is created, group first, with the shadow tools when they exist', () => {
    const run = runUserSetup({
      uid: FREE_UID,
      gid: FREE_GID,
      tools: ['groupadd', 'useradd', 'addgroup', 'adduser'],
    })
    expect(run.code).toBe(0)
    expect(called(run, 'groupadd')).toEqual([`groupadd -g ${FREE_GID} agent`])
    expect(called(run, 'useradd')[0]).toContain(`-u ${FREE_UID}`)
    expect(called(run, 'useradd')[0]).toContain(`-g ${FREE_GID}`)
    expect(called(run, 'useradd')[0]).toContain('-d /home/agent')
    // The busybox spellings stay untouched when the shadow ones are there.
    expect(called(run, 'addgroup')).toEqual([])
    expect(called(run, 'adduser')).toEqual([])
  })

  test('a busybox base uses addgroup/adduser, and never an option busybox lacks', () => {
    const run = runUserSetup({ uid: FREE_UID, gid: FREE_GID, tools: ['addgroup', 'adduser'] })
    expect(run.code).toBe(0)
    expect(called(run, 'addgroup')).toEqual([`addgroup -g ${FREE_GID} agent`])
    expect(called(run, 'adduser')[0]).toContain(`-u ${FREE_UID}`)
    expect(called(run, 'adduser')[0]).toContain('-G agent')
    expect(called(run, 'adduser')[0]).toContain('-h /home/agent')
    // -o (allow a duplicate uid) does not exist in busybox: the recipe must
    // never need it, since it only ever creates a uid nobody owns.
    expect(agentUserCommand(FREE_UID, FREE_GID)).not.toContain('-o ')
  })

  test('a taken gid with a free uid reuses the existing group instead of failing on it', () => {
    // gid 0 is taken everywhere; its name is what adduser -G must receive.
    const run = runUserSetup({ uid: FREE_UID, gid: 0, tools: ['addgroup', 'adduser'] })
    expect(run.code).toBe(0)
    expect(called(run, 'addgroup')).toEqual([])
    expect(called(run, 'adduser')[0]).toMatch(/-G (root|wheel)/)
    expect(called(run, 'adduser')[0]).toContain(`-u ${FREE_UID}`)
  })

  test('a base that can create neither fails the build, loudly and actionably', () => {
    const run = runUserSetup({ uid: FREE_UID, gid: 0, tools: [] })
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('codesema:')
    expect(run.stderr).toContain('neither useradd nor adduser')
    expect(run.stderr).toContain('.devcontainer')
  })

  test('a base with no way to own the gid fails the same way, naming the gid', () => {
    const run = runUserSetup({ uid: FREE_UID, gid: FREE_GID, tools: ['useradd', 'adduser'] })
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('codesema:')
    expect(run.stderr).toContain('neither groupadd nor addgroup')
    expect(run.stderr).toContain(String(FREE_GID))
    // It stopped there: no user was created against a group that is not owned.
    expect(called(run, 'useradd')).toEqual([])
  })
})

describe('generateAgentDockerfile', () => {
  const dockerfile = generateAgentDockerfile({
    baseRef: 'node:22',
    installCommand: DEFAULT_CLAUDE_INSTALL_COMMAND,
    postCreate: null,
    uid: 1000,
    gid: 1000,
  })

  test('derives from the base and ends as the non-root host uid', () => {
    expect(dockerfile).toContain('FROM node:22')
    expect(dockerfile).toContain(DEFAULT_CLAUDE_INSTALL_COMMAND)
    // NUMERIC on purpose: when the base's own user is reused, its name is only
    // known inside the build and a Dockerfile cannot carry it into USER.
    expect(dockerfile.trimEnd().endsWith('USER 1000:1000')).toBe(true)
    expect(dockerfile).toContain('ENV HOME=/home/agent')
    expect(dockerfile).toContain('WORKDIR /work')
  })

  test('runs as the host uid/gid so the mounted worktree stays writable', () => {
    const asUser = generateAgentDockerfile({
      baseRef: 'node:22',
      installCommand: 'true',
      postCreate: null,
      uid: 1500,
      gid: 1501,
    })
    expect(asUser).toContain('-u 1500')
    expect(asUser).toContain('-g 1501')
    expect(asUser).toContain('chown -R 1500:1501 /home/agent')
    expect(asUser.trimEnd().endsWith('USER 1500:1501')).toBe(true)
  })

  // HOME is the mount point of the per-task home volume (containerRunArgs), so
  // it must NOT follow a reused user's own home (`/home/node` on a node base):
  // the ENV wins over the passwd entry, and both sides agree on one path.
  test('HOME is the cage home whatever the reused user owns', () => {
    expect(dockerfile).toContain('ENV HOME=/home/agent')
    expect(dockerfile).toContain('mkdir -p /home/agent /work')
    expect(dockerfile).toContain('chown -R 1000:1000 /home/agent')
  })

  test('every RUN uses the JSON exec form: a hostile postCreateCommand cannot break out', () => {
    const evil = generateAgentDockerfile({
      baseRef: 'node:22',
      installCommand: 'true',
      postCreate: 'echo "quoted" && :',
      uid: 1000,
      gid: 1000,
    })
    for (const line of evil.split('\n').filter((l) => l.startsWith('RUN'))) {
      expect(line.startsWith('RUN ["sh","-lc",')).toBe(true)
      expect(line.endsWith(']')).toBe(true)
    }
    expect(evil).toContain('echo \\"quoted\\"')
  })

  // The bug this guards: node: ships git, node:*-slim and *-alpine do not, and
  // an agent whose `git status` answers "not found" reports that git is not
  // available and starts guessing what the previous turn did.
  test('git is guaranteed: probed first, then installed per package-manager family', () => {
    expect(dockerfile).toContain('command -v git')
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends git')
    expect(dockerfile).toContain('apk add --no-cache git')
    expect(dockerfile).toContain('dnf install -y git')
    // The probe comes first: a base that already has git installs nothing.
    expect(GIT_INSTALL_COMMAND.indexOf('command -v git')).toBeLessThan(
      GIT_INSTALL_COMMAND.indexOf('apt-get'),
    )
  })

  test('a base with neither git nor a package manager fails the build, with the reason', () => {
    expect(GIT_INSTALL_COMMAND.trimEnd().endsWith('exit 1')).toBe(true)
    expect(GIT_INSTALL_COMMAND).toContain('codesema: this base image ships no git')
  })

  test('user setup, git and the agent CLI all run as root, before the final USER', () => {
    const lines = dockerfile.split('\n')
    const userStep = lines.findIndex((line) => line.includes('getent passwd 1000'))
    const gitStep = lines.findIndex((line) => line.includes('apk add --no-cache git'))
    const claudeStep = lines.findIndex((line) => line.includes(DEFAULT_CLAUDE_INSTALL_COMMAND))
    expect(userStep).toBeGreaterThan(lines.indexOf('USER root'))
    expect(userStep).toBeLessThan(gitStep)
    expect(gitStep).toBeLessThan(claudeStep)
    expect(claudeStep).toBeLessThan(lines.indexOf('USER 1000:1000'))
  })

  test('postCreateCommand is best effort: it can never fail the cage build', () => {
    const withPost = generateAgentDockerfile({
      baseRef: 'node:22',
      installCommand: 'true',
      postCreate: 'npm ci',
      uid: 1000,
      gid: 1000,
    })
    expect(withPost).toContain('npm ci ||')
  })
})

describe('defaultInstallCommand', () => {
  test('npm on a node base, bun on a bun base', () => {
    expect(defaultInstallCommand('node:22')).toBe(DEFAULT_CLAUDE_INSTALL_COMMAND)
    expect(defaultInstallCommand('python:3.12')).toBe(DEFAULT_CLAUDE_INSTALL_COMMAND)
    expect(defaultInstallCommand('oven/bun:1')).toBe(BUN_CLAUDE_INSTALL_COMMAND)
  })
})

describe('agentImageTag', () => {
  test('12 hex chars, stable for the same inputs', () => {
    const tag = agentImageTag('node:22', 'FROM node:22', '2.1.233')
    expect(tag).toBe(agentImageTag('node:22', 'FROM node:22', '2.1.233'))
    expect(tag).toMatch(/^codesema-agent:[0-9a-f]{12}$/)
  })

  test('a host claude upgrade, a new base or a new dockerfile all retag', () => {
    const base = agentImageTag('node:22', 'FROM node:22', '2.1.233')
    expect(agentImageTag('node:22', 'FROM node:22', '2.1.234')).not.toBe(base)
    expect(agentImageTag('node:24', 'FROM node:22', '2.1.233')).not.toBe(base)
    expect(agentImageTag('node:22', 'FROM node:22\nUSER agent', '2.1.233')).not.toBe(base)
  })

  // The tag hashes the WHOLE recipe, so adding the git step invalidates every
  // git-less agent image already built on this machine instead of reusing it.
  test('changing the recipe retags: images built before the git step are invalidated', () => {
    const recipe = generateAgentDockerfile({
      baseRef: DEFAULT_BASE_IMAGE,
      installCommand: DEFAULT_CLAUDE_INSTALL_COMMAND,
      postCreate: null,
      uid: 1000,
      gid: 1000,
    })
    const withoutGit = recipe
      .split('\n')
      .filter((line) => !line.includes('command -v git'))
      .join('\n')
    expect(withoutGit).not.toBe(recipe)
    expect(agentImageTag(DEFAULT_BASE_IMAGE, recipe, '2.1.233')).not.toBe(
      agentImageTag(DEFAULT_BASE_IMAGE, withoutGit, '2.1.233'),
    )
  })

  // Same guarantee for the user step: every image built by the create-only
  // recipe carries the old step in its hash, so none of them is reused.
  test('changing the user step retags: no image built by the broken recipe is reused', () => {
    const recipe = generateAgentDockerfile({
      baseRef: DEFAULT_BASE_IMAGE,
      installCommand: DEFAULT_CLAUDE_INSTALL_COMMAND,
      postCreate: null,
      uid: 1000,
      gid: 1000,
    })
    const broken = recipe
      .split('\n')
      .map((line) =>
        line.includes('getent passwd 1000')
          ? 'RUN ["sh","-lc","useradd -o -m -u 1000 -g 1000 -s /bin/sh agent"]'
          : line,
      )
      .join('\n')
    expect(broken).not.toBe(recipe)
    expect(agentImageTag(DEFAULT_BASE_IMAGE, recipe, '2.1.233')).not.toBe(
      agentImageTag(DEFAULT_BASE_IMAGE, broken, '2.1.233'),
    )
  })
})

describe('buildAgentImage', () => {
  test('builds once and memoizes: the second turn reuses the tag without rebuilding', async () => {
    const { calls, exec } = fakeExec()
    const worktree = makeDir()
    const first = await buildAgentImage({
      worktree,
      base: plainBase(),
      claudeVersion: '2.1.233',
      runtime: 'docker',
      execFn: exec,
    })
    const second = await buildAgentImage({
      worktree,
      base: plainBase(),
      claudeVersion: '2.1.233',
      runtime: 'docker',
      execFn: exec,
    })
    expect(second).toBe(first)
    expect(argsOf(calls, 'build')).toHaveLength(1)
    expect(first).toMatch(/^codesema-agent:[0-9a-f]{12}$/)
  })

  test('the build context is empty: nothing of the repo is ever copied into the image', async () => {
    const { calls, exec } = fakeExec()
    const worktree = makeDir()
    writeFileSync(join(worktree, 'secret.env'), 'TOKEN=1\n')
    await buildAgentImage({
      worktree,
      base: plainBase(),
      claudeVersion: '2.1.233',
      runtime: 'docker',
      execFn: exec,
    })
    const build = argsOf(calls, 'build')[0] ?? []
    expect(build.some((arg) => arg.includes(worktree))).toBe(false)
  })

  test('a devcontainer Dockerfile base is built first, then used as the FROM', async () => {
    const { calls, exec } = fakeExec()
    const worktree = makeDir()
    await buildAgentImage({
      worktree,
      base: {
        source: 'devcontainer-dockerfile',
        image: null,
        dockerfile: '.devcontainer/Dockerfile',
        context: '.devcontainer',
        postCreate: null,
      },
      claudeVersion: '2.1.233',
      runtime: 'podman',
      execFn: exec,
    })
    const builds = argsOf(calls, 'build')
    expect(builds).toHaveLength(2)
    expect(builds[0]?.join(' ')).toContain(join(worktree, '.devcontainer/Dockerfile'))
    expect(builds[0]?.join(' ')).toContain('codesema-base:')
    expect(builds[1]?.join(' ')).toContain('codesema-agent:')
  })

  test('a failed build makes the cage UNAVAILABLE, loudly, and is retried next time', async () => {
    let attempts = 0
    const { exec } = fakeExec((call) => {
      if (call.args[0] === 'build') {
        attempts++
        return ok({ code: 1, stderr: 'npm ERR! 404 @anthropic-ai/claude-code' })
      }
      return ok()
    })
    const worktree = makeDir()
    const build = () =>
      buildAgentImage({
        worktree,
        base: plainBase(),
        claudeVersion: '2.1.233',
        runtime: 'docker',
        execFn: exec,
      })
    await expect(build()).rejects.toThrow(/npm ERR! 404/)
    // The rejected build is evicted from the memo: a transient failure (no
    // network at that second) must not brick the cage for the whole process.
    await expect(build()).rejects.toThrow()
    expect(attempts).toBe(2)
  })

  test('the injected install command lands in the image (test/smoke seam)', async () => {
    const { calls, exec } = fakeExec()
    const worktree = makeDir()
    const tag = await buildAgentImage({
      worktree,
      base: plainBase(),
      claudeVersion: '2.1.233',
      runtime: 'docker',
      execFn: exec,
      installCommand: 'echo offline-install',
    })
    const dir = (argsOf(calls, 'build')[0] ?? []).at(-1) ?? ''
    expect(dir).toContain('codesema-agent-image-')
    expect(tag).toMatch(/^codesema-agent:/)
  })
})

// --- egress proxy ----------------------------------------------------------

describe('buildSquidConfig', () => {
  test('CONNECT to the allowlist, deny everything else', () => {
    const config = buildSquidConfig(['api.anthropic.com'])
    expect(config).toContain('acl allowed dstdomain .api.anthropic.com')
    expect(config).toContain('http_access deny !CONNECT')
    expect(config).toContain('http_access deny CONNECT !SSL_ports')
    expect(config).toContain('http_access allow CONNECT allowed')
    expect(
      config
        .trimEnd()
        .split('\n')
        .filter((l) => l === 'http_access deny all'),
    ).toHaveLength(1)
  })

  // Squid dies on startup ("Bungled squid.conf") when a domain is listed both
  // bare and dotted, taking the whole cage with it. The dotted form alone
  // matches the apex and every subdomain — verified against squid 6.13.
  test('each domain is emitted ONCE, dotted: squid refuses the bare+dotted pair', () => {
    const config = buildSquidConfig(['api.anthropic.com', 'platform.claude.com'])
    const acls = config.split('\n').filter((l) => l.startsWith('acl allowed dstdomain'))
    expect(acls).toEqual([
      'acl allowed dstdomain .api.anthropic.com',
      'acl allowed dstdomain .platform.claude.com',
    ])
  })

  test('an entry that is not a hostname never reaches the file', () => {
    const config = buildSquidConfig(['api.anthropic.com', 'evil.com\nhttp_access allow all'])
    expect(config).not.toContain('allow all')
    expect(config).toContain('api.anthropic.com')
  })

  test('an empty allowlist denies everything (no allow rule at all)', () => {
    expect(buildSquidConfig([])).not.toContain('http_access allow')
  })
})

describe('ensureEgressProxy', () => {
  test('creates an INTERNAL network, starts squid outside it, then connects it', async () => {
    const { calls, exec } = fakeExec((call) =>
      call.args[1] === 'inspect' ? ok({ code: 1 }) : ok(),
    )
    const proxy = await ensureEgressProxy({
      runtime: 'docker',
      execFn: exec,
      allowedDomains: ['api.anthropic.com'],
      configDir: makeDir('codesema-proxy-conf-'),
    })
    expect(proxy.network).toMatch(/^codesema-net-[0-9a-f]{8}$/)
    expect(proxy.egressNetwork).toMatch(/^codesema-egress-[0-9a-f]{8}$/)
    expect(proxy.container).toMatch(/^codesema-proxy-[0-9a-f]{8}$/)
    expect(proxy.url).toBe(`http://${proxy.container}:3128`)

    // Exactly one of the two networks is internal: the agent's.
    const creates = argsOf(calls, 'network', 'create')
    expect(creates).toHaveLength(2)
    expect(creates.find((a) => a.includes('--internal'))?.at(-1)).toBe(proxy.network)
    expect(creates.find((a) => !a.includes('--internal'))?.at(-1)).toBe(proxy.egressNetwork)

    const run = argsOf(calls, 'run')[0] ?? []
    expect(run).toContain(EGRESS_PROXY_IMAGE)
    expect(run.join(' ')).toContain(`${proxy.configPath}:/etc/squid/squid.conf:ro`)
    // The proxy is NOT started on the internal network: that would leave it
    // with no route out either. It starts on its own bridge — never the
    // runtime default, which is pasta under rootless podman and cannot be
    // `network connect`ed — and joins the internal one afterwards.
    expect(run[run.indexOf('--network') + 1]).toBe(proxy.egressNetwork)
    expect(run).not.toContain(proxy.network)
    expect(argsOf(calls, 'network', 'connect')[0]).toEqual([
      'network',
      'connect',
      proxy.network,
      proxy.container,
    ])
  })

  test('idempotent: a second task reuses the running proxy without touching the runtime', async () => {
    const { calls, exec } = fakeExec((call) =>
      call.args[1] === 'inspect' ? ok({ code: 1 }) : ok(),
    )
    const configDir = makeDir('codesema-proxy-conf-')
    const first = await ensureEgressProxy({ runtime: 'docker', execFn: exec, configDir })
    const before = calls.length
    const second = await ensureEgressProxy({ runtime: 'docker', execFn: exec, configDir })
    expect(second).toEqual(first)
    expect(calls.length).toBe(before)
  })

  test('an existing network and container are reused as they are', async () => {
    const { calls, exec } = fakeExec()
    await ensureEgressProxy({
      runtime: 'podman',
      execFn: exec,
      configDir: makeDir('codesema-proxy-conf-'),
    })
    expect(argsOf(calls, 'network', 'create')).toHaveLength(0)
    expect(argsOf(calls, 'run')).toHaveLength(0)
  })

  test('a different allowlist gets its own network and proxy', async () => {
    const { exec } = fakeExec((call) => (call.args[1] === 'inspect' ? ok({ code: 1 }) : ok()))
    const configDir = makeDir('codesema-proxy-conf-')
    const a = await ensureEgressProxy({
      runtime: 'docker',
      execFn: exec,
      allowedDomains: ['api.anthropic.com'],
      configDir,
    })
    const b = await ensureEgressProxy({
      runtime: 'docker',
      execFn: exec,
      allowedDomains: ['api.anthropic.com', 'registry.npmjs.org'],
      configDir,
    })
    expect(b.network).not.toBe(a.network)
  })

  test('a failure to create the network is reported, never swallowed', async () => {
    const { exec } = fakeExec((call) => {
      if (call.args[1] === 'inspect') {
        return ok({ code: 1 })
      }
      return call.args[1] === 'create' ? ok({ code: 125, stderr: 'permission denied' }) : ok()
    })
    await expect(
      ensureEgressProxy({
        runtime: 'docker',
        execFn: exec,
        configDir: makeDir('codesema-proxy-conf-'),
      }),
    ).rejects.toThrow(/permission denied/)
  })

  test('teardown removes what THIS process started, and nothing else', async () => {
    const { calls, exec } = fakeExec((call) =>
      call.args[1] === 'inspect' ? ok({ code: 1 }) : ok(),
    )
    const proxy = await ensureEgressProxy({
      runtime: 'docker',
      execFn: exec,
      configDir: makeDir('codesema-proxy-conf-'),
    })
    calls.length = 0
    await teardownEgressProxy({ runtime: 'docker', execFn: exec })
    expect(argsOf(calls, 'rm', '-f')[0]).toEqual(['rm', '-f', proxy.container])
    // Both networks this process created go away with it.
    expect(argsOf(calls, 'network', 'rm').map((a) => a[2])).toEqual([
      proxy.network,
      proxy.egressNetwork,
    ])
  })

  test('teardown without a runtime is a no-op, never a crash on shutdown', async () => {
    const { calls, exec } = fakeExec()
    await teardownEgressProxy({ runtime: null, execFn: exec })
    expect(calls).toHaveLength(0)
  })
})

// --- agent HOME volume -----------------------------------------------------

describe('bootstrapAgentHome', () => {
  const taskId = 'a1b2c3d4e5f6'

  test('copies the host credentials through stdin: the secret never enters argv', async () => {
    const credentials = makeDir()
    const path = join(credentials, '.credentials.json')
    writeFileSync(path, '{"claudeAiOauth":{"accessToken":"sk-secret"}}')
    const { calls, exec } = fakeExec((call) =>
      call.args[1] === 'inspect' ? ok({ code: 1 }) : ok(),
    )
    const home = await bootstrapAgentHome({
      runtime: 'podman',
      taskId,
      image: 'codesema-agent:deadbeefcafe',
      execFn: exec,
      env: {},
      credentialsPath: path,
    })
    expect(home).toEqual({ volume: agentHomeVolume(taskId), credentials: 'copied' })
    expect(argsOf(calls, 'volume', 'create')[0]).toEqual([
      'volume',
      'create',
      agentHomeVolume(taskId),
    ])
    const seed = calls.find((call) => call.args[0] === 'run')
    expect(seed?.input).toContain('sk-secret')
    expect(seed?.args.join(' ')).not.toContain('sk-secret')
    // The seeding container has no reason to reach anything.
    expect(seed?.args).toContain('--network')
    expect(seed?.args[(seed.args.indexOf('--network') ?? 0) + 1]).toBe('none')
    expect(seed?.args).toContain('--userns=keep-id')
  })

  test('an OAuth token in the environment means nothing is copied at all', async () => {
    const { calls, exec } = fakeExec((call) =>
      call.args[1] === 'inspect' ? ok({ code: 1 }) : ok(),
    )
    const home = await bootstrapAgentHome({
      runtime: 'docker',
      taskId,
      image: 'codesema-agent:deadbeefcafe',
      execFn: exec,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    })
    expect(home.credentials).toBe('oauth-token')
    expect(argsOf(calls, 'run')).toHaveLength(0)
  })

  test('no credentials on the host: honest "missing", the cage still runs', async () => {
    const { exec } = fakeExec((call) => (call.args[1] === 'inspect' ? ok({ code: 1 }) : ok()))
    const home = await bootstrapAgentHome({
      runtime: 'docker',
      taskId,
      image: 'codesema-agent:deadbeefcafe',
      execFn: exec,
      env: {},
      credentialsPath: join(makeDir(), 'nothing-here.json'),
    })
    expect(home.credentials).toBe('missing')
  })

  test('an existing volume is left strictly alone (that is how sessions survive turns)', async () => {
    const { calls, exec } = fakeExec()
    const home = await bootstrapAgentHome({
      runtime: 'docker',
      taskId,
      image: 'codesema-agent:deadbeefcafe',
      execFn: exec,
      env: {},
    })
    expect(home.credentials).toBe('already-bootstrapped')
    expect(argsOf(calls, 'volume', 'create')).toHaveLength(0)
    expect(argsOf(calls, 'run')).toHaveLength(0)
  })

  test('memoized per task: two turns bootstrap once', async () => {
    const { calls, exec } = fakeExec((call) =>
      call.args[1] === 'inspect' ? ok({ code: 1 }) : ok(),
    )
    const opts = {
      runtime: 'docker',
      taskId,
      image: 'codesema-agent:deadbeefcafe',
      execFn: exec,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    }
    await bootstrapAgentHome(opts)
    const before = calls.length
    await bootstrapAgentHome(opts)
    expect(calls.length).toBe(before)
  })
})

// --- the caged command and its argv ---------------------------------------

describe('containerTaskCommandFor', () => {
  test('the cage replaces the policy hardening: skip-permissions in, host flags out', () => {
    const cmd = containerTaskCommandFor('claude -p', { session: { kind: 'new', id: 'uuid-1' } })
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('--output-format stream-json --include-partial-messages --verbose')
    expect(cmd).toContain('--session-id uuid-1')
    expect(cmd).not.toContain('--strict-mcp-config')
    expect(cmd).not.toContain('--setting-sources')
    expect(cmd).not.toContain('--permission-mode')
  })

  test('later turns resume the stored session', () => {
    const cmd = containerTaskCommandFor('claude -p', { session: { kind: 'resume', id: 's9' } })
    expect(cmd).toContain('--resume s9')
    expect(cmd).not.toContain('--session-id')
  })

  test('a user-set skip flag is not duplicated', () => {
    const cmd = containerTaskCommandFor('claude -p --dangerously-skip-permissions', {
      session: null,
    })
    expect(cmd.match(/--dangerously-skip-permissions/g)).toHaveLength(1)
  })

  test('a custom output format keeps the session flags but drops the stream flags', () => {
    const cmd = containerTaskCommandFor('claude -p --output-format json', {
      session: { kind: 'new', id: 'uuid-1' },
    })
    expect(cmd).not.toContain('stream-json')
    expect(cmd).toContain('--session-id uuid-1')
  })

  test('a non-claude command is passed through untouched', () => {
    expect(containerTaskCommandFor('codex exec -', { session: null })).toBe('codex exec -')
  })
})

describe('containerRunArgs', () => {
  const spec = {
    runtime: 'docker',
    name: agentContainerName('a1b2c3d4e5f6'),
    image: 'codesema-agent:deadbeefcafe',
    worktree: '/repo/.codesema/worktrees/a1b2c3d4e5f6',
    homeVolume: 'codesema-home-a1b2c3d4e5f6',
    network: 'codesema-net-12345678',
    proxyUrl: 'http://codesema-proxy-12345678:3128',
    command: 'claude -p --dangerously-skip-permissions',
    forwardEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
  }

  test('ephemeral, named, prompt on stdin, worktree as the only host path', () => {
    const args = containerRunArgs(spec)
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i'])
    expect(args).toContain('--name')
    expect(args[args.indexOf('--name') + 1]).toBe('codesema-task-a1b2c3d4e5f6')
    expect(args).toContain(`${spec.worktree}:/work:rw`)
    expect(args[args.indexOf('-w') + 1]).toBe('/work')
    expect(args).toContain('codesema-home-a1b2c3d4e5f6:/home/agent')
    // Nothing else of the machine: exactly two mounts, both known.
    expect(args.filter((arg) => arg === '-v')).toHaveLength(2)
  })

  test('the git mounts are read-only, and they are the ONLY host path added', () => {
    const args = containerRunArgs({
      ...spec,
      gitMounts: ['-v', '/repo/.git:/gitcommon:ro', '-v', '/tmp/x/dotgit:/work/.git:ro'],
    })
    expect(args.filter((arg) => arg === '-v')).toHaveLength(4)
    expect(args).toContain('/repo/.git:/gitcommon:ro')
    expect(args).toContain('/tmp/x/dotgit:/work/.git:ro')
    // Read-only is the whole point: the box reads the history, the host commits.
    for (const mount of args.filter((arg) => arg.includes(':/gitcommon'))) {
      expect(mount.endsWith(':ro')).toBe(true)
    }
  })

  // git refuses a repository owned by another uid; the rootless mappings make
  // that mismatch ordinary. safe.directory only counts in protected config,
  // and GIT_CONFIG_* (command scope) is per RUN, so it survives a $HOME volume
  // that was seeded on an earlier turn.
  test('safe.directory travels as protected config, on every run', () => {
    const args = containerRunArgs(spec)
    expect(args).toContain('GIT_CONFIG_COUNT=2')
    expect(args).toContain('GIT_CONFIG_KEY_0=safe.directory')
    expect(args).toContain('GIT_CONFIG_VALUE_0=/work')
    expect(args).toContain('GIT_CONFIG_KEY_1=safe.directory')
    expect(args).toContain('GIT_CONFIG_VALUE_1=/gitcommon')
  })

  test('the only route out is the internal network plus the proxy env', () => {
    const args = containerRunArgs(spec)
    expect(args[args.indexOf('--network') + 1]).toBe('codesema-net-12345678')
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      expect(args).toContain(`${key}=http://codesema-proxy-12345678:3128`)
    }
  })

  test('forwarded provider variables travel BY NAME: no secret in argv', () => {
    const args = containerRunArgs(spec)
    expect(args).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(args.some((arg) => arg.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))).toBe(false)
  })

  test('bounded, unprivileged, and no socket: the cage is a cage', () => {
    const args = containerRunArgs(spec)
    expect(args[args.indexOf('--cpus') + 1]).toBe('2')
    expect(args[args.indexOf('--memory') + 1]).toBe('4g')
    expect(args).toContain('--security-opt')
    expect(args).toContain('no-new-privileges')
    expect(args).not.toContain('--privileged')
    expect(args.join(' ')).not.toContain('docker.sock')
    expect(args.join(' ')).not.toContain('--cap-add')
  })

  test('the agent command runs under sh -lc INSIDE the container, last', () => {
    const args = containerRunArgs(spec)
    expect(args.slice(-3)).toEqual(['sh', '-lc', spec.command])
    expect(args.at(-4)).toBe(spec.image)
  })

  test('podman keeps the host uid inside the cage; docker needs no such flag', () => {
    expect(containerRunArgs({ ...spec, runtime: 'podman' })).toContain('--userns=keep-id')
    expect(containerRunArgs(spec)).not.toContain('--userns=keep-id')
  })

  // A podman exposed as `docker` is podman: the name lies, the probed flag wins.
  test('the resolved podman flag overrides the runtime NAME, both ways', () => {
    expect(containerRunArgs({ ...spec, runtime: 'docker', podman: true })).toContain(
      '--userns=keep-id',
    )
    expect(containerRunArgs({ ...spec, runtime: 'podman', podman: false })).not.toContain(
      '--userns=keep-id',
    )
  })
})

// --- reading git from inside the box ---------------------------------------

describe('container git access', () => {
  test('a linked worktree resolves to the shared git dir plus its admin subpath', () => {
    const { repo, worktree } = makeLinkedWorktree()
    const link = resolveWorktreeGitLink(worktree)
    expect(link).not.toBeNull()
    expect(link?.commonDir).toBe(join(repo, '.git'))
    expect(link?.gitDirRelative).toBe('worktrees/wt')
    // What lands over /work/.git: a pointer INSIDE the container, no host path.
    expect(link ? gitPointerContent(link) : '').toBe(
      `gitdir: ${CAGE_GIT_COMMON_DIR}/worktrees/wt\n`,
    )
  })

  test('a plain checkout needs nothing: its .git is already inside the mount', () => {
    const { repo } = makeLinkedWorktree()
    expect(resolveWorktreeGitLink(repo)).toBeNull()
    expect(prepareContainerGit({ worktree: repo, workDir: '/work' })).toBeNull()
  })

  test('a directory that is not a repository is left strictly alone', () => {
    expect(resolveWorktreeGitLink(makeDir())).toBeNull()
  })

  test('prepare writes the pointer file and returns two read-only mounts', () => {
    const { repo, worktree } = makeLinkedWorktree()
    const stateDir = makeDir('codesema-isolation-gitstate-')
    const git = prepareContainerGit({ worktree, workDir: '/work', stateDir })
    expect(git?.mountArgs).toEqual([
      '-v',
      `${join(repo, '.git')}:/gitcommon:ro`,
      '-v',
      `${join(stateDir, 'dotgit')}:/work/.git:ro`,
    ])
    expect(readFileSync(git?.pointerPath ?? '', 'utf8')).toBe('gitdir: /gitcommon/worktrees/wt\n')
  })

  test('the scratch dir is stable per worktree: no tmp growth across turns', () => {
    const worktree = '/repo/.codesema/worktrees/a1b2c3d4e5f6'
    expect(containerGitStateDir(worktree)).toBe(containerGitStateDir(worktree))
    expect(containerGitStateDir(worktree)).not.toBe(containerGitStateDir(`${worktree}-other`))
  })
})

describe('runtimeIsPodman', () => {
  test('a binary named podman is taken at its word, without spawning anything', async () => {
    const { calls, exec } = fakeExec()
    expect(await runtimeIsPodman('podman', exec)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  // The emulation shim: `docker --version` prints "podman version 5.7.0".
  test('a docker that is really podman is detected from its --version', async () => {
    const { exec } = fakeExec(() => ok({ stdout: 'podman version 5.7.0\n' }))
    expect(await runtimeIsPodman('docker', exec)).toBe(true)
  })

  test('a real docker stays docker', async () => {
    const { exec } = fakeExec(() => ok({ stdout: 'Docker version 27.3.1, build ce1223035a\n' }))
    expect(await runtimeIsPodman('docker', exec)).toBe(false)
  })

  test('a runtime that cannot answer is not assumed to be podman', async () => {
    const { exec } = fakeExec(() => ok({ code: 127, stderr: 'not found' }))
    expect(await runtimeIsPodman('docker', exec)).toBe(false)
  })
})

// --- one caged turn --------------------------------------------------------

describe('runContainerTurn', () => {
  const taskId = 'a1b2c3d4e5f6'

  function rig(over: { spawn?: (opts: ContainerSpawnOptions) => Promise<string> } = {}) {
    const { calls, exec } = fakeExec((call) =>
      call.args[1] === 'inspect' ? ok({ code: 1 }) : ok(),
    )
    const spawned: ContainerSpawnOptions[] = []
    const spawnFn = (opts: ContainerSpawnOptions): Promise<string> => {
      spawned.push(opts)
      return over.spawn ? over.spawn(opts) : Promise.resolve('{"type":"result"}')
    }
    return { calls, exec, spawned, spawnFn }
  }

  test('prepares the cage and runs the turn with the exact expected flags', async () => {
    const { exec, spawned, spawnFn } = rig()
    const worktree = makeDir()
    const out = await runContainerTurn({
      taskId,
      worktree,
      command: 'claude -p --dangerously-skip-permissions',
      prompt: 'do the thing',
      timeoutMs: 60_000,
      runtime: 'docker',
      claudeVersion: '2.1.233',
      execFn: exec,
      spawnFn,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    })
    expect(out).toBe('{"type":"result"}')
    const run = spawned[0]
    expect(run?.file).toBe('docker')
    expect(run?.input).toBe('do the thing')
    expect(run?.args.slice(0, 3)).toEqual(['run', '--rm', '-i'])
    expect(run?.args).toContain(`${worktree}:/work:rw`)
    expect(run?.args).toContain(agentContainerName(taskId))
    expect(run?.args).toContain(`${agentHomeVolume(taskId)}:/home/agent`)
    expect(run?.args).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(run?.args).not.toContain('--privileged')
    expect(run?.args.slice(-3)).toEqual(['sh', '-lc', 'claude -p --dangerously-skip-permissions'])
  })

  test('the cage turn is handed the watchdog budgets, its beat and the agent command', async () => {
    const { exec, spawned, spawnFn } = rig()
    const beats: AgentHeartbeat[] = []
    const budgets = { inactivityMs: 60_000, toolBudgetMs: 120_000, heartbeatMs: 5_000 }
    await runContainerTurn({
      taskId,
      worktree: makeDir(),
      command: 'claude -p --output-format stream-json',
      prompt: 'p',
      timeoutMs: 1000,
      watchdog: budgets,
      onHeartbeat: (beat) => beats.push(beat),
      runtime: 'docker',
      claudeVersion: '2.1.233',
      execFn: exec,
      spawnFn,
      env: {},
    })
    const run = spawned[0]
    expect(run?.watchdog).toEqual(budgets)
    expect(run?.onHeartbeat).toBeDefined()
    // The AGENT command, not the runtime argv: it is what says whether the
    // stdout coming back can be decoded into tool signals.
    expect(run?.command).toBe('claude -p --output-format stream-json')
  })

  test('a devcontainer in the worktree decides the base image of the cage', async () => {
    const { calls, exec, spawnFn } = rig()
    const worktree = makeDir()
    mkdirSync(join(worktree, '.devcontainer'), { recursive: true })
    writeFileSync(
      join(worktree, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ image: 'python:3.12-slim' }),
    )
    await runContainerTurn({
      taskId,
      worktree,
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 1000,
      runtime: 'docker',
      claudeVersion: '2.1.233',
      execFn: exec,
      spawnFn,
      env: {},
    })
    const build = argsOf(calls, 'build')[0] ?? []
    const dockerfile = build[build.indexOf('-f') + 1] ?? ''
    expect(readFileSync(dockerfile, 'utf8')).toContain('FROM python:3.12-slim')
  })

  // The reported bug: the agent answered "Git isn't available in the container"
  // because /work/.git pointed at a HOST path the box never saw.
  test('a task worktree gets its git: shared dir read-only, pointer over /work/.git', async () => {
    const { repo, worktree } = makeLinkedWorktree()
    cleanups.push(containerGitStateDir(worktree))
    const { exec, spawned, spawnFn } = rig()
    await runContainerTurn({
      taskId,
      worktree,
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 1000,
      runtime: 'docker',
      claudeVersion: '2.1.233',
      execFn: exec,
      spawnFn,
      env: {},
    })
    const args = spawned[0]?.args ?? []
    expect(args).toContain(`${join(repo, '.git')}:/gitcommon:ro`)
    const pointer = args.find((arg) => arg.endsWith(':/work/.git:ro'))
    expect(pointer).toBeDefined()
    expect(readFileSync((pointer ?? '').split(':')[0] ?? '', 'utf8')).toBe(
      'gitdir: /gitcommon/worktrees/wt\n',
    )
    expect(args).toContain('GIT_CONFIG_VALUE_0=/work')
  })

  test('no container runtime: the turn fails saying so, it never runs on the host', async () => {
    const { spawned, spawnFn } = rig()
    const noRuntime: IsolationExecFn = () => Promise.resolve(ok({ code: 127, failure: 'ENOENT' }))
    await expect(
      runContainerTurn({
        taskId,
        worktree: makeDir(),
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 1000,
        claudeVersion: '2.1.233',
        execFn: noRuntime,
        spawnFn,
        env: {},
      }),
    ).rejects.toThrow(/container runtime/)
    expect(spawned).toHaveLength(0)
  })

  test('interrupt and timeout kill the CONTAINER by name, not just the client', async () => {
    const { calls, exec, spawnFn } = rig({
      spawn: (opts) => {
        opts.onKill()
        return Promise.reject(new Error('interrupted'))
      },
    })
    await expect(
      runContainerTurn({
        taskId,
        worktree: makeDir(),
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 1000,
        runtime: 'podman',
        claudeVersion: '2.1.233',
        execFn: exec,
        spawnFn,
        env: {},
      }),
    ).rejects.toThrow('interrupted')
    expect(argsOf(calls, 'kill')[0]).toEqual(['kill', agentContainerName(taskId)])
  })

  test('a broken cage build fails the turn instead of degrading to the host', async () => {
    const { spawned, spawnFn } = rig()
    const failingBuild: IsolationExecFn = (_file, args) =>
      Promise.resolve(
        args[0] === 'build' ? ok({ code: 1, stderr: 'no space left on device' }) : ok({ code: 1 }),
      )
    await expect(
      runContainerTurn({
        taskId,
        worktree: makeDir(),
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 1000,
        runtime: 'docker',
        claudeVersion: '2.1.233',
        execFn: failingBuild,
        spawnFn,
        env: {},
      }),
    ).rejects.toThrow(/no space left on device/)
    expect(spawned).toHaveLength(0)
  })
})

// --- boot probe ------------------------------------------------------------

describe('probeIsolation', () => {
  test('a runtime whose engine answers makes the cage available', async () => {
    const { exec } = fakeExec()
    const probe = await probeIsolation({ configured: 'auto', command: 'claude -p', execFn: exec })
    expect(probe).toMatchObject({ available: true, mode: 'container', runtime: 'docker' })
    expect(probe.reason).toContain('docker')
  })

  test('no runtime at all: unavailable, with the reason a human can act on', async () => {
    const { exec } = fakeExec(() => ok({ code: 127, failure: 'ENOENT' }))
    const probe = await probeIsolation({ configured: 'auto', command: 'claude -p', execFn: exec })
    expect(probe.available).toBe(false)
    expect(probe.mode).toBe('policy')
    expect(probe.reason).toMatch(/docker or podman/)
  })

  test('an installed client whose engine is down is NOT a usable cage', async () => {
    const { exec } = fakeExec((call) => (call.args[0] === 'info' ? ok({ code: 1 }) : ok()))
    const probe = await probeIsolation({ configured: 'auto', command: 'claude -p', execFn: exec })
    expect(probe.available).toBe(false)
    expect(probe.runtime).toBe('docker')
    expect(probe.reason).toMatch(/does not answer/)
  })

  test('configured policy: no runtime is even probed', async () => {
    const { calls, exec } = fakeExec()
    const probe = await probeIsolation({ configured: 'policy', command: 'claude -p', execFn: exec })
    expect(probe.available).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('the cage only ships claude-code: another agent gets the honest reason', async () => {
    const { exec } = fakeExec()
    const probe = await probeIsolation({
      configured: 'auto',
      command: 'codex exec -',
      execFn: exec,
    })
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('codex')
  })
})

describe('resolveTaskIsolation', () => {
  const probe = (over: Partial<IsolationProbe>): IsolationProbe => ({
    available: true,
    mode: 'container',
    reason: 'docker is available',
    configured: 'auto',
    runtime: 'docker',
    ...over,
  })

  test('auto: the cage when it is there', () => {
    expect(resolveTaskIsolation(probe({}))?.isolation).toBe('container')
  })

  test('auto: policy otherwise, carrying the WHY to the journal', () => {
    const resolved = resolveTaskIsolation(
      probe({ available: false, mode: 'policy', reason: 'no container runtime found' }),
    )
    expect(resolved?.isolation).toBe('policy')
    expect(resolved?.reason).toBe('no container runtime found')
  })

  test('strict container without a cage: refused (null = 409 at the creation)', () => {
    expect(
      resolveTaskIsolation(probe({ configured: 'container', available: false, mode: 'policy' })),
    ).toBeNull()
  })

  test('strict container with a cage: container', () => {
    expect(resolveTaskIsolation(probe({ configured: 'container' }))?.isolation).toBe('container')
  })

  test('configured policy stays policy even if a runtime shows up', () => {
    expect(resolveTaskIsolation(probe({ configured: 'policy' }))?.isolation).toBe('policy')
  })
})

describe('names', () => {
  test('deterministic per task, so an interrupt can find the container', () => {
    expect(agentContainerName('a1b2c3d4e5f6')).toBe('codesema-task-a1b2c3d4e5f6')
    expect(agentHomeVolume('a1b2c3d4e5f6')).toBe('codesema-home-a1b2c3d4e5f6')
  })

  test('the forwarded environment is a closed list of provider variables', () => {
    for (const name of CAGE_FORWARDED_ENV) {
      expect(/^(CLAUDE|ANTHROPIC)_/.test(name)).toBe(true)
    }
  })
})

describe('the default allowlist', () => {
  test('covers exactly what the agent needs to authenticate and call the API', () => {
    // Claude Code's documented network requirements: API traffic on
    // api.anthropic.com, OAuth exchange/refresh on platform.claude.com.
    expect([...DEFAULT_ISOLATION_ALLOWED_DOMAINS]).toEqual([
      'api.anthropic.com',
      'platform.claude.com',
    ])
    const config = buildSquidConfig(DEFAULT_ISOLATION_ALLOWED_DOMAINS)
    expect(config).not.toContain('registry.npmjs.org')
    expect(config).not.toContain('github.com')
  })
})

// --- the caged turn is watched like the host one (T1.7) --------------------

describe('spawnContainer semantic watchdog', () => {
  const CAGED_COMMAND =
    'claude -p --dangerously-skip-permissions --output-format stream-json --include-partial-messages --verbose'

  const BUDGETS: WatchdogBudgets = {
    inactivityMs: 30 * 60_000,
    toolBudgetMs: 120 * 60_000,
    heartbeatMs: 30_000,
  }

  /** Virtual time: no test waits out a budget counted in hours. */
  function fakeClock(): AgentClock & { advance: (ms: number) => void } {
    let now = 1_000_000
    let nextId = 1
    const timers = new Map<number, { due: number; fn: () => void }>()
    return {
      now: () => now,
      setTimer(fn, ms) {
        const id = nextId++
        timers.set(id, { due: now + ms, fn })
        return () => timers.delete(id)
      },
      advance(ms) {
        const target = now + ms
        for (;;) {
          let pick: [number, { due: number; fn: () => void }] | null = null
          for (const entry of timers) {
            if (entry[1].due <= target && (pick === null || entry[1].due < pick[1].due)) {
              pick = entry
            }
          }
          if (pick === null) {
            break
          }
          timers.delete(pick[0])
          now = pick[1].due
          pick[1].fn()
        }
        now = target
      },
    }
  }

  type FakeClient = {
    child: ChildProcess
    ops: string[]
    stdout: (chunk: string) => void
    close: (code: number | null) => void
  }

  function fakeClient(ops: string[]): FakeClient {
    const stdoutListeners: ((d: Buffer) => void)[] = []
    const closeListeners: ((code: number | null) => void)[] = []
    let stdinEnded = false
    const child = {
      pid: 999,
      stdin: {
        on: () => child.stdin,
        write: () => true,
        end: () => {
          ops.push(stdinEnded ? 'stdin:end(noop)' : 'stdin:end')
          stdinEnded = true
        },
      },
      stdout: {
        on(event: string, listener: (d: Buffer) => void) {
          if (event === 'data') {
            stdoutListeners.push(listener)
          }
          return child.stdout
        },
        destroy: () => ops.push('stdout:destroy'),
      },
      on(event: string, listener: (arg: never) => void) {
        if (event === 'close') {
          closeListeners.push(listener as (code: number | null) => void)
        }
        return child
      },
      kill: (signal?: NodeJS.Signals) => {
        ops.push(`client.kill:${signal}`)
        return true
      },
    }
    return {
      child: child as unknown as ChildProcess,
      ops,
      stdout: (chunk) => {
        for (const listener of stdoutListeners) {
          listener(Buffer.from(chunk))
        }
      },
      close: (code) => {
        for (const listener of closeListeners) {
          listener(code)
        }
      },
    }
  }

  function startCagedRun(over: { command?: string; timeoutMs?: number } = {}) {
    const ops: string[] = []
    const client = fakeClient(ops)
    const clock = fakeClock()
    const beats: AgentHeartbeat[] = []
    const promise = spawnContainer({
      file: 'docker',
      args: ['run', '--rm', '-i'],
      command: over.command ?? CAGED_COMMAND,
      input: 'do the thing',
      timeoutMs: over.timeoutMs ?? 10 * 60 * 60_000,
      watchdog: BUDGETS,
      clock,
      onHeartbeat: (beat) => beats.push(beat),
      onKill: () => ops.push('container:kill'),
      spawnProcessFn: () => client.child,
    })
    return { ops, client, clock, beats, promise }
  }

  const frame = (event: unknown) => `${JSON.stringify(event)}\n`

  test('a mute caged agent is cut with inactivity_timeout', async () => {
    const rig = startCagedRun()
    rig.clock.advance(30 * 60_000)
    // The container is what holds the agent: it is killed by NAME first, and
    // the client's stdin (already closed at start) is the no-op first step.
    expect(rig.ops).toEqual(['stdin:end', 'stdin:end(noop)', 'container:kill'])
    rig.clock.advance(CONTAINER_KILL_GRACE_MS + AGENT_KILL_GRACE_MS)
    rig.client.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentWatchdogError)
    expect(agentReasonCode(err)).toBe('inactivity_timeout')
  })

  test('the escalation is ordered: stdin, the container, the client, then stdout', async () => {
    const rig = startCagedRun()
    rig.clock.advance(30 * 60_000)
    expect(rig.ops.slice(1)).toEqual(['stdin:end(noop)', 'container:kill'])
    // Bounded wait, then the client — never before the box, which would orphan it.
    rig.clock.advance(CONTAINER_KILL_GRACE_MS)
    expect(rig.ops.slice(1)).toEqual(['stdin:end(noop)', 'container:kill', 'client.kill:SIGTERM'])
    // Bounded wait, then SIGKILL, and stdout LAST so the agent's final words survive.
    rig.clock.advance(AGENT_KILL_GRACE_MS)
    expect(rig.ops.slice(1)).toEqual([
      'stdin:end(noop)',
      'container:kill',
      'client.kill:SIGTERM',
      'client.kill:SIGKILL',
      'stdout:destroy',
    ])
    rig.client.close(null)
    await expect(rig.promise).rejects.toBeInstanceOf(AgentWatchdogError)
  })

  test('a client that never closes still settles, with the watchdog cause', async () => {
    const rig = startCagedRun()
    rig.clock.advance(
      30 * 60_000 + CONTAINER_KILL_GRACE_MS + AGENT_KILL_GRACE_MS + AGENT_SETTLE_GRACE_MS,
    )
    const err = await rig.promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentWatchdogError)
  })

  test('a tool in flight inside the box suspends inactivity, its own budget cuts', async () => {
    const rig = startCagedRun()
    rig.client.stdout(
      frame({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] },
      }),
    )
    // 100 min inside one tool: far past inactivity, under the tool budget.
    rig.clock.advance(100 * 60_000)
    expect(rig.ops).not.toContain('container:kill')
    rig.clock.advance(
      25 * 60_000 + CONTAINER_KILL_GRACE_MS + AGENT_KILL_GRACE_MS + AGENT_SETTLE_GRACE_MS,
    )
    const err = await rig.promise.catch((e: unknown) => e)
    expect((err as AgentWatchdogError).watchdogCause).toBe('tool_budget')
  })

  test('a caged agent that keeps talking is never cut', async () => {
    const rig = startCagedRun()
    for (let i = 0; i < 8; i++) {
      rig.clock.advance(25 * 60_000)
      rig.client.stdout(frame({ type: 'stream_event', event: { type: 'ping' } }))
    }
    expect(rig.ops).not.toContain('container:kill')
    rig.client.close(0)
    await expect(rig.promise).resolves.toContain('stream_event')
  })

  test('the beat comes from the cage too, so a long caged task is not a dead one', async () => {
    const rig = startCagedRun()
    rig.clock.advance(90_000)
    expect(rig.beats).toHaveLength(3)
    expect(rig.beats[2]?.idleMs).toBe(90_000)
    rig.client.close(0)
    await expect(rig.promise).resolves.toBe('')
  })

  test('the absolute ceiling stays armed and distinct from a watchdog cut', async () => {
    const rig = startCagedRun({ timeoutMs: 10 * 60_000 })
    for (let i = 0; i < 2; i++) {
      rig.clock.advance(5 * 60_000)
      rig.client.stdout(frame({ type: 'stream_event', event: { type: 'ping' } }))
    }
    rig.clock.advance(CONTAINER_KILL_GRACE_MS + AGENT_KILL_GRACE_MS)
    rig.client.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(AgentWatchdogError)
    expect(agentReasonCode(err)).toBeNull()
    expect((err as Error).message).toMatch(/600s/)
  })

  test('an exit code and an interrupt stay their own rejections', async () => {
    const failing = startCagedRun()
    failing.client.close(3)
    const exitErr = await failing.promise.catch((e: unknown) => e)
    expect((exitErr as Error).message).toMatch(/3/)

    const controller = new AbortController()
    const ops: string[] = []
    const client = fakeClient(ops)
    const promise = spawnContainer({
      file: 'docker',
      args: ['run'],
      command: CAGED_COMMAND,
      input: 'p',
      timeoutMs: 60_000,
      clock: fakeClock(),
      signal: controller.signal,
      onKill: () => ops.push('container:kill'),
      spawnProcessFn: () => client.child,
    })
    controller.abort()
    expect(ops).toContain('container:kill')
    client.close(null)
    const err = await promise.catch((e: unknown) => e)
    expect(agentReasonCode(err)).toBeNull()
    expect((err as Error).message).toMatch(/interrupted|interrompu/)
  })
})

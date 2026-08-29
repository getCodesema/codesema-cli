/**
 * The guest-user and agent-CLI bootstrap shared by every microVM entry point
 * that runs the agent (dev turn: microvm-turn.ts; review: task-review.ts;
 * scan proposal: runbook-runner.ts's `runProposal`, which is a plain
 * `runMicrovmTurn` call and so gets this for free). Factored out because all
 * three used to duplicate (or, for the review, simply omit) the same two
 * steps: create the non-root guest user, make sure the agent binary is on
 * its PATH.
 */
import type { SandboxHandle } from './microsandbox-driver.js'
import { installCommandFor } from './task-isolation.js'

/**
 * The only domain a microVM ever needs to install the agent CLI: npm only,
 * never the native curl|bash installer's claude.ai/storage domains, which
 * a cold-boot allowlist has no way to pre-approve for a repository nobody
 * has scanned yet. Opened on top of the caller's own allowlist for the
 * duration of a cold boot only — a boot restored from a project snapshot
 * (agent already installed when the snapshot was built) never needs it.
 */
export const AGENT_INSTALL_DOMAINS: readonly string[] = ['registry.npmjs.org']

const BOOTSTRAP_TIMEOUT_MS = 60_000
const AGENT_INSTALL_TIMEOUT_MS = 5 * 60_000

/** Matches how `useradd` names a user; enforced before `user` is spliced unquoted into any shell script below. */
const GUEST_USER_PATTERN = /^[a-z_][a-z0-9_-]*$/

export function assertValidGuestUser(user: string): void {
  if (!GUEST_USER_PATTERN.test(user)) {
    throw new Error(`invalid guest user "${user}": must match ${GUEST_USER_PATTERN}`)
  }
}

function agentUserBootstrapScript(user: string): string {
  return [
    'set -e',
    `if ! id -u ${user} >/dev/null 2>&1; then`,
    `  useradd -m -s /bin/bash ${user}`,
    'fi',
  ].join('\n')
}

/** `useradd -m` the guest user if it does not already exist; idempotent, safe to re-run. */
export async function ensureGuestUser(handle: SandboxHandle, user: string): Promise<void> {
  assertValidGuestUser(user)
  await handle.shell(agentUserBootstrapScript(user), {
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    user: 'root',
  })
}

export type EnsureAgentInstalledOptions = {
  /**
   * true: a missing agent is installed (npm, root) — the boot is cold, the
   * caller already opened AGENT_INSTALL_DOMAINS for it. false: a missing
   * agent is a readable error instead — the boot restored a project
   * snapshot that was supposed to have it baked in already.
   */
  install: boolean
}

/**
 * Makes sure `agentId` is on the guest's PATH. A hot boot (`install: false`)
 * that finds it missing means the snapshot was built without the agent, or
 * for a different one — rebuild it rather than silently paying the npm
 * install cost with a possibly-closed network policy.
 */
export async function ensureAgentInstalled(
  handle: SandboxHandle,
  agentId: string,
  opts: EnsureAgentInstalledOptions,
): Promise<void> {
  const probe = await handle.shell(`command -v ${agentId}`, {
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    user: 'root',
  })
  if (probe.code === 0) {
    return
  }
  if (!opts.install) {
    throw new Error(
      `${agentId} is not installed in this microVM (snapshot without the agent, rebuild it)`,
    )
  }
  const result = await handle.shell(installCommandFor(agentId, undefined, { prefer: 'npm' }), {
    timeoutMs: AGENT_INSTALL_TIMEOUT_MS,
    user: 'root',
  })
  if (result.code !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-2000)
    throw new Error(`could not install ${agentId} in the microVM: ${tail}`)
  }
}

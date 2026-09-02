/**
 * The background service launcher shared by the runbook scan
 * (runbook-runner.ts) and the mechanical verification (task-verification.ts):
 * a `nohup ... &` script so `services.host_up` commands never block the
 * caller's shell call the way a foreground `handle.shell` would for a
 * long-running server.
 */

/** Wall-clock budget for launching one background service (the launcher itself, not the service). */
export const SERVICE_LAUNCH_TIMEOUT_MS = 15_000

/** Single-quotes a value for `sh -c '...'`, escaping any embedded single quote. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The `nohup sh -c '<command>' > /tmp/codesema-service-<index>.log 2>&1 &` script for one `services.host_up` entry. */
export function serviceLaunchScript(command: string, index: number): string {
  return `nohup sh -c ${shellSingleQuote(command)} > /tmp/codesema-service-${index}.log 2>&1 &`
}

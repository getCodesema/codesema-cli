import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { t } from './i18n.js'
import { confirm, isInteractive } from './tui.js'
import { AMBER, GREEN, dim, paint } from './ui.js'
import { VERSION, isNewerVersion, startUpdateCheck } from './version.js'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** Guesses the global package manager from where the CLI is installed. */
export function detectPackageManager(installedPath: string): PackageManager {
  const segments = installedPath.split(/[\\/]/)
  if (segments.includes('.bun')) return 'bun'
  if (segments.includes('pnpm')) return 'pnpm'
  if (segments.includes('yarn')) return 'yarn'
  return 'npm'
}

export function upgradeCommand(pm: PackageManager, version: string): { cmd: string; args: string[] } {
  const pkg = `codesema@${version}`
  switch (pm) {
    case 'bun':
      return { cmd: 'bun', args: ['add', '-g', pkg] }
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-g', pkg] }
    case 'yarn':
      return { cmd: 'yarn', args: ['global', 'add', pkg] }
    case 'npm':
      return { cmd: 'npm', args: ['install', '-g', pkg] }
  }
}

function runUpgrade(latest: string): void {
  const pm = detectPackageManager(fileURLToPath(import.meta.url))
  const { cmd, args } = upgradeCommand(pm, latest)
  const command = `${cmd} ${args.join(' ')}`
  console.log('')
  console.log(`  ${t('upgrade.running', { command })}`)
  console.log('')
  // On Windows the package managers are .cmd shims, unreachable without a shell;
  // args are shell-safe there because the version is validated by startUpdateCheck.
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  console.log('')
  if (result.status === 0) {
    console.log(`  ${paint('✔', GREEN)} ${t('upgrade.done', { latest })}`)
  } else {
    console.log(`  ${t('upgrade.failed', { command })}`)
  }
}

/**
 * Startup update check: when a newer version is published, asks (yes/no)
 * whether to upgrade now and runs the package manager on acceptance.
 * Best effort and interactive-only; the current invocation continues either way.
 */
export async function maybeOfferUpgrade(): Promise<void> {
  if (!isInteractive()) return
  const latest = await startUpdateCheck()
  if (!latest || !isNewerVersion(VERSION, latest)) return
  console.log('')
  console.log(`  ${paint(t('upgrade.available', { latest }), AMBER)} ${dim(`(v${VERSION})`)}`)
  const accepted = await confirm({ title: t('upgrade.question') })
  if (accepted) runUpgrade(latest)
  console.log('')
}

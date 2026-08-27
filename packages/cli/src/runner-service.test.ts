import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { t } from './i18n.js'
import {
  installRunnerService,
  renderRunnerServiceUnit,
  systemdUnitPath,
  uninstallRunnerService,
  type ExecCommandFn,
} from './runner-service.js'

type Call = { command: string; args: readonly string[] }

function recordingExecFn(calls: Call[]): ExecCommandFn {
  return (command, args) => {
    calls.push({ command, args })
    return ''
  }
}

function throwingOn(command: string, calls: Call[]): ExecCommandFn {
  return (cmd, args) => {
    calls.push({ command: cmd, args })
    if (cmd === command) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
    }
    return ''
  }
}

describe('renderRunnerServiceUnit', () => {
  test('pins the three per-install directives and keeps the static ones from the shipped template', () => {
    const unit = renderRunnerServiceUnit({
      workingDirectory: '/home/codesema/bench',
      execStart: '/usr/lib/node_modules/codesema/dist/index.mjs runner serve',
      environmentFile: null,
    })
    expect(unit).toContain('[Unit]')
    expect(unit).toContain('[Service]')
    expect(unit).toContain('[Install]')
    expect(unit).toContain('WorkingDirectory=/home/codesema/bench')
    expect(unit).toContain('ExecStart=/usr/lib/node_modules/codesema/dist/index.mjs runner serve')
    expect(unit).not.toContain('EnvironmentFile=')
    expect(unit).toContain('Description=codesema runner daemon')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('RestartSec=5')
    expect(unit).toContain('WantedBy=default.target')
  })

  test('includes EnvironmentFile= only when given', () => {
    const unit = renderRunnerServiceUnit({
      workingDirectory: '/repo',
      execStart: '/bin/codesema runner serve',
      environmentFile: '/etc/codesema/runner.env',
    })
    expect(unit).toContain('EnvironmentFile=/etc/codesema/runner.env')
  })
})

describe('installRunnerService / uninstallRunnerService', () => {
  const previousXdg = process.env.XDG_CONFIG_HOME
  let xdgConfigHome: string
  let cwd: string

  beforeEach(() => {
    xdgConfigHome = mkdtempSync(join(tmpdir(), 'codesema-runnersvc-xdg-'))
    cwd = mkdtempSync(join(tmpdir(), 'codesema-runnersvc-cwd-'))
    process.env.XDG_CONFIG_HOME = xdgConfigHome
  })

  afterEach(() => {
    rmSync(xdgConfigHome, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg
    }
  })

  test('systemdUnitPath honors XDG_CONFIG_HOME', () => {
    expect(systemdUnitPath()).toBe(
      join(xdgConfigHome, 'systemd', 'user', 'codesema-runner.service'),
    )
  })

  test('writes the unit, reloads, enables --now, then enables lingering, in that order', () => {
    const calls: Call[] = []
    const result = installRunnerService({
      workingDirectory: '/repo',
      cwd,
      execFn: recordingExecFn(calls),
    })

    expect(existsSync(result.unitPath)).toBe(true)
    expect(result.workingDirectory).toBe('/repo')
    expect(result.execStart).toBe(`${realpathSync(process.argv[1] as string)} runner serve`)
    expect(result.environmentFile).toBeNull()
    expect(result.lingerError).toBeNull()

    expect(calls).toEqual([
      { command: 'systemctl', args: ['--version'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'codesema-runner.service'] },
      { command: 'loginctl', args: ['enable-linger'] },
    ])
  })

  test('resolves a relative --env-file against the given cwd, not process.cwd()', () => {
    writeFileSync(join(cwd, 'runner.env'), 'GH_TOKEN=x\n')
    const result = installRunnerService({
      workingDirectory: '/repo',
      cwd,
      envFile: 'runner.env',
      execFn: recordingExecFn([]),
    })
    expect(result.environmentFile).toBe(join(cwd, 'runner.env'))
    const written = readFileSync(result.unitPath, 'utf8')
    expect(written).toContain(`EnvironmentFile=${join(cwd, 'runner.env')}`)
  })

  test('an absolute --env-file is used as-is', () => {
    const envFile = join(xdgConfigHome, 'runner.env')
    writeFileSync(envFile, 'GH_TOKEN=x\n')
    const result = installRunnerService({
      workingDirectory: '/repo',
      cwd,
      envFile,
      execFn: recordingExecFn([]),
    })
    expect(result.environmentFile).toBe(envFile)
  })

  test('a missing --env-file throws and writes nothing', () => {
    expect(() =>
      installRunnerService({
        workingDirectory: '/repo',
        cwd,
        envFile: 'does-not-exist.env',
        execFn: recordingExecFn([]),
      }),
    ).toThrow()
    expect(existsSync(systemdUnitPath())).toBe(false)
  })

  test('no systemctl on the machine: throws a clear error and writes nothing', () => {
    const calls: Call[] = []
    expect(() =>
      installRunnerService({
        workingDirectory: '/repo',
        cwd,
        execFn: throwingOn('systemctl', calls),
      }),
    ).toThrow(t('runner.systemctlNotFound'))
    expect(existsSync(systemdUnitPath())).toBe(false)
    expect(calls).toEqual([{ command: 'systemctl', args: ['--version'] }])
  })

  test('a failing loginctl is reported but does not fail the install (unit still enabled)', () => {
    const calls: Call[] = []
    const execFn: ExecCommandFn = (command, args) => {
      calls.push({ command, args })
      if (command === 'loginctl') {
        throw new Error('Failed to connect to bus: No such file or directory')
      }
      return ''
    }
    const result = installRunnerService({ workingDirectory: '/repo', cwd, execFn })
    expect(result.lingerError).toBe('Failed to connect to bus: No such file or directory')
    expect(existsSync(result.unitPath)).toBe(true)
    expect(calls.some((c) => c.command === 'systemctl' && c.args.includes('enable'))).toBe(true)
  })

  test('uninstall with no unit installed: idempotent no-op, no exec calls', () => {
    const calls: Call[] = []
    const result = uninstallRunnerService({ execFn: recordingExecFn(calls) })
    expect(result).toEqual({ removed: false, unitPath: systemdUnitPath() })
    expect(calls).toEqual([])
  })

  test('uninstall removes an installed unit: disable --now, delete the file, then daemon-reload', () => {
    installRunnerService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn([]) })
    const calls: Call[] = []
    const result = uninstallRunnerService({ execFn: recordingExecFn(calls) })

    expect(result.removed).toBe(true)
    expect(existsSync(result.unitPath)).toBe(false)
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--version'] },
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'codesema-runner.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
  })

  test('uninstall of an existing unit with no systemctl: throws and leaves the unit file in place', () => {
    installRunnerService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn([]) })
    const calls: Call[] = []
    expect(() => uninstallRunnerService({ execFn: throwingOn('systemctl', calls) })).toThrow(
      t('runner.systemctlNotFound'),
    )
    expect(existsSync(systemdUnitPath())).toBe(true)
  })
})

describe('directory creation', () => {
  const previousXdg = process.env.XDG_CONFIG_HOME
  let xdgConfigHome: string
  let cwd: string

  beforeEach(() => {
    xdgConfigHome = mkdtempSync(join(tmpdir(), 'codesema-runnersvc-mkdir-'))
    cwd = mkdtempSync(join(tmpdir(), 'codesema-runnersvc-mkdir-cwd-'))
    process.env.XDG_CONFIG_HOME = xdgConfigHome
  })

  afterEach(() => {
    rmSync(xdgConfigHome, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg
    }
  })

  test('creates ~/.config/systemd/user when it does not exist yet', () => {
    expect(existsSync(join(xdgConfigHome, 'systemd'))).toBe(false)
    installRunnerService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn([]) })
    expect(existsSync(systemdUnitPath())).toBe(true)
  })

  test('overwrites a unit that already exists (re-running install-service after an upgrade)', () => {
    mkdirSync(join(xdgConfigHome, 'systemd', 'user'), { recursive: true })
    writeFileSync(systemdUnitPath(), 'stale content')
    installRunnerService({ workingDirectory: '/new-repo', cwd, execFn: recordingExecFn([]) })
    const written = readFileSync(systemdUnitPath(), 'utf8')
    expect(written).toContain('WorkingDirectory=/new-repo')
    expect(written).not.toContain('stale content')
  })
})

describe('legacy codesema-brain.service purge', () => {
  const previousXdg = process.env.XDG_CONFIG_HOME
  let xdgConfigHome: string
  let cwd: string

  function legacyUnitPath(): string {
    return join(xdgConfigHome, 'systemd', 'user', 'codesema-brain.service')
  }

  beforeEach(() => {
    xdgConfigHome = mkdtempSync(join(tmpdir(), 'codesema-runnersvc-legacy-xdg-'))
    cwd = mkdtempSync(join(tmpdir(), 'codesema-runnersvc-legacy-cwd-'))
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    mkdirSync(join(xdgConfigHome, 'systemd', 'user'), { recursive: true })
  })

  afterEach(() => {
    rmSync(xdgConfigHome, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    if (previousXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg
    }
  })

  test('install disables and removes a pre-existing legacy unit before writing the new one', () => {
    writeFileSync(legacyUnitPath(), 'stale legacy unit')
    const calls: Call[] = []
    const result = installRunnerService({
      workingDirectory: '/repo',
      cwd,
      execFn: recordingExecFn(calls),
    })

    expect(existsSync(legacyUnitPath())).toBe(false)
    expect(existsSync(result.unitPath)).toBe(true)
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--version'] },
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'codesema-brain.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'codesema-runner.service'] },
      { command: 'loginctl', args: ['enable-linger'] },
    ])
  })

  test('install with no legacy unit present never mentions codesema-brain.service', () => {
    const calls: Call[] = []
    installRunnerService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn(calls) })
    expect(calls.some((c) => c.args.includes('codesema-brain.service'))).toBe(false)
  })

  test('a legacy unit whose own disable fails is still removed, install still succeeds', () => {
    writeFileSync(legacyUnitPath(), 'stale legacy unit')
    const execFn: ExecCommandFn = (command, args) => {
      if (command === 'systemctl' && args.includes('codesema-brain.service')) {
        throw new Error('unit not loaded')
      }
      return ''
    }
    const result = installRunnerService({ workingDirectory: '/repo', cwd, execFn })
    expect(existsSync(legacyUnitPath())).toBe(false)
    expect(existsSync(result.unitPath)).toBe(true)
  })

  test('uninstall purges both the current and the legacy unit in one call', () => {
    installRunnerService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn([]) })
    writeFileSync(legacyUnitPath(), 'stale legacy unit')
    const calls: Call[] = []
    const result = uninstallRunnerService({ execFn: recordingExecFn(calls) })

    expect(result.removed).toBe(true)
    expect(existsSync(systemdUnitPath())).toBe(false)
    expect(existsSync(legacyUnitPath())).toBe(false)
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--version'] },
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'codesema-runner.service'] },
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'codesema-brain.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
  })

  test('uninstall removes a lone legacy unit even when the current one was never installed', () => {
    writeFileSync(legacyUnitPath(), 'stale legacy unit')
    const result = uninstallRunnerService({ execFn: recordingExecFn([]) })
    expect(result.removed).toBe(true)
    expect(existsSync(legacyUnitPath())).toBe(false)
  })
})

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
import {
  installBrainService,
  renderBrainServiceUnit,
  systemdUnitPath,
  uninstallBrainService,
  type ExecCommandFn,
} from './brain-service.js'
import { t } from './i18n.js'

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

describe('renderBrainServiceUnit', () => {
  test('pins the three per-install directives and keeps the static ones from the shipped template', () => {
    const unit = renderBrainServiceUnit({
      workingDirectory: '/home/codesema/bench',
      execStart: '/usr/lib/node_modules/codesema/dist/index.mjs brain serve',
      environmentFile: null,
    })
    expect(unit).toContain('[Unit]')
    expect(unit).toContain('[Service]')
    expect(unit).toContain('[Install]')
    expect(unit).toContain('WorkingDirectory=/home/codesema/bench')
    expect(unit).toContain('ExecStart=/usr/lib/node_modules/codesema/dist/index.mjs brain serve')
    expect(unit).not.toContain('EnvironmentFile=')
    expect(unit).toContain('Description=codesema brain daemon')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('RestartSec=5')
    expect(unit).toContain('WantedBy=default.target')
  })

  test('includes EnvironmentFile= only when given', () => {
    const unit = renderBrainServiceUnit({
      workingDirectory: '/repo',
      execStart: '/bin/codesema brain serve',
      environmentFile: '/etc/codesema/brain.env',
    })
    expect(unit).toContain('EnvironmentFile=/etc/codesema/brain.env')
  })
})

describe('installBrainService / uninstallBrainService', () => {
  const previousXdg = process.env.XDG_CONFIG_HOME
  let xdgConfigHome: string
  let cwd: string

  beforeEach(() => {
    xdgConfigHome = mkdtempSync(join(tmpdir(), 'codesema-brainsvc-xdg-'))
    cwd = mkdtempSync(join(tmpdir(), 'codesema-brainsvc-cwd-'))
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
    expect(systemdUnitPath()).toBe(join(xdgConfigHome, 'systemd', 'user', 'codesema-brain.service'))
  })

  test('writes the unit, reloads, enables --now, then enables lingering, in that order', () => {
    const calls: Call[] = []
    const result = installBrainService({
      workingDirectory: '/repo',
      cwd,
      execFn: recordingExecFn(calls),
    })

    expect(existsSync(result.unitPath)).toBe(true)
    expect(result.workingDirectory).toBe('/repo')
    expect(result.execStart).toBe(`${realpathSync(process.argv[1] as string)} brain serve`)
    expect(result.environmentFile).toBeNull()
    expect(result.lingerError).toBeNull()

    expect(calls).toEqual([
      { command: 'systemctl', args: ['--version'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'codesema-brain.service'] },
      { command: 'loginctl', args: ['enable-linger'] },
    ])
  })

  test('resolves a relative --env-file against the given cwd, not process.cwd()', () => {
    writeFileSync(join(cwd, 'brain.env'), 'GH_TOKEN=x\n')
    const result = installBrainService({
      workingDirectory: '/repo',
      cwd,
      envFile: 'brain.env',
      execFn: recordingExecFn([]),
    })
    expect(result.environmentFile).toBe(join(cwd, 'brain.env'))
    const written = readFileSync(result.unitPath, 'utf8')
    expect(written).toContain(`EnvironmentFile=${join(cwd, 'brain.env')}`)
  })

  test('an absolute --env-file is used as-is', () => {
    const envFile = join(xdgConfigHome, 'brain.env')
    writeFileSync(envFile, 'GH_TOKEN=x\n')
    const result = installBrainService({
      workingDirectory: '/repo',
      cwd,
      envFile,
      execFn: recordingExecFn([]),
    })
    expect(result.environmentFile).toBe(envFile)
  })

  test('a missing --env-file throws and writes nothing', () => {
    expect(() =>
      installBrainService({
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
      installBrainService({
        workingDirectory: '/repo',
        cwd,
        execFn: throwingOn('systemctl', calls),
      }),
    ).toThrow(t('brain.systemctlNotFound'))
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
    const result = installBrainService({ workingDirectory: '/repo', cwd, execFn })
    expect(result.lingerError).toBe('Failed to connect to bus: No such file or directory')
    expect(existsSync(result.unitPath)).toBe(true)
    expect(calls.some((c) => c.command === 'systemctl' && c.args.includes('enable'))).toBe(true)
  })

  test('uninstall with no unit installed: idempotent no-op, no exec calls', () => {
    const calls: Call[] = []
    const result = uninstallBrainService({ execFn: recordingExecFn(calls) })
    expect(result).toEqual({ removed: false, unitPath: systemdUnitPath() })
    expect(calls).toEqual([])
  })

  test('uninstall removes an installed unit: disable --now, delete the file, then daemon-reload', () => {
    installBrainService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn([]) })
    const calls: Call[] = []
    const result = uninstallBrainService({ execFn: recordingExecFn(calls) })

    expect(result.removed).toBe(true)
    expect(existsSync(result.unitPath)).toBe(false)
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--version'] },
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'codesema-brain.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
  })

  test('uninstall of an existing unit with no systemctl: throws and leaves the unit file in place', () => {
    installBrainService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn([]) })
    const calls: Call[] = []
    expect(() => uninstallBrainService({ execFn: throwingOn('systemctl', calls) })).toThrow(
      t('brain.systemctlNotFound'),
    )
    expect(existsSync(systemdUnitPath())).toBe(true)
  })
})

describe('directory creation', () => {
  const previousXdg = process.env.XDG_CONFIG_HOME
  let xdgConfigHome: string
  let cwd: string

  beforeEach(() => {
    xdgConfigHome = mkdtempSync(join(tmpdir(), 'codesema-brainsvc-mkdir-'))
    cwd = mkdtempSync(join(tmpdir(), 'codesema-brainsvc-mkdir-cwd-'))
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
    installBrainService({ workingDirectory: '/repo', cwd, execFn: recordingExecFn([]) })
    expect(existsSync(systemdUnitPath())).toBe(true)
  })

  test('overwrites a unit that already exists (re-running install-service after an upgrade)', () => {
    mkdirSync(join(xdgConfigHome, 'systemd', 'user'), { recursive: true })
    writeFileSync(systemdUnitPath(), 'stale content')
    installBrainService({ workingDirectory: '/new-repo', cwd, execFn: recordingExecFn([]) })
    const written = readFileSync(systemdUnitPath(), 'utf8')
    expect(written).toContain('WorkingDirectory=/new-repo')
    expect(written).not.toContain('stale content')
  })
})

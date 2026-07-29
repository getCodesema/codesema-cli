import { describe, expect, test } from 'bun:test'
import { detectPackageManager, upgradeCommand } from './upgrade.js'

describe('detectPackageManager', () => {
  test('detects bun from a global bun install path', () => {
    expect(detectPackageManager('/home/u/.bun/install/global/node_modules/codesema/dist/index.mjs')).toBe('bun')
  })

  test('detects pnpm from a global pnpm install path', () => {
    expect(
      detectPackageManager('/home/u/.local/share/pnpm/global/5/node_modules/codesema/dist/index.mjs'),
    ).toBe('pnpm')
  })

  test('detects yarn from a global yarn install path', () => {
    expect(detectPackageManager('/home/u/.config/yarn/global/node_modules/codesema/dist/index.mjs')).toBe('yarn')
  })

  test('defaults to npm', () => {
    expect(detectPackageManager('/usr/local/lib/node_modules/codesema/dist/index.mjs')).toBe('npm')
    expect(detectPackageManager('/somewhere/else/index.mjs')).toBe('npm')
  })

  test('matches whole path segments, not substrings', () => {
    expect(detectPackageManager('/home/u/pnpm-tools/lib/node_modules/codesema/dist/index.mjs')).toBe('npm')
    expect(detectPackageManager('/home/yarnell/lib/node_modules/codesema/dist/index.mjs')).toBe('npm')
    expect(detectPackageManager('/home/u/.bunker/node_modules/codesema/dist/index.mjs')).toBe('npm')
  })

  test('detects from windows-style paths', () => {
    expect(
      detectPackageManager('C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\codesema\\dist\\index.mjs'),
    ).toBe('pnpm')
  })
})

describe('upgradeCommand', () => {
  test('builds the install command per package manager', () => {
    expect(upgradeCommand('npm', '0.9.0')).toEqual({ cmd: 'npm', args: ['install', '-g', 'codesema@0.9.0'] })
    expect(upgradeCommand('pnpm', '0.9.0')).toEqual({ cmd: 'pnpm', args: ['add', '-g', 'codesema@0.9.0'] })
    expect(upgradeCommand('bun', '0.9.0')).toEqual({ cmd: 'bun', args: ['add', '-g', 'codesema@0.9.0'] })
    expect(upgradeCommand('yarn', '0.9.0')).toEqual({ cmd: 'yarn', args: ['global', 'add', 'codesema@0.9.0'] })
  })
})

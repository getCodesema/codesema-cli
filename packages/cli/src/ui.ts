import { t } from './i18n.js'
import type { PartialReview } from './partial.js'
import { VERSION } from './version.js'

export const OCEAN = [24, 30, 36, 37, 43, 44, 50] as const

export const ACCENT = OCEAN[4]
export const GREEN = 42
export const RED = 203
export const AMBER = 214
export const GRAY = 245

export function isFancy(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
}

export function paint(text: string, color: number): string {
  return isFancy() ? `\x1b[38;5;${color}m${text}\x1b[0m` : text
}

export function dim(text: string): string {
  return isFancy() ? `\x1b[2m${text}\x1b[0m` : text
}

export function bold(text: string): string {
  return isFancy() ? `\x1b[1m${text}\x1b[0m` : text
}

export function underline(text: string): string {
  return isFancy() ? `\x1b[4m${text}\x1b[0m` : text
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, '').length
}

export type FieldRow = { label: string; value: string }

/**
 * Renders a bkctl-style aligned field block: labels padded to the widest
 * label IN THIS BLOCK, painted in ACCENT, prefixed with two spaces. Width is
 * computed on the raw label text so alignment stays correct whether or not
 * ANSI color codes are active.
 */
export function renderFieldRows(rows: FieldRow[]): string[] {
  const maxLen = rows.reduce((max, row) => Math.max(max, visibleLength(row.label)), 0)
  return rows.map((row) => {
    const padded = row.label + ' '.repeat(maxLen + 3 - visibleLength(row.label))
    return `  ${paint(padded, ACCENT)}${row.value}`
  })
}

// ANSI Shadow wordmark, 68 columns: regenerate if the product is renamed.
const BANNER = [
  ' ██████╗ ██████╗ ██████╗ ███████╗███████╗███████╗███╗   ███╗ █████╗ ',
  '██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔════╝████╗ ████║██╔══██╗',
  '██║     ██║   ██║██║  ██║█████╗  ███████╗█████╗  ██╔████╔██║███████║',
  '██║     ██║   ██║██║  ██║██╔══╝  ╚════██║██╔══╝  ██║╚██╔╝██║██╔══██║',
  '╚██████╗╚██████╔╝██████╔╝███████╗███████║███████╗██║ ╚═╝ ██║██║  ██║',
  ' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝',
]

export function printBanner(): void {
  if (!isFancy()) return
  console.log('')
  if ((process.stdout.columns ?? 80) < BANNER[0]!.length + 4) {
    console.log(`  ${paint('◆', ACCENT)} ${bold('codesema')} ${dim(`v${VERSION}`)}`)
    console.log('')
    return
  }
  BANNER.forEach((line, i) => {
    const version = i === BANNER.length - 1 ? ` ${dim(`v${VERSION}`)}` : ''
    console.log('  ' + paint(line, OCEAN[Math.min(1 + i, OCEAN.length - 1)]!) + version)
  })
  console.log('')
}

const WAVE_CHARS = '▁▂▃▄▅▆▇█'
const WAVE_WIDTH = 22

const PHASE_KEYS = [
  'ui.phaseReading',
  'ui.phaseCalls',
  'ui.phaseGrouping',
  'ui.phaseRisks',
  'ui.phaseStory',
  'ui.phasePraise',
  'ui.phaseSharpening',
] as const

const STATUS_MAX = 56

function truncateStatus(text: string): string {
  return text.length > STATUS_MAX ? `${text.slice(0, STATUS_MAX - 1)}…` : text
}

export function progressLabel(partial: PartialReview): string | null {
  if (partial.stepTitles.length > 0) {
    const current = partial.stepTitles[partial.stepTitles.length - 1]!
    return truncateStatus(t('ui.progressStep', { n: partial.stepTitles.length, title: current }))
  }
  if (partial.findings.length > 0) {
    return t('ui.progressFindings', { n: partial.findings.length })
  }
  if (partial.verdict) return t('ui.progressVerdict', { verdict: partial.verdict })
  return null
}

function elapsed(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000)
  const mm = String(Math.floor(secs / 60)).padStart(2, '0')
  const ss = String(secs % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export type Spinner = {
  stop: (finalLine: string) => void
  update: (status: string) => void
}

export function startSpinner(label: string): Spinner {
  if (!isFancy()) {
    console.log(label)
    return {
      stop(finalLine) {
        console.log(finalLine)
      },
      update() {},
    }
  }

  const startedAt = Date.now()
  let tick = 0
  let liveStatus: string | null = null
  const showCursor = () => process.stdout.write('\x1b[?25h')
  const onSigint = () => {
    showCursor()
    process.stdout.write('\n')
    process.exit(130)
  }
  process.once('SIGINT', onSigint)
  process.stdout.write('\x1b[?25l')

  const render = () => {
    tick++
    let wave = ''
    for (let i = 0; i < WAVE_WIDTH; i++) {
      const level = (Math.sin(i * 0.55 - tick * 0.18) + 1) / 2
      const h = Math.round(level * (WAVE_CHARS.length - 1))
      const color = OCEAN[Math.min(Math.round(level * (OCEAN.length - 1)), OCEAN.length - 1)]!
      wave += paint(WAVE_CHARS[h]!, color)
    }
    const secs = Math.floor((Date.now() - startedAt) / 1000)
    const status = liveStatus ?? t(PHASE_KEYS[Math.floor(secs / 7) % PHASE_KEYS.length]!)
    process.stdout.write(`\r\x1b[2K  ${wave}  ${label} ${dim(`${elapsed(startedAt)} · ${status}`)}`)
  }

  render()
  const timer = setInterval(render, 90)

  return {
    stop(finalLine) {
      clearInterval(timer)
      process.removeListener('SIGINT', onSigint)
      process.stdout.write('\r\x1b[2K')
      showCursor()
      console.log(`${finalLine} ${dim(`(${elapsed(startedAt)})`)}`)
    },
    update(status) {
      liveStatus = status
    },
  }
}

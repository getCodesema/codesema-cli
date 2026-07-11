export const EMBER = [124, 160, 196, 202, 208, 214, 220] as const

export function paint(text: string, color: number): string {
  return `\x1b[38;5;${color}m${text}\x1b[0m`
}

export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`
}

export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`
}

export function isFancy(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
}

// Compact wordmark (Calvin S style): regenerate if the product is renamed.
const BANNER = [
  '┌─┐┌─┐┌┬┐┌─┐┌─┐┌─┐┌┬┐┌─┐',
  '│  │ │ ││├┤ └─┐├┤ │││├─┤',
  '└─┘└─┘─┴┘└─┘└─┘└─┘┴ ┴┴ ┴',
]

export function printBanner(): void {
  if (!isFancy()) return
  console.log('')
  BANNER.forEach((line, i) => {
    console.log('  ' + paint(line, EMBER[Math.min(2 + i * 2, EMBER.length - 1)]!))
  })
  console.log('')
}

const WAVE_CHARS = '▁▂▃▄▅▆▇█'
const WAVE_WIDTH = 22

const PHASES = [
  'reading the diff…',
  'following the call chains…',
  'grouping changes into chapters…',
  'weighing the risks…',
  'writing the story…',
  'collecting praise…',
  'sharpening the findings…',
]

function elapsed(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000)
  const mm = String(Math.floor(secs / 60)).padStart(2, '0')
  const ss = String(secs % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export type Spinner = { stop: (finalLine: string) => void }

export function startSpinner(label: string): Spinner {
  if (!isFancy()) {
    console.log(label)
    return {
      stop(finalLine) {
        console.log(finalLine)
      },
    }
  }

  const startedAt = Date.now()
  let tick = 0
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
      const color = EMBER[Math.min(Math.round(level * (EMBER.length - 1)), EMBER.length - 1)]!
      wave += paint(WAVE_CHARS[h]!, color)
    }
    const secs = Math.floor((Date.now() - startedAt) / 1000)
    const phase = PHASES[Math.floor(secs / 7) % PHASES.length]!
    process.stdout.write(`\r\x1b[2K  ${wave}  ${label} ${dim(`${elapsed(startedAt)} · ${phase}`)}`)
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
  }
}

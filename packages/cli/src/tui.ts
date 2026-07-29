import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { t } from './i18n.js'
import { ACCENT, dim, isFancy, paint } from './ui.js'

export type SelectOption<T> = {
  label: string
  value: T
  hint?: string
  /** Render a blank line above this option (visually detaches back/quit entries). */
  separatorBefore?: boolean
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

const MAX_VISIBLE = 10

type KeypressEvent = {
  name?: string
  ctrl?: boolean
  sequence?: string
}

function color(text: string, code: number): string {
  return isFancy() ? paint(text, code) : text
}

function faint(text: string): string {
  return isFancy() ? dim(text) : text
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

export async function select<T>(opts: {
  title: string
  options: SelectOption<T>[]
  initialIndex?: number
  filter?: boolean
  /** false = erase the prompt entirely on resolve, leaving no trace (stable in-place menus). */
  summary?: boolean
}): Promise<T | null> {
  if (!isInteractive() || opts.options.length === 0) return null

  const { stdin, stdout } = process
  emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write('\x1b[?25l')

  let query = ''
  let cursor = Math.min(Math.max(opts.initialIndex ?? 0, 0), opts.options.length - 1)
  let renderedLines = 0

  const width = () => Math.max(40, stdout.columns || 80)

  const filtered = (): SelectOption<T>[] => {
    if (!query) return opts.options
    const q = query.toLowerCase()
    return opts.options.filter((o) => o.label.toLowerCase().includes(q))
  }

  const clearRendered = () => {
    if (renderedLines > 0) stdout.write(`\x1b[${renderedLines}A`)
    stdout.write('\x1b[0J')
  }

  const render = () => {
    const list = filtered()
    if (cursor >= list.length) cursor = Math.max(0, list.length - 1)

    const lines: string[] = []
    const filterPart = opts.filter
      ? query
        ? `  ${color('/', ACCENT)}${query}`
        : `  ${faint(t('tui.typeToFilter'))}`
      : ''
    lines.push(`  ${color('?', ACCENT)} ${opts.title}${filterPart}`)
    // The question stands out: a blank line below it, answers indented deeper.
    lines.push('')

    if (list.length === 0) {
      lines.push(`        ${faint(t('tui.noMatch'))}`)
    } else {
      const start = Math.min(Math.max(0, cursor - MAX_VISIBLE + 2), Math.max(0, list.length - MAX_VISIBLE))
      const visible = list.slice(start, start + MAX_VISIBLE)
      if (start > 0) lines.push(`        ${faint(t('tui.moreUp', { n: start }))}`)
      visible.forEach((option, i) => {
        const index = start + i
        const active = index === cursor
        const label = truncate(option.label, Math.floor(width() * 0.5))
        const hint = option.hint ? `  ${faint(truncate(option.hint, Math.floor(width() * 0.35)))}` : ''
        if (option.separatorBefore && lines.at(-1) !== '') lines.push('')
        lines.push(active ? `      ${color('❯', ACCENT)} ${color(label, ACCENT)}${hint}` : `        ${label}${hint}`)
      })
      const rest = list.length - start - visible.length
      if (rest > 0) lines.push(`        ${faint(t('tui.moreDown', { n: rest }))}`)
    }
    lines.push(`  ${faint(opts.filter ? t('tui.keysWithFilter') : t('tui.keys'))}`)

    clearRendered()
    stdout.write(`${lines.join('\n')}\n`)
    renderedLines = lines.length
  }

  return new Promise<T | null>((resolve) => {
    const finish = (value: T | null, summary: string) => {
      stdin.removeListener('keypress', onKeypress)
      stdin.setRawMode(Boolean(wasRaw))
      stdin.pause()
      clearRendered()
      renderedLines = 0
      if (opts.summary !== false) stdout.write(`${summary}\n`)
      stdout.write('\x1b[?25h')
      resolve(value)
    }

    const confirm = () => {
      const list = filtered()
      const chosen = list[cursor]
      if (!chosen) return
      finish(chosen.value, `  ${color('✔', ACCENT)} ${opts.title} ${faint('·')} ${chosen.label}`)
    }

    const cancel = () => {
      finish(null, `  ${faint('✘')} ${opts.title} ${faint(`· ${t('tui.cancelled')}`)}`)
    }

    const onKeypress = (char: string | undefined, key: KeypressEvent) => {
      const list = filtered()
      if (key.ctrl && key.name === 'c') {
        stdin.setRawMode(Boolean(wasRaw))
        stdout.write('\x1b[?25h\n')
        process.exit(130)
      }
      if (key.name === 'return' || key.name === 'enter') return confirm()
      if (key.name === 'escape') return cancel()
      if (key.name === 'up' || (key.ctrl && key.name === 'p') || (!opts.filter && key.name === 'k')) {
        cursor = list.length ? (cursor - 1 + list.length) % list.length : 0
        return render()
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n') || (!opts.filter && key.name === 'j')) {
        cursor = list.length ? (cursor + 1) % list.length : 0
        return render()
      }
      if (!opts.filter && key.name === 'q') return cancel()
      if (!opts.filter && char && /^[1-9]$/.test(char)) {
        const index = Number(char) - 1
        if (index < list.length) {
          cursor = index
          return confirm()
        }
        return
      }
      if (opts.filter) {
        if (key.name === 'backspace') {
          query = query.slice(0, -1)
          return render()
        }
        if (char && !key.ctrl && char >= ' ' && char !== '\x7f') {
          query += char
          cursor = 0
          return render()
        }
      }
    }

    stdin.on('keypress', onKeypress)
    render()
  })
}

export async function textInput(opts: { title: string; placeholder?: string }): Promise<string | null> {
  if (!isInteractive()) return null
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = opts.placeholder ? ` ${faint(`(${opts.placeholder})`)}` : ''
    const answer = (await rl.question(`  ${color('?', ACCENT)} ${opts.title}${suffix} `)).trim()
    return answer || null
  } finally {
    rl.close()
  }
}

/** Accepts y/yes/o/oui as true and n/no/non as false, anything else is unanswered. */
export function parseYesNo(input: string): boolean | null {
  const normalized = input.trim().toLowerCase()
  if (normalized === 'y' || normalized === 'yes' || normalized === 'o' || normalized === 'oui') return true
  if (normalized === 'n' || normalized === 'no' || normalized === 'non') return false
  return null
}

/** Typed yes/no question, re-asked until answered; false when not interactive. */
export async function confirm(opts: { title: string }): Promise<boolean> {
  if (!isInteractive()) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = await rl.question(`  ${color('?', ACCENT)} ${opts.title} ${faint(t('tui.confirmHint'))} `)
      const parsed = parseYesNo(answer)
      if (parsed === null) continue
      if (isFancy()) {
        process.stdout.write('\x1b[1A\x1b[2K')
        process.stdout.write(`  ${color('✔', ACCENT)} ${opts.title} ${faint('·')} ${t(parsed ? 'tui.yes' : 'tui.no')}\n`)
      }
      return parsed
    }
  } finally {
    rl.close()
  }
}

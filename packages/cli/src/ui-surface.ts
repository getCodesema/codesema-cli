export const UI_EXTENSIONS: ReadonlySet<string> = new Set([
  'vue',
  'svelte',
  'tsx',
  'jsx',
  'html',
  'htm',
  'css',
  'scss',
  'less',
])

export const UI_PATH_HINTS: readonly string[] = [
  'components',
  'pages',
  'views',
  'public',
  'ui',
  'app',
  'layouts',
  'styles',
]

function normalizePath(raw: string): string {
  const slashed = raw.replaceAll('\\', '/')
  return slashed.startsWith('./') ? slashed.slice(2) : slashed
}

function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  return base.slice(dot + 1).toLowerCase()
}

function hasUiPathHint(path: string): boolean {
  const segments = path.split('/')
  return segments.some((segment) => UI_PATH_HINTS.includes(segment.toLowerCase()))
}

export function classifyUiPaths(paths: readonly string[]): { ui: string[]; other: string[] } {
  const ui: string[] = []
  const other: string[] = []
  for (const raw of paths) {
    if (raw === '') {
      continue
    }
    const path = normalizePath(raw)
    const extension = extensionOf(path)
    const isUi = (extension !== null && UI_EXTENSIONS.has(extension)) || hasUiPathHint(path)
    if (isUi) {
      ui.push(raw)
    } else {
      other.push(raw)
    }
  }
  return { ui, other }
}

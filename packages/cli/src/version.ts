// Replaced at build time by tsdown (define) with the version from package.json.
declare const __CODESEMA_VERSION__: string

export const VERSION = typeof __CODESEMA_VERSION__ !== 'undefined' ? __CODESEMA_VERSION__ : '0.0.0-dev'

/** Numeric x.y.z comparison; a leading "v" and any prerelease suffix are ignored. */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(current)
  const b = parse(latest)
  for (let i = 0; i < 3; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Strict x.y.z(-prerelease) shape: the tag ends up in a shell command, anything else is dropped. */
export function isValidVersionTag(tag: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)
}

/**
 * Latest published version from the npm registry (dist-tags only, nothing sent).
 * Best-effort: returns null when offline, slow, or opted out via CODESEMA_NO_UPDATE_CHECK.
 */
export function startUpdateCheck(): Promise<string | null> {
  if (process.env.CODESEMA_NO_UPDATE_CHECK || !process.stdout.isTTY) return Promise.resolve(null)
  return fetch('https://registry.npmjs.org/-/package/codesema/dist-tags', {
    signal: AbortSignal.timeout(2500),
  })
    .then(async (res) => {
      if (!res.ok) return null
      const tags = (await res.json()) as { latest?: unknown }
      return typeof tags.latest === 'string' && isValidVersionTag(tags.latest) ? tags.latest : null
    })
    .catch(() => null)
}

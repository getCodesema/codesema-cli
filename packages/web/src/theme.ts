import { ref, watchEffect } from 'vue'
import { readStorageItem, writeStorageItem } from './storage'

export const PALETTES = [
  { id: 'ink', label: 'Ink' },
  { id: 'tokyonight', label: 'Tokyo Night' },
  { id: 'nord', label: 'Nord' },
  { id: 'gruvbox', label: 'Gruvbox Dark' },
  { id: 'catppuccin', label: 'Catppuccin Mocha' },
  { id: 'bauhaus', label: 'Bauhaus' },
  { id: 'aamis', label: 'Aamis' },
  { id: 'aetheria', label: 'Aetheria' },
  { id: 'arcblueberry', label: 'Arc Blueberry' },
  { id: 'artzen', label: 'Artzen' },
] as const

export type PaletteId = (typeof PALETTES)[number]['id']
export type Contrast = 'aa' | 'aaa'

export const DEFAULT_PALETTE: PaletteId = 'ink'
export const DEFAULT_CONTRAST: Contrast = 'aa'

export const PALETTE_STORAGE_KEY = 'codesema-palette'
export const CONTRAST_STORAGE_KEY = 'codesema-contrast'

const PALETTE_IDS: ReadonlySet<string> = new Set(PALETTES.map((palette) => palette.id))

export function normalizePalette(value: string | null | undefined): PaletteId {
  return value !== null && value !== undefined && PALETTE_IDS.has(value)
    ? (value as PaletteId)
    : DEFAULT_PALETTE
}

export function normalizeContrast(value: string | null | undefined): Contrast {
  return value === 'aaa' ? 'aaa' : DEFAULT_CONTRAST
}

export type ThemeRoot = {
  dataset: { palette?: string; contrast?: string }
}

// The default palette sets no attribute so tokens.css `:root` wins and the
// index.html bootstrap script stays a mirror of this function.
export function applyTheme(root: ThemeRoot, palette: PaletteId, contrast: Contrast): void {
  if (palette === DEFAULT_PALETTE) {
    delete root.dataset.palette
  } else {
    root.dataset.palette = palette
  }
  if (contrast === 'aaa') {
    root.dataset.contrast = 'aaa'
  } else {
    delete root.dataset.contrast
  }
}

const PALETTE_MIGRATION_KEY = 'codesema-palette-migrated-ink'

function readInitialPalette(): PaletteId {
  const stored = readStorageItem(PALETTE_STORAGE_KEY)
  // One-shot: the previous default id now maps to Ink so bare :root wins.
  if (stored === 'tokyonight' && readStorageItem(PALETTE_MIGRATION_KEY) !== '1') {
    writeStorageItem(PALETTE_STORAGE_KEY, 'ink')
    writeStorageItem(PALETTE_MIGRATION_KEY, '1')
    return 'ink'
  }
  return normalizePalette(stored)
}

const palette = ref<PaletteId>(readInitialPalette())
const contrast = ref<Contrast>(normalizeContrast(readStorageItem(CONTRAST_STORAGE_KEY)))

let bound = false

export function usePalette() {
  if (!bound && typeof document !== 'undefined') {
    bound = true
    watchEffect(() => {
      applyTheme(document.documentElement, palette.value, contrast.value)
      writeStorageItem(PALETTE_STORAGE_KEY, palette.value)
      writeStorageItem(CONTRAST_STORAGE_KEY, contrast.value)
    })
  }
  return { palette, contrast }
}

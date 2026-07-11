// Types du record servi par `codesema show` (/api/review).
// Miroir du contrat CLI (packages/cli/src/contract.ts).

import type { Finding } from './composables/useDiff'

export type NarrativeChapter = {
  title: string
  rationale: string
  files: string[]
  finding_refs: number[]
  risk?: 'high' | 'medium' | 'low'
  take?: string
  check?: string | null
}

/** Chapitre normalisé pour l'affichage (check: null → undefined, cf. ReviewShell). */
export type ChapterView = Omit<NarrativeChapter, 'check'> & { check?: string }

export type ReviewFirstItem = {
  point: string
  risk: 'high' | 'medium' | 'low'
  chapter_ref: number | null
  file: string | null
}

export type ReviewNarrative = {
  intent: string
  confidence: 'high' | 'medium' | 'low'
  prologue?: {
    why: string
    what: string
    key_changes: { title: string; detail: string }[]
  }
  chapters: NarrativeChapter[]
  review_first: ReviewFirstItem[]
}

export type ReviewRecord = {
  version: 1
  meta: {
    title: string
    branch: string
    target: string
    merge_base: string
    repo_root: string
    created_at: string
  }
  commits: string[]
  diff: string
  review: {
    verdict: 'approve' | 'request_changes' | 'comment'
    summary: string
    findings: Finding[]
    narrative: ReviewNarrative | null
  }
}

// Session live servie par `codesema review` (/api/status, /api/events).
// Miroir de packages/cli/src/serve.ts et partial.ts.

export type LiveInput = {
  branch: string
  target: string
  commits: string[]
  files: { path: string; additions: number; deletions: number }[]
  additions: number
  deletions: number
  incremental: boolean
}

export type LiveStatus = {
  phase: 'reviewing' | 'done' | 'error'
  started_at: string
  agent?: string
  input?: LiveInput
  error?: string
}

export type PartialFinding = {
  file: string
  message: string
  title?: string
  severity?: string
  kind?: string
  line?: number
}

export type PartialReview = {
  verdict?: 'approve' | 'request_changes' | 'comment'
  summary?: string
  intent?: string
  findings: PartialFinding[]
  chapterTitles: string[]
}

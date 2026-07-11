// `mr-review export` : rend la review courante (ou la dernière archivée) en
// Markdown lisible — partageable dans une MR, un ticket ou un chat d'équipe.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding, ReviewRecord } from './contract.js'
import { ensureWorkDir } from './config.js'
import { repoRoot } from './git.js'
import { resolveRecord } from './record.js'

const VERDICT_LABEL: Record<string, string> = {
  approve: 'Approved ✅',
  request_changes: 'Changes requested ❌',
  comment: 'Comment 💬',
}

function findingAnchor(f: Finding): string {
  const line = f.line != null ? `:${f.line}${f.endLine != null ? `-${f.endLine}` : ''}` : ''
  return `\`${f.file}${line}\``
}

function renderFinding(f: Finding, index: number): string {
  const parts: string[] = []
  const badge = [f.severity, f.kind].filter(Boolean).join(' / ')
  parts.push(`### ${index + 1}. ${findingAnchor(f)} — ${badge}`)
  if (f.title) parts.push(`**${f.title}**`)
  parts.push(f.message)
  if (f.suggestion) parts.push('```suggestion\n' + f.suggestion + '\n```')
  return parts.join('\n\n')
}

export function renderMarkdown(record: ReviewRecord): string {
  const { meta, review } = record
  const n = review.narrative
  const out: string[] = []

  out.push(`# Review — ${meta.branch} → ${meta.target}`)
  out.push(
    [
      `- **Verdict:** ${VERDICT_LABEL[review.verdict] ?? review.verdict}`,
      `- **Created:** ${meta.created_at}`,
      `- **Commits:** ${record.commits.length}`,
      `- **Findings:** ${review.findings.length}`,
    ].join('\n'),
  )

  if (review.summary) {
    out.push('## Summary')
    out.push(review.summary)
  }

  if (n) {
    if (n.intent) out.push(`**Intent:** ${n.intent} _(confidence: ${n.confidence})_`)
    if (n.prologue) {
      out.push('## Prologue')
      const p: string[] = []
      if (n.prologue.why) p.push(`**Why:** ${n.prologue.why}`)
      if (n.prologue.what) p.push(`**What:** ${n.prologue.what}`)
      for (const kc of n.prologue.key_changes) p.push(`- **${kc.title}**${kc.detail ? ` — ${kc.detail}` : ''}`)
      out.push(p.join('\n\n'))
    }
    if (n.review_first.length) {
      out.push('## Review first')
      out.push(
        n.review_first
          .map((rf, i) => `${i + 1}. **[${rf.risk}]** ${rf.point}${rf.file ? ` (\`${rf.file}\`)` : ''}`)
          .join('\n'),
      )
    }
    if (n.chapters.length) {
      out.push('## Chapters')
      n.chapters.forEach((ch, i) => {
        const head = `### ${i + 1}. ${ch.title}${ch.risk ? ` — ${ch.risk} risk` : ''}`
        const body: string[] = [head]
        if (ch.rationale) body.push(ch.rationale)
        if (ch.take) body.push(`> ${ch.take}`)
        if (ch.check) body.push(`- [ ] To verify: ${ch.check}`)
        if (ch.files.length) body.push(`Files: ${ch.files.map((f) => `\`${f}\``).join(', ')}`)
        if (ch.finding_refs.length) {
          body.push(`Findings: ${ch.finding_refs.map((r) => `#${r + 1}`).join(', ')}`)
        }
        out.push(body.join('\n\n'))
      })
    }
  }

  if (review.findings.length) {
    out.push('## Findings')
    review.findings.forEach((f, i) => out.push(renderFinding(f, i)))
  }

  return `${out.join('\n\n')}\n`
}

export function exportCommand(opts: { review?: string; out?: string; cwd: string }): void {
  const cwd = repoRoot(opts.cwd)
  const { record, sourcePath } = resolveRecord({ review: opts.review, cwd })
  const markdown = renderMarkdown(record)

  if (opts.out === '-') {
    process.stdout.write(markdown)
    return
  }
  const outPath = opts.out ?? join(ensureWorkDir(cwd), 'review.md')
  writeFileSync(outPath, markdown)
  console.log(`review exported: ${outPath} (from ${sourcePath})`)
}

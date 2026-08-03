import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import type { Finding, ReviewRecord } from './contract.js'
import { repoRoot } from './git.js'
import { t } from './i18n.js'
import { resolveRecord } from './record.js'

function verdictLabel(verdict: string): string {
  if (verdict === 'approve') {
    return t('export.verdictApprove')
  }
  if (verdict === 'request_changes') {
    return t('export.verdictChanges')
  }
  if (verdict === 'comment') {
    return t('export.verdictComment')
  }
  return verdict
}

function findingAnchor(f: Finding): string {
  const line = f.line != null ? `:${f.line}${f.endLine != null ? `-${f.endLine}` : ''}` : ''
  return `\`${f.file}${line}\``
}

function renderFinding(f: Finding, index: number): string {
  const parts: string[] = []
  const badge = [f.severity, f.kind].filter(Boolean).join(' / ')
  parts.push(`### ${index + 1}. ${findingAnchor(f)} — ${badge}`)
  if (f.title) {
    parts.push(`**${f.title}**`)
  }
  parts.push(f.message)
  if (f.suggestion) {
    parts.push('```suggestion\n' + f.suggestion + '\n```')
  }
  return parts.join('\n\n')
}

export function renderMarkdown(record: ReviewRecord): string {
  const { meta, review } = record
  const n = review.narrative
  const out: string[] = []

  out.push(`# ${t('export.title', { branch: meta.branch, target: meta.target })}`)
  out.push(
    [
      `- **${t('export.verdictLabel')}:** ${verdictLabel(review.verdict)}`,
      `- **${t('export.createdLabel')}:** ${meta.created_at}`,
      `- **${t('export.commitsLabel')}:** ${record.commits.length}`,
      `- **${t('export.findingsLabel')}:** ${review.findings.length}`,
    ].join('\n'),
  )

  if (review.summary) {
    out.push(`## ${t('export.summary')}`)
    out.push(review.summary)
  }

  if (n) {
    if (n.intent) {
      out.push(
        `**${t('export.intent')}:** ${n.intent} _(${t('export.confidence')}: ${n.confidence})_`,
      )
    }
    if (n.prologue) {
      out.push(`## ${t('export.prologue')}`)
      const p: string[] = []
      if (n.prologue.why) {
        p.push(`**${t('export.why')}:** ${n.prologue.why}`)
      }
      if (n.prologue.what) {
        p.push(`**${t('export.what')}:** ${n.prologue.what}`)
      }
      for (const kc of n.prologue.key_changes) {
        p.push(`- **${kc.title}**${kc.detail ? ` — ${kc.detail}` : ''}`)
      }
      out.push(p.join('\n\n'))
    }
    if (n.review_first.length) {
      out.push(`## ${t('export.reviewFirst')}`)
      out.push(
        n.review_first
          .map(
            (rf, i) =>
              `${i + 1}. **[${t(`risk.${rf.risk}`)}]** ${rf.point}${rf.file ? ` (\`${rf.file}\`)` : ''}`,
          )
          .join('\n'),
      )
    }
    if (n.steps.length) {
      out.push(`## ${t('export.steps')}`)
      n.steps.forEach((ch, i) => {
        const head = `### ${i + 1}. ${ch.title}${ch.risk ? ` — ${t('export.risk', { risk: t(`risk.${ch.risk}`) })}` : ''}`
        const body: string[] = [head]
        if (ch.rationale) {
          body.push(ch.rationale)
        }
        if (ch.take) {
          body.push(`> ${ch.take}`)
        }
        if (ch.check) {
          body.push(`- [ ] ${t('export.toVerify')}: ${ch.check}`)
        }
        if (ch.files.length) {
          body.push(`${t('export.files')}: ${ch.files.map((f) => `\`${f}\``).join(', ')}`)
        }
        if (ch.finding_refs.length) {
          body.push(
            `${t('export.findingsRefs')}: ${ch.finding_refs.map((r) => `#${r + 1}`).join(', ')}`,
          )
        }
        out.push(body.join('\n\n'))
      })
    }
  }

  if (review.findings.length) {
    out.push(`## ${t('export.findingsLabel')}`)
    review.findings.forEach((f, i) => out.push(renderFinding(f, i)))
  }

  return `${out.join('\n\n')}\n`
}

export function exportCommand(opts: {
  review?: string | undefined
  out?: string | undefined
  cwd: string
}): void {
  const cwd = repoRoot(opts.cwd)
  const { record, sourcePath } = resolveRecord({ review: opts.review, cwd })
  const markdown = renderMarkdown(record)

  if (opts.out === '-') {
    process.stdout.write(markdown)
    return
  }
  const outPath = opts.out ?? join(ensureWorkDir(cwd), 'review.md')
  writeFileSync(outPath, markdown)
  console.log(t('export.exported', { outPath, sourcePath }))
}

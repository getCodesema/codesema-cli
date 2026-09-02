import type { EvidenceRecord, ProofIntent } from './contract.js'

function describeIntent(intent: ProofIntent): string {
  const detail =
    intent.kind === 'screenshot' && intent.pages
      ? ` pages: ${intent.pages.join(', ')}`
      : intent.kind === 'journey' && intent.journey
        ? ` spec: ${intent.journey}`
        : ''
  return `kind=${intent.kind}${detail}, reason: "${intent.reason}"`
}

function describeEvidence(evidence: EvidenceRecord): string {
  const parts = [`status=${evidence.status}`]
  if (evidence.items.length > 0) {
    const items = evidence.items
      .map((item) => `kind=${item.kind} bytes=${item.bytes} turn=${item.turn}`)
      .join('; ')
    parts.push(`items: ${items}`)
  }
  if (evidence.reason) {
    parts.push(`reason: ${evidence.reason}`)
  }
  return parts.join(', ')
}

export type BuildProofChapterInput = {
  /** UI-classified paths touched by this diff (ui-surface.ts's classifyUiPaths). */
  uiFiles: string[]
  /** How many other, non-UI paths this diff also touches. */
  otherCount: number
  /** This turn's own PROOF declaration, or null when it never stated one. */
  intent: ProofIntent | null
  /** This task's evidence.json, already checked by the caller to match the reviewed head_sha; null otherwise. */
  evidence: EvidenceRecord | null
  /** Whether the turn declared a PROOF line at all, independent of what it declared. */
  declared: boolean
}

/**
 * D17: the mandatory chapter that hands the reviewer the mechanical facts
 * (which files are UI, what the turn declared, what capture actually ran) and
 * asks for exactly one judgment call — was the declaration a reasonable
 * response to those facts. Same split as buildCriteriaChapter: the fact is
 * read off the diff/disk by this file, never by the model; only the
 * reasonableness of the response is asked of it.
 */
export function buildProofChapter(input: BuildProofChapterInput): string {
  const uiLine = input.uiFiles.length > 0 ? input.uiFiles.join(', ') : 'none'
  const declarationLine =
    input.declared && input.intent
      ? describeIntent(input.intent)
      : 'the agent did not declare a proof this turn'
  const evidenceLine = input.evidence
    ? describeEvidence(input.evidence)
    : 'no proof for this commit'

  return [
    'Visual proof (MANDATORY chapter):',
    'FACTS:',
    `- UI files touched by this diff: ${uiLine}`,
    `- other files touched: ${input.otherCount}`,
    `- declaration: ${declarationLine}`,
    `- proof produced: ${evidenceLine}`,
    '',
    'The decision grid the agent was asked to follow when it wrote its PROOF line:',
    '- the interface changed and the change is visible: "screenshot" naming the pages, or "journey" naming the spec when the change is a sequence rather than one screen;',
    '- a UI file changed with no visible effect (a refactor with no rendered difference, a prop threaded through with no new output): "none", with the reason stated;',
    '- nothing outside the interface was touched: "none";',
    '- doubt: proof, not "none". The grid resolves a tie toward capturing rather than skipping.',
    '',
    'Judge whether the declaration above was a reasonable response to the FACTS above, using the grid as your standard. A proof supplied when none was owed is never blocking. An absence justified by a real lack of visible effect is coherent. A project with no proof target configured turns every declaration into "skipped", reason "no_target": that is always coherent, since there is nothing to replay a proof against.',
    '',
    'Add ONE more top-level field to the JSON you output, after "files_reviewed":',
    '"proof_review": { "expected": "none" | "screenshot" | "journey", "coherent": true | false, "reason": "<one sentence>" }',
    '',
    'Rule for this chapter: if "coherent" is false AND the UI files listed above are non-empty, you MUST ALSO emit a finding with "kind": "design" and "severity": "major", anchored on a line of one of those UI files, whose message names the proof that was expected. Never emit this finding when the UI files list above is empty, and never emit it merely because a proof was supplied that was not owed.',
  ].join('\n')
}

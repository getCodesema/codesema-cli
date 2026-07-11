// i18n minimal sans dépendance : dictionnaire plat + interpolation {n} + pluriel "a | b".
// Exposé globalement comme $t dans les templates (voir main.ts).

const messages: Record<string, string> = {
  // App shell
  'app.tabChapters': 'Chapters',
  'app.tabFiles': 'Files',
  'app.loading': 'Loading review…',
  'app.loadError': 'Could not load the review.',
  'app.retry': 'Retry',
  'verdict.approve': 'Approved',
  'verdict.request_changes': 'Changes requested',
  'verdict.comment': 'Comment',
  'header.copyPrompt': 'Copy for Claude Code ({n})',
  'header.copied': 'Copied ✓',

  // Live review (codesema review en cours)
  'live.title': 'Review in progress',
  'live.errorTitle': 'The review failed',
  'live.filesChanged': '{n} file changed | {n} files changed',
  'live.commits': '{n} commit | {n} commits',
  'live.incremental': 'incremental update',
  'live.summary': 'Summary',
  'live.findings': 'Findings so far',
  'live.chapters': 'Chapters taking shape',
  'live.moreFiles': '+ {n} more files',
  'live.reading': 'The agent is reading the diff — the review fills in here as it is written.',
  'live.streaming': 'The agent is still writing —',

  // Prologue
  'reviews.prologue.why': 'Why this MR',
  'reviews.prologue.what': 'What it does',
  'reviews.prologue.keyChanges': 'Key changes',
  'reviews.prologue.reviewFirst': 'Review first',
  'reviews.prologue.empty': 'No prologue for this review.',
  'reviews.intent': 'Intent',
  'reviews.confidence': 'Confidence',
  'reviews.confidenceHigh': 'high',
  'reviews.confidenceMedium': 'medium',
  'reviews.confidenceLow': 'low',
  'reviews.summary': 'Summary',
  'reviews.generalNotes': 'General notes',

  // Chapters
  'reviews.chaptersTitle': 'Chapters',
  'reviews.chaptersBy': 'chaptered by AI',
  'reviews.chaptersFiles': '{n} file | {n} files',
  'reviews.chaptersFindings': '{n} note | {n} notes',
  'reviews.chaptersStart': 'Start review →',
  'reviews.chaptersEmpty': 'No chapters in this review.',
  'reviews.riskHigh': 'High risk',
  'reviews.riskMedium': 'Medium risk',
  'reviews.riskLow': 'Low risk',
  'reviews.noDiff': 'No diff available.',
  'reviews.annotatedDiff': 'Annotated diff',
  'reviews.otherChanges': 'Other changes',

  // Guided mode
  'reviews.guidedBack': '← Back to overview',
  'reviews.guidedMarkRead': 'Mark as read',
  'reviews.guidedMarkUnread': 'Mark as unread',
  'reviews.guidedChapter': 'Chapter',
  'reviews.guidedPrev': 'Previous chapter',
  'reviews.guidedNext': 'Next chapter',
  'reviews.guidedToWatch': 'To verify',
  'reviews.guidedFiles': 'Files',
  'reviews.guidedFileFilter': 'Filter files…',
  'reviews.guidedFileEmpty': 'No matching file.',
  'reviews.guidedBannerTitle': 'This chapter was reviewed',
  'reviews.guidedBannerCount': '{n} note | {n} notes',

  // Diff view
  'diffView.modeUnified': 'Unified',
  'diffView.modeSplit': 'Split',
  'diffView.noteCount': '{n} note | {n} notes',
  'diffView.gapLines': '{n} unchanged line | {n} unchanged lines',
  'diffView.suggestionLabel': 'Suggested fix',
  'diffView.kindSecurity': 'Security',
  'diffView.kindPerf': 'Performance',
  'diffView.kindConvention': 'Convention',
  'diffView.kindDesign': 'Design',
  'diffView.kindPraise': 'Praise',
  'diffView.kindWhy': 'Why',
  'diffView.sevCritical': 'Critical',
  'diffView.sevMajor': 'Major',
  'diffView.sevMinor': 'Minor',
  'diffView.sevInfo': 'Info',
  'note.author': 'Reviewer',

  // File tree
  'fileTree.files': 'Files',
  'fileTree.filterPlaceholder': 'Filter…',
  'fileTree.filterEmpty': 'No matching file.',
  'fileTree.noteCount': '{n} note | {n} notes',
  'fileTree.expandAll': 'Expand all',
  'fileTree.collapseAll': 'Collapse all',
}

export function t(key: string, params?: Record<string, unknown>, count?: number): string {
  let msg = messages[key] ?? key
  if (msg.includes(' | ')) {
    const n = count ?? (typeof params?.n === 'number' ? (params.n as number) : undefined)
    const parts = msg.split(' | ')
    msg = (n === 1 ? parts[0] : parts[1] ?? parts[0]) ?? msg
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) msg = msg.replaceAll(`{${k}}`, String(v))
  }
  return msg
}

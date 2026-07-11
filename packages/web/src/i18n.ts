// Minimal i18n with no dependency: flat dictionary, {n} interpolation, "a | b" plural.
// The locale comes from window.__CODESEMA_LOCALE__, injected into index.html by the
// CLI server (packages/cli/src/serve.ts) before the bundle runs.

const en = {
  'app.tabSteps': 'Steps',
  'app.tabFiles': 'Files',
  'app.loading': 'Loading review…',
  'app.loadError': 'Could not load the review.',
  'app.retry': 'Retry',
  'verdict.approve': 'Approved',
  'verdict.request_changes': 'Changes requested',
  'verdict.comment': 'Comment',
  'header.copyPrompt': 'Copy for Claude Code ({n})',
  'header.copied': 'Copied ✓',

  'live.title': 'Review in progress',
  'live.errorTitle': 'The review failed',
  'live.filesChanged': '{n} file changed | {n} files changed',
  'live.commits': '{n} commit | {n} commits',
  'live.incremental': 'incremental update',
  'live.summary': 'Summary',
  'live.findings': 'Findings so far',
  'live.steps': 'Steps taking shape',
  'live.moreFiles': '+ {n} more files',
  'live.reading': 'The agent is reading the diff — the review fills in here as it is written.',
  'live.streaming': 'The agent is still writing —',

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

  'reviews.stepsTitle': 'Steps',
  'reviews.stepsBy': 'grouped by AI',
  'reviews.stepsFiles': '{n} file | {n} files',
  'reviews.stepsFindings': '{n} note | {n} notes',
  'reviews.stepsStart': 'Start review →',
  'reviews.stepsEmpty': 'No steps in this review.',
  'reviews.riskHigh': 'High risk',
  'reviews.riskMedium': 'Medium risk',
  'reviews.riskLow': 'Low risk',
  'reviews.noDiff': 'No diff available.',
  'reviews.annotatedDiff': 'Annotated diff',
  'reviews.otherChanges': 'Other changes',

  'reviews.guidedBack': '← Back to overview',
  'reviews.guidedMarkRead': 'Mark as read',
  'reviews.guidedMarkUnread': 'Mark as unread',
  'reviews.guidedStep': 'Step',
  'reviews.guidedPrev': 'Previous step',
  'reviews.guidedNext': 'Next step',
  'reviews.guidedToWatch': 'To verify',
  'reviews.guidedFiles': 'Files',
  'reviews.guidedFileFilter': 'Filter files…',
  'reviews.guidedFileEmpty': 'No matching file.',
  'reviews.guidedBannerTitle': "Agent's take",
  'reviews.guidedBannerCount': '{n} note | {n} notes',

  'rail.aria': 'Review progress',
  'rail.mr': 'MR',
  'rail.merge': 'MERGE ✓',

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

  'fileTree.files': 'Files',
  'fileTree.filterPlaceholder': 'Filter…',
  'fileTree.filterEmpty': 'No matching file.',
  'fileTree.noteCount': '{n} note | {n} notes',
  'fileTree.expandAll': 'Expand all',
  'fileTree.collapseAll': 'Collapse all',
}

export type MessageKey = keyof typeof en

const fr: Record<MessageKey, string> = {
  'app.tabSteps': 'Étapes',
  'app.tabFiles': 'Fichiers',
  'app.loading': 'Chargement de la revue…',
  'app.loadError': 'Impossible de charger la revue.',
  'app.retry': 'Réessayer',
  'verdict.approve': 'Approuvée',
  'verdict.request_changes': 'Changements demandés',
  'verdict.comment': 'Commentaire',
  'header.copyPrompt': 'Copier pour Claude Code ({n})',
  'header.copied': 'Copié ✓',

  'live.title': 'Revue en cours',
  'live.errorTitle': 'La revue a échoué',
  'live.filesChanged': '{n} fichier modifié | {n} fichiers modifiés',
  'live.commits': '{n} commit | {n} commits',
  'live.incremental': 'mise à jour incrémentale',
  'live.summary': 'Résumé',
  'live.findings': "Notes relevées jusqu'ici",
  'live.steps': 'Les étapes prennent forme',
  'live.moreFiles': '+ {n} autre fichier | + {n} autres fichiers',
  'live.reading': "L'agent lit le diff : la revue se remplit ici au fil de l'écriture.",
  'live.streaming': "L'agent écrit encore ·",

  'reviews.prologue.why': 'Pourquoi cette MR',
  'reviews.prologue.what': "Ce qu'elle fait",
  'reviews.prologue.keyChanges': 'Changements clés',
  'reviews.prologue.reviewFirst': 'À vérifier en premier',
  'reviews.prologue.empty': 'Pas de prologue pour cette revue.',
  'reviews.intent': 'Intention',
  'reviews.confidence': 'Confiance',
  'reviews.confidenceHigh': 'haute',
  'reviews.confidenceMedium': 'moyenne',
  'reviews.confidenceLow': 'basse',
  'reviews.summary': 'Résumé',
  'reviews.generalNotes': 'Notes générales',

  'reviews.stepsTitle': 'Étapes',
  'reviews.stepsBy': "regroupées par l'IA",
  'reviews.stepsFiles': '{n} fichier | {n} fichiers',
  'reviews.stepsFindings': '{n} note | {n} notes',
  'reviews.stepsStart': 'Commencer la revue →',
  'reviews.stepsEmpty': 'Aucune étape dans cette revue.',
  'reviews.riskHigh': 'Risque élevé',
  'reviews.riskMedium': 'Risque moyen',
  'reviews.riskLow': 'Risque faible',
  'reviews.noDiff': 'Aucun diff disponible.',
  'reviews.annotatedDiff': 'Diff annoté',
  'reviews.otherChanges': 'Autres changements',

  'reviews.guidedBack': "← Retour à la vue d'ensemble",
  'reviews.guidedMarkRead': 'Marquer comme lue',
  'reviews.guidedMarkUnread': 'Marquer comme non lue',
  'reviews.guidedStep': 'Étape',
  'reviews.guidedPrev': 'Étape précédente',
  'reviews.guidedNext': 'Étape suivante',
  'reviews.guidedToWatch': 'À vérifier',
  'reviews.guidedFiles': 'Fichiers',
  'reviews.guidedFileFilter': 'Filtrer les fichiers…',
  'reviews.guidedFileEmpty': 'Aucun fichier correspondant.',
  'reviews.guidedBannerTitle': "Avis de l'agent",
  'reviews.guidedBannerCount': '{n} note | {n} notes',

  'rail.aria': 'Progression de la revue',
  'rail.mr': 'MR',
  'rail.merge': 'MERGE ✓',

  'diffView.modeUnified': 'Unifié',
  'diffView.modeSplit': 'Côte à côte',
  'diffView.noteCount': '{n} note | {n} notes',
  'diffView.gapLines': '{n} ligne inchangée | {n} lignes inchangées',
  'diffView.suggestionLabel': 'Correctif suggéré',
  'diffView.kindSecurity': 'Sécurité',
  'diffView.kindPerf': 'Performance',
  'diffView.kindConvention': 'Convention',
  'diffView.kindDesign': 'Design',
  'diffView.kindPraise': 'Éloge',
  'diffView.kindWhy': 'Pourquoi',
  'diffView.sevCritical': 'Critique',
  'diffView.sevMajor': 'Majeure',
  'diffView.sevMinor': 'Mineure',
  'diffView.sevInfo': 'Info',
  'note.author': 'Relecteur',

  'fileTree.files': 'Fichiers',
  'fileTree.filterPlaceholder': 'Filtrer…',
  'fileTree.filterEmpty': 'Aucun fichier correspondant.',
  'fileTree.noteCount': '{n} note | {n} notes',
  'fileTree.expandAll': 'Tout déplier',
  'fileTree.collapseAll': 'Tout replier',
}

const catalogs: Record<string, Record<MessageKey, string>> = { en, fr }

function detectLocale(): string {
  if (typeof window === 'undefined') return 'en'
  const injected = (window as { __CODESEMA_LOCALE__?: string }).__CODESEMA_LOCALE__
  return injected && catalogs[injected] ? injected : 'en'
}

const messages: Record<string, string> = catalogs[detectLocale()] ?? en

export function t(key: string, params?: Record<string, unknown>, count?: number): string {
  let msg = messages[key] ?? (en as Record<string, string>)[key] ?? key
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

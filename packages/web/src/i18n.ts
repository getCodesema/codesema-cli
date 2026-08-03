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
  'header.copyPrompt': 'Copy for agent ({n})',
  'header.copied': 'Copied ✓',
  'header.runFixes': 'Run the fixes ({n})',

  'mode.explain': 'Explanation',
  'mode.focus': 'Focus problems',

  'focus.title': 'Problems',
  'focus.selectAll': 'All',
  'focus.selectNone': 'None',
  'focus.problem': 'Problem',
  'focus.prev': 'Previous problem',
  'focus.next': 'Next problem',
  'focus.copySelected': 'Copy selection for agent ({n})',
  'focus.empty': 'No actionable finding in this review.',
  'focus.noExcerpt': 'This note is not anchored to a specific line.',
  'focus.runFixes': 'Run fixes ({n})',
  'focus.fixRunning': 'The agent is applying the fixes…',
  'focus.fixDone': 'Fixes applied. Run a new review to verify.',
  'focus.fixFailed': 'Fix run failed',
  'focus.headMoved':
    'The branch has moved since this review; the agent will patch the files as they are now.',

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
  'live.laneReviewer': 'Reviewer',
  'live.laneProsecutor': 'Prosecutor',
  'live.laneWarmingUp': 'Warming up…',
  'live.laneStep': 'Current step',
  'live.laneFindingCount': '{n} finding so far | {n} findings so far',
  'live.consensusTitle': 'Where both reviewers converge',
  'live.consensusHotZone': 'Both reviewers flagged this file',
  'live.judgeTitle': 'Deliberation',
  'live.judgeProgress': '{done} / {total} adjudicated',
  'live.judgeMergedInto': 'merged into {id}',
  'live.judgeKept': 'kept',
  'live.judgeRejected': 'rejected',

  'finding.consensus': 'both reviewers',
  'reviews.dualStat':
    'dual review · {merged} merged · {rejected} rejected · {added} added by the prosecutor',

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

  'tour.start': 'Guided reading',
  'tour.prev': 'Previous note',
  'tour.next': 'Next note',
  'tour.finish': 'Finish reading',

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
  'header.copyPrompt': "Copier pour l'agent ({n})",
  'header.copied': 'Copié ✓',
  'header.runFixes': 'Lancer les fix ({n})',

  'mode.explain': 'Explication',
  'mode.focus': 'Focus problèmes',

  'focus.title': 'Problèmes',
  'focus.selectAll': 'Tout',
  'focus.selectNone': 'Aucun',
  'focus.problem': 'Problème',
  'focus.prev': 'Problème précédent',
  'focus.next': 'Problème suivant',
  'focus.copySelected': "Copier la sélection pour l'agent ({n})",
  'focus.empty': 'Aucun problème à corriger dans cette revue.',
  'focus.noExcerpt': "Cette note n'est pas ancrée à une ligne précise.",
  'focus.runFixes': 'Lancer les fix ({n})',
  'focus.fixRunning': "L'agent applique les fix…",
  'focus.fixDone': 'Fix appliqués. Relance une review pour vérifier.',
  'focus.fixFailed': 'Le lancement des fix a échoué',
  'focus.headMoved':
    "La branche a bougé depuis cette revue ; l'agent corrigera les fichiers dans leur état actuel.",

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
  'live.laneReviewer': 'Relecteur',
  'live.laneProsecutor': 'Procureur',
  'live.laneWarmingUp': 'En préparation…',
  'live.laneStep': 'Étape en cours',
  'live.laneFindingCount': '{n} note relevée | {n} notes relevées',
  'live.consensusTitle': 'Là où les deux avis convergent',
  'live.consensusHotZone': 'Les deux relecteurs ont repéré ce fichier',
  'live.judgeTitle': 'Délibération',
  'live.judgeProgress': '{done} / {total} tranchées',
  'live.judgeMergedInto': 'fusionné avec {id}',
  'live.judgeKept': 'conservé',
  'live.judgeRejected': 'rejeté',

  'finding.consensus': 'les 2 reviewers',
  'reviews.dualStat':
    'revue duale · {merged} fusionnées · {rejected} rejetées · {added} ajoutées par le procureur',

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

  'tour.start': 'Lecture guidée',
  'tour.prev': 'Note précédente',
  'tour.next': 'Note suivante',
  'tour.finish': 'Terminer la lecture',

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
  if (typeof window === 'undefined') {
    return 'en'
  }
  const injected = (window as { __CODESEMA_LOCALE__?: string }).__CODESEMA_LOCALE__
  return injected && catalogs[injected] ? injected : 'en'
}

const messages: Record<string, string> = catalogs[detectLocale()] ?? en

export function t(key: string, params?: Record<string, unknown>, count?: number): string {
  let msg = messages[key] ?? (en as Record<string, string>)[key] ?? key
  if (msg.includes(' | ')) {
    const n = count ?? (typeof params?.n === 'number' ? (params.n as number) : undefined)
    const parts = msg.split(' | ')
    msg = (n === 1 ? parts[0] : (parts[1] ?? parts[0])) ?? msg
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v))
    }
  }
  return msg
}

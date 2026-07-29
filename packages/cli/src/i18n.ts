// Minimal i18n with no dependency: flat dictionary, {x} interpolation, "a | b" plural.
// Mirrors packages/web/src/i18n.ts. Every key must exist in every catalog (enforced
// by the Record<MessageKey, string> type on non-English catalogs).

const en = {
  'cli.help': `codesema — local merge request review, step by step

Usage:
  codesema                            Opens an interactive menu (review, show, sync, link, config) in
                                      an interactive terminal; behaves like \`review\` otherwise. Pick
                                      a local branch, the web UI opens immediately and fills in live
                                      while your AI agent reviews. First run only: a short wizard picks
                                      the language, agent, model and effort (saved globally — change it
                                      with \`codesema config\`)
  codesema review [--branch <name>] [--target <branch>] [--agent <cmd>] [--full] [--no-open]
                                      Same flow; --branch skips the branch picker (also skipped
                                      when stdin is not a terminal, e.g. CI). Re-runs on the same
                                      branch update the previous review incrementally; --full
                                      forces a review from scratch
  codesema config                     Change the language, AI agent, model, effort and auto-sync (interactive)
  codesema prep [--target <branch>]   Only detect branches, compute the MR diff, write
                                      .codesema/input.json for your own agent flow
  codesema show [--review <file>]     Only display a review (agent output) in the local web UI
  codesema export [--review <file>] [--out <file>]
                                      Export the review as Markdown (--out - for stdout)
  codesema sync              Push the latest review to your codesema.com workspace
  codesema sync delete       Delete all synced data (unlinked workspaces only)
  codesema link [code]       Link this workspace to your codesema.com account (no code: confirm in the browser)

Options:
  --branch <name>     Local branch to review (default: interactive picker, else current branch)
  --target <branch>   Target branch of the MR (default: auto-detected via glab/gh, origin/HEAD, then heuristic)
  --agent <cmd>       Agent command override for this run. Receives the prompt on stdin,
                      must print the review JSON on stdout
  --review <file>     Agent output to display (default: .codesema/review.json, else last archived review)
  --port <n>          Preferred port for the local server (default: 4400)
  --timeout <s>       Agent time budget in seconds for \`review\` (default: 900)
  --full              Review from scratch instead of updating the previous review
  --dual              Dual review: two independent reviewers run in parallel (same agent,
                      different angles), then a judge model merges their findings
  --no-open           Do not open the browser
  -h, --help          Show this help
  -v, --version       Show version

Config precedence: CLI flags > .codesema/config.json (repo) > ~/.config/codesema/config.json (global).

\`review\` and \`show\` check the npm registry once at startup to tell you when a newer
version exists (nothing is sent). Set CODESEMA_NO_UPDATE_CHECK=1 to disable.
`,
  'cli.unknownCommand': 'unknown command: {command}',
  'cli.intFlagError': '--{name} {raw}: expected an integer between {min} and {max}',
  'cli.failOnError': 'invalid --fail-on {raw}: expected one of {values}',

  'git.notFound': 'git not found on PATH — install git (https://git-scm.com) and retry',

  'agent.timeout': 'agent timed out after {s}s — raise it with --timeout <seconds>',
  'agent.exitCode': 'agent command exited with code {code}',
  'agent.noneFound':
    "no supported agent CLI found on PATH (looked for: {bins}) — pass one with --agent '<command>' (it receives the full prompt on stdin and must print the review JSON on stdout)",
  'agent.noJsonReview': 'the agent did not return a JSON review (raw output saved to .codesema/agent-output.txt)',

  'prep.detachedHead': 'detached HEAD — checkout the branch you want reviewed first, or pass --branch <name>',
  'prep.branchNotFound': '--branch {branch}: local branch not found',
  'prep.targetFlagNotFound': '--target {flag}: branch not found (neither local nor origin/{flag})',
  'prep.noTarget': 'could not detect the target branch — pass it explicitly with --target <branch>',
  'prep.targetIsSelf': '"{branch}" is the target branch itself — pick your feature branch, or pass --target <branch>',
  'prep.noMergeBase': 'no merge-base between {target} and {branch} — pass another base with --target <branch>',
  'prep.emptyDiff': 'empty diff between {target} and {branch} — nothing to review.{hint}',
  'prep.dirtyHint': ' Your working tree has uncommitted changes: commit them first, codesema reviews committed work.',
  'prep.title': 'codesema prep',
  'prep.label.branch': 'branch',
  'prep.label.target': 'target',
  'prep.label.files': 'files',
  'prep.label.commits': 'commits',
  'prep.label.custom': 'custom',
  'prep.label.input': 'input',
  'prep.customNote': '.codesema/PROMPT.md merged into instructions',
  'prep.label.rules': 'rules',
  'prep.rulesNote': '{n} team rule from .codesema/RULES.md | {n} team rules from .codesema/RULES.md',
  'prep.next': 'Next: have your AI agent write .codesema/review.json (see the codesema skill), then run `codesema show`.',

  'review.trustTitle': 'This repository provides its own review agent command:',
  'review.trustWarning': 'It runs on your machine, in your shell. Approve it only if you trust this repo.',
  'review.trustQuestion': 'Run this repo-provided agent command?',
  'review.trustCancel': 'Cancel',
  'review.trustCancelHint': 'do not run',
  'review.trustApprove': 'Approve and run',
  'review.trustApproveHint': 'remembered for this repo',
  'review.trustAborted': 'aborted — repo-provided agent not approved',
  'review.repoAgentUnattended':
    "this repository ships its own agent command via .codesema/config.json ({command}) — refusing to run it unattended. Approve it once in an interactive terminal, or pass --agent '<command>' explicitly.",
  'review.files': '{n} file | {n} files',
  'review.commits': '{n} commit | {n} commits',
  'review.findingCount': '{n} finding | {n} findings',
  'review.modeIncremental': 'incremental',
  'review.modeIncrementalHint': '· updating the review done at {sha} · pass --full to start over',
  'review.modeDual': 'dual · two reviewers + a judge',
  'review.dualLaneA': 'reviewer',
  'review.dualLaneB': 'prosecutor',
  'review.dualJudging': 'deliberation · {n} notes on the bench',
  'review.dualJudgeProgress': 'deliberation · {done}/{total} adjudicated',
  'review.dualStats': 'dual review: {merged} merged · {rejected} rejected by the judge · {added} added by the prosecutor',
  'review.dualConsensus': '{n} note raised by both reviewers | {n} notes raised by both reviewers',
  'review.coverageGap': '⚠ {lane} did not examine {n} file(s): {files}',
  'review.dualReviewerFailed': 'one reviewer failed ({message}); finished with the surviving review',
  'review.dualJudgeFailed': 'judge unusable ({message}); kept the union of both reviews',
  'review.customPrompt': 'custom instructions from .codesema/PROMPT.md merged into the agent prompt',
  'review.teamRules': '{n} team rule from .codesema/RULES.md drives the hunt pass | {n} team rules from .codesema/RULES.md drive the hunt pass',
  'review.webLiveHint': '· live, findings appear as the agent works',
  'review.spinner': 'reviewing with {cmd}',
  'review.runFailed': 'agent run failed',
  'review.runFailedDetail': 'agent run failed: {message}',
  'review.stillUp': '{url} still up · Ctrl+C to stop',
  'review.gateFailed': 'CI gate failed: {reason}',
  'review.gateReasonSeverity': '{n} finding(s) at or above {level}',
  'review.gateReasonVerdict': 'changes requested',
  'review.unusableOutput': 'unusable agent output',
  'review.groundedDropped': '{n} finding dropped: file not in the diff | {n} findings dropped: file not in the diff',
  'review.groundedDeanchored': '{n} line anchor removed: line outside the diff | {n} line anchors removed: lines outside the diff',
  'review.groundedMerged': '{n} duplicate finding merged | {n} duplicate findings merged',
  'review.groundedVerdict': 'verdict escalated to request_changes: critical finding on an approve',
  'review.ready': 'review ready',
  'review.ctrlc': 'Ctrl+C to stop',
  'review.syncHint': 'codesema sync  saves this review to your codesema.com workspace',
  'review.syncPushed': '☁ review synced to your linked codesema.com workspace',
  'review.syncAlready': '☁ review already synced (identical content)',
  'review.syncBlockedSecrets': '☁ sync skipped: {n} potential secret(s) in the diff · codesema sync --force to override',
  'review.syncFailed': '☁ sync failed: {message} · the review stays archived locally',

  'notify.failedRun': 'review failed: agent run failed',
  'notify.failedOutput': 'review failed: unusable agent output',
  'notify.ready': 'review ready · {findings} · {verdict}',

  'field.branch': 'branch',
  'field.changes': 'changes',
  'field.mode': 'mode',
  'field.prompt': 'prompt',
  'field.rules': 'rules',
  'field.web': 'web',
  'field.archived': 'archived',
  'field.verdict': 'verdict',
  'field.findings': 'findings',
  'field.status': 'status',
  'field.account': 'account',

  'wizard.firstRun': 'First run — pick the agent that will review your code.',
  'wizard.firstRunHint': 'Saved once, for every repo. Change it anytime with `codesema config`.',
  'wizard.notOnPath': 'not found on PATH: {bins}',
  'wizard.whichAgent': 'Which AI agent runs the review?',
  'wizard.current': 'current',
  'wizard.customCommand': 'Custom command',
  'wizard.stdinStdout': 'stdin → stdout',
  'wizard.fullCommandTitle': 'Full agent command',
  'wizard.fullCommandPlaceholder': 'reads the prompt on stdin, prints the review JSON on stdout',
  'wizard.modelFor': 'Model for {label}?',
  'wizard.cliDefault': 'CLI default',
  'wizard.letDecide': 'let {bin} decide',
  'wizard.otherOption': 'Other…',
  'wizard.typeModelName': 'type a model name',
  'wizard.modelName': 'Model name',
  'wizard.effort': 'Reasoning effort?',
  'wizard.saved': 'saved: {path}',

  'config.notInteractive': '`codesema config` is interactive — run it from a terminal, or edit the config file directly',
  'config.currentAgent': 'current agent: {command}',
  'config.fromPath': 'from {path}',
  'config.saveWhere': 'Save where?',
  'config.everywhere': 'Everywhere',
  'config.everywhereHint': 'global config, all repos',
  'config.thisRepo': 'This repo only',
  'config.thisRepoHint': '.codesema/config.json, overrides global',
  'config.agentSaved': 'agent command saved: {command}',
  'config.savedTo': 'config: {path}',
  'config.menuTitle': 'What do you want to configure?',
  'config.agentEntry': 'Agent & model',
  'config.agentEntryUnset': 'not configured yet',
  'config.languageEntry': 'Language',
  'config.languageAuto': 'auto-detected',
  'config.autoSyncEntry': 'Auto-sync of completed reviews',
  'config.autoSyncOn': 'on',
  'config.autoSyncOff': 'off',
  'config.autoSyncUnset': 'not chosen yet (asked after the first `codesema sync`)',
  'config.autoSyncQuestion': 'Push every completed review to your codesema.com workspace automatically?',
  'config.autoSyncSaved': 'auto-sync {state}: {path}',
  'config.back': 'Back',
  'config.languageSaved': 'language saved: {path}',

  'tui.typeToFilter': 'type to filter',
  'tui.noMatch': 'no match — backspace to clear the filter',
  'tui.keysWithFilter': '↑↓ move · enter select · esc cancel',
  'tui.keys': '↑↓ move · enter select · esc cancel · 1-9 pick',
  'tui.cancelled': 'cancelled',
  'tui.moreUp': '↑ {n} more',
  'tui.moreDown': '↓ {n} more',
  'tui.confirmHint': '(yes/no)',
  'tui.yes': 'yes',
  'tui.no': 'no',

  'upgrade.available': 'A new version {latest} of codesema is available!',
  'upgrade.question': 'Do you want to upgrade codesema now?',
  'upgrade.running': 'Running {command} ...',
  'upgrade.done': 'codesema upgraded to {latest}',
  'upgrade.failed': 'upgrade failed: run {command} manually',
  'ui.phaseReading': 'reading the diff…',
  'ui.phaseCalls': 'following the call chains…',
  'ui.phaseGrouping': 'grouping changes into steps…',
  'ui.phaseRisks': 'weighing the risks…',
  'ui.phaseStory': 'writing the story…',
  'ui.phasePraise': 'collecting praise…',
  'ui.phaseSharpening': 'sharpening the findings…',
  'ui.progressStep': 'step {n}: {title}',
  'ui.progressFindings': '{n} finding drafted | {n} findings drafted',
  'ui.progressVerdict': 'verdict {verdict} · drafting findings',

  'summary.none': 'none',
  'summary.checkFirst': 'check first',
  'summary.praiseCount': '{n} praise',
  'summary.sevCritical': '{n} critical',
  'summary.sevMajor': '{n} major',
  'summary.sevMinor': '{n} minor',
  'summary.sevInfo': '{n} info',

  'verdict.approve': 'approve',
  'verdict.request_changes': 'request_changes',
  'verdict.comment': 'comment',

  'risk.high': 'high',
  'risk.medium': 'medium',
  'risk.low': 'low',

  'branches.pick': 'Review which branch?',

  'show.archived': 'review archived: {path}',
  'show.lastArchived': 'showing last archived review: {path}',

  'serve.noWebUi': 'embedded web UI not found at {path}: broken install or build',
  'serve.noFreePort': 'no free port between {start} and {end}',

  'record.invalidJson': '{path} is not valid JSON — the agent output must be a single JSON object',
  'record.noInput': '.codesema/input.json not found — run `codesema prep` first',
  'record.reviewNotFound': 'review file not found: {path}',
  'record.nothingToShow': 'no review to show — run `codesema prep`, let your agent write .codesema/review.json, then retry',

  'export.verdictApprove': 'Approved ✅',
  'export.verdictChanges': 'Changes requested ❌',
  'export.verdictComment': 'Comment 💬',
  'export.title': 'Review — {branch} → {target}',
  'export.verdictLabel': 'Verdict',
  'export.createdLabel': 'Created',
  'export.commitsLabel': 'Commits',
  'export.findingsLabel': 'Findings',
  'export.summary': 'Summary',
  'export.intent': 'Intent',
  'export.confidence': 'confidence',
  'export.prologue': 'Prologue',
  'export.why': 'Why',
  'export.what': 'What',
  'export.reviewFirst': 'Review first',
  'export.steps': 'Steps',
  'export.risk': '{risk} risk',
  'export.toVerify': 'To verify',
  'export.files': 'Files',
  'export.findingsRefs': 'Findings',
  'export.exported': 'review exported: {outPath} (from {sourcePath})',

  'sync.firstRunTitle': 'Sync this review to codesema.com?',
  'sync.firstRunDetail':
    'This sends the review record (including the diff) to {url}. An anonymous workspace is created; no account needed. Run `codesema sync delete` anytime to erase everything.',
  'sync.firstRunQuestion': 'Create an anonymous workspace and sync?',
  'sync.firstRunCancel': 'No, stay local',
  'sync.firstRunAccept': 'Yes, sync this review',
  'sync.autoPushQuestion': 'Also push future reviews automatically?',
  'sync.autoPushDecline': 'No, I will sync manually',
  'sync.autoPushAccept': 'Yes, push every completed review',
  'sync.autoPushAcceptHint': 'every repo on this machine, diff included',
  'sync.aborted': 'Sync cancelled: everything stays local.',
  'sync.pushed': 'Review of {branch} synced.',
  'sync.alreadySynced': 'Review of {branch} was already synced (no duplicate created).',
  'sync.statusNew': 'new',
  'sync.statusExisting': 'already synced',
  'sync.secretsBlocked': 'refusing to sync: the diff looks like it contains secrets',
  'sync.secretFilenameTag': 'sensitive filename',
  'sync.secretsHint': 'remove them from the diff, or pass --force to sync anyway',
  'sync.secretsForced': 'secrets detected in the diff, syncing anyway (--force)',
  'sync.linkHint':
    'Tip: run `codesema link` to attach this workspace to a codesema.com account and see your reviews online.',
  'sync.linked': 'Workspace linked to your account on {url}.',
  'sync.linkBrowserOpen': 'Confirm the link in your browser:',
  'sync.linkWaiting': 'Waiting for the confirmation in the browser… (Ctrl+C to cancel)',
  'sync.linkFailed': 'Link not confirmed.',
  'sync.linkExpired': 'the link request expired before being confirmed: run `codesema link` again',
  'sync.deleted': 'All synced data deleted and local credentials cleared.',
  'sync.noCredentials': 'no synced workspace on this machine (run `codesema sync` first)',
  'sync.nonInteractiveSetup': 'sync is not set up: run `codesema sync` once in an interactive terminal to opt in',
  'sync.unknownAction': 'unknown sync action: {action} (expected `codesema sync` or `codesema sync delete`)',
  'sync.unreachable': 'could not reach {url}: check your connection or CODESEMA_SYNC_URL',
  'sync.badResponse': 'unexpected response from {url}: required fields are missing or invalid',

  'menu.title': 'What do you want to do?',
  'menu.review': 'Simple review',
  'menu.reviewHint': 'pick a branch and start a review',
  'menu.dualReview': 'Dual review',
  'menu.dualReviewHint': 'two reviewers in parallel, a judge merges their notes',
  'menu.show': 'Show last review',
  'menu.showHint': 'open the last review in the local web UI',
  'menu.sync': 'Sync',
  'menu.syncHintPush': 'push the latest review',
  'menu.syncHintSetup': 'not set up yet',
  'menu.link': 'Link account',
  'menu.linkHint': 'confirm in the browser to attach this workspace to your account',
  'menu.syncDelete': 'Delete synced data',
  'menu.syncDeleteHint': 'erase everything from codesema.com',
  'menu.syncDeleteConfirm': 'Delete all synced data?',
  'menu.syncDeleteConfirmCancel': 'Cancel',
  'menu.syncDeleteConfirmDelete': 'Delete everything',
  'menu.syncDeleteConfirmDeleteHint': 'cannot be undone',
  'menu.config': 'Config',
  'menu.configHint': 'change language, agent, model and effort',
  'menu.quit': 'Quit',
  'menu.needRepo': 'run codesema inside a git repository',
  'menu.notInRepo': 'not inside a git repository: cd into your project first',
  'menu.cloud': 'Cloud',
  'menu.cloudTitle': 'Cloud · codesema.com',
  'menu.cloudHintActive': 'workspace connected',
  'menu.cloudHintSetup': 'sync your reviews to codesema.com',
  'menu.back': 'Back',
}

export type MessageKey = keyof typeof en

const fr: Record<MessageKey, string> = {
  'cli.help': `codesema : revue de merge request locale, étape par étape

Usage :
  codesema                            Ouvre un menu interactif (review, show, sync, link, config)
                                      dans un terminal interactif ; se comporte comme \`review\` sinon.
                                      Choisissez une branche locale, l'UI web s'ouvre immédiatement et
                                      se remplit en direct pendant que votre agent IA travaille. Premier
                                      lancement uniquement : un court assistant choisit la langue,
                                      l'agent, le modèle et l'effort (sauvegardés globalement,
                                      modifiables avec \`codesema config\`)
  codesema review [--branch <nom>] [--target <branche>] [--agent <cmd>] [--full] [--no-open]
                                      Même flux ; --branch saute le sélecteur de branche (sauté
                                      aussi quand stdin n'est pas un terminal, ex. CI). Relancer
                                      sur la même branche met à jour la revue précédente de façon
                                      incrémentale ; --full force une revue complète
  codesema config                     Changer la langue, l'agent IA, le modèle, l'effort et l'auto-sync (interactif)
  codesema prep [--target <branche>]  Détecte seulement les branches, calcule le diff de la MR,
                                      écrit .codesema/input.json pour votre propre flux d'agent
  codesema show [--review <fichier>]  Affiche seulement une revue (sortie d'agent) dans l'UI web locale
  codesema export [--review <fichier>] [--out <fichier>]
                                      Exporte la revue en Markdown (--out - pour stdout)
  codesema sync              Pousse la dernière review vers votre workspace codesema.com
  codesema sync delete       Supprime toutes les données synchronisées (workspaces non rattachés)
  codesema link [code]       Rattache ce workspace à votre compte codesema.com (sans code : confirmation navigateur)

Options :
  --branch <nom>      Branche locale à passer en revue (défaut : sélecteur interactif, sinon branche courante)
  --target <branche>  Branche cible de la MR (défaut : auto-détectée via glab/gh, origin/HEAD, puis heuristique)
  --agent <cmd>       Commande d'agent pour ce lancement. Reçoit le prompt sur stdin,
                      doit afficher le JSON de la revue sur stdout
  --review <fichier>  Sortie d'agent à afficher (défaut : .codesema/review.json, sinon dernière revue archivée)
  --port <n>          Port préféré du serveur local (défaut : 4400)
  --timeout <s>       Budget de temps de l'agent en secondes pour \`review\` (défaut : 900)
  --full              Revue complète au lieu de mettre à jour la revue précédente
  --dual              Revue duale : deux reviewers indépendants en parallèle (même agent,
                      angles différents), puis un modèle juge fusionne leurs notes
  --no-open           Ne pas ouvrir le navigateur
  -h, --help          Afficher cette aide
  -v, --version       Afficher la version

Priorité de config : flags CLI > .codesema/config.json (repo) > ~/.config/codesema/config.json (globale).

\`review\` et \`show\` interrogent une fois le registre npm au démarrage pour signaler qu'une nouvelle
version existe (rien n'est envoyé). CODESEMA_NO_UPDATE_CHECK=1 pour désactiver.
`,
  'cli.unknownCommand': 'commande inconnue : {command}',
  'cli.intFlagError': '--{name} {raw} : entier attendu entre {min} et {max}',
  'cli.failOnError': '--fail-on {raw} invalide : attendu l\'un de {values}',

  'git.notFound': 'git introuvable sur le PATH : installez git (https://git-scm.com) et réessayez',

  'agent.timeout': "délai de l'agent dépassé après {s}s : augmentez-le avec --timeout <secondes>",
  'agent.exitCode': "la commande d'agent a quitté avec le code {code}",
  'agent.noneFound':
    "aucune CLI d'agent trouvée sur le PATH (recherchées : {bins}) : passez-en une avec --agent '<commande>' (elle reçoit le prompt complet sur stdin et doit afficher le JSON de la revue sur stdout)",
  'agent.noJsonReview': "l'agent n'a pas renvoyé de revue JSON (sortie brute sauvegardée dans .codesema/agent-output.txt)",

  'prep.detachedHead': 'HEAD détachée : positionnez-vous d\'abord sur la branche à passer en revue, ou passez --branch <nom>',
  'prep.branchNotFound': '--branch {branch} : branche locale introuvable',
  'prep.targetFlagNotFound': '--target {flag} : branche introuvable (ni locale ni origin/{flag})',
  'prep.noTarget': 'impossible de détecter la branche cible : passez-la explicitement avec --target <branche>',
  'prep.targetIsSelf': '"{branch}" est la branche cible elle-même : choisissez votre branche de feature, ou passez --target <branche>',
  'prep.noMergeBase': 'pas de merge-base entre {target} et {branch} : passez une autre base avec --target <branche>',
  'prep.emptyDiff': 'diff vide entre {target} et {branch} : rien à passer en revue.{hint}',
  'prep.dirtyHint': ' Votre working tree a des changements non commités : commitez-les d\'abord, codesema passe en revue le travail commité.',
  'prep.title': 'codesema prep',
  'prep.label.branch': 'branche',
  'prep.label.target': 'cible',
  'prep.label.files': 'fichiers',
  'prep.label.commits': 'commits',
  'prep.label.custom': 'custom',
  'prep.label.input': 'entrée',
  'prep.customNote': '.codesema/PROMPT.md fusionné dans les instructions',
  'prep.label.rules': 'règles',
  'prep.rulesNote': '{n} règle d\'équipe depuis .codesema/RULES.md | {n} règles d\'équipe depuis .codesema/RULES.md',
  'prep.next': 'Ensuite : faites écrire .codesema/review.json à votre agent IA (voir le skill codesema), puis lancez `codesema show`.',

  'review.trustTitle': 'Ce dépôt fournit sa propre commande d\'agent de revue :',
  'review.trustWarning': 'Elle s\'exécute sur votre machine, dans votre shell. Approuvez-la seulement si vous faites confiance à ce dépôt.',
  'review.trustQuestion': 'Exécuter cette commande d\'agent fournie par le dépôt ?',
  'review.trustCancel': 'Annuler',
  'review.trustCancelHint': 'ne pas exécuter',
  'review.trustApprove': 'Approuver et exécuter',
  'review.trustApproveHint': 'mémorisé pour ce dépôt',
  'review.trustAborted': 'abandon : agent fourni par le dépôt non approuvé',
  'review.repoAgentUnattended':
    "ce dépôt fournit sa propre commande d'agent via .codesema/config.json ({command}) : refus de l'exécuter sans supervision. Approuvez-la une fois dans un terminal interactif, ou passez --agent '<commande>' explicitement.",
  'review.files': '{n} fichier | {n} fichiers',
  'review.commits': '{n} commit | {n} commits',
  'review.findingCount': '{n} note | {n} notes',
  'review.modeIncremental': 'incrémental',
  'review.modeIncrementalHint': '· mise à jour de la revue faite à {sha} · passez --full pour repartir de zéro',
  'review.modeDual': 'duale · deux reviewers + un juge',
  'review.dualLaneA': 'reviewer',
  'review.dualLaneB': 'procureur',
  'review.dualJudging': 'délibération · {n} notes à arbitrer',
  'review.dualJudgeProgress': 'délibération · {done}/{total} arbitrées',
  'review.dualStats': 'revue duale : {merged} fusionnées · {rejected} rejetées par le juge · {added} ajoutées par le procureur',
  'review.dualConsensus': '{n} note relevée par les deux reviewers | {n} notes relevées par les deux reviewers',
  'review.coverageGap': '⚠ {lane} n\'a pas examiné {n} fichier(s) : {files}',
  'review.dualReviewerFailed': 'un reviewer a échoué ({message}) ; la revue survivante a été utilisée',
  'review.dualJudgeFailed': 'juge inutilisable ({message}) ; union des deux revues conservée',
  'review.customPrompt': 'instructions personnalisées de .codesema/PROMPT.md fusionnées dans le prompt de l\'agent',
  'review.teamRules': '{n} règle d\'équipe de .codesema/RULES.md guide la passe de chasse | {n} règles d\'équipe de .codesema/RULES.md guident la passe de chasse',
  'review.webLiveHint': '· en direct, les notes apparaissent pendant que l\'agent travaille',
  'review.spinner': 'revue avec {cmd}',
  'review.runFailed': 'échec de l\'agent',
  'review.runFailedDetail': 'échec de l\'agent : {message}',
  'review.stillUp': '{url} toujours actif · Ctrl+C pour arrêter',
  'review.gateFailed': 'gate CI échoué : {reason}',
  'review.gateReasonSeverity': '{n} finding(s) au niveau {level} ou supérieur',
  'review.gateReasonVerdict': 'changements demandés',
  'review.unusableOutput': 'sortie d\'agent inutilisable',
  'review.groundedDropped': '{n} finding écarté : fichier absent du diff | {n} findings écartés : fichier absent du diff',
  'review.groundedDeanchored': '{n} ancre de ligne retirée : ligne hors du diff | {n} ancres de ligne retirées : lignes hors du diff',
  'review.groundedMerged': '{n} finding doublon fusionné | {n} findings doublons fusionnés',
  'review.groundedVerdict': 'verdict passé à request_changes : finding critique sur un approve',
  'review.ready': 'revue prête',
  'review.ctrlc': 'Ctrl+C pour arrêter',
  'review.syncHint': 'codesema sync  enregistre cette review dans votre workspace codesema.com',
  'review.syncPushed': '☁ revue synchronisée sur votre workspace codesema.com lié',
  'review.syncAlready': '☁ revue déjà synchronisée (contenu identique)',
  'review.syncBlockedSecrets': '☁ synchro ignorée : {n} secret(s) potentiel(s) dans la diff · codesema sync --force pour forcer',
  'review.syncFailed': '☁ échec de la synchro : {message} · la revue reste archivée en local',

  'notify.failedRun': 'échec de la revue : échec de l\'agent',
  'notify.failedOutput': 'échec de la revue : sortie d\'agent inutilisable',
  'notify.ready': 'revue prête · {findings} · {verdict}',

  'field.branch': 'branche',
  'field.changes': 'modifs',
  'field.mode': 'mode',
  'field.prompt': 'prompt',
  'field.rules': 'règles',
  'field.web': 'web',
  'field.archived': 'archivée',
  'field.verdict': 'verdict',
  'field.findings': 'notes',
  'field.status': 'statut',
  'field.account': 'compte',

  'wizard.firstRun': 'Premier lancement : choisissez l\'agent qui fera la revue de votre code.',
  'wizard.firstRunHint': 'Sauvegardé une fois, pour tous les dépôts. Modifiable à tout moment avec `codesema config`.',
  'wizard.notOnPath': 'introuvable sur le PATH : {bins}',
  'wizard.whichAgent': 'Quel agent IA fait la revue ?',
  'wizard.current': 'actuel',
  'wizard.customCommand': 'Commande personnalisée',
  'wizard.stdinStdout': 'stdin → stdout',
  'wizard.fullCommandTitle': 'Commande d\'agent complète',
  'wizard.fullCommandPlaceholder': 'lit le prompt sur stdin, affiche le JSON de la revue sur stdout',
  'wizard.modelFor': 'Modèle pour {label} ?',
  'wizard.cliDefault': 'Défaut CLI',
  'wizard.letDecide': 'laisser {bin} décider',
  'wizard.otherOption': 'Autre…',
  'wizard.typeModelName': 'saisir un nom de modèle',
  'wizard.modelName': 'Nom du modèle',
  'wizard.effort': 'Effort de raisonnement ?',
  'wizard.saved': 'sauvegardé : {path}',

  'config.notInteractive': '`codesema config` est interactif : lancez-le depuis un terminal, ou éditez directement le fichier de config',
  'config.currentAgent': 'agent actuel : {command}',
  'config.fromPath': 'depuis {path}',
  'config.saveWhere': 'Sauvegarder où ?',
  'config.everywhere': 'Partout',
  'config.everywhereHint': 'config globale, tous les dépôts',
  'config.thisRepo': 'Ce dépôt uniquement',
  'config.thisRepoHint': '.codesema/config.json, prime sur la globale',
  'config.agentSaved': 'commande d\'agent sauvegardée : {command}',
  'config.savedTo': 'config : {path}',
  'config.menuTitle': 'Que voulez-vous configurer ?',
  'config.agentEntry': 'Agent & modèle',
  'config.agentEntryUnset': 'pas encore configuré',
  'config.languageEntry': 'Langue',
  'config.languageAuto': 'auto-détectée',
  'config.autoSyncEntry': 'Auto-sync des reviews terminées',
  'config.autoSyncOn': 'activé',
  'config.autoSyncOff': 'désactivé',
  'config.autoSyncUnset': 'pas encore choisi (proposé après le premier `codesema sync`)',
  'config.autoSyncQuestion': 'Pousser automatiquement chaque review terminée vers votre workspace codesema.com ?',
  'config.autoSyncSaved': 'auto-sync {state} : {path}',
  'config.back': 'Retour',
  'config.languageSaved': 'langue enregistrée : {path}',

  'tui.typeToFilter': 'tapez pour filtrer',
  'tui.noMatch': 'aucun résultat : retour arrière pour effacer le filtre',
  'tui.keysWithFilter': '↑↓ naviguer · entrée valider · échap annuler',
  'tui.keys': '↑↓ naviguer · entrée valider · échap annuler · 1-9 choisir',
  'tui.cancelled': 'annulé',
  'tui.moreUp': '↑ {n} de plus',
  'tui.moreDown': '↓ {n} de plus',
  'tui.confirmHint': '(oui/non)',
  'tui.yes': 'oui',
  'tui.no': 'non',

  'upgrade.available': 'Une nouvelle version {latest} de codesema est disponible !',
  'upgrade.question': 'Voulez-vous mettre à jour codesema maintenant ?',
  'upgrade.running': 'Exécution de {command} ...',
  'upgrade.done': 'codesema mis à jour en {latest}',
  'upgrade.failed': 'échec de la mise à jour : lancez {command} manuellement',
  'ui.phaseReading': 'lecture du diff…',
  'ui.phaseCalls': 'suivi des chaînes d\'appel…',
  'ui.phaseGrouping': 'regroupement des changements en étapes…',
  'ui.phaseRisks': 'évaluation des risques…',
  'ui.phaseStory': 'écriture du récit…',
  'ui.phasePraise': 'collecte des éloges…',
  'ui.phaseSharpening': 'affûtage des notes…',
  'ui.progressStep': 'étape {n} : {title}',
  'ui.progressFindings': '{n} note rédigée | {n} notes rédigées',
  'ui.progressVerdict': 'verdict {verdict} · rédaction des notes',

  'summary.none': 'aucune',
  'summary.checkFirst': 'à vérifier d\'abord',
  'summary.praiseCount': '{n} éloge | {n} éloges',
  'summary.sevCritical': '{n} critique | {n} critiques',
  'summary.sevMajor': '{n} majeure | {n} majeures',
  'summary.sevMinor': '{n} mineure | {n} mineures',
  'summary.sevInfo': '{n} info | {n} infos',

  'verdict.approve': 'approuvée',
  'verdict.request_changes': 'changements demandés',
  'verdict.comment': 'commentaire',

  'risk.high': 'élevé',
  'risk.medium': 'moyen',
  'risk.low': 'faible',

  'branches.pick': 'Quelle branche passer en revue ?',

  'show.archived': 'revue archivée : {path}',
  'show.lastArchived': 'affichage de la dernière revue archivée : {path}',

  'serve.noWebUi': 'UI web embarquée introuvable dans {path} : installation ou build cassé',
  'serve.noFreePort': 'aucun port libre entre {start} et {end}',

  'record.invalidJson': '{path} n\'est pas du JSON valide : la sortie de l\'agent doit être un unique objet JSON',
  'record.noInput': '.codesema/input.json introuvable : lancez d\'abord `codesema prep`',
  'record.reviewNotFound': 'fichier de revue introuvable : {path}',
  'record.nothingToShow': 'aucune revue à afficher : lancez `codesema prep`, laissez votre agent écrire .codesema/review.json, puis réessayez',

  'export.verdictApprove': 'Approuvée ✅',
  'export.verdictChanges': 'Changements demandés ❌',
  'export.verdictComment': 'Commentaire 💬',
  'export.title': 'Revue : {branch} → {target}',
  'export.verdictLabel': 'Verdict',
  'export.createdLabel': 'Créée',
  'export.commitsLabel': 'Commits',
  'export.findingsLabel': 'Notes',
  'export.summary': 'Résumé',
  'export.intent': 'Intention',
  'export.confidence': 'confiance',
  'export.prologue': 'Prologue',
  'export.why': 'Pourquoi',
  'export.what': 'Quoi',
  'export.reviewFirst': 'À vérifier en premier',
  'export.steps': 'Étapes',
  'export.risk': 'risque {risk}',
  'export.toVerify': 'À vérifier',
  'export.files': 'Fichiers',
  'export.findingsRefs': 'Notes',
  'export.exported': 'revue exportée : {outPath} (depuis {sourcePath})',

  'sync.firstRunTitle': 'Synchroniser cette review vers codesema.com ?',
  'sync.firstRunDetail':
    'Ceci envoie le review record (diff inclus) vers {url}. Un workspace anonyme est créé, aucun compte requis. `codesema sync delete` efface tout à tout moment.',
  'sync.firstRunQuestion': 'Créer un workspace anonyme et synchroniser ?',
  'sync.firstRunCancel': 'Non, rester en local',
  'sync.firstRunAccept': 'Oui, synchroniser cette review',
  'sync.autoPushQuestion': 'Pousser aussi les prochaines reviews automatiquement ?',
  'sync.autoPushDecline': 'Non, je synchroniserai manuellement',
  'sync.autoPushAccept': 'Oui, pousser chaque review terminée',
  'sync.autoPushAcceptHint': 'tous les dépôts de cette machine, diff inclus',
  'sync.aborted': 'Sync annulée : tout reste en local.',
  'sync.pushed': 'Review de {branch} synchronisée.',
  'sync.alreadySynced': 'Review de {branch} déjà synchronisée (pas de doublon créé).',
  'sync.statusNew': 'nouvelle',
  'sync.statusExisting': 'déjà synchronisée',
  'sync.secretsBlocked': 'synchronisation refusée : le diff semble contenir des secrets',
  'sync.secretFilenameTag': 'nom de fichier sensible',
  'sync.secretsHint': 'retirez-les du diff, ou passez --force pour synchroniser quand même',
  'sync.secretsForced': 'secrets détectés dans le diff, synchronisation quand même (--force)',
  'sync.linkHint':
    'Astuce : lancez `codesema link` pour rattacher ce workspace à un compte codesema.com et retrouver vos reviews en ligne.',
  'sync.linked': 'Workspace rattaché à votre compte sur {url}.',
  'sync.linkBrowserOpen': 'Confirmez le rattachement dans votre navigateur :',
  'sync.linkWaiting': 'En attente de la confirmation dans le navigateur… (Ctrl+C pour annuler)',
  'sync.linkFailed': 'Rattachement non confirmé.',
  'sync.linkExpired': 'la demande de rattachement a expiré avant d\'être confirmée : relancez `codesema link`',
  'sync.deleted': 'Données synchronisées supprimées et credentials locaux effacés.',
  'sync.noCredentials': 'aucun workspace synchronisé sur cette machine (lancez `codesema sync` d\'abord)',
  'sync.nonInteractiveSetup': 'sync non configuré : lancez `codesema sync` une fois dans un terminal interactif pour l\'activer',
  'sync.unknownAction': 'action sync inconnue : {action} (attendu `codesema sync` ou `codesema sync delete`)',
  'sync.unreachable': 'impossible de joindre {url} : vérifiez votre connexion ou CODESEMA_SYNC_URL',
  'sync.badResponse': 'réponse inattendue de {url} : champs requis manquants ou invalides',

  'menu.title': 'Que voulez-vous faire ?',
  'menu.review': 'Revue simple',
  'menu.reviewHint': 'choisir une branche et démarrer une revue',
  'menu.dualReview': 'Revue duale',
  'menu.dualReviewHint': 'deux reviewers en parallèle, un juge fusionne leurs notes',
  'menu.show': 'Afficher la dernière revue',
  'menu.showHint': 'ouvrir la dernière revue dans l\'UI web locale',
  'menu.sync': 'Synchroniser',
  'menu.syncHintPush': 'pousser la dernière revue',
  'menu.syncHintSetup': 'pas encore configuré',
  'menu.link': 'Rattacher le compte',
  'menu.linkHint': 'confirmer dans le navigateur pour rattacher ce workspace à votre compte',
  'menu.syncDelete': 'Supprimer les données synchronisées',
  'menu.syncDeleteHint': 'efface tout sur codesema.com',
  'menu.syncDeleteConfirm': 'Supprimer toutes les données synchronisées ?',
  'menu.syncDeleteConfirmCancel': 'Annuler',
  'menu.syncDeleteConfirmDelete': 'Tout supprimer',
  'menu.syncDeleteConfirmDeleteHint': 'irréversible',
  'menu.config': 'Configuration',
  'menu.configHint': 'changer la langue, l\'agent, le modèle et l\'effort',
  'menu.quit': 'Quitter',
  'menu.needRepo': 'à lancer dans un repo git',
  'menu.notInRepo': 'pas dans un repo git : placez-vous d\'abord dans votre projet',
  'menu.cloud': 'Cloud',
  'menu.cloudTitle': 'Cloud · codesema.com',
  'menu.cloudHintActive': 'workspace connecté',
  'menu.cloudHintSetup': 'synchronisez vos reviews sur codesema.com',
  'menu.back': 'Retour',
}

const CATALOGS = { en, fr } satisfies Record<string, Record<MessageKey, string>>

/** ISO 639-1 codes of the languages codesema ships catalogs for. */
export type SupportedLanguage = keyof typeof CATALOGS

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && value in CATALOGS
}

/** English names the review prompt understands. */
const PROMPT_LANGUAGE_NAMES: Record<SupportedLanguage, string> = { en: 'English', fr: 'French' }

let configured: SupportedLanguage | null = null
let catalog: Record<MessageKey, string> = en

export function setLanguage(value: SupportedLanguage | null | undefined): void {
  configured = value ?? null
  catalog = configured ? CATALOGS[configured] : en
}

/** Locale the CLI and web UI render in. */
export function uiLocale(): SupportedLanguage {
  return configured ?? 'en'
}

/**
 * Language the agent must write the review in, null when unconfigured
 * (the prompt then falls back to the commit-message language rule).
 */
export function reviewLanguage(): string | null {
  return configured ? PROMPT_LANGUAGE_NAMES[configured] : null
}

export function t(key: MessageKey, params?: Record<string, unknown>, count?: number): string {
  let msg = catalog[key] ?? en[key]
  if (msg.includes(' | ')) {
    const n = count ?? (typeof params?.n === 'number' ? params.n : undefined)
    const parts = msg.split(' | ')
    msg = (n === 1 ? parts[0] : parts[1] ?? parts[0]) ?? msg
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) msg = msg.replaceAll(`{${k}}`, String(v))
  }
  return msg
}

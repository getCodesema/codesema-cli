/**
 * Conventional Commits, appliqué au `commit-msg` par lefthook.
 *
 * Deux écarts au preset, tous deux calés sur ce que fait RÉELLEMENT ce repo
 * plutôt que sur le défaut :
 *
 *  - `header-max-length` monté à 140. Le défaut du preset est 100, et deux
 *    sujets de l'historique le dépassent déjà (132 et 117 caractères) : ce sont
 *    des sujets descriptifs assumés, pas des accidents. Un plafond qui refuse
 *    la pratique établie du repo serait changé ou contourné dès la première
 *    gêne — 140 reste une vraie borne tout en laissant passer ce qui s'écrit ici.
 *
 *  - `merge` ajouté au `type-enum`. Les merges de contexte sont écrits à la main
 *    sous cette forme (`merge: main into feat/...`) et ne sont PAS attrapés par
 *    les ignores par défaut, qui ne reconnaissent que les formulations de git et
 *    des forges (« Merge pull request », « Merge branch X »).
 *
 * Les commits que codesema génère lui-même sont ignorés, cf. `ignores` ci-dessous.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  /*
   * `task(<id>): <titre> — turn <n>` est le message que le task runner compose
   * lui-même à chaque tour (packages/cli/src/task-runner.ts). Son sujet est le
   * titre de tâche saisi par la personne qui l'a lancée : langue, casse et
   * longueur sont hors de notre contrôle, et un hook qui refuse ces commits
   * casserait l'outil dans son propre dépôt. On les laisse donc passer en bloc
   * plutôt que de tordre les règles qui, elles, s'appliquent aux humains.
   */
  ignores: [(message) => /^task\([0-9a-f]+\): /.test(message)],
  rules: {
    'header-max-length': [2, 'always', 140],
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'merge',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
  },
}

import { loadConfig } from './config.js'
import { tryGit } from './git.js'
import { t } from './i18n.js'
import { review } from './review.js'
import { show } from './show.js'
import { linkCommand, loadSyncCredentials, syncCommand } from './sync.js'
import { select, textInput } from './tui.js'
import { configCommand } from './wizard.js'

export type MenuItemId = 'review' | 'show' | 'sync' | 'link' | 'syncDelete' | 'config' | 'quit'

export type MenuItem = {
  id: MenuItemId
  label: string
  hint: string
}

export type MenuContext = {
  hasSyncCredentials: boolean
  inRepo: boolean
}

export function buildMenuItems(context: MenuContext): MenuItem[] {
  // Repo-scoped actions stay visible outside a repo (hiding the product's main
  // action reads as a regression); the hint says where to run them instead.
  const items: MenuItem[] = [
    { id: 'review', label: t('menu.review'), hint: context.inRepo ? t('menu.reviewHint') : t('menu.needRepo') },
    { id: 'show', label: t('menu.show'), hint: context.inRepo ? t('menu.showHint') : t('menu.needRepo') },
    {
      id: 'sync',
      label: t('menu.sync'),
      hint: !context.inRepo
        ? t('menu.needRepo')
        : context.hasSyncCredentials
          ? t('menu.syncHintPush')
          : t('menu.syncHintSetup'),
    },
  ]
  if (context.hasSyncCredentials) {
    items.push({ id: 'link', label: t('menu.link'), hint: t('menu.linkHint') })
    items.push({ id: 'syncDelete', label: t('menu.syncDelete'), hint: t('menu.syncDeleteHint') })
  }
  items.push({ id: 'config', label: t('menu.config'), hint: t('menu.configHint') })
  items.push({ id: 'quit', label: t('menu.quit'), hint: '' })
  return items
}

export type MenuActions = {
  review: () => Promise<void>
  show: () => Promise<void>
  sync: () => Promise<void>
  link: () => Promise<void>
  syncDelete: () => Promise<void>
  config: () => Promise<void>
}

export function dispatchMenuAction(id: Exclude<MenuItemId, 'quit'>, actions: MenuActions): Promise<void> {
  return actions[id]()
}

/** Actions that report their result and redisplay the menu; review/show block on the local web server. */
const LOOPING_ACTIONS: ReadonlySet<MenuItemId> = new Set(['sync', 'link', 'syncDelete', 'config'])

/** Actions that only make sense inside a git repository. */
const REPO_ACTIONS: ReadonlySet<MenuItemId> = new Set(['review', 'show', 'sync'])

async function confirmSyncDelete(): Promise<boolean> {
  const choice = await select<'cancel' | 'delete'>({
    title: t('menu.syncDeleteConfirm'),
    options: [
      { label: t('menu.syncDeleteConfirmCancel'), hint: '', value: 'cancel' },
      { label: t('menu.syncDeleteConfirmDelete'), hint: t('menu.syncDeleteConfirmDeleteHint'), value: 'delete' },
    ],
    initialIndex: 0,
  })
  return choice === 'delete'
}

function buildActions(cwd: string): MenuActions {
  return {
    review: () => review({ open: true, cwd }),
    show: () => show({ open: true, cwd, port: loadConfig(tryGit(['rev-parse', '--show-toplevel'], cwd)).port }),
    sync: () => syncCommand({ cwd }),
    link: async () => {
      const code = await textInput({ title: t('menu.linkPrompt') })
      if (!code) return
      await linkCommand({ code })
    },
    syncDelete: async () => {
      if (!(await confirmSyncDelete())) return
      await syncCommand({ action: 'delete', cwd })
    },
    config: () => configCommand(tryGit(['rev-parse', '--show-toplevel'], cwd)),
  }
}

export async function runMenu(opts: { cwd: string }): Promise<void> {
  const actions = buildActions(opts.cwd)

  for (;;) {
    const inRepo = tryGit(['rev-parse', '--show-toplevel'], opts.cwd) !== null
    const hasSyncCredentials = loadSyncCredentials() !== null
    const items = buildMenuItems({ hasSyncCredentials, inRepo })

    console.log('')
    const picked = await select<MenuItemId>({
      title: t('menu.title'),
      options: items.map((item) => ({ label: item.label, hint: item.hint, value: item.id })),
    })
    if (picked === null || picked === 'quit') return

    if (REPO_ACTIONS.has(picked) && !inRepo) {
      console.log(`  ${t('menu.notInRepo')}`)
      continue
    }

    if (!LOOPING_ACTIONS.has(picked)) {
      await dispatchMenuAction(picked, actions)
      return
    }

    try {
      await dispatchMenuAction(picked, actions)
    } catch (err) {
      console.error(`codesema: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

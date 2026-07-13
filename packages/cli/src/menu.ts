import { loadConfig } from './config.js'
import { tryGit } from './git.js'
import { t } from './i18n.js'
import { review } from './review.js'
import { show } from './show.js'
import { linkCommand, loadSyncCredentials, syncCommand } from './sync.js'
import { select, textInput } from './tui.js'
import { configCommand } from './wizard.js'

export type MenuItemId = 'review' | 'show' | 'cloud' | 'config' | 'quit'
export type CloudItemId = 'sync' | 'link' | 'syncDelete' | 'back'
export type MenuActionId = 'review' | 'show' | 'sync' | 'link' | 'syncDelete' | 'config'

export type MenuItem<Id extends string> = {
  id: Id
  label: string
  hint: string
}

export type MenuContext = {
  hasSyncCredentials: boolean
  inRepo: boolean
}

export function buildMenuItems(context: MenuContext): MenuItem<MenuItemId>[] {
  // Repo-scoped actions stay visible outside a repo (hiding the product's main
  // action reads as a regression); the hint says where to run them instead.
  return [
    { id: 'review', label: t('menu.review'), hint: context.inRepo ? t('menu.reviewHint') : t('menu.needRepo') },
    { id: 'show', label: t('menu.show'), hint: context.inRepo ? t('menu.showHint') : t('menu.needRepo') },
    {
      id: 'cloud',
      label: t('menu.cloud'),
      hint: context.hasSyncCredentials ? t('menu.cloudHintActive') : t('menu.cloudHintSetup'),
    },
    { id: 'config', label: t('menu.config'), hint: t('menu.configHint') },
    { id: 'quit', label: t('menu.quit'), hint: '' },
  ]
}

export function buildCloudMenuItems(context: MenuContext): MenuItem<CloudItemId>[] {
  const items: MenuItem<CloudItemId>[] = [
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
  items.push({ id: 'back', label: t('menu.back'), hint: '' })
  return items
}

export type MenuActions = Record<MenuActionId, () => Promise<void>>

export function dispatchMenuAction(id: MenuActionId, actions: MenuActions): Promise<void> {
  return actions[id]()
}

function currentContext(cwd: string): MenuContext {
  return {
    inRepo: tryGit(['rev-parse', '--show-toplevel'], cwd) !== null,
    hasSyncCredentials: loadSyncCredentials() !== null,
  }
}

async function confirmSyncDelete(): Promise<boolean> {
  const choice = await select<'cancel' | 'delete'>({
    title: t('menu.syncDeleteConfirm'),
    options: [
      { label: t('menu.syncDeleteConfirmCancel'), hint: '', value: 'cancel' },
      { label: t('menu.syncDeleteConfirmDelete'), hint: t('menu.syncDeleteConfirmDeleteHint'), value: 'delete' },
    ],
    initialIndex: 0,
    summary: false,
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

function printActionError(err: unknown): void {
  console.error(`codesema: ${err instanceof Error ? err.message : String(err)}`)
}

function printNotInRepo(): void {
  console.log('')
  console.log(`  ${t('menu.notInRepo')}`)
  console.log('')
}

/** Cloud submenu: loops on itself after each action; back returns to the main menu. */
async function runCloudMenu(cwd: string, actions: MenuActions): Promise<void> {
  for (;;) {
    const context = currentContext(cwd)
    const items = buildCloudMenuItems(context)
    const picked = await select<CloudItemId>({
      title: t('menu.cloudTitle'),
      options: items.map((item) => ({ label: item.label, hint: item.hint, value: item.id })),
      summary: false,
    })
    if (picked === null || picked === 'back') return

    if (picked === 'sync' && !context.inRepo) {
      printNotInRepo()
      continue
    }

    try {
      await dispatchMenuAction(picked, actions)
    } catch (err) {
      printActionError(err)
    }
    console.log('')
  }
}

export async function runMenu(opts: { cwd: string }): Promise<void> {
  const actions = buildActions(opts.cwd)

  // Menus render with summary: false and erase themselves on selection, so the
  // UI redraws in place instead of stacking one list per navigation step.
  console.log('')
  for (;;) {
    const context = currentContext(opts.cwd)
    const items = buildMenuItems(context)
    const picked = await select<MenuItemId>({
      title: t('menu.title'),
      options: items.map((item) => ({ label: item.label, hint: item.hint, value: item.id })),
      summary: false,
    })
    if (picked === null || picked === 'quit') return

    if ((picked === 'review' || picked === 'show') && !context.inRepo) {
      printNotInRepo()
      continue
    }

    if (picked === 'cloud') {
      await runCloudMenu(opts.cwd, actions)
      continue
    }

    if (picked === 'config') {
      try {
        await dispatchMenuAction(picked, actions)
      } catch (err) {
        printActionError(err)
      }
      console.log('')
      continue
    }

    // review/show block on the local web server: leave the menu loop.
    await dispatchMenuAction(picked, actions)
    return
  }
}

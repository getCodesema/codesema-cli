import { afterEach, describe, expect, test } from 'bun:test'
import { setLanguage, t } from './i18n.js'
import {
  buildCloudMenuItems,
  buildMenuItems,
  dispatchMenuAction,
  reviewFlagsPassed,
  type MenuActionId,
  type MenuActions,
} from './menu.js'

afterEach(() => setLanguage(null))

describe('buildMenuItems', () => {
  test('main menu groups all online actions under a single cloud entry', () => {
    for (const hasSyncCredentials of [true, false]) {
      for (const inRepo of [true, false]) {
        const items = buildMenuItems({ hasSyncCredentials, inRepo })
        expect(items.map((item) => item.id)).toEqual([
          'review',
          'dualReview',
          'show',
          'cloud',
          'config',
          'quit',
        ])
      }
    }
  })

  test('review and show are hinted to run inside a repo when outside one', () => {
    const items = buildMenuItems({ hasSyncCredentials: false, inRepo: false })
    for (const id of ['review', 'dualReview', 'show'] as const) {
      expect(items.find((item) => item.id === id)?.hint).toBe(t('menu.needRepo'))
    }
  })

  test('the cloud hint reflects whether a workspace exists', () => {
    const withCredentials = buildMenuItems({ hasSyncCredentials: true, inRepo: true }).find(
      (i) => i.id === 'cloud',
    )
    const withoutCredentials = buildMenuItems({ hasSyncCredentials: false, inRepo: true }).find(
      (i) => i.id === 'cloud',
    )
    expect(withCredentials?.hint).toBe(t('menu.cloudHintActive'))
    expect(withoutCredentials?.hint).toBe(t('menu.cloudHintSetup'))
  })

  test('quit is always present and always last', () => {
    const items = buildMenuItems({ hasSyncCredentials: true, inRepo: true })
    expect(items.at(-1)?.id).toBe('quit')
    expect(items.filter((item) => item.id === 'quit').length).toBe(1)
  })

  test('labels and hints follow the active i18n catalog', () => {
    setLanguage('fr')
    const items = buildMenuItems({ hasSyncCredentials: true, inRepo: true })
    expect(items.find((i) => i.id === 'review')?.label).toBe(t('menu.review'))
    expect(items.find((i) => i.id === 'cloud')?.label).toBe(t('menu.cloud'))
  })
})

describe('buildCloudMenuItems', () => {
  test('full cloud menu with credentials, back always last', () => {
    const items = buildCloudMenuItems({ hasSyncCredentials: true, inRepo: true })
    expect(items.map((item) => item.id)).toEqual(['sync', 'link', 'syncDelete', 'back'])
  })

  test('link and syncDelete are hidden without credentials', () => {
    const items = buildCloudMenuItems({ hasSyncCredentials: false, inRepo: true })
    expect(items.map((item) => item.id)).toEqual(['sync', 'back'])
  })

  test('sync stays visible outside a repo, hinted to run inside one', () => {
    const items = buildCloudMenuItems({ hasSyncCredentials: true, inRepo: false })
    expect(items.map((item) => item.id)).toEqual(['sync', 'link', 'syncDelete', 'back'])
    expect(items.find((item) => item.id === 'sync')?.hint).toBe(t('menu.needRepo'))
  })

  test('the sync hint depends on whether credentials exist', () => {
    const withCredentials = buildCloudMenuItems({ hasSyncCredentials: true, inRepo: true }).find(
      (i) => i.id === 'sync',
    )
    const withoutCredentials = buildCloudMenuItems({
      hasSyncCredentials: false,
      inRepo: true,
    }).find((i) => i.id === 'sync')
    expect(withCredentials?.hint).toBe(t('menu.syncHintPush'))
    expect(withoutCredentials?.hint).toBe(t('menu.syncHintSetup'))
  })
})

describe('reviewFlagsPassed', () => {
  test('a bare invocation opens the menu', () => {
    expect(reviewFlagsPassed({})).toBe(false)
  })

  test('each review flag forces the review command instead of the menu', () => {
    for (const flag of ['branch', 'target', 'agent', 'port', 'timeout']) {
      expect(reviewFlagsPassed({ [flag]: 'x' })).toBe(true)
    }
    expect(reviewFlagsPassed({ full: true })).toBe(true)
    expect(reviewFlagsPassed({ 'no-open': true })).toBe(true)
    expect(reviewFlagsPassed({ dual: true })).toBe(true)
  })

  test('flags of other commands still open the menu', () => {
    expect(reviewFlagsPassed({ review: 'develop-20260713', out: 'review.md' })).toBe(false)
  })

  test('a flag parsed as false still counts as passed', () => {
    expect(reviewFlagsPassed({ full: false })).toBe(true)
  })
})

describe('dispatchMenuAction', () => {
  function spyActions(): { actions: MenuActions; calls: MenuActionId[] } {
    const calls: MenuActionId[] = []
    const actions: MenuActions = {
      review: async () => {
        calls.push('review')
      },
      dualReview: async () => {
        calls.push('dualReview')
      },
      show: async () => {
        calls.push('show')
      },
      sync: async () => {
        calls.push('sync')
      },
      link: async () => {
        calls.push('link')
      },
      syncDelete: async () => {
        calls.push('syncDelete')
      },
      config: async () => {
        calls.push('config')
      },
    }
    return { actions, calls }
  }

  test('routes each id to its matching action and none other', async () => {
    const ids: MenuActionId[] = [
      'review',
      'dualReview',
      'show',
      'sync',
      'link',
      'syncDelete',
      'config',
    ]
    for (const id of ids) {
      const { actions, calls } = spyActions()
      await dispatchMenuAction(id, actions)
      expect(calls).toEqual([id])
    }
  })

  test('propagates a rejection from the underlying action', async () => {
    const { actions } = spyActions()
    const failing: MenuActions = {
      ...actions,
      link: async () => Promise.reject(new Error('bad pairing code')),
    }
    await expect(dispatchMenuAction('link', failing)).rejects.toThrow('bad pairing code')
  })
})

import { describe, expect, test } from 'bun:test'
import { createLoadCap, DEFAULT_MAX_CONCURRENT_AGENTS, type Release } from './load-cap.js'

describe('load-cap: default plafond', () => {
  test('plafond par défaut sans configuration: quatre passent, le cinquième attend', async () => {
    const cap = createLoadCap()
    expect(DEFAULT_MAX_CONCURRENT_AGENTS).toBe(4)
    const releases: Release[] = []
    for (let i = 0; i < 4; i++) {
      releases.push(await cap.acquire('turn'))
    }
    expect(cap.snapshot()).toEqual({ occupied: 4, max: 4, queued: 0 })

    let fifthSettled = false
    const fifth = cap.acquire('turn').then((release) => {
      fifthSettled = true
      return release
    })
    // A microtask turn is not enough for the fifth to settle on its own.
    await Promise.resolve()
    await Promise.resolve()
    expect(fifthSettled).toBe(false)
    expect(cap.snapshot().queued).toBe(1)

    releases[0]?.()
    const fifthRelease = await fifth
    expect(fifthSettled).toBe(true)
    fifthRelease()
    for (const release of releases.slice(1)) {
      release()
    }
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 4, queued: 0 })
  })
})

describe('load-cap: FIFO, tous types confondus', () => {
  test('la demande la plus ancienne est servie en premier, quel que soit son kind', async () => {
    const cap = createLoadCap(1)
    const holder = await cap.acquire('turn')
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })

    const order: string[] = []
    const reviewP = cap.acquire('review').then((r) => {
      order.push('review')
      return r
    })
    await Promise.resolve()
    const checksP = cap.acquire('checks').then((r) => {
      order.push('checks')
      return r
    })
    await Promise.resolve()
    const turnP = cap.acquire('turn').then((r) => {
      order.push('turn')
      return r
    })
    await Promise.resolve()
    expect(cap.snapshot().queued).toBe(3)

    holder()
    const reviewRelease = await reviewP
    expect(order).toEqual(['review'])
    // The other two stay in line.
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 2 })

    reviewRelease()
    const checksRelease = await checksP
    expect(order).toEqual(['review', 'checks'])

    checksRelease()
    const turnRelease = await turnP
    expect(order).toEqual(['review', 'checks', 'turn'])
    turnRelease()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })
})

describe('load-cap: plafond configurable', () => {
  test('maxConcurrentAgents: 2 laisse passer deux acquisitions et fait attendre la troisième', async () => {
    const cap = createLoadCap(2)
    const a = await cap.acquire('turn')
    const b = await cap.acquire('review')
    expect(cap.snapshot()).toEqual({ occupied: 2, max: 2, queued: 0 })

    let thirdSettled = false
    const third = cap.acquire('checks').then((r) => {
      thirdSettled = true
      return r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(thirdSettled).toBe(false)

    a()
    const c = await third
    expect(thirdSettled).toBe(true)
    b()
    c()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 2, queued: 0 })
  })
})

describe('load-cap: libération et absence d’interblocage', () => {
  test('N+2 acquisitions concurrentes de types mélangés finissent toutes servies puis libérées', async () => {
    const N = 3
    const cap = createLoadCap(N)
    const kinds: ('turn' | 'review' | 'checks')[] = ['turn', 'review', 'checks', 'turn', 'review']
    expect(kinds.length).toBe(N + 2)
    const pending = kinds.map((kind) => cap.acquire(kind))

    // Exactly N settle right away.
    let settledNow = 0
    for (const p of pending) {
      void p.then(() => {
        settledNow += 1
      })
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(settledNow).toBe(N)
    expect(cap.snapshot()).toEqual({ occupied: N, max: N, queued: 2 })

    // Release everyone as their promise resolves, draining the FIFO until
    // nothing is left — no interlock, no orphaned slot.
    const released = new Set<number>()
    let remaining = pending.length
    for (let i = 0; i < pending.length; i++) {
      void pending[i]!.then((release) => {
        if (!released.has(i)) {
          released.add(i)
          release()
          remaining -= 1
        }
      })
    }
    // Drain: each release may unblock the next waiter, which must itself be
    // released for the chain to finish — loop until the semaphore is idle.
    for (let guard = 0; guard < 20; guard++) {
      if (remaining === 0) {
        break
      }
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(remaining).toBe(0)
    expect(cap.snapshot()).toEqual({ occupied: 0, max: N, queued: 0 })
  })

  test('release() est idempotent: un second appel ne libère pas un slot de trop', async () => {
    const cap = createLoadCap(1)
    const release = await cap.acquire('turn')
    release()
    release()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
    // A fresh acquire still sees exactly one free slot, not minus one.
    const second = await cap.acquire('turn')
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })
    second()
  })

  test('libéré même quand le consommateur échoue: release() ne dépend jamais de l’issue', async () => {
    const cap = createLoadCap(1)
    const release = await cap.acquire('turn')
    try {
      throw new Error('boom')
    } catch {
      release()
    }
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })
})

describe('load-cap: tryAcquire ne file jamais', () => {
  test('un tryAcquire qui échoue laisse la file vide (jamais un waiter fantôme)', () => {
    const cap = createLoadCap(1)
    const release = cap.tryAcquire('turn')
    expect(release).not.toBeNull()
    const second = cap.tryAcquire('turn')
    expect(second).toBeNull()
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })
    release?.()
  })
})

describe('load-cap: onSlotFreed', () => {
  test('un observateur est notifié à chaque libération, même quand le slot part au suivant de la file', async () => {
    const cap = createLoadCap(1)
    let notifications = 0
    const unsubscribe = cap.onSlotFreed(() => {
      notifications += 1
    })
    const first = await cap.acquire('turn')
    const secondP = cap.acquire('review')
    await Promise.resolve()
    first()
    await secondP.then((release) => release())
    expect(notifications).toBe(2)
    unsubscribe()
    const third = await cap.acquire('turn')
    third()
    // Unsubscribed: no further notifications.
    expect(notifications).toBe(2)
  })

  test('un observateur qui jette ne bloque pas les autres ni la libération', async () => {
    const cap = createLoadCap(1)
    let sawIt = false
    cap.onSlotFreed(() => {
      throw new Error('broken observer')
    })
    cap.onSlotFreed(() => {
      sawIt = true
    })
    const release = await cap.acquire('turn')
    expect(() => release()).not.toThrow()
    expect(sawIt).toBe(true)
  })
})

// CRITIQUE (adversarial review, T1.3): un waiter parqué doit pouvoir être
// réveillé par un AbortSignal, et RETIRÉ de la file — sinon un release()
// ultérieur lui remettrait un slot que personne ne libérerait jamais.
describe('load-cap: acquire(kind, signal) — attente interruptible', () => {
  test('un abort pendant l’attente règle la promesse tout de suite, avec un Release no-op', async () => {
    const cap = createLoadCap(1)
    const holder = await cap.acquire('turn')
    const controller = new AbortController()
    let settled = false
    const waiterP = cap.acquire('review', controller.signal).then((release) => {
      settled = true
      return release
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(cap.snapshot().queued).toBe(1)

    controller.abort()
    // No microtask delay needed: the abort listener settles synchronously.
    await Promise.resolve()
    expect(settled).toBe(true)
    const release = await waiterP
    // A no-op: calling it must not touch occupancy.
    release()
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })

    holder()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  test('un abort pendant l’attente RETIRE le waiter de la file: aucun slot ne lui est jamais remis', async () => {
    const cap = createLoadCap(1)
    const holder = await cap.acquire('turn')
    const controller = new AbortController()
    const aborted = cap.acquire('checks', controller.signal)
    await Promise.resolve()
    expect(cap.snapshot().queued).toBe(1)

    controller.abort()
    await aborted

    // The FIFO must be empty now: a release must hand the slot to occupied
    // decrementing (nobody left to give it to), never to the cancelled
    // waiter — which would leak the slot forever since its Release is a
    // no-op.
    expect(cap.snapshot().queued).toBe(0)
    holder()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
    const fresh = await cap.acquire('turn')
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })
    fresh()
  })

  test('un signal déjà aborté avant l’appel ne fait jamais rejoindre la file', async () => {
    const cap = createLoadCap(1)
    const holder = await cap.acquire('turn')
    const controller = new AbortController()
    controller.abort()
    const release = await cap.acquire('turn', controller.signal)
    expect(cap.snapshot().queued).toBe(0)
    release()
    holder()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  test('un slot libre est accordé même avec un signal déjà aborté: le caller le possède et doit le rendre', async () => {
    const cap = createLoadCap(1)
    const controller = new AbortController()
    controller.abort()
    const release = await cap.acquire('turn', controller.signal)
    // A REAL slot, not the no-op: tryAcquire never consults the signal.
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })
    release()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  test('une libération qui gagne la course contre l’abort donne un VRAI slot, pas le no-op', async () => {
    const cap = createLoadCap(1)
    const holder = await cap.acquire('turn')
    const controller = new AbortController()
    const waiterP = cap.acquire('review', controller.signal)
    await Promise.resolve()

    // The release runs first, synchronously handing the slot to the waiter —
    // the abort listener, fired right after, must see `settled` already true
    // and do nothing (no double-resolve, no attempt to splice a waiter that
    // is no longer in the queue).
    holder()
    controller.abort()
    const release = await waiterP
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })
    release()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })
})

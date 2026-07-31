import { ref } from 'vue'

const isClient = typeof window !== 'undefined'

export function useReviewProgress(reviewId: string) {
  const storageKey = `codesema-progress:${reviewId}`

  function loadState(): { read: number[]; checked: number[] } {
    if (!isClient) {
      return { read: [], checked: [] }
    }
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) {
        return { read: [], checked: [] }
      }
      const parsed = JSON.parse(raw)
      return {
        read: Array.isArray(parsed.read)
          ? (parsed.read as unknown[]).filter((v): v is number => typeof v === 'number')
          : [],
        checked: Array.isArray(parsed.checked)
          ? (parsed.checked as unknown[]).filter((v): v is number => typeof v === 'number')
          : [],
      }
    } catch {
      return { read: [], checked: [] }
    }
  }

  function saveState(read: Set<number>, checked: Set<number>) {
    if (!isClient) {
      return
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify({ read: [...read], checked: [...checked] }))
    } catch {
      // localStorage unavailable (private mode quota, etc.)
    }
  }

  const initial = loadState()
  const readSet = ref<Set<number>>(new Set(initial.read))
  const checkedSet = ref<Set<number>>(new Set(initial.checked))

  function toggleRead(index: number) {
    const next = new Set(readSet.value)
    if (next.has(index)) {
      next.delete(index)
    } else {
      next.add(index)
    }
    readSet.value = next
    saveState(readSet.value, checkedSet.value)
  }

  function markRead(index: number) {
    if (readSet.value.has(index)) {
      return
    }
    const next = new Set(readSet.value)
    next.add(index)
    readSet.value = next
    saveState(readSet.value, checkedSet.value)
  }

  function toggleChecked(index: number) {
    const next = new Set(checkedSet.value)
    if (next.has(index)) {
      next.delete(index)
    } else {
      next.add(index)
    }
    checkedSet.value = next
    saveState(readSet.value, checkedSet.value)
  }

  return {
    readSet,
    checkedSet,
    toggleRead,
    toggleChecked,
    markRead,
  }
}

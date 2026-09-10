import { type KeyboardEvent, useEffect, useMemo, useState } from "react"

import { sortLibraryEntries, type LibrarySort } from "@/lib/library-entry"
import type { LibraryTreeEntry } from "@/types"

type SelectionState = {
  scope: string | null
  active: boolean
  paths: Set<string>
  anchor: string | null
}

function emptySelection(scope: string | null): SelectionState {
  return { scope, active: false, paths: new Set(), anchor: null }
}

export function useLibraryFileSelection(
  scope: string | null,
  entries: LibraryTreeEntry[],
  sort: LibrarySort,
  disabled: boolean,
) {
  const [state, setState] = useState(() => emptySelection(scope))
  const sortedEntries = useMemo(() => sortLibraryEntries(entries, sort), [entries, sort])
  const paths = useMemo(() => new Set(
    entries.filter(entry => state.scope === scope && state.paths.has(entry.path)).map(entry => entry.path),
  ), [entries, scope, state])
  const active = state.scope === scope && state.active
  const selectedEntries = useMemo(() => sortedEntries.filter(entry => paths.has(entry.path)), [sortedEntries, paths])

  useEffect(() => {
    setState(current => {
      if (current.scope !== scope) return emptySelection(scope)
      const available = new Set(entries.map(entry => entry.path))
      if ([...current.paths].every(path => available.has(path))) return current
      const remaining = new Set([...current.paths].filter(path => available.has(path)))
      return remaining.size > 0 ? { ...current, paths: remaining } : emptySelection(scope)
    })
  }, [scope, entries])

  function onClear() {
    if (!disabled) setState(emptySelection(scope))
  }

  function onSelectAll() {
    if (disabled) return
    setState(entries.length > 0
      ? { scope, active: true, paths: new Set(entries.map(entry => entry.path)), anchor: sortedEntries[0]?.path ?? null }
      : emptySelection(scope))
  }

  function onToggle(entry: LibraryTreeEntry, modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) {
    if (disabled) return
    setState(previous => {
      const current = previous.scope === scope ? previous : emptySelection(scope)
      const anchorIndex = sortedEntries.findIndex(item => item.path === current.anchor)
      const index = sortedEntries.findIndex(item => item.path === entry.path)
      if (index < 0) return current
      if (modifiers.shiftKey && anchorIndex >= 0) {
        const range = sortedEntries.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1)
        const next = new Set(modifiers.metaKey || modifiers.ctrlKey ? current.paths : [])
        range.forEach(item => next.add(item.path))
        return { ...current, active: true, paths: next }
      }
      const next = new Set(current.paths)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next.size > 0 ? { scope, active: true, paths: next, anchor: entry.path } : emptySelection(scope)
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (disabled || event.defaultPrevented || !scope || event.altKey || event.nativeEvent.isComposing) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], [role="dialog"]')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault()
      event.stopPropagation()
      onSelectAll()
    } else if (event.key === "Escape" && active) {
      event.preventDefault()
      event.stopPropagation()
      onClear()
    }
  }

  return {
    active, paths, selectedEntries, onToggle, onSelectAll, onClear, onKeyDown,
    onMenuTarget(entry: LibraryTreeEntry) {
      if (disabled) return
      setState(current => {
        if (current.scope === scope && current.paths.has(entry.path)) return current
        return current.scope === scope && current.active
          ? { ...current, paths: new Set([entry.path]), anchor: entry.path }
          : emptySelection(scope)
      })
    },
    enter() { if (!disabled) setState(current => ({ ...current, scope, active: true })) },
    deselectAll: onClear,
    finish(completed: string[], allSucceeded: boolean) {
      setState(current => {
        const remaining = new Set([...current.paths].filter(path => !completed.includes(path)))
        return allSucceeded || remaining.size === 0 ? emptySelection(scope) : { ...current, paths: remaining }
      })
    },
  }
}

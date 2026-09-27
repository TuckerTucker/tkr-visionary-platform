/**
 * Undo and redo, from the UI: the one place a key or a button reaches the
 * scene's history.
 *
 * **Undo is total because nothing asks first** (web/CLAUDE.md, "Nothing asks
 * for confirmation"). A trim, a reorder, a crossfade, a render, a take chosen,
 * a continuation, a detach — each is one command on the open Core (see
 * `useEdit`), so each is one entry here, and this module never learns which
 * gesture made it except to put a word to it on a button.
 *
 * **Core's history only.** `useEdit`'s `undo()`/`redo()` drive it; the Studio
 * keeps a stack of its own for canvas drags this page never makes, and two
 * stacks would be two answers to what ⌘Z does. What can be undone is read from
 * `core.store` (`history`/`future`), the same state those calls move.
 *
 *   installUndoKeys()   one keydown listener; returns its removal
 *   useUndoKeys()       the same, for a component's lifetime
 *   useHistory()        can undo/redo, and what each would undo, for controls
 *   chordOf / isTextTarget / wordFor   the pure parts, exported to be read
 *                        and tested on their own
 *
 * **The prompt keeps its own undo.** Keys are ignored while focus is in a text
 * field, a textarea or anything contenteditable: the prompt's ⌘Z is the
 * browser's text undo and the field's own `keys()` chords, and a timeline that
 * took it would throw away a trim to put back a deleted word.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { Command, Core, HistoryEntry } from '@openvideo/core'

import { useStore } from '../store'
import { SLOT_CONTINUE, SLOT_RENDER, TAKE_CHOOSE } from './commands'
import { CLIP_DETACH } from './detach'
import { redo, undo, useEdit } from './useEdit'

export type Chord = 'undo' | 'redo'

/** The key facts a chord is read from — a KeyboardEvent satisfies it. */
export type KeyFacts = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * Whether this is a Mac, where the chords are ⌘ rather than Ctrl.
 *
 * `userAgentData` first because `navigator.platform` is deprecated and already
 * frozen in some browsers; the fallback is what Safari and Firefox still have.
 */
export function isMac(nav: Navigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false
  const hinted = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  return /mac|iphone|ipad|ipod/i.test(hinted || nav.platform || nav.userAgent || '')
}

/**
 * The chord a key press is, or null.
 *
 * ⌘Z / ⇧⌘Z on a Mac; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y elsewhere. The modifier is
 * the platform's one and only that one: Ctrl+Z on a Mac is not undo in any Mac
 * app, and ⌘ elsewhere is the OS key. Alt is refused outright — ⌘⌥Z and
 * Ctrl+Alt+Z are other applications' chords, not a slower undo. `key` is
 * compared lowercased because Shift makes it "Z" in Chrome and "z" in Safari,
 * and by `key` rather than `code` so a non-QWERTY layout's Z is the Z.
 */
export function chordOf(e: KeyFacts, mac: boolean): Chord | null {
  if (e.altKey) return null
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null
  const k = e.key.toLowerCase()
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (k === 'y' && !mac && !e.shiftKey) return 'redo'
  return null
}

/**
 * Whether focus is somewhere that owns its own ⌘Z: a text input, a textarea, a
 * select, or anything contenteditable. The trim handles are `role="slider"`
 * spans, not inputs, so a focused handle still undoes the trim it just made.
 */
export function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false
  if (t instanceof HTMLElement && t.isContentEditable) return true
  return t.matches('input,textarea,select')
}

/**
 * Whether the history is the page's to drive right now: the video side, a
 * scene with time on it, and an open Core. On the image side, or before the
 * first take, ⌘Z means nothing here and is left to the browser.
 */
export function historyActive(): boolean {
  const st = useStore.getState()
  if (st.mode !== 'generate' || st.kind !== 'video' || st.takes.length === 0) return false
  return !!useEdit.getState().core
}

export type UndoKeysDeps = {
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>
  mac: boolean
  active: () => boolean
  undo: () => boolean
  redo: () => boolean
  /** Something modal is open and owns the keyboard. */
  covered: () => boolean
}

const DEFAULTS = (): UndoKeysDeps => ({
  target: window,
  mac: isMac(),
  active: historyActive,
  undo,
  redo,
  // The same guard App's other global keys use: a lightbox, a menu, the
  // palette or a scrim is in front of the timeline, and an undo landing behind
  // it is an edit nobody saw happen.
  covered: () => !!document.querySelector('.lb,.menu,.pal,.scrim'),
})

/**
 * Listen for the undo/redo chords on the window, and return the removal.
 *
 * One listener, in the bubble phase, so a control that handles its own keys
 * (the trim handles stop the arrows, never ⌘Z) has had its turn first. The
 * chord is consumed only when it did something: with nothing to undo it is
 * left alone, rather than a key that silently swallows itself.
 */
export function installUndoKeys(deps: Partial<UndoKeysDeps> = {}): () => void {
  const d = { ...DEFAULTS(), ...deps }
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return
    const chord = chordOf(e, d.mac)
    if (!chord) return
    if (isTextTarget(e.target) || d.covered() || !d.active()) return
    if (!(chord === 'undo' ? canUndoNow() : canRedoNow())) return
    e.preventDefault()
    if (chord === 'undo') d.undo()
    else d.redo()
  }
  d.target.addEventListener('keydown', onKey)
  return () => d.target.removeEventListener('keydown', onKey)
}

/** `installUndoKeys` for a component's lifetime — mounted once, in App. */
export function useUndoKeys(): void {
  useEffect(() => installUndoKeys(), [])
}

const canUndoNow = (): boolean => (useEdit.getState().core?.store.getState().history.length ?? 0) > 0
const canRedoNow = (): boolean => (useEdit.getState().core?.store.getState().future.length ?? 0) > 0

/* ---- what an entry was, in a word --------------------------------------- */

type Added = { clip?: { type?: string; metadata?: Record<string, unknown> } }

const addsOf = (c: Command): Added[] => {
  if (c.type !== 'clip.add') return []
  return Array.isArray(c.payload) ? (c.payload as Added[]) : [c.payload as Added]
}

/** What a clip added by a gesture that is not a take landing was put there
 *  as — read off the metadata each of those gestures writes, so no two of
 *  them are told apart by clip type alone. An Audio clip is a detached
 *  soundtrack only when it names the clip it came from (`detach.ts`); music
 *  dropped on an A track is an Audio clip too, and was once called a detach. */
function kindAdded(a: Added): 'detach' | 'title' | 'drop' | null {
  const m = a.clip?.metadata
  if (a.clip?.type === 'Audio' && typeof m?.linkedTo === 'string') return 'detach'
  if (m?.title === true) return 'title'
  if (typeof m?.dropped === 'string') return 'drop'
  return null
}

/**
 * The word for one history entry — "trim", "render" — or null when it is not
 * one of ours to name.
 *
 * Single commands carry their own type. A `batch` does not (Core names every
 * batch "batch"), so it is read from what is inside, in the order that
 * separates the gestures `cuts.ts`, `drop.ts`, `detach.ts` and `useEdit`
 * actually make:
 * - `clip.detach`, or an Audio clip added that names its take in
 *   `metadata.linkedTo`, is a soundtrack detached;
 * - a title or a dropped file, each on the new track the batch makes, is that;
 * - a track's clip order restated is a reorder (a reorder may also drop a
 *   crossfade whose clips are no longer neighbours, so this comes first);
 * - a Transition added, or a clip removed without a reorder, is a crossfade
 *   put on or taken off — nothing else removes a clip in one gesture;
 * - another clip added is a take landing on the end of V1;
 * - clip updates alone are a trim, which ripples the clips after it — except
 *   a title's words retyped, which is the title's.
 */
export function wordFor(command: Command): string | null {
  switch (command.type) {
    case SLOT_RENDER: return 'render'
    case TAKE_CHOOSE: return 'take choice'
    case SLOT_CONTINUE: return 'continue'
    case CLIP_DETACH: return 'detach'
    case 'clip.add': return addsOf(command).map(kindAdded).find((k) => k) ?? 'new take'
    case 'clip.update': return retitles(command) ? 'title' : 'trim'
    case 'batch': break
    default: return null
  }
  const inner = Array.isArray(command.payload) ? (command.payload as Command[]) : []
  const types = new Set(inner.map((c) => c.type))
  const added = inner.flatMap(addsOf)
  if (types.has(CLIP_DETACH)) return 'detach'
  const kind = added.map(kindAdded).find((k) => k)
  if (kind) return kind
  if (types.has('track.update')) return 'reorder'
  if (added.some((a) => a.clip?.type === 'Transition') || types.has('clip.remove')) return 'crossfade'
  if (added.length) return 'new take'
  if (types.size && [...types].every((t) => t === 'clip.update')) return 'trim'
  return null
}

/** Whether a `clip.update` changes a title's words (`drop.ts`'s
 *  `setTitleText`) — the one update that is not a re-timing. */
function retitles(c: Command): boolean {
  const list = Array.isArray(c.payload) ? c.payload : [c.payload]
  return list.some((u) => {
    const updates = (u as { updates?: Record<string, unknown> } | null)?.updates
    return !!updates && typeof updates.text === 'string' && !('timing' in updates)
  })
}

/** "Undo trim", or plain "Undo" for an entry with no word. */
export function labelFor(verb: 'Undo' | 'Redo', entry: HistoryEntry | undefined): string {
  const w = entry ? wordFor(entry.command) : null
  return w ? `${verb} ${w}` : verb
}

/* ---- the history, for a control ----------------------------------------- */

export type HistoryView = {
  canUndo: boolean
  canRedo: boolean
  /** "Undo trim" — what the next undo takes back, or "Undo". */
  undoLabel: string
  redoLabel: string
}

const NONE: readonly HistoryEntry[] = []
const noop = (): void => {}

/**
 * The open Core's history as a control needs it. Re-reads on every Core
 * change, through `core.store.subscribe` rather than `core.on` — the Studio's
 * teardown removes every `core.on` listener, and a Stage remount would leave
 * the buttons reading a history that had stopped telling them anything.
 */
export function useHistory(): HistoryView {
  const core: Core | null = useEdit((s) => s.core)
  const subscribe = useCallback(
    (fn: () => void): (() => void) => (core ? core.store.subscribe(fn) : noop), [core])
  // The arrays themselves: Core replaces them on every change and leaves them
  // alone otherwise, so they are stable snapshots with no copying.
  const history = useSyncExternalStore(subscribe, () => core?.store.getState().history ?? NONE)
  const future = useSyncExternalStore(subscribe, () => core?.store.getState().future ?? NONE)
  return {
    canUndo: history.length > 0,
    canRedo: future.length > 0,
    undoLabel: labelFor('Undo', history[history.length - 1]),
    redoLabel: labelFor('Redo', future[0]),
  }
}

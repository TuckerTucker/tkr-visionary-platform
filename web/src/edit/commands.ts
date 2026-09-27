/**
 * Rendering is an edit: `slot.render`, `take.choose` and `slot.continue` as
 * OpenVideo commands, on the same history as a trim.
 *
 * **A command is synchronous and a render is not**, so the two halves are
 * split where they fall. Pressing render starts an ordinary `/api/video` job
 * (useVideo — the job/status/stop contract, unchanged) and marks the slot as
 * rendering, which is page state and not an edit. When the take *lands*, the
 * edit happens: one command, one undo entry, replacing the slot's clip with
 * the new take. Undo puts the previous take back; the undone take's bytes stay
 * in their job folder on the volume and in the slot's take list, one ‹ › away.
 *
 * **Every handler is pure** — `(state, cmd) => Patch[]`, reading nothing but
 * its arguments — and every patch is a WHOLE clip or the whole track list, with
 * `oldValue`. Core inverts a patch by swapping `value` and `oldValue`; a patch
 * on a field path (`/clips/x/timing/display`) inverts to that field alone, and
 * the Studio then rebuilds the clip from a half-old, half-new object. Whole
 * objects invert to exactly what was there.
 *
 * **Swapping a take is a remove and an add of the same id**, not an update.
 * The Studio's bridge applies an update to a clip it already holds by copying
 * fields onto it, and `src` is not one of the fields it copies — the clip
 * would keep playing the old file under the new name. A remove and an add
 * make it load the new one. The id is kept because it is what everything else
 * in the arrangement points at: a transition's `fromClipId`, a selection, the
 * saved project.
 *
 * **Decided, and why:**
 *
 * - *A take lands at the slot's start and plays whole.* The trim a person set
 *   on the old take was chosen against that take's frames; carried across, an
 *   in-point of 1.2 s would cut into a different shot at a different moment,
 *   which is a trim nobody made. A fade is a property of the place rather than
 *   the picture, so fades are kept.
 * - *The rest of the track moves by the difference in length.* A slot is a
 *   place in a sequence, and a longer take either overlaps the next one or a
 *   shorter one leaves a hole — both of which would be edits the person did
 *   not make. So every clip on the same track that starts at or after the old
 *   take's end moves by exactly the change. Other tracks are not moved: an
 *   overlay sits at a time, not after a clip, and guessing which it belongs to
 *   is a guess.
 * - *`take.choose` carries the clip, not only the index.* The handler cannot
 *   read the take list (it lives in the store, not the Core) or a file's length
 *   (that is an async read); the caller does both and hands over the clip the
 *   engine read. `index` rides along so the history says which take was chosen.
 */
import type { AnyClip, CommandHandler, IProject, ITrack, Patch } from '@openvideo/core'

import type { Engine } from './engine'
import { slotOf, v1, v1Track } from './project'

export const SLOT_RENDER = 'slot.render'
export const TAKE_CHOOSE = 'take.choose'
export const SLOT_CONTINUE = 'slot.continue'

/**
 * `slot.render` — the landed take becomes the slot's clip.
 *
 * `clip` is the engine's reading of the take (`core.clip.prepare`), carrying
 * `{slotId, jobId, file}` in its metadata. When no clip in the Core fills the
 * slot — it was held out of the Core because its old file would not load —
 * the take is put where that one sat: `trackId` at `at` µs, the place having
 * been `span` µs long.
 */
export type SlotRenderPayload = {
  slotId: string
  clip: AnyClip
  trackId?: string
  at?: number
  span?: number
}

/** `take.choose` — the slot's clip plays take `index` of its list instead. */
export type TakeChoosePayload = { slotId: string; index: number; clip: AnyClip }

/** `slot.continue` — a new slot, `slotId`, filled with `clip`, directly after
 *  `fromSlotId` on its track. With `fromSlotId` gone (removed, or undone while
 *  the take rendered) the new slot goes on the end of V1. */
export type SlotContinuePayload = { fromSlotId: string; slotId: string; clip: AnyClip }

type State = Pick<IProject, 'clips' | 'tracks'>

const lengthOf = (c: AnyClip): number => c.timing.display.to - c.timing.display.from

const trackOf = (state: State, clipId: string): ITrack | null =>
  state.tracks.find((t) => t.clipIds.includes(clipId)) ?? null

const inSlot = (state: State, slotId: string): AnyClip | null =>
  Object.values(state.clips).find((c) => slotOf(c) === slotId) ?? null

/** `clip` with its metadata naming `slotId` — whatever the reader put there —
 *  so the slot is found by the next command however the clip was prepared. */
function stamped(clip: AnyClip, slotId: string): AnyClip {
  return { ...clip, metadata: { ...clip.metadata, slotId } }
}

/** `clip` placed to start at `from` and play its whole length. */
function placed(clip: AnyClip, from: number): AnyClip {
  const len = lengthOf(clip)
  return { ...clip, timing: { ...clip.timing, display: { from, to: from + len } } }
}

/**
 * Whole-clip updates moving every clip on `track` that starts at or after
 * `from` by `delta` µs, leaving out `skip`. The Core state is read, never
 * written.
 */
function ripple(state: State, track: ITrack | null, from: number, delta: number, skip: string): Patch[] {
  if (!track || delta === 0) return []
  const out: Patch[] = []
  for (const id of track.clipIds) {
    if (id === skip) continue
    const c = state.clips[id]
    if (!c || c.timing.display.from < from) continue
    const moved: AnyClip = {
      ...c,
      timing: {
        ...c.timing,
        display: { from: c.timing.display.from + delta, to: c.timing.display.to + delta },
      },
    } as AnyClip
    out.push({ op: 'update', path: `/clips/${id}`, value: moved, oldValue: c })
  }
  return out
}

/**
 * The patches that put `next` in the place `old` holds: same id, same start,
 * the whole new take, the old take's fades, and the rest of its track moved
 * by the change in length.
 */
function swap(state: State, old: AnyClip, next: AnyClip): Patch[] {
  const from = old.timing.display.from
  const fades = {
    ...(old.timing.fadeIn !== undefined && { fadeIn: old.timing.fadeIn }),
    ...(old.timing.fadeOut !== undefined && { fadeOut: old.timing.fadeOut }),
  }
  const base = placed(next, from)
  const clip = { ...base, id: old.id, timing: { ...base.timing, ...fades } } as AnyClip
  return [
    { op: 'remove', path: `/clips/${old.id}`, oldValue: old },
    { op: 'add', path: `/clips/${old.id}`, value: clip },
    ...ripple(state, trackOf(state, old.id), old.timing.display.to, lengthOf(clip) - lengthOf(old), old.id),
  ]
}

/**
 * The patches that put `clip` on `track` at `at` µs, as a new clip, moving
 * everything on the track that starts at or after `at + span` along by the
 * difference. `span` is the room the place already had: zero for a new slot,
 * the old length for a slot whose clip was held out of the Core.
 *
 * With no track at all, V1 is created in the same patches, so the edit and its
 * undo are still one entry.
 */
function insert(state: State, trackId: string | null, at: number | null, span: number, clip: AnyClip): Patch[] {
  const existing = (trackId ? state.tracks.find((t) => t.id === trackId) : undefined) ?? v1(state)
  const start = at ?? (existing ? endOf(state, existing) : 0)
  const next = placed(clip, start)
  const tracks = existing
    ? state.tracks.map((t) => (t.id === existing.id ? { ...t, clipIds: [...t.clipIds, next.id] } : t))
    : [...state.tracks, { ...v1Track(), clipIds: [next.id] }]
  return [
    ...ripple(state, existing, start + span, lengthOf(next) - span, next.id),
    { op: 'add', path: `/clips/${next.id}`, value: next },
    { op: 'update', path: '/tracks', value: tracks, oldValue: state.tracks },
  ]
}

function endOf(state: State, track: ITrack): number {
  return track.clipIds.reduce((end, id) => Math.max(end, state.clips[id]?.timing.display.to ?? 0), 0)
}

/** See `SlotRenderPayload`. */
export const slotRender: CommandHandler<SlotRenderPayload> = (state, cmd) => {
  const { slotId, clip, trackId, at, span } = cmd.payload
  const next = stamped(clip, slotId)
  const old = inSlot(state, slotId)
  if (old) return swap(state, old, next)
  return insert(state, trackId ?? null, at ?? null, span ?? 0, next)
}

/** See `TakeChoosePayload`. A slot no clip fills is nothing to choose on. */
export const takeChoose: CommandHandler<TakeChoosePayload> = (state, cmd) => {
  const { slotId, clip } = cmd.payload
  const old = inSlot(state, slotId)
  if (!old) return []
  return swap(state, old, stamped(clip, slotId))
}

/** See `SlotContinuePayload`. */
export const slotContinue: CommandHandler<SlotContinuePayload> = (state, cmd) => {
  const { fromSlotId, slotId, clip } = cmd.payload
  const next = stamped(clip, slotId)
  const from = inSlot(state, fromSlotId)
  const track = from ? trackOf(state, from.id) : null
  if (!from || !track) return insert(state, null, null, 0, next)
  return insert(state, track.id, from.timing.display.to, 0, next)
}

/**
 * Teach the engine the three commands. Idempotent — the registry is one map
 * for the page, and registering a type again replaces its handler.
 */
export function registerCommands(engine: Pick<Engine, 'registerCommand'>): void {
  engine.registerCommand(SLOT_RENDER, slotRender)
  engine.registerCommand(TAKE_CHOOSE, takeChoose)
  engine.registerCommand(SLOT_CONTINUE, slotContinue)
}

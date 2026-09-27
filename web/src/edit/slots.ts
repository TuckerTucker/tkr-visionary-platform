/**
 * A slot, and every take it has had.
 *
 * A slot is a place in the cut that a generation fills — one clip on a track,
 * addressed by the `slotId` in its `metadata` (see project.ts). Rendering it
 * again does not make a second clip; it adds a take to the slot and puts the
 * new take in the clip. The old take is not deleted, not hidden and not moved
 * off the volume: it is one ‹ › away, and one undo away.
 *
 * **Two records, and each holds one thing.**
 *
 * - *Which takes a slot has had* is intent: it is what the person asked for,
 *   and it has to survive anything done to the arrangement. It rides on the
 *   takes themselves — `SlotTake.slot`, beside `jobId` and `line` in
 *   `store.takes`, which the scene sidecar already writes and whose reader
 *   keeps every field it does not model. So the intent learns a slot's takes
 *   with no second list to keep in step, and a take can never be in the list
 *   of a slot it was not rendered for.
 * - *Which take the slot is showing* is arrangement, and it lives where the
 *   rest of the arrangement does: in the clip, in the Core. That is what puts
 *   choosing a take on the same undo history as a trim. Written into the intent
 *   as well, an undo would move one copy and not the other, and the day the two
 *   disagreed nobody could say which take the slot holds.
 *
 * `intentSlots` renders the two together in the `slots[slotId] = {takes,
 * chosen}` shape, for a reader that wants a slot's history without the engine.
 *
 * Nothing here touches the engine; the types are `import type` and erased, so
 * this is safe on the first-load path.
 */
import { create } from 'zustand'
import type { AnyClip, IProject } from '@openvideo/core'

import type { ApiError } from '../api/client'
import type { SceneTake } from '../store'
import { clipsOn, slotOf, v1 } from './project'

/** A take, and the slot it was rendered for. `slot` is optional because a
 *  scene saved before slots existed has takes without one — their slot is the
 *  clip that plays them (see `slotTakes`), and `adoptTakes` stamps it. */
export type SlotTake = SceneTake & { slot?: string }

const sameTake = (a: Pick<SceneTake, 'jobId' | 'file'>, b: Pick<SceneTake, 'jobId' | 'file'>): boolean =>
  a.jobId === b.jobId && a.file === b.file

/** The clip filling `slotId`, on any track, or null. */
export function clipOfSlot(project: Pick<IProject, 'clips'> | null, slotId: string): AnyClip | null {
  if (!project) return null
  return Object.values(project.clips).find((c) => slotOf(c) === slotId) ?? null
}

/**
 * Every take `slotId` has had, oldest first.
 *
 * A take stamped for the slot, or — for a take from before slots were stamped
 * — the one the slot's clip is playing. The second rule is what keeps a legacy
 * slot's first take in its own list when it is rendered again; `adoptTakes`
 * then stamps it so the list no longer depends on what the clip happens to show.
 */
export function slotTakes(
  takes: readonly SlotTake[], slotId: string, project: Pick<IProject, 'clips'> | null,
): SlotTake[] {
  const clip = clipOfSlot(project, slotId)
  const m = clip?.metadata
  const playing = m && typeof m.jobId === 'string' && typeof m.file === 'string'
    ? { jobId: m.jobId, file: m.file } : null
  return takes.filter((t) => t.slot === slotId || (!t.slot && playing !== null && sameTake(t, playing)))
}

/** A slot as the page draws it: its takes and which one is in the clip. */
export type SlotView = {
  takes: SlotTake[]
  /** Index into `takes` of the take the clip plays; -1 when the clip plays
   *  something the list does not hold (a take from a scene that was cleared). */
  chosen: number
}

export function slotView(
  takes: readonly SlotTake[], slotId: string, project: Pick<IProject, 'clips'> | null,
): SlotView {
  const list = slotTakes(takes, slotId, project)
  const m = clipOfSlot(project, slotId)?.metadata
  const chosen = m ? list.findIndex((t) => t.jobId === m.jobId && t.file === m.file) : -1
  return { takes: list, chosen }
}

/** The slot whose clip plays the take `jobId` rendered, or null. How a
 *  continuation armed from a take finds the slot it continues. */
export function slotPlaying(project: Pick<IProject, 'clips'> | null, jobId: string): string | null {
  if (!project) return null
  for (const c of Object.values(project.clips)) {
    if (c.metadata?.jobId === jobId) {
      const s = slotOf(c)
      if (s) return s
    }
  }
  return null
}

/** The last slot on V1, in time — what the canvas's Continue continues. */
export function lastV1Slot(project: Pick<IProject, 'clips' | 'tracks'> | null): string | null {
  if (!project) return null
  const track = v1(project)
  if (!track) return null
  const clips = clipsOn(project, track)
  for (let i = clips.length - 1; i >= 0; i--) {
    const s = slotOf(clips[i]!)
    if (s) return s
  }
  return null
}

/** The take a slot's clip plays, as the take record, or null. */
export function chosenTake(
  takes: readonly SlotTake[], slotId: string, project: Pick<IProject, 'clips'> | null,
): SlotTake | null {
  const v = slotView(takes, slotId, project)
  return v.takes[v.chosen] ?? null
}

/**
 * `takes` with every unstamped take that a clip plays stamped with that clip's
 * slot, or `takes` itself when there is nothing to stamp. Run when a scene
 * opens, so a scene written before slots existed gains the record on its first
 * save rather than depending on the arrangement to say which take is whose.
 */
export function adoptTakes(takes: readonly SlotTake[], project: Pick<IProject, 'clips'>): SlotTake[] | null {
  let changed = false
  const out = takes.map((t) => {
    if (t.slot) return t
    const c = Object.values(project.clips).find((x) =>
      x.metadata?.jobId === t.jobId && x.metadata?.file === t.file && slotOf(x))
    if (!c) return t
    changed = true
    return { ...t, slot: slotOf(c)! }
  })
  return changed ? out : null
}

/** One take as the intent's slot record carries it. */
export type IntentSlotTake = { jobId: string; file: string; line: string; seconds?: number }

/** `slots[slotId]` in the scene intent. */
export type IntentSlot = { takes: IntentSlotTake[]; chosen: number }

/**
 * Every slot the takes name, in the intent's `slots` shape: its takes, oldest
 * first, and the index of the one its clip plays (-1 when no clip is loaded to
 * ask). Derived, never read back — the takes and the clip are the records —
 * so it can be written beside them for a reader without an engine and never
 * disagree with them for longer than one save.
 */
export function intentSlots(
  takes: readonly SlotTake[], project: Pick<IProject, 'clips'> | null,
): Record<string, IntentSlot> {
  const ids = new Set<string>()
  for (const t of takes) if (t.slot) ids.add(t.slot)
  for (const c of Object.values(project?.clips ?? {})) { const s = slotOf(c); if (s) ids.add(s) }
  const out: Record<string, IntentSlot> = {}
  for (const id of ids) {
    const v = slotView(takes, id, project)
    if (!v.takes.length) continue
    out[id] = {
      takes: v.takes.map((t) => ({
        jobId: t.jobId, file: t.file, line: t.line,
        ...(typeof t.seconds === 'number' && { seconds: t.seconds }),
      })),
      chosen: v.chosen,
    }
  }
  return out
}

/* ---- where a take that is being rendered will land ---------------------- */

/**
 * Where a run's take goes when it lands.
 *
 * - `append` — a new slot at the end of V1: an ordinary Generate.
 * - `render` — into an existing slot, replacing its clip's take.
 * - `continue` — a new slot directly after `from` on its track, the rest of
 *   the track moving along to make room: Continue.
 *
 * Decided when the run is *started*, not when it lands, because that is when
 * the person said it — a slot re-rendered from its own button must land in
 * that slot however the cut was rearranged during the three minutes it took.
 */
export type SlotTarget =
  | { kind: 'append'; slotId: string }
  | { kind: 'render'; slotId: string }
  | { kind: 'continue'; slotId: string; from: string }

// Keyed by job id, because that is what the take that lands carries. Module
// state rather than a field on the take: it is where the take goes *this
// session*, and a sidecar read next month has no use for it.
const targets = new Map<string, SlotTarget>()

/** Say where the take `jobId` renders will land. */
export function expectLanding(jobId: string, target: SlotTarget): void {
  targets.set(jobId, target)
}

/** Where the take `jobId` rendered goes, without forgetting it. */
export function peekLanding(jobId: string): SlotTarget | null {
  return targets.get(jobId) ?? null
}

/** Where the take `jobId` rendered goes; asked once, when it is placed. */
export function takeLanding(jobId: string): SlotTarget | null {
  const t = targets.get(jobId) ?? null
  targets.delete(jobId)
  return t
}

/* ---- a slot being rendered ---------------------------------------------- */

/**
 * A render in flight on a slot, or the refusal it ended with.
 *
 * UI state and not a Core patch: a job that is running has changed nothing in
 * the arrangement yet, and an undo entry for "started rendering" would be an
 * undo that cannot un-start a GPU. The edit happens when the take lands.
 */
export type SlotRun = {
  running: boolean
  /** The job being polled; null before `/api/video` has answered. */
  runId: string | null
  percent: number
  phase: string
  /** The refusal or failure, verbatim — the whole `ApiError` where there is
   *  one, so its detail folds away under the sentence rather than being lost. */
  error: string | ApiError | null
}

export const useSlotRuns = create<Record<string, SlotRun>>(() => ({}))

export function setSlotRun(slotId: string, patch: Partial<SlotRun>): void {
  useSlotRuns.setState((s) => {
    const was = s[slotId] ?? { running: false, runId: null, percent: 0, phase: '', error: null }
    return { ...s, [slotId]: { ...was, ...patch } }
  })
}

export function clearSlotRun(slotId: string): void {
  useSlotRuns.setState((s) => {
    if (!(slotId in s)) return s
    const rest = { ...s }
    delete rest[slotId]
    return rest
  }, true)
}

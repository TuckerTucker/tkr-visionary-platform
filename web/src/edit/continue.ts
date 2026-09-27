/**
 * Continue from the out-point.
 *
 * A take trimmed because its last second went wrong is continued from the cut,
 * not from that second. Continue used to read nothing but the take's id, so the
 * next take picked up the motion the trim had just thrown away — the pinned
 * context is the *end* of the saved latent, and the end was the part cut off.
 *
 * So Continue now also sends where the cut is: `continue_at`, seconds into the
 * delivered take, read off the clip's out point (`timing.trim.to`, which is
 * source µs, and for a take the source *is* the delivered clip). The server
 * cuts the saved latent to end there before the pack loads it, snapped DOWN
 * onto the VAE's 17-frame cycle — the pack slices nothing else — and says how
 * far it moved (`continued_at`, `continue_snap`). An untrimmed take sends no
 * `continue_at` at all, so its behaviour is byte-for-byte what it was.
 *
 * **When the continuation lands, the source's out-point moves to the snap.**
 * The new take opens where the context ended, `continued_at`, and the source
 * clip would otherwise still play on to the out-point it had — up to 16 frames
 * that both sides of the join then show, the same motion twice. So the landing
 * edit (`slot.continue`) also trims the source back to `continued_at`, one undo
 * entry for both, and each slot says what the snap did (Slot.tsx).
 *
 * **The out-point is read when Generate is pressed, not when Continue was.**
 * Continue arms and Generate spends, and between the two somebody can nudge the
 * trim another frame — a value captured at arm time would send the cut they had
 * rather than the cut they have. The arm-time value survives only for a take no
 * longer in the cut, where there is no clip left to read.
 *
 * Page state, not an edit: nothing here is on the undo history, because arming
 * a continuation is not a change to the arrangement.
 */
import { create } from 'zustand'
import type { AnyClip, IProject } from '@openvideo/core'

import { sourceUs } from './cuts'
import { sec } from './engine'
import { clipOfSlot } from './slots'

const DEFAULT_FPS = 24

/**
 * Where a take's out point sits, in seconds into its delivered clip — or null
 * when it sits at the end.
 *
 * "At the end" is within half a frame, because the trim is frame-snapped in
 * microseconds and the file's own length is not: a take nobody trimmed must not
 * start sending a `continue_at` a rounding error short of its end, which the
 * server would then snap back a whole 17-frame cycle.
 */
export function outPointOf(clip: AnyClip, fps: number = DEFAULT_FPS): number | null {
  // Only a take has a saved latent to cut; a dropped file or a title has no
  // continuation to aim.
  if (clip.type !== 'Video') return null
  const to = clip.timing.trim?.to
  const src = sourceUs(clip)
  if (to === undefined || !(to > 0) || !(src > 0)) return null
  const half = 1_000_000 / (fps > 0 ? fps : DEFAULT_FPS) / 2
  return to < src - half ? sec(to) : null
}

/** A continuation's source: the take a clip plays, and where its cut is. */
export type ContinueSource = { jobId: string; file: string; at: number | null }

/** The take `clip` plays and its out-point, or null when it plays no take. */
export function continueFromClip(clip: AnyClip, fps?: number): ContinueSource | null {
  const m = clip.metadata
  if (!m || typeof m.jobId !== 'string' || typeof m.file !== 'string') return null
  return { jobId: m.jobId, file: m.file, at: outPointOf(clip, fps) }
}

/* ---- the armed continuation, and what the server did with it ------------- */

/** What Continue armed: the take, the slot it was pressed on, the out-point it
 *  had then, and the base64 of the frame read there — the frame the Motion
 *  tile falls back to, which is how the tile knows the frame is the cut's. */
export type Armed = {
  jobId: string
  slotId: string | null
  at: number | null
  frame: string | null
}

/** Where the server cut, as it reported it: the out-point asked for, where the
 *  context now ends, and how far back the snap moved it — and `from`, the take
 *  it cut, when the page sent the request (a status does not name it). */
export type Cut = { requested: number; continuedAt: number; snap: number; from?: string }

type ContinueState = {
  armed: Armed | null
  /** Keyed twice: by the *new* take's job id (what the slot it lands in shows)
   *  and by `source@at` (what the Motion tile shows while it stays armed). */
  cuts: Record<string, Cut>
}

export const useContinueCut = create<ContinueState>(() => ({ armed: null, cuts: {} }))

export function arm(armed: Armed): void {
  useContinueCut.setState({ armed })
}

const cutKey = (jobId: string, at: number): string => `${jobId}@${at.toFixed(3)}`

/** The clip playing `jobId` now — in the slot it was armed from when that slot
 *  still plays it, otherwise wherever it plays. */
function clipPlaying(project: IProject | null, jobId: string, slotId: string | null): AnyClip | null {
  if (!project) return null
  const inSlot = slotId ? clipOfSlot(project, slotId) : null
  if (inSlot?.metadata?.jobId === jobId) return inSlot
  return Object.values(project.clips).find((c) => c.metadata?.jobId === jobId) ?? null
}

/**
 * The out-point to continue `jobId` from, read live off `project` (the drawn
 * arrangement, `useEdit`'s) — see the file comment. Null means continue from
 * the end, which is also what an untrimmed take means, so an unarmed or
 * untrimmed continuation sends nothing new.
 *
 * The project is handed in rather than read from `useEdit` here: `useEdit`
 * reads this file's cuts when a continuation lands, and a module each of the
 * two imports is an import cycle whose evaluation order decides which of them
 * sees the other undefined.
 */
export function continueAtFor(jobId: string, project: IProject | null): number | null {
  const armed = useContinueCut.getState().armed
  const clip = clipPlaying(project, jobId, armed?.jobId === jobId ? armed.slotId : null)
  if (clip) return outPointOf(clip, project?.settings.fps)
  return armed?.jobId === jobId ? armed.at : null
}

/** The `/api/video` fields a continuation adds beside `continue_from`. */
export function continueAtBody(
  continueFrom: string | null, project: IProject | null,
): { continue_at?: number } {
  if (!continueFrom) return {}
  const at = continueAtFor(continueFrom, project)
  return at === null ? {} : { continue_at: Number(at.toFixed(3)) }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * Record what the server said it did with an out-point — from the route's
 * reply, which answers before a GPU is rented, and again from the finished
 * job's status. `body` is what was sent (empty for a status), so the snap is
 * filed against the cut it was for.
 */
export function noteCut(runId: string, body: Record<string, unknown>, said: Record<string, unknown>): void {
  const continuedAt = num(said.continued_at)
  const snap = num(said.continue_snap)
  if (continuedAt === null || snap === null) return
  // A status carries where the cut landed and how far it moved, not what was
  // asked — the sum is what was asked, to the millisecond both are rounded to.
  const requested = num(body.continue_at) ?? Number((continuedAt + snap).toFixed(3))
  const sent = typeof body.continue_from === 'string' ? body.continue_from : null
  useContinueCut.setState((s) => {
    // The finished job's status does not say which take it continued; the
    // reply to the request did, so the source filed then is kept — it is what
    // tells a landing continuation whose out-point to move (`landedCut`).
    const from = sent ?? s.cuts[runId]?.from ?? null
    const cut: Cut = { requested, continuedAt, snap, ...(from !== null && { from }) }
    return {
      cuts: { ...s.cuts, [runId]: cut, ...(from !== null && { [cutKey(from, requested)]: cut }) },
    }
  })
}

/**
 * The cut take `jobId` continued from, read once as it lands: the take it cut
 * and where, or null when it was no cut or its source is not known.
 *
 * The continuation opens at `continuedAt`, which the snap put up to 16 frames
 * before the out-point the source clip still shows — so the source's out-point
 * moves back to it in the same edit (`slot.continue`'s `cut`), or those frames
 * of motion play twice across the join.
 */
export function landedCut(jobId: string): { from: string; continuedAt: number } | null {
  const cut = useContinueCut.getState().cuts[jobId]
  return cut?.from ? { from: cut.from, continuedAt: cut.continuedAt } : null
}

/** The cut the server made for take `jobId`, or null — what a slot playing
 *  that take shows. */
export function useTakeCut(jobId: string | null): Cut | null {
  return useContinueCut((s) => (jobId ? s.cuts[jobId] ?? null : null))
}

/**
 * The cut a continuation of take `jobId` moved that take's out-point back for,
 * while the out-point is still where it was moved to — what the *source* slot
 * shows. Derived from the clip rather than recorded at landing, so an undo, or
 * a trim somebody makes afterwards, takes the mark away with the reason for it.
 */
export function useSourceCut(jobId: string | null, outAt: number | null, fps: number = DEFAULT_FPS): Cut | null {
  return useContinueCut((s) => {
    if (!jobId || outAt === null) return null
    const half = 1 / (fps > 0 ? fps : DEFAULT_FPS) / 2
    return Object.values(s.cuts).find((c) =>
      c.from === jobId && c.snap > 0 && Math.abs(c.continuedAt - outAt) < half) ?? null
  })
}

/** The cut the armed continuation will make, once the server has said. */
export function cutFor(jobId: string, at: number): Cut | null {
  return useContinueCut.getState().cuts[cutKey(jobId, at)] ?? null
}

/** Seconds, as the page writes them next to a cut. */
export function secs(s: number): string {
  return `${s.toFixed(2)}s`
}

/** One sentence for a cut the snap moved: what was asked, where it landed, why. */
export function snapNote(cut: Cut): string {
  return cut.snap > 0
    ? `Continues from ${secs(cut.continuedAt)} — the cut at ${secs(cut.requested)} `
      + `moved back ${secs(cut.snap)} onto the motion latent's 17-frame grid.`
    : `Continues from the cut at ${secs(cut.continuedAt)}, exactly.`
}

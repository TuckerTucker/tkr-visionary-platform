/**
 * What a re-render made out of date — derived, never stored.
 *
 * A take is sometimes made *from* another take. A continuation carries the
 * motion latent of the take it continues (`continue_from`); an insert that took
 * V1's frame opens on a picture read out of the V1 take under it. Re-render
 * that source, or step it to another take with ‹ ›, and the take made from it
 * now joins onto — or cuts away from — something that is no longer in the cut.
 * Nothing about that is visible in the picture until somebody watches the join,
 * and by then it may be in an export.
 *
 * **The record is on the take, and staleness is arithmetic over it.** A take
 * says which take it was made from (`from` on a continuation, `conditionedOn`
 * on anything made from another take — job ids, written when it lands; see
 * `ConditionedTake`); the arrangement says which take each slot
 * plays now (the clip's metadata, in the Core). A slot is stale when the slot
 * holding its source take plays a different take. Nothing is written when a
 * slot goes stale, so nothing has to be unwritten: an undo of the re-render, or
 * ‹ back to the old take, puts the source's take back in its clip and the mark
 * is gone on the same frame. A stored flag would need a second undo history to
 * agree with the first, and the day they disagreed nobody could say which one
 * the export should believe.
 *
 * **Per take, not per slot.** A slot's own ↻ renders without a continuation
 * (`slotBody` in useVideo), so a stale continuation re-rendered from its own
 * button is a take conditioned on nothing — correctly not stale — while its
 * earlier take, one ‹ away, still is. A per-slot field would say the opposite
 * of one of them.
 *
 * **Only a frame makes an insert conditioned.** What an insert inherits — cast,
 * look, LoRAs — is the scene's, not the V1 take's (inherit.ts), so re-rendering
 * the V1 slot under it changes nothing the insert was made from unless it took
 * V1's frame. Marking a frameless cutaway stale would be a mark that is wrong
 * every time it shows, which teaches people to ignore the one that is right.
 *
 * **Transitive along chains.** Slot 4 continued from slot 3, slot 3 from slot
 * 2: re-render slot 2 and slot 3 is stale *because of slot 2*, slot 4 because
 * of slot 3 — whose take it still plays, but which is itself out of date.
 *
 * Pure: `import type` only, and the arrangement helpers, so the walk can be run
 * without an engine, a store or a DOM (tools/ui-checks/check_stale.py runs it
 * under node).
 */
import type { AnyClip, IProject, ITrack } from '@openvideo/core'

import type { SceneTake } from '../store'
import { clipsOn, slotOf, v1 } from './project'

/** A take, with the slot it was rendered for and the take it was made from.
 *  `conditionedOn` is optional because every take landed before it was
 *  recorded has none — and a take conditioned on nothing is never stale. */
export type ConditionedTake = SceneTake & { slot?: string; conditionedOn?: string }

/** How a take was made from another: continued from its motion, or opened on
 *  its frame (an insert that took V1's frame). */
export type Conditioning = 'continue' | 'frame'

/** One "made from" link, as the arrangement stands now. */
export type Edge = {
  /** The slot whose take was made from another. */
  slot: string
  /** The slot holding the take it was made from. */
  on: string
  /** The take it was made from, by job id. */
  onTake: string
  how: Conditioning
}

/** Why a slot is out of date. */
export type Staleness = {
  /** The slot whose change made it so. */
  because: string
  /** `retaken`: `because` plays a different take than the one this slot was
   *  made from. `upstream`: `because` still plays that take, but is itself out
   *  of date. */
  reason: 'retaken' | 'upstream'
  how: Conditioning
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const jobOf = (c: Pick<AnyClip, 'metadata'>): string | null =>
  typeof c.metadata?.jobId === 'string' && c.metadata.jobId ? c.metadata.jobId : null

/** Each slot, and the take its clip plays now. A slot whose clip plays nothing
 *  (an empty insert, a title) is absent: it was made from nothing. */
export function playingBySlot(project: Pick<IProject, 'clips'>): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of Object.values(project.clips)) {
    const s = slotOf(c)
    const j = jobOf(c)
    if (s && j) out.set(s, j)
  }
  return out
}

/** Whether `slotId` is an insert — it has a context on some track. Read here
 *  rather than through inherit.ts, which reaches the store and the editor. */
function isInsert(project: Pick<IProject, 'tracks'>, slotId: string): boolean {
  return project.tracks.some((t) => {
    const ins = (t as ITrack & { inserts?: unknown }).inserts
    return isObj(ins) && isObj(ins[slotId])
  })
}

/**
 * Every "made from" link in the cut: for each slot playing a take, the take it
 * was made from and the slot holding that take.
 *
 * The source slot is the one the source take was *rendered for* (its `slot`),
 * not the one playing it: after a re-render the slot no longer plays it, and
 * that is exactly the case being asked about. A take from before slots were
 * stamped falls back to whichever clip plays it.
 *
 * `fallback` answers for a take with no `conditionedOn` — the page passes what
 * it still remembers this session (a trimmed continuation's cut, continue.ts),
 * so a take landed before the record was kept is not silently unconditioned
 * while the page that watched it land is still open.
 */
export function conditioningEdges(
  project: Pick<IProject, 'clips' | 'tracks'>,
  takes: readonly ConditionedTake[],
  fallback: (jobId: string) => string | null = () => null,
): Edge[] {
  const playing = playingBySlot(project)
  const slotPlaying = (job: string): string | null => {
    for (const [s, j] of playing) if (j === job) return s
    return null
  }
  const edges: Edge[] = []
  for (const [slot, job] of playing) {
    const rec = takes.find((t) => t.jobId === job && t.slot === slot) ?? takes.find((t) => t.jobId === job)
    // `from` first: it is the chain's own record, written on every
    // continuation (re-anchored ones too), where `conditionedOn` is the
    // general "made from" that inserts share.
    const cont = typeof rec?.from === 'string' && rec.from ? rec.from : null
    const onTake = cont || (typeof rec?.conditionedOn === 'string' && rec.conditionedOn) || fallback(job)
    if (!onTake || onTake === job) continue
    const on = takes.find((t) => t.jobId === onTake && t.slot)?.slot ?? slotPlaying(onTake)
    if (!on || on === slot) continue
    edges.push({ slot, on, onTake, how: !cont && isInsert(project, slot) ? 'frame' : 'continue' })
  }
  return edges
}

/**
 * The staleness walk: which slots are out of date, and because of which slot.
 *
 * Direct first — a slot whose source slot plays a different take. A source
 * slot that is no longer in the cut at all is *not* a different take: there is
 * nothing to re-render from, and a mark with no remedy is noise. Then along
 * the chains, breadth-first, each slot made from a stale slot's current take
 * inheriting the staleness; a direct reason is never overwritten by an
 * upstream one, because the direct one is the one with something to do about
 * it. A cycle (which no gesture makes, but a hand-edited project could) ends
 * the walk rather than looping.
 */
export function staleWalk(edges: readonly Edge[], playing: ReadonlyMap<string, string>): Map<string, Staleness> {
  const out = new Map<string, Staleness>()
  for (const e of edges) {
    const now = playing.get(e.on)
    if (now !== undefined && now !== e.onTake) out.set(e.slot, { because: e.on, reason: 'retaken', how: e.how })
  }
  const from = new Map<string, Edge[]>()
  for (const e of edges) from.set(e.on, [...(from.get(e.on) ?? []), e])
  const queue = [...out.keys()]
  while (queue.length) {
    const s = queue.shift()!
    for (const e of from.get(s) ?? []) {
      if (out.has(e.slot) || playing.get(s) !== e.onTake) continue
      out.set(e.slot, { because: s, reason: 'upstream', how: e.how })
      queue.push(e.slot)
    }
  }
  return out
}

/** Every stale slot in `project`. */
export function staleSlots(
  project: Pick<IProject, 'clips' | 'tracks'> | null,
  takes: readonly ConditionedTake[],
  fallback?: (jobId: string) => string | null,
): Map<string, Staleness> {
  if (!project) return new Map()
  return staleWalk(conditioningEdges(project, takes, fallback), playingBySlot(project))
}

/**
 * The take V1 plays under the start of insert `slotId`, when the insert took
 * V1's frame — the take a render of the insert is made from, to be written on
 * the take that lands as its `conditionedOn`. Null when the insert took no
 * frame (it is made from the scene, not from V1) or nothing on V1 plays there.
 */
export function insertCondition(project: Pick<IProject, 'clips' | 'tracks'> | null, slotId: string): string | null {
  if (!project) return null
  let frame = false
  for (const t of project.tracks) {
    const ins = (t as ITrack & { inserts?: unknown }).inserts
    const ctx = isObj(ins) ? ins[slotId] : undefined
    if (isObj(ctx)) { frame = ctx.frame === true; break }
  }
  if (!frame) return null
  const mine = Object.values(project.clips).find((c) => slotOf(c) === slotId)
  const at = mine?.timing.display.from
  const track = v1(project)
  if (at === undefined || !track) return null
  for (const c of clipsOn(project, track)) {
    if (c.type === 'Transition') continue
    const d = c.timing.display
    if (d.from <= at && at < d.to) return jobOf(c)
  }
  return null
}

/* ---- saying it ---------------------------------------------------------- */

/** m:ss, with a tenth when the time has one — the clock the insert's own
 *  chips use ("inherited from V1 at 0:04.5"), so the two read as one place. */
function clock(micro: number): string {
  const t = Math.max(0, micro / 1_000_000)
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const tenths = Math.round(s * 10) / 10
  const text = Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1)
  return `${String(m)}:${text.padStart(Number.isInteger(tenths) ? 2 : 4, '0')}`
}

/**
 * What a person calls a slot: "slot 3" for the third take on V1, "insert at
 * 0:12" for anything on another track. Slot ids are opaque by design (they
 * outlive every reorder), so they are never what a sentence names.
 */
export function slotLabel(project: Pick<IProject, 'clips' | 'tracks'> | null, slotId: string): string {
  if (!project) return 'a slot'
  const track = v1(project)
  if (track) {
    const onV1 = clipsOn(project, track).filter((c) => c.type !== 'Transition')
    const i = onV1.findIndex((c) => slotOf(c) === slotId)
    if (i >= 0) return `slot ${String(i + 1)}`
  }
  const clip = Object.values(project.clips).find((c) => slotOf(c) === slotId)
  return clip ? `insert at ${clock(clip.timing.display.from)}` : 'a slot no longer in the cut'
}

/** One sentence: why `slotId` is out of date. */
export function staleSentence(project: Pick<IProject, 'clips' | 'tracks'> | null, s: Staleness): string {
  const src = slotLabel(project, s.because)
  if (s.reason === 'upstream') {
    return s.how === 'frame'
      ? `Opens on a frame of ${src}, which is itself out of date.`
      : `Continued from ${src}, which is itself out of date.`
  }
  return s.how === 'frame'
    ? `Opens on ${src}'s frame from an earlier take — ${src} plays a different take now.`
    : `Continued from ${src}'s earlier take — ${src} plays a different take now.`
}

/**
 * The slot whose re-render would clear `slotId`: itself when the reason is
 * direct, otherwise the first slot up the chain that is out of date directly —
 * re-rendering a slot made from a stale take only makes a second stale take.
 */
export function rootOf(stale: ReadonlyMap<string, Staleness>, slotId: string): string {
  let at = slotId
  for (let i = 0; i < stale.size; i++) {
    const s = stale.get(at)
    if (!s || s.reason === 'retaken') return at
    at = s.because
  }
  return at
}

/** Stale slots in cut order: V1 by time, then the other tracks by time. */
export function staleOrder(project: Pick<IProject, 'clips' | 'tracks'> | null, stale: ReadonlyMap<string, Staleness>): string[] {
  if (!project) return [...stale.keys()]
  const track = v1(project)
  const at = (id: string): [number, number] => {
    const c = Object.values(project.clips).find((x) => slotOf(x) === id)
    const onV1 = !!(c && track?.clipIds.includes(c.id))
    return [onV1 ? 0 : 1, c?.timing.display.from ?? Number.MAX_SAFE_INTEGER]
  }
  return [...stale.keys()].sort((a, b) => {
    const [ta, fa] = at(a)
    const [tb, fb] = at(b)
    return ta - tb || fa - fb
  })
}

/** "2 slots are out of date: slot 3, insert at 0:12" — what Export says. */
export function staleSummary(project: Pick<IProject, 'clips' | 'tracks'> | null, stale: ReadonlyMap<string, Staleness>): string {
  const names = staleOrder(project, stale).map((id) => slotLabel(project, id))
  const n = names.length
  return `${String(n)} slot${n === 1 ? ' is' : 's are'} out of date: ${names.join(', ')}`
}

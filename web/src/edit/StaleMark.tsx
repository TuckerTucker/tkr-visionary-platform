import type { CSSProperties, PointerEvent } from 'react'
import type { AnyClip, IProject, ITrack } from '@openvideo/core'

import { PX_PER_SEC } from '../scene/Timeline'
import { useStore } from '../store'
import { continueSlot, renderSlot } from '../video/useVideo'
import { useContinueCut, type Cut } from './continue'
import { sec } from './engine'
import { slotOf } from './project'
import { chosenTake, useSlotRuns } from './slots'
import {
  rootOf, slotLabel, staleSentence, staleSlots, type ConditionedTake, type Staleness,
} from './stale'
import { useEdit } from './useEdit'

/**
 * (StaleMark, not Stale.tsx: beside `stale.ts` on a case-insensitive disk,
 * `./Stale` resolves to the pure module and the component cannot be imported —
 * the clash that made export.ts exportCut.ts.)
 *
 * A slot made from a take the cut no longer plays, marked on itself — and the
 * one press that makes it again from the new cut.
 *
 * **Marked, never mended on its own.** A re-render of slot 2 is three minutes
 * of GPU; re-rendering slot 3 behind it unasked would spend three more on a
 * take somebody may be about to step back from with ‹, and a chain of five
 * would spend twelve. The mark says what changed and offers the render; the
 * person decides whether the join matters.
 *
 * **Drawn as a state of the clip, plus one control.** An amber edge round the
 * whole bar — the clip is what is out of date, not a corner of it — and a
 * small `stale` button whose sentence names why ("Continued from slot 2's
 * earlier take — slot 2 plays a different take now"). It keeps off everything
 * already on a clip: the trim handles own both ends (`--et-trim`), the slot's
 * ↻ → own the top right and its ‹ n/N › the bottom right (`Slot`), and the
 * middle is the timeline's seek. On a V1 slot it takes the top-left corner,
 * which nothing else uses there; on an insert the top row is its inherited
 * chips, so it takes the bottom-left, which only a continuation's snap mark
 * uses — and an insert is never a continuation. A clip too short to carry it
 * keeps the edge alone, and Export still names it.
 *
 * **What the press does depends on what the slot was made from:**
 *
 * - *An insert that opened on V1's frame* renders again (`renderSlot`, the
 *   slot's own ↻) — the frame is read out of V1 when the render starts, so it
 *   is the new take's frame.
 * - *A continuation* is armed again from the source slot's new take
 *   (`continueSlot`, the source's own →) with this take's sentence put back in
 *   the prompt, so Generate makes the same beat from the new cut. It lands
 *   after the source slot, as every continuation does; the stale take stays
 *   where it is, one undo from gone.
 * - *A slot stale only because the slot it was made from is* sends the press
 *   up the chain to the slot that changed directly: remaking slot 4 from slot
 *   3's out-of-date take would only make a second out-of-date take.
 *
 * Undo of the re-render — or ‹ back to the old take — takes the mark away on
 * the same frame, because the mark is derived (stale.ts) and nothing here is
 * stored.
 */
export type StaleProps = { clip: AnyClip; track: ITrack }

/* ---- the derivation, shared --------------------------------------------- */

type Inputs = { project: IProject | null; takes: readonly ConditionedTake[]; cuts: Record<string, Cut> }
let memo: (Inputs & { out: Map<string, Staleness> }) | null = null

/** The stale slots for these inputs — computed once per change and shared by
 *  every clip's mark and by Export, which all ask on the same render. */
function staleFor(project: IProject | null, takes: readonly ConditionedTake[], cuts: Record<string, Cut>): Map<string, Staleness> {
  if (memo && memo.project === project && memo.takes === takes && memo.cuts === cuts) return memo.out
  // What the page still remembers of a trimmed continuation's source, for a
  // take that landed before takes recorded `conditionedOn` (continue.ts).
  const out = staleSlots(project, takes, (job) => cuts[job]?.from ?? null)
  memo = { project, takes, cuts, out }
  return out
}

/** Every stale slot, and why — derived from the drawn arrangement and the
 *  takes on each render; never stored. */
export function useStale(): Map<string, Staleness> {
  const project = useEdit((s) => s.project)
  const takes = useStore((s) => s.takes)
  const cuts = useContinueCut((s) => s.cuts)
  return staleFor(project, takes, cuts)
}

/** The stale slots as they stand now, outside a render. */
function staleNow(): Map<string, Staleness> {
  return staleFor(useEdit.getState().project, useStore.getState().takes, useContinueCut.getState().cuts)
}

/**
 * Make `slotId` again from the new cut — see the top for what that means per
 * kind. Only ever called from a press; nothing calls it on a change.
 */
export async function rerenderStale(slotId: string): Promise<void> {
  const stale = staleNow()
  const root = rootOf(stale, slotId)
  const why = stale.get(root)
  if (!why) return
  if (why.how === 'frame') {
    await renderSlot(root)
    return
  }
  const take = chosenTake(useStore.getState().takes, root, useEdit.getState().project)
  await continueSlot(why.because)
  // After the arm, which clears the prose on purpose — a continuation is a new
  // beat. This one is not: it is the stale take's beat, made again.
  if (take?.line.trim()) useStore.getState().setProse(take.line)
}

/** The sentence under the press: what it will do, per kind. */
function offerNote(project: IProject | null, slotId: string, stale: ReadonlyMap<string, Staleness>): string {
  const root = rootOf(stale, slotId)
  const why = stale.get(root)
  if (!why) return ''
  const src = slotLabel(project, why.because)
  const first = root === slotId ? '' : `Re-render ${slotLabel(project, root)} first. `
  return why.how === 'frame'
    ? `${first}Press to render ${root === slotId ? 'this insert' : 'it'} again on ${src}'s frame as it is now.`
    : `${first}Press to continue from ${src}'s new take with ${root === slotId ? "this take's" : 'its'} sentence — `
      + `Generate renders it right after ${src}.`
}

/* ---- the mark ----------------------------------------------------------- */

const ROW = 14
const INSET = 'calc(var(--et-trim, 8px) + 2px)'
/** What `Slot`'s ↻ and → take at the top row's right end, px. */
const SLOT_ACTS = 2 * (ROW + 2) + 4
/** The button's width at 9px, px — "stale" and its padding. */
const CHIP = 30

const stopPress = (e: PointerEvent<HTMLElement>): void => { e.stopPropagation() }

const handle = (): number => (window.matchMedia('(hover:none)').matches ? 14 : 8)

const edge: CSSProperties = {
  position: 'absolute', inset: 0, borderRadius: 'var(--r-inner)', pointerEvents: 'none',
  // Inset, so the edge sits inside the bar and never overlaps a neighbour's.
  boxShadow: 'inset 0 0 0 1px var(--warn)',
}

const chip = (corner: 'top' | 'bottom'): CSSProperties => ({
  position: 'absolute', [corner]: 1, left: INSET, zIndex: 2, height: ROW, width: CHIP,
  padding: 0, border: '1px solid var(--warn)', borderRadius: 'var(--r-inner)',
  background: 'rgba(0,0,0,.6)', color: 'var(--warn)', fontSize: 9, lineHeight: `${String(ROW - 2)}px`,
  cursor: 'pointer',
})

export function StaleMark({ clip, track }: StaleProps) {
  const slotId = slotOf(clip)
  const stale = useStale()
  const project = useEdit((s) => s.project)
  const running = useSlotRuns((s) => (slotId ? !!s[slotId]?.running : false))
  const why = slotId ? stale.get(slotId) : undefined
  if (!slotId || !why) return null

  const sentence = staleSentence(project, why)
  const offer = offerNote(project, slotId, stale)
  const onV1 = !isInsertTrack(track, slotId)
  const room = sec(clip.timing.display.to - clip.timing.display.from) * PX_PER_SEC - 2 * (handle() + 2)
  // On V1 the button shares the top row with ↻ →; on an insert it has the
  // bottom-left to itself, beside the ‹ n/N › that sits at the right.
  const fits = room >= CHIP + (onV1 ? SLOT_ACTS : 0) + 4

  return (
    <span className="et-stale" data-slot={slotId} data-because={why.because} data-reason={why.reason}
          data-how={why.how} role="note" aria-label={`Out of date. ${sentence}`}>
      <span aria-hidden="true" style={edge} />
      {fits && !running && (
        <button type="button" className="et-stale-offer" data-act="restale" data-slot={slotId}
                aria-label={`Out of date. ${sentence} ${offer}`} title={`${sentence}\n\n${offer}`}
                onPointerDown={stopPress} style={chip(onV1 ? 'top' : 'bottom')}
                onClick={() => void rerenderStale(slotId)}>
          stale
        </button>
      )}
    </span>
  )
}

function isInsertTrack(track: ITrack, slotId: string): boolean {
  const ins = (track as ITrack & { inserts?: unknown }).inserts
  return typeof ins === 'object' && ins !== null && slotId in ins
}

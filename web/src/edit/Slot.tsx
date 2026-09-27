import type { CSSProperties, PointerEvent } from 'react'
import type { AnyClip, ITrack } from '@openvideo/core'

import { shotsOf, type TakeShot } from '../scene/model'
import { PX_PER_SEC } from '../scene/Timeline'
import { useStore } from '../store'
import { continueSlot, renderSlot, stopSlot } from '../video/useVideo'
import { outPointOf, secs, snapNote, useSourceCut, useTakeCut, type Cut } from './continue'
import { sourceUs } from './cuts'
import { sec } from './engine'
import { slotOf, takeOf } from './project'
import { clearSlotRun, slotView, useSlotRuns } from './slots'
import { chooseTake, useEdit } from './useEdit'

/**
 * What a slot says and does, drawn on its own clip — `Tracks`' `clipOverlay`.
 *
 * - **‹ n / N ›** when the slot has had more than one take: the canvas's
 *   `#gen-nav`, the same look and the same meaning, stepping which take the
 *   clip plays. Each step is `take.choose`, one undo.
 * - **↻ render** — render the slot again: the prompt as it stands, or, with the
 *   prompt empty, the sentence of the take on screen. The take that lands
 *   replaces this clip's (`slot.render`); the old one stays in the list.
 * - **→ continue** — arm the next Generate to continue from this take; what it
 *   renders lands directly after this slot.
 * - **While rendering**, the job's own phase and a hairline for its percent,
 *   with Stop — `/api/stop`, the same cooperative stop Generate has. The clip
 *   keeps playing the take it had until the new one lands: a render is
 *   replaced when the next one lands, not when it is asked for.
 * - **What the snap did to a continuation's join**, on both sides of it: a
 *   small `−0.38s` on the take that continued (it opens that much before the
 *   cut it was asked for) and on the take it continued from (its out-point
 *   moved back the same distance to meet it — see `cutBack` in commands.ts).
 *   A trim that moved with nothing on the clip saying why reads as the editor
 *   losing a frame count; the sentence is the mark's title.
 * - **A refusal, verbatim, on the slot** it was for. The route's sentence says
 *   what to change; a paraphrase is one fact short. Dismissed by its ✕ — there
 *   is nothing to confirm, and the next render clears it anyway.
 *
 * Nothing asks whether you are sure. Every one of these is undone by undo.
 *
 * **Controls on a clip must not seek.** A press on the lanes seeks and scrubs
 * (`Tracks`), so every press that starts on a control here is stopped before
 * it reaches the lane — a click on ‹ that also moved the playhead would be two
 * edits from one gesture.
 */
export type SlotProps = { clip: AnyClip; track: ITrack }

const stopPress = (e: PointerEvent<HTMLElement>): void => { e.stopPropagation() }

/* Two 14px rows, one along each long edge of the clip, and the height is the
   point: the lane is 34px and a press on its middle is a seek (`Tracks`). A
   control tall enough to reach the middle turns "put the head here" into
   "render this slot" for whoever aimed at the clip's centre line, which is
   where a seek is aimed. The middle stays the timeline's.

   Two rows rather than one because one did not fit: a 3-second take is 90px,
   and ‹ n / N › with ↻ and → beside it is wider than that once the trim
   handles have their ends. The bottom row says which take (or, while one is
   rendering, how far along it is); the top row holds what to do next. */
const ROW = 14

/* Both rows keep off the trim handles (`--et-trim`, tracks.css): a control
   under a handle is one the handle eats — a clip trimmed short had its ↻
   covered by its own out point. The cut's diamond sits astride the join on the
   top edge, inside the same inset. */
const INSET = 'calc(var(--et-trim, 8px) + 2px)'

/* What each control costs, in px, for deciding what a short clip can carry. */
const COST = { stepper: 2 * ROW + 26, button: ROW + 2, gap: 2 }

const btn: CSSProperties = {
  width: ROW + 2, height: ROW, padding: 0, border: 0, borderRadius: 'var(--r-inner)',
  background: 'rgba(0,0,0,.45)', color: 'var(--fg)', fontSize: 11, lineHeight: `${String(ROW)}px`,
  cursor: 'pointer', flex: 'none',
}

const row = (edge: 'top' | 'bottom'): CSSProperties => ({
  position: 'absolute', [edge]: 1, right: INSET, height: ROW, display: 'flex', alignItems: 'center',
  gap: COST.gap, maxWidth: `calc(100% - 2 * ${INSET})`,
})

/* A snap mark's width, px — "−0.38s" at 9px — which decides whether a short
   clip has room for it beside the bottom row. */
const MARK = 34

/* Bottom-left: both rows are right-aligned, the handles own both ends and the
   middle is the seek (see ROW), so the far end of the bottom edge is the one
   place on a clip no control uses — and the bottom row is empty on the slot
   that most needs it, a source with one take. Dim, because it explains an
   edit rather than offering one. */
const mark: CSSProperties = {
  position: 'absolute', bottom: 1, left: INSET, height: ROW, display: 'flex', alignItems: 'center',
  gap: COST.gap, pointerEvents: 'none',
}

const markChip: CSSProperties = {
  fontSize: 9, lineHeight: `${String(ROW)}px`, padding: '0 3px', borderRadius: 'var(--r-inner)',
  background: 'rgba(0,0,0,.45)', color: 'var(--dim)', whiteSpace: 'nowrap', pointerEvents: 'auto',
  cursor: 'default', fontVariantNumeric: 'tabular-nums',
}

/** The sentence on the source slot's mark: its out-point moved to meet the
 *  take that continues it. */
const sourceNote = (cut: Cut): string =>
  `This take's out-point moved back ${secs(cut.snap)}, from ${secs(cut.requested)} to `
  + `${secs(cut.continuedAt)}, because the take after it continues from there — the motion `
  + 'latent is cut on a 17-frame grid, and without the move those frames would play twice '
  + 'across the join. Undo puts both back.'

/**
 * Where the `[Shot N]` cuts inside this take fall on the clip, in px from its
 * left edge — the shots it was rendered from, recorded on the take.
 *
 * **Scaled to the file, not taken as seconds.** The document spans each shot
 * at `beats / total * seconds` (`_compile_h3_scene`), and the file that comes
 * back is the frames the model could decode — snapped to its 17-frame grid,
 * capped at one generation — so the recorded seconds are a proportion of what
 * was delivered, and that is how they are placed. Then through the trim and
 * the rate, so a cut the trim took off is not drawn and one it kept stays
 * under the frame it is on.
 */
function shotMarks(shots: readonly TakeShot[], clip: AnyClip): { n: number; x: number }[] {
  const total = shots.reduce((n, s) => n + s.beats, 0)
  if (shots.length < 2 || total <= 0) return []
  const t = clip.timing
  const source = sec(sourceUs(clip))
  const from = sec(t.trim?.from ?? 0)
  const rate = t.playbackRate && t.playbackRate > 0 ? t.playbackRate : 1
  const width = sec(t.display.to - t.display.from)
  const out: { n: number; x: number }[] = []
  let run = 0
  shots.slice(0, -1).forEach((s, i) => {
    run += s.beats
    const at = ((run / total) * source - from) / rate
    if (at > 0 && at < width) out.push({ n: i + 2, x: at * PX_PER_SEC })
  })
  return out
}

/** The trim handle's width here, px — tracks.css widens it where there is no
 *  hover, and the room left for the rows is what is between the two. */
const handle = (): number => (window.matchMedia('(hover:none)').matches ? 14 : 8)

export function Slot({ clip }: SlotProps) {
  const slotId = slotOf(clip)
  const takes = useStore((s) => s.takes)
  const project = useEdit((s) => s.project)
  const heldOut = useEdit((s) => clip.id in s.broken)
  const run = useSlotRuns((s) => (slotId ? s[slotId] : undefined))
  const hasProse = useStore((s) => s.scene.shots.some((x) => x.line.trim() !== ''))
  const jobId = typeof clip.metadata?.jobId === 'string' ? clip.metadata.jobId : null
  const fps = project?.settings.fps
  const opened = useTakeCut(jobId)
  const moved = useSourceCut(jobId, outPointOf(clip, fps), fps)
  if (!slotId) return null

  const { takes: list, chosen } = slotView(takes, slotId, project)
  const n = list.length
  // A slot is one generation and holds the shots rendered in it: H3 makes the
  // cuts between them inside one take, so they are drawn inside the clip
  // rather than as clips of their own. A take that recorded none (rendered
  // before takes kept them, or one shot) draws none rather than guessing.
  const recorded = shotsOf(takeOf(clip, takes))
  const shotCuts = recorded ? shotMarks(recorded, clip) : []

  // A clip trimmed very short cannot carry every control, and a row that
  // overflows pushes its last control under the out handle. What goes first
  // is what has another way in: Continue is also the canvas's, a re-render is
  // also Generate's; which take the slot plays has no other control at all.
  const room = sec(clip.timing.display.to - clip.timing.display.from) * PX_PER_SEC - 2 * (handle() + 2)
  const showStepper = n > 1 && room >= COST.stepper
  const showRender = room >= COST.button
  const showContinue = room >= 2 * COST.button + COST.gap
  const marks = [
    ...(opened && opened.snap > 0 ? [{ kind: 'continued', cut: opened, note: snapNote(opened) }] : []),
    ...(moved ? [{ kind: 'source', cut: moved, note: sourceNote(moved) }] : []),
  ]
  // After the bottom row's controls: the marks explain, the stepper acts, and
  // a clip with room for only one keeps the one that acts. Not while a render
  // runs — the phase and Stop take that row, and the join may be about to change.
  const running = !!run?.running
  const beside = showStepper ? COST.stepper + COST.gap : 0
  const showMarks = marks.length > 0 && !running && room >= beside + marks.length * (MARK + COST.gap)
  const err = run?.error ?? null
  const errText = err === null ? '' : typeof err === 'string' ? err : err.error
  const errDetail = err !== null && typeof err !== 'string' ? err.detail : undefined

  return (
    <>
      {shotCuts.length > 0 && (
        <div className="et-shots" data-shots={recorded?.length} aria-hidden="true"
             style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {shotCuts.map((c) => (
            <span key={c.n} className="et-shot-cut" data-shot={c.n}
                  style={{ position: 'absolute', top: ROW + 2, bottom: ROW + 2, left: c.x, width: 1,
                           background: 'var(--line-2)' }} />
          ))}
        </div>
      )}

      {running && (
        <span aria-hidden="true" style={{
          position: 'absolute', left: 0, bottom: 0, height: 2, pointerEvents: 'none',
          width: `${String(Math.max(2, Math.min(100, run.percent)))}%`, background: 'var(--fg)',
          transition: 'width .4s linear',
        }} />
      )}

      {showMarks && (
        <div className="et-slot-marks" data-slot={slotId} onPointerDown={stopPress} style={mark}>
          {marks.map((m) => (
            <span key={m.kind} className="et-snap" data-cut={m.kind} data-snap={m.cut.snap}
                  role="note" aria-label={m.note} title={m.note} style={markChip}>
              −{secs(m.cut.snap)}
            </span>
          ))}
        </div>
      )}

      {!running && (showRender || showContinue) && (
        <div className="et-slot-acts" data-slot={slotId} onPointerDown={stopPress} style={row('top')}>
          {showRender && <button type="button" data-act="render" style={btn}
                  title={hasProse
                    ? 'Render the prompt into this slot — the take it has stays one ‹ away'
                    : 'Render this slot again from its sentence — the take it has stays one ‹ away'}
                  aria-label="Render this slot"
                  onClick={() => void renderSlot(slotId)}>↻</button>}
          {showContinue && <button type="button" data-act="continue" style={btn}
                  title="Continue from this take — write the next beat and Generate; it lands after this slot"
                  aria-label="Continue from this take"
                  disabled={chosen < 0 || heldOut}
                  onClick={() => void continueSlot(slotId)}>→</button>}
        </div>
      )}

      <div className="et-slot" data-slot={slotId} onPointerDown={stopPress} style={row('bottom')}>
        {showStepper && !running && (
          <div className="film-nav et-slot-nav" style={{ margin: 0, opacity: 1, gap: 1 }}>
            <button type="button" className="ico" data-act="prev" style={btn}
                    title="The take before this one — one undo"
                    aria-label="Previous take"
                    disabled={chosen <= 0}
                    onClick={() => void chooseTake(slotId, chosen - 1)}>‹</button>
            <span className="count" style={{ minWidth: 0, fontSize: 10, padding: '0 1px' }}>
              {chosen >= 0 ? String(chosen + 1) : '–'} / {n}
            </span>
            <button type="button" className="ico" data-act="next" style={btn}
                    title="The take after this one — one undo"
                    aria-label="Next take"
                    disabled={chosen >= n - 1}
                    onClick={() => void chooseTake(slotId, chosen + 1)}>›</button>
          </div>
        )}

        {running && (
          <>
            <span className="et-slot-phase" aria-live="polite"
                  style={{ fontSize: 10, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden',
                           textOverflow: 'ellipsis', minWidth: 0, background: 'rgba(0,0,0,.45)',
                           padding: '0 4px', borderRadius: 'var(--r-inner)', lineHeight: `${String(ROW)}px` }}>
              {run.phase || 'Working…'}
            </span>
            <button type="button" data-act="stop" style={btn}
                    title={run.runId ? 'Stop this render — the slot keeps the take it has'
                                     : 'Starting — Stop is live once the job has an id'}
                    aria-label="Stop the render"
                    disabled={!run.runId}
                    onClick={() => void stopSlot(slotId)}>■</button>
          </>
        )}
      </div>

      {err !== null && (
        <div className="et-slot-err" role="alert" onPointerDown={stopPress}
             title={errDetail ? `${errText}\n\n${errDetail}` : errText}
             style={{
               position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 4,
               padding: '0 4px 0 8px', background: 'var(--crit-fill)',
               border: '1px solid var(--crit-line)', borderRadius: 'var(--r-inner)',
             }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#fca5a5', whiteSpace: 'nowrap',
                         overflow: 'hidden', textOverflow: 'ellipsis' }}>{errText}</span>
          <button type="button" data-act="dismiss" style={btn} aria-label="Dismiss"
                  title="Dismiss — the slot still has the take it had"
                  onClick={() => clearSlotRun(slotId)}>✕</button>
        </div>
      )}
    </>
  )
}

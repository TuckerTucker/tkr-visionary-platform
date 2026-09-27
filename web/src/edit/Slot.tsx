import type { CSSProperties, PointerEvent } from 'react'
import type { AnyClip, ITrack } from '@openvideo/core'

import { useStore } from '../store'
import { continueSlot, renderSlot, stopSlot } from '../video/useVideo'
import { slotOf } from './project'
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

/* One 14px row along the clip's bottom edge, and the height is the point: the
   lane is 34px and a press on its middle is a seek (`Tracks`). A control
   tall enough to reach the middle turns "put the head here" into "render this
   slot" for whoever aimed at the clip's centre line, which is where a seek is
   aimed. The top half stays the timeline's; the bottom row is the slot's. */
const ROW = 14

const btn: CSSProperties = {
  width: ROW + 2, height: ROW, padding: 0, border: 0, borderRadius: 'var(--r-inner)',
  background: 'rgba(0,0,0,.45)', color: 'var(--fg)', fontSize: 11, lineHeight: `${String(ROW)}px`,
  cursor: 'pointer', flex: 'none',
}

export function Slot({ clip }: SlotProps) {
  const slotId = slotOf(clip)
  const takes = useStore((s) => s.takes)
  const project = useEdit((s) => s.project)
  const heldOut = useEdit((s) => clip.id in s.broken)
  const run = useSlotRuns((s) => (slotId ? s[slotId] : undefined))
  const hasProse = useStore((s) => s.scene.shots.some((x) => x.line.trim() !== ''))
  if (!slotId) return null

  const { takes: list, chosen } = slotView(takes, slotId, project)
  const n = list.length
  const running = !!run?.running
  const err = run?.error ?? null
  const errText = err === null ? '' : typeof err === 'string' ? err : err.error
  const errDetail = err !== null && typeof err !== 'string' ? err.detail : undefined

  return (
    <>
      {running && (
        <span aria-hidden="true" style={{
          position: 'absolute', left: 0, bottom: 0, height: 2, pointerEvents: 'none',
          width: `${String(Math.max(2, Math.min(100, run.percent)))}%`, background: 'var(--fg)',
          transition: 'width .4s linear',
        }} />
      )}

      <div className="et-slot" data-slot={slotId} onPointerDown={stopPress}
           style={{
             position: 'absolute', right: 2, bottom: 1, height: ROW, display: 'flex', alignItems: 'center',
             gap: 2, maxWidth: 'calc(100% - 4px)',
           }}>
        {n > 1 && !running && (
          <div className="film-nav et-slot-nav" style={{ margin: 0, opacity: 1, gap: 1 }}>
            <button type="button" className="ico" data-act="prev" style={btn}
                    title="The take before this one — one undo"
                    aria-label="Previous take"
                    disabled={chosen <= 0}
                    onClick={() => void chooseTake(slotId, chosen - 1)}>‹</button>
            <span className="count" style={{ minWidth: 0, fontSize: 10, padding: '0 2px' }}>
              {chosen >= 0 ? String(chosen + 1) : '–'} / {n}
            </span>
            <button type="button" className="ico" data-act="next" style={btn}
                    title="The take after this one — one undo"
                    aria-label="Next take"
                    disabled={chosen >= n - 1}
                    onClick={() => void chooseTake(slotId, chosen + 1)}>›</button>
          </div>
        )}

        {running ? (
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
        ) : (
          <>
            <button type="button" data-act="render" style={btn}
                    title={hasProse
                      ? 'Render the prompt into this slot — the take it has stays one ‹ away'
                      : 'Render this slot again from its sentence — the take it has stays one ‹ away'}
                    aria-label="Render this slot"
                    onClick={() => void renderSlot(slotId)}>↻</button>
            <button type="button" data-act="continue" style={btn}
                    title="Continue from this take — write the next beat and Generate; it lands after this slot"
                    aria-label="Continue from this take"
                    disabled={chosen < 0 || heldOut}
                    onClick={() => void continueSlot(slotId)}>→</button>
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

import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { AnyClip, ITrack } from '@openvideo/core'

import type { ApiError } from '../api/client'
import type { SceneTake } from '../store'
import type { Edge } from './cuts'
import { sec } from './engine'
import { slotOf } from './project'

/**
 * One clip on a lane: a bar as long as the time it plays, at the timeline's
 * fixed scale, showing what the take was.
 *
 * **The take's sentence, not a thumbnail.** A frame would be one more fetch or
 * decode per clip for a picture the stage above is already showing, and the
 * sentence is the thing that tells two takes of the same people apart — the
 * reason `scene/Timeline`'s shot bars carry their prose rather than a picture.
 *
 * **A clip that will not load says so on itself**, naming its file, and keeps
 * its length: the place it held in the cut is part of the arrangement whether
 * or not the bytes came back.
 *
 * **Its edges are its in and out points.** A clip that can be trimmed carries a
 * handle on each end — the whole height of the bar, because an edge you have to
 * find is an edge nobody trims. Each handle is a slider to a keyboard: focus it
 * and ←/→ move that edge one frame, Shift a second, Home/End to the file's ends.
 * Dragging the bar itself reorders it (see `Tracks`), and Alt+←/→ on the focused
 * bar does the same one place at a time. A clip that cannot be edited right now
 * keeps its handles, greyed, with the reason on them — not hidden, so the reason
 * is where somebody reaching for the edge will find it.
 *
 * **Room for what comes next is `children`.** A take stepper, a stale badge —
 * each is drawn *on* the clip it is about, never in a panel beside it, so each
 * arrives as a child laid over the bar (`Tracks`' `clipOverlay` passes them
 * down). The bar is `position:relative` for exactly that.
 */
export type ClipProps = {
  clip: AnyClip
  track: ITrack
  /** The timeline's scale — every clip on a timeline shares one. */
  pxPerSec: number
  /** The take this clip plays, when it is one. */
  take: SceneTake | null
  /** Why its file would not load. */
  failure?: ApiError
  /** Trim and reorder, for a clip on V1. Absent: the clip is only drawn. */
  edit?: ClipEdit
  /** Where the bar sits while it is being dragged, in px from the lane's start —
   *  the pointer's place rather than a time the arrangement holds. */
  liftedLeft?: number
  children?: ReactNode
}

export type ClipEdit = {
  /** Why this clip cannot be edited right now, or null. */
  lock: string | null
  /** Whether it has a file whose in and out points can move. */
  trim: boolean
  /** The file's length, in source µs — the out point's limit. */
  source: number
  /** The in and out points now, in source µs. */
  inPoint: number
  outPoint: number
  onTrimPress: (edge: Edge, e: PointerEvent<HTMLElement>) => void
  onTrimKey: (edge: Edge, e: KeyboardEvent<HTMLElement>) => void
  /** A key on the focused bar — Alt+←/→ moves it along V1. */
  onKey: (e: KeyboardEvent<HTMLElement>) => void
}

const secs = (micro: number): string => {
  const s = sec(micro)
  return s % 1 ? s.toFixed(2).replace(/0$/, '') : String(s)
}

export function Clip({ clip, track, pxPerSec, take, failure, edit, liftedLeft, children }: ClipProps) {
  const from = sec(clip.timing.display.from)
  const length = sec(clip.timing.display.to - clip.timing.display.from)
  const line = take?.line.trim() || ''
  const file = typeof clip.metadata?.file === 'string' ? clip.metadata.file : clip.name
  const movable = !!edit && !edit.lock && !failure
  const what = line || file
  const lifted = liftedLeft !== undefined
  return (
    <div className={`et-clip${failure ? ' broken' : ''}${edit ? ' editable' : ''}${lifted ? ' lifted' : ''}`}
         data-clip={clip.id} data-track={track.id}
         data-slot={slotOf(clip) ?? undefined}
         data-job={typeof clip.metadata?.jobId === 'string' ? clip.metadata.jobId : undefined}
         data-movable={movable ? '1' : undefined}
         tabIndex={edit ? 0 : undefined}
         aria-label={edit ? `${what}, ${length.toFixed(1)} seconds` : undefined}
         onKeyDown={edit ? edit.onKey : undefined}
         style={{ left: lifted ? liftedLeft : from * pxPerSec, width: Math.max(2, length * pxPerSec) }}
         title={failure
           ? `${failure.error}${failure.detail ? `\n\n${failure.detail}` : ''}`
           : `${what} — ${length.toFixed(1)}s${edit && !edit.lock ? '\nDrag to move it along V1 · Alt+←/→' : ''}`}>
      {failure
        ? <span className="et-fail">{failure.error}</span>
        : <span className="et-line">{line || <i>{file}</i>}</span>}
      <span className="et-secs">{length % 1 ? length.toFixed(1) : String(length)}s</span>
      {edit?.trim && !failure && (['in', 'out'] as const).map((edge) => {
        const at = edge === 'in' ? edit.inPoint : edit.outPoint
        const name = edge === 'in' ? 'In point' : 'Out point'
        return (
          <span key={edge} className={`et-trim ${edge}`} data-edge={edge}
                role="slider" tabIndex={0}
                aria-label={`${name} of ${what}`}
                aria-valuemin={0} aria-valuemax={Number(sec(edit.source).toFixed(3))}
                aria-valuenow={Number(sec(at).toFixed(3))}
                aria-valuetext={`${secs(at)} of ${secs(edit.source)} seconds`}
                aria-disabled={edit.lock ? true : undefined}
                title={edit.lock
                  ?? `${name}: ${secs(at)}s of ${secs(edit.source)}s — drag, or ←/→ one frame (Shift: a second)`}
                onPointerDown={(e) => edit.onTrimPress(edge, e)}
                onKeyDown={(e) => edit.onTrimKey(edge, e)} />
        )
      })}
      {children}
    </div>
  )
}

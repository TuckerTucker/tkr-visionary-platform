import type { ReactNode } from 'react'
import type { AnyClip, ITrack } from '@openvideo/core'

import type { ApiError } from '../api/client'
import type { SceneTake } from '../store'
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
 * **Room for what comes next is `children`.** Trim handles, a take stepper, a
 * crossfade mark, a stale badge — each is drawn *on* the clip it is about,
 * never in a panel beside it, so each arrives as a child laid over the bar
 * (`Tracks`' `clipOverlay` passes them down). The bar is `position:relative`
 * for exactly that.
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
  children?: ReactNode
}

export function Clip({ clip, track, pxPerSec, take, failure, children }: ClipProps) {
  const from = sec(clip.timing.display.from)
  const length = sec(clip.timing.display.to - clip.timing.display.from)
  const line = take?.line.trim() || ''
  const file = typeof clip.metadata?.file === 'string' ? clip.metadata.file : clip.name
  return (
    <div className={`et-clip${failure ? ' broken' : ''}`}
         data-clip={clip.id} data-track={track.id}
         data-slot={slotOf(clip) ?? undefined}
         data-job={typeof clip.metadata?.jobId === 'string' ? clip.metadata.jobId : undefined}
         style={{ left: from * pxPerSec, width: Math.max(2, length * pxPerSec) }}
         title={failure
           ? `${failure.error}${failure.detail ? `\n\n${failure.detail}` : ''}`
           : `${line || file} — ${length.toFixed(1)}s`}>
      {failure
        ? <span className="et-fail">{failure.error}</span>
        : <span className="et-line">{line || <i>{file}</i>}</span>}
      <span className="et-secs">{length % 1 ? length.toFixed(1) : String(length)}s</span>
      {children}
    </div>
  )
}

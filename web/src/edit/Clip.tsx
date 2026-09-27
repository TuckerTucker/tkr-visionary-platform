import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AnyClip, ITrack } from '@openvideo/core'

import type { ApiError } from '../api/client'
import type { SceneTake } from '../store'
import type { Edge } from './cuts'
import {
  detachFromClip, firstFree, hasSound, resolveTarget, targetAtPoint, useDetach, type DetachTarget,
} from './detach'
import { sec } from './engine'
import { slotOf } from './project'
import { useEdit } from './useEdit'

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
 * **A take's sound is a strip along its bottom edge** while it is still the
 * clip's own (`detach.ts`). Dragging the strip onto an A track — or below the
 * last track, for a new one — detaches it there; D on the focused bar does the
 * same onto the first A track free for the take's stretch. Either is one undo,
 * and the undo re-links. The strip is the bottom few pixels, inside the trim
 * handles and under the slot's controls (`Slot`, drawn after it), so an edge
 * press is still a trim and a press on ‹ › is still a take: what it takes from
 * the timeline is a sliver of the seek, and only on a clip with sound to give.
 * On a clip too short for ‹ n/N › to sit on the strip and leave most of it
 * free, `Slot` puts the stepper in its top row instead (`slotLayout`) — a
 * drag target you have to find a sliver of is one nobody detaches with.
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

/* The strip's reach: the bottom of the bar, between the trim handles. Taller
   than it is drawn, because a 3px target is one nobody hits — and taller again
   with no hover, where the target is a finger. */
const STRIP_HIT = 8
const STRIP_HIT_TOUCH = 12
const STRIP_DRAWN = 3
const INSET = 'calc(var(--et-trim, 8px) + 2px)'
/** How far the pointer moves before a press on the strip is a drag. Below it
 *  the press does nothing: a strip that detached on a click would be an edit
 *  made by somebody aiming a seek at the bottom of a clip. */
const LIFT_PX = 4

type Carry = { x: number; y: number; dx: number; target: DetachTarget | null; label: string }

/** What the sound would become if it were let go here, in words, for the
 *  ghost it rides on — including when the lane under it is taken. */
function sayTarget(clipId: string, target: DetachTarget | null): string {
  if (!target) return 'Onto an A track, or below the last track'
  const st = useEdit.getState().core?.store.getState()
  const video = st?.clips[clipId]
  if (!st || !video) return 'Detach the sound'
  const r = resolveTarget(st, video, target)
  if (r.trackId) return `Detach the sound onto ${r.name}`
  return 'trackId' in target
    ? `Something plays there — onto a new ${r.name}`
    : `Detach the sound onto a new ${r.name}`
}

export function Clip({ clip, track, pxPerSec, take, failure, edit, liftedLeft, children }: ClipProps) {
  const ready = useEdit((s) => s.phase === 'ready')
  const refusal = useDetach((s) => (s.failed?.clipId === clip.id ? s.failed.err : null))
  const [carry, setCarry] = useState<Carry | null>(null)
  /** Ends a strip drag without detaching — for an unmount mid-drag. */
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])
  const sound = ready && !failure && hasSound(clip)

  const from = sec(clip.timing.display.from)
  const length = sec(clip.timing.display.to - clip.timing.display.from)
  const line = take?.line.trim() || ''
  const file = typeof clip.metadata?.file === 'string' ? clip.metadata.file : clip.name
  const movable = !!edit && !edit.lock && !failure
  const what = line || file
  const lifted = liftedLeft !== undefined
  const barWidth = Math.max(2, length * pxPerSec)

  /** Pick the sound up off the clip and carry it to a lane. Captured on the
   *  strip and stopped there: the lanes' own press would seek and, on V1,
   *  pick the whole clip up. */
  const strip = (e: PointerEvent<HTMLElement>): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const x0 = e.clientX
    const y0 = e.clientY
    const dx = x0 - (el.closest('.et-clip')?.getBoundingClientRect().left ?? x0)
    let moving = false
    let target: DetachTarget | null = null
    try { el.setPointerCapture(e.pointerId) } catch { /* a pointer already gone ends below */ }
    const move = (ev: globalThis.PointerEvent): void => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < LIFT_PX) return
      moving = true
      target = targetAtPoint(ev.clientX, ev.clientY)
      setCarry({ x: ev.clientX, y: ev.clientY, dx, target, label: sayTarget(clip.id, target) })
    }
    const up = (): void => finish(true)
    const cancel = (): void => finish(false)
    // Escape drops it — in the capture phase and stopped there, because mid-drag
    // it means "not this", not the page's own Escape.
    const esc = (ev: globalThis.KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    function finish(ok: boolean): void {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc, true)
      stop.current = null
      setCarry(null)
      if (ok && moving && target) void detachFromClip(clip.id, target)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc, true)
    stop.current?.()
    stop.current = cancel
  }

  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (sound && e.target === e.currentTarget && (e.key === 'd' || e.key === 'D')
        && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      e.preventDefault()
      // Stopped at the bar: the page routes a stray letter typed with nothing
      // in a field into the prompt, and a D that detached a sound is not also
      // the first letter of a sentence — the T that makes a title is stopped
      // the same way.
      e.stopPropagation()
      e.nativeEvent.stopPropagation()
      const st = useEdit.getState().core?.store.getState()
      const video = st?.clips[clip.id]
      if (st && video) void detachFromClip(clip.id, firstFree(st, video))
      return
    }
    edit?.onKey(e)
  }

  const touch = window.matchMedia('(hover:none)').matches
  const stripStyle: CSSProperties = {
    position: 'absolute', left: INSET, right: INSET, bottom: 0,
    height: touch ? STRIP_HIT_TOUCH : STRIP_HIT,
    cursor: carry ? 'grabbing' : 'grab', touchAction: 'none',
  }
  const band: CSSProperties = {
    position: 'absolute', left: 0, right: 0, bottom: 1, height: STRIP_DRAWN, borderRadius: 1,
    // Ticks rather than a waveform: it says "sound" without a decode per clip.
    background: 'repeating-linear-gradient(90deg, rgba(255,255,255,.42) 0 2px, rgba(255,255,255,.16) 2px 4px)',
    opacity: carry ? 0.35 : 1,
  }

  return (
    <div className={`et-clip${failure ? ' broken' : ''}${edit ? ' editable' : ''}${lifted ? ' lifted' : ''}`}
         data-clip={clip.id} data-track={track.id}
         data-slot={slotOf(clip) ?? undefined}
         data-job={typeof clip.metadata?.jobId === 'string' ? clip.metadata.jobId : undefined}
         data-movable={movable ? '1' : undefined}
         data-sound={sound ? 'attached' : clip.audio === false ? 'detached' : undefined}
         tabIndex={edit ? 0 : undefined}
         aria-label={edit ? `${what}, ${length.toFixed(1)} seconds` : undefined}
         aria-keyshortcuts={edit && sound ? 'D' : undefined}
         onKeyDown={edit ? key : undefined}
         style={{ left: lifted ? liftedLeft : from * pxPerSec, width: barWidth }}
         title={failure
           ? `${failure.error}${failure.detail ? `\n\n${failure.detail}` : ''}`
           : `${what} — ${length.toFixed(1)}s${edit && !edit.lock ? '\nDrag to move it along V1 · Alt+←/→' : ''}`
             + (edit && sound ? '\nD detaches its sound onto an A track' : '')
             + (clip.audio === false ? '\nIts sound is detached, on an A track' : '')}>
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
      {sound && (
        // Hidden from the accessibility tree because its keyboard half is the
        // bar's D, which says so in the bar's own title and aria-keyshortcuts.
        <span className="et-sound" data-sound-strip={clip.id} style={stripStyle} aria-hidden="true"
              title={`The sound of ${what} — drag it onto an A track to detach it, or below the last track for a new one${edit ? ' (D on the clip)' : ''}`}
              onPointerDown={strip}>
          <span style={band} />
        </span>
      )}
      {refusal && (
        <span className="et-sound-err" role="alert" data-sound-err={clip.id}
              title={`${refusal.error}${refusal.detail ? `\n\n${refusal.detail}` : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', left: INSET, right: INSET, bottom: 1, zIndex: 2,
                display: 'flex', alignItems: 'center', gap: 4, height: 14, padding: '0 4px',
                fontSize: 10, color: '#fca5a5', background: 'var(--crit-fill)',
                border: '1px solid var(--crit-line)', borderRadius: 'var(--r-inner)',
              }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {refusal.error}
          </span>
          <button type="button" aria-label="Dismiss" title="Dismiss — the sound is still attached"
                  style={{ border: 0, padding: 0, background: 'none', color: 'inherit', cursor: 'pointer' }}
                  onClick={() => useDetach.setState({ failed: null })}>✕</button>
        </span>
      )}
      {children}
      {/* The sound in flight rides on its own ghost, saying where it would
          land — portalled, because the lanes scroll and clip their overflow. */}
      {carry && createPortal(
        <div className="et-sound-carry" aria-hidden="true" style={{
          position: 'fixed', left: carry.x - carry.dx, top: carry.y - 9, width: barWidth, height: 18,
          zIndex: 50, pointerEvents: 'none', display: 'flex', alignItems: 'center', padding: '0 6px',
          borderRadius: 'var(--r-inner)', whiteSpace: 'nowrap', fontSize: 10.5, color: 'var(--fg)',
          border: `1px ${carry.target ? 'solid' : 'dashed'} var(--line-2)`,
          background: carry.target
            ? 'repeating-linear-gradient(90deg, rgba(255,255,255,.2) 0 2px, rgba(255,255,255,.07) 2px 4px), var(--bg)'
            : 'var(--bg)',
          boxShadow: '0 4px 14px rgba(0,0,0,.55)', opacity: carry.target ? 1 : 0.8,
        }}>
          {carry.label}
        </div>,
        document.body,
      )}
    </div>
  )
}

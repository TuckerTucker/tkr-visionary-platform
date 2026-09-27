import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { AnyClip, ITrack } from '@openvideo/core'

import { OPENVIDEO_PIN, sec, us } from './engine'
import { Clip } from './Clip'
import { clipsOn, displayOrder, projectEnd, takeOf } from './project'
import { pause, retry, seek, toggle, useEdit } from './useEdit'
import { PX_PER_SEC } from '../scene/Timeline'
import { useStore } from '../store'
import { ErrorNote } from '../ui/ErrorNote'
import { IconPlay } from '../icons'
import './edit.css'

/**
 * The timeline under the stage: every track, top to bottom, with its clips as
 * bars in time, a playhead, and play/pause.
 *
 * **Generic over tracks.** It draws `project.tracks` in `displayOrder` — the
 * picture tracks with V1 first, then sound — and every clip through `Clip`,
 * whatever it is. Nothing here knows V1 is special, so a second track arriving
 * is a lane appearing, not a change to this file.
 *
 * **The same scale as the scene's own timeline, and it scrolls.** `PX_PER_SEC`
 * is `scene/Timeline`'s, for that file's reason: fitting the cut to the width
 * moves every bar whenever the cut changes length, and makes a long scene
 * unreachable. A second is the same distance on both.
 *
 * **Seeking is a press on the lanes.** Anywhere on them, clips included, and a
 * drag scrubs. Nothing is selected by it, because nothing here acts on a
 * selection yet; a later control that wants the press on a clip stops it there.
 *
 * **The playhead does not re-render the timeline.** Playback moves the Core's
 * `currentTime` every frame, so the head and the readout are written straight
 * to the DOM from a store subscription; React only redraws when the
 * arrangement itself changes.
 *
 * Extension points, each drawn on the thing it is about rather than in a panel:
 * - `tools` — controls for the whole cut (Export, Undo), at the end of the
 *   transport row. It costs nothing when empty.
 * - `clipOverlay(clip, track)` — laid over each clip bar (trim handles, a take
 *   stepper, a crossfade mark, a stale badge).
 * - `laneOverlay(track)` — laid over each lane (a drop target, the gap a drag
 *   would open).
 */
export type TracksProps = {
  tools?: ReactNode
  clipOverlay?: (clip: AnyClip, track: ITrack) => ReactNode
  laneOverlay?: (track: ITrack) => ReactNode
}

/** Room past the end of the cut, so the last clip is never flush against the
 *  edge and the head can sit past it. */
const TAIL_SEC = 2

const clock = (micro: number): string => {
  const t = Math.max(0, sec(micro))
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${String(m)}:${s.toFixed(1).padStart(4, '0')}`
}

export function Tracks({ tools, clipOverlay, laneOverlay }: TracksProps) {
  const phase = useEdit((s) => s.phase)
  const error = useEdit((s) => s.error)
  const core = useEdit((s) => s.core)
  const project = useEdit((s) => s.project)
  const broken = useEdit((s) => s.broken)
  const notes = useEdit((s) => s.notes)
  const playing = useEdit((s) => s.playing)
  const takes = useStore((s) => s.takes)

  const scroller = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const readout = useRef<HTMLSpanElement>(null)

  const end = project ? projectEnd(project) : 0
  const seconds = sec(end)
  const width = (seconds + TAIL_SEC) * PX_PER_SEC

  // The head and the clock, straight from the Core — see above.
  useEffect(() => {
    if (!core) return
    const paint = (t: number, isPlaying: boolean): void => {
      const x = sec(t) * PX_PER_SEC
      if (head.current) head.current.style.transform = `translateX(${String(x)}px)`
      if (readout.current) readout.current.textContent = `${clock(t)} / ${clock(end)}`
      // Follow the head while it plays, a page at a time — never while paused,
      // where the scroll position is somebody's choice.
      const sc = scroller.current
      if (isPlaying && sc && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 24)) {
        sc.scrollLeft = Math.max(0, x - 24)
      }
    }
    const st = core.store.getState()
    paint(st.currentTime, st.isPlaying)
    return core.store.subscribe((s, prev) => {
      if (s.currentTime !== prev.currentTime || s.isPlaying !== prev.isPlaying) paint(s.currentTime, s.isPlaying)
    })
  }, [core, end])

  const timeAt = useCallback((clientX: number): number => {
    const r = body.current?.getBoundingClientRect()
    return r ? us((clientX - r.left) / PX_PER_SEC) : 0
  }, [])

  const press = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // A press on the horizontal scrollbar is a scroll, not a seek.
    const sc = e.currentTarget
    if (e.clientY - sc.getBoundingClientRect().top > sc.clientHeight) return
    pause()
    seek(timeAt(e.clientX))
    sc.setPointerCapture(e.pointerId)
    const move = (ev: globalThis.PointerEvent): void => seek(timeAt(ev.clientX))
    const up = (): void => {
      sc.removeEventListener('pointermove', move)
      sc.removeEventListener('pointerup', up)
      sc.removeEventListener('pointercancel', up)
    }
    sc.addEventListener('pointermove', move)
    sc.addEventListener('pointerup', up)
    sc.addEventListener('pointercancel', up)
  }, [timeAt])

  // Space plays while the timeline has focus — the editor's convention, and
  // the one place on the page where it cannot mean full screen, because the
  // thing under your hand is the cut rather than a render. Stopped before it
  // reaches the window-level binding in App.
  const key = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target as HTMLElement
    if (t.matches('input,textarea,select')) return
    e.preventDefault()
    e.nativeEvent.stopPropagation()
    toggle()
  }, [])

  const tracks = project ? displayOrder(project) : []

  return (
    <div className="edit-tracks" id="edit-tracks" onKeyDown={key}>
      <div className="et-head">
        <button type="button" className="ico" id="edit-play"
                disabled={phase !== 'ready'}
                title={playing ? 'Pause — Space' : 'Play the cut — Space'}
                onClick={toggle}>
          {playing
            ? <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" /></svg>
            : <IconPlay />}
        </button>
        {/* While the engine arrives the row says so, in the words of what is
            happening: a first open downloads the editor, and a still button
            with nothing beside it reads as a broken one. */}
        <span className="et-clock" ref={readout} aria-live="off">
          {phase === 'loading' ? `Opening the editor (OpenVideo ${OPENVIDEO_PIN})…` : ''}
        </span>
        <span className="grow" />
        {tools}
      </div>

      {phase === 'failed' && error && (
        <div className="et-note">
          <ErrorNote err={error} />
          <button type="button" className="wide" id="edit-retry" onClick={retry}>Try again</button>
        </div>
      )}
      {notes.map((n, i) => (
        typeof n === 'string'
          ? <p key={i} className="et-note muted">{n}</p>
          : <div key={i} className="et-note"><ErrorNote err={n} /></div>
      ))}

      <div className="et-scroll" ref={scroller} onPointerDown={press}>
        <div className="et-body" ref={body} style={{ width }}>
          <div className="et-rule">
            {Array.from({ length: Math.floor(seconds + TAIL_SEC) + 1 }, (_, n) => n)
              .filter((n) => (seconds > 40 ? n % 10 === 0 : n % 5 === 0))
              .map((n) => (
                <span key={n} className="et-tick" style={{ left: n * PX_PER_SEC }}>
                  {n >= 60 ? `${String(Math.floor(n / 60))}:${String(n % 60).padStart(2, '0')}` : `${String(n)}s`}
                </span>
              ))}
          </div>
          {tracks.map((t) => (
            <div key={t.id} className={`et-lane ${t.type.toLowerCase() === 'audio' ? 'audio' : 'picture'}`}
                 data-track={t.id}>
              {clipsOn(project!, t).map((c) => (
                <Clip key={c.id} clip={c} track={t} pxPerSec={PX_PER_SEC}
                      take={takeOf(c, takes)} failure={broken[c.id]}>
                  {clipOverlay?.(c, t)}
                </Clip>
              ))}
              {laneOverlay?.(t)}
            </div>
          ))}
          {phase === 'ready' && <div className="et-playhead" id="edit-head" ref={head} aria-hidden="true" />}
        </div>
      </div>
    </div>
  )
}

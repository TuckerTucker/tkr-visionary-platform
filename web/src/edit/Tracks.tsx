import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { AnyClip, IProject, ITrack } from '@openvideo/core'

import { OPENVIDEO_PIN, sec, us } from './engine'
import { Clip, type ClipEdit } from './Clip'
import {
  cutsOf, dropIndex, edgeOf, frameUs, planCrossfade, planMove, planTrim, refused,
  sourceUs, transitionsOn, trimmable, v1Clips, v1Lock, type Cut, type Edge, type Plan, type Refusal,
} from './cuts'
import { clipsOn, displayOrder, projectEnd, takeOf, v1 } from './project'
import { batch, pause, retry, seek, toggle, useEdit } from './useEdit'
import { PX_PER_SEC } from '../scene/Timeline'
import { useStore } from '../store'
import { ErrorNote } from '../ui/ErrorNote'
import { IconPlay } from '../icons'
import './edit.css'
import './tracks.css'

/**
 * The timeline under the stage: every track, top to bottom, with its clips as
 * bars in time, a playhead, and play/pause — and the cut shaped on it: trims on
 * a clip's edges, order by dragging, a crossfade on the cut itself.
 *
 * **Generic over tracks.** It draws `project.tracks` in `displayOrder` — the
 * picture tracks with V1 first, then sound — and every clip through `Clip`,
 * whatever it is. The one thing that knows V1 is the editing: trims, moves and
 * cuts are V1's, because V1 is the track that stays gapless (see `cuts.ts`).
 * A transition on any track is drawn as the stretch it dissolves over, never as
 * a clip bar — it is a property of a cut, not a thing on the track.
 *
 * **The same scale as the scene's own timeline, and it scrolls.** `PX_PER_SEC`
 * is `scene/Timeline`'s, for that file's reason: fitting the cut to the width
 * moves every bar whenever the cut changes length, and makes a long scene
 * unreachable. A second is the same distance on both.
 *
 * **A press seeks; a drag on a V1 clip moves it.** A press anywhere on the
 * lanes puts the head there, clips included. Dragging a clip that can move
 * picks it up — past 4px with a mouse or pen, or after a still hold with a
 * finger, because on glass a drag that starts moving at once is the timeline
 * scrolling. Everywhere else a drag scrubs, as before.
 *
 * **One gesture, one undo entry, and what you saw is what lands.** A drag draws
 * `cuts.ts`'s plan for where the pointer is, and nothing reaches the Core until
 * it is let go; then the plan is made again against the arrangement as it is
 * *now* (a take may have landed meanwhile) and run as one `batch`. Escape, or a
 * cancelled pointer, drops it. The playhead then goes to what the edit exposed —
 * the first or last frame kept, or the start of a new dissolve — so the stage
 * shows the change on its next frame, from the engine's cache, with nothing
 * fetched again.
 *
 * **The playhead does not re-render the timeline.** Playback moves the Core's
 * `currentTime` every frame, so the head and the readout are written straight
 * to the DOM from a store subscription; React only redraws when the
 * arrangement itself changes, or a drag moves what it would change.
 *
 * Extension points, each drawn on the thing it is about rather than in a panel:
 * - `tools` — controls for the whole cut (Export, Undo), at the end of the
 *   transport row. It costs nothing when empty.
 * - `clipOverlay(clip, track)` — laid over each clip bar (a take stepper, a
 *   stale badge).
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

/** How far a mouse or pen moves on a clip before the press is a pick-up rather
 *  than a seek that wobbled. */
const LIFT_PX = 4
/** How long a finger holds still on a clip before it picks the clip up. Any
 *  sooner and every swipe that starts on V1 — most of the timeline's height —
 *  would move a clip instead of scrolling. */
const HOLD_MS = 300
/** How far a finger may drift during that hold and still be holding. */
const HOLD_SLOP_PX = 8

const clock = (micro: number): string => {
  const t = Math.max(0, sec(micro))
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${String(m)}:${s.toFixed(1).padStart(4, '0')}`
}

/** What a drag in progress draws instead of the arrangement. */
type Draft = { project: IProject; lift?: { id: string; left: number } }

/** Run a plan: one batch, then the head to what it exposed. A refusal or a
 *  plan with nothing in it runs nothing. */
function commit(p: Plan | Refusal): void {
  if (refused(p) || !p.commands.length) return
  pause()
  if (batch(p.commands) && p.at !== undefined) seek(p.at)
}

export function Tracks({ tools, clipOverlay, laneOverlay }: TracksProps) {
  const phase = useEdit((s) => s.phase)
  const error = useEdit((s) => s.error)
  const core = useEdit((s) => s.core)
  const project = useEdit((s) => s.project)
  const parked = useEdit((s) => s.parked)
  const broken = useEdit((s) => s.broken)
  const notes = useEdit((s) => s.notes)
  const playing = useEdit((s) => s.playing)
  const takes = useStore((s) => s.takes)

  const scroller = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const readout = useRef<HTMLSpanElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  /** Ends the gesture in progress without committing it — Escape, an unmount,
   *  the scene closing under it. */
  const abort = useRef<(() => void) | null>(null)

  const shown = draft?.project ?? project
  const end = project ? projectEnd(project) : 0
  const seconds = sec(Math.max(end, shown ? projectEnd(shown) : 0))
  const width = (seconds + TAIL_SEC) * PX_PER_SEC
  const lock = phase === 'ready' ? v1Lock(project, parked) : 'The cut is still opening.'

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

  // A gesture never outlives the Core it was planned against.
  useEffect(() => () => abort.current?.(), [core])

  const timeAt = useCallback((clientX: number): number => {
    const r = body.current?.getBoundingClientRect()
    return r ? us((clientX - r.left) / PX_PER_SEC) : 0
  }, [])

  /**
   * Wire one pointer gesture: `move` on every move, `done(true)` on release,
   * `done(false)` on cancel or Escape. Escape is taken in the capture phase and
   * stopped there, because the page's own Escape (leaving region editing) is not
   * what somebody mid-drag on the timeline means.
   */
  const follow = useCallback((el: HTMLElement, pointerId: number,
    move: (ev: globalThis.PointerEvent) => void, done: (ok: boolean) => void) => {
    try { el.setPointerCapture(pointerId) } catch { /* a pointer already gone ends below */ }
    const up = (): void => finish(true)
    const cancel = (): void => finish(false)
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
      if (abort.current === cancel) abort.current = null
      done(ok)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc, true)
    abort.current?.()
    abort.current = cancel
  }, [])

  /* ---- trim ------------------------------------------------------------ */

  const trimPress = useCallback((clip: AnyClip, edge: Edge, e: PointerEvent<HTMLElement>) => {
    // The handle's press is its own: it never also seeks or picks the clip up.
    e.stopPropagation()
    if (e.button !== 0 || lock || !project) return
    e.preventDefault()
    pause()
    const base = project
    const x0 = e.clientX
    const rate = clip.timing.playbackRate && clip.timing.playbackRate > 0 ? clip.timing.playbackRate : 1
    const from = edgeOf(clip, edge)
    let target = from
    follow(e.currentTarget, e.pointerId, (ev) => {
      target = from + us((ev.clientX - x0) / PX_PER_SEC) * rate
      const p = planTrim(base, clip.id, edge, target)
      if (!refused(p)) setDraft({ project: p.project })
    }, (ok) => {
      setDraft(null)
      const now = useEdit.getState().project
      if (ok && now && target !== from) commit(planTrim(now, clip.id, edge, target))
    })
  }, [follow, lock, project])

  const trimKey = useCallback((clip: AnyClip, edge: Edge, e: KeyboardEvent<HTMLElement>) => {
    if (!project || e.metaKey || e.ctrlKey || e.altKey) return
    const f = frameUs(project)
    const step = e.shiftKey ? Math.round(project.settings.fps || 24) * f : f
    const at = edgeOf(clip, edge)
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? at - step
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? at + step
        : e.key === 'Home' ? (edge === 'in' ? 0 : -Infinity)
          : e.key === 'End' ? (edge === 'out' ? sourceUs(clip) : Infinity)
            : null
    if (to === null) return
    e.preventDefault()
    e.stopPropagation()
    if (lock) return
    // ±Infinity lands on the far limit: planTrim clamps it to the other edge.
    commit(planTrim(project, clip.id, edge, Number.isFinite(to) ? to : to > 0 ? sourceUs(clip) : 0))
  }, [lock, project])

  /* ---- move ------------------------------------------------------------ */

  const moveKey = useCallback((clip: AnyClip, e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || !project || !e.altKey) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    if (lock) return
    const order = v1Clips(project)
    const i = order.findIndex((c) => c.id === clip.id)
    const to = e.key === 'ArrowLeft' ? i - 1 : i + 1
    if (i < 0 || to < 0 || to >= order.length) return
    commit(planMove(project, clip.id, to))
  }, [lock, project])

  /** A press on the lanes: seek there, then scrub — or, on a V1 clip that can
   *  move, pick it up once the press turns into a drag. */
  const press = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // A press on the horizontal scrollbar is a scroll, not a seek.
    const sc = e.currentTarget
    if (e.clientY - sc.getBoundingClientRect().top > sc.clientHeight) return
    pause()
    seek(timeAt(e.clientX))

    const bar = (e.target as HTMLElement).closest<HTMLElement>('.et-clip[data-movable]')
    const id = bar?.dataset.clip
    const base = project
    const clip = id && base ? base.clips[id] : undefined
    const touch = e.pointerType === 'touch'
    const x0 = e.clientX
    const y0 = e.clientY
    let mode: 'scrub' | 'wait' | 'lift' | 'off' = clip && !lock ? 'wait' : 'scrub'
    let left = clip ? clip.timing.display.from : 0
    let timer = 0
    // Once a finger has picked a clip up, the page must not scroll under it.
    // touch-action is fixed at the press, so this is the only way to take the
    // pan back from the browser mid-gesture: a non-passive touchmove, cancelled.
    const hold = (ev: TouchEvent): void => { if (mode === 'lift' && ev.cancelable) ev.preventDefault() }

    const lift = (ev: { clientX: number }): void => {
      if (!clip || !base) return
      mode = 'lift'
      window.clearTimeout(timer)
      sc.addEventListener('touchmove', hold, { passive: false })
      drag(ev)
    }
    const drag = (ev: { clientX: number }): void => {
      if (!clip || !base) return
      left = Math.max(0, clip.timing.display.from + us((ev.clientX - x0) / PX_PER_SEC))
      const p = planMove(base, clip.id, dropIndex(base, clip.id, left))
      setDraft({ project: refused(p) ? base : p.project, lift: { id: clip.id, left: sec(left) * PX_PER_SEC } })
    }
    if (mode === 'wait' && touch) {
      timer = window.setTimeout(() => { if (mode === 'wait') lift({ clientX: x0 }) }, HOLD_MS)
    }

    follow(sc, e.pointerId, (ev) => {
      const dx = ev.clientX - x0
      if (mode === 'scrub') seek(timeAt(ev.clientX))
      else if (mode === 'lift') drag(ev)
      else if (mode === 'wait') {
        if (touch) {
          // A finger that moves before the hold is up is scrolling the
          // timeline; the browser takes that pan and this press is over.
          if (Math.hypot(dx, ev.clientY - y0) > HOLD_SLOP_PX) { mode = 'off'; window.clearTimeout(timer) }
        } else if (Math.abs(dx) > LIFT_PX) {
          lift(ev)
        }
      }
    }, (ok) => {
      window.clearTimeout(timer)
      sc.removeEventListener('touchmove', hold)
      const lifted = mode === 'lift'
      mode = 'off'
      if (!lifted) return
      setDraft(null)
      const now = useEdit.getState().project
      if (ok && now && clip) commit(planMove(now, clip.id, dropIndex(now, clip.id, left)))
    })
  }, [follow, lock, project, timeAt])

  /* ---- crossfade ------------------------------------------------------- */

  const flip = useCallback((cut: Cut) => {
    const now = useEdit.getState().project
    if (!now || lock) return
    commit(planCrossfade(now, cut.from.id, cut.to.id, !cut.fade))
  }, [lock])

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

  const tracks = shown ? displayOrder(shown) : []
  const base = shown ? v1(shown) : null
  const cuts = shown ? cutsOf(shown) : []

  const editOf = (c: AnyClip): ClipEdit | undefined => {
    if (phase !== 'ready' || c.type === 'Transition' || broken[c.id]) return undefined
    const canTrim = trimmable(c)
    return {
      lock,
      trim: canTrim,
      source: canTrim ? sourceUs(c) : 0,
      inPoint: canTrim ? edgeOf(c, 'in') : 0,
      outPoint: canTrim ? edgeOf(c, 'out') : 0,
      onTrimPress: (edge, e) => trimPress(c, edge, e),
      onTrimKey: (edge, e) => trimKey(c, edge, e),
      onKey: (e) => moveKey(c, e),
    }
  }

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

      <div className={`et-scroll${draft ? ' dragging' : ''}`} ref={scroller} onPointerDown={press}>
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
          {tracks.map((t) => {
            const isV1 = t.id === base?.id
            return (
              <div key={t.id} className={`et-lane ${t.type.toLowerCase() === 'audio' ? 'audio' : 'picture'}`}
                   data-track={t.id}>
                {clipsOn(shown!, t).filter((c) => c.type !== 'Transition').map((c) => (
                  <Clip key={c.id} clip={c} track={t} pxPerSec={PX_PER_SEC}
                        take={takeOf(c, takes)} failure={broken[c.id]}
                        edit={isV1 ? editOf(c) : undefined}
                        liftedLeft={draft?.lift?.id === c.id ? draft.lift.left : undefined}>
                    {clipOverlay?.(c, t)}
                  </Clip>
                ))}
                {/* A dissolve is drawn as the stretch it runs over, under the
                    pointer's reach — the control for it is the cut's. */}
                {transitionsOn(shown!, t).map((f) => (
                  <span key={f.id} className="et-fade" data-fade={f.id} aria-hidden="true"
                        style={{
                          left: sec(f.timing.display.from) * PX_PER_SEC,
                          width: sec(f.timing.display.to - f.timing.display.from) * PX_PER_SEC,
                        }} />
                ))}
                {isV1 && !draft?.lift && cuts.map((c) => {
                  const fade = c.fade ? sec(c.fade.timing.display.to - c.fade.timing.display.from) : 0
                  return (
                    <button key={`${c.from.id}>${c.to.id}`} type="button"
                            className={`et-cut${c.fade ? ' on' : ''}`}
                            data-from={c.from.id} data-to={c.to.id}
                            style={{ left: sec(c.at) * PX_PER_SEC }}
                            aria-pressed={!!c.fade}
                            aria-label={c.fade ? `Crossfade, ${fade.toFixed(2)} seconds` : 'Hard cut'}
                            disabled={!!lock || !!draft}
                            title={lock ?? (c.fade
                              ? `Crossfade, ${fade.toFixed(2)}s — press for a hard cut`
                              : 'Hard cut — press for a crossfade')}
                            onPointerDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              // Space is the button's own press (it clicks on
                              // key-up), so the timeline's Space-plays and the
                              // page's Space binding must not hear it.
                              if (e.key !== ' ') return
                              e.stopPropagation()
                              e.nativeEvent.stopPropagation()
                            }}
                            onClick={() => flip(c)} />
                  )
                })}
                {laneOverlay?.(t)}
              </div>
            )
          })}
          {phase === 'ready' && <div className="et-playhead" id="edit-head" ref={head} aria-hidden="true" />}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { ITrack } from '@openvideo/core'

import { useStore } from '../store'
import { trackEnd, v1 } from '../edit/project'
import { useEdit } from '../edit/useEdit'
import {
  clampBeats, generations, SHOT_MAX, SHOT_MIN, SHOT_STEP, shotSecs, TAKE_SECONDS, type Shot,
} from './model'

/**
 * Time, along the axis time actually runs on.
 *
 * **Left to right, and authored.** The composer stacked shots vertically and
 * derived each one's length from how much you had written about it. Both halves
 * were wrong and the owner's objection retires them together:
 *
 * > Time is not derived from the description because doing so is impossible. If
 * > I'm a director, maybe I want a 5 minute scene where the protagonist sits in
 * > a chair. The director decides, not the model.
 *
 * Nothing about "he sits in the chair" implies five seconds or five minutes. So
 * a shot is a **bar you pull**, and the thing the derivation was protecting — a
 * 9px handle between two rows — is answered by giving duration its own axis
 * rather than by taking the decision away.
 *
 * **A fixed scale, and the track scrolls.** Fitting the whole scene to the width
 * would make every bar move while you drag one, and it would make a five-minute
 * scene unreachable — the two things this exists to allow. `PX_PER_SEC` is
 * constant, so a second is the same distance everywhere and the track is as long
 * as the film is.
 *
 * **The break is arithmetic, not a setting** — `generations` in model.ts. H3
 * tops out around 14.4s, so a scene longer than one generation is several, and
 * a shot longer than one runs across several chained by Continue.
 *
 * **One timeline on screen.** This composer track is what a scene with no
 * takes shows — duration starts at zero, and before the first render there is
 * no edit timeline to put anything in. Once a take exists the edit timeline is
 * the timeline, and the same bars are drawn by `PendingSlots` as the slots V1
 * does not have yet, after its last clip: the break mark becomes the boundary
 * between two slots, which is what it always meant. Two tracks for one film
 * was a scene drawn twice at the same scale with nothing saying which one the
 * next Generate would land in.
 */

/** One second, in pixels. A beat wants to be visible at a glance and a bar
 *  wants an edge big enough to grab, which 30px gives at the 1s floor. The
 *  edit timeline draws at this scale too, so a second is one distance on both. */
export const PX_PER_SEC = 30

const tick = (t: number) => {
  const m = Math.floor(t / 60)
  const s = Math.round(t - m * 60)
  return m ? `${String(m)}:${String(s).padStart(2, '0')}` : `${String(s)}s`
}

const fmt = (sec: number) => (sec % 1 ? sec.toFixed(1) : String(sec))

/** Seconds per shot, as the next run will read them — `shotSecs`. Drawing the
 *  default 4s bar under a duration menu reading 8s put two authorities on
 *  screen disagreeing about one clip. */
function useSecs(): { shots: Shot[]; secs: number[] } {
  const scene = useStore((s) => s.scene)
  const menu = useStore((s) => s.vid.seconds)
  return { shots: scene.shots, secs: shotSecs(scene, Number(menu)) }
}

/**
 * Pulling a bar's right edge, by pointer or by key.
 *
 * **The pointer is captured on the handle** rather than followed on `window`:
 * a finger that leaves the 10px edge mid-pull is still pulling, a cancelled
 * touch (the browser taking the gesture for a scroll) puts the length back
 * instead of leaving it wherever the finger was when the page lost it, and the
 * press never reaches the edit timeline underneath, where it would seek.
 *
 * **The keyboard does what the pointer does**, on a focusable slider: ←/→ half
 * a second, Shift five, Home the floor, End one whole generation. The steps are
 * the pointer's grid, so the two cannot land on lengths the other could not.
 */
function usePull() {
  const [pulling, setPulling] = useState<string | null>(null)

  const press = useCallback((shot: Shot, from: number, e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const x0 = e.clientX
    const before = shot.beats
    try { el.setPointerCapture(e.pointerId) } catch { /* a pointer already gone ends below */ }
    setPulling(shot.id)
    const move = (ev: globalThis.PointerEvent) => {
      useStore.getState().patchShot(shot.id, { beats: clampBeats(from + (ev.clientX - x0) / PX_PER_SEC) })
    }
    const end = (keep: boolean) => () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      if (!keep) useStore.getState().patchShot(shot.id, { beats: before })
      setPulling(null)
    }
    const up = end(true)
    const cancel = end(false)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
  }, [])

  const key = useCallback((shot: Shot, from: number, e: KeyboardEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const step = e.shiftKey ? 5 : SHOT_STEP
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? from - step
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? from + step
        : e.key === 'Home' ? SHOT_MIN
          : e.key === 'End' ? TAKE_SECONDS
            : null
    if (to === null) return
    // Stopped here: the edit timeline plays on Space and the page steps takes
    // on arrows, and a key that moved this edge must not also do either.
    e.preventDefault()
    e.stopPropagation()
    useStore.getState().patchShot(shot.id, { beats: clampBeats(to) })
  }, [])

  return { pulling, press, key }
}

type BarProps = {
  shot: Shot
  /** 1-based, as the document numbers `[Shot N]`. */
  n: number
  /** This bar's seconds — the whole shot, or one piece of a long one. */
  sec: number
  /** The whole shot's seconds, which is what a pull changes. */
  total: number
  /** Where the whole shot starts, in the scene. */
  start: number
  part?: number
  parts?: number
  /** Which pending slot the bar is drawn in; absent on the composer's track. */
  gen?: number
  /** A long shot's earlier pieces carry no handle: the shot ends once. */
  pullable: boolean
  style?: CSSProperties
  pull: ReturnType<typeof usePull>
  children?: React.ReactNode
}

/** One shot, as a bar with a pullable end. Shared by the composer's track and
 *  the pending slots, so the two cannot drift into two controls for one thing. */
function Bar({ shot, n, sec, total, start, part = 1, parts = 1, gen, pullable, style, pull, children }: BarProps) {
  const sel = useStore((s) => s.shotSel === shot.id)
  const selectShot = useStore((s) => s.selectShot)
  const cont = parts > 1
  return (
    <div className={`tl-shot${sel ? ' sel' : ''}`} data-shot={shot.id} data-part={part} data-parts={parts}
         data-gen={gen}
         style={{ width: sec * PX_PER_SEC, ...style }}
         onPointerDown={(e) => {
           if ((e.target as HTMLElement).closest('.tl-pull')) return
           // Not a seek on the edit timeline underneath: this is choosing what
           // to write, and a press that also moved the playhead is two edits.
           e.stopPropagation()
           selectShot(shot.id)
           // Focus follows selection, because the bar and the field under it
           // are one control: picking a shot is picking what to write.
           requestAnimationFrame(() => document.getElementById('prompt')?.focus())
         }}>
      <span className="tl-n">{n}{cont ? <em style={{ fontStyle: 'normal', opacity: 0.7 }}>·{part}</em> : null}</span>
      {/* The prompt, in the bar. Not a thumbnail — there is no frame yet,
          and the sentence is the only thing that says what this shot is. */}
      <span className="tl-line">{shot.line.trim() || <i>…</i>}</span>
      <span className="tl-secs">{fmt(sec)}s{cont ? ` of ${fmt(total)}` : ''}</span>
      {/* The whole right edge, not a hairline: this is the one control the
          old derivation existed to avoid, so it has to be grabbable. */}
      {pullable && (
        <span className="tl-pull" role="slider" tabIndex={0}
              aria-label={`How long shot ${String(n)} runs`}
              aria-valuemin={SHOT_MIN} aria-valuemax={SHOT_MAX} aria-valuenow={total}
              aria-valuetext={`${fmt(total)} seconds`}
              title={`${tick(start)} → ${tick(start + total)} — drag, or ←/→, to set how long this shot runs`}
              onPointerDown={(e) => pull.press(shot, total, e)}
              onKeyDown={(e) => pull.key(shot, total, e)} />
      )}
      {children}
    </div>
  )
}

const CUT_TITLE = 'H3 renders about 14 seconds at a time — the next take picks up from this frame'

/** The composer's own track: what a scene with no takes shows. */
export function Timeline() {
  const { shots, secs } = useSecs()
  const addShot = useStore((s) => s.addShot)
  const pull = usePull()
  const total = secs.reduce((n, x) => n + x, 0)

  // Where each generation ends, in scene seconds. Computed rather than stored:
  // it is a consequence of the bars, and a stored copy is a second thing to
  // keep in step with them.
  const bounds: number[] = []
  let t = 0
  const gens = generations(secs, shots.map((x) => x.id))
  gens.slice(0, -1).forEach((g) => { t += g.seconds; bounds.push(t) })

  let at = 0
  return (
    <div className={`tl${pull.pulling ? ' pulling' : ''}`}>
      <div className="tl-track">
        {shots.map((shot, i) => {
          const sec = secs[i]!
          const start = at
          at += sec
          // A break at a bar's end is drawn on its right edge; one inside a
          // long bar where the generation boundary falls in it.
          const marks = bounds.filter((b) => b > start && b <= at + 1e-9)
          return (
            <Bar key={shot.id} shot={shot} n={i + 1} sec={sec} total={sec} start={start}
                 pullable pull={pull}>
              {marks.map((b) => (
                <span key={b} className="tl-cut" title={CUT_TITLE}
                      style={b < at - 1e-9 ? { right: 'auto', left: (b - start) * PX_PER_SEC - 1 } : undefined} />
              ))}
            </Bar>
          )
        })}
        <button type="button" className="tl-add" title="Another shot"
                onClick={() => {
                  addShot(shots[shots.length - 1]?.id)
                  requestAnimationFrame(() => document.getElementById('prompt')?.focus())
                }}>+</button>
      </div>
      {/* A ruler under the bars, at whole seconds while they are far apart and
          every five once they are not. It is a readout: nothing is dragged here. */}
      <div className="tl-rule" style={{ width: total * PX_PER_SEC }}>
        {Array.from({ length: Math.floor(total) + 1 }, (_, n) => n)
          .filter((n) => (total > 40 ? n % 10 === 0 : total > 16 ? n % 5 === 0 : n % 2 === 0))
          .map((n) => (
            <span key={n} className="tl-tick" style={{ left: n * PX_PER_SEC }}>{tick(n)}</span>
          ))}
      </div>
    </div>
  )
}

const pendingBox: CSSProperties = {
  position: 'absolute', top: 0, bottom: 0, boxSizing: 'border-box', pointerEvents: 'none',
  border: '1px dashed var(--line-2)', borderRadius: 'var(--r-inner)',
}

/**
 * The slots V1 does not have yet: the composer's shots for the next Generate,
 * drawn after V1's last clip — `Tracks`' `laneOverlay` for V1.
 *
 * **Each dashed box is one generation**, dashed because nothing has rendered
 * into it, and the boundary between two boxes is the break mark the composer's
 * own track drew: shots past the cap spill into a second pending slot, and a
 * shot longer than a generation runs across as many as it needs, its piece in
 * each numbered `N·k`. The left edge is where V1 ends, which is where Generate
 * puts the take it makes — the slot is drawn where it will land.
 *
 * **The bars are the composer's bars**: press one to write it, pull its right
 * edge (or ←/→ on it) to set its length. Every press here is stopped before
 * the lane, whose own press seeks — choosing what to write is not moving the
 * playhead.
 *
 * **The bars are one flat list over the boxes, not children of them**, and a
 * long shot's last piece keeps one key however many pieces it has. A pull that
 * carries a shot across the cap moves it into the next generation; nested, the
 * handle under the pointer was unmounted at that instant and the pull died with
 * its pointer capture — and the same crossing took keyboard focus off the
 * handle an arrow key had just moved.
 */
export function PendingSlots({ track }: { track: ITrack }) {
  const project = useEdit((s) => s.project)
  const { shots, secs } = useSecs()
  const addShot = useStore((s) => s.addShot)
  const pull = usePull()
  if (!project) return null
  const base = v1(project)
  if (!base || base.id !== track.id) return null

  const left = (trackEnd(project, base) / 1e6) * PX_PER_SEC
  const gens = generations(secs, shots.map((x) => x.id))
  const starts: number[] = []
  const total = secs.reduce((n, x, i) => { starts[i] = n; return n + x }, 0)
  const genAt: number[] = []
  gens.reduce((n, g, k) => { genAt[k] = n; return n + g.seconds }, 0)

  return (
    <div className="et-pending-slots" data-pulling={pull.pulling ?? undefined}
         onPointerDown={(e) => e.stopPropagation()}
         style={{ position: 'absolute', top: 0, bottom: 0, left, width: total * PX_PER_SEC }}>
      {gens.map((g, k) => (
        <div key={k} className="et-pending" data-pending={k} role="group"
             aria-label={k === 0
               ? 'What Generate renders next — these shots, as one take with their cuts'
               : `Past one generation — pending slot ${String(k + 1)} continues from the one before it`}
             style={{ ...pendingBox, left: (genAt[k] ?? 0) * PX_PER_SEC, width: g.seconds * PX_PER_SEC }} />
      ))}
      {gens.flatMap((g, k) => g.pieces.map((p) => {
        const shot = shots[p.i]!
        const last = p.part === p.parts
        return (
          <Bar key={`${shot.id}:${last ? 'last' : String(p.part)}`} shot={shot} n={p.i + 1}
               sec={p.to - p.from} total={secs[p.i]!} start={starts[p.i] ?? 0}
               part={p.part} parts={p.parts} gen={k} pullable={last} pull={pull}
               style={{ position: 'absolute', top: 1, bottom: 1, height: 'auto', minWidth: 0,
                        left: ((genAt[k] ?? 0) + p.from) * PX_PER_SEC }} />
        )
      }))}
      <button type="button" className="tl-add" title="Another shot"
              style={{ position: 'absolute', top: 0, bottom: 0, height: 'auto',
                       left: total * PX_PER_SEC + 3 }}
              onClick={() => {
                addShot(shots[shots.length - 1]?.id)
                requestAnimationFrame(() => document.getElementById('prompt')?.focus())
              }}>+</button>
    </div>
  )
}

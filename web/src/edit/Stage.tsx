import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Core } from '@openvideo/core'
import type { Studio } from '@openvideo/engine-pixi'

import { failed, type ApiError } from '../api/client'
import { useStore } from '../store'
import { ErrorNote } from '../ui/ErrorNote'
import { play, seek, useEdit } from './useEdit'
import './edit.css'

/**
 * The cut, drawn: OpenVideo's Studio on a canvas, following the open Core.
 *
 * **It is the canvas's time layer, not a monitor beside it.** `Canvas` mounts
 * it inside `#vid-out` — the largest thing on screen — once the scene has a
 * take, and a still session never mounts it at all (see `Canvas`). It sizes
 * itself to whatever box it is put in: the box carries the project's aspect and
 * the Studio fits the frame inside it. A ResizeObserver re-fits it, because the
 * engine only listens to the *window* resizing, and a box that changes when the
 * console grows is not a window resize.
 *
 * **The canvas element is made here, not rendered by React.** Pixi takes it
 * over — sizes it, sets its attributes, hands it a WebGL context — and a node
 * React also reconciles is a node two owners disagree about.
 *
 * `interactivity: false` (see `Engine.mountStudio`): a drag on the picture
 * would move the engine's sprite without telling the Core, so what plays and
 * what is saved would drift apart. The page drives the Core; this follows it.
 * It is also what keeps "a click addresses what is under it" true here: over
 * bare picture a click does nothing.
 *
 * Unmounting destroys the Studio and nothing else. The Core, its history and
 * its saver belong to the session in `useEdit`, which outlives a switch to
 * stills; the next mount draws the same Core again from the engine's cache.
 */
/**
 * One Studio per Core at a time, in order.
 *
 * Destroying a Studio calls `core.removeAllListeners()` on the Core it drew —
 * its bridge's own teardown — so a Studio destroyed *after* the next one has
 * wired itself up silently unhooks the new one, and the stage stops following
 * the cut with nothing to say why. StrictMode's mount-unmount-mount does
 * exactly that in development, and a quick switch to stills and back does it
 * in production. Each mount waits its turn behind the last Studio's teardown.
 */
let turn: Promise<void> = Promise.resolve()

/** The mounted stage's box, for full screen. Module state because there is
 *  only ever one stage, and the two callers — the canvas's expand button and
 *  App's Space — are not its parents. */
let box: HTMLDivElement | null = null

/** The last landed job the stage moved to — see the land effect in `Stage`. */
let handled: string | null = null

/** How long a landed take may take to be read by the Studio before the stage
 *  takes over anyway, parked at its start. The same allowance `useEdit` gives
 *  a file to say what it is: a cold volume answering slowly is not a failure. */
const READ_MS = 30_000

/**
 * Put the stage in full screen and play the cut from the playhead. False when
 * there is no drawn stage to show, so the caller falls back to the viewer.
 *
 * The *element* goes full screen rather than a copy of the clip opening in the
 * viewer: the viewer can only hold one file, and what is on the stage is the
 * cut. It plays on the way in because a full-screen request is a request to
 * watch, and it is a press, so sound is something the person asked for —
 * which a land is not (see the land effect in `Stage`).
 */
export function fullScreenStage(): boolean {
  const el = box
  if (!el || !useEdit.getState().studio || !el.requestFullscreen) return false
  void el.requestFullscreen().then(() => play(), () => {})
  return true
}

/** Whether the stage is the full-screen element — where Space means play. */
export function stageIsFullScreen(): boolean {
  return !!box && document.fullscreenElement === box
}

/**
 * Hold the Studio's copy of every crossfade to the length the Core holds.
 *
 * OpenVideo 1.4.0's bridge builds a Studio transition from the clip's top-level
 * `duration`, and Core's `normalizeClip` deletes top-level `duration` from every
 * clip it stores, imports or updates — so every Transition the bridge adds
 * (a stage mounting, a reload, the undo of a removal) comes up at the Studio's
 * two-second default while the Core, project.json and the Compositor's export
 * all say `timing.duration`. The preview would dissolve for four times as long
 * as the export does, and only after the page had been reopened. The bridge
 * does copy `timing` on an *update*, which is why a freshly added crossfade is
 * right until the stage remounts; this puts the Core's timing on the Studio's
 * clip whenever the clips change, which is the update the bridge never gets.
 *
 * It lives here, beside the Studio it corrects, and runs for exactly as long as
 * that Studio does. It used to be the timeline's, which was right only while
 * the stage was mounted beside it: once the stage moved into the canvas the two
 * mount on different conditions, and a correction owned by one surface for an
 * object owned by the other is a correction that can be absent.
 *
 * It writes the Studio's clip and redraws — never the Core, so it is no edit
 * and no undo entry. The bridge adds clips one at a time and asynchronously, so
 * a crossfade it has not reached yet is looked for again on the next frames.
 */
function keepFadesInStep(core: Core, studio: Studio): () => void {
  let raf = 0
  let tries = 0
  const step = (): void => {
    raf = 0
    if (studio.destroyed) return
    let waiting = false
    let moved = false
    for (const c of Object.values(core.store.getState().clips)) {
      if (c.type !== 'Transition') continue
      const s = studio.timeline.getClipById(c.id)
      if (!s) { waiting = true; continue }
      const d = c.timing.display
      if (s.duration !== c.timing.duration || s.display.from !== d.from || s.display.to !== d.to) {
        s.display = { from: d.from, to: d.to }
        s.duration = c.timing.duration
        moved = true
      }
    }
    if (moved) void studio.updateFrame(studio.currentTime)
    if (waiting && ++tries < 300) raf = requestAnimationFrame(step)
  }
  const kick = (): void => {
    tries = 0
    if (!raf) raf = requestAnimationFrame(step)
  }
  kick()
  const unsub = core.store.subscribe((st, prev) => { if (st.clips !== prev.clips) kick() })
  return () => { unsub(); cancelAnimationFrame(raf) }
}

export function Stage({
  landed,
  onShowing,
  children,
}: {
  /** The job whose render just landed, if any: once its clip is on the Core
   *  the playhead goes to its start and the cut plays from there. */
  landed: string | null
  /** Told once per landed job, after the stage is showing it — the moment the
   *  canvas can let go of whatever it was bridging the land with. */
  onShowing: (jobId: string) => void
  /** Laid over the drawn stage, inside its box. */
  children?: ReactNode
}) {
  const core = useEdit((s) => s.core)
  const engine = useEdit((s) => s.engine)
  const studio = useEdit((s) => s.studio)
  const project = useEdit((s) => s.project)
  // Before the arrangement is open the box still has to be the right shape, so
  // the land is not drawn into a 16:9 that changes a moment later: the take's
  // own reported size, which is what the first take is laid out at anyway.
  const last = useStore((s) => s.takes[s.takes.length - 1])
  const width = project?.settings.width ?? last?.width ?? 16
  const height = project?.settings.height ?? last?.height ?? 9
  const outer = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<ApiError | null>(null)

  useEffect(() => {
    box = outer.current
    return () => { if (box === outer.current) box = null }
  }, [])

  useEffect(() => {
    const el = host.current
    if (!el || !core || !engine) return
    let alive = true
    let studio: Studio | null = null
    let stopFades = (): void => {}
    const canvas = document.createElement('canvas')
    el.appendChild(canvas)
    const { settings } = core.store.getState()
    setErr(null)
    // Wait for the last Studio to be gone before this one exists — see `turn`.
    const prev = turn
    let release = (): void => {}
    turn = new Promise<void>((r) => { release = r })
    void (async () => {
      await prev
      if (!alive) { release(); return }
      let r: Studio | ApiError
      try {
        r = await engine.mountStudio(canvas, core, { width: settings.width, height: settings.height })
      } catch (e) {
        if (alive) setErr({ error: 'The preview could not be mounted.', detail: String(e) })
        release()
        return
      }
      if (failed(r)) { if (alive) setErr(r); release(); return }
      if (!alive) { r.destroy(); release(); return }
      studio = r
      stopFades = keepFadesInStep(core, r)
      useEdit.setState({ studio: r })
    })()
    const ro = new ResizeObserver(() => studio?.updateArtboardLayout())
    ro.observe(el)
    return () => {
      alive = false
      ro.disconnect()
      // Stopped rather than left "playing" with nothing drawing it, so the
      // button reads Play when the surface comes back.
      core.pause()
      stopFades()
      if (studio) {
        if (useEdit.getState().studio === studio) useEdit.setState({ studio: null })
        studio.destroy()
        release()
      }
      canvas.remove()
    }
  }, [core, engine])

  // **A render is replaced when the next one lands** — on the stage that means
  // the playhead moves to the new take's start, so the picture on the canvas
  // is the render that just arrived rather than wherever the head was left.
  //
  // Held there, not played. The land is already announced by the bridge in
  // `Canvas`, which plays the file muted while the Studio reads it; the cut
  // has sound, and starting a soundtrack nobody asked for is exactly what the
  // muted-autoplay rule exists to avoid. Play is one press on the timeline,
  // and Space in full screen.
  //
  // Once per job, and remembered across mounts (`handled`): a later edit that
  // changes the project must not drag the head back to the take that landed
  // last, and neither must a switch to stills and back.
  //
  // **It waits for the Studio to have read the take, not only the Core.** The
  // Core has the clip the moment it is added; the Studio loads its media after
  // that, and until it has, its length does not reach the take — a seek then
  // draws nothing, and a Play pressed then is refused ("Cannot play: invalid
  // duration") while the Core goes on reporting that it is playing. So the
  // handover waits for the Studio's length to reach the take's end, and the
  // landed file keeps bridging until it does.
  useEffect(() => {
    if (!landed || !project || !studio) return
    // Already moved to: said again rather than skipped, because the canvas
    // that asked may be a fresh one (Train and back) still bridging it.
    if (handled === landed) { onShowing(landed); return }
    const clip = Object.values(project.clips).find((c) => c.metadata?.jobId === landed)
    if (!clip) return
    const go = (): void => {
      handled = landed
      seek(clip.timing.display.from)
      onShowing(landed)
    }
    // A take whose file would not load is parked outside the Core, so the
    // Studio will never read it: the head goes to its place, which says so on
    // the timeline.
    if (useEdit.getState().broken[clip.id]) { go(); return }
    const until = performance.now() + READ_MS
    let raf = 0
    const wait = (): void => {
      if (studio.maxDuration >= clip.timing.display.to - 1_000 || performance.now() > until) go()
      else raf = requestAnimationFrame(wait)
    }
    wait()
    return () => cancelAnimationFrame(raf)
  }, [landed, project, studio, onShowing])

  return (
    <div className="edit-stage" id="edit-stage" ref={outer}
         style={{ '--ar': String(width / height) } as CSSProperties}>
      <div className="edit-stage-host" ref={host} />
      {children}
      {err && <ErrorNote err={err} />}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { Studio } from '@openvideo/engine-pixi'

import { failed, type ApiError } from '../api/client'
import { ErrorNote } from '../ui/ErrorNote'
import { useEdit } from './useEdit'
import './edit.css'

/**
 * The cut, drawn: OpenVideo's Studio on a canvas, following the open Core.
 *
 * **It sizes itself to whatever box it is put in.** The Studio fits the
 * project's frame inside its canvas's parent and letterboxes the rest, so this
 * component has no opinion about where it lives — which is the point, because
 * where it lives is about to change: it belongs in the canvas's video slot, the
 * largest thing on screen, and is mounted beside the timeline only until that
 * move is made. A ResizeObserver re-fits it, because the engine only listens to
 * the *window* resizing, and a box that changes when the console grows is not a
 * window resize.
 *
 * **The canvas element is made here, not rendered by React.** Pixi takes it
 * over — sizes it, sets its attributes, hands it a WebGL context — and a node
 * React also reconciles is a node two owners disagree about.
 *
 * `interactivity: false` (see `Engine.mountStudio`): a drag on the picture
 * would move the engine's sprite without telling the Core, so what plays and
 * what is saved would drift apart. The page drives the Core; this follows it.
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

export function Stage() {
  const core = useEdit((s) => s.core)
  const engine = useEdit((s) => s.engine)
  const width = useEdit((s) => s.project?.settings.width ?? 16)
  const height = useEdit((s) => s.project?.settings.height ?? 9)
  const host = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<ApiError | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el || !core || !engine) return
    let alive = true
    let studio: Studio | null = null
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
      if (studio) {
        if (useEdit.getState().studio === studio) useEdit.setState({ studio: null })
        studio.destroy()
        release()
      }
      canvas.remove()
    }
  }, [core, engine])

  return (
    <div className="edit-stage" id="edit-stage"
         style={{ aspectRatio: `${String(width)} / ${String(height)}` }}>
      <div className="edit-stage-host" ref={host} />
      {err && <ErrorNote err={err} />}
    </div>
  )
}

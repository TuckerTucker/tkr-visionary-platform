import { useEffect, useRef } from 'react'

import { Refusal, useRefusal } from '../ui/Refusal'

/**
 * Why a box cannot be drawn on a take. One sentence, because it is said on the
 * picture, and it names the fact that settles it rather than apologising: the
 * route a take comes from has no field for regions, and the model behind it has
 * nothing a region could condition.
 */
export const NO_REGIONS_ON_A_TAKE =
  'Regions are a still’s. /api/video takes none — H3 has no regional conditioning, '
  + 'so a box drawn on a take would reach nothing.'

/** Travel that turns a plain press into a drag. `RegionLayer`'s `CLICK_SLOP`, for
 *  the reason it gives there: two thresholds for one gesture is two gestures. */
const CLICK_SLOP = 8

/**
 * The region tool over a video slot: present, disabled, and saying why.
 *
 * **Regions belong to the still slot under the playhead.** On the image side that
 * is the one still slot — a still is a zero-duration scene of one slot — and
 * `store.regions` is its regions: `RegionLayer` draws them on whichever host shows
 * that slot (the frame, or the still on screen), which is how they move with it
 * when the strip steps and survive a trip to the video side and back. Over a video
 * slot there is nothing for a box to belong to: `/api/video` has no regions field,
 * and a rectangle drawn anyway would be sent nowhere while looking exactly like
 * one that works. So the stage mounts no `RegionLayer` at all.
 *
 * **What it mounts instead is the answer, not a control.** Nothing is drawn at
 * rest: a disabled button in a toolbar is the veto list's panel, and a badge on the
 * picture is chrome on the one surface the layout keeps clear. The tool *is* the
 * gestures — ⌘-drag and a double-click, which draw on a still — so the disabled
 * state lives where those land. Reaching for one here (or dragging the picture, the
 * gesture somebody who has not met ⌘ tries first) says the sentence on the stage,
 * in the style a refused drop uses on the frame. Before that, holding ⌘ over the
 * stage turns the cursor to not-allowed: the frame's crosshair, answered with its
 * opposite before the press rather than after it.
 *
 * Silence was the behaviour this replaces, and silence is the failure: the same
 * gesture draws a box on the image side, so on a take it read as the app not
 * having heard. Not `alert()` — a modal that stops the app to deliver one sentence
 * is the wrong weight for it — and no timer: the next press anywhere clears it, the
 * way `RegionLayer`'s own refusal clears, so there is nothing to dismiss.
 *
 * **It listens on its host rather than covering it.** Laid over the stage with
 * pointer events of its own, it would sit on top of the bridging `<video>`'s
 * controls and take every press meant for them. Rendered as a child of the stage
 * box (see `Stage`'s `children`), it reads the gestures from its parent, lets every
 * press through, and only answers the ones that were reaching for a region.
 */
export function StageRegions() {
  const el = useRef<HTMLDivElement>(null)
  // Cleared by the next gesture anywhere, before the host's own handler below runs —
  // which is what lets one press both clear the sentence and say it again. See
  // `ui/Refusal`.
  const [said, setSaid] = useRefusal()

  useEffect(() => {
    const host = el.current?.parentElement
    if (!host) return
    // Presses on a control of their own are not reaching for anything of ours: the
    // bridge's scrubber is a drag, and a double-click on a <video> is its full
    // screen.
    const theirs = (t: EventTarget | null) =>
      !!(t as HTMLElement | null)?.closest?.('video,button,a,input,select,textarea,.err-box')
    const say = () => setSaid(NO_REGIONS_ON_A_TAKE)

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || theirs(e.target)) return
      if (e.metaKey || e.ctrlKey) { say(); return }
      const moved = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) <= CLICK_SLOP) return
        stop()
        say()
      }
      const stop = () => {
        window.removeEventListener('pointermove', moved)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
      }
      window.addEventListener('pointermove', moved)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    }
    const dbl = (e: MouseEvent) => { if (!theirs(e.target)) say() }
    const hover = (e: PointerEvent) => {
      host.style.cursor = (e.metaKey || e.ctrlKey) && !theirs(e.target) ? 'not-allowed' : ''
    }
    const leave = () => { host.style.cursor = '' }

    host.addEventListener('pointerdown', down)
    host.addEventListener('dblclick', dbl)
    host.addEventListener('pointermove', hover)
    host.addEventListener('pointerleave', leave)
    return () => {
      host.removeEventListener('pointerdown', down)
      host.removeEventListener('dblclick', dbl)
      host.removeEventListener('pointermove', hover)
      host.removeEventListener('pointerleave', leave)
      host.style.cursor = ''
    }
  }, [setSaid])

  return (
    // `aria-disabled` and the reason as its description: the tool is here and
    // unavailable, which a screen reader can be told without anything being painted.
    <div id="stage-regions" ref={el} aria-disabled="true" aria-label="Regions"
         aria-description={NO_REGIONS_ON_A_TAKE} data-reason={NO_REGIONS_ON_A_TAKE}
         style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <Refusal text={said} />
    </div>
  )
}

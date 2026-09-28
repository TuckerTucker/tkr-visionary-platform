import { useEffect, useState } from 'react'

/**
 * A refusal said on the surface the gesture landed on, and gone with the next gesture.
 *
 * **Why not `alert()`.** A modal stops the whole app to deliver one sentence, and it
 * delivers it in the middle of the screen — away from the drop target that just lit up
 * and then did nothing. The sentence is about that target, so it belongs on it.
 *
 * **Why no timer.** A note that fades after N seconds is gone before a slow reader is
 * done and still there for a fast one, and it is one more thing on the picture with a
 * clock of its own. Anything you do next — a press, a key, another drag arriving —
 * is the moment the sentence stops being about the latest thing, so that is what
 * clears it. Nothing to dismiss.
 *
 * The listeners are capture-phase on the document, so they run before the surface's
 * own handler: one press can clear the old sentence and say a new one, which is what
 * `StageRegions` needs when the same refused gesture is tried twice. A drop is not a
 * press, but every drop is preceded by a `dragenter`, so a second refused drop clears
 * and re-says in the same way.
 *
 * This was two copies before it was one — `RegionLayer`'s and `StageRegions`' — which
 * agreed on the style and disagreed on what cleared them.
 */
export function useRefusal(): [string | null, (text: string | null) => void] {
  const [said, say] = useState<string | null>(null)
  useEffect(() => {
    if (!said) return
    const clear = () => say(null)
    const events = ['pointerdown', 'keydown', 'dragenter'] as const
    for (const e of events) document.addEventListener(e, clear, true)
    return () => { for (const e of events) document.removeEventListener(e, clear, true) }
  }, [said])
  return [said, say]
}

/**
 * Where `useRefusal`'s sentence is drawn: pinned to the bottom-left of the nearest
 * positioned ancestor, which is the surface the gesture landed on.
 *
 * The live region is always mounted and only its contents come and go. A region that
 * mounts *with* its text is not announced by most screen readers, because nothing
 * inside an existing live region changed.
 */
export function Refusal({ text }: { text: string | null }) {
  return (
    <div className="refusal-slot" aria-live="polite">
      {text && <p className="refusal" role="status">{text}</p>}
    </div>
  )
}

import { isMac, useHistory } from './history'
import { redo, undo, useEdit } from './useEdit'

/**
 * Undo and redo on the surface, beside Export at the end of the timeline's
 * transport row.
 *
 * **Touch parity.** ⌘Z is a keyboard's; a tablet trimming with a finger has no
 * chord, and "undo is what replaces confirmation" is only true where undo can
 * be reached. So the history has a control, not only a key.
 *
 * **Disabled, never hidden.** With nothing to undo the button stays, greyed —
 * a control that appears only after the first edit is a control nobody learns
 * is there until they need it and look for it.
 *
 * **The title names what it would undo** ("Undo render", "Undo trim"), read
 * from the Core's newest history entry, because after a render and three
 * trims, "Undo" alone does not say which of them is about to go.
 */
export function UndoBar() {
  const phase = useEdit((s) => s.phase)
  const { canUndo, canRedo, undoLabel, redoLabel } = useHistory()
  const ready = phase === 'ready'
  const mac = isMac()
  const undoKeys = mac ? '⌘Z' : 'Ctrl+Z'
  const redoKeys = mac ? '⇧⌘Z' : 'Ctrl+Shift+Z'
  return (
    <span id="edit-undo" style={{ display: 'inline-flex', gap: 2 }}>
      <button type="button" className="ico" id="edit-undo-go" data-act="undo"
              disabled={!ready || !canUndo} aria-label={undoLabel}
              title={canUndo ? `${undoLabel} — ${undoKeys}` : 'Nothing to undo'}
              onClick={() => { undo() }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </svg>
      </button>
      <button type="button" className="ico" id="edit-redo-go" data-act="redo"
              disabled={!ready || !canRedo} aria-label={redoLabel}
              title={canRedo ? `${redoLabel} — ${redoKeys}` : 'Nothing to redo'}
              onClick={() => { redo() }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
        </svg>
      </button>
    </span>
  )
}

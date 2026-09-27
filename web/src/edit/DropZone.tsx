import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react'
import type { AnyClip } from '@openvideo/core'

import { failed } from '../api/client'
import { PX_PER_SEC } from '../scene/Timeline'
import { ErrorNote } from '../ui/ErrorNote'
import {
  ACCEPT_ATTR, clockAt, dropFile, insertTitle, invitation, kindOf, nextTrackName, refusal,
  setTitleText, timeAtPx, useDrop, type DropKind,
} from './drop'
import { Inherited } from './Inherited'
import { INSERT_MIN_SECONDS, INSERT_SECONDS, isEmptyInsert, insertOf, makeInsert } from './inherit'
import { slotOf } from './project'
import { useEdit } from './useEdit'

/** How far a mouse or pen moves along the strip before a press is drawing an
 *  insert rather than a press that wobbled on its way to the file picker. The
 *  timeline's own lift distance (`Tracks`), for the same reason. */
const DRAW_PX = 4
/** How long a finger holds still on the strip before it is drawing. Any sooner
 *  and every swipe that crosses the strip — it is the timeline's last row, the
 *  one a thumb scrolling the cut lands on — would make an insert. */
const DRAW_HOLD_MS = 300
const DRAW_SLOP_PX = 8

/** An insert at the playhead, `INSERT_SECONDS` long — I, and the strip's ▭. */
function insertAtHead(): void {
  const at = useEdit.getState().core?.store.getState().currentTime ?? 0
  void makeInsert(at, at + INSERT_SECONDS * 1_000_000).then((r) => {
    useDrop.setState({ error: failed(r) ? r : null })
  })
}

/**
 * The strip under the last track, where a track is made by putting something
 * on it — see `drop.ts` for what each kind becomes and where it goes.
 *
 * **Not a panel, and not a library.** It holds nothing and lists nothing: it is
 * the empty space below the tracks, made a target. The only files that reach it
 * are the ones somebody brings — from the Finder by a drag, or, for keyboard
 * and touch, from the file picker a press on the strip opens. That picker is
 * reaching for a file, which is the one way the library may open.
 *
 * **Where it lands is where it was let go.** The strip spans the timeline at
 * the timeline's own scale, so a drag held over it draws a line at the drop
 * time and says which track it would make — "V2 at 0:03.2" — before anything
 * is committed. A press opens the picker for the time pressed; Enter opens it
 * for the playhead.
 *
 * **A file the timeline cannot place does not light it up**, read off the drag
 * while it is held (the absence of an invitation, before the drop). If it is
 * dropped anyway, the strip says what it was and what the timeline takes —
 * here, where the file went, not in a toast or a console.
 *
 * **A title is typed, not configured.** With the timeline focused, T puts one
 * at the playhead on a new T track, open for typing in place (`TitleEdit`). The
 * `T` at the strip's end is the same act for a hand with no keyboard.
 *
 * **An insert is drawn, not added.** Drag along the strip and the stretch you
 * cover becomes an empty slot on a new picture track over V1, opening with the
 * cast, look and LoRAs of the scene it covers (`inherit.ts`). I on the timeline,
 * or the ▭ beside the T, makes a three-second one at the playhead. A plain press
 * still opens the file picker — the drag is what says "a time, not a file".
 *
 * Mounted inside the timeline's scrolling body, after the lanes, so its left
 * edge is the timeline's zero.
 */
export function DropZone({ pxPerSec = PX_PER_SEC }: { pxPerSec?: number }) {
  const phase = useEdit((s) => s.phase)
  const project = useEdit((s) => s.project)
  const busy = useDrop((s) => s.busy)
  const error = useDrop((s) => s.error)
  const zone = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  /** The time the picker was opened for, µs. */
  const pickAt = useRef(0)
  const [over, setOver] = useState<{ x: number; at: number; kind: DropKind | null; ok: 'yes' | 'maybe' | 'no' } | null>(null)

  /** An insert being drawn along the strip: where the press started and where
   *  the pointer is, px from time zero. */
  const [drawing, setDrawing] = useState<{ x0: number; x: number } | null>(null)
  /** Set when a press ended as a drawn insert, so the click the browser sends
   *  after it does not also open the file picker. */
  const drew = useRef(false)

  // T for a title and I for an insert, while the timeline has focus — bound on
  // the timeline's own element, so they cannot mean anything anywhere else on
  // the page.
  useEffect(() => {
    const host = zone.current?.closest<HTMLElement>('.edit-tracks')
    if (!host || phase !== 'ready') return
    const key = (e: globalThis.KeyboardEvent): void => {
      const k = e.key.toLowerCase()
      if (k !== 't' && k !== 'i') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const t = e.target as HTMLElement
      if (t.closest('input,textarea,select,[contenteditable="true"]')) return
      e.preventDefault()
      // Stopped here: the page routes a stray letter typed with nothing
      // focused into the prompt, and a T that made a title is not also the
      // first letter of a sentence.
      e.stopPropagation()
      if (k === 't') void insertTitle()
      else insertAtHead()
    }
    host.addEventListener('keydown', key)
    return () => host.removeEventListener('keydown', key)
  }, [phase])

  if (phase !== 'ready' || !project) return null

  const xOf = (clientX: number): number => {
    const r = zone.current?.getBoundingClientRect()
    return r ? Math.max(0, clientX - r.left) : 0
  }

  const place = async (files: File[], at: number): Promise<void> => {
    // One at a time, each its own track and its own undo entry: a drop of
    // three files is three things that can each be taken back.
    for (const f of files) {
      if (failed(await dropFile(f, at))) return
    }
  }

  const dragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (![...(e.dataTransfer.types)].includes('Files')) return
    // Taken whatever it is, so a wrong file dropped here is named here rather
    // than handed to the browser, which would navigate away to open it.
    e.preventDefault()
    const ok = invitation(e.dataTransfer.items)
    e.dataTransfer.dropEffect = ok === 'no' ? 'none' : 'copy'
    const first = [...e.dataTransfer.items].find((i) => i.kind === 'file')
    const x = xOf(e.clientX)
    setOver({ x, at: timeAtPx(x, pxPerSec), kind: first ? kindOf({ type: first.type }) : null, ok })
  }

  const drop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const at = timeAtPx(xOf(e.clientX), pxPerSec)
    setOver(null)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    const bad = files.find((f) => !kindOf(f))
    if (bad) {
      useDrop.setState({ error: refusal(bad), busy: null })
      return
    }
    void place(files, at)
  }

  const open = (at: number): void => {
    if (busy) return
    pickAt.current = at
    picker.current?.click()
  }

  /**
   * A press on the strip: a click opens the picker (below); a drag along it
   * draws an empty insert over the stretch it covers — past `DRAW_PX` with a
   * mouse or pen, or after a still hold with a finger. The strip is where a
   * track is made by putting something on it, and an insert is a track made by
   * saying *when* rather than *what*: the empty space below the lanes, made a
   * target for time as well as for files, and still no add-track button.
   */
  const press = (e: PointerEvent<HTMLDivElement>): void => {
    // The strip's press is its own: it must not also start the timeline's
    // seek-and-scrub, which captures the pointer and would swallow the click.
    e.stopPropagation()
    drew.current = false
    if (e.button !== 0 || busy) return
    const el = e.currentTarget
    const id = e.pointerId
    const x0 = xOf(e.clientX)
    const cx0 = e.clientX
    const cy0 = e.clientY
    const touch = e.pointerType === 'touch'
    let mode: 'wait' | 'draw' | 'off' = 'wait'
    let x = x0
    let timer = 0
    const start = (): void => {
      mode = 'draw'
      window.clearTimeout(timer)
      try { el.setPointerCapture(id) } catch { /* a pointer already gone ends below */ }
      setDrawing({ x0, x })
    }
    if (touch) timer = window.setTimeout(() => { if (mode === 'wait') start() }, DRAW_HOLD_MS)
    const move = (ev: globalThis.PointerEvent): void => {
      if (ev.pointerId !== id) return
      x = xOf(ev.clientX)
      if (mode === 'draw') { setDrawing({ x0, x }); return }
      if (mode !== 'wait') return
      if (touch) {
        // A finger that moves before the hold is up is scrolling the cut.
        if (Math.hypot(ev.clientX - cx0, ev.clientY - cy0) > DRAW_SLOP_PX) { mode = 'off'; window.clearTimeout(timer) }
      } else if (Math.abs(ev.clientX - cx0) > DRAW_PX) {
        start()
      }
    }
    const finish = (ok: boolean): void => {
      window.clearTimeout(timer)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc, true)
      const was = mode
      mode = 'off'
      setDrawing(null)
      if (was !== 'draw') return
      drew.current = true
      if (!ok) return
      const a = timeAtPx(Math.min(x0, x), pxPerSec)
      const b = timeAtPx(Math.max(x0, x), pxPerSec)
      void makeInsert(a, b).then((r) => useDrop.setState({ error: failed(r) ? r : null }))
    }
    const up = (ev: globalThis.PointerEvent): void => { if (ev.pointerId === id) finish(true) }
    const cancel = (ev: globalThis.PointerEvent): void => { if (ev.pointerId === id) finish(false) }
    // Escape mid-draw drops the drawing, as it drops a drag on the lanes.
    const esc = (ev: globalThis.KeyboardEvent): void => {
      if (ev.key !== 'Escape' || mode !== 'draw') return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc, true)
  }

  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    // Space is the timeline's play key everywhere else on it; on the strip it
    // is the strip's own press, as on any button.
    e.stopPropagation()
    e.nativeEvent.stopPropagation()
    open(useEdit.getState().core?.store.getState().currentTime ?? 0)
  }

  const span = drawing
    ? { left: Math.min(drawing.x0, drawing.x), width: Math.max(Math.abs(drawing.x - drawing.x0), INSERT_MIN_SECONDS * pxPerSec) }
    : null
  const label = span
    ? `Empty insert on ${nextTrackName(project, 'video')} · ${clockAt(timeAtPx(span.left, pxPerSec))}–`
      + `${clockAt(timeAtPx(span.left + span.width, pxPerSec))} — with the cast and look of V1 there`
    : over
      ? over.ok === 'no'
        ? 'Not something the timeline can place'
        : `${over.kind ? `New ${nextTrackName(project, over.kind)}` : 'A new track'} at ${clockAt(over.at)}`
      : busy ?? 'Drop your own footage, a photograph or music — or drag along here for an empty insert'
  const hot = (!!over && over.ok !== 'no') || !!span

  return (
    <div className="et-drop-wrap" style={S.wrap}>
      <div ref={zone} id="edit-drop" className={`et-drop${hot ? ' hot' : ''}`}
           role="button" tabIndex={0}
           aria-busy={busy ? true : undefined}
           aria-label="Add your own footage, photograph or music on a new track — opens a file picker"
           title="Drop a file here, or press to pick one — it lands on a new track at that time"
           data-over={over ? over.ok : undefined}
           style={{ ...S.zone, ...(hot ? S.hot : null), ...(over?.ok === 'no' ? S.no : null) }}
           onPointerDown={press}
           onClick={(e) => {
             if (drew.current) { drew.current = false; return }
             open(timeAtPx(xOf(e.clientX), pxPerSec))
           }}
           onKeyDown={key}
           onDragEnter={dragOver}
           onDragOver={dragOver}
           onDragLeave={(e) => {
             if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null)
           }}
           onDrop={drop}>
        {over && <span aria-hidden="true" style={{ ...S.mark, left: over.x }} />}
        {span && <span aria-hidden="true" id="edit-drawing" style={{ ...S.span, left: span.left, width: span.width }} />}
        <span className="et-drop-say" aria-live="polite"
              style={{ ...S.say, left: span ? span.left + span.width + 6 : over ? over.x + 6 : 8 }}>{label}</span>
        <button type="button" id="edit-title" className="ico" style={S.title}
                title="A title at the playhead — or press T on the timeline"
                aria-label="Add a title at the playhead"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); void insertTitle() }}>T</button>
        <button type="button" id="edit-insert" className="ico" style={{ ...S.title, ...S.insert }}
                title={`An empty insert over V1 at the playhead, ${String(INSERT_SECONDS)}s, with the cast and look `
                  + 'of V1 there — or press I on the timeline, or drag along this strip'}
                aria-label="Add an empty insert over V1 at the playhead"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); insertAtHead() }}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
            <rect x="5" y="3" width="6" height="4" rx="1" />
            <rect x="1" y="9" width="14" height="4" rx="1" opacity=".45" />
          </svg>
        </button>
        <input ref={picker} type="file" accept={ACCEPT_ATTR} multiple className="hide"
               onClick={(e) => e.stopPropagation()}
               onChange={(e) => {
                 const files = [...(e.target.files ?? [])]
                 e.target.value = ''
                 const bad = files.find((f) => !kindOf(f))
                 if (bad) useDrop.setState({ error: refusal(bad), busy: null })
                 else if (files.length) void place(files, pickAt.current)
               }} />
      </div>
      {error && (
        <div className="et-drop-err" id="edit-drop-error" style={S.err}
             onPointerDown={(e) => e.stopPropagation()}>
          <ErrorNote err={error} style={{ margin: 0, flex: 1 }} />
          <button type="button" className="ico" aria-label="Dismiss" title="Dismiss"
                  style={S.dismiss}
                  onClick={() => useDrop.setState({ error: null })}>×</button>
        </div>
      )}
    </div>
  )
}

/**
 * A title clip, typed into where it sits on the timeline — never in an
 * inspector. Laid over a Text clip's bar through `Tracks`' `clipOverlay`;
 * renders nothing for any other clip.
 *
 * Double-click or Enter opens it for typing; Enter or leaving keeps the words
 * (one undo entry), Escape leaves them as they were. A title just inserted
 * opens already typing, with its placeholder selected, so the first keystroke
 * replaces it.
 */
export function TitleEdit({ clip, pxPerSec = PX_PER_SEC }: { clip: AnyClip; pxPerSec?: number }) {
  const editing = useDrop((s) => s.editing === clip.id)
  const project = useEdit((s) => s.project)
  // An insert is made on this strip too, and what it carries is drawn on it
  // here — before the empty-insert test below, because an insert that has been
  // rendered is a Video clip and still has its inherited context. The empty one
  // is a Text clip only so it survives a reload (see `inherit.ts`); it has no
  // words anybody should type over, so it never opens as a title.
  if (insertOf(project, slotOf(clip))) return <Inherited clip={clip} />
  if (clip.type !== 'Text' || isEmptyInsert(clip)) return null
  const text = typeof clip.text === 'string' ? clip.text : ''
  if (editing) return <TitleInput id={clip.id} text={text} />
  return (
    <button type="button" className="et-title-hit" data-title={clip.id}
            aria-label={`Title “${text}” — Enter to type over it`}
            title={`“${text}” — double-click or Enter to type`}
            style={S.hit}
            onPointerDown={(e) => {
              // A press on the title still puts the head there, as a press on
              // any clip does — done here because the timeline's own press
              // captures the pointer, and a captured press never becomes the
              // double-click that opens the title.
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              const at = clip.timing.display.from + ((e.clientX - r.left) / pxPerSec) * 1_000_000
              const core = useEdit.getState().core
              core?.pause()
              core?.seek(Math.max(0, Math.round(at)))
            }}
            onDoubleClick={() => useDrop.setState({ editing: clip.id })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              e.stopPropagation()
              useDrop.setState({ editing: clip.id })
            }} />
  )
}

/**
 * The title's words, being typed. Its own component so the words it starts
 * from are its initial state: set from an effect instead, the select-all ran
 * before the words were in the box, and the first keystroke was appended to
 * "Title" rather than replacing it.
 */
function TitleInput({ id, text }: { id: string; text: string }) {
  const input = useRef<HTMLInputElement>(null)
  // `text` is read once: an undo landing mid-typing must not throw away what
  // is being typed.
  const [draft, setDraft] = useState(text)
  /** Enter closes the box, and the box leaving focus as it goes is a blur —
   *  without this the words would be kept twice, as two undo entries. */
  const closed = useRef(false)

  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const close = (keep: boolean): void => {
    if (closed.current) return
    closed.current = true
    if (keep) void setTitleText(id, draft)
    if (useDrop.getState().editing === id) useDrop.setState({ editing: null })
  }

  return (
    <input ref={input} className="et-title-input" data-title-edit={id}
           aria-label="Title text" value={draft} style={S.input}
           onChange={(e) => setDraft(e.target.value)}
           onPointerDown={(e) => e.stopPropagation()}
           onKeyDown={(e) => {
             if (e.key === 'Enter') { e.preventDefault(); close(true) }
             else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false) }
             // Every other key is the input's: the timeline's Space and T,
             // and the page's shortcuts, must not hear typing.
             e.nativeEvent.stopPropagation()
           }}
           onBlur={() => close(true)} />
  )
}

/* Inline, because the strip and the title editor are this slice's whole
   surface and the timeline's stylesheets belong to the timeline. The states
   that need a selector — focus — are the browser's own focus ring. */
const S: Record<string, CSSProperties> = {
  wrap: { position: 'relative', marginTop: 3 },
  zone: {
    position: 'relative', height: 26, borderRadius: 'var(--r-inner)',
    border: '1px dashed var(--line)', background: 'transparent', cursor: 'copy',
    overflow: 'hidden', touchAction: 'manipulation',
  },
  hot: { borderStyle: 'solid', borderColor: 'var(--line-2)', background: 'var(--wash-3)' },
  no: { cursor: 'no-drop', opacity: 0.6 },
  mark: { position: 'absolute', top: 0, bottom: 0, width: 1, background: 'var(--fg)', pointerEvents: 'none' },
  span: {
    position: 'absolute', top: 2, bottom: 2, borderRadius: 'var(--r-inner)', pointerEvents: 'none',
    border: '1px dashed var(--line-2)', background: 'var(--wash-3)',
  },
  insert: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  say: {
    position: 'absolute', top: 0, bottom: 0, display: 'flex', alignItems: 'center',
    fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap', pointerEvents: 'none',
  },
  title: {
    position: 'sticky', float: 'right', right: 0, top: 0, width: 26, height: 24,
    fontFamily: "'Jost', var(--stack)", fontWeight: 600, fontSize: 13, color: 'var(--dim)',
  },
  err: { display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 4, fontSize: 11.5 },
  dismiss: { flex: 'none', width: 24, height: 24 },
  hit: {
    position: 'absolute', inset: 0, zIndex: 1, margin: 0, padding: 0, border: 0,
    background: 'transparent', cursor: 'text',
  },
  input: {
    position: 'absolute', inset: 0, zIndex: 2, width: '100%', margin: 0, padding: '0 8px',
    border: '1px solid var(--line-2)', borderRadius: 'var(--r-inner)', background: 'var(--bg)',
    color: 'var(--fg)', fontSize: 11.5, outline: 'none',
  },
}

import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import type { GalleryItem } from '../gallery/types'
import { useStore } from '../store'
import {
  exportMeta, exportUnsupported, missingNote, resetExport, runExport, stopExport, upload,
  useExport,
} from './exportCut'
import { useEdit } from './useEdit'

/**
 * Export, at the end of the timeline's transport row — the control for the
 * whole cut, and everything about the export is said on it.
 *
 * **Progress is on the button, not beside it.** The fill is the fraction and
 * the label is which take is going through the encoder, because an encode of a
 * long scene is minutes, and a bar at 40% says less than "take 3 of 7" about
 * whether it is moving.
 *
 * **Unavailable is shown, not hidden.** Where the browser cannot encode (Firefox,
 * an older Safari) the button stays, greyed, and the reason sits beside it
 * naming what is missing — a control that vanishes in one browser is a feature
 * nobody can find out about.
 *
 * **A failed upload keeps the encode.** The Blob stays on the control with a
 * Save to disk link and a retry that re-sends the same bytes; nothing is
 * encoded twice and nothing is lost to a dropped connection.
 *
 * `onLanded` is the gallery's record path — the same callback a render calls —
 * so the cut is in the grid the moment the server has it.
 */
export function Export({ onLanded }: { onLanded?: (it: GalleryItem) => void }) {
  const phase = useEdit((s) => s.phase)
  const core = useEdit((s) => s.core)
  const engine = useEdit((s) => s.engine)
  const project = useEdit((s) => s.project)
  const parked = useEdit((s) => s.parked)
  const run = useExport()

  const width = project?.settings.width ?? 0
  const height = project?.settings.height ?? 0
  // `undefined` while the browser is being asked; null is "yes, it can".
  const [why, setWhy] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!engine || !width || !height) return
    let live = true
    setWhy(undefined)
    void exportUnsupported(engine, { width, height }).then((r) => { if (live) setWhy(r) })
    return () => { live = false }
  }, [engine, width, height])

  const hasTime = !!core && Object.keys(project?.clips ?? {}).length > parked.length
  const missing = missingNote(parked)

  // The landed state is the confirmation, and it is on the control; it goes
  // back to Export on its own so the row is ready for the next cut.
  useEffect(() => {
    if (run.phase !== 'landed') return
    const t = window.setTimeout(resetExport, 4000)
    return () => window.clearTimeout(t)
  }, [run.phase])

  const blob = run.phase === 'failed' ? run.blob : null
  const href = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob])
  useEffect(() => () => { if (href) URL.revokeObjectURL(href) }, [href])

  const start = (): void => {
    if (!core) return
    const st = useStore.getState()
    const proj = core.project.export()
    void runExport(proj, exportMeta(proj, st.takes, st.sceneId), onLanded)
  }

  if (run.phase === 'encoding') {
    const pct = Math.round(run.progress.fraction * 100)
    return (
      <span id="edit-export" style={row}>
        {missing && <span className="muted" style={note} title={missing}>{missing}</span>}
        <span id="export-status" role="progressbar" aria-valuenow={pct} aria-valuemin={0}
              aria-valuemax={100} aria-label={run.progress.label}
              style={{ ...btn, ...status, background: fill(run.progress.fraction) }}>
          {run.progress.label}
        </span>
        <button type="button" id="export-stop" style={btn} onClick={stopExport}
                title="Stop the export — nothing is uploaded">
          Stop
        </button>
      </span>
    )
  }

  if (run.phase === 'uploading') {
    return (
      <span id="edit-export" style={row}>
        <span id="export-status" style={{ ...btn, ...status, background: fill(1) }}>
          Sending the cut to the gallery · {mb(run.blob.size)}
        </span>
      </span>
    )
  }

  if (run.phase === 'landed') {
    return (
      <span id="edit-export" style={row}>
        <button type="button" id="export-done" style={btn} onClick={resetExport}
                title={`Filed as ${run.item.job_id}/${run.item.files[0] ?? ''}`}>
          Exported — in the gallery
        </button>
      </span>
    )
  }

  if (run.phase === 'failed') {
    return (
      <span id="edit-export" style={row}>
        <span id="export-error" role="alert" style={err}
              title={run.error.detail ? `${run.error.error}\n\n${run.error.detail}` : run.error.error}>
          {run.error.error}
        </span>
        {href && (
          <a id="export-save" style={{ ...btn, textDecoration: 'none' }} href={href}
             download={`${useStore.getState().sceneId ?? 'cut'}.mp4`}>
            Save to disk
          </a>
        )}
        <button type="button" id="export-retry" style={btn}
                onClick={() => {
                  // The same bytes again when there are some; only an encode
                  // that failed is encoded again.
                  if (run.blob && run.meta) void upload(run.blob, run.meta, onLanded)
                  else start()
                }}>
          {run.blob ? 'Send again' : 'Try again'}
        </button>
        {!run.blob && (
          <button type="button" style={btn} onClick={resetExport}>Dismiss</button>
        )}
      </span>
    )
  }

  const off = phase !== 'ready' || !hasTime || why !== null
  const title = why ?? (missing ? `Export the cut to the gallery. ${missing}` : 'Export the cut to the gallery as an MP4')
  return (
    <span id="edit-export" style={row}>
      {why && <span id="export-why" className="muted" style={note}>{why}</span>}
      <button type="button" id="export-go" style={{ ...btn, ...(off ? dim : null) }}
              disabled={off} title={title} aria-describedby={why ? 'export-why' : undefined}
              onClick={start}>
        {why === undefined && phase === 'ready' ? 'Export…' : 'Export'}
      </button>
    </span>
  )
}

const fill = (f: number): string => {
  const p = `${String(Math.max(0, Math.min(1, f)) * 100)}%`
  return `linear-gradient(90deg, var(--wash-3) ${p}, var(--wash-1) ${p})`
}

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`

// Inline because the timeline's stylesheet belongs to the timeline; these are
// the transport row's own button metrics (`.et-note button`) so the control
// sits in the row as one of its own.
const row: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }
const btn: CSSProperties = {
  flex: 'none', display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 12px',
  borderRadius: 'var(--r-control)', border: '1px solid var(--line)', background: 'var(--wash-2)',
  color: 'var(--fg)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
}
const dim: CSSProperties = { opacity: 0.45, cursor: 'default' }
const status: CSSProperties = { cursor: 'default', fontVariantNumeric: 'tabular-nums', minWidth: 200 }
const note: CSSProperties = {
  fontSize: 11, color: 'var(--dim)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
// Wrapping, not truncated: this is the one state where the sentence is the
// point, and an ellipsis would cut off the half that says what to do.
const err: CSSProperties = { fontSize: 11.5, color: '#fca5a5', maxWidth: 420, lineHeight: 1.3 }

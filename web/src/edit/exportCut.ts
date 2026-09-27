/**
 * The cut, encoded to an MP4 in the page and landed as an output.
 *
 * **Encoded here, not on a server.** The web container has no ffmpeg and the
 * GPU image is rented by the second; the browser already holds every take's
 * file (the engine cached them to play the cut) and WebCodecs encodes H.264 on
 * the machine's own hardware. So the bytes are made where they already are and
 * only the finished MP4 travels — once, to `POST /api/outputs`, which files it
 * beside every render so the gallery, `/api/file` and delete treat it as one.
 *
 * **The encode is never lost to the upload.** Minutes of encoding that end in a
 * dropped connection must not end in nothing, so the Blob stays on the export
 * state until it has landed, and a failed upload is offered to save to disk and
 * to try again — without encoding a second time.
 *
 * The run lives in a module store rather than a component: switching to stills
 * unmounts the timeline, and an export in flight (or a Blob waiting to be
 * saved) must survive that the way a render survives closing the drawer.
 *
 * Not `export.ts`: beside `Export.tsx` on a case-insensitive disk (every Mac),
 * `import … from './edit/Export'` resolves to the `.ts` first and the build
 * fails with TS1261 — on the machine the page is developed on and nowhere else.
 */
import { create } from 'zustand'
import type { AnyClip, IProject } from '@openvideo/core'
import type { ProjectJSON } from '@openvideo/engine-pixi'

import { failed, type ApiError } from '../api/client'
import { exportOutput } from '../api/routes'
import type { ExportMeta } from '../api/types'
import type { GalleryItem } from '../gallery/types'
import type { SceneTake } from '../store'
import { loadEngine, OPENVIDEO_PIN, sec, type Engine } from './engine'
import { clipsOn, projectEnd, takeOf, v1, type Parked } from './project'

/** What the control shows while the cut is encoding. */
export type ExportProgress = { fraction: number; label: string }

/**
 * The APIs `Compositor.isSupported` reads, by the name a person could look up.
 * Checked one by one here because the engine's own answer is a bare boolean,
 * and "Export is unavailable" with no noun in it is the refusal a person hits
 * twice — once here, once after installing the browser that turns out to be
 * missing the same thing.
 */
const ENCODER_APIS = [
  'VideoEncoder', 'VideoDecoder', 'VideoFrame', 'AudioEncoder', 'AudioDecoder', 'AudioData',
  'OffscreenCanvas',
] as const

/**
 * Null when this browser can encode the cut at this size, else the sentence
 * that says why not — naming what is missing, because Firefox (no
 * AudioEncoder/H.264 encode on most builds), an older Safari (no WebCodecs at
 * all) and a GPU that will not encode this resolution are three different
 * fixes.
 */
export async function exportUnsupported(
  engine: Engine, size: { width: number; height: number },
): Promise<string | null> {
  const g = globalThis as unknown as Record<string, unknown>
  const missing = ENCODER_APIS.filter((k) => g[k] == null)
  if (missing.length) {
    return `This browser cannot encode video — it has no ${missing.join(', ')}. `
      + 'Export works in Chrome or Edge.'
  }
  try {
    if (await engine.Compositor.isSupported({ width: size.width, height: size.height })) return null
  } catch (e) {
    return `This browser would not say whether it can encode video: ${e instanceof Error ? e.message : String(e)}`
  }
  return `This browser has WebCodecs but will not encode H.264 at ${String(size.width)}×${String(size.height)} `
    + 'with AAC audio — Export works in Chrome or Edge.'
}

/**
 * Which part of the cut `micro` falls in, as a person would say it: the take
 * on V1 by its position, the gap after one, or the tail past V1's end where
 * only another track has anything.
 */
export function partAt(project: IProject, micro: number): string {
  const track = v1(project)
  // A crossfade is a Transition clip on V1 itself (cuts.ts). Counted as a
  // clip, one dissolve made a two-take cut read "take 3 of 3", and the half
  // second it covers was named as a take of its own rather than as the cut
  // between two.
  const clips = track ? clipsOn(project, track).filter((c) => c.type !== 'Transition') : []
  if (!clips.length) return 'the cut'
  const n = clips.length
  const i = clips.findIndex((c) => micro >= c.timing.display.from && micro < c.timing.display.to)
  if (i >= 0) return `take ${String(i + 1)} of ${String(n)}`
  const before = clips.filter((c) => c.timing.display.to <= micro).length
  if (before === 0) return 'the opening'
  if (before === n) return 'the tail'
  return `the gap after take ${String(before)}`
}

/**
 * The takes the Core does not hold, named before anything is encoded.
 *
 * A parked clip's file would not load, so the engine never had it — and an
 * export that quietly leaves a take out is a cut that is shorter than the one
 * on screen with nothing to say why. So the control says which, by the file,
 * before the first frame.
 */
export function missingNote(parked: readonly Parked[]): string | null {
  if (!parked.length) return null
  const names = parked.map((p) => `${String(p.clip.metadata?.jobId ?? '?')}/${String(p.clip.metadata?.file ?? '?')}`)
  return `Exporting without ${names.join(', ')} — ${parked.length === 1 ? 'its file' : 'their files'} `
    + 'would not load, so the cut has a gap where '
    + `${parked.length === 1 ? 'it sits' : 'they sit'}.`
}

/** The sidecar the export is filed with: the scene, the frame, and which takes
 *  are in it in order — enough to find every source file again from the card. */
export function exportMeta(project: IProject, takes: readonly SceneTake[], sceneId: string | null): ExportMeta {
  const track = v1(project)
  const clips: AnyClip[] = track ? clipsOn(project, track) : []
  const meta: ExportMeta = {
    width: project.settings.width,
    height: project.settings.height,
    fps: project.settings.fps,
    seconds: Math.round(sec(projectEnd(project)) * 1000) / 1000,
    openvideo: OPENVIDEO_PIN,
    takes: clips.flatMap((c) => {
      const m = c.metadata
      if (typeof m?.jobId !== 'string' || typeof m.file !== 'string') return []
      const line = takeOf(c, takes)?.line
      return [{ job_id: m.jobId, file: m.file, ...(line ? { line } : {}) }]
    }),
  }
  if (sceneId) meta.scene = sceneId
  return meta
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/**
 * Encode `project` to an MP4 Blob, or an ApiError naming where it failed.
 *
 * `project` is the Core's own export — what the engine can play — never the
 * drawn one with parked clips put back, which the Compositor would try to
 * fetch and fail on. Never rejects. `signal` stops it: the Compositor is
 * destroyed (which closes its muxer and releases its GPU context) and the
 * answer is an ApiError the caller already knows to expect.
 */
export async function exportCut(
  project: IProject,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<Blob | ApiError> {
  const stopped: ApiError = { error: 'Export stopped — nothing was uploaded.' }
  const end = projectEnd(project)
  if (end <= 0) return { error: 'There is nothing on the timeline to export yet.' }
  const engine = await loadEngine()
  if (failed(engine)) return engine
  if (signal.aborted) return stopped

  const { width, height, fps } = project.settings
  const why = await exportUnsupported(engine, { width, height })
  if (why) return { error: why }

  let where = 'preparing the encoder'
  onProgress({ fraction: 0, label: 'Preparing the encoder…' })
  const c = new engine.Compositor({ width, height, fps })
  const stop = (): void => c.destroy()
  signal.addEventListener('abort', stop, { once: true })
  try {
    await c.initPixiApp()
    if (signal.aborted) return stopped
    where = 'loading the takes'
    onProgress({ fraction: 0, label: 'Loading the takes into the encoder…' })
    // IProject and ProjectJSON are the same document from two packages' points
    // of view; the engine's type is looser (every clip kind as a union), and
    // slice 1 verified the round trip in Chrome.
    await c.loadFromJSON(project as unknown as ProjectJSON)
    if (signal.aborted) return stopped

    where = `encoding ${partAt(project, 0)}`
    c.on('export:progress', (f: number) => {
      const part = partAt(project, Math.min(end - 1, f * end))
      where = `encoding ${part}`
      onProgress({ fraction: f, label: `Encoding ${part} · ${String(Math.round(f * 100))}%` })
    })
    // The engine reports a mid-stream failure as an event and then closes the
    // stream, which would otherwise read as a short, valid-looking file.
    const broke = new Promise<never>((_, reject) => {
      c.on('error', (e: Error) => { reject(e) })
    })
    const halted = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => { reject(new DOMException('stopped', 'AbortError')) }, { once: true })
    })
    const raw = await Promise.race([new Response(c.output()).blob(), broke, halted])
    if (signal.aborted) return stopped
    // The muxer's Blob has no type, and a Blob with none is served to the
    // `<a download>` fallback and the upload alike as octet-stream.
    return new Blob([raw], { type: 'video/mp4' })
  } catch (e) {
    if (signal.aborted) return stopped
    // The engine's own words in the sentence, not only under the disclosure:
    // "failed while encoding take 2" says where, and the message says why —
    // a lost GPU context and a file the decoder refused are different fixes.
    const said = e instanceof Error ? e.message : String(e)
    return { error: `The export failed while ${where}: ${said}`, detail: errText(e) }
  } finally {
    signal.removeEventListener('abort', stop)
    c.destroy()
  }
}

/* ---- the run, as the control sees it ------------------------------------ */

export type ExportState =
  | { phase: 'idle' }
  | { phase: 'encoding'; progress: ExportProgress }
  | { phase: 'uploading'; blob: Blob }
  | { phase: 'landed'; item: GalleryItem }
  | { phase: 'failed'; error: ApiError; blob: Blob | null; meta: ExportMeta | null }

export const useExport = create<ExportState>(() => ({ phase: 'idle' }))

let controller: AbortController | null = null

/**
 * Encode and upload, reporting through `useExport`.
 *
 * `onLanded` is the gallery's `record` path — the same callback a render calls
 * when it finishes — so an export is in the grid the moment it lands rather
 * than when the volume listing next catches up.
 */
export async function runExport(
  project: IProject, meta: ExportMeta, onLanded: ((it: GalleryItem) => void) | undefined,
): Promise<void> {
  if (controller) return
  controller = new AbortController()
  const signal = controller.signal
  useExport.setState({ phase: 'encoding', progress: { fraction: 0, label: 'Preparing the encoder…' } }, true)
  try {
    const blob = await exportCut(project, (progress) => {
      useExport.setState({ phase: 'encoding', progress }, true)
    }, signal)
    if (signal.aborted) {
      useExport.setState({ phase: 'idle' }, true)
      return
    }
    if (failed(blob)) {
      useExport.setState({ phase: 'failed', error: blob, blob: null, meta: null }, true)
      return
    }
    await upload(blob, meta, onLanded)
  } finally {
    controller = null
  }
}

/** Send an encoded cut. Also the retry after a failed upload — the Blob it is
 *  handed is the one already encoded, never a second encode. */
export async function upload(
  blob: Blob, meta: ExportMeta, onLanded: ((it: GalleryItem) => void) | undefined,
): Promise<void> {
  useExport.setState({ phase: 'uploading', blob }, true)
  const r = await exportOutput(blob, meta)
  if (failed(r)) {
    useExport.setState({
      phase: 'failed',
      error: { error: `The cut encoded but did not reach the gallery: ${r.error}`, detail: r.detail },
      blob,
      meta,
    }, true)
    return
  }
  const item: GalleryItem = {
    ...meta,
    job_id: r.job_id,
    kind: 'video',
    files: [r.name],
    created: Date.now() / 1000,
    source: 'edit',
  }
  onLanded?.(item)
  useExport.setState({ phase: 'landed', item }, true)
}

/** Stop an encode in flight. Nothing is uploaded. */
export function stopExport(): void {
  controller?.abort()
}

/** Back to idle — after a landed export has been seen, or a failure dismissed. */
export function resetExport(): void {
  if (!controller) useExport.setState({ phase: 'idle' }, true)
}

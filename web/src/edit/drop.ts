/**
 * Tracks made by a drop: your own footage, photographs and music, and a title
 * typed at the playhead.
 *
 * **There is no add-track button, and this is why none is needed.** A track
 * exists because something was put on it. A file dropped on the timeline makes
 * the next track of its kind — a video or a photograph V(n+1), audio A(n+1) —
 * and a title makes T(n+1), each with the thing on it at the time it was
 * dropped. An empty track is a question the page would have to ask later
 * ("what is this for?"), so it never makes one.
 *
 * **One drop, one undo entry.** The new track and its clip arrive as one
 * `batch`, so undo takes both away together rather than leaving an empty lane
 * behind — the undo that replaces confirmation has to put the page back
 * exactly, or it is not a replacement.
 *
 * **Where a track goes in the stack.** OpenVideo composites the *first* track
 * on top, and `displayOrder` draws the picture tracks reversed so V1 is at the
 * top of the timeline and each overlay sits under the one it covers. So:
 * - a picture track goes directly above the topmost picture track — over V1
 *   (a cutaway covers the take) but under every title, so a title laid first
 *   is not hidden by a clip dropped after it;
 * - a title goes on top of everything;
 * - audio goes to the end, the bottom of the timeline, where it composites
 *   nothing.
 * The engine's own `track.add` only ever prepends, so the placement is a
 * `track.move` inside the same batch.
 *
 * **Dropped files never enter a dataset.** They go to `scenes/{id}/media/` by
 * their own route (`sceneMedia`), which writes nowhere else. A clip dropped on
 * V2 is not training material, and a shared store is the one way it could
 * become some by accident.
 *
 * **Refused before anything is sent.** The page reads the file itself first —
 * its type, then whether this browser can decode it — because a clip the
 * engine cannot read does not fail: it arrives at 600x400 and five seconds
 * with nothing saying so. A refusal names the file and what it is, on the zone
 * it was dropped on (see `DropZone`); the server sniffs the bytes again and
 * says the same kind of sentence if the page was wrong.
 */
import { create } from 'zustand'
import type { AddClipPayload, AnyClip, IProject, ITrack } from '@openvideo/core'

import { failed, type ApiError } from '../api/client'
import { sceneFileUrl, sceneMedia } from '../api/routes'
import { useStore } from '../store'
import jostUrl from '../styles/jost-600.woff2'
import { absoluteUrl, sec } from './engine'
import { sceneIdFor } from './persist'
import { batch, execute, pause, seek, useEdit, type EditCommand } from './useEdit'

/** What a dropped file can become. */
export type DropKind = 'video' | 'image' | 'audio'
/** What a new track can hold. */
export type TrackKind = DropKind | 'text'

/** The sentence every refusal ends with — the same list app.py's
 *  `SCENE_MEDIA_ACCEPTS` names, so the page and the server refuse alike. */
export const ACCEPTS = 'video (MP4, WebM, MOV), images (PNG, JPEG, WebP) or audio (MP3, WAV, M4A, AAC, OGG)'

/** For the file picker, which is the zone's keyboard and touch half. */
export const ACCEPT_ATTR = [
  'video/mp4', 'video/webm', 'video/quicktime', '.mp4', '.webm', '.mov', '.m4v',
  'image/png', 'image/jpeg', 'image/webp', '.png', '.jpg', '.jpeg', '.webp',
  'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg',
].join(',')

const BY_MIME: Record<string, DropKind> = {
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video', 'video/x-m4v': 'video',
  'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image',
  'audio/mpeg': 'audio', 'audio/mp3': 'audio', 'audio/wav': 'audio', 'audio/x-wav': 'audio',
  'audio/wave': 'audio', 'audio/vnd.wave': 'audio', 'audio/mp4': 'audio', 'audio/x-m4a': 'audio',
  'audio/aac': 'audio', 'audio/x-aac': 'audio', 'audio/ogg': 'audio',
}
const BY_EXT: Record<string, DropKind> = {
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio',
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/**
 * What a file would become, or null for one the timeline cannot place.
 *
 * The MIME type first, the extension when the browser gave none — Finder
 * hands over an empty type for a `.m4a` more often than not, and refusing
 * a file for what the OS failed to say about it is refusing the person.
 */
export function kindOf(file: { type: string; name?: string }): DropKind | null {
  const t = file.type.toLowerCase()
  if (t) return BY_MIME[t] ?? null
  return BY_EXT[extOf(file.name ?? '')] ?? null
}

/**
 * Whether a drag in progress is worth lighting the zone for — read off
 * `dataTransfer.items`, the one moment the answer is available and still
 * useful: the rejection is the absence of an invitation, before the drop
 * rather than after it. `maybe` is a file whose type the drag does not say
 * (the name is not readable until the drop), which lights the zone and is
 * decided when it lands.
 */
export function invitation(items: DataTransferItemList | null | undefined): 'yes' | 'no' | 'maybe' {
  const files = [...(items ?? [])].filter((i) => i.kind === 'file')
  if (!files.length) return 'no'
  let maybe = false
  for (const f of files) {
    if (!f.type) { maybe = true; continue }
    if (kindOf({ type: f.type })) return 'yes'
  }
  return maybe ? 'maybe' : 'no'
}

/** "a PDF", "a GIF", "a Matroska video": what a refused file *is*, in the
 *  words somebody would use for it rather than its MIME type. */
function what(file: { type: string; name: string }): string {
  const t = file.type.toLowerCase()
  const ext = extOf(file.name)
  if (t === 'application/pdf' || ext === 'pdf') return 'a PDF'
  if (t === 'image/gif' || ext === 'gif') return 'a GIF'
  if (t === 'image/heic' || t === 'image/heif' || ext === 'heic' || ext === 'heif') return 'a HEIC photo'
  if (t === 'image/avif' || ext === 'avif') return 'an AVIF image'
  if (t === 'image/svg+xml' || ext === 'svg') return 'an SVG drawing'
  if (t === 'video/x-matroska' || ext === 'mkv') return 'a Matroska (.mkv) video'
  if (t.startsWith('text/')) return 'text'
  if (t === 'application/zip' || ext === 'zip') return 'a zip archive'
  if (t) return `a ${t} file`
  return ext ? `a .${ext} file` : 'a file with no type'
}

/** The refusal for a file the timeline cannot place, naming it and the type. */
export function refusal(file: { type: string; name: string }): ApiError {
  return { error: `${file.name} is ${what(file)} — the timeline takes ${ACCEPTS}.` }
}

/** How long a file may take to say what it is before it is treated as one
 *  this browser cannot decode. A local read — generous is cheap. */
const DECODE_MS = 15_000

/**
 * What this browser can decode `file` as — `kind`, or `audio` for a video
 * file with no picture in it — else why not, naming the file.
 *
 * Asked of the local file, before anything is uploaded: the engine cannot say
 * (its metadata read falls back to 600x400 and five seconds in silence), and a
 * file refused after the upload is a file left in the scene folder that
 * nothing plays.
 */
export function decodes(file: File, kind: DropKind): Promise<DropKind | ApiError> {
  const cannot = (detail?: string): ApiError => ({
    error: `${file.name} would not decode in this browser, so it was not added. `
      + 'Chrome and Edge read H.264 MP4, WebM, MOV, PNG, JPEG, WebP, MP3, WAV, M4A and OGG.',
    detail,
  })
  if (kind === 'image') {
    return createImageBitmap(file).then(
      (b): DropKind => { b.close(); return 'image' },
      (e: unknown) => cannot(e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
    )
  }
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'video' ? 'video' : 'audio')
    const url = URL.createObjectURL(file)
    let done = false
    const finish = (r: DropKind | ApiError): void => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      el.removeAttribute('src')
      el.load()
      URL.revokeObjectURL(url)
      resolve(r)
    }
    const timer = window.setTimeout(() => finish(cannot(`no metadata within ${String(DECODE_MS / 1000)}s`)),
      DECODE_MS)
    el.preload = 'metadata'
    el.muted = true
    el.onloadedmetadata = () => {
      // A video file with no picture in it — a voice memo saved as .mp4, a
      // soundtrack bounced to .mov — loads its metadata fine and would draw
      // nothing on V2. It is sound, so it goes where sound goes.
      finish(el instanceof HTMLVideoElement && !el.videoWidth ? 'audio' : kind)
    }
    el.onerror = () => {
      const m = el.error
      finish(cannot(m ? `MediaError ${String(m.code)}${m.message ? `: ${m.message}` : ''}` : undefined))
    }
    el.src = url
  })
}

/* ---- tracks ------------------------------------------------------------ */

const TYPE: Record<TrackKind, 'video' | 'audio' | 'text'> = {
  video: 'video', image: 'video', audio: 'audio', text: 'text',
}
const LETTER: Record<'video' | 'audio' | 'text', string> = { video: 'V', audio: 'A', text: 'T' }
const ACCEPTS_ON: Record<'video' | 'audio' | 'text', string[]> = {
  video: ['video', 'image'], audio: ['audio'], text: ['text', 'caption'],
}
const typeOf = (t: ITrack): string => t.type.toLowerCase()
const isPicture = (t: ITrack): boolean => typeOf(t) === 'video' || typeOf(t) === 'image'

/** The name the next track of `kind` would get: V2 after V1, A1 for the first
 *  sound. Counted, not stored — a track's name is its place in its kind. */
export function nextTrackName(project: Pick<IProject, 'tracks'>, kind: TrackKind): string {
  const type = TYPE[kind]
  const n = project.tracks.filter((t) => (type === 'video' ? isPicture(t) : typeOf(t) === type)).length
  return `${LETTER[type]}${String(n + 1)}`
}

/** The engine index a new track of `kind` belongs at — see the file comment. */
function stackIndex(project: Pick<IProject, 'tracks'>, kind: TrackKind): number {
  const type = TYPE[kind]
  if (type === 'text') return 0
  if (type === 'audio') return project.tracks.length
  const top = project.tracks.findIndex(isPicture)
  if (top >= 0) return top
  const firstSound = project.tracks.findIndex((t) => typeOf(t) === 'audio')
  return firstSound >= 0 ? firstSound : project.tracks.length
}

const hex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))]
  .map((n) => n.toString(16).padStart(2, '0')).join('')

/**
 * The commands that make a new track of `kind` holding `clip`: add, place,
 * fill — for one `batch`, so they are one undo entry.
 */
export function newTrackCommands(project: Pick<IProject, 'tracks'>, kind: TrackKind, clip: AnyClip): {
  commands: EditCommand[]
  track: ITrack
} {
  const type = TYPE[kind]
  const track: ITrack = {
    id: `trk_${type}_${hex(4)}`,
    name: nextTrackName(project, kind),
    type,
    clipIds: [],
    accepts: ACCEPTS_ON[type],
  }
  const commands: EditCommand[] = [{ type: 'track.add', payload: track }]
  const at = stackIndex(project, kind)
  // `track.add` put it at 0; anywhere else is a move in the same entry.
  if (at !== 0) commands.push({ type: 'track.move', payload: { id: track.id, newIndex: at } })
  commands.push({ type: 'clip.add', payload: { clip, trackId: track.id } })
  return { commands, track }
}

/** `clip` starting at `at` µs, its length untouched. */
function startingAt(clip: AnyClip, at: number): AnyClip {
  const d = clip.timing.display
  const from = Math.max(0, Math.round(at))
  return { ...clip, timing: { ...clip.timing, display: { from, to: from + (d.to - d.from) } } }
}

/* ---- what the zone shows ------------------------------------------------ */

export type DropState = {
  /** What the drop in flight is doing right now, in its own words — or null. */
  busy: string | null
  /** The last refusal, on the zone until the next drop or a dismissal. */
  error: ApiError | null
  /** The title clip being typed into, in place on the timeline. */
  editing: string | null
}

export const useDrop = create<DropState>(() => ({ busy: null, error: null, editing: null }))

/** What a drop resolved to: the track it made and the clip on it. */
export type Dropped = { trackId: string; trackName: string; clipId: string }

/** The scene the file belongs to — through persist's one minting function,
 *  because a drop is always worth keeping and a second minter is how one scene
 *  ends up split across two folders. */
const sceneIdNow = (): string => sceneIdFor(true) as string

const mb = (n: number): string => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${String(Math.ceil(n / 1024))} KB`)

const CLIP_TYPE: Record<DropKind, 'Video' | 'Image' | 'Audio'> = { video: 'Video', image: 'Image', audio: 'Audio' }

/**
 * Put `file` on a new track of its kind, starting at `at` µs. Resolves to the
 * track and clip it made, or a refusal naming the file; never rejects. The
 * zone reads `useDrop` for what it is doing meanwhile.
 */
export async function dropFile(file: File, at: number): Promise<Dropped | ApiError> {
  const done = (r: Dropped | ApiError): Dropped | ApiError => {
    useDrop.setState({ busy: null, error: failed(r) ? r : null })
    return r
  }
  const claimed = kindOf(file)
  if (!claimed) return done(refusal(file))
  const core = useEdit.getState().core
  if (!core) return done({ error: `The cut is still opening — drop ${file.name} again once it shows.` })

  useDrop.setState({ busy: `Reading ${file.name}…`, error: null })
  const kind = await decodes(file, claimed)
  if (failed(kind)) return done(kind)

  const sid = sceneIdNow()
  useDrop.setState({ busy: `Sending ${file.name} · ${mb(file.size)} to the scene…` })
  const saved = await sceneMedia(sid, file)
  if (failed(saved)) return done(saved)

  // The scene may have been cleared while the bytes travelled. The file is on
  // the volume either way; it only goes on the cut it was dropped on.
  if (useEdit.getState().core !== core || useStore.getState().sceneId !== sid) {
    return done({ error: `The scene closed while ${file.name} was sending. It is saved in that `
      + `scene's folder as ${saved.name}; drop it again to put it on this one.` })
  }

  useDrop.setState({ busy: `Placing ${file.name}…` })
  const payload: AddClipPayload = {
    type: CLIP_TYPE[kind],
    name: file.name,
    src: absoluteUrl(sceneFileUrl(sid, saved.name)),
    // Ours, in `metadata` — the only place the engine's serializers keep it.
    metadata: { media: saved.name, dropped: kind },
  }
  let clip: AnyClip
  try {
    clip = await core.clip.prepare(payload, kind === 'audio' ? undefined : { objectFit: 'contain' })
  } catch (e) {
    return done({
      error: `${file.name} is saved in the scene as ${saved.name}, but the editor could not read it.`,
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    })
  }
  if (useEdit.getState().core !== core) {
    return done({ error: `The scene closed while ${file.name} was being placed; it is saved as ${saved.name}.` })
  }
  const placed = startingAt(clip, at)
  const { commands, track } = newTrackCommands(core.store.getState(), kind, placed)
  pause()
  if (!batch(commands)) return done({ error: `The cut closed before ${file.name} could go on it.` })
  // The head goes to what just landed, so the stage shows it on the next frame.
  seek(placed.timing.display.from)
  return done({ trackId: track.id, trackName: track.name, clipId: placed.id })
}

/* ---- titles ------------------------------------------------------------ */

/** What a new title says before it is typed over. */
export const TITLE_TEXT = 'Title'

/**
 * A title on a new T track at `at` µs (the playhead when omitted), open for
 * typing in place. The engine's own text style, in the page's own face: the
 * engine's default font is fetched from fonts.gstatic.com, and nothing here
 * downloads on its own — `jost-600.woff2` is already in the bundle for the
 * wordmark, so pointing the title at it costs no request anybody did not make.
 *
 * It wraps, centred, inside 80% of the frame: the engine's default is one
 * line as wide as the words, and a sentence-long title ran off both edges of
 * the picture.
 */
export async function insertTitle(at?: number): Promise<Dropped | ApiError> {
  const core = useEdit.getState().core
  if (!core) return { error: 'The cut is still opening — add the title once it shows.' }
  const st = core.store.getState()
  const when = at ?? st.currentTime
  let clip: AnyClip
  try {
    clip = await core.clip.prepare({
      type: 'Text',
      name: TITLE_TEXT,
      text: TITLE_TEXT,
      style: {
        fontFamily: 'Jost', fontUrl: absoluteUrl(jostUrl),
        wordWrap: true, wordWrapWidth: Math.round(st.settings.width * 0.8), align: 'center',
      },
      metadata: { title: true },
    })
  } catch (e) {
    const err: ApiError = {
      error: 'The editor could not set a title here.',
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }
    useDrop.setState({ error: err })
    return err
  }
  if (useEdit.getState().core !== core) return { error: 'The cut closed before the title could go on it.' }
  const placed = startingAt(clip, when)
  const { commands, track } = newTrackCommands(core.store.getState(), 'text', placed)
  pause()
  if (!batch(commands)) return { error: 'The cut closed before the title could go on it.' }
  seek(placed.timing.display.from)
  useDrop.setState({ editing: placed.id, error: null })
  return { trackId: track.id, trackName: track.name, clipId: placed.id }
}

/**
 * Change what a title says — one undo entry. Resolves false when there is
 * nothing to change: no such title, or the same words. An empty title keeps
 * the words it had, because a title with nothing in it is a clip nobody can
 * see or find.
 *
 * The box is measured again for the new words, about the same centre. The
 * engine sizes a text clip once, when it is prepared, and draws inside that
 * box afterwards — so "Title" retyped as "Chapter one" was cut off at the
 * width of "Title" on the stage.
 */
export async function setTitleText(clipId: string, text: string): Promise<boolean> {
  const core = useEdit.getState().core
  const clip = core?.store.getState().clips[clipId]
  if (!core || !clip || clip.type !== 'Text') return false
  const next = text.replace(/\s+/g, ' ').trim()
  if (!next || next === clip.text) return false
  let box: { width: number; height: number } | null = null
  try {
    const m = await core.clip.prepare({ type: 'Text', text: next, style: clip.style })
    box = { width: m.transform.width, height: m.transform.height }
  } catch {
    // Unmeasured, the words still change; the box keeps its old size, which
    // is the engine's own behaviour and at worst what it drew before.
  }
  const now = core.store.getState().clips[clipId]
  if (useEdit.getState().core !== core || !now) return false
  const tr = now.transform
  const updates: Record<string, unknown> = { text: next, name: next }
  if (box && box.width > 0 && box.height > 0) {
    updates.transform = {
      ...tr,
      width: box.width,
      height: box.height,
      x: tr.x + (tr.width - box.width) / 2,
      y: tr.y + (tr.height - box.height) / 2,
    }
  }
  return execute({ type: 'clip.update', payload: { id: clipId, updates } })
}

/** Where on the timeline a drop at `x` px lands, in µs. */
export function timeAtPx(x: number, pxPerSec: number): number {
  return Math.max(0, Math.round((x / pxPerSec) * 1_000_000))
}

/** "0:03.2", for saying where a drop will land. */
export function clockAt(micro: number): string {
  const t = Math.max(0, sec(micro))
  const m = Math.floor(t / 60)
  return `${String(m)}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}

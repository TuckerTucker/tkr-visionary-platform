/**
 * An insert: an empty slot over V1 that opens already knowing which scene it
 * is in.
 *
 * A cutaway is three seconds of somebody's hands, and it is the same people in
 * the same light as the take it cuts away from. Rebuilding the cast, the look
 * and the LoRAs for it is the work this exists to remove — so an insert copies
 * them from what V1 is playing under its start, marks every one of them as
 * inherited, and lets any one be dropped with one press that touches nothing
 * but the insert.
 *
 * **Decided, and why:**
 *
 * - *An empty insert is a clip in the Core, not a record beside it.* It has a
 *   place in time and a track, which is arrangement, and the arrangement's only
 *   record is the Core (useEdit). A slot drawn from a second list would need a
 *   second undo history and a second saver, and the render path would need to
 *   learn a second kind of slot — while a clip carrying `slotId` is already
 *   what `renderSlot` aims at and what `slot.render` swaps a landed take into,
 *   at its start, on its track. So the empty slot is filled by the path every
 *   slot is filled by, and undoing the render puts the empty insert back.
 *
 * - *The clip is a Text clip drawn at zero opacity.* OpenVideo 1.4.0's
 *   `project.import` keeps a clip with no `src` only if it is Text, Caption,
 *   Effect or Transition (read from `@openvideo/core`'s import filter) — an
 *   empty-src Video, a Shape and a Backdrop all vanish on the next reload, which
 *   is an insert that did not survive being saved. Of the four, Text is the one
 *   that composites nothing when invisible: an Effect filters what is under it,
 *   a Caption wants words and timings. It uses the bundled Jost face, as a
 *   title does, because the engine's default face is fetched from
 *   fonts.gstatic.com and nothing here downloads on its own.
 *
 * - *What it inherited lives on its track, keyed by slot:*
 *   `track.inserts[slotId]`. Not in the clip's metadata, because the render
 *   that fills the insert swaps the clip for the take's (`slot.render` keeps
 *   the new take's metadata, correctly — see `stamped` in commands.ts) and the
 *   context would go with the empty clip: the chips would vanish the moment the
 *   insert rendered, and rendering it again would be rendering the scene's cast
 *   rather than its own. The track survives a swap untouched. It is also a
 *   Core record, so dropping an inherited item is a `track.update` — one undo
 *   entry on the same history as a trim, saved in project.json with the rest
 *   of the arrangement, and read back by the same import (tracks are kept
 *   verbatim, extra fields included). One insert per track, because an insert
 *   makes its track the way a dropped file does (`drop.ts`): no add-track
 *   button, and no empty lane.
 *
 * - *"The V1 slot under 0:12" means the scene's context.* The cast, the look
 *   and the LoRAs are scene-wide by design — they "never belonged to a take"
 *   (useVideo's `chain`) — so every V1 slot's context is the scene's, and there
 *   is no per-slot snapshot to read. Recording one at render time would be a
 *   second copy of the cast that disagrees with the first the moment anybody
 *   edits a member. The insert copies the scene as it stands and records which
 *   V1 slot it covers (`from`), which is what staleness (slice 15) walks.
 *
 * - *V1's frame is offered, not taken.* Pinned as the insert's first frame it
 *   makes the insert open on the picture it cuts away from — right for a
 *   push-in, wrong for a cutaway, and the more common of the two is the second.
 *   Taken, it is marked inherited like everything else and dropped the same
 *   way. It is stored as a flag, not pixels: the frame is read out of V1's file
 *   when the insert renders, so it is always the frame V1 plays *now* at the
 *   insert's start — derived and disposable, and not a megabyte of base64 in
 *   every save of project.json.
 *
 * Only `import type` from the engine: this module is reached from the timeline
 * on the first-load path.
 */
import type { AnyClip, IProject, ITrack } from '@openvideo/core'

import { failed, type ApiError } from '../api/client'
import { fileUrl } from '../api/routes'
import type { LoraChip } from '../lora/tokens'
import { named, newShot, type CastMember, type PoolFile, type Scene } from '../scene/model'
import { useStore, type Store } from '../store'
import jostUrl from '../styles/jost-600.woff2'
import { absoluteUrl, sec } from './engine'
import { newTrackCommands, type Dropped } from './drop'
import { mintSlotId, slotOf, v1 } from './project'
import { batch, execute, pause, seek, useEdit, type EditCommand } from './useEdit'

/** How long an insert made at a point (I, or the strip's button) runs. A
 *  cutaway is a beat, and three seconds is one you can see without it being a
 *  second shot. */
export const INSERT_SECONDS = 3

/** The shortest insert a drag makes. Shorter than this and the bar is too
 *  narrow to carry its own render control, which is a slot nobody can fill. */
export const INSERT_MIN_SECONDS = 1

/** What the empty clip is called on its bar until a take fills it. */
export const INSERT_NAME = 'Empty insert'

/** What an insert copied from the scene when it was made, less what has been
 *  dropped since. Everything in here is inherited — nothing is added to an
 *  insert except by taking V1's frame, which is inherited too. */
export type InsertContext = {
  /** The V1 slot under the insert's start when it was made; null when nothing
   *  on V1 was under it. */
  from: string | null
  /** Where it was read, µs. */
  at: number
  cast: CastMember[]
  style: string
  grade: string
  loras: LoraChip[]
  /** V1's frame at the insert's start, as its first frame — see the top. */
  frame: boolean
}

/** A track as this module reads it: the engine's, plus the inserts it holds. */
type InsertTrack = ITrack & { inserts?: Record<string, InsertContext> }

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * A context read off disk, or null for something that is not one. Lenient
 * where the page can supply a default and silent about fields it does not know
 * — a sidecar is read years after it is written — so an insert saved by an
 * older page still opens with what it had.
 */
function readContext(x: unknown): InsertContext | null {
  if (!isObj(x)) return null
  return {
    ...(x as Partial<InsertContext>),
    from: typeof x.from === 'string' ? x.from : null,
    at: typeof x.at === 'number' ? x.at : 0,
    cast: Array.isArray(x.cast) ? (x.cast as CastMember[]) : [],
    style: typeof x.style === 'string' ? x.style : '',
    grade: typeof x.grade === 'string' ? x.grade : '',
    loras: Array.isArray(x.loras) ? (x.loras as LoraChip[]) : [],
    frame: x.frame === true,
  }
}

/** The track holding `slotId`'s insert context, and the context. */
function insertEntry(project: Pick<IProject, 'tracks'> | null, slotId: string | null):
  { track: InsertTrack; ctx: InsertContext } | null {
  if (!project || !slotId) return null
  for (const t of project.tracks as InsertTrack[]) {
    const raw = isObj(t.inserts) ? t.inserts[slotId] : undefined
    const ctx = readContext(raw)
    if (ctx) return { track: t, ctx }
  }
  return null
}

/** `slotId`'s inherited context, or null when the slot is not an insert. */
export function insertOf(project: Pick<IProject, 'tracks'> | null, slotId: string | null): InsertContext | null {
  return insertEntry(project, slotId)?.ctx ?? null
}

/** Whether `clip` is an insert nothing has been rendered into yet. */
export function isEmptyInsert(clip: Pick<AnyClip, 'metadata'>): boolean {
  return clip.metadata?.insert === true
}

/** The V1 clip playing at `at` µs, or null. A dissolve is not a clip. */
export function v1ClipAt(project: Pick<IProject, 'tracks' | 'clips'> | null, at: number): AnyClip | null {
  if (!project) return null
  const track = v1(project)
  if (!track) return null
  for (const id of track.clipIds) {
    const c = project.clips[id]
    if (!c || c.type === 'Transition') continue
    const d = c.timing.display
    if (d.from <= at && at < d.to) return c
  }
  return null
}

/** The video side's LoRA chips, whichever side is showing. */
function videoLoras(s: Store): LoraChip[] {
  return s.kind === 'video' ? s.loras : (s.stash.video?.loras ?? [])
}

/**
 * What an insert at `at` inherits: the scene's named cast, its look and its
 * LoRAs, as they stand — see the top for why the scene is the V1 slot's
 * context. Copies, so an edit to the scene after this is not an edit to the
 * insert: *edits in a scene are scene-local*, and the insert is its own.
 */
export function contextAt(project: Pick<IProject, 'tracks' | 'clips'> | null, at: number, s: Store): InsertContext {
  const under = v1ClipAt(project, at)
  return {
    from: under ? slotOf(under) : null,
    at,
    cast: structuredClone(named(s.scene.cast)),
    style: s.scene.style,
    grade: s.scene.grade,
    loras: structuredClone(videoLoras(s)),
    frame: false,
  }
}

/* ---- making one --------------------------------------------------------- */

/**
 * An empty insert from `from` to `to` µs, on a new picture track over V1, as
 * one undo entry: the track, its place in the stack, the empty clip and what
 * it inherited all arrive in one `batch`. Resolves to what it made, or why not;
 * never rejects.
 */
export async function makeInsert(from: number, to: number): Promise<Dropped | ApiError> {
  const core = useEdit.getState().core
  if (!core) return { error: 'The cut is still opening — make the insert once it shows.' }
  const start = Math.max(0, Math.round(Math.min(from, to)))
  const length = Math.max(Math.round(Math.abs(to - from)), INSERT_MIN_SECONDS * 1_000_000)
  const st = core.store.getState()
  // The drawn project, parked clips included: a V1 slot whose file would not
  // load is still the slot the insert covers.
  const drawn = useEdit.getState().project ?? { settings: st.settings, tracks: st.tracks, clips: st.clips }
  const slotId = mintSlotId(drawn)
  const ctx = contextAt(drawn, start, useStore.getState())

  let prepared: AnyClip
  try {
    prepared = await core.clip.prepare({
      type: 'Text',
      name: INSERT_NAME,
      text: INSERT_NAME,
      style: { fontFamily: 'Jost', fontUrl: absoluteUrl(jostUrl) },
      metadata: { slotId, insert: true },
    })
  } catch (e) {
    return {
      error: 'The editor could not make an insert here.',
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }
  }
  if (useEdit.getState().core !== core) return { error: 'The cut closed before the insert could go on it.' }
  const clip = {
    ...prepared,
    metadata: { ...prepared.metadata, slotId, insert: true },
    timing: {
      ...prepared.timing,
      display: { from: start, to: start + length },
      trim: { from: 0, to: length },
      duration: length,
    },
    transform: { ...prepared.transform, opacity: 0 },
  } as AnyClip
  const { commands, track } = newTrackCommands(core.store.getState(), 'video', clip)
  // `track.add` builds its track from a fixed list of fields, so the context
  // goes on with `track.update`, which spreads — in the same batch, so the
  // insert and what it inherited are one undo.
  const withContext: EditCommand[] = [
    ...commands,
    { type: 'track.update', payload: { id: track.id, updates: { inserts: { [slotId]: ctx } } } },
  ]
  pause()
  if (!batch(withContext)) return { error: 'The cut closed before the insert could go on it.' }
  seek(start)
  return { trackId: track.id, trackName: track.name, clipId: clip.id }
}

/* ---- dropping what it inherited ----------------------------------------- */

/** One inherited thing, as the slot draws it. `key` is what `dropInherited`
 *  takes. */
export type InheritedItem =
  | { key: string; kind: 'cast'; label: string; member: CastMember }
  | { key: 'style' | 'grade'; kind: 'look'; label: string }
  | { key: string; kind: 'lora'; label: string; lora: LoraChip }
  | { key: 'frame'; kind: 'frame'; label: string }

/** Everything `ctx` still carries, in the order the rail draws the scene's:
 *  cast, look, LoRAs — and V1's frame last, when taken. */
export function inheritedItems(ctx: InsertContext): InheritedItem[] {
  const out: InheritedItem[] = []
  for (const m of ctx.cast) out.push({ key: `cast:${m.id}`, kind: 'cast', label: m.name, member: m })
  if (ctx.style.trim()) out.push({ key: 'style', kind: 'look', label: ctx.style.trim() })
  if (ctx.grade.trim()) out.push({ key: 'grade', kind: 'look', label: ctx.grade.trim() })
  for (const l of ctx.loras) out.push({ key: `lora:${l.path}`, kind: 'lora', label: l.rel, lora: l })
  if (ctx.frame) out.push({ key: 'frame', kind: 'frame', label: 'V1 frame' })
  return out
}

/** `ctx` without the item `key`, or null when it holds no such item. */
export function without(ctx: InsertContext, key: string): InsertContext | null {
  if (key.startsWith('cast:')) {
    const id = key.slice(5)
    return ctx.cast.some((m) => m.id === id) ? { ...ctx, cast: ctx.cast.filter((m) => m.id !== id) } : null
  }
  if (key.startsWith('lora:')) {
    const path = key.slice(5)
    return ctx.loras.some((l) => l.path === path) ? { ...ctx, loras: ctx.loras.filter((l) => l.path !== path) } : null
  }
  if (key === 'style') return ctx.style ? { ...ctx, style: '' } : null
  if (key === 'grade') return ctx.grade ? { ...ctx, grade: '' } : null
  if (key === 'frame') return ctx.frame ? { ...ctx, frame: false } : null
  return null
}

/** Put `next` in place of `slotId`'s context — one `track.update`, one undo.
 *  Only the insert's own track is written, so V1 and the scene cannot move. */
function setContext(slotId: string, next: InsertContext): boolean {
  const core = useEdit.getState().core
  const found = insertEntry(core?.store.getState() ?? null, slotId)
  if (!core || !found) return false
  const inserts = { ...(isObj(found.track.inserts) ? found.track.inserts : {}), [slotId]: next }
  return execute({ type: 'track.update', payload: { id: found.track.id, updates: { inserts } } })
}

/**
 * Drop one inherited item from the insert — one gesture, one undo entry, and
 * nothing but the insert changes: the scene's cast, the V1 slot and every
 * other insert are untouched. False when there was nothing to drop.
 */
export function dropInherited(slotId: string, key: string): boolean {
  const ctx = insertOf(useEdit.getState().core?.store.getState() ?? null, slotId)
  const next = ctx ? without(ctx, key) : null
  return next ? setContext(slotId, next) : false
}

/** Take V1's frame at the insert's start as its first frame — one undo. */
export function takeFrame(slotId: string): boolean {
  const ctx = insertOf(useEdit.getState().core?.store.getState() ?? null, slotId)
  return ctx && !ctx.frame ? setContext(slotId, { ...ctx, frame: true }) : false
}

/* ---- rendering one ------------------------------------------------------ */

/** How long reading V1's frame may take before the render goes without it and
 *  says so. A local decode of a file the stage already plays. */
const FRAME_MS = 15_000

/**
 * The frame `url` shows at `t` seconds, as the bare base64 a keyframe slot
 * takes, or why not. `lastFrame`'s method at an arbitrary time: a <video> in
 * the page decodes what is already being served to the stage, where a route
 * would rent a container to do the same.
 */
export function frameAt(url: string, t: number): Promise<string | ApiError> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    let done = false
    const finish = (r: string | ApiError): void => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      v.removeAttribute('src')
      v.load()
      resolve(r)
    }
    const cannot = (detail: string): ApiError => ({
      error: `V1's frame at ${t.toFixed(2)}s could not be read, so the insert did not render. `
        + 'Drop the V1 frame from the insert to render it without one.',
      detail: `${url}: ${detail}`,
    })
    const timer = window.setTimeout(() => finish(cannot(`no frame within ${String(FRAME_MS / 1000)}s`)), FRAME_MS)
    v.onloadedmetadata = () => {
      // Not `duration`: a fragmented MP4 reports Infinity until read to the end.
      const end = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : v.duration
      v.currentTime = Math.max(0, Math.min(t, Number.isFinite(end) ? Math.max(0, end - 0.05) : t))
    }
    v.onseeked = () => {
      const c = document.createElement('canvas')
      c.width = v.videoWidth
      c.height = v.videoHeight
      if (!c.width || !c.height) { finish(cannot('the file has no picture')); return }
      c.getContext('2d')?.drawImage(v, 0, 0)
      finish(c.toDataURL('image/jpeg', 0.92).split(',')[1] ?? cannot('the frame would not encode'))
    }
    v.onerror = () => finish(cannot(v.error ? `MediaError ${String(v.error.code)}` : 'the file would not load'))
    v.src = url
  })
}

/** V1's frame under the insert `slotId` starts at, now — whatever V1 plays
 *  there after every trim since the insert was made. */
async function v1FrameUnder(slotId: string): Promise<string | ApiError> {
  const project = useEdit.getState().project
  const mine = project ? Object.values(project.clips).find((c) => slotOf(c) === slotId) : undefined
  const at = mine?.timing.display.from ?? insertOf(project, slotId)?.at ?? 0
  const under = v1ClipAt(project, at)
  const m = under?.metadata
  if (!under || typeof m?.jobId !== 'string' || typeof m.file !== 'string') {
    return {
      error: `Nothing on V1 plays at ${sec(at).toFixed(1)}s any more, so there is no frame to open the `
        + 'insert on. Drop the V1 frame from the insert to render it without one.',
    }
  }
  const rate = under.timing.playbackRate && under.timing.playbackRate > 0 ? under.timing.playbackRate : 1
  const t = sec((under.timing.trim?.from ?? 0) + (at - under.timing.display.from) * rate)
  return frameAt(absoluteUrl(fileUrl(m.jobId, m.file)), t)
}

/** The pool files a member's references point at that are not in the pool —
 *  a picture the scene let go of after the insert copied the member. */
function missingFiles(cast: CastMember[], pool: Record<string, PoolFile>): string[] {
  const out: string[] = []
  for (const m of cast) {
    const gone = m.refs.filter((r) => !pool[r.fileId]).length
    if (gone) out.push(`${m.name} (${String(gone)} file${gone === 1 ? '' : 's'})`)
  }
  return out
}

/**
 * The store a render into insert `slotId` is built from: the page's, with the
 * insert's own cast, look and LoRAs in place of the scene's — and, with V1's
 * frame taken, that frame as the first frame. Null when the slot is not an
 * insert (the render is the ordinary one); a refusal naming what is missing
 * when the insert cannot be rendered as it says.
 *
 * `line` is the sentence to render when the composer is empty — the take's own,
 * as `renderSlot` picks it. An ordinary slot re-rendered from its sentence
 * sends no scene at all; an insert's scene *is* its cast, so the sentence is
 * put in it as its one shot rather than sending the cast away with the
 * composer's empty rows.
 *
 * What the composer holds for Generate does not travel: a continuation armed,
 * the keyframe and reference trays, a document taken over by hand. Each is
 * about the take Generate will make next, and none of them is the insert's.
 */
export async function insertStore(slotId: string, s: Store, line: string | null): Promise<{ store: Store } | ApiError | null> {
  const ctx = insertOf(useEdit.getState().project, slotId)
  if (!ctx) return null
  const lost = missingFiles(ctx.cast, s.pool)
  if (lost.length) {
    return {
      error: `This insert's cast points at pictures the scene no longer holds: ${lost.join(', ')}. `
        + 'Drop them from the insert, or attach the pictures again in the scene before rendering it.',
    }
  }
  let first: string | null = null
  if (ctx.frame) {
    const f = await v1FrameUnder(slotId)
    if (failed(f)) return f
    first = f
  }
  const scene: Scene = {
    ...s.scene,
    cast: ctx.cast,
    style: ctx.style,
    grade: ctx.grade,
    ...(line !== null && { shots: [newShot(line)] }),
  }
  return {
    store: {
      ...s,
      scene,
      loras: ctx.loras,
      continueFrom: null,
      keyframe: { first, last: null },
      refs: [],
      refVids: [],
      refRoles: [],
      doc: null,
    },
  }
}

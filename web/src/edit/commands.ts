/**
 * Rendering is an edit: `slot.render`, `take.choose` and `slot.continue` as
 * OpenVideo commands, on the same history as a trim.
 *
 * **A command is synchronous and a render is not**, so the two halves are
 * split where they fall. Pressing render starts an ordinary `/api/video` job
 * (useVideo — the job/status/stop contract, unchanged) and marks the slot as
 * rendering, which is page state and not an edit. When the take *lands*, the
 * edit happens: one command, one undo entry, replacing the slot's clip with
 * the new take. Undo puts the previous take back; the undone take's bytes stay
 * in their job folder on the volume and in the slot's take list, one ‹ › away.
 *
 * **Every handler is pure** — `(state, cmd) => Patch[]`, reading nothing but
 * its arguments — and every patch is a WHOLE clip or the whole track list, with
 * `oldValue`. Core inverts a patch by swapping `value` and `oldValue`; a patch
 * on a field path (`/clips/x/timing/display`) inverts to that field alone, and
 * the Studio then rebuilds the clip from a half-old, half-new object. Whole
 * objects invert to exactly what was there.
 *
 * **Swapping a take is a remove and an add of the same id**, not an update.
 * The Studio's bridge applies an update to a clip it already holds by copying
 * fields onto it, and `src` is not one of the fields it copies — the clip
 * would keep playing the old file under the new name. A remove and an add
 * make it load the new one. The id is kept because it is what everything else
 * in the arrangement points at: a transition's `fromClipId`, a selection, the
 * saved project.
 *
 * **Decided, and why:**
 *
 * - *A take lands at the slot's start and plays whole.* The trim a person set
 *   on the old take was chosen against that take's frames; carried across, an
 *   in-point of 1.2 s would cut into a different shot at a different moment,
 *   which is a trim nobody made. A fade is a property of the place rather than
 *   the picture, so fades are kept.
 * - *The rest of the track moves by the difference in length.* A slot is a
 *   place in a sequence, and a longer take either overlaps the next one or a
 *   shorter one leaves a hole — both of which would be edits the person did
 *   not make. On V1 that is the layout every trim ends in (`relayV1`), so a
 *   crossfade moves with its cut — moving only the pictures once left each
 *   dissolve where the cut used to be. Other tracks are not moved: an overlay
 *   sits at a time, not after a clip, and guessing which it belongs to is a
 *   guess.
 * - *A continuation moves its source's out-point to where it opens.* The
 *   server snaps the cut down onto the motion latent's grid, so without this
 *   up to 16 frames play twice across the join. Same command, so one undo puts
 *   the source's trim back and takes the continuation out (`cutBack`). A
 *   continuation made again in its own slot (the stale offer, `slot.render`
 *   with a `cut`) meets its source the same way.
 * - *A detached slot stays detached.* Once a slot's sound has been put on an
 *   A track (detach.ts), a new take in that slot — rendered, or chosen with
 *   ‹ › — arrives silent and linked, and the linked Audio clip is swapped to
 *   the new take's file in the same patches, its timing the new Video's (trim
 *   reset, as the picture's is; its own fades kept, a fade being the place's).
 *   Before this the new take arrived with its own sound on and the old Audio
 *   clip stayed on its A track playing the take that no longer showed: two
 *   soundtracks, one of them for a picture nobody could see. One undo puts
 *   back the old take *and* its sound. See `carrySound`.
 * - *A new take's sound that no longer fits its A track moves; it is not
 *   clamped.* When the new take is longer than the room its sound's track has
 *   (another clip starts there before the new take ends), the sound goes onto
 *   the first A track free for its whole stretch, else a new A track at the
 *   bottom — the rule a detach itself lands by. Clamping would cut the new
 *   take's sound short where its picture plays on, which is a trim nobody
 *   made; a sound on another lane is still all there, and one drag puts it
 *   back.
 * - *`take.choose` carries the clip, not only the index.* The handler cannot
 *   read the take list (it lives in the store, not the Core) or a file's length
 *   (that is an async read); the caller does both and hands over the clip the
 *   engine read. `index` rides along so the history says which take was chosen.
 */
import type { AnyClip, CommandHandler, IProject, ITrack, Patch } from '@openvideo/core'

import type { Engine } from './engine'
import { edgeOf, planTrim, refused, relayV1, v1Clips } from './cuts'
import { slotOf, v1, v1Track } from './project'

export const SLOT_RENDER = 'slot.render'
export const TAKE_CHOOSE = 'take.choose'
export const SLOT_CONTINUE = 'slot.continue'

/**
 * `slot.render` — the landed take becomes the slot's clip.
 *
 * `clip` is the engine's reading of the take (`core.clip.prepare`), carrying
 * `{slotId, jobId, file}` in its metadata. When no clip in the Core fills the
 * slot — it was held out of the Core because its old file would not load —
 * the take is put where that one sat: `trackId` at `at` µs, the place having
 * been `span` µs long.
 */
export type SlotRenderPayload = {
  slotId: string
  clip: AnyClip
  trackId?: string
  at?: number
  span?: number
  /** See `Placing.keepGaps`. */
  keepGaps?: boolean
  /** Where the take opens in the take it continues, when it is a continuation
   *  rendered into its own slot (the stale offer): take `jobId`, `to` µs into
   *  it. The clip playing that take is cut back to it — see `cutBack`. */
  cut?: { jobId: string; to: number }
}

/** `take.choose` — the slot's clip plays take `index` of its list instead. */
export type TakeChoosePayload = { slotId: string; index: number; clip: AnyClip; keepGaps?: boolean }

/** `slot.continue` — a new slot, `slotId`, filled with `clip`, directly after
 *  `fromSlotId` on its track. With `fromSlotId` gone (removed, or undone while
 *  the take rendered) the new slot goes on the end of V1.
 *
 *  `cut` is where the continuation opens in its source: take `jobId`, `to` µs
 *  into it (`continued_at`). See `cutBack`. */
export type SlotContinuePayload = {
  fromSlotId: string
  slotId: string
  clip: AnyClip
  keepGaps?: boolean
  cut?: { jobId: string; to: number }
}

type State = Pick<IProject, 'clips' | 'tracks' | 'settings'>

type Placing = {
  /**
   * Set by the caller while a clip on V1 is held out of the Core because its
   * file would not load (`useEdit`'s parked clips). V1 is otherwise re-laid
   * gapless, as a trim leaves it — and that would close the hole the held clip
   * is still written back into, putting two clips in one place.
   */
  keepGaps: boolean
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const lengthOf = (c: AnyClip): number => c.timing.display.to - c.timing.display.from

const trackOf = (state: Pick<IProject, 'tracks'>, clipId: string): ITrack | null =>
  state.tracks.find((t) => t.clipIds.includes(clipId)) ?? null

const inSlot = (state: Pick<IProject, 'clips'>, slotId: string): AnyClip | null =>
  Object.values(state.clips).find((c) => slotOf(c) === slotId) ?? null

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const asProject = (s: State): IProject => ({ settings: s.settings, tracks: s.tracks, clips: s.clips })

/** The id a clip is linked to — a detached sound's picture, a silenced
 *  picture's sound (detach.ts) — or null. */
export function linkedTo(clip: Pick<AnyClip, 'metadata'>): string | null {
  const l: unknown = clip.metadata?.linkedTo
  return typeof l === 'string' && l ? l : null
}

export const isAudioTrack = (t: ITrack): boolean => t.type.toLowerCase() === 'audio'

/** Whether `track` has nothing playing anywhere in [from, to), not counting
 *  clip `skip` — the one being placed, wherever it sits now. */
export function freeOver(state: Pick<IProject, 'clips'>, track: ITrack, from: number, to: number,
  skip?: string): boolean {
  return track.clipIds.every((id) => {
    const c = state.clips[id]
    if (!c || id === skip) return true
    const d = c.timing.display
    return d.to <= from || d.from >= to
  })
}

/**
 * The Audio clip `video`'s sound was detached onto, or null — only when the
 * link holds both ways. A link to a clip that is gone, or that points
 * elsewhere, is a sound somebody deleted or a stale mark; nothing follows it.
 */
export function soundOf(state: Pick<IProject, 'clips'>, video: AnyClip): AnyClip | null {
  const id = linkedTo(video)
  const s = id ? state.clips[id] : undefined
  return s && s.type === 'Audio' && video.audio === false && linkedTo(s) === video.id ? s : null
}

/** A new A track, its id and name made from the state alone so the handler
 *  stays pure and a redo makes the same one. The name is the count drop.ts's
 *  `nextTrackName` makes; it cannot be imported here, because drop.ts imports
 *  useEdit and useEdit imports this file. */
function newSoundTrack(state: Pick<IProject, 'tracks'>, soundId: string): ITrack {
  let id = `trk_audio_${soundId}`
  for (let n = 2; state.tracks.some((t) => t.id === id); n++) id = `trk_audio_${soundId}_${String(n)}`
  const n = state.tracks.filter(isAudioTrack).length
  return { id, name: `A${String(n + 1)}`, type: 'audio', clipIds: [], accepts: ['audio'] }
}

/**
 * `state` — in which clip `videoId` has just become a new take — with that
 * take kept detached: the Video silenced and linked to `sound`, and `sound`
 * playing the new take's file over the new take's stretch. See "A detached
 * slot stays detached" at the top of this file.
 *
 * Both silences are written, as a detach writes them: the export reads
 * `audio`, the stage's video element reads `muted`. The sound's metadata is
 * the new take's alone, as the Video's is (`stamped`) — an old `source`
 * length describes the old file.
 */
function carrySound(state: State, videoId: string, sound: AnyClip): State {
  const video = state.clips[videoId]
  if (!video) return state
  const silent = {
    ...video,
    audio: false,
    muted: true,
    metadata: { ...video.metadata, linkedTo: sound.id },
  } as AnyClip
  const meta = isObj(video.metadata) ? video.metadata : {}
  // The picture's fades were the old place's; the sound keeps its own.
  const timing = { ...video.timing }
  delete timing.fadeIn
  delete timing.fadeOut
  const next = {
    ...sound,
    name: `${video.name} · sound`,
    src: video.src,
    timing: {
      ...timing,
      ...(sound.timing.fadeIn !== undefined && { fadeIn: sound.timing.fadeIn }),
      ...(sound.timing.fadeOut !== undefined && { fadeOut: sound.timing.fadeOut }),
    },
    metadata: {
      ...(typeof meta.jobId === 'string' && { jobId: meta.jobId }),
      ...(typeof meta.file === 'string' && { file: meta.file }),
      linkedTo: video.id,
    },
  } as AnyClip

  const { from, to } = next.timing.display
  const fits = (t: ITrack): boolean => isAudioTrack(t) && freeOver(state, t, from, to, sound.id)
  const on = trackOf(state, sound.id)
  let tracks = state.tracks
  if (!on || !fits(on)) {
    const other = state.tracks.find((t) => t.id !== on?.id && fits(t))
    const rest = state.tracks.map((t) =>
      (t.id === on?.id ? { ...t, clipIds: t.clipIds.filter((id) => id !== sound.id) } : t))
    tracks = other
      ? rest.map((t) => (t.id === other.id ? { ...t, clipIds: [...t.clipIds, sound.id] } : t))
      // The bottom of the stack, where every sound goes (drop.ts).
      : [...rest, { ...newSoundTrack(state, sound.id), clipIds: [sound.id] }]
  }
  return { ...state, tracks, clips: { ...state.clips, [videoId]: silent, [sound.id]: next } }
}

/** Whether `track` is V1 and V1 may be re-laid — see `Placing.keepGaps`. */
const relays = (state: State, track: ITrack | null, p: Placing): boolean =>
  !p.keepGaps && track !== null && track.id === v1(state)?.id

/**
 * `clip` with its metadata naming `slotId` — whatever the reader put there —
 * so the slot is found by the next command however the clip was prepared.
 *
 * The metadata is the new take's alone. A trimmed clip carries its file's
 * length in `metadata.source` (cuts.ts), keyed by the path it measured, and the
 * old take's entry describes the old file: carried across, it would be one
 * file's length claimed for another. A fresh take is untrimmed, so its own
 * length is where its trim ends until a trim of it writes that down.
 */
function stamped(clip: AnyClip, slotId: string): AnyClip {
  return { ...clip, metadata: { ...clip.metadata, slotId } }
}

/** `clip` placed to start at `from` and play its whole length. */
function placed(clip: AnyClip, from: number): AnyClip {
  const len = lengthOf(clip)
  return { ...clip, timing: { ...clip.timing, display: { from, to: from + len } } }
}

/** `clips` with every clip on `track` that starts at or after `from` moved by
 *  `delta` µs, leaving out `skip` — for a track that is not re-laid. */
function ripple(clips: Record<string, AnyClip>, track: ITrack | null, from: number, delta: number,
  skip: string): Record<string, AnyClip> {
  if (!track || delta === 0) return clips
  const out = { ...clips }
  for (const id of track.clipIds) {
    const c = out[id]
    if (id === skip || !c || c.timing.display.from < from) continue
    const d = c.timing.display
    out[id] = { ...c, timing: { ...c.timing, display: { from: d.from + delta, to: d.to + delta } } } as AnyClip
  }
  return out
}

/**
 * The patches that turn `before` into `after`: whole clips and the whole track
 * list, each with `oldValue`, in the order the Studio's bridge needs them —
 * removals, the swapped clips' remove and add (see the top of this file) —
 * the take, and its detached sound when it has one, whose `src` changes too —
 * new clips, moved clips, and the track list last.
 */
function patchesFor(before: State, after: State, swapped: readonly string[] = []): Patch[] {
  const out: Patch[] = []
  for (const [id, c] of Object.entries(before.clips)) {
    if (!after.clips[id]) out.push({ op: 'remove', path: `/clips/${id}`, oldValue: c })
  }
  for (const id of swapped) {
    const was = before.clips[id]
    const now = after.clips[id]
    if (!was || !now) continue
    out.push({ op: 'remove', path: `/clips/${id}`, oldValue: was })
    out.push({ op: 'add', path: `/clips/${id}`, value: now })
  }
  for (const [id, c] of Object.entries(after.clips)) {
    if (!before.clips[id]) out.push({ op: 'add', path: `/clips/${id}`, value: c })
  }
  for (const [id, c] of Object.entries(after.clips)) {
    const was = before.clips[id]
    if (was && !swapped.includes(id) && !same(was, c)) {
      out.push({ op: 'update', path: `/clips/${id}`, value: c, oldValue: was })
    }
  }
  if (!same(before.tracks, after.tracks)) {
    out.push({ op: 'update', path: '/tracks', value: after.tracks, oldValue: before.tracks })
  }
  return out
}

/**
 * The patches that put `next` in the place `old` holds: same id, same start,
 * the whole new take, the old take's fades — and the track after it laid out
 * again for the new length. On V1 that is `relayV1`, the layout every trim
 * ends in, so each crossfade follows its cut; elsewhere the clips after it move
 * by the difference. A slot whose sound was detached stays detached
 * (`carrySound`), in the same patches.
 */
function swap(state: State, old: AnyClip, next: AnyClip, p: Placing, was: State = state): Patch[] {
  const fades = {
    ...(old.timing.fadeIn !== undefined && { fadeIn: old.timing.fadeIn }),
    ...(old.timing.fadeOut !== undefined && { fadeOut: old.timing.fadeOut }),
  }
  const base = placed(next, old.timing.display.from)
  const clip = { ...base, id: old.id, timing: { ...base.timing, ...fades } } as AnyClip
  const track = trackOf(state, old.id)
  const put: State = { ...state, clips: { ...state.clips, [old.id]: clip } }
  const laid: State = relays(state, track, p)
    ? relayV1(asProject(put))
    : { ...put, clips: ripple(put.clips, track, old.timing.display.to, lengthOf(clip) - lengthOf(old), old.id) }
  const sound = soundOf(state, old)
  if (!sound) return patchesFor(was, laid, [old.id])
  return patchesFor(was, carrySound(laid, old.id, sound), [old.id, sound.id])
}

/**
 * The patches that put `clip` on a track as a new clip.
 *
 * On V1 (with no gap to keep) it goes into V1's order directly after `afterId`
 * — or last — and V1 is re-laid, which moves everything after it along and
 * drops a crossfade whose two clips no longer meet: a continuation put between
 * two dissolving clips leaves that dissolve with no cut to be on.
 *
 * Otherwise it goes at `at` µs (the end of the track when null), and whatever
 * starts at or after `at + span` moves by the difference — `span` being the
 * room the place already had: the old length for a slot whose clip was held
 * out of the Core, zero for a new one.
 *
 * With no track at all, V1 is created in the same patches, so the edit and its
 * undo are still one entry.
 *
 * `state` may already hold other changes made in the same edit; `was` is the
 * state before any of them, which is what the patches are taken against — so
 * the undo puts back what was there, not the half-made edit.
 */
function insert(state: State, trackId: string | null, afterId: string | null, at: number | null,
  span: number, clip: AnyClip, p: Placing, was: State = state): Patch[] {
  const existing = (trackId ? state.tracks.find((t) => t.id === trackId) : undefined) ?? v1(state)
  const tracks = existing
    ? state.tracks.map((t) => (t.id === existing.id ? { ...t, clipIds: [...t.clipIds, clip.id] } : t))
    : [...state.tracks, { ...v1Track(), clipIds: [clip.id] }]
  if (at === null && (!existing || relays(state, existing, p))) {
    const order = v1Clips(asProject(state))
    const i = afterId ? order.findIndex((c) => c.id === afterId) : -1
    order.splice(i >= 0 ? i + 1 : order.length, 0, clip)
    const after = relayV1({ settings: state.settings, tracks, clips: { ...state.clips, [clip.id]: clip } }, order)
    return patchesFor(was, after)
  }
  const start = at ?? (existing ? endOf(state, existing) : 0)
  const next = placed(clip, start)
  const clips = ripple({ ...state.clips, [next.id]: next }, existing, start + span, lengthOf(next) - span, next.id)
  return patchesFor(was, { ...state, tracks, clips })
}

function endOf(state: State, track: ITrack): number {
  return track.clipIds.reduce((end, id) => Math.max(end, state.clips[id]?.timing.display.to ?? 0), 0)
}

/** See `SlotRenderPayload`. */
export const slotRender: CommandHandler<SlotRenderPayload> = (state, cmd) => {
  const { slotId, clip, trackId, at, span, keepGaps, cut } = cmd.payload
  const p = { keepGaps: !!keepGaps }
  const next = stamped(clip, slotId)
  const old = inSlot(state, slotId)
  if (old) {
    // A continuation made again in its own slot meets its source where the
    // snap put it, exactly as a new one does — same edit, one undo.
    const src = cut ? Object.values(state.clips).find((c) =>
      c.id !== old.id && c.type === 'Video' && c.metadata?.jobId === cut.jobId) : undefined
    const put = src && cut && relays(state, trackOf(state, src.id), p) ? withCutBack(state, src, cut) : state
    return swap(put, old, next, p, state)
  }
  return insert(state, trackId ?? null, null, at ?? null, span ?? 0, next, p)
}

/** See `TakeChoosePayload`. A slot no clip fills is nothing to choose on. */
export const takeChoose: CommandHandler<TakeChoosePayload> = (state, cmd) => {
  const { slotId, clip, keepGaps } = cmd.payload
  const old = inSlot(state, slotId)
  if (!old) return []
  return swap(state, old, stamped(clip, slotId), { keepGaps: !!keepGaps })
}

/**
 * `from` with its out-point moved back to `cut.to` — the point its
 * continuation opens at — or null when there is nothing to move.
 *
 * The server snaps a continuation's out-point *down* onto the latent's 17-frame
 * grid, so the new take opens up to 16 frames before where the source clip's
 * picture stops. Left there, the join plays that stretch of motion twice: once
 * as the source's tail, again as the continuation's head. The source is cut
 * back in the same edit so the two meet where the motion does, and one undo
 * restores both.
 *
 * It is `planTrim`'s arithmetic — frame-snapped, clamped to the file and to the
 * shortest clip a trim may leave, the file's length written down — so a cut
 * made here is the cut the out handle would have made, and undoes and re-trims
 * like one. Nothing moves when:
 *
 * - the clip no longer plays the take that was continued (a different take was
 *   chosen into the slot while this one rendered — its out-point is not the
 *   one the snap was measured against);
 * - the cut is not earlier than the out-point it has (nobody lengthens a clip
 *   on the strength of a continuation);
 * - V1 is holding a gap for a clip whose file would not load: a trim is refused
 *   then (`v1Lock`) for the reason the gap is kept, and this is a trim.
 *
 * A source whose sound was detached keeps it detached; the sound is cut back
 * with the picture only while it still lies exactly under it (`cutSound`).
 */
function cutBack(state: State, from: AnyClip, cut: { jobId: string; to: number }): AnyClip | null {
  if (from.metadata?.jobId !== cut.jobId) return null
  const plan = planTrim(asProject(state), from.id, 'out', cut.to)
  if (refused(plan)) return null
  const trimmed = plan.project.clips[from.id]
  const had = edgeOf(from, 'out')
  return trimmed && edgeOf(trimmed, 'out') < had ? trimmed : null
}

/**
 * `sound` — `from`'s detached sound — cut back to the out-point `cut` gave the
 * picture, or null to leave it.
 *
 * Only while it still plays exactly the stretch the picture did (same display
 * and trim — untouched since the detach). Left long, its tail sounds the
 * frames the continuation replays, which is the double the picture's cut is
 * there to remove. Moved or trimmed on its own, it was placed by hand, and a
 * detached sound is not moved because its picture moved (detach.ts).
 */
function cutSound(from: AnyClip, cut: AnyClip, sound: AnyClip): AnyClip | null {
  const a = sound.timing
  const v = from.timing
  if (!same(a.display, v.display) || !same(a.trim, v.trim)) return null
  const source: unknown = cut.metadata?.source
  return {
    ...sound,
    timing: { ...a, display: { ...cut.timing.display }, ...(cut.timing.trim && { trim: { ...cut.timing.trim } }) },
    metadata: { ...sound.metadata, ...(source !== undefined && { source }) },
  } as AnyClip
}

/** `state` with `from` cut back to where its continuation opens (`cutBack`),
 *  and its detached sound with it while that still lies under it — or
 *  `state` itself when there is nothing to move. */
function withCutBack(state: State, from: AnyClip, cut: { jobId: string; to: number }): State {
  const cutFrom = cutBack(state, from, cut)
  if (!cutFrom) return state
  const sound = soundOf(state, from)
  const cutAudio = sound ? cutSound(from, cutFrom, sound) : null
  return { ...state, clips: { ...state.clips, [from.id]: cutFrom, ...(cutAudio && { [cutAudio.id]: cutAudio }) } }
}

/** See `SlotContinuePayload`. */
export const slotContinue: CommandHandler<SlotContinuePayload> = (state, cmd) => {
  const { fromSlotId, slotId, clip, keepGaps, cut } = cmd.payload
  const p = { keepGaps: !!keepGaps }
  const next = stamped(clip, slotId)
  const from = inSlot(state, fromSlotId)
  const track = from ? trackOf(state, from.id) : null
  if (!from || !track) return insert(state, null, null, null, 0, next, p)
  if (relays(state, track, p)) {
    return insert(cut ? withCutBack(state, from, cut) : state, track.id, from.id, null, 0, next, p, state)
  }
  return insert(state, track.id, null, from.timing.display.to, 0, next, p)
}

/**
 * Teach the engine the three commands. Idempotent — the registry is one map
 * for the page, and registering a type again replaces its handler.
 */
export function registerCommands(engine: Pick<Engine, 'registerCommand'>): void {
  engine.registerCommand(SLOT_RENDER, slotRender)
  engine.registerCommand(TAKE_CHOOSE, takeChoose)
  engine.registerCommand(SLOT_CONTINUE, slotContinue)
}

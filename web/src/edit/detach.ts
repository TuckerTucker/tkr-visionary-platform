/**
 * A take's soundtrack, detached from its picture onto an A track.
 *
 * **Until it is detached, the sound is the Video clip's.** H3 renders picture
 * and sound into one file and the engine plays and exports a Video clip's
 * audio by default, so a take's sound is trimmed, moved, crossfaded and
 * exported with it by construction — there is no second clip to keep in step,
 * which is exactly why nothing here tries to.
 *
 * **Detached, it is its own clip.** OpenVideo has no detach, so detaching is
 * what one would be: an Audio clip playing the same file over the same stretch
 * (the Video's whole `timing` — display, trim, rate and fades, because a fade
 * on the picture was a fade on its sound too) on an A track, and the Video
 * clip made silent. From then on the two are independent: a trim or a move of
 * the Video re-times V1 and leaves the sound where it was put, which is the
 * point of separating them — a line of dialogue laid over the next shot has to
 * stay where it was laid when that shot is trimmed.
 *
 * **Linked, both ways, by `metadata.linkedTo`** — the other clip's id, in the
 * one place the engine's serializers keep. It is a record of where the sound
 * came from, not a constraint: nothing moves one because the other moved.
 *
 * **Silenced twice, because the engine reads silence in two places.** The
 * Compositor builds an export from `audio: false`; the Studio plays a Video
 * through an HTMLVideoElement whose volume reads `muted` and never `audio`.
 * With only `audio: false`, the stage played the take's sound twice — once from
 * the picture and once from the A track — while the export was right.
 *
 * **One command, one undo, and undo re-links.** `clip.detach` is a registered
 * command emitting whole-object patches (see `commands.ts` for why whole): the
 * Audio clip added, the track list, and the Video clip *removed and added again*
 * under the same id rather than updated. The Studio's bridge copies an update's
 * `muted` onto a clip it already holds only when the new value is defined, and
 * the pre-detach clip never had one — so an undo by update left the stage
 * silent with the sound "re-linked". A remove and an add make the bridge build
 * the clip again from the object, the silenced one going forward and the
 * original going back. It is named by its own type, so the history's word for
 * it (`history.ts`) is a lookup rather than a guess.
 *
 * **Where the sound lands.** Onto the A track it was dropped on when that
 * track is free for the take's whole stretch; otherwise — dropped below the
 * last track, or onto an A track with something already playing there — onto
 * a new A track at the bottom, where every sound goes (`drop.ts`). Two sounds
 * overlapping on one lane would draw as one bar over another, and a track is
 * cheap. The keyboard's D asks for the first free A track, else a new one.
 */
import { create } from 'zustand'
import type { AnyClip, CommandHandler, IProject, ITrack, Patch } from '@openvideo/core'

import { failed, type ApiError } from '../api/client'
import { nextTrackName } from './drop'
import { slotOf } from './project'
import { sourceUs } from './cuts'
import { execute, pause, useEdit } from './useEdit'

export const CLIP_DETACH = 'clip.detach'

/** Where a detached sound is asked to go: onto `trackId`, or a new A track. */
export type DetachTarget = { trackId: string } | { track: 'new' }

/**
 * `clip.detach` — `audio` goes onto `onto` (or `newTrack` when that is not a
 * free A track), and the Video clip `videoId` goes silent. `audio` supplies
 * the engine's shape of an Audio clip and its id; its timing is taken from the
 * Video as the command runs, so a trim that landed while it was prepared is
 * the one the sound gets.
 */
export type DetachPayload = { videoId: string; audio: AnyClip; onto: string | null; newTrack: ITrack }

type State = Pick<IProject, 'clips' | 'tracks'>

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const isAudioTrack = (t: ITrack): boolean => t.type.toLowerCase() === 'audio'

/** The id a clip is linked to, or null. */
export function linkedTo(clip: Pick<AnyClip, 'metadata'>): string | null {
  const l: unknown = clip.metadata?.linkedTo
  return typeof l === 'string' && l ? l : null
}

/**
 * Whether `clip` is a take still carrying its own sound — the clips that get a
 * sound strip. A take, because a take is what H3 rendered sound into; a file
 * somebody dropped on V2 may have none, and the engine cannot say which (its
 * metadata read reports size and length, not tracks), so a strip there would
 * be an offer that detaches silence.
 */
export function hasSound(clip: AnyClip): boolean {
  return clip.type === 'Video' && clip.audio !== false && slotOf(clip) !== null
}

/** Whether `track` has nothing playing anywhere in [from, to). */
function freeOver(state: State, track: ITrack, from: number, to: number): boolean {
  return track.clipIds.every((id) => {
    const c = state.clips[id]
    if (!c) return true
    const d = c.timing.display
    return d.to <= from || d.from >= to
  })
}

/** The A track `target` resolves to for `video` — an existing one, or null
 *  for a new one — with the name the timeline will show. */
export function resolveTarget(state: State, video: AnyClip, target: DetachTarget): { trackId: string | null; name: string } {
  const { from, to } = video.timing.display
  const fits = (t: ITrack | undefined): t is ITrack => !!t && isAudioTrack(t) && freeOver(state, t, from, to)
  if ('trackId' in target) {
    const t = state.tracks.find((x) => x.id === target.trackId)
    if (fits(t)) return { trackId: t.id, name: t.name }
  }
  return { trackId: null, name: nextTrackName(state, 'audio') }
}

/** The first A track free across the clip's stretch, or a new one — what D asks for. */
export function firstFree(state: State, video: AnyClip): DetachTarget {
  const { from, to } = video.timing.display
  const t = state.tracks.find((x) => isAudioTrack(x) && freeOver(state, x, from, to))
  return t ? { trackId: t.id } : { track: 'new' }
}

/** See `DetachPayload`. Pure: reads nothing but its arguments. */
export const clipDetach: CommandHandler<DetachPayload> = (state, cmd) => {
  const { videoId, audio, onto, newTrack } = cmd.payload
  const video = state.clips[videoId]
  // Gone, or already silent: nothing to detach, and an entry that did nothing
  // would be an undo that does nothing.
  if (!video || !hasSound(video) || state.clips[audio.id]) return []

  const silent = {
    ...video,
    audio: false,
    muted: true,
    metadata: { ...video.metadata, linkedTo: audio.id },
  } as AnyClip
  const meta = isObj(video.metadata) ? video.metadata : {}
  const sound = {
    ...audio,
    type: 'Audio',
    src: video.src,
    timing: { ...video.timing },
    // The take's ids, so the timeline draws its sentence on the sound too —
    // and never its slot id: a slot is found by the clip carrying it, and two
    // would make the slot's controls act on whichever came first.
    metadata: {
      ...(typeof meta.jobId === 'string' && { jobId: meta.jobId }),
      ...(typeof meta.file === 'string' && { file: meta.file }),
      linkedTo: video.id,
    },
  } as AnyClip

  const target = onto ? state.tracks.find((t) => t.id === onto) : undefined
  const { from, to } = video.timing.display
  const tracks = target && isAudioTrack(target) && freeOver(state, target, from, to)
    ? state.tracks.map((t) => (t.id === target.id ? { ...t, clipIds: [...t.clipIds, sound.id] } : t))
    // Sound goes to the end of the stack — the bottom of the timeline, where
    // it composites nothing (drop.ts).
    : [...state.tracks, { ...newTrack, clipIds: [sound.id] }]

  const patches: Patch[] = [
    { op: 'remove', path: `/clips/${video.id}`, oldValue: video },
    { op: 'add', path: `/clips/${video.id}`, value: silent },
    { op: 'add', path: `/clips/${sound.id}`, value: sound },
    { op: 'update', path: '/tracks', value: tracks, oldValue: state.tracks },
  ]
  return patches
}

/** Teach the engine `clip.detach`. Idempotent — see `Engine.registerCommand`. */
function ensureRegistered(): boolean {
  const engine = useEdit.getState().engine
  if (!engine) return false
  if (!engine.hasCommand(CLIP_DETACH)) engine.registerCommand(CLIP_DETACH, clipDetach as CommandHandler)
  return true
}

const hex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))]
  .map((n) => n.toString(16).padStart(2, '0')).join('')

/** What a detach resolved to: the sound clip and the track it is on. */
export type Detached = { clipId: string; trackId: string }

/**
 * Detach the sound of take clip `videoId` onto `target`. Resolves to the new
 * Audio clip and its track, or a sentence saying why not; never rejects.
 */
export async function detachSound(videoId: string, target: DetachTarget): Promise<Detached | ApiError> {
  const core = useEdit.getState().core
  if (!core) return { error: 'The cut is still opening — detach the sound once it shows.' }
  const video = core.store.getState().clips[videoId]
  if (!video || !hasSound(video)) return { error: 'That clip has no attached sound to detach.' }
  if (!ensureRegistered()) return { error: 'The editor is still loading — detach the sound once it shows.' }

  let audio: AnyClip
  try {
    // The engine's own shape of an Audio clip. `timing.duration` is given so
    // the reader does not fetch the file to learn a length the Video already
    // knows; the command replaces the timing with the Video's anyway.
    audio = await core.clip.prepare({
      type: 'Audio',
      name: `${video.name} · sound`,
      src: video.src as string,
      timing: { duration: sourceUs(video) },
    })
  } catch (e) {
    return {
      error: `The editor could not read the sound of ${String(video.metadata?.file ?? video.name)}, so it is still attached.`,
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }
  }
  if (useEdit.getState().core !== core) return { error: 'The scene closed before the sound could be detached.' }

  const state = core.store.getState()
  const now = state.clips[videoId]
  if (!now || !hasSound(now)) return { error: 'That clip has no attached sound to detach.' }
  const { trackId } = resolveTarget(state, now, target)
  const newTrack: ITrack = {
    id: `trk_audio_${hex(4)}`,
    name: nextTrackName(state, 'audio'),
    type: 'audio',
    clipIds: [],
    accepts: ['audio'],
  }
  pause()
  const payload: DetachPayload = { videoId, audio, onto: trackId, newTrack }
  if (!execute({ type: CLIP_DETACH, payload })) {
    return { error: 'The scene closed before the sound could be detached.' }
  }
  const after = core.store.getState()
  const on = after.tracks.find((t) => t.clipIds.includes(audio.id))
  if (!on) return { error: 'The sound could not be detached — the clip changed while it was being read.' }
  return { clipId: audio.id, trackId: on.id }
}

/**
 * Where a sound strip let go at (x, y) would go, read off the page: an A lane
 * under the pointer, or the drop strip / the space below the last lane for a
 * new A track. Null over a picture lane or off the timeline, which cancels.
 */
export function targetAtPoint(x: number, y: number): DetachTarget | null {
  const under = document.elementsFromPoint(x, y)
  for (const el of under) {
    const lane = el.closest<HTMLElement>('.et-lane[data-track]')
    if (lane) return lane.classList.contains('audio') ? { trackId: lane.dataset.track ?? '' } : null
    if (el.closest('#edit-drop')) return { track: 'new' }
  }
  const body = document.querySelector<HTMLElement>('#edit-tracks .et-body')
  const lanes = body?.querySelectorAll<HTMLElement>('.et-lane')
  const last = lanes?.[lanes.length - 1]
  if (body && last) {
    const b = body.getBoundingClientRect()
    if (x >= b.left && x <= b.right && y > last.getBoundingClientRect().bottom && y <= b.bottom + 48) {
      return { track: 'new' }
    }
  }
  return null
}

/* ---- what the clip shows ------------------------------------------------ */

/** The last detach that did not happen, on the clip it was for, until the next
 *  one or a dismissal. */
export const useDetach = create<{ failed: { clipId: string; err: ApiError } | null }>(() => ({ failed: null }))

/** `detachSound`, with its refusal put on the clip rather than returned. */
export async function detachFromClip(videoId: string, target: DetachTarget): Promise<void> {
  const r = await detachSound(videoId, target)
  useDetach.setState({ failed: failed(r) ? { clipId: videoId, err: r } : null })
}

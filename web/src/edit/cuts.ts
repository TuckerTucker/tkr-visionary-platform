/**
 * The cut, as arithmetic: trims, order and crossfades on V1, planned as the
 * Core commands that make them.
 *
 * Pure, like `project.ts`: every function here takes the drawn IProject and
 * returns a `Plan` — the arrangement it would produce, and the commands that
 * produce it — or a `Refusal` saying why not. Nothing touches a Core. The
 * timeline draws `plan.project` while a hand is still on a handle and runs
 * `plan.commands` as one `batch` when it lets go, so a gesture is one undo entry
 * however many clips it moved, and what was drawn under the pointer is exactly
 * what gets committed.
 *
 * **V1 stays gapless.** Every plan ends in `arrange`, which lays V1's clips end
 * to end from where the first one starts. A trim or a move therefore ripples
 * everything after it — there is no gap to close and no overlap to resolve,
 * because neither can be expressed.
 *
 * **Cuts are hard until somebody gives one a crossfade.** Nothing here adds a
 * transition on its own: not on append, not on a reorder, and not on a join
 * made by Continue — that one is seamless already, because the pinned context
 * is cut off at decode, and a default dissolve there would overlap picture and
 * sound that already continue. (A take does not record that it was continued —
 * `SceneTake` has no `continue_from` — so "not by default, anywhere" is also the
 * only rule that can be kept without guessing which joins those are.)
 *
 * **A crossfade is OpenVideo's own Transition clip** — `transitionKey: 'fade'`,
 * the catalog's plain cross-dissolve — sitting on V1, centred on the cut, so the
 * Studio previews it and the Compositor exports it without anything of ours in
 * between. Two engine facts shape how it is written, both read from 1.4.0:
 * - The Studio's bridge builds its transition from a *top-level* `duration`,
 *   falling back to two seconds, and Core's `normalizeClip` deletes top-level
 *   `duration` from every clip it stores. So a new crossfade is followed, in the
 *   same batch, by a `clip.update` carrying its `timing` — the bridge copies
 *   timing on an update, never on an add — or the preview dissolves for two
 *   seconds while the saved clip and the export say half a second. (A stage
 *   that remounts, or an undo that re-adds one, meets the same default with no
 *   update behind it; `Stage` holds the Studio to the Core for those.)
 * - Neither side overlaps the clips: the outgoing picture holds its last frame
 *   through the second half and the incoming one holds its first frame through
 *   the first. So the dissolve is kept short and never longer than either clip.
 */
import type { AnyClip, IProject, ITrack, ITransitionClip } from '@openvideo/core'

import { clipsOn, v1 } from './project'
import type { EditCommand } from './useEdit'

/** The catalog's plain cross-dissolve (`TRANSITION_CATALOG`, category "fade"):
 *  "the outgoing scene fades out while the incoming scene fades in". */
export const CROSSFADE_KEY = 'fade'

/** Half a second at H3's 24fps. Short because the engine freezes the frames on
 *  either side of the cut for the dissolve's length (see above) — a two-second
 *  default is a second of held frame on each side of every cut it is put on. */
const CROSSFADE_FRAMES = 12

/**
 * The shortest a trim may leave a clip, in frames.
 *
 * Half a second at 24fps is 15px at the timeline's scale — about the width of
 * the clip's own two trim handles. Shorter, and the bar is narrower than what
 * you would grab it by, so a trim could make a clip nobody can trim back out.
 */
const MIN_FRAMES = 12

/** One frame of the project, in µs. */
export function frameUs(project: Pick<IProject, 'settings'>): number {
  const fps = project.settings.fps
  return 1_000_000 / (fps > 0 ? fps : 24)
}

export type Plan = {
  /** The arrangement once the commands have run, as the timeline draws it. */
  project: IProject
  /** One gesture's commands, for one `batch`. Empty when nothing changes. */
  commands: EditCommand[]
  /** Where the playhead should go to show what was done, in µs. */
  at?: number
}

/** Why a gesture cannot be made, as a sentence for the control it is on. */
export type Refusal = { reason: string }

export const refused = (p: Plan | Refusal): p is Refusal => 'reason' in p

const isTransition = (c: AnyClip): c is ITransitionClip => c.type === 'Transition'

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const len = (c: AnyClip): number => c.timing.display.to - c.timing.display.from

/** V1's picture clips in time order — everything on it but its transitions. */
export function v1Clips(project: IProject): AnyClip[] {
  const track = v1(project)
  return track ? clipsOn(project, track).filter((c) => !isTransition(c)) : []
}

/** A track's transitions. */
export function transitionsOn(project: IProject, track: ITrack): ITransitionClip[] {
  return clipsOn(project, track).filter(isTransition)
}

/** One join between two V1 clips that touch, and its crossfade if it has one. */
export type Cut = { at: number; from: AnyClip; to: AnyClip; fade: ITransitionClip | null }

/**
 * Every cut on V1. Two clips cut where one ends and the next begins; a gap
 * (a project saved by something that is not this page) is not a cut and gets
 * no control until the next edit closes it.
 */
export function cutsOf(project: IProject): Cut[] {
  const track = v1(project)
  if (!track) return []
  const clips = v1Clips(project)
  const fades = transitionsOn(project, track)
  const slack = frameUs(project) / 2
  const cuts: Cut[] = []
  for (let i = 1; i < clips.length; i++) {
    const a = clips[i - 1]!
    const b = clips[i]!
    if (Math.abs(a.timing.display.to - b.timing.display.from) > slack) continue
    cuts.push({
      at: b.timing.display.from,
      from: a,
      to: b,
      fade: fades.find((t) => t.fromClipId === a.id && t.toClipId === b.id) ?? null,
    })
  }
  return cuts
}

/* ---- the source a clip plays from --------------------------------------- */

/** Where a clip's file lives, host dropped — `rebase` moves the host, and the
 *  file it names is the same one. */
function srcPath(clip: AnyClip): string | null {
  if (typeof clip.src !== 'string' || !clip.src) return null
  try {
    return new URL(clip.src, 'http://visionary.invalid').pathname
  } catch {
    return null
  }
}

/** Clips a trim applies to: ones with a file that has a length of its own. */
export function trimmable(clip: AnyClip): boolean {
  return (clip.type === 'Video' || clip.type === 'Audio') && srcPath(clip) !== null
}

/**
 * How long the clip's file is, in source µs — the furthest its out point may go.
 *
 * The engine does not keep this: `timing.duration` is the *trimmed* length and
 * `trim.to` is wherever the out point sits. Untrimmed, `trim.to` is the file's
 * end (the engine's `loadClip` reads it off the file), so the first trim writes
 * that into `metadata.source` beside the path it measured — metadata is the one
 * place the engine's serializers keep — and every later trim reads it back. A
 * clip whose file has since changed under it (a different take chosen into the
 * slot) no longer matches the path and falls back to its own, untrimmed, end.
 */
export function sourceUs(clip: AnyClip): number {
  const m: unknown = clip.metadata?.source
  if (isObj(m) && typeof m.us === 'number' && m.us > 0 && m.path === srcPath(clip)) return m.us
  const t = clip.timing
  return Math.max(t.trim?.to ?? 0, t.duration)
}

/* ---- laying V1 out ------------------------------------------------------ */

/** A crossfade's length at a cut: the default, but never longer than either
 *  clip it joins, so its half on each side stays inside that clip. */
function fadeLength(project: Pick<IProject, 'settings'>, a: AnyClip, b: AnyClip): number {
  return Math.round(Math.min(CROSSFADE_FRAMES * frameUs(project), len(a), len(b)))
}

/** The Transition clip for a cut, centred on it. */
function placeFade(fade: ITransitionClip, at: number, d: number): ITransitionClip {
  const from = at - Math.round(d / 2)
  return {
    ...fade,
    timing: { ...fade.timing, display: { from, to: from + d }, trim: { from: 0, to: 0 }, duration: d, playbackRate: 1 },
  }
}

/**
 * `project` with V1 laid out as `order`: end to end from where V1 starts now,
 * each clip keeping its own length. Crossfades whose two clips still meet are
 * re-centred on their cut; one whose clips no longer meet has no cut to be on
 * and goes. V1's clip list follows the new order, so what the engine reads
 * top to bottom is what plays left to right.
 */
function arrange(project: IProject, order: readonly AnyClip[]): IProject {
  const track = v1(project)
  if (!track) return project
  const start = v1Clips(project)[0]?.timing.display.from ?? 0
  const clips: Record<string, AnyClip> = { ...project.clips }
  let at = start
  for (const c of order) {
    const l = len(c)
    clips[c.id] = { ...c, timing: { ...c.timing, display: { from: at, to: at + l } } } as AnyClip
    at += l
  }
  const index = new Map(order.map((c, i) => [c.id, i]))
  const kept: string[] = []
  for (const t of transitionsOn(project, track)) {
    const i = t.fromClipId ? index.get(t.fromClipId) : undefined
    const j = t.toClipId ? index.get(t.toClipId) : undefined
    if (i === undefined || j !== i + 1) {
      delete clips[t.id]
      continue
    }
    const a = clips[order[i]!.id]!
    const b = clips[order[j]!.id]!
    clips[t.id] = placeFade(t, b.timing.display.from, fadeLength(project, a, b))
    kept.push(t.id)
  }
  // Anything else on V1 that is neither a clip in `order` nor a transition
  // (nothing today) keeps its place in the list rather than vanishing from it.
  const others = track.clipIds.filter((id) => !index.has(id) && !(project.clips[id] && isTransition(project.clips[id]!)))
  const clipIds = [...order.map((c) => c.id), ...kept, ...others]
  return {
    ...project,
    clips,
    tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clipIds } : t)),
  }
}

/**
 * `project` with V1 laid out as a trim would leave it — gapless from where it
 * starts, in `order` (time order when omitted), each crossfade re-centred on
 * its cut and one whose clips no longer meet gone.
 *
 * For commands outside this file that change what V1 holds: a take swapped
 * into a slot is a clip of a new length, and a continuation is a clip between
 * two others. Rippling only the clips moved the pictures and left each
 * crossfade on the cut where it used to be — a dissolve between the wrong two
 * frames, or over the middle of a take.
 */
export function relayV1(project: IProject, order?: readonly AnyClip[]): IProject {
  return arrange(project, order ?? v1Clips(project))
}

/* ---- from one arrangement to the next, as commands ---------------------- */

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The commands that turn `before` into `after`, in the order the Studio's
 * bridge needs them: removals, then updates (so the clips a new crossfade joins
 * are already where they end up), then additions — each new Transition followed
 * by the `clip.update` that hands the bridge its timing (see the top of this
 * file) — and V1's clip order last.
 */
export function commandsFor(before: IProject, after: IProject): EditCommand[] {
  const cmds: EditCommand[] = []
  const gone = Object.keys(before.clips).filter((id) => !after.clips[id])
  if (gone.length) cmds.push({ type: 'clip.remove', payload: { ids: gone } })

  const updates: Array<{ id: string; updates: Partial<AnyClip> }> = []
  for (const [id, next] of Object.entries(after.clips)) {
    const prev = before.clips[id]
    if (!prev || same(prev, next)) continue
    const u: Partial<AnyClip> = {}
    if (!same(prev.timing, next.timing)) u.timing = next.timing
    if (!same(prev.metadata, next.metadata)) u.metadata = next.metadata
    if (Object.keys(u).length) updates.push({ id, updates: u })
  }
  if (updates.length) cmds.push({ type: 'clip.update', payload: updates })

  for (const [id, clip] of Object.entries(after.clips)) {
    if (before.clips[id]) continue
    const track = after.tracks.find((t) => t.clipIds.includes(id))
    cmds.push({ type: 'clip.add', payload: { clip, trackId: track?.id } })
    if (clip.type === 'Transition') {
      cmds.push({ type: 'clip.update', payload: { id, updates: { timing: clip.timing } } })
    }
  }

  for (const t of after.tracks) {
    const was = before.tracks.find((x) => x.id === t.id)
    if (!was) continue
    // Compared as the list the handlers above leave behind: `clip.remove`
    // drops removed ids and `clip.add` appends new ones, so only an order
    // they would not produce needs saying.
    const left = was.clipIds.filter((id) => !gone.includes(id))
    const expected = [...left, ...t.clipIds.filter((id) => !left.includes(id))]
    if (!same(expected, t.clipIds)) {
      cmds.push({ type: 'track.update', payload: { id: t.id, updates: { clipIds: t.clipIds } } })
    }
  }
  return cmds
}

const plan = (before: IProject, after: IProject, at?: number): Plan =>
  ({ project: after, commands: commandsFor(before, after), at })

/* ---- the gestures ------------------------------------------------------- */

/**
 * Why V1 cannot be re-timed right now, or null when it can.
 *
 * A clip whose file did not load is held outside the Core (`useEdit`'s parked
 * clips) and written back at the place it sat. Commands cannot move it, so a
 * ripple would slide every playable clip past a clip that stays put — two clips
 * drawn in one place, and a saved arrangement with the missing take in the
 * wrong spot when it comes back.
 */
export function v1Lock(project: IProject | null, parked: ReadonlyArray<{ clip: AnyClip; trackId: string }>): string | null {
  if (!project) return 'The cut is still opening.'
  const track = v1(project)
  const held = parked.find((p) => p.trackId === track?.id)
  if (!held) return null
  const file = typeof held.clip.metadata?.file === 'string' ? held.clip.metadata.file : held.clip.name
  const job = typeof held.clip.metadata?.jobId === 'string' ? ` (take ${held.clip.metadata.jobId})` : ''
  return `${file}${job} did not load, so V1 cannot be re-timed until it does — commands cannot move `
    + 'a clip that is not in the editor, and the clips around it would slide over its place.'
}

export type Edge = 'in' | 'out'

/**
 * Move one edge of a clip to `sourceTime` (µs into its file), ripple V1.
 *
 * The edge snaps to the project's frames and stops at the file's ends and at
 * `MIN_FRAMES` from the other edge — a trim past the source is not a request
 * this can be handed, because the value is clamped before anything is planned.
 * The playhead goes to the frame the edit exposed: the new first frame for an
 * in point, the new last frame for an out point.
 */
export function planTrim(project: IProject, clipId: string, edge: Edge, sourceTime: number): Plan | Refusal {
  const order = v1Clips(project)
  const i = order.findIndex((c) => c.id === clipId)
  const clip = order[i]
  if (!clip) return { reason: 'That clip is not on V1.' }
  if (!trimmable(clip)) return { reason: `${clip.name} has no file of its own to trim.` }
  const f = frameUs(project)
  const rate = clip.timing.playbackRate && clip.timing.playbackRate > 0 ? clip.timing.playbackRate : 1
  const src = sourceUs(clip)
  const trim = { from: clip.timing.trim?.from ?? 0, to: clip.timing.trim?.to ?? src }
  const least = Math.min(MIN_FRAMES * f * rate, src)
  const snap = (x: number): number => Math.round(Math.round(x / f) * f)
  const next = { ...trim }
  if (edge === 'in') next.from = Math.max(0, Math.min(trim.to - least, snap(sourceTime)))
  else next.to = Math.min(src, Math.max(trim.from + least, snap(sourceTime)))
  next.from = Math.max(0, Math.round(next.from))
  next.to = Math.round(next.to)
  const shown = Math.round((next.to - next.from) / rate)
  const trimmed = {
    ...clip,
    metadata: { ...(clip.metadata ?? {}), source: { path: srcPath(clip), us: src } },
    timing: {
      ...clip.timing,
      trim: next,
      duration: next.to - next.from,
      display: { from: clip.timing.display.from, to: clip.timing.display.from + shown },
    },
  } as AnyClip
  const after = arrange(project, order.map((c) => (c.id === clipId ? trimmed : c)))
  const placed = after.clips[clipId]!
  const at = edge === 'in' ? placed.timing.display.from : Math.max(placed.timing.display.from, placed.timing.display.to - f)
  if (next.from === trim.from && next.to === trim.to) return { project, commands: [], at }
  return plan(project, after, Math.round(at))
}

/** The in or out point a clip has now, in source µs. */
export function edgeOf(clip: AnyClip, edge: Edge): number {
  return edge === 'in' ? clip.timing.trim?.from ?? 0 : clip.timing.trim?.to ?? sourceUs(clip)
}

/**
 * Put a V1 clip at `toIndex` in V1's order (counted without it), ripple V1.
 * Crossfades whose two clips no longer meet go with the move — the cut they
 * were on no longer exists — and come back with its undo.
 */
export function planMove(project: IProject, clipId: string, toIndex: number): Plan | Refusal {
  const order = v1Clips(project)
  const clip = order.find((c) => c.id === clipId)
  if (!clip) return { reason: 'That clip is not on V1.' }
  const rest = order.filter((c) => c.id !== clipId)
  const at = Math.max(0, Math.min(rest.length, Math.round(toIndex)))
  const next = [...rest.slice(0, at), clip, ...rest.slice(at)]
  if (next.every((c, i) => c.id === order[i]!.id)) return { project, commands: [] }
  return plan(project, arrange(project, next))
}

/**
 * The index a clip being dragged would land at, with its left edge at `left`
 * µs: past every other clip whose middle it has crossed. The others are laid
 * end to end as they would be without it, so the answer does not depend on
 * where the dragged clip used to sit.
 */
export function dropIndex(project: IProject, clipId: string, left: number): number {
  const order = v1Clips(project)
  const clip = order.find((c) => c.id === clipId)
  if (!clip) return 0
  const mid = left + len(clip) / 2
  let at = order[0]?.timing.display.from ?? 0
  let n = 0
  for (const c of order) {
    if (c.id === clipId) continue
    if (mid > at + len(c) / 2) n += 1
    at += len(c)
  }
  return n
}

/**
 * Give the cut between `fromId` and `toId` a crossfade, or take it away. The
 * two must meet on V1 — a crossfade is a property of a cut, and there is no
 * cut between clips that do not touch.
 */
export function planCrossfade(project: IProject, fromId: string, toId: string, on: boolean): Plan | Refusal {
  const cut = cutsOf(project).find((c) => c.from.id === fromId && c.to.id === toId)
  if (!cut) return { reason: 'Those two clips do not meet on V1, so there is no cut between them.' }
  if (!!cut.fade === on) return { project, commands: [], at: cut.at }
  const track = v1(project)!
  if (!on) {
    const fade = cut.fade!
    const clips = { ...project.clips }
    delete clips[fade.id]
    const after = {
      ...project,
      clips,
      tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clipIds: t.clipIds.filter((id) => id !== fade.id) } : t)),
    }
    return plan(project, after, cut.at)
  }
  const d = fadeLength(project, cut.from, cut.to)
  const fade = placeFade({
    id: crypto.randomUUID(),
    type: 'Transition',
    name: 'Crossfade',
    transitionKey: CROSSFADE_KEY,
    fromClipId: fromId,
    toClipId: toId,
    timing: { display: { from: 0, to: 0 }, duration: 0 },
    transform: { x: 0, y: 0, width: project.settings.width, height: project.settings.height, angle: 0, zIndex: 10, opacity: 1 },
  }, cut.at, d)
  const after = {
    ...project,
    clips: { ...project.clips, [fade.id]: fade },
    tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, clipIds: [...t.clipIds, fade.id] } : t)),
  }
  // From the start of the dissolve, so what the monitor shows is it running.
  return plan(project, after, fade.timing.display.from)
}

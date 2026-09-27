/**
 * The arrangement, as arithmetic.
 *
 * Pure functions over OpenVideo's IProject: nothing here touches a Core, a
 * Studio, the network or the DOM, so every rule about where a take lands can be
 * read — and later tested — without an engine. `useEdit` is the only caller
 * that turns their answers into commands.
 *
 * The types come in by `import type`, which `verbatimModuleSyntax` erases: this
 * module is on the first-load path (App → useEdit → here), and a value import of
 * `@openvideo/core` from it would put the 3.4 MB engine in the entry chunk.
 *
 * **Our ids live in `clip.metadata`.** The engine's serializers keep
 * `metadata` and drop other top-level fields they do not model, so a slot id
 * written anywhere else would survive the first save and vanish on the first
 * import. Every take clip carries `{slotId, jobId, file}` there.
 */
import type { AddClipPayload, AnyClip, IProject, IProjectSettings, ITrack } from '@openvideo/core'

import { fileUrl } from '../api/routes'
import type { SceneTake } from '../store'
import { absoluteUrl } from './engine'

/** V1's track id. Named rather than found by position: OpenVideo's first track
 *  is the *top* of the compositing stack, so "the first video track" moves the
 *  moment an overlay is dropped above the picture, and a take appended to
 *  whatever sits first would land on the overlay. */
export const V1_ID = 'v1'

/** H3's frame rate (`H3_FPS` in app.py). The fallback only — a take that
 *  reported its own fps sets the project's. */
const DEFAULT_FPS = 24

/** What a take clip carries in `metadata`. */
export type TakeMeta = { slotId: string; jobId: string; file: string }

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/** The slot a clip fills, or null for a clip that is not a take (a dropped
 *  file, a title, a transition). */
export function slotOf(clip: Pick<AnyClip, 'metadata'>): string | null {
  const s = clip.metadata?.slotId
  return typeof s === 'string' && s ? s : null
}

/** The take a clip plays, by the `(jobId, file)` its metadata names. */
export function takeOf(clip: Pick<AnyClip, 'metadata'>, takes: readonly SceneTake[]): SceneTake | null {
  const m = clip.metadata
  if (!m) return null
  return takes.find((t) => t.jobId === m.jobId && t.file === m.file) ?? null
}

/**
 * A fresh slot id no clip in `project` already uses: `slt` + base-36 time + 4
 * hex, the scene id's shape at a finer grain.
 *
 * Minted by the page, because a slot is addressed (by `intent.slots`, by undo,
 * by a render in flight) from the moment it exists — an id the page had to ask
 * for would be a slot nothing can point at while the answer is out.
 */
export function mintSlotId(project: Pick<IProject, 'clips'> | null, now: number = Date.now()): string {
  const used = new Set(Object.values(project?.clips ?? {}).map(slotOf))
  for (;;) {
    const hex = [...crypto.getRandomValues(new Uint8Array(2))]
      .map((n) => n.toString(16).padStart(2, '0')).join('')
    const id = `slt${now.toString(36)}${hex}`
    if (!used.has(id)) return id
  }
}

/** V1 as an empty track. `accepts` names what may sit on the picture's base
 *  layer; audio has its own tracks. */
export function v1Track(): ITrack {
  return { id: V1_ID, name: 'V1', type: 'video', clipIds: [], accepts: ['video', 'image'] }
}

const isVisual = (t: ITrack): boolean => t.type.toLowerCase() !== 'audio'

/**
 * V1: the track with V1's id, or — for a project that never had one — the
 * bottom of the picture stack, which is the last visual track because the
 * engine composites the first one on top.
 */
export function v1(project: Pick<IProject, 'tracks'>): ITrack | null {
  const named = project.tracks.find((t) => t.id === V1_ID)
  if (named) return named
  const visual = project.tracks.filter((t) => t.type.toLowerCase() === 'video')
  return visual[visual.length - 1] ?? null
}

/** A track's clips in time order. Ids the clips map does not hold are skipped
 *  rather than thrown on: a track pointing at nothing is a stale id, and the
 *  timeline should still draw everything that is there. */
export function clipsOn(project: Pick<IProject, 'clips'>, track: ITrack): AnyClip[] {
  return track.clipIds
    .map((id) => project.clips[id])
    .filter((c): c is AnyClip => !!c)
    .sort((a, b) => a.timing.display.from - b.timing.display.from)
}

/** Where a track's last clip ends, in µs; zero for an empty track. */
export function trackEnd(project: Pick<IProject, 'clips'>, track: ITrack): number {
  return clipsOn(project, track).reduce((end, c) => Math.max(end, c.timing.display.to), 0)
}

/** Where the cut ends, in µs — the latest end on any track. */
export function projectEnd(project: Pick<IProject, 'clips'>): number {
  return Object.values(project.clips).reduce((end, c) => Math.max(end, c.timing.display.to), 0)
}

/**
 * The order the timeline draws tracks in, top to bottom: the picture tracks
 * with V1 first, then the audio tracks.
 *
 * The engine's order is compositing order — first on top — so the picture
 * tracks are reversed to put the base layer first and each overlay below the
 * one it covers. That is what makes "drop below the last track" mean "over the
 * picture" for a picture and "under the picture" for sound, with no button.
 */
export function displayOrder(project: Pick<IProject, 'tracks'>): ITrack[] {
  const visual = project.tracks.filter(isVisual).reverse()
  const audio = project.tracks.filter((t) => !isVisual(t))
  return [...visual, ...audio]
}

/** The absolute URL of a take's file. Absolute because the engine rewrites a
 *  leading `/` to `media-file://` — see `absoluteUrl`. */
export function takeSrc(take: Pick<SceneTake, 'jobId' | 'file'>): string {
  return absoluteUrl(fileUrl(take.jobId, take.file))
}

/**
 * What to hand `core.clip.prepare` for a take: the file and our ids, and
 * nothing about time. The engine reads the file's own length and size, which is
 * the trim this slice promises — the delivered frames, because the file *is*
 * the delivered take (a continued take's pinned head is cut at decode, before
 * the file is written).
 */
export function takePayload(take: SceneTake, slotId: string): AddClipPayload {
  const metadata: TakeMeta = { slotId, jobId: take.jobId, file: take.file }
  return { type: 'Video', name: `${take.jobId}/${take.file}`, src: takeSrc(take), metadata }
}

/** `clip`, moved so it starts where V1 ends. Its length is untouched. */
export function atEndOfV1(project: Pick<IProject, 'tracks' | 'clips'>, clip: AnyClip): AnyClip {
  const track = v1(project)
  const from = track ? trackEnd(project, track) : 0
  const length = clip.timing.display.to - clip.timing.display.from
  return { ...clip, timing: { ...clip.timing, display: { from, to: from + length } } }
}

/**
 * The project with `clip` appended to V1 — at the end of the cut, so takes
 * rendered by Continue go on in the order they were made. V1 is created if the
 * project has none.
 */
export function appendTake(project: IProject, clip: AnyClip): IProject {
  const tracks = v1(project) ? project.tracks : [...project.tracks, v1Track()]
  const withTrack = { ...project, tracks }
  const placed = atEndOfV1(withTrack, clip)
  const target = v1(withTrack)!
  return {
    ...project,
    tracks: tracks.map((t) => (t.id === target.id ? { ...t, clipIds: [...t.clipIds, placed.id] } : t)),
    clips: { ...project.clips, [placed.id]: placed },
  }
}

/** The frame a set of takes wants: the first one's size, else 720p; its fps,
 *  else H3's. `duration` is recomputed by the engine from the clips. */
export function settingsFor(size: { width?: number; height?: number; fps?: number } | null): IProjectSettings {
  return {
    width: size?.width || 1280,
    height: size?.height || 720,
    fps: size?.fps || DEFAULT_FPS,
    duration: 0,
  }
}

/** An empty arrangement: V1 and nothing on it. */
export function emptyProject(settings: IProjectSettings): IProject {
  return { settings, tracks: [v1Track()], clips: {} }
}

/**
 * An IProject off disk, or a sentence saying why it is not one.
 *
 * The check is the shape `core.project.import` itself refuses — no `tracks`
 * and no `clips` — plus the two containers being the right kind, because the
 * engine iterates both and a string where an array belongs is a throw from
 * inside it. Everything else is the engine's to read: a validator here would
 * have to move in lockstep with an engine it does not run.
 */
export function readProject(x: unknown): IProject | string {
  if (!isObj(x)) return 'the saved arrangement is not an object'
  if (!Array.isArray(x.tracks)) return 'the saved arrangement has no track list'
  if (!isObj(x.clips)) return 'the saved arrangement has no clip map'
  return x as unknown as IProject
}

/**
 * The project with every same-app media URL pointed at this page's origin.
 *
 * Sources are stored absolute, because the engine turns a leading `/` into
 * `media-file://` (see `absoluteUrl`) — which writes the origin the page was
 * served from into project.json. Opened from anywhere else (the dev server, a
 * renamed deployment, the preview on another port) those URLs are another
 * origin's: the CSP refuses them, and every clip fails to load while the files
 * sit on the volume. A path under `/api/` is ours whatever host it names, so it
 * is re-rooted here on the way in and the stored arrangement stays portable.
 */
export function rebase(project: IProject): IProject {
  let changed = false
  const clips: Record<string, AnyClip> = {}
  for (const [id, c] of Object.entries(project.clips)) {
    let src = c.src
    if (typeof src === 'string' && src) {
      try {
        const u = new URL(src, window.location.origin)
        if (u.pathname.startsWith('/api/')) {
          const here = absoluteUrl(u.pathname + u.search)
          if (here !== src) { src = here; changed = true }
        }
      } catch {
        // Not a URL at all: the engine will say so about this clip alone.
      }
    }
    clips[id] = src === c.src ? c : ({ ...c, src } as AnyClip)
  }
  return changed ? { ...project, clips } : project
}

/** Every media URL the project plays — what the engine's file cache is
 *  allowed to keep. */
export function mediaSrcs(project: Pick<IProject, 'clips'>): string[] {
  return Object.values(project.clips)
    .map((c) => c.src)
    .filter((s): s is string => typeof s === 'string' && s !== '')
}

/**
 * A clip the page is holding outside the Core, and where it sat.
 *
 * A clip whose file will not load cannot be handed to the Studio: its bridge
 * adds clips one by one and stops at the first that throws, so one missing take
 * would silence every clip after it. So it is parked — kept here, drawn on the
 * timeline with its failure, and written back into every save — and the Core
 * holds the rest, which is what keeps the rest of the cut playing.
 */
export type Parked = { clip: AnyClip; trackId: string; index: number }

/** `project` with the parked clips put back where they sat — what is saved and
 *  what the timeline draws. */
export function withParked(project: IProject, parked: readonly Parked[]): IProject {
  if (!parked.length) return project
  let tracks = project.tracks
  const clips = { ...project.clips }
  for (const p of parked) {
    clips[p.clip.id] = p.clip
    if (!tracks.some((t) => t.id === p.trackId)) {
      tracks = [...tracks, p.trackId === V1_ID ? v1Track() : { ...v1Track(), id: p.trackId, name: p.trackId }]
    }
    tracks = tracks.map((t) => {
      if (t.id !== p.trackId || t.clipIds.includes(p.clip.id)) return t
      const ids = [...t.clipIds]
      ids.splice(Math.min(p.index, ids.length), 0, p.clip.id)
      return { ...t, clipIds: ids }
    })
  }
  return { ...project, tracks, clips }
}

/** Split a project into what the Core can play and what has to be parked,
 *  given the ids of clips whose files did not load. */
export function park(project: IProject, broken: ReadonlySet<string>): { playable: IProject; parked: Parked[] } {
  if (!broken.size) return { playable: project, parked: [] }
  const parked: Parked[] = []
  for (const t of project.tracks) {
    t.clipIds.forEach((id, index) => {
      const clip = project.clips[id]
      if (clip && broken.has(id)) parked.push({ clip, trackId: t.id, index })
    })
  }
  const clips = { ...project.clips }
  for (const id of broken) delete clips[id]
  return {
    playable: {
      ...project,
      clips,
      tracks: project.tracks.map((t) => ({ ...t, clipIds: t.clipIds.filter((id) => !broken.has(id)) })),
    },
    parked,
  }
}

/**
 * The open scene's arrangement: one Core, and the one place commands run.
 *
 * **The seam later work plugs into.** Everything that changes the cut — a trim,
 * a reorder, a crossfade, a render as an edit, an undo — goes through
 * `execute` or `batch` below, against the Core this module owns. Nothing else
 * constructs a Core or holds one across a render: read it with
 * `useEdit((s) => s.core)` and drive it through here, so there is one history
 * and one saver, and a Core torn down on Clear is never written to afterwards.
 *
 *   useEdit            zustand hook — phase, core, studio, the drawn project,
 *                      the clips that would not load, notes, playing
 *   execute / batch    run commands on the open Core (one undo entry per call)
 *   play/pause/toggle/seek   transport, in µs
 *   startEditing()     called once from main.tsx; opens and closes the session
 *
 * **Duration starts at zero.** A session opens only when the video side is
 * showing *and* the scene has a take — so a still-only visit never downloads
 * the 3.4 MB engine, and nobody meets a timeline before there is time on it.
 * Once open it outlives a switch to stills: the Core is the arrangement and its
 * undo history, and closing it on a kind switch would throw both away for a
 * glance at the other side. The Studio does not outlive it — that is `Stage`'s,
 * mounted only while the surface is on screen.
 *
 * **The arrangement's only record is the Core.** On open it is imported from
 * the scene's project.json when there is one; otherwise the scene's takes are
 * laid onto V1 in order and that becomes the record. From then on a take that
 * lands goes where its run was aimed when it was started (see `SlotTarget`):
 * the end of V1, into a slot it re-renders, or after the slot it continues —
 * each one command, so each is one undo. The intent never learns where a take
 * sits (see persist.ts); it learns which slot a take was rendered for.
 *
 *   chooseTake         step a slot to another of its takes (`take.choose`)
 *   undo / redo        Core's history — the only one
 */
import { create } from 'zustand'
import type { AnyClip, Command, Core, IProject } from '@openvideo/core'
import type { Studio } from '@openvideo/engine-pixi'

import { failed, type ApiError } from '../api/client'
import { useStore, type SceneTake, type Store } from '../store'
import { loadEngine, OPENVIDEO_PIN, us, type Engine } from './engine'
import { attachProjectSaver, loadedProject, pinNote, saveProject } from './persist'
import {
  appendTake, atEndOfV1, emptyProject, mediaSrcs, mintSlotId, park, readProject, rebase,
  settingsFor, slotOf, takePayload, takeSrc, v1, V1_ID, v1Track, withParked, type Parked,
} from './project'
import { landedCut } from './continue'
import {
  registerCommands, SLOT_CONTINUE, SLOT_RENDER, TAKE_CHOOSE,
  type SlotContinuePayload, type SlotRenderPayload, type TakeChoosePayload,
} from './commands'
import {
  adoptTakes, clearSlotRun, clipOfSlot, setSlotRun, slotView, takeLanding, useSlotRuns,
  type SlotTake,
} from './slots'

export type EditPhase = 'off' | 'loading' | 'ready' | 'failed'

export type EditState = {
  /** `off` — no session (no take, or never on the video side). `loading` — the
   *  engine or the arrangement is on its way. `failed` — the engine would not
   *  load; `error` says why and `retry()` asks again. */
  phase: EditPhase
  error: ApiError | null
  /** The open scene's Core. Null outside `ready`. */
  core: Core | null
  engine: Engine | null
  /** The Studio drawing `core`, while `Stage` is mounted. For frame grabs;
   *  never for commands — its own history is not the scene's. */
  studio: Studio | null
  /** The arrangement as drawn: the Core's, with parked clips put back. Updated
   *  on every structural change, not on playback. */
  project: IProject | null
  /** Clips held outside the Core because their file would not load. */
  parked: Parked[]
  /** Clip id → why its file would not load, naming the file. */
  broken: Record<string, ApiError>
  /** What the arrangement's reader has to say: a damaged project.json, an
   *  arrangement saved by another OpenVideo. Shown on the timeline. */
  notes: Array<string | ApiError>
  playing: boolean
}

const OFF: Omit<EditState, 'studio'> = {
  phase: 'off', error: null, core: null, engine: null, project: null,
  parked: [], broken: {}, notes: [], playing: false,
}

export const useEdit = create<EditState>(() => ({ ...OFF, studio: null }))

/* ---- commands ---------------------------------------------------------- */

/** A command without an id; one is minted. */
export type EditCommand<T = unknown> = Omit<Command<T>, 'id'> & { id?: string }

const withId = <T>(c: EditCommand<T>): Command<T> => ({ ...c, id: c.id ?? crypto.randomUUID() })

/**
 * Run one command on the open Core — one undo entry. False when no scene is
 * open, which is a caller that offered an edit with nothing to edit, and is
 * said rather than thrown so a control racing a Clear does not take the page
 * down with it.
 */
export function execute<T>(command: EditCommand<T>): boolean {
  const core = useEdit.getState().core
  if (!core) return false
  core.execute(withId(command))
  return true
}

/** Run several commands as one undo entry. */
export function batch(commands: EditCommand[]): boolean {
  const core = useEdit.getState().core
  if (!core) return false
  core.batch(commands.map(withId))
  return true
}

/**
 * Step back one edit on the open scene's history — a trim, a render, a take
 * chosen — or forward again. Core's history only: the Studio keeps one of its
 * own for canvas drags, which this page never makes, and two stacks would be
 * two answers to "what does undo do". False with no scene open.
 */
export function undo(): boolean {
  const core = useEdit.getState().core
  if (!core) return false
  core.undo()
  return true
}
export function redo(): boolean {
  const core = useEdit.getState().core
  if (!core) return false
  core.redo()
  return true
}

/* ---- transport --------------------------------------------------------- */

/**
 * Play from the playhead. The Studio keeps a clock of its own and a freshly
 * mounted one starts it at zero while the Core still holds where the head was,
 * so Play would run the cut from the top and drag the head back with it. The
 * Studio is put where the Core is first.
 */
export function play(): void {
  const { core, studio } = useEdit.getState()
  if (!core) return
  const t = core.store.getState().currentTime
  if (studio && Math.abs(studio.currentTime - t) > 1_000) void studio.seek(t).then(() => core.play())
  else core.play()
}
export function pause(): void { useEdit.getState().core?.pause() }
export function toggle(): void {
  const core = useEdit.getState().core
  if (!core) return
  if (core.store.getState().isPlaying) core.pause()
  else play()
}
/** Move the playhead, in µs, clamped to the cut. */
export function seek(micro: number): void {
  const { core, project } = useEdit.getState()
  if (!core) return
  const end = project ? Math.max(0, ...Object.values(project.clips).map((c) => c.timing.display.to)) : 0
  core.seek(Math.max(0, Math.min(end, Math.round(micro))))
}

/* ---- the engine's file cache ------------------------------------------- */

/**
 * The key OpenVideo files a URL under in OPFS `assets/`.
 *
 * The engine downloads every clip's file whole into `assets/<key>` and never
 * evicts it — a month of takes is a month of video in the browser's storage
 * that nothing will ever read again. Its `AssetManager.getCacheKey` is private,
 * and `engine.ts` does not hand the class out, so this is that function
 * transcribed (cyrb53 with seed 0, hex) from @openvideo/engine-pixi 1.4.0. A
 * version that changes the scheme turns pruning into a cache miss and a
 * refetch, never into deleting a file that is in use — the keys simply stop
 * matching anything — and `check_edit.py` compares the names the engine wrote
 * against these.
 */
export function assetKey(url: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * Delete every cached file the open project does not reference.
 *
 * Silent on failure, deliberately: a browser without OPFS, a private window, a
 * file the engine still holds open — each leaves a cache that is merely larger
 * than it needs to be, which is not something a person can act on or needs to
 * hear about while editing.
 */
async function pruneAssets(keep: readonly string[]): Promise<number> {
  try {
    const root = await navigator.storage.getDirectory()
    let dir: FileSystemDirectoryHandle
    try {
      dir = await root.getDirectoryHandle('assets')
    } catch {
      return 0
    }
    const wanted = new Set(keep.map(assetKey))
    const doomed: string[] = []
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (!wanted.has(name)) doomed.push(name)
    }
    const gone = await Promise.all(doomed.map((n) => dir.removeEntry(n).then(() => 1, () => 0)))
    return gone.reduce<number>((a, b) => a + b, 0)
  } catch {
    return 0
  }
}

/* ---- reading a file before the engine is handed it ---------------------- */

type Probe = { width: number; height: number; seconds: number }

/** How long a file may take to say what it is before it is treated as one
 *  that will not load. Generous: this is a metadata read, and a cold volume
 *  answering slowly is not a missing file. */
const PROBE_MS = 30_000

/**
 * The file's size and length, or why it will not load — naming the file.
 *
 * Asked before the engine sees the clip, because the engine cannot say: a
 * metadata read that fails inside it falls back to 600x400 and five seconds
 * silently, and a clip whose bytes 404 throws out of the Studio's loader and
 * stops every clip after it from loading. Knowing first is what lets the
 * failure sit on the one clip and the rest of the cut play.
 */
function probe(take: Pick<SceneTake, 'jobId' | 'file'>): Promise<Probe | ApiError> {
  const src = takeSrc(take)
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    let done = false
    const finish = (r: Probe | ApiError): void => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      v.removeAttribute('src')
      v.load()
      resolve(r)
    }
    const timer = window.setTimeout(() => {
      finish({
        error: `${take.file} (take ${take.jobId}) did not answer within ${String(PROBE_MS / 1000)} `
          + 'seconds, so it is held out of the preview. Its place on V1 is kept; reload to try it again.',
      })
    }, PROBE_MS)
    v.onloadedmetadata = () => {
      // A fragmented MP4 reports Infinity until it has been read to the end —
      // the reason `lastFrame` uses `seekable`. The engine reads its own length
      // later; this only has to be a finite fallback.
      const d = Number.isFinite(v.duration) ? v.duration
        : v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0
      finish({ width: v.videoWidth, height: v.videoHeight, seconds: d })
    }
    v.onerror = () => {
      const code = v.error ? `MediaError ${String(v.error.code)}${v.error.message ? `: ${v.error.message}` : ''}` : ''
      void why(src).then((status) => {
        finish(status === 404 || status === 410
          ? { error: `${take.file} (take ${take.jobId}) is not on the volume any more. Its place `
                + 'on V1 is kept and the rest of the cut plays around it.',
              detail: `GET ${src} → ${String(status)}` }
          : status !== null && status < 400
            ? { error: `${take.file} (take ${take.jobId}) is on the volume, but this browser `
                  + 'could not decode it. Its place on V1 is kept and the rest of the cut plays '
                  + 'around it; Chrome or Edge read H.264 with AAC.',
                detail: code || undefined }
            : { error: `${take.file} (take ${take.jobId}) could not be fetched`
                  + `${status ? ` (the server answered ${String(status)})` : ''}. Its place on V1 is `
                  + 'kept; reload to try it again.',
                detail: code || undefined })
      })
    }
    v.src = src
  })
}

/** Missing or undecodable: one byte asked for, the status is the answer. */
async function why(src: string): Promise<number | null> {
  try {
    const r = await fetch(src, { headers: { Range: 'bytes=0-0' } })
    void r.body?.cancel()
    return r.status
  } catch {
    return null
  }
}

/** A clip for a take the engine could not read, so it can still hold its
 *  place: the length the job reported, else five seconds, at full frame. */
function standIn(take: SceneTake, slotId: string, settings: IProject['settings']): AnyClip {
  const length = us(take.seconds && take.seconds > 0 ? take.seconds : 5)
  const p = takePayload(take, slotId)
  return {
    ...p,
    id: crypto.randomUUID(),
    type: 'Video',
    name: p.name ?? take.file,
    src: takeSrc(take),
    timing: { display: { from: 0, to: length }, trim: { from: 0, to: length }, duration: length, playbackRate: 1 },
    transform: { x: 0, y: 0, width: settings.width, height: settings.height, angle: 0, zIndex: 10, opacity: 1 },
  } as AnyClip
}

/** The engine's own reading of a take, or why it could not make one. */
async function prepare(core: Core, take: SceneTake, slotId: string): Promise<AnyClip | ApiError> {
  try {
    return await core.clip.prepare(takePayload(take, slotId))
  } catch (e) {
    return {
      error: `${take.file} (take ${take.jobId}) could not be read by the editor. Its place on V1 `
        + 'is kept and the rest of the cut plays around it.',
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }
  }
}

/* ---- the session ------------------------------------------------------- */

type Session = {
  gen: number
  /** The takes already on the timeline, in order. A store list that extends
   *  this is new takes to append; one that does not is a different scene. */
  known: SceneTake[]
  core: Core | null
  cleanup: Array<() => void>
  /** The engine's reading of each take file this session has placed, by URL.
   *  Stepping a slot back to a take it had is then a command and nothing else —
   *  no second metadata read of a file the page already knows the length of. */
  reads: Map<string, AnyClip>
}

let session: Session | null = null
let generation = 0
/** The parked clips of the open session. Module state rather than read off
 *  the zustand store inside the saver, so a save never races a render. */
let parked: Parked[] = []

const sameTake = (a: SceneTake, b: SceneTake): boolean => a.jobId === b.jobId && a.file === b.file
const extendsKnown = (known: readonly SceneTake[], takes: readonly SceneTake[]): boolean =>
  known.length <= takes.length && known.every((t, i) => sameTake(t, takes[i]!))

function snapshot(core: Core): IProject {
  const st = core.store.getState()
  return withParked({ settings: st.settings, tracks: st.tracks, clips: st.clips }, parked)
}

function publish(core: Core): void {
  useEdit.setState({ project: snapshot(core), parked })
}

function close(): void {
  generation += 1
  const s = session
  session = null
  parked = []
  if (s) {
    // In the order they were attached, which puts the saver first: its
    // detach writes a pending edit, and it must read the Core before anything
    // else lets go of it.
    for (const f of s.cleanup) f()
    s.core?.pause()
  }
  // A slot's "placing the take" belongs to the arrangement that is going
  // away, and would otherwise sit on a slot of the next scene with the same id
  // forever. A job still running keeps running; its take joins `store.takes`.
  useSlotRuns.setState({}, true)
  useEdit.setState({ ...OFF })
}

/**
 * The takes an arrangement is compiled from, one per slot, in the order each
 * slot first appeared — and in each slot the latest take, because that is the
 * one a render put there. A take from before slots existed is a slot of its
 * own. Only these are read: a slot's other takes are not on the timeline.
 */
function laidOut(takes: readonly SlotTake[]): Array<{ take: SlotTake; slotId: string | null }> {
  const out: Array<{ take: SlotTake; slotId: string | null }> = []
  const at = new Map<string, number>()
  for (const t of takes) {
    if (!t.slot) { out.push({ take: t, slotId: null }); continue }
    const i = at.get(t.slot)
    if (i === undefined) { at.set(t.slot, out.length); out.push({ take: t, slotId: t.slot }) }
    else out[i] = { take: t, slotId: t.slot }
  }
  return out
}

/** Lay `layout` onto V1 of a new project, reading each file once. */
async function compile(eng: Engine, layout: ReadonlyArray<{ take: SceneTake; slotId: string | null }>,
  probes: Array<Probe | ApiError>): Promise<{ project: IProject; broken: Record<string, ApiError> }> {
  const takes = layout.map((l) => l.take)
  const first = probes.find((p): p is Probe => !failed(p))
  const settings = settingsFor({
    width: first?.width || takes[0]?.width,
    height: first?.height || takes[0]?.height,
    fps: takes[0]?.fps,
  })
  // A Core only for its reader: `prepare` fits each clip to this frame.
  const scratch = eng.createCore(emptyProject(settings))
  let project = emptyProject(settings)
  const broken: Record<string, ApiError> = {}
  for (const [i, { take, slotId: stamped }] of layout.entries()) {
    const slotId = stamped ?? mintSlotId(project)
    const pr = probes[i]!
    const read = failed(pr) ? pr : await prepare(scratch, take, slotId)
    if (failed(read)) {
      const stand = standIn(take, slotId, settings)
      broken[stand.id] = read
      project = appendTake(project, stand)
    } else {
      project = appendTake(project, read)
    }
  }
  return { project, broken }
}

async function open(): Promise<void> {
  const gen = ++generation
  const takes = [...useStore.getState().takes]
  const s: Session = { gen, known: takes, core: null, cleanup: [], reads: new Map() }
  session = s
  parked = []
  useEdit.setState({ ...OFF, phase: 'loading' })

  const eng = await loadEngine()
  if (gen !== generation) return
  if (failed(eng)) {
    session = null
    useEdit.setState({ ...OFF, phase: 'failed', error: eng })
    return
  }
  // Before any Core runs a command: a Core asked for a type nobody registered
  // warns in the console and does nothing, which is a render that landed and
  // silently went nowhere.
  registerCommands(eng)

  const notes: Array<string | ApiError> = []
  const lp = loadedProject()
  let base: IProject | null = null
  if (lp.sceneId !== null && lp.sceneId === useStore.getState().sceneId) {
    if (lp.project_error) {
      notes.push({
        error: `This scene's saved arrangement could not be read, so its takes were laid onto V1 `
          + 'again in the order they were made. The damaged file is set aside on the next save.',
        detail: lp.project_error,
      })
    }
    if (lp.project !== null) {
      const r = readProject(lp.project)
      if (typeof r === 'string') {
        notes.push({ error: `This scene's saved arrangement was not used: ${r}. Its takes were `
          + 'laid onto V1 again in the order they were made.' })
      } else {
        base = rebase(r)
      }
    }
    const pn = pinNote(lp.openvideo)
    if (pn && base) notes.push(pn)
  }

  let project: IProject
  let broken: Record<string, ApiError> = {}
  if (base) {
    project = base
    // Every take clip is read once before the Core sees it — see `probe`.
    const clips = Object.values(base.clips).filter((c) => c.type === 'Video' && c.metadata?.file)
    const probes = await Promise.all(clips.map((c) =>
      probe({ jobId: String(c.metadata!.jobId), file: String(c.metadata!.file) })))
    clips.forEach((c, i) => { const p = probes[i]!; if (failed(p)) broken[c.id] = p })
  } else {
    const layout = laidOut(takes)
    const probes = await Promise.all(layout.map((l) => probe(l.take)))
    ;({ project, broken } = await compile(eng, layout, probes))
  }
  if (gen !== generation) return

  // The cache is pruned to this scene before anything is fetched into it.
  await pruneAssets(mediaSrcs(project))
  if (gen !== generation) return

  const split = park(project, new Set(Object.keys(broken)))
  parked = split.parked
  const core = eng.createCore(emptyProject(project.settings))
  s.core = core
  // Attached before the import, so a compiled arrangement is saved straight
  // away: the next reload then opens it rather than compiling it again.
  s.cleanup.push(attachProjectSaver(
    (fn) => core.store.subscribe(fn),
    () => withParked(core.project.export(), parked),
  ))
  try {
    core.project.import(split.playable)
  } catch (e) {
    // The engine refused a project that passed `readProject`. The scene still
    // has its takes, so they are laid onto V1 again rather than showing nothing.
    notes.push({
      error: `OpenVideo ${OPENVIDEO_PIN} refused this scene's saved arrangement, so its takes were `
        + 'laid onto V1 again in the order they were made.',
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    })
    const layout = laidOut(takes)
    const probes = await Promise.all(layout.map((l) => probe(l.take)))
    if (gen !== generation) return
    const again = await compile(eng, layout, probes)
    if (gen !== generation) return
    broken = again.broken
    const split2 = park(again.project, new Set(Object.keys(broken)))
    parked = split2.parked
    core.project.import(split2.playable)
  }
  if (gen !== generation) return

  s.cleanup.push(core.store.subscribe((st, prev) => {
    if (st.tracks !== prev.tracks || st.clips !== prev.clips || st.settings !== prev.settings) publish(core)
    if (st.isPlaying !== prev.isPlaying) useEdit.setState({ playing: st.isPlaying })
  }))
  useEdit.setState({
    phase: 'ready', error: null, core, engine: eng, project: snapshot(core), parked, broken, notes,
    playing: false,
  })
  // A scene from before slots existed: every take on the timeline is stamped
  // with the slot it sits in, so its slot's list survives the slot being
  // rendered again. `known` is compared by job and file, so this is not a
  // different scene to `sync`.
  const adopted = adoptTakes(useStore.getState().takes, snapshot(core))
  if (adopted) useStore.setState({ takes: adopted })
  // Whatever landed while this was opening.
  void sync()
}

/** The engine's reading of a take, from the session's cache when it has one.
 *  A file that will not load is never cached, so the next ask is the retry. */
async function readTake(s: Session, core: Core, take: SceneTake, slotId: string): Promise<AnyClip | ApiError> {
  const key = takeSrc(take)
  const had = s.reads.get(key)
  if (had) return had
  const pr = await probe(take)
  if (failed(pr)) return pr
  const read = await prepare(core, take, slotId)
  if (!failed(read)) s.reads.set(key, read)
  return read
}

/** A copy of a cached reading with an id of its own, for a clip that is new
 *  to the arrangement — two clips sharing an id are one clip to the Core. */
const fresh = (c: AnyClip): AnyClip => ({ ...c, id: crypto.randomUUID() })

/** Whether V1 has a clip held out of the Core — a hole the slot commands must
 *  not close by re-laying V1 (see `Placing.keepGaps` in commands.ts). The same
 *  condition `v1Lock` refuses a trim on. */
const holdsGap = (): boolean => parked.some((p) => p.trackId === V1_ID)

/**
 * One take that has landed, into the arrangement where its run was aimed (see
 * `SlotTarget`) — each as one command, so each is one undo:
 *
 * - into the slot it re-rendered (`slot.render`), the slot's old take kept in
 *   its list and on the volume;
 * - after the slot it continues (`slot.continue`);
 * - otherwise onto the end of V1.
 *
 * A file that will not load is parked in its place instead, and the saver is
 * told, because a parked clip is not a Core change it would otherwise see. A
 * re-render whose file will not load leaves the slot on the take it had, and
 * says so on the slot — the new take is still in its list.
 */
async function land(s: Session, core: Core, take: SlotTake): Promise<void> {
  const target = takeLanding(take.jobId)
  const slotId = target?.slotId ?? take.slot ?? mintSlotId(snapshot(core))
  const read = await readTake(s, core, take, slotId)
  if (session !== s) return

  if (target?.kind === 'render') {
    clearSlotRun(slotId)
    if (failed(read)) { setSlotRun(slotId, { error: read }); return }
    if (clipOfSlot(core.store.getState(), slotId)) {
      const payload: SlotRenderPayload = { slotId, clip: read, keepGaps: holdsGap() }
      core.execute(withId({ type: SLOT_RENDER, payload }))
      return
    }
    const held = parked.find((p) => slotOf(p.clip) === slotId)
    if (held) {
      // The slot's old file never loaded, so its clip is not in the Core. The
      // new take goes where that one sat, and the stand-in is let go of — the
      // slot plays now.
      parked = parked.filter((p) => p !== held)
      useEdit.setState((st) => {
        const rest = { ...st.broken }
        delete rest[held.clip.id]
        return { broken: rest }
      })
      const d = held.clip.timing.display
      const payload: SlotRenderPayload = {
        slotId, clip: fresh(read), trackId: held.trackId, at: d.from, span: d.to - d.from,
      }
      core.execute(withId({ type: SLOT_RENDER, payload }))
      return
    }
    // The slot left the cut (undone, or its clip removed) while the take
    // rendered. The take is still the slot's; it goes on the end of V1 rather
    // than nowhere.
  }

  // Placed against the drawn project, parked clips included, so a take after
  // a missing one does not slide into the missing one's place.
  const now = snapshot(core)
  if (failed(read)) {
    const clip = atEndOfV1(now, standIn(take, slotId, now.settings))
    const track = v1(now)
    parked = [...parked, { clip, trackId: track?.id ?? V1_ID, index: track?.clipIds.length ?? 0 }]
    useEdit.setState((st) => ({ broken: { ...st.broken, [clip.id]: read } }))
    publish(core)
    void saveProject()
    return
  }
  if (target?.kind === 'continue') {
    // Where the server said the continuation opens, so the source's out-point
    // moves there in the same undo entry — see `cutBack` in commands.ts.
    const cut = landedCut(take.jobId)
    const payload: SlotContinuePayload = {
      fromSlotId: target.from, slotId, clip: fresh(read), keepGaps: holdsGap(),
      ...(cut && { cut: { jobId: cut.from, to: Math.round(us(cut.continuedAt)) } }),
    }
    core.execute(withId({ type: SLOT_CONTINUE, payload }))
    return
  }
  const placed = atEndOfV1(now, fresh(read))
  // A Core with no V1 left (a later edit removed it) gets one back in the same
  // undo entry; a clip added to a track id that does not exist is a clip on no
  // track, which nothing draws or plays.
  const track = v1(core.store.getState())
  const cmds: Command[] = track ? [] : [withId({ type: 'track.add', payload: v1Track() })]
  cmds.push(withId({ type: 'clip.add', payload: { clip: placed, trackId: track?.id ?? V1_ID } }))
  if (cmds.length === 1) core.execute(cmds[0]!)
  else core.batch(cmds)
}

/**
 * Put take `index` of `slotId`'s list in the slot's clip — `take.choose`, one
 * undo entry. Resolves false when there is nothing to do (no scene, no such
 * take, already chosen, the slot's clip held out of the Core) or the take's
 * file will not load, in which case the slot says why.
 */
export async function chooseTake(slotId: string, index: number): Promise<boolean> {
  const s = session
  const core = s?.core
  if (!s || !core) return false
  const view = slotView(useStore.getState().takes, slotId, snapshot(core))
  const take = view.takes[index]
  if (!take || index === view.chosen) return false
  if (!clipOfSlot(core.store.getState(), slotId)) return false
  const read = await readTake(s, core, take, slotId)
  if (session !== s) return false
  if (failed(read)) { setSlotRun(slotId, { error: read }); return false }
  const payload: TakeChoosePayload = { slotId, index, clip: read, keepGaps: holdsGap() }
  core.execute(withId({ type: TAKE_CHOOSE, payload }))
  return true
}

let syncing = false
let syncAgain = false

/** Bring the timeline up to the store's takes: append what is new, or reopen
 *  when the list is not an extension of what is on screen (a different scene
 *  was loaded under it). One pass at a time, in order. */
async function sync(): Promise<void> {
  if (syncing) { syncAgain = true; return }
  syncing = true
  try {
    for (;;) {
      const s = session
      const core = s?.core
      if (!s || !core) return
      const takes = useStore.getState().takes
      if (!extendsKnown(s.known, takes)) {
        close()
        if (takes.length && useStore.getState().kind === 'video') void open()
        return
      }
      const next = takes[s.known.length]
      if (!next) return
      await land(s, core, next)
      if (session !== s) return
      s.known = [...s.known, next]
    }
  } finally {
    syncing = false
    if (syncAgain) { syncAgain = false; void sync() }
  }
}

function reconcile(st: Store): void {
  if (!st.takes.length) {
    if (session || useEdit.getState().phase !== 'off') close()
    return
  }
  if (!session) {
    if (st.kind === 'video' && useEdit.getState().phase !== 'failed') void open()
    return
  }
  void sync()
}

/** Ask for the engine again after it failed to load. */
export function retry(): void {
  if (session) return
  useEdit.setState({ ...OFF })
  const st = useStore.getState()
  if (st.takes.length && st.kind === 'video') void open()
}

/**
 * Open and close the session as the store changes. Call once, after
 * `startPersisting()` — so on a Clear the intent saver has already flushed the
 * old folder's last arrangement edit and dropped its id when this detaches.
 * Returns the stop.
 */
export function startEditing(): () => void {
  // The history, reachable from a UI check before a control draws it — the
  // `__eye` convention. It runs the same two functions a button would.
  ;(window as unknown as Record<string, unknown>).__edit = { undo, redo }
  const unsub = useStore.subscribe((st, prev) => {
    if (st.takes !== prev.takes || st.kind !== prev.kind) reconcile(st)
  })
  reconcile(useStore.getState())
  return () => { unsub(); close() }
}

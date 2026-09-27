/**
 * A scene survives the page.
 *
 * Everything a scene is made of — the cast, their photographs, the prose, the
 * pills and every take — used to live in one tab's memory, so a reload was the
 * end of it. This keeps it in a folder on the volume (`scenes/{id}/`, see
 * `SCENES` in app.py): the page opens the newest one on load and saves
 * continuously after that. Nothing asks to save.
 *
 * Three rules shape it, each for a failure it prevents:
 *
 * - **The reader keeps what it does not model.** The intent read on load is
 *   spread under the one written, so a field a later build added survives a
 *   save by this one. The server stores `intent` verbatim for the same reason.
 * - **A failed save keeps the page.** The store is never rolled back to match
 *   the volume; the error is exposed through `useSaveState` for the page to show
 *   where the scene is, and the next change retries.
 * - **Bytes travel once.** A photograph is uploaded the first time a save needs
 *   it and never again: re-sending nine references on every debounce would be
 *   the 48 MB body `shrinkB64` exists to prevent, on a timer.
 *
 * The arrangement — which take sits where, trimmed how, crossfaded into what —
 * is a second file beside the intent (`project.json`), saved by a second saver
 * below: OpenVideo's IProject, exported from the Core and stored verbatim with
 * the pin it was written at. It is the ONLY record of trim, order and position;
 * the intent carries none of them, so there is never a second copy to disagree
 * with. Both savers share one folder id and one `useSaveState`.
 *
 * `./engine` is imported for `OPENVIDEO_PIN` alone. That is a static export of
 * a module whose packages are loaded only by `import()`, so this file — which is
 * on the first-load path — pulls in a string, not the 3.4 MB engine.
 */
import { create } from 'zustand'

import { failed, type ApiError } from '../api/client'
import {
  saveProject as postProject, saveScene, scene as getScene, sceneFileUrl, scenes as listScenes,
} from '../api/routes'
import type { SceneIntent, ScenePoolRef } from '../api/types'
import { toB64 } from '../media/files'
import {
  newMember, newShot, SOURCE_TAKES,
  type CastMember, type Media, type PoolFile, type Scene, type Shot, type SourceKind,
} from '../scene/model'
import { useStore, type SceneTake, type Store } from '../store'
import { OPENVIDEO_PIN } from './engine'

/** Quiet time before a change is written. Long enough that typing a sentence
 *  is one save rather than forty, short enough that closing the tab a moment
 *  after the last keystroke rarely loses it. */
const SAVE_DEBOUNCE_MS = 800

export type SaveState = {
  saving: boolean
  /** The last save's failure, or a load that could not open the last scene.
   *  Cleared by the next save that lands. */
  error: ApiError | null
}

/** What the page shows about saving. Its own tiny store rather than fields on
 *  the app store, so a save starting and finishing does not wake the app
 *  store's subscribers — including this module's own. */
export const useSaveState = create<SaveState>(() => ({ saving: false, error: null }))

/** Each writer's own failure, kept apart so an intent save landing does not
 *  clear an arrangement save that is still failing — one shared `error` field
 *  written by two savers would say "saved" while half the scene was not. */
const errors: { load: ApiError | null; intent: ApiError | null; project: ApiError | null } = {
  load: null, intent: null, project: null,
}

/** Recompute the shared state from both savers. A write failure outranks the
 *  load note because it is the one that loses work if nobody reads it. */
function publish(): void {
  useSaveState.setState({
    saving: inFlight || projectInFlight,
    error: errors.intent ?? errors.project ?? errors.load,
  })
}

function loadFailed(e: ApiError): void {
  errors.load = e
  publish()
}

/** A save landed: the load note has been answered by the page working. */
function landed(which: 'intent' | 'project'): void {
  errors[which] = null
  errors.load = null
}

/**
 * A fresh scene id: `scn` + local YYYYmmddHHMMSS + 4 hex, the job ids' shape.
 *
 * Minted by the page rather than the server so a scene has its folder name
 * before its first save lands — the save is debounced and may fail, and an id
 * the page had to wait for would be a scene that cannot be addressed while it
 * is retrying.
 */
export function newSceneId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${String(now.getFullYear())}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const hex = [...crypto.getRandomValues(new Uint8Array(2))]
    .map((n) => n.toString(16).padStart(2, '0')).join('')
  return `scn${stamp}${hex}`
}

/* ---- what this module remembers about the folder it is writing ----------- */

/** The intent last read or written, spread under every write. */
let lastIntent: SceneIntent = {}
/** Pool id → the ref name assigned to its bytes in this scene's folder.
 *  Assigned once and kept across failed saves, so a retry re-sends under the
 *  same name rather than minting a second copy. */
let refNames = new Map<string, string>()
/** Ref names the folder is known to hold — listed on load, or confirmed by a
 *  save that landed. Only names outside this set are sent. */
let onVolume = new Set<string>()
/** The last intent written, serialised. A change that serialises the same —
 *  a region dragged, a popover opened — is not a save. */
let lastWritten = ''
/** Bumped whenever the folder being written changes, so a save that was in
 *  flight across a Clear does not mark its refs as present in the new one. */
let generation = 0
/** The arrangement last read or written, serialised. The Core fires on
 *  selection and playback as well as on edits, and an export that serialises
 *  the same is not a save. */
let lastProject = ''

function forgetFolder(): void {
  lastIntent = {}
  refNames = new Map()
  onVolume = new Set()
  lastWritten = ''
  lastProject = ''
  loaded = { sceneId: null, project: null, openvideo: null, project_error: null }
  generation += 1
}

/**
 * The folder id both savers write to, minted by whichever needs it first.
 *
 * One function for both because they are debounced separately: an arrangement
 * change can fire before the intent's first save, and two savers each minting
 * would split one scene across two folders. `worth` is the caller's own test
 * of whether what it holds is a scene rather than a blank page.
 */
function sceneIdFor(worth: boolean): string | null {
  const s = useStore.getState()
  if (s.sceneId) return s.sceneId
  if (!worth) return null
  // Minted on the first change worth keeping, and not on load: a visit that
  // made nothing leaves no folder behind.
  const id = newSceneId()
  s.setSceneId(id)
  return id
}

/* ---- the arrangement as read ------------------------------------------- */

/** What `loadLatestScene` read of the arrangement, for the timeline to import
 *  into its Core. */
export type LoadedProject = {
  sceneId: string | null
  /** OpenVideo's IProject as stored, or null when the scene has none — or
   *  when it did not parse, in which case the takes are laid onto V1 again
   *  from the intent. */
  project: unknown
  /** The pin it was written at; hand it to `pinNote`. */
  openvideo: string | null
  /** project.json's parse error, naming the file, when it had one. */
  project_error: string | null
}

let loaded: LoadedProject = { sceneId: null, project: null, openvideo: null, project_error: null }

/** The arrangement `loadLatestScene` found. Read once, after it settles. */
export function loadedProject(): LoadedProject {
  return loaded
}

/**
 * A sentence for an arrangement written by another OpenVideo, or null.
 *
 * Not a refusal: the IProject is imported as it is and usually reads fine. But
 * a clip that sits wrong after an engine bump has two possible causes — the
 * edit, or the engine reading an older shape — and the person can only tell
 * them apart if the page has said the versions differ.
 */
export function pinNote(openvideo: string | null): string | null {
  if (openvideo === null || openvideo === OPENVIDEO_PIN) return null
  return `This arrangement was saved by OpenVideo ${openvideo} and opened with `
    + `${OPENVIDEO_PIN}. It was imported unchanged; if a clip sits wrong, the `
    + 'version difference is the first thing to suspect.'
}

/* ---- reading a scene back ---------------------------------------------- */

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const MEDIA: Media[] = ['image', 'video', 'audio']

/**
 * A shot off disk, with a fresh id and every field it carried.
 *
 * Fresh because `scene/model.ts` mints ids from a module counter that starts
 * at zero on every page load — a restored `s1` would collide with the next
 * `newShot()`, and two rows sharing an id is a patch landing on both.
 */
function readShot(x: unknown): Shot | null {
  if (!isObj(x) || typeof x.line !== 'string') return null
  const base = newShot()
  const say = isObj(x.say) ? { ...base.say, ...x.say } : base.say
  return {
    ...(x as Partial<Shot>), ...base, line: x.line,
    beats: typeof x.beats === 'number' ? x.beats : null,
    pills: Array.isArray(x.pills) ? (x.pills as Shot['pills']) : [],
    say: say as Shot['say'],
  }
}

function readMember(x: unknown): CastMember | null {
  if (!isObj(x) || typeof x.name !== 'string') return null
  const base = newMember('subject')
  return {
    ...(x as Partial<CastMember>), ...base,
    name: x.name,
    note: typeof x.note === 'string' ? x.note : '',
    retention: typeof x.retention === 'string' ? x.retention : base.retention,
    refs: Array.isArray(x.refs)
      ? (x.refs as CastMember['refs']).filter((r) => isObj(r) && typeof r.fileId === 'string')
      : [],
  }
}

/** The stored scene, or null when it is not one — in which case the page opens
 *  a new scene and the folder is left exactly as it was. */
function readStoredScene(x: unknown): Scene | null {
  if (!isObj(x) || !Array.isArray(x.shots)) return null
  const shots = x.shots.map(readShot).filter((s): s is Shot => s !== null)
  if (!shots.length) return null
  const cast = Array.isArray(x.cast)
    ? x.cast.map(readMember).filter((c): c is CastMember => c !== null)
    : []
  const sources: Scene['sources'] = {}
  if (isObj(x.sources)) {
    for (const k of Object.keys(SOURCE_TAKES) as SourceKind[]) {
      const v = x.sources[k]
      if (Array.isArray(v)) sources[k] = v.filter((id): id is string => typeof id === 'string')
    }
  }
  return {
    ...(x as Partial<Scene>),
    cast, shots, sources,
    style: typeof x.style === 'string' ? x.style : '',
    grade: typeof x.grade === 'string' ? x.grade : '',
  }
}

function readTakes(x: unknown): SceneTake[] {
  if (!Array.isArray(x)) return []
  return x.filter((t): t is SceneTake => isObj(t)
    && typeof t.jobId === 'string' && typeof t.file === 'string')
    .map((t) => ({ ...t, line: typeof t.line === 'string' ? t.line : '' }))
}

/**
 * The newest scene on the volume, into the store — cast, photographs, prose,
 * pills and takes.
 *
 * **Pool files come back with their bytes**, because `readScene` sends
 * `PoolFile.b64` as the run's `references[]`: a pool entry holding only a URL
 * would render as a scene with nobody's face in it. So each ref is fetched once
 * here, and a file that does not come back is recorded on the member that
 * pointed at it as `missing` — the arsenal's rule, because the validator
 * refuses that by name, where dropping the pointer would compile a valid
 * document about somebody else.
 *
 * A folder that cannot be opened is never written to: the page starts a new
 * scene and says which folder it passed over, and the old one stays for
 * whoever wants to repair it.
 */
export async function loadLatestScene(): Promise<void> {
  const list = await listScenes()
  if (failed(list)) {
    loadFailed({
      error: 'Could not list saved scenes, so this is a new one — the last '
        + 'scene is still on the volume.', detail: list.error })
    return
  }
  const newest = list.scenes[0]
  if (!newest) return
  const passOver = (why: string, detail?: string): void => {
    loadFailed({
      error: `Scene ${newest.id} could not be opened, so this is a new scene — `
        + `the folder is untouched. ${why}`, detail })
  }
  if (newest.error) return passOver('Its scene.json does not parse.', newest.error)
  const rec = await getScene(newest.id)
  if (failed(rec)) return passOver('The server refused it.', rec.error)
  const intent = isObj(rec.intent) ? (rec.intent as SceneIntent) : null
  const sc = intent ? readStoredScene(intent.scene) : null
  if (!intent || !sc) return passOver('Its intent holds no scene this page can read.')

  const stored = isObj(intent.pool) ? intent.pool : {}
  const pool: Record<string, PoolFile> = {}
  const names = new Map<string, string>()
  const lost = new Map<string, { file: string; kind: string }>()
  await Promise.all(Object.entries(stored).map(async ([id, p]) => {
    if (!isObj(p) || typeof p.ref !== 'string') return
    const kind = MEDIA.includes(p.kind as Media) ? (p.kind as Media) : 'image'
    const name = typeof p.name === 'string' ? p.name : p.ref
    names.set(id, p.ref)
    try {
      const res = await fetch(sceneFileUrl(newest.id, p.ref))
      const blob = res.ok ? await res.blob() : null
      const b64 = blob ? await toB64(blob) : null
      if (!blob || !b64) { lost.set(id, { file: p.ref, kind }); return }
      pool[id] = { id, name, kind, b64, url: URL.createObjectURL(blob) }
    } catch {
      lost.set(id, { file: p.ref, kind })
    }
  }))
  if (lost.size) {
    sc.cast = sc.cast.map((c) => {
      const gone = c.refs.filter((r) => lost.has(r.fileId))
      if (!gone.length) return c
      return { ...c, refs: c.refs.filter((r) => !lost.has(r.fileId)),
               missing: [...(c.missing ?? []), ...gone.map((r) => lost.get(r.fileId)!)] }
    })
    for (const k of Object.keys(sc.sources) as SourceKind[]) {
      sc.sources[k] = (sc.sources[k] ?? []).filter((id) => !lost.has(id))
    }
  }

  // The folder's bookkeeping is set before the store, so the store write below
  // reads as "already saved" to `startPersisting` rather than as a change.
  forgetFolder()
  lastIntent = intent
  refNames = names
  onVolume = new Set(rec.refs)
  loaded = {
    sceneId: newest.id,
    // `?? null`: a server from before the arrangement existed answers neither.
    project: isObj(rec.project) ? rec.project : null,
    openvideo: typeof rec.openvideo === 'string' ? rec.openvideo : null,
    project_error: typeof rec.project_error === 'string' ? rec.project_error : null,
  }
  lastProject = loaded.project === null ? '' : JSON.stringify(loaded.project)
  const takes = readTakes(intent.takes)
  useStore.setState((s) => ({
    scene: sc,
    pool: { ...s.pool, ...pool },
    shotSel: sc.shots[0]?.id ?? '',
    takes,
    sceneId: newest.id,
  }))
  lastWritten = JSON.stringify(intentOf(useStore.getState()).intent)
  if (lost.size) {
    loadFailed({
      error: `${String(lost.size)} reference file${lost.size === 1 ? '' : 's'} did not come `
        + `back from scene ${newest.id}; the cast card lists ${lost.size === 1 ? 'it' : 'them'} `
        + 'as missing until attached again.',
      detail: [...lost.values()].map((f) => f.file).join(', ') })
  }
}

/* ---- writing it -------------------------------------------------------- */

/** Nothing typed, nobody cast, nothing attached. A blank page is not a scene
 *  and must not mint a folder. */
function blank(sc: Scene): boolean {
  return sc.cast.length === 0
    && sc.style.trim() === '' && sc.grade.trim() === ''
    && Object.values(sc.sources).every((v) => !v.length)
    && sc.shots.every((x) => x.line.trim() === '' && !x.pills.length && x.say.text.trim() === '')
}

const worthSaving = (s: Store): boolean => s.takes.length > 0 || !blank(s.scene)

/** Pool ids something in the scene still points at. A file dropped and then
 *  detached is not uploaded — `refs/` holds what the scene uses, not every
 *  file that passed through it. */
function referenced(sc: Scene): Set<string> {
  const ids = new Set<string>()
  for (const c of sc.cast) for (const r of c.refs) ids.add(r.fileId)
  for (const v of Object.values(sc.sources)) for (const id of v) ids.add(id)
  return ids
}

/** An extension from the bytes, because the name a file arrived with is not
 *  what was kept: `shrinkB64` turns an oversized PNG into a JPEG. The route
 *  serves by extension, so a wrong one is an `<img>` told the wrong type. */
function extOf(f: PoolFile): string {
  const b = f.b64
  if (f.kind === 'image') {
    if (b.startsWith('/9j/')) return 'jpg'
    if (b.startsWith('UklGR')) return 'webp'
    return 'png'
  }
  if (f.kind === 'audio') {
    if (b.startsWith('SUQz') || b.startsWith('//')) return 'mp3'
    return 'wav'
  }
  if (b.startsWith('GkXfo')) return 'webm'
  return 'mp4'
}

/** `{i:02d}-{kind}.{ext}`, a character's naming, numbered in the order the
 *  scene first needed each file and never reused. */
function refNameFor(f: PoolFile): string {
  const had = refNames.get(f.id)
  if (had) return had
  const taken = new Set([...refNames.values(), ...onVolume])
  let i = refNames.size
  let name = ''
  do {
    name = `${String(i).padStart(2, '0')}-${f.kind}.${extOf(f)}`
    i += 1
  } while (taken.has(name))
  refNames.set(f.id, name)
  return name
}

/** The intent this page would write now, and the refs the folder lacks.
 *
 *  No trim, order or position goes in here — those are the arrangement's, and
 *  `SceneTake` has no field for them. A second copy would be a second record,
 *  and the day the two disagree nobody could say which one the scene is. */
function intentOf(s: Store): { intent: SceneIntent; refs: Record<string, string> } {
  const pool: Record<string, ScenePoolRef> = {}
  const refs: Record<string, string> = {}
  for (const id of referenced(s.scene)) {
    const f = s.pool[id]
    if (!f) continue
    const ref = refNameFor(f)
    pool[id] = { name: f.name, kind: f.kind, ref }
    if (!onVolume.has(ref)) refs[ref] = f.b64
  }
  return {
    intent: {
      ...lastIntent,
      scene: s.scene,
      pool,
      takes: s.takes,
      slots: isObj(lastIntent.slots) ? lastIntent.slots : {},
    },
    refs,
  }
}

let timer: number | undefined
let inFlight = false
let again = false

/** Write the scene now if it has changed. Safe to call at any time; a call
 *  while a save is out runs once more when that save returns. */
export async function saveIntent(): Promise<void> {
  if (inFlight) { again = true; return }
  const id = sceneIdFor(worthSaving(useStore.getState()))
  if (!id) return
  const { intent, refs } = intentOf(useStore.getState())
  const serial = JSON.stringify(intent)
  const sending = Object.keys(refs)
  if (serial === lastWritten && !sending.length) return
  const gen = generation
  inFlight = true
  publish()
  const r = await saveScene(id, { intent, ...(sending.length && { refs }) })
  inFlight = false
  if (failed(r)) {
    // The page keeps what it has — nothing is rolled back to match the volume
    // — and the next change, or the retry below, tries again.
    errors.intent = r
  } else {
    if (gen === generation) {
      for (const name of sending) onVolume.add(name)
      lastIntent = intent
      lastWritten = serial
    }
    landed('intent')
  }
  publish()
  if (again) {
    again = false
    schedule()
  }
}

function schedule(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => { void saveIntent() }, SAVE_DEBOUNCE_MS)
}

/**
 * Save every change to the scene, debounced. Call once, after
 * `loadLatestScene()` has settled. Returns the unsubscribe.
 *
 * Only `scene`, `pool` and `takes` are watched, by reference: the store changes
 * at pointer rate during a region drag, and none of that is a scene.
 *
 * **Clearing the takes starts a new scene.** `clearTakes` is what the canvas's
 * Clear does, and saving that into the same folder would erase the record of
 * every take it had — so the folder is left as it was and the next change
 * worth keeping mints a new one. The cast survives the clear on the page, so
 * the new folder starts with it and re-uploads its photographs; that copy is
 * the price of never rewriting a scene's history from a button that reads as
 * "start over".
 */
export function startPersisting(): () => void {
  const unsub = useStore.subscribe((s, prev) => {
    if (prev.takes.length > 0 && s.takes.length === 0) {
      window.clearTimeout(timer)
      // The old folder's last arrangement edit goes to the old folder, before
      // the id is dropped — otherwise it would be written into the new one.
      flushProject()
      forgetFolder()
      useStore.getState().setSceneId(null)
      if (worthSaving(useStore.getState())) schedule()
      return
    }
    if (s.scene !== prev.scene || s.pool !== prev.pool || s.takes !== prev.takes) schedule()
  })
  // A tab being closed or backgrounded does not wait out a debounce. Not a
  // guarantee — the request can still be cut off — but it turns "the last
  // 800ms are always lost" into "they usually are not".
  const onHide = (): void => {
    if (document.visibilityState === 'hidden' && timer !== undefined) {
      window.clearTimeout(timer)
      void saveIntent()
    }
  }
  document.addEventListener('visibilitychange', onHide)
  return () => {
    unsub()
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', onHide)
  }
}

/* ---- the arrangement --------------------------------------------------- */

let projectTimer: number | undefined
let projectInFlight = false
let projectAgain = false
/** Reads the live Core's `project.export()`; null while no timeline is up. */
let exportProject: (() => unknown) | null = null

/** One arrangement, exported, with the folder it belongs to. */
type Snap = { id: string; project: Record<string, unknown>; serial: string; gen: number }

/** Arrangements taken while a save was out — the latest per folder — written
 *  when it returns. A flush cannot wait for the export to be re-taken later:
 *  by then a Clear may have emptied the Core or a teardown dropped it. */
const parked = new Map<string, Snap>()

/** A project with no clips is an empty timeline, which is not a scene and must
 *  not mint a folder. The one field of the IProject the page reads. */
function hasClips(p: Record<string, unknown>): boolean {
  return isObj(p.clips) && Object.keys(p.clips).length > 0
}

/** The arrangement as it stands, if it differs from what was last written.
 *  Synchronous, so a caller about to change folders or drop the Core reads it
 *  first. It mints the folder id if the intent saver has not yet, even on a
 *  Clear: an arrangement nobody had saved is still work. */
function snapshot(): Snap | null {
  if (!exportProject) return null
  const project = exportProject()
  if (!isObj(project)) return null
  const serial = JSON.stringify(project)
  if (serial === lastProject) return null
  const id = sceneIdFor(hasClips(project))
  if (!id) return null
  return { id, project, serial, gen: generation }
}

/**
 * Write one arrangement, or park it behind the save in flight. The one place
 * the route is called, so the in-flight flag and the shared state never
 * disagree.
 */
async function write(snap: Snap): Promise<void> {
  if (projectInFlight) { parked.set(snap.id, snap); return }
  projectInFlight = true
  publish()
  const r = await postProject(snap.id, { openvideo: OPENVIDEO_PIN, project: snap.project })
  projectInFlight = false
  if (failed(r)) {
    // `lastProject` stays where it was, so the next change — which exports
    // something different from it — is the retry. The page is not rolled back.
    errors.project = r
  } else {
    landed('project')
    if (snap.gen === generation) lastProject = snap.serial
  }
  publish()
  const next = parked.values().next()
  if (!next.done) {
    parked.delete(next.value.id)
    await write(next.value)
  } else if (projectAgain) {
    projectAgain = false
    scheduleProject()
  }
}

/**
 * Write the arrangement now if it has changed. Safe to call at any time; a call
 * while a save is out runs once more when that save returns.
 *
 * Exported at save time rather than on every change, because the Core fires
 * far more often than a debounce lets through and an export walks every clip.
 */
export async function saveProject(): Promise<void> {
  if (projectInFlight) { projectAgain = true; return }
  const snap = snapshot()
  if (snap) await write(snap)
}

function scheduleProject(): void {
  window.clearTimeout(projectTimer)
  projectTimer = window.setTimeout(() => {
    projectTimer = undefined
    void saveProject()
  }, SAVE_DEBOUNCE_MS)
}

/** Take a pending edit now and write it to the folder it was made in. Called
 *  before the folder id changes and before the Core is dropped. */
function flushProject(): void {
  if (projectTimer === undefined && !projectAgain) return
  window.clearTimeout(projectTimer)
  projectTimer = undefined
  projectAgain = false
  const snap = snapshot()
  if (snap) void write(snap)
}

/**
 * Save the arrangement on every Core change, debounced, into the same folder
 * as the intent. Returns the detach, which writes a pending edit first — so
 * tearing a timeline down is never what loses its last trim.
 *
 * Takes the Core's subscribe and export as functions rather than a Core,
 * because naming the Core's type here would put the engine's shape in a
 * first-load module, and because it is all this needs:
 *
 *     attachProjectSaver((fn) => core.store.subscribe(fn), () => core.project.export())
 *
 * `core.store.subscribe` rather than `core.on('change')`: `studio.destroy()`
 * removes every listener on the Core, which would stop the saving silently.
 */
export function attachProjectSaver(
  subscribe: (onChange: () => void) => () => void,
  exportFn: () => unknown,
): () => void {
  exportProject = exportFn
  const unsub = subscribe(scheduleProject)
  // As the intent's: a closing tab does not wait out a debounce.
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') flushProject()
  }
  document.addEventListener('visibilitychange', onHide)
  return () => {
    unsub()
    document.removeEventListener('visibilitychange', onHide)
    flushProject()
    if (exportProject === exportFn) exportProject = null
  }
}

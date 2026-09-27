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
 */
import { create } from 'zustand'

import { failed, type ApiError } from '../api/client'
import { saveScene, scene as getScene, sceneFileUrl, scenes as listScenes } from '../api/routes'
import type { SceneIntent, ScenePoolRef } from '../api/types'
import { toB64 } from '../media/files'
import {
  newMember, newShot, SOURCE_TAKES,
  type CastMember, type Media, type PoolFile, type Scene, type Shot, type SourceKind,
} from '../scene/model'
import { useStore, type SceneTake, type Store } from '../store'

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

function forgetFolder(): void {
  lastIntent = {}
  refNames = new Map()
  onVolume = new Set()
  lastWritten = ''
  generation += 1
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
    useSaveState.setState({ error: {
      error: 'Could not list saved scenes, so this is a new one — the last '
        + 'scene is still on the volume.', detail: list.error } })
    return
  }
  const newest = list.scenes[0]
  if (!newest) return
  const passOver = (why: string, detail?: string): void => {
    useSaveState.setState({ error: {
      error: `Scene ${newest.id} could not be opened, so this is a new scene — `
        + `the folder is untouched. ${why}`, detail } })
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
    useSaveState.setState({ error: {
      error: `${String(lost.size)} reference file${lost.size === 1 ? '' : 's'} did not come `
        + `back from scene ${newest.id}; the cast card lists ${lost.size === 1 ? 'it' : 'them'} `
        + 'as missing until attached again.',
      detail: [...lost.values()].map((f) => f.file).join(', ') } })
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

/** The intent this page would write now, and the refs the folder lacks. */
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
  const s = useStore.getState()
  if (!s.sceneId) {
    if (!worthSaving(s)) return
    // Minted here, on the first change worth keeping, and not on load: a
    // visit that typed nothing leaves no folder behind.
    useStore.getState().setSceneId(newSceneId())
  }
  const id = useStore.getState().sceneId
  if (!id) return
  const { intent, refs } = intentOf(useStore.getState())
  const serial = JSON.stringify(intent)
  const sending = Object.keys(refs)
  if (serial === lastWritten && !sending.length) return
  const gen = generation
  inFlight = true
  useSaveState.setState({ saving: true })
  const r = await saveScene(id, { intent, ...(sending.length && { refs }) })
  inFlight = false
  if (failed(r)) {
    // The page keeps what it has — nothing is rolled back to match the volume
    // — and the next change, or the retry below, tries again.
    useSaveState.setState({ saving: false, error: r })
  } else {
    if (gen === generation) {
      for (const name of sending) onVolume.add(name)
      lastIntent = intent
      lastWritten = serial
    }
    useSaveState.setState({ saving: false, error: null })
  }
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

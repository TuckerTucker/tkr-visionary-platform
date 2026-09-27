import { useCallback, useEffect, useState } from 'react'

import { everyMs, failed, type ApiError } from '../api/client'
import { fileUrl, status, stop, video } from '../api/routes'
import type { JobStatus } from '../api/types'
import type { GalleryItem } from '../gallery/types'
import { readVidChips, stripLoras } from '../lora/tokens'
import { readShot, useStore, type SceneTake, type Store } from '../store'
import {
  chainLength, readScene, reanchorDue, sceneSeconds, shotSecs, shotsOf, splitScene, takeShots,
  typedProse, type Scene, type Shot,
} from '../scene/model'
import { resolveVid } from '../console/resolve'
import { mintSlotId } from '../edit/project'
import {
  chosenTake, clearSlotRun, clipOfSlot, expectLanding, lastV1Slot, peekLanding, setSlotRun,
  slotPlaying, takeLanding, useSlotRuns, type SlotTake, type SlotTarget,
} from '../edit/slots'
import { useEdit } from '../edit/useEdit'
import {
  arm, continueAtBody, continueAtFor, noteCut, outPointOf, snapNote, type Cut,
} from '../edit/continue'
import { insertStore } from '../edit/inherit'
import { insertCondition } from '../edit/stale'
import { frameAt } from './lastFrame'

/**
 * One clip, from press to playback.
 *
 * The same job/status/stop contract the image side uses, at the same 400ms. A second
 * video family lived on this exact contract for a while without adding a backend,
 * which is the claim worth keeping: what is per-family is a graph builder on the
 * server and a row in `VIDEO_MODELS`, and nothing here.
 *
 * The one thing that differs from `useGenerate` is what the phase says while nothing
 * is sampling yet. The first minutes of a video run are 42.5 GB loading onto the card,
 * with no step count to show — naming that beats a bar that sits at zero looking stuck.
 *
 * **Every run is aimed at a slot when it starts** (`edit/slots.ts`): Generate at a new
 * slot on the end of V1, or directly after the slot Continue was armed from; a slot's
 * own ↻ (`renderSlot`) back into that slot. Same job, same poll, same Stop — the aim is
 * only where the take goes when it lands, and `edit/useEdit` puts it there as one
 * command, so a render is on the same undo history as a trim.
 */
export type VideoRun = {
  running: boolean
  /** The clip on screen — the last run that *completed*. Not cleared when the next
   *  one starts: a new clip replaces the old one when it lands, not when it is asked
   *  for. It matters more here than on the image side, because a take is two to three
   *  minutes and blanking the canvas means the thing you were judging is gone for all
   *  of them. `finish` is the only thing that moves it. */
  jobId: string | null
  file: string | null
  /** The job being polled right now, which is *not* `jobId` until it completes. Two
   *  ids because the bytes on screen and the work in flight are two different clips
   *  during a run. */
  runId: string | null
  percent: number
  phase: string
  /** See `RunState.error`: the whole `ApiError`, so `ErrorNote` still has the
   *  server's report to fold away under the sentence. */
  error: string | ApiError | null
  meta: string[]
}

/** What a Generate sent, kept for when its take lands: the sentence, the
 *  shots left for the next generation, the composer's shots as they were (to
 *  tell whether anybody has written since), and the take's record. */
type Sent = { line: string; later: Shot[]; shots: Shot[]; record: TakeRecord }

const IDLE: VideoRun = {
  running: false, jobId: null, file: null, runId: null, percent: 0, phase: '',
  error: null, meta: [],
}

export function videoBody(s: Store): Record<string, unknown> {
  const r = resolveVid(s)
  // See `imageBody`: one string, keying both halves of the same request.
  const prompt = stripLoras(typedProse(s.scene))
  // Null when the scene is not live, and that is the contract rather than an
  // optimisation: no cast, one shot and nothing chosen, and the run is the typed
  // sentence byte-for-byte — the same document a prompt box would have produced,
  // because there is no document. Its three asset lists are what `<Picture N>`
  // numbers against, so they replace the flat trays whenever it is live.
  const sc = readScene(s.scene, s.pool)
  return {
    ...(sc && { scene: sc.scene }),
    // **The edit is what runs.** A document taken over by hand travels in its own
    // field rather than as `prompt`, because `prompt_typed` is the prose somebody
    // wrote and only the receipt is being overridden — folded together, Reuse
    // would load a six-field schema into the first shot's row and compile *that*
    // on the next run. See `SourcePane`.
    ...(s.doc !== null && { prompt_compiled: s.doc }),
    model: s.vid.model,
    prompt,
    // No negative prompt, no CFG and no flow shift: H3 is guidance-distilled
    // and reads none of them. They were here for a second family that did.
    aspect: s.vid.aspect,
    tier: r.tier,
    // The track is the clip's length once it has been authored. See
    // `sceneSeconds` — the duration menu keeps still-or-motion and nothing else.
    seconds: sceneSeconds(s.scene) ?? r.seconds,
    steps: s.vid.steps,
    seed: s.vid.seed,
    sampler: r.sampler,
    scheduler: r.scheduler,
    loras: readVidChips(s.loras, s.state?.max_loras ?? 6),
    shot: readShot(s.shot),
    ref_roles: sc ? [] : s.refRoles.slice(0, s.refs.length),
    // One anchor at a time. A motion continuation already answers "where does
    // this take open", so the first frame is withheld rather than sent beside
    // it — the route refuses the pair, and the page should never be the stale
    // tab that sends it. The frame is kept in the store as the fallback the
    // Motion tile clears back to.
    first_frame: s.continueFrom ? null : s.keyframe.first,
    last_frame: s.continueFrom ? null : s.keyframe.last,
    ...(s.continueFrom && { continue_from: s.continueFrom }),
    // Where the cut is, when the take was trimmed — read now, not when
    // Continue was pressed (see `edit/continue.ts`). Absent for a take played
    // to its end, which keeps an untrimmed continuation's body what it was.
    ...continueAtBody(s.continueFrom, useEdit.getState().project),
    // The cast's files when there is a cast, and the flat trays otherwise. Never
    // both: `<Picture N>` is a *position* in this array, so a cast ref pointing
    // at index 1 and a tray photo also sitting at index 1 is a well-formed
    // document naming somebody else's face.
    references: sc ? sc.references : s.refs,
    ref_videos: sc ? sc.ref_videos : s.refVids,
    ...(sc && { ref_audios: sc.ref_audios }),
    ref_size: s.vid.refSize,
    gpu: s.gpu.video,
  }
}

/* ---- one job, from its id to its end ------------------------------------ */

/** What the phase line says while a take is running. The first minutes of a
 *  take are the model loading, with no step count to show — naming that beats
 *  a bar at zero looking stuck. */
function phaseOf(st: JobStatus): string {
  return st.step
    ? `Step ${String(st.step)}/${String(st.total_steps ?? st.steps ?? '?')}`
      + (st.eta ? ` · ${String(st.eta)} left` : '')
    : (st.phase === 'loading' ? 'Loading the model…' : (st.phase || 'Working…'))
}

/** The meta line's account of a cut, when the take continued from one: where
 *  it opened and how far the snap moved it. Empty for every other take. */
function cutLine(st: JobStatus): string {
  const at = st.continued_at
  const snap = st.continue_snap
  if (typeof at !== 'number' || typeof snap !== 'number') return ''
  const cut: Cut = { requested: Number((at + snap).toFixed(3)), continuedAt: at, snap }
  return snapNote(cut)
}

type Ends = {
  progress: (percent: number, phase: string) => void
  completed: (st: JobStatus) => void
  failed: (error: string | undefined) => void
  stopped: () => void
}

/** Poll `runId` every 400ms until it ends — the image side's contract, and the
 *  only one a video job has, whether the canvas started it or a slot did. */
function poll(runId: string, ends: Ends): void {
  const t = everyMs(async () => {
    const st = await status(runId)
    if (failed(st)) return
    if (st.status === 'completed') {
      clearInterval(t)
      ends.completed(st)
    } else if (st.status === 'failed') {
      clearInterval(t)
      ends.failed(st.error)
    } else if (st.status === 'stopped') {
      clearInterval(t)
      ends.stopped()
    } else {
      ends.progress(Number(st.percent ?? 0), phaseOf(st))
    }
  }, 400)
}

/** What a run knows when it starts that its status will not say, written on
 *  the take when it lands. Every field is optional because most runs have
 *  only some of them, and a field nobody set is left off rather than written
 *  empty (a sidecar reader keeps what it does not model). */
type TakeRecord = Pick<SlotTake, 'shots' | 'from' | 'reanchored' | 'conditionedOn'>

/** The first generation of `scene` and the shots left after it — what a
 *  render sends and what the next one is for. See `splitScene`. */
function firstGeneration(scene: Scene, menu: string): { now: Scene; later: Shot[]; record: TakeRecord } {
  const { now, later } = splitScene(scene, shotSecs(scene, Number(menu)))
  return { now, later, record: { shots: takeShots(now, shotSecs(now, Number(menu))) } }
}

/** How often a chain re-anchors — served, so the page and the constant never
 *  disagree; 3 from a deployment that predates the field. */
const reanchorEvery = (s: Pick<Store, 'state'>): number => s.state?.h3mc_reanchor_takes ?? 3

/**
 * Whether a continuation of `from` opens from references instead of motion.
 *
 * **Every `H3MC_REANCHOR_TAKES`-th continuation re-anchors.** The motion
 * latent is a photocopy of the take before it, and the pack's README says the
 * losses compound down a chain with the sound dulling first — so a chain left
 * to run is a slow fade to mud that no single join shows. The re-anchored take
 * still opens on the frame at the source's out-point, so the picture joins;
 * what it gives up is the pinned motion and audio, for one take, in exchange
 * for the cast's references at full strength again.
 */
export function reanchors(s: Pick<Store, 'takes' | 'state'>, from: string | null): boolean {
  return !!from && reanchorDue(chainLength(s.takes, from), reanchorEvery(s))
}

/** The sentence a re-anchoring take is explained by, on the Motion tile while
 *  it is armed and on the meta line once it has landed. */
export function reanchorNote(s: Pick<Store, 'state'>): string {
  const n = reanchorEvery(s)
  return `Re-anchors: after ${String(n)} continuation${n === 1 ? '' : 's'} on the motion latent, this take `
    + "opens from the cast's references and the frame at the out-point instead — quality compounds "
    + 'down a chain, and the sound dulls first (the continuation pack’s README).'
}

/** The page's own landing handler — the gallery's `record` and the regions
 *  going back off the picture. Set by the `useVideo` the page mounts, so a take
 *  a slot rendered reaches the gallery exactly as one the canvas rendered. */
let pageLanded: ((it: GalleryItem) => void) | null = null

/**
 * A finished job, into the gallery and into the scene. Returns the file, or
 * null when the job reported none.
 *
 * Every generation is a link whether or not you go on to add another — a scene
 * with one take in it is just a scene you have not continued yet, which is what
 * keeps `Continue` from being a mode you enter. What the job said about the
 * file rides along, where it said it: the editor lays the first take out at its
 * size and holds a take that will not load at its length. Only numbers are kept
 * — a field the record did not carry is left off rather than written as a guess.
 *
 * `slot` is the slot the take was rendered for, written on the take itself —
 * the record of which takes a slot has had (see `edit/slots.ts`). `record` is
 * what the run knew when it started and the status does not say: the shots it
 * was rendered from, and the take it was made from.
 */
function landTake(
  st: JobStatus, jobId: string, line: string, slot: string | null, record: TakeRecord = {},
): string | null {
  const file = (st.files as string[] | undefined)?.[0] ?? null
  if (!file) return null
  // See useGenerate: the run reports itself rather than the page re-asking the
  // volume about work it just watched finish.
  pageLanded?.({ ...(st as Partial<GalleryItem>), job_id: jobId, kind: 'video',
                 files: [file], created: Date.now() / 1000 })
  const num = (k: string): { [key: string]: number } => {
    const v = st[k]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? { [k]: v } : {}
  }
  const take: SlotTake = {
    jobId, file, line,
    ...num('width'), ...num('height'), ...num('seconds'), ...num('frames'), ...num('fps'),
    ...(slot && { slot }),
    ...record,
  }
  useStore.getState().addTake(take)
  return file
}

/**
 * Arm the next Generate to continue `from` — by motion, and by its last frame.
 *
 * The frame is still read, even though motion is the anchor that runs: it is
 * what the Motion tile falls back to when cleared, and what the route's own
 * degrade points at when a latent has gone missing. Cheap — the bytes are
 * already in a <video> on the page.
 *
 * What does *not* carry is the prose. A take is a beat, and reopening on the
 * sentence you already rendered would invite editing the last one rather than
 * writing the next.
 *
 * `at` is the take's out-point when it was trimmed. The frame read is then the
 * one at the cut, not the file's last — so clearing the Motion tile, or the
 * route's degrade when the latent is gone, opens on what the person kept
 * rather than on the second they trimmed away.
 */
async function armContinue(
  from: Pick<SceneTake, 'jobId' | 'file'>, at: number | null = null, slotId: string | null = null,
): Promise<void> {
  const frame = await frameAt(fileUrl(from.jobId, from.file), at ?? Infinity)
  arm({ jobId: from.jobId, slotId, at, frame })
  const s = useStore.getState()
  s.setContinueFrom(from.jobId)
  s.setKeyframe('first', frame)
  // A first frame and a last frame together are `fl2va`, which would pin the
  // new take's ending to the old take's ending — the opposite of continuing.
  s.setKeyframe('last', null)
  s.setProse('')
  // After the commit, for the reason `applyWrite` waits: the field is
  // controlled, and focusing now would focus a node React is about to replace.
  requestAnimationFrame(() => document.getElementById('prompt')?.focus())
}

/**
 * Where a Generate started now lands. A fresh slot, always — minted here, when
 * the person pressed the button, because that is when they said it. With a
 * continuation armed it goes directly after the slot playing the take it
 * continues (`slot.continue`), or after the last V1 slot if that take is no
 * longer in the cut; otherwise on the end of V1.
 */
function generateTarget(s: Store): SlotTarget {
  const project = useEdit.getState().project
  const slotId = mintSlotId(project)
  const from = s.continueFrom ? (slotPlaying(project, s.continueFrom) ?? lastV1Slot(project)) : null
  return from ? { kind: 'continue', slotId, from } : { kind: 'append', slotId }
}

export function useVideo(onLanded: (it: GalleryItem) => void) {
  const [run, setRun] = useState<VideoRun>(IDLE)
  /** Reading the last frame out of the clip takes a decode, so it is a state a
   *  button can show rather than a promise nobody can see. Declared here with
   *  `run` rather than beside `chain`: every hook in this file is above the
   *  first callback, which is the arrangement that cannot be misread. */
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    pageLanded = onLanded
    return () => { if (pageLanded === onLanded) pageLanded = null }
  }, [onLanded])

  const finish = useCallback((st: JobStatus, jobId: string, sent: Sent) => {
    const file = (st.files as string[] | undefined)?.[0] ?? null
    noteCut(jobId, {}, st)
    const meta = [
      sent.record.reanchored ? reanchorNote(useStore.getState()) : '',
      cutLine(st),
      st.width ? `${String(st.width)}×${String(st.height)}` : '',
      st.seconds ? `${String(st.seconds)}s · ${String(st.frames)} frames · ${String(st.fps)} fps` : '',
      st.seed != null ? `seed ${String(st.seed)}` : '',
      st.steps ? `${String(st.steps)} steps` : '',
      st.duration_s ? `${String(st.duration_s)}s` : '',
    ].filter(Boolean)
    // Atomically, so there is never a frame pairing the old jobId with the new file.
    setRun((p) => ({
      ...p, running: false, jobId, file, runId: null, percent: 100, phase: '',
      error: null, meta,
    }))
    const slot = peekLanding(jobId)?.slotId ?? null
    // The sentence that was sent, not the composer's now: it may have moved on
    // to the next beat during the minutes this rendered.
    if (!landTake(st, jobId, sent.line, slot, sent.record) || !file || !sent.later.length) return
    // **The rest of the scene is the next Generate, and nothing renders on its
    // own.** Continue is armed from the take that just landed and the composer
    // holds the shots still to render, so the pending slots after V1 are the
    // remainder and one press renders the next generation as a continuation.
    // Only when the composer is still what was sent: a sentence somebody wrote
    // while this rendered is theirs, and arming clears the prose.
    if (useStore.getState().scene.shots !== sent.shots) return
    void (async () => {
      setLinking(true)
      await armContinue({ jobId, file }, null, slot)
      setLinking(false)
      useStore.getState().setLaterShots(sent.later)
    })()
  }, [])

  const start = useCallback(async () => {
    const s = useStore.getState()
    if (!stripLoras(typedProse(s.scene))) return
    // **One generation per render.** The whole scene used to go with its
    // seconds summed, the server clamped the frames to one generation, and the
    // document's `[Shot N]` cut times ran past the end of the clip it made —
    // shots that were asked for and silently never rendered.
    const { now, later, record } = firstGeneration(s.scene, s.vid.seconds)
    const from = s.continueFrom
    const reanchor = reanchors(s, from)
    const sent: Sent = {
      line: typedProse(now), later, shots: s.scene.shots,
      record: {
        ...record,
        ...(from && { from, conditionedOn: from }),
        ...(reanchor && { reanchored: true }),
      },
    }
    // Keep the last clip on screen and overlay a progress state on it — see `jobId`
    // above. A cold first run has nothing to keep and shows the full placeholder.
    setRun((p) => ({
      ...p, running: true, runId: null, percent: 0, phase: 'Queued…', error: null,
    }))
    const target = generateTarget(s)
    // Re-anchoring is a continuation without the latent: `continue_from` and
    // `continue_at` go, and the frame Continue read at the out-point — kept as
    // the first frame all along — is what it opens on, beside the references.
    const body = videoBody({ ...s, scene: now, ...(reanchor && { continueFrom: null }) })
    const r = await video(body)
    if (failed(r)) {
      // The last clip stays: a request that never started should not blank what you
      // were watching. The whole `ApiError` — see `useGenerate`, same reason.
      setRun((p) => ({ ...p, running: false, runId: null, error: r }))
      return
    }
    const runId = r.job_id
    // The route answers the snap before a GPU is rented — pure arithmetic on
    // the source's record — so the Motion tile can say where the cut landed
    // for the whole length of the render rather than only once it is over.
    noteCut(runId, body, r as Record<string, unknown>)
    expectLanding(runId, target)
    setRun((p) => ({ ...p, runId }))
    poll(runId, {
      progress: (percent, phase) => setRun((p) => ({ ...p, running: true, percent, phase })),
      // The take it continued, as sent — the status does not name it, and
      // staleness (edit/stale.ts) walks it.
      completed: (st) => finish(st, runId, sent),
      // See `useGenerate` for why the bare fallback went. The advice differs on
      // this side because the failures do: a clip is the run that dies on card
      // memory, and duration is the one lever in the strip that changes how much
      // of it the run asks for.
      failed: (error) => {
        takeLanding(runId)
        setRun((p) => ({
          ...p, running: false, runId: null,
          error: error
            || 'The clip failed and the job gave no reason — press Generate to try'
               + ' again, or pick a shorter duration if it keeps failing.',
        }))
      },
      // The previous clip coming back is the feedback — there is nothing to say
      // that the returned picture does not already say.
      stopped: () => {
        takeLanding(runId)
        setRun((p) => ({ ...p, running: false, runId: null, phase: '' }))
      },
    })
  }, [finish])

  const cancel = useCallback(async () => {
    if (!run.runId) return
    setRun((p) => ({ ...p, phase: 'Stopping…' }))
    await stop(run.runId)
  }, [run.runId])

  /** The canvas only. The prompt, the pills, the boxes and the settings are all still
   *  what you were working on — this clears the result, which is the one thing "clear"
   *  can mean when everything else is an input you are mid-edit of. */
  const clear = useCallback(() => { setRun(IDLE); useStore.getState().clearTakes() }, [])

  /**
   * The next generation of the same scene — `slot.continue` from the last slot
   * on V1.
   *
   * **What carries is context, not a capability.** The cast, their photographs,
   * their voices, the look and the LoRAs are all untouched — they belong to the
   * scene and never belonged to a take — so the only thing asked of H3 is the
   * same characters again, plus whoever is new. That is the whole of chaining.
   *
   * The last frame of what just rendered becomes the next take's first frame,
   * which is what makes two generations read as one continuous scene instead of
   * two clips of the same people. It also promotes the task to `i2va` on its own,
   * through machinery that already existed and had nothing feeding it.
   *
   * **It is best-effort.** A codec the browser will not decode yields no frame,
   * and the next take simply opens cold rather than refusing to start — the
   * continuity is the point, not a precondition.
   *
   * **What it continues is the take the cut ends on**, when the editor is open:
   * the last V1 slot's chosen take, which after ‹ › is not necessarily the take
   * the canvas last showed. Continuing the one on the canvas would carry motion
   * out of a take that is not in the cut.
   */
  const chain = useCallback(async () => {
    const project = useEdit.getState().project
    const last = lastV1Slot(project)
    const cut = last ? chosenTake(useStore.getState().takes, last, project) : null
    const from = cut ?? (run.jobId && run.file ? { jobId: run.jobId, file: run.file } : null)
    if (!from) return
    // The out-point only when the take came from the cut: the canvas's own
    // take has no clip, so it has no trim, so it continues from its end.
    const clip = cut && last ? clipOfSlot(project, last) : null
    setLinking(true)
    await armContinue(from, clip ? outPointOf(clip, project?.settings.fps) : null, cut ? last : null)
    setLinking(false)
  }, [run.jobId, run.file])

  return { run, start, cancel, clear, chain, linking }
}

/* ---- a slot's own render ------------------------------------------------- */

/**
 * The body of a render into a slot: the composer as it stands, or — when the
 * prompt is empty — the sentence of the take the slot is showing, which is the
 * common case: *that shot again*.
 *
 * A continuation armed for Generate is not this render's, so it is not sent:
 * re-rendering slot 2 is not "continue from whatever Continue last pointed at".
 * The first frame goes with it, because while a continuation is armed that
 * frame is the continuation's.
 */
function slotBody(s: Store, line: string | null): Record<string, unknown> {
  const base = videoBody({
    ...s, continueFrom: null,
    keyframe: s.continueFrom ? { first: null, last: null } : s.keyframe,
  })
  if (line === null) return base
  // The scene document is the composer's, and the composer is empty: sending it
  // would compile nothing and discard the sentence this render is for.
  const body: Record<string, unknown> = { ...base, prompt: stripLoras(line) }
  delete body.scene
  delete body.prompt_compiled
  return body
}

/**
 * A slot's take made again *as a continuation*, in its own slot: the take it
 * continues (by job id) and the take being made again — whose sentence and
 * length it keeps, because it is the same beat, from a source that changed.
 */
export type SlotContinuation = { continueFrom: string; take: SlotTake }

/**
 * The body of a continuation rendered into its own slot — the stale offer's.
 *
 * The composer is not read: what is being made is `take` again, so its
 * sentence is the prompt and its recorded length is the length. The
 * continuation is this render's own, not the one armed for Generate, so its
 * out-point is read off the source's clip now, exactly as Generate reads it.
 * Re-anchoring applies as it does to Generate: when due, no latent, and the
 * frame at the source's out-point (`frame`) is the first frame.
 */
function continuationBody(
  s: Store, cont: SlotContinuation, reanchor: boolean, frame: string | null,
): Record<string, unknown> {
  const base = videoBody({
    ...s,
    continueFrom: reanchor ? null : cont.continueFrom,
    keyframe: { first: reanchor ? frame : null, last: null },
  })
  const recorded = shotsOf(cont.take)
  const seconds = recorded ? recorded.reduce((n, x) => n + x.beats, 0) : cont.take.seconds
  const body: Record<string, unknown> = {
    ...base, prompt: stripLoras(cont.take.line), ...(seconds && { seconds }),
  }
  delete body.scene
  delete body.prompt_compiled
  return body
}

/**
 * Render a slot again — slot.render's first half. Starts an ordinary
 * `/api/video` job, marks the slot as rendering (page state, not an edit), and
 * aims the take at the slot, where `edit/useEdit` puts it with one command
 * when it lands. Nothing about the job/status/stop contract differs from
 * Generate's; a slot is where the take goes, not a second way to make one.
 *
 * One render per slot at a time: a second press while one runs does nothing,
 * because two takes racing into one clip would land in whichever order the GPU
 * finished and the person would not know which one they were looking at.
 *
 * A composer longer than one generation renders its first generation here,
 * for the reason Generate does: a slot is one generation, and the rest would be
 * cut times past the end of the clip.
 *
 * With `cont` it renders `cont.take` again continued from `cont.continueFrom`,
 * *into this slot* — the stale offer for a continuation. It lands through the
 * same `slot.render` swap, so one undo puts the stale take back; before, the
 * offer armed Continue and Generate landed a second slot beside the stale one.
 */
export async function renderSlot(slotId: string, cont: SlotContinuation | null = null): Promise<void> {
  if (useSlotRuns.getState()[slotId]?.running) return
  const s = useStore.getState()
  const project = useEdit.getState().project
  const current = chosenTake(s.takes, slotId, project)
  const typed = typedProse(s.scene)
  const own = !cont && !!stripLoras(typed)
  const said = cont ? cont.take.line : own ? typed : (current?.line ?? '')
  if (!stripLoras(said)) {
    setSlotRun(slotId, {
      running: false, runId: null, phase: '',
      error: 'Nothing to render: this slot has no sentence and the prompt is empty. '
        + 'Write what happens in this take, then render the slot.',
    })
    return
  }
  setSlotRun(slotId, { running: true, runId: null, percent: 0, phase: 'Queued…', error: null })
  // An insert renders with what it inherited, not the scene's cast as it
  // stands now — see `edit/inherit.ts`. Null for every other slot.
  const ins = cont ? null : await insertStore(slotId, s, own ? null : said)
  if (ins && failed(ins)) {
    setSlotRun(slotId, { running: false, runId: null, phase: '', error: ins })
    return
  }
  let line = said
  let body: Record<string, unknown>
  let record: TakeRecord
  if (cont) {
    const reanchor = reanchors(s, cont.continueFrom)
    let frame: string | null = null
    if (reanchor) {
      setSlotRun(slotId, { phase: 'Reading the frame at the cut…' })
      const src = s.takes.find((t) => t.jobId === cont.continueFrom)
      const at = continueAtFor(cont.continueFrom, project)
      frame = src ? await frameAt(fileUrl(src.jobId, src.file), at ?? Infinity) : null
    }
    body = continuationBody(s, cont, reanchor, frame)
    const shots = shotsOf(cont.take)
    record = {
      from: cont.continueFrom, conditionedOn: cont.continueFrom,
      ...(reanchor && { reanchored: true }), ...(shots && { shots }),
    }
  } else if (ins || own) {
    const from = ins ? ins.store : s
    const { now, record: rec } = firstGeneration(from.scene, from.vid.seconds)
    body = slotBody({ ...from, scene: now }, null)
    line = ins ? said : typedProse(now)
    // The V1 take an insert opens on the frame of, read as the render starts —
    // what the landed take was made from (edit/stale.ts).
    const on = ins ? insertCondition(project, slotId) : null
    record = { ...rec, ...(on && { conditionedOn: on }) }
  } else {
    body = slotBody(s, said)
    // That take again: its recorded shots are what this render asks for.
    const shots = current ? shotsOf(current) : null
    record = shots ? { shots } : {}
  }
  const r = await video(body)
  if (failed(r)) {
    // Verbatim, on the slot: the route's refusal is the sentence that says
    // what to change, and a paraphrase of it is one fact short.
    setSlotRun(slotId, { running: false, runId: null, phase: '', error: r })
    return
  }
  const runId = r.job_id
  // A continuation's snap, filed against its source so the landing moves the
  // source's out-point to meet it — the same record Generate's makes.
  noteCut(runId, body, r as Record<string, unknown>)
  expectLanding(runId, { kind: 'render', slotId })
  setSlotRun(slotId, { runId })
  poll(runId, {
    progress: (percent, phase) => setSlotRun(slotId, { running: true, percent, phase }),
    completed: (st) => {
      noteCut(runId, {}, st)
      // Still running as far as the slot is concerned: the file has to be read
      // before it can replace anything. `useEdit` clears this when it lands.
      setSlotRun(slotId, { running: true, runId: null, percent: 100, phase: 'Placing the take…' })
      if (!landTake(st, runId, line, slotId, record)) {
        takeLanding(runId)
        setSlotRun(slotId, {
          running: false, phase: '',
          error: `Job ${runId} finished without a file, so the slot keeps the take it had.`,
        })
      }
    },
    failed: (error) => {
      takeLanding(runId)
      setSlotRun(slotId, {
        running: false, runId: null, phase: '',
        error: error
          || `Job ${runId} failed and gave no reason. The slot keeps the take it had; `
             + 'render it again, or shorten the take if it keeps failing.',
      })
    },
    // The slot still showing the take it had is the feedback.
    stopped: () => { takeLanding(runId); clearSlotRun(slotId) },
  })
}

/** Stop a slot's render — `/api/stop`, cooperative, the same as Generate's. */
export async function stopSlot(slotId: string): Promise<void> {
  const runId = useSlotRuns.getState()[slotId]?.runId
  if (!runId) return
  setSlotRun(slotId, { phase: 'Stopping…' })
  await stop(runId)
}

/**
 * Continue from a slot — slot.continue's first half. Arms the next Generate
 * from the take the slot is showing, exactly as the canvas's Continue does;
 * the take that renders lands directly after this slot, moving the rest of the
 * track along, as one undo.
 *
 * Two gestures rather than one because the prose does not carry: the next take
 * is a new beat, and there is nothing to render until it has been written.
 */
export async function continueSlot(slotId: string): Promise<void> {
  const project = useEdit.getState().project
  const take = chosenTake(useStore.getState().takes, slotId, project)
  if (!take) return
  const clip = clipOfSlot(project, slotId)
  await armContinue(take, clip ? outPointOf(clip, project?.settings.fps) : null, slotId)
}

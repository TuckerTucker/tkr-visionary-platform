import { useCallback, useEffect, useState } from 'react'

import { everyMs, failed, type ApiError } from '../api/client'
import { fileUrl, status, stop, video } from '../api/routes'
import type { JobStatus } from '../api/types'
import type { GalleryItem } from '../gallery/types'
import { readVidChips, stripLoras } from '../lora/tokens'
import { readShot, useStore, type SceneTake, type Store } from '../store'
import { readScene, sceneSeconds, typedProse } from '../scene/model'
import { resolveVid } from '../console/resolve'
import { mintSlotId } from '../edit/project'
import {
  chosenTake, clearSlotRun, clipOfSlot, expectLanding, lastV1Slot, peekLanding, setSlotRun,
  slotPlaying, takeLanding, useSlotRuns, type SlotTake, type SlotTarget,
} from '../edit/slots'
import { useEdit } from '../edit/useEdit'
import { arm, continueAtBody, noteCut, outPointOf, snapNote, type Cut } from '../edit/continue'
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
    ...continueAtBody(s.continueFrom),
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
 * the record of which takes a slot has had (see `edit/slots.ts`).
 */
function landTake(st: JobStatus, jobId: string, line: string, slot: string | null): string | null {
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

  const finish = useCallback((st: JobStatus, jobId: string) => {
    const file = (st.files as string[] | undefined)?.[0] ?? null
    noteCut(jobId, {}, st)
    const meta = [
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
    landTake(st, jobId, typedProse(useStore.getState().scene), peekLanding(jobId)?.slotId ?? null)
  }, [])

  const start = useCallback(async () => {
    const s = useStore.getState()
    if (!stripLoras(typedProse(s.scene))) return
    // Keep the last clip on screen and overlay a progress state on it — see `jobId`
    // above. A cold first run has nothing to keep and shows the full placeholder.
    setRun((p) => ({
      ...p, running: true, runId: null, percent: 0, phase: 'Queued…', error: null,
    }))
    const target = generateTarget(s)
    const body = videoBody(s)
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
      completed: (st) => finish(st, runId),
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
 * Render a slot again — slot.render's first half. Starts an ordinary
 * `/api/video` job, marks the slot as rendering (page state, not an edit), and
 * aims the take at the slot, where `edit/useEdit` puts it with one command
 * when it lands. Nothing about the job/status/stop contract differs from
 * Generate's; a slot is where the take goes, not a second way to make one.
 *
 * One render per slot at a time: a second press while one runs does nothing,
 * because two takes racing into one clip would land in whichever order the GPU
 * finished and the person would not know which one they were looking at.
 */
export async function renderSlot(slotId: string): Promise<void> {
  if (useSlotRuns.getState()[slotId]?.running) return
  const s = useStore.getState()
  const current = chosenTake(s.takes, slotId, useEdit.getState().project)
  const typed = typedProse(s.scene)
  const line = stripLoras(typed) ? typed : (current?.line ?? '')
  if (!stripLoras(line)) {
    setSlotRun(slotId, {
      running: false, runId: null, phase: '',
      error: 'Nothing to render: this slot has no sentence and the prompt is empty. '
        + 'Write what happens in this take, then render the slot.',
    })
    return
  }
  setSlotRun(slotId, { running: true, runId: null, percent: 0, phase: 'Queued…', error: null })
  const r = await video(slotBody(s, stripLoras(typed) ? null : line))
  if (failed(r)) {
    // Verbatim, on the slot: the route's refusal is the sentence that says
    // what to change, and a paraphrase of it is one fact short.
    setSlotRun(slotId, { running: false, runId: null, phase: '', error: r })
    return
  }
  const runId = r.job_id
  expectLanding(runId, { kind: 'render', slotId })
  setSlotRun(slotId, { runId })
  poll(runId, {
    progress: (percent, phase) => setSlotRun(slotId, { running: true, percent, phase }),
    completed: (st) => {
      // Still running as far as the slot is concerned: the file has to be read
      // before it can replace anything. `useEdit` clears this when it lands.
      setSlotRun(slotId, { running: true, runId: null, percent: 100, phase: 'Placing the take…' })
      if (!landTake(st, runId, line, slotId)) {
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

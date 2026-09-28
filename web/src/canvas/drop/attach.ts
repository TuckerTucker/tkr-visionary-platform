import { shrinkB64, toB64, unreadable } from '../../media/files'
import { live } from '../../scene/model'
import { supports, useStore, type Store } from '../../store'

/**
 * What a picture given to a take can be for, and whether the take can use it now.
 *
 * One module for both ways in — a drop zone on the canvas and a tile in the console —
 * because the rules are the run's rules, not the surface's: keyframes and references
 * load different transformers, so while one is in play the other is out, and a
 * surface that accepted a picture the run would then ignore is the broken promise
 * every drop target on this page is written against.
 */
export type Role = 'first' | 'last' | 'reference'

/**
 * Why `role` cannot take a picture right now, or null when it can. The sentence names
 * what to clear, because every one of these is a state somebody made and can unmake.
 *
 * - A keyframe is out while references are attached — references win when both are,
 *   because that is what the run does — and while the take continues the last one's
 *   motion, whose pinned context already decides how it opens.
 * - A reference is out while a keyframe is set and no reference is, which is exactly
 *   where SourceRow's tray goes dim; and when the model reads none.
 */
export function outOfPlay(s: Store, role: Role): string | null {
  const sup = supports(s)
  if (role === 'reference') {
    if (!sup.references) return 'This model takes no references — MiniMax-H3 does.'
    const framed = !!(s.keyframe.first || s.keyframe.last)
    if (framed && !s.refs.length && !s.refVids.length) {
      return 'A keyframe is set, and a take opens on a frame or on references, not both — '
        + 'clear the keyframe to add references.'
    }
    return null
  }
  if (role === 'last' && !sup.last_frame) return 'This model takes a first frame only.'
  if (s.refs.length || s.refVids.length) {
    return 'References are attached, and they win — a keyframe would be ignored. '
      + 'Remove the references to open on a frame.'
  }
  if (s.continueFrom) {
    return 'This take continues the last one’s motion — clear the Motion tile to open on '
      + 'a frame instead.'
  }
  return null
}

/** A keyframe, or the reason it is not one. */
export async function setFrame(at: 'first' | 'last', f: File): Promise<string | null> {
  if (!f.type.startsWith('image/')) return `A ${at} frame is an image.`
  const b = await toB64(f)
  if (!b) return unreadable(f)
  useStore.getState().setKeyframe(at, b)
  return null
}

/**
 * Appends what decodes to the flat reference tray, up to the cap, and answers with what
 * it could not take.
 *
 * Refused outright while a scene is composed: `videoBody` then sends the cast's files
 * and never the tray, so a picture appended here would look attached and never reach
 * the run.
 */
export async function addReferences(files: File[]): Promise<string | null> {
  // Re-read the bucket and the cap at drop time rather than closing over them: both
  // arrays are replaced wholesale by Reuse and by a model change dropping references it
  // cannot take, so a captured array would be pushed into a detached one.
  const st = useStore.getState()
  if (live(st.scene)) {
    return 'This scene has a cast — a reference belongs to somebody in it. Drop it on '
      + 'their card.'
  }
  const imgs = files.filter((f) => f.type.startsWith('image/'))
  const vids = files.filter((f) => f.type.startsWith('video/'))
  if (!imgs.length && !vids.length) return 'A reference is an image or a video.'
  const said = [
    imgs.length ? await append('img', imgs) : null,
    vids.length ? await append('vid', vids) : null,
  ].filter(Boolean)
  return said.length ? said.join(' ') : null
}

async function append(kind: 'img' | 'vid', files: File[]): Promise<string | null> {
  const st = useStore.getState()
  const isImg = kind === 'img'
  const noun = isImg ? 'image' : 'video'
  const bucket = isImg ? st.refs : st.refVids
  const max = isImg ? (st.state?.max_refs ?? 9) : (st.state?.max_ref_videos ?? 3)
  if (bucket.length >= max) {
    return `${max} ${noun} references is the model’s limit — remove one to add another.`
  }
  const out = [...bucket]
  const room = max - bucket.length
  const unread: File[] = []
  for (const f of files.slice(0, room)) {
    // Images go through the same shrink the region photos do, for the payload half of
    // the reason H3_REF_MAX_SIDE gives: nine photographs straight off a phone is tens of
    // megabytes of base64 in one JSON body. The server caps them again on arrival and
    // that is the copy that binds. Videos are sent whole: nothing here re-encodes one.
    const b = await (isImg ? shrinkB64(f) : toB64(f))
    // `null` is a file the canvas could not decode. Pushed anyway it would be a chip with
    // no picture and a base64 of "null" in the request, which fails on the GPU rather
    // than on the file it came from.
    if (b) out.push(b)
    else unread.push(f)
  }
  if (isImg) st.setRefs(out)
  else st.setRefVids(out)
  // Both said, in one sentence: a drop of twelve onto a cap of nine used to keep nine
  // and say nothing about the other three, which reads as the tray losing pictures.
  const said = [
    unread.length && unreadable(unread[0]!, noun) + (unread.length > 1
      ? ` (and ${unread.length - 1} more)` : ''),
    files.length > room && `${files.length - room} left out — ${max} ${noun} references is the model’s limit.`,
  ].filter(Boolean)
  return said.length ? said.join(' ') : null
}

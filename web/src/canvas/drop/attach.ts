import { shrinkB64, toB64, unreadable } from '../../media/files'
import { live, slotFor } from '../../scene/model'
import { intake, mediaOf } from '../../scene/pool'
import { supports, useStore, type Store } from '../../store'
import { refBudget } from '../../video/refBudget'

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
  // Pictures that will travel as references, counted the way `videoBody` sends them —
  // the cast's files while a scene is composed, the flat tray otherwise. Reading the
  // tray alone called a composed scene reference-free with nine photographs on its cast.
  const b = refBudget(s)
  const referenced = b.images + b.videos > 0
  if (role === 'reference') {
    if (!sup.references) return 'This model takes no references — MiniMax-H3 does.'
    const framed = !!(s.keyframe.first || s.keyframe.last)
    if (framed && !referenced) {
      return 'A keyframe is set, and a take opens on a frame or on references, not both — '
        + 'clear the keyframe to add references.'
    }
    return null
  }
  if (role === 'last' && !sup.last_frame) return 'This model takes a first frame only.'
  if (referenced) {
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
 * A reference, landed where the run will read it, and the answer with what could not be
 * taken.
 *
 * **While a scene is composed, a reference is somebody.** `videoBody` then sends the
 * cast's files and never the flat tray, so a picture appended to the tray would look
 * attached and never reach the run. So the drop makes a cast member holding it, through
 * the composer's own intake — the same member `+ Subject` makes, with its card open.
 * It is named for you, because an unnamed member is left out of the payload (`named`)
 * and its pictures would never travel: the file's own name when it reads like one,
 * `subject` otherwise — visible on the open card and one edit from right, which is the
 * veto list's answer to a question worth not asking. One member per
 * drop, holding every file in it: several photographs of one person is the drop people
 * make, and the guide's own sentence is that one subject may be defined by several
 * references.
 */
export async function addReferences(files: File[]): Promise<string | null> {
  // Re-read the bucket and the cap at drop time rather than closing over them: both
  // arrays are replaced wholesale by Reuse and by a model change dropping references it
  // cannot take, so a captured array would be pushed into a detached one.
  const st = useStore.getState()
  if (live(st.scene)) return castFrom(files)
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

/** See `addReferences`: a composed scene's reference, as a new cast member. */
async function castFrom(files: File[]): Promise<string | null> {
  const usable = files.filter((f) => mediaOf(f.type))
  if (!usable.length) return 'A reference is an image, a video or a recording.'
  const got = await Promise.all(usable.map(async (f) => ({ f, file: await intake(f) })))
  const read = got.filter((g) => g.file)
  const unread = got.filter((g) => !g.file).map((g) => g.f)
  const said = unread.length
    ? unreadable(unread[0]!, mediaOf(unread[0]!.type) === 'video' ? 'video' : 'image')
      + (unread.length > 1 ? ` (and ${unread.length - 1} more)` : '')
    : null
  // Nothing decoded, so nobody is made: an empty member is a name with no picture, and
  // the drop was a picture.
  if (!read.length) return said
  const st = useStore.getState()
  const member = st.addCast('subject', nameFor(read[0]!.f))
  for (const { file } of read) {
    const slot = slotFor(member.kind, file!.kind)
    if (!slot) continue
    st.addFile(file!)
    st.attachSlot(member.id, file!.id, slot)
  }
  st.setRailOpen(member.id)
  return said
}

/** `maya.jpg` is Maya; `IMG_2034.HEIC` is nobody, and `@img_2034` in a shot would be
 *  worse than an honest placeholder. */
function nameFor(f: File): string {
  const stem = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return /^[A-Za-z][A-Za-z ']{1,23}$/.test(stem) && !/^(img|dsc|image|photo|screenshot)\b/i.test(stem)
    ? stem : 'subject'
}

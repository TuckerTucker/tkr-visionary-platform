import { characterFileUrl, characters, saveCharacter } from '../api/routes'
import { failed } from '../api/client'
import { useStore } from '../store'
import { intake } from './pool'
import type { CastMember } from './model'

/**
 * The Arsenal's first shelf: characters, saved deliberately, recalled by name.
 *
 * Saving is a choice and never a side effect — "it never remembers unless
 * told" — and recall is the gesture that already exists: typing `@ma…` offers
 * `maya — saved` beside "New subject", so the library never grows a browser
 * panel. The drawer rule, kept: the name you are already typing is the recall.
 *
 * What travels is the pool's own bytes. `PoolFile.b64` is exactly what a run
 * uploads, so a save costs no re-encode — and a recall walks back through
 * `intake`, which is what keeps the content-keyed pool honest: a character
 * recalled twice, or recalled beside her own original photograph, still
 * resolves to one entry per picture.
 */

export type SavedRef = { file: string; kind: string; note?: string; sheet?: boolean }
export type SavedCharacter = {
  handle: string
  note: string
  retention: string
  refs: SavedRef[]
}

/** The saved cast, for the picker. A popover-speed listing — names, notes and
 *  filenames; never bytes. */
export async function listCharacters(): Promise<SavedCharacter[]> {
  const r = await characters()
  if (failed(r) || !Array.isArray((r as { characters?: unknown }).characters)) return []
  return (r as { characters: SavedCharacter[] }).characters
}

/** Save one member, whole. Resolves to an error sentence or null. */
export async function save(member: CastMember): Promise<string | null> {
  const pool = useStore.getState().pool
  const refs = member.refs.flatMap((r) => {
    const f = pool[r.fileId]
    if (!f) return []
    return [{ kind: f.kind, b64: f.b64,
              ...(r.note ? { note: r.note } : {}),
              ...(r.sheet ? { sheet: true } : {}) }]
  })
  const r = await saveCharacter(member.name, {
    note: member.note, retention: member.retention, refs,
  })
  return failed(r) ? r.error : null
}

/**
 * Rebuild a saved character into the live cast, files and all.
 *
 * The member is created synchronously by the caller — the picker needs a handle
 * to insert at the caret *now* — and this hydrates it: each file fetched off
 * its route, walked through `intake` so it lands in the pool exactly as a
 * dropped file would, then attached with its note and its sheet mark.
 *
 * A file that does not come back is recorded on the member, not skipped. It
 * used to be skipped, on the theory that three of four files is still a
 * character — and it is, just not the one that was saved: the remaining set
 * compiles to a valid document and renders somebody plausible. `missing` is
 * what the validator refuses by name and the card lists.
 */
export async function hydrate(memberId: string, saved: SavedCharacter): Promise<void> {
  const st = useStore.getState()
  if (saved.note) st.patchCast(memberId, { note: saved.note })
  if (saved.retention) st.patchCast(memberId, { retention: saved.retention })
  const missing: { file: string; kind: string }[] = []
  for (const ref of saved.refs) {
    const lost = () => { missing.push({ file: ref.file, kind: ref.kind }) }
    try {
      const res = await fetch(characterFileUrl(saved.handle, ref.file))
      if (!res.ok) { lost(); continue }
      const blob = await res.blob()
      const got = await intake(new File([blob], ref.file, { type: blob.type }))
      if (!got) { lost(); continue }
      const now = useStore.getState()
      now.addFile(got)
      now.attachSlot(memberId, got.id, got.kind)
      if (ref.note || ref.sheet) {
        now.patchRef(memberId, got.id, {
          ...(ref.note ? { note: ref.note } : {}),
          ...(ref.sheet ? { sheet: true } : {}),
        })
      }
    } catch {
      lost()
    }
  }
  if (missing.length) useStore.getState().patchCast(memberId, { missing })
}

/**
 * A saved character as a region's likeness — the image side's recall.
 *
 * A character is stored in no model's syntax, which is what lets it cross families;
 * until this, only the scene composer's `@` menu read it back, so a Krea 2 box could
 * not take a likeness somebody had saved. A box holds one photograph where a cast
 * member holds several, so this takes the first plain image — a character sheet is
 * several views on one canvas, which a single-face mold reads as one strange face —
 * and a sheet only when there is nothing else.
 *
 * Through `intake`, like `hydrate`, so the photograph is shrunk the way a dropped one
 * is. The box is found again by id when the bytes arrive: the fetch outlives a click,
 * and an index captured at the start would attach the likeness to whichever box moved
 * into that slot. The note fills the box's sentence only when the box has none.
 *
 * Resolves to a refusal naming the file, or null. A photograph that does not come
 * back is said rather than skipped, for `hydrate`'s reason: a box that looks recalled
 * and renders somebody else is the failure this exists to prevent.
 */
export async function recallLikeness(regionId: string, saved: SavedCharacter): Promise<string | null> {
  const images = saved.refs.filter((r) => r.kind === 'image')
  const ref = images.find((r) => !r.sheet) ?? images[0]
  if (!ref) {
    return `${saved.handle} has no photograph saved — a box takes a photograph, and `
      + `${saved.handle} was saved with ${saved.refs.map((r) => r.kind).join(' and ') || 'nothing'}.`
  }
  const gone = `${saved.handle}’s photograph ${ref.file} is not on the volume any more — `
    + 'drop a photo on the box instead, or save the character again from a scene.'
  let b64: string
  try {
    const res = await fetch(characterFileUrl(saved.handle, ref.file))
    if (!res.ok) return gone
    const blob = await res.blob()
    const got = await intake(new File([blob], ref.file, { type: blob.type }))
    if (!got) return gone
    // Not added to the pool: a box holds the bytes, not a pool id, so the preview URL
    // `intake` made would outlive every reader of it.
    URL.revokeObjectURL(got.url)
    b64 = got.b64
  } catch {
    return gone
  }
  const st = useStore.getState()
  const i = st.regions.findIndex((r) => r.id === regionId)
  if (i < 0) return null
  st.attach(i, 'identity', b64)
  if (!st.regions[i]!.prompt.trim() && saved.note) st.patchRegion(i, { prompt: saved.note })
  return null
}

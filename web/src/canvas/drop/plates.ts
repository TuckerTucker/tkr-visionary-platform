import { NEED_EDIT_LORA } from '../../lora/note'
import { shrinkB64, unreadable } from '../../media/files'
import { attached, useStore, type Role, type Store } from '../../store'

/**
 * What a picture dropped on the image frame can be for, and whether the run can take it.
 *
 * One module for both ways in — a zone on the frame and a tile in `PlateRow` — for the
 * video side's reason (`attach.ts`): the rules are the run's, not the surface's, and a
 * surface that disagreed with another about what a picture may be is two promises.
 *
 * A box is not here. A photo on a box is that character, and the box says so itself;
 * these are the four things that belong to the whole frame.
 */
export type Plate = 'scene' | 'outfit' | 'object' | 'style'

/** V12's free-role sockets, in the order the graph wires them. */
export const OBJECT_ROLES = ['object1', 'object2'] as const
/** One style socket. The K/V engine's tested no-leakage route is single-reference —
 *  its two-ref node is an experiment — so the frame offers exactly what the backend
 *  accepts. */
export const STYLE_ROLE = 'style1' as const

export const PLATES: { plate: Plate; label: string }[] = [
  { plate: 'scene', label: 'Scene' },
  { plate: 'outfit', label: 'Outfit' },
  { plate: 'object', label: 'Object' },
  { plate: 'style', label: 'Style' },
]

/**
 * How much of the frame's height the band takes, from the bottom edge.
 *
 * The bottom edge because it is the edge nearest the console the tiles used to be in,
 * and because the region mode seeds two full-height columns: there is no bare frame to
 * drop a scene on in the commonest arrangement, so the band has to win over the boxes
 * where it lies. A fifth of the frame is wide enough to aim at and leaves four fifths
 * of every box saying "This character".
 */
export const BAND = 0.2

/** The plate under a point on the frame, in 0..1 of the frame, or null above the band. */
export function plateAt(fx: number, fy: number): Plate | null {
  if (fy < 1 - BAND) return null
  return PLATES[Math.min(PLATES.length - 1, Math.floor(fx * PLATES.length))]!.plate
}

/** The object socket a new object would fill, or null when both hold one. */
export function freeObject(s: Pick<Store, 'frame'>): (typeof OBJECT_ROLES)[number] | null {
  return OBJECT_ROLES.find((role) => !attached(s.frame, role)) ?? null
}

/**
 * Why `plate` cannot take a picture now, or null when it can. The sentence names what
 * to do, because both of these are states somebody can change.
 *
 * Style needs no weight — it is the one plate that works on a bare install — so it is
 * never out. The plates are not gated on boxes either, the way `PlateRow`'s tiles never
 * were: "compose into this" first and boxes second is the natural order, and the note
 * under the prompt names the missing box.
 */
export function plateOut(s: Pick<Store, 'state' | 'frame'>, plate: Plate): string | null {
  if (plate === 'style') return null
  if (!s.state?.edit_lora) return NEED_EDIT_LORA
  if (plate === 'object' && !freeObject(s)) {
    return 'Two objects is what the compose takes — remove one to add another.'
  }
  return null
}

/** The caption's half of `plateOut`: short enough to sit on a zone. */
export function plateShort(s: Pick<Store, 'state' | 'frame'>, plate: Plate): string | null {
  if (!plateOut(s, plate)) return null
  return s.state?.edit_lora ? 'both taken' : 'needs the edit LoRA'
}

/**
 * Attach `f` as `plate`, or say why not.
 *
 * An object lands in the free socket with its note focused: a plate the prompt never
 * refers to does close to nothing, which is why the backend refuses one without a note,
 * and the caret in the field is the instruction to write it.
 */
export async function dropPlate(plate: Plate, f: File): Promise<string | null> {
  if (!f.type.startsWith('image/')) return `A ${plate} is an image.`
  const st = useStore.getState()
  const out = plateOut(st, plate)
  if (out) return out
  const b64 = await shrinkB64(f)
  if (!b64) return unreadable(f)
  // Re-read after the await: a second drop can have filled the socket meanwhile.
  const now = useStore.getState()
  const role: Role | null = plate === 'object' ? freeObject(now)
    : plate === 'style' ? STYLE_ROLE : plate
  if (!role) return plateOut(now, plate)
  now.attach('frame', role, b64)
  if (plate === 'object') {
    requestAnimationFrame(() => document.getElementById(`g-${role}-note`)?.focus())
  }
  return null
}

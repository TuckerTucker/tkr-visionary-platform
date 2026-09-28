import { supports, type Store } from '../../store'
import { refBudget } from '../../video/refBudget'
import { outOfPlay, type Role } from './attach'

/**
 * Where a picture dropped on the video canvas goes is where you let go of it.
 *
 * Three zones: the left edge is the first frame, the right edge the last, and the middle
 * is a reference. That is the clip read as a strip of time, which is the one layout of
 * these three nobody has to be taught — a first frame is at the start. A menu after the
 * drop was the other answer and it was refused: it makes one gesture into two and puts
 * a question on the canvas, which the veto list names as a small failure every time.
 *
 * A zone the model has no use for is not drawn at all — no last frame on a model that
 * takes a first frame only, no middle on one that reads no references — and the zones
 * that remain take the room. A zone that is drawn but out of play right now, because
 * the other half is attached, stays drawn and says so, the rule SourceRow's tiles
 * follow: dim rather than hide, because the row's job is to show these are alternatives.
 */
export type Zone = { role: Role; label: string; from: number; to: number }

/** The strip, left to right, as fractions of the canvas width. */
export function zonesFor(s: Store): Zone[] {
  const sup = supports(s)
  const refs = !!sup.references
  const last = !!sup.last_frame
  // A quarter at each edge is wide enough to aim at from across a 1400px canvas and
  // leaves the middle — the reference, the zone the most files go to — the largest.
  const edge = refs ? 0.25 : last ? 0.5 : 1
  const zones: Zone[] = [{ role: 'first', label: 'First frame', from: 0, to: edge }]
  if (refs) zones.push({ role: 'reference', label: 'Reference', from: edge, to: last ? 1 - edge : 1 })
  if (last) zones.push({ role: 'last', label: 'Last frame', from: 1 - edge, to: 1 })
  return zones
}

export function zoneAt(zones: Zone[], fx: number): Zone | null {
  return zones.find((z) => fx >= z.from && fx < z.to) ?? zones[zones.length - 1] ?? null
}

/**
 * The zones, drawn only while a file is over the window. Every zone outlines itself and
 * only the one under the cursor is captioned — "you may drop here" and "here is what
 * dropping does" are different questions, and naming all three at once is the wall of
 * captions the region rows were deleted for.
 *
 * Paint only: it takes no pointer events and handles no drag events. The canvas under it
 * does, so the clip's own controls are never covered and the zone is decided from the
 * pointer, not from whichever element happens to be on top.
 */
export function VideoDrops({ s, hot }: { s: Store; hot: Role | null }) {
  const zones = zonesFor(s)
  return (
    <div id="vid-drops" aria-hidden="true">
      {zones.map((z) => {
        const off = outOfPlay(s, z.role)
        return (
          <div key={z.role} data-role={z.role}
               className={`vzone${hot === z.role ? ' hot' : ''}${off ? ' off' : ''}`}
               style={{ left: `${z.from * 100}%`, width: `${(z.to - z.from) * 100}%` }}
               data-drop={off ? `${z.label} — ${short(z.role, s)}` : z.label} />
        )
      })}
    </div>
  )
}

/** The caption's half of a refusal: short enough to sit on a zone. The whole sentence
 *  is said on the canvas if the file is let go anyway. */
function short(role: Role, s: Store): string {
  if (role === 'reference') return supports(s).references ? 'a keyframe is set' : 'not on this model'
  const b = refBudget(s)
  if (b.images + b.videos > 0) return 'references win'
  if (s.continueFrom) return 'continuing the last take'
  return 'not on this model'
}

/** The empty video canvas's one sentence, naming only the zones this model has. */
export function inviteFor(zones: Zone[]): string {
  const has = (r: Role) => zones.some((z) => z.role === r)
  const parts = ['the left edge opens the clip on it']
  if (has('last')) parts.push('the right edge ends it there')
  if (has('reference')) parts.push('the middle makes it a reference')
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}` : parts[0]!
  return `Drop a picture on the canvas: ${list}.`
}

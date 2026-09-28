import type { Store } from '../../store'
import { BAND, PLATES, plateShort, type Plate } from './plates'

/**
 * Where a picture dropped on the image frame goes, for the four things that belong to
 * the whole frame: a band along its bottom edge — Scene, Outfit, Object, Style.
 *
 * `VideoDrops`' rules, on the frame. Drawn only while a file is over the window; every
 * zone outlines itself and only the one under the cursor is captioned, because "you may
 * drop here" and "here is what dropping does" are different questions. A zone out of
 * play stays drawn and names why before the drop, and the layer refuses in words after
 * it.
 *
 * Paint only. `RegionLayer` reads the drag and decides the zone from the pointer, so a
 * box under the band and a band over a box cannot disagree about which one takes it —
 * the band does, where it is drawn.
 */
export function ImageDrops({ s, hot }: {
  s: Pick<Store, 'state' | 'frame'>
  hot: Plate | null
}) {
  return (
    <div id="img-drops" aria-hidden="true" style={{ height: `${BAND * 100}%` }}>
      {PLATES.map(({ plate, label }) => {
        const off = plateShort(s, plate)
        return (
          <div key={plate} data-plate={plate}
               className={`pzone${hot === plate ? ' hot' : ''}${off ? ' off' : ''}`}
               data-drop={off ? `${label} — ${off}` : label} />
        )
      })}
    </div>
  )
}

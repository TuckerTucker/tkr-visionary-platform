import type { CSSProperties } from 'react'
import type { AnyClip } from '@openvideo/core'

import { faceOf } from '../scene/model'
import { useStore } from '../store'
import { sec } from './engine'
import { dropInherited, inheritedItems, insertOf, takeFrame, type InheritedItem } from './inherit'
import { slotOf } from './project'
import { useEdit } from './useEdit'

/**
 * What an insert inherited, drawn on the insert — never in an inspector.
 *
 * One chip per thing it carries from the scene it covers: each cast member by
 * their face (or initial), the style and the grade by their words, each LoRA by
 * its name. **Every chip is marked inherited** the one way this page marks what
 * was filled in for you rather than read from your words — a dashed edge — and
 * says where it came from under the pointer and to a screen reader. That is the
 * whole trust surface, per *Derived or invented, always visible*: the insert
 * never asks whether you want the cast, it takes it and shows it took it.
 *
 * **A press on a chip drops it** from this insert and nothing else — one undo
 * entry (`dropInherited`). The scene's cast, the V1 slot and every other
 * insert are untouched. There is nothing to confirm; undo puts it back.
 *
 * **V1's frame is offered, not taken** (see `inherit.ts`): a solid `+ frame`
 * chip takes it, and once taken it is an inherited chip like the rest.
 *
 * It sits in the clip's top row, left of the slot's own ↻ and →, and scrolls
 * sideways when an insert is too short to show them all: every chip stays
 * reachable by Tab and by a swipe, and the middle of the bar stays the
 * timeline's seek (see `Slot`).
 */
const ROW = 14
const INSET = 'calc(var(--et-trim, 8px) + 2px)'
/** Room for `Slot`'s ↻ and → at the row's right end. */
const SLOT_ACTS = 2 * (ROW + 2) + 4

export function Inherited({ clip }: { clip: AnyClip }) {
  const slotId = slotOf(clip)
  // The project, not the context: `insertOf` builds a fresh object each call,
  // and a selector that never returns the same reference re-renders forever.
  const project = useEdit((s) => s.project)
  const pool = useStore((s) => s.pool)
  const ctx = insertOf(project, slotId)
  if (!slotId || !ctx) return null

  const items = inheritedItems(ctx)
  const where = `V1 at ${clockOf(ctx.at)}`
  return (
    <div className="et-inherited" data-insert={slotId} role="group"
         aria-label={`Inherited from ${where}`}
         onPointerDown={(e) => e.stopPropagation()}
         style={S.row}>
      {items.map((it) => (
        <button key={it.key} type="button" className="et-inh" data-inherited="v1" data-key={it.key}
                data-kind={it.kind}
                aria-label={`${describe(it)}, inherited from ${where} — press to drop it from this insert`}
                title={`${describe(it)} — inherited from ${where}. Press to drop it from this insert only; undo puts it back.`}
                style={S.chip}
                onClick={() => { dropInherited(slotId, it.key) }}>
          {it.kind === 'cast' && <Face url={faceOf(it.member, pool)?.url ?? null} name={it.label} />}
          <span style={S.label}>{it.kind === 'lora' ? `◇ ${it.label}` : it.kind === 'frame' ? '▣ frame' : it.label}</span>
        </button>
      ))}
      {!ctx.frame && ctx.from !== null && (
        <button type="button" className="et-inh-offer" data-offer="frame"
                aria-label={`Take V1's frame at the insert's start as its first frame`}
                title="Open the insert on V1's frame at its start — marked inherited, and dropped the same way"
                style={{ ...S.chip, ...S.offer }}
                onClick={() => { takeFrame(slotId) }}>
          <span style={S.label}>+ frame</span>
        </button>
      )}
    </div>
  )
}

function Face({ url, name }: { url: string | null; name: string }) {
  return url
    ? <img src={url} alt="" style={S.face} draggable={false} />
    : <span aria-hidden="true" style={{ ...S.face, ...S.initial }}>{(name[0] ?? '?').toUpperCase()}</span>
}

function describe(it: InheritedItem): string {
  if (it.kind === 'cast') return `@${it.label}`
  if (it.kind === 'look') return `${it.key === 'style' ? 'Style' : 'Grade'} “${it.label}”`
  if (it.kind === 'lora') return `LoRA ${it.label}`
  return "V1's frame at the insert's start"
}

const clockOf = (micro: number): string => {
  const t = Math.max(0, sec(micro))
  const m = Math.floor(t / 60)
  return `${String(m)}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}

const S: Record<string, CSSProperties> = {
  row: {
    position: 'absolute', top: 1, left: INSET, right: `calc(${INSET} + ${String(SLOT_ACTS)}px)`,
    height: ROW, display: 'flex', alignItems: 'center', gap: 2, zIndex: 1,
    overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none',
  },
  chip: {
    flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 2, height: ROW, maxWidth: 88,
    margin: 0, padding: '0 4px 0 1px', borderRadius: ROW / 2,
    // The inherited mark: a dashed edge, the one way "filled in for you" is
    // drawn, so the eye can tell it from anything the person put there.
    border: '1px dashed var(--line-2)', background: 'rgba(0,0,0,.45)', color: 'var(--fg)',
    fontSize: 10, lineHeight: `${String(ROW - 2)}px`, cursor: 'pointer',
  },
  offer: { borderStyle: 'solid', borderColor: 'var(--line)', color: 'var(--dim)', paddingLeft: 4 },
  label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  face: { width: ROW - 4, height: ROW - 4, borderRadius: '50%', objectFit: 'cover', flex: 'none' },
  initial: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--wash-3)', fontSize: 7, color: 'var(--fg)',
  },
}

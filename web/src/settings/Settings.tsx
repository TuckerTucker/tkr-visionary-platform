import { useMemo, useState } from 'react'

import { failed, type ApiError } from '../api/client'
import {
  addCaptionModel, changePassword, deleteCaptionModel, deleteLora, downloadFamily,
  setToken, signOut, startDownload, startGdrive,
} from '../api/routes'
import type { AppState, GpuChoice, LoraEntry, ModelEntry } from '../api/types'
import { useStore } from '../store'
import { fmtBytes } from '../format'
import { IconClose, IconDownload } from '../icons'
import { ErrorNote } from '../ui/ErrorNote'
import { useBusy } from '../ui/useBusy'
import { useDownload } from './useDownload'

/**
 * Everything decided once, behind the gear.
 *
 * Nothing downloads on its own — weights are chosen explicitly, here. The GPU
 * pickers live here for the same reason: a card is set per session and confirms
 * a cold start when it changes, so it was 71px of composer for a decision no
 * take varies by.
 *
 * The password is the one card that is not about weights, and it is here rather
 * than in a sheet of its own: two fields and a Sign out do not earn a second
 * settings surface, and a person looking for "where do I change this" opens the
 * gear whatever the gear is called.
 */
export function Settings({
  state, open, onClose, onReload,
}: {
  state: AppState | null
  open: boolean
  onClose: () => void
  onReload: () => void
}) {
  const [token, setTokenValue] = useState('')
  const [tokenNote, setTokenNote] = useState<string | null>(null)
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNext, setPwNext] = useState('')
  const [pwNote, setPwNote] = useState<{ text: string; err?: boolean } | null>(null)
  const [driveUrl, setDriveUrl] = useState('')
  const [driveFolder, setDriveFolder] = useState('')
  // The whole ApiError, not `r.error`: the sentence is what the box shows, but a delete
  // that failed on a path guard answers with the route's own report behind it, and
  // widening the state is all it costs to keep that reachable.
  const [loraError, setLoraError] = useState<string | ApiError | null>(null)
  /* Which families are unfolded, keyed by name; unset means "open unless
     complete". A complete family is a list of green ticks — true, and not
     worth twenty rows of the one screen that has to be scrolled to be used.
     The head still says `complete`, so nothing is hidden that a glance was
     answering; the rows are one click away, and the fold is session state
     rather than stored, because `It never remembers unless told`. */
  const [openFams, setOpenFams] = useState<Record<string, boolean>>({})
  const dl = useDownload()
  // Save and every row's ✕ on one keyed flag. `dl.busy` is the uplink, which is a
  // different thing and already had its own; this is the two mutations on this sheet
  // that write and then reload, and the key is which of them is in flight.
  const { busy, run } = useBusy()

  // Grouped by family, in catalogue order. Twenty-odd flat cards is a wall you
  // scroll rather than a list you read, and the group is the unit you actually
  // decide in: you want the video stack or you do not.
  const families = useMemo(() => {
    const out: { name: string; items: ModelEntry[] }[] = []
    for (const m of state?.models ?? []) {
      const g = out.find((f) => f.name === m.family)
      if (g) g.items.push(m)
      else out.push({ name: m.family, items: [m] })
    }
    return out
  }, [state])

  if (!open) return null

  const saveToken = () => run('token', async () => {
    const r = await setToken(token)
    setTokenNote(failed(r) ? r.error : 'Token saved.')
    setTokenValue('')
    if (!failed(r)) onReload()
  })

  const savePassword = () => run('password', async () => {
    const r = await changePassword(pwCurrent, pwNext)
    if (failed(r)) {
      // The current field keeps what was typed and the new one is cleared: a
      // refusal here is almost always the current password, and clearing both
      // would make the person retype the half that was right.
      setPwNote({ text: r.error, err: true })
      setPwNext('')
      return
    }
    setPwNote({ text: 'Password changed. Every other browser is signed out.' })
    setPwCurrent('')
    setPwNext('')
  })

  // No confirm dialog. Signing out is not destructive — nothing is lost and the
  // way back is the password you already have — and the rules here reserve a
  // dialog for a blast radius, not for a decision that undoes itself.
  const endSession = () => run('signout', async () => {
    const r = await signOut()
    if (failed(r)) return setPwNote({ text: r.error, err: true })
    // The reload lands on the gate, because the cookie is gone by the time this
    // runs. Deliberately not left to the next poll's 401: the person pressed a
    // button and the page should answer the press, not the poll after it.
    window.location.reload()
  })

  const removeLora = (l: LoraEntry) => {
    // The dialog is the entire safety net: the route unlinks and there is
    // nothing behind it. So it says how much is going, and whether it can come
    // back — two different sentences, because a catalogue LoRA is a download
    // and a LoRA you trained is however many hours that run took.
    const n = l.files.length
    const ok = confirm(
      `Permanently delete “${l.name}”?\n\n` +
      `${n} file${n === 1 ? '' : 's'} (${fmtBytes(l.bytes)}) unlinked from the volume.\n` +
      (l.catalogue
        ? `It is part of ${l.catalogue} in the catalogue below, so it can be downloaded again.`
        : 'This cannot be undone.'),
    )
    if (!ok) return
    // Keyed by root, so only the row being deleted changes; the confirm stays outside
    // `run` because nothing should be marked in flight while a dialog is still open.
    return run(`lora:${l.root}`, async () => {
      const r = await deleteLora(l.root)
      if (failed(r)) return setLoraError(r)
      setLoraError(null)
      // The whole sheet, not just this list: deleting a catalogue LoRA moves it
      // back to "missing" in the cards below.
      onReload()
    })
  }

  const loras = state?.loras ?? []
  const loraBytes = loras.reduce((a, l) => a + (Number(l.bytes) || 0), 0)
  // The server's own number, not a 12 retyped here. The fallback only covers
  // the tick before the first /api/state lands, and it is deliberately the
  // stricter direction: a field that is briefly harder to satisfy is recoverable,
  // one that is briefly easier sends a password the route will refuse.
  const min = state?.password_min ?? 12

  return (
    <div id="settings" className="scrim">
      <div className="sheet">
        <div className="sheet-head">
          <h1 className="grow">Settings</h1>
          <button className="ico" id="settings-x" type="button" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="card">
          <label>GPU</label>
          <div className="row" style={{ gap: 10 }}>
            <GpuSelect id="g-gpu" label="Image" side="image" spec={state?.gpus.image} />
            <GpuSelect id="v-gpu" label="Video" side="video" spec={state?.gpus.video} />
          </div>
          <p className="muted" style={{ margin: '9px 2px 0' }}>
            Changing a card costs one cold start while the model loads. Runs after it are warm.
          </p>
        </div>

        {/* Above the HuggingFace field rather than below it, for two reasons.
            It is the credential *for* this app rather than one the app carries
            somewhere else, so it is the first thing on the sheet that is about
            the deployment you are standing in. And two `type="password"` inputs
            on one panel is a password manager's worst case: the real ones go
            first and are marked current/new, the token below stays `off`, and
            nothing offers to autofill an hf_… field with your login. */}
        <div className="card">
          <label>Password</label>
          <div className="row">
            <input id="pw-cur" type="password" className="grow" placeholder="Current"
                   autoComplete="current-password" value={pwCurrent}
                   onChange={(e) => setPwCurrent(e.target.value)} />
            <input id="pw-new" type="password" className="grow"
                   placeholder={`New — ${min}+ characters`}
                   autoComplete="new-password" value={pwNext}
                   onChange={(e) => setPwNext(e.target.value)} />
            {/* Shut until the new one could be accepted, so the length is a
                thing you watch rather than a thing you are told after pressing.
                `run` is still the guard that matters — `disabled` is a paint. */}
            <button className="s" type="button"
                    disabled={!!busy || pwNext.length < min || !pwCurrent}
                    onClick={() => void savePassword()}>
              {busy === 'password' ? 'Saving…' : 'Change'}
            </button>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            The one password on this deployment. Signing out signs out every
            browser, here and anywhere else it is open.{' '}
            <span id="pw-state">
              {pwNote && <span className={pwNote.err ? 'warn' : 'ok'}>{pwNote.text}</span>}
            </span>
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="s" type="button" disabled={!!busy}
                    onClick={() => void endSession()}>
              {busy === 'signout' ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>

        {/* The token, and only the token. "Download missing" used to sit in
            this row, which put the one button that pulls the entire catalogue
            next to a password field it has nothing to do with. */}
        <div className="card">
          <label>HuggingFace token</label>
          <div className="row">
            <input id="tok" type="password" className="grow" placeholder="hf_…"
                   autoComplete="off" value={token}
                   onChange={(e) => setTokenValue(e.target.value)} />
            {/* The note under the field is written *by* the reply, so until the reply
                landed there was nothing on screen at all — and the only honest read of a
                save that shows nothing is that Save did not work, which is why it got
                pressed again. The label carries the state; the guard is `run`'s, because
                `disabled` is a paint and a queued second click gets past a paint. */}
            <button className="s" type="button" disabled={!!busy}
                    onClick={() => void saveToken()}>
              {busy === 'token' ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Needed for Krea 2 RAW and Turbo, which are gated. Accept the licence at
            huggingface.co/krea/Krea-2-Raw with the same account.{' '}
            <span id="tok-state">
              {tokenNote ? <span className="ok">{tokenNote}</span>
                : state?.hf_token_set ? <span className="ok">Token saved.</span>
                : <span className="warn">No token saved.</span>}
            </span>
          </p>
        </div>

        {/* The other way weights arrive. Most LoRAs worth having were never
            published to HuggingFace — they are a link someone sent you. Same
            card shape as the token, deliberately: another place weights come
            from, not another kind of thing. */}
        <div className="card">
          <label>Google Drive</label>
          <div className="row">
            <input id="gd-url" className="grow" placeholder="Drive link or file id"
                   autoComplete="off" spellCheck={false} value={driveUrl}
                   onChange={(e) => setDriveUrl(e.target.value)} />
            {/* 158px is what it wants, not what it insists on. This was
                `width:158;flex:none`, and a `.row` whose items all refuse to shrink can
                only overflow — the link field, this one and Download ran off the right
                edge of the sheet on a phone, and Settings has no media query of its own
                to catch it. `minWidth` has to be spelled out too: a flex item's automatic
                minimum is its intrinsic width, and for an `<input>` that is the default
                ~20-character box, which is most of the overflow on its own. */}
            <input id="gd-folder" placeholder="folder (optional)" autoComplete="off"
                   spellCheck={false} style={{ flex: '1 1 158px', minWidth: 96 }}
                   title="Group the files under loras/{name}/ — for a matched pair that belongs together. Leave blank to drop them in loose."
                   value={driveFolder} onChange={(e) => setDriveFolder(e.target.value)} />
            {/* `.s`, matching Save in the token row above it. This was the only
                white primary button on the screen, which inverted the hierarchy of
                the whole thing: pulling one file somebody sent you was drawn louder
                than the model catalogue below, which is what this screen is *for*
                and which pulls 17 GB. The hand-written padding went with it — it
                made this the one `.b` in the product at 13px. */}
            <button className="s" type="button" disabled={dl.busy}
                    onClick={() => {
                      if (!driveUrl.trim()) return
                      void dl.begin('gdrive', 'dl_gdrive', 'Downloaded.',
                        () => startGdrive(driveUrl.trim(), driveFolder.trim() || undefined),
                        onReload)
                    }}>
              Download
            </button>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Lands in <code>loras/</code>, ready to name in a prompt. Only{' '}
            <code>.safetensors</code> is kept — a folder's preview images and readme are left
            behind. The link has to be shared with anyone who has it.
          </p>
          {/* No progress bar, unlike the cards below. Drive does not say how big
              a file is before it sends it, so a bar here could only sit at zero
              for the length of the transfer — which is what "stuck" looks like.
              The byte count and the rate move, and moving is the whole job. */}
          <Line p={dl.progressOf('gdrive')}
                onCancel={() => void dl.cancel('gdrive', 'dl_gdrive')} />
        </div>

        <div className="card">
          <div className="row" style={{ alignItems: 'baseline', marginBottom: 4 }}>
            <label className="grow" style={{ margin: 0 }}>LoRAs</label>
            <span className="muted" id="lora-total">
              {loras.length ? `${loras.length} · ${fmtBytes(loraBytes)}` : ''}
            </span>
          </div>
          <ErrorNote err={loraError} style={{ marginTop: 10 }} />
          <div id="lora-list">
            {loras.length ? loras.map((l) => (
              <div className="lora-row" key={l.root}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <b>{l.name}</b>
                  {l.trigger_word ? <> <code>{l.trigger_word}</code></> : null}
                  <div className="muted">
                    {l.files.length} file{l.files.length === 1 ? '' : 's'} · {fmtBytes(l.bytes)}
                    {l.catalogue ? ` · ${l.catalogue}` : ''}
                  </div>
                </div>
                {/* Unlinking the files and reloading the sheet leaves the row sitting
                    there, still with a ✕ on it, for as long as both take — which reads
                    as a delete that did not take, and the second press opens the confirm
                    again for a LoRA already on its way out. The glyph carries it because
                    `.lora-x` is a fixed square: there is no room in it for a word. */}
                <button className="lora-x" type="button" disabled={!!busy}
                        title={busy === `lora:${l.root}` ? 'Deleting…' : 'Delete'}
                        onClick={() => void removeLora(l)}>
                  {busy === `lora:${l.root}` ? '…' : <IconClose />}
                </button>
              </div>
            )) : (
              // Both ways in are directly above this card, so the empty state
              // points at them rather than saying "nothing here".
              <p className="muted" style={{ margin: '2px 0 0' }}>
                Nothing in <code>loras/</code> yet — train one, or paste a Drive link above.
              </p>
            )}
          </div>
        </div>

        {/* Captioners are menu rows, not catalogue entries: the weights pull
            into the HF cache on first use rather than downloading here, so the
            card offers add-by-repo instead of a Download button. */}
        <CaptionModels state={state} onReload={onReload} />

        <div id="models">
          {families.map((f) => {
            const left = f.items.filter((m) => !m.present)
            const size = left.reduce((a, m) => a + m.approx_gb, 0)
            const id = `fam:${f.name}`
            const open = openFams[f.name] ?? left.length > 0
            return (
              <div className="fam" key={f.name}>
                <div className="fam-head">
                  {/* The name is the toggle; the caret is what says so. A
                      separate disclosure control beside the name would be two
                      marks for one act. `.fam-dl` keeps its own button because
                      a toggle and a 17 GB download must not share a target. */}
                  <button className="t fam-toggle" type="button" aria-expanded={open}
                          onClick={() => setOpenFams((o) => ({ ...o, [f.name]: !open }))}>
                    <span className={`caret${open ? ' open' : ''}`} aria-hidden="true" />
                    <b>{f.name}</b>
                  </button>
                  <span className="muted">
                    {left.length ? `${left.length} missing · ${size.toFixed(1)} GB` : 'complete'}
                  </span>
                  {/* One short shows no button at all, because that is what its
                      own Download already is. */}
                  {/* A family is the unit you decide in — you want the stack or
                      you do not — so this is the press that matters, and the
                      per-file buttons below are the escape hatch. A quiet pill
                      now rather than the screen's one `.b`: the mockup's call,
                      and the white fill was drawing a purchase decision louder
                      than the canvas draws Generate. */}
                  {left.length > 1 && (
                    <button className="s fam-dl" type="button" disabled={dl.busy}
                            onClick={() => void dl.begin(id, id, `${f.name} downloaded.`,
                              () => downloadFamily(f.name, token), onReload)}>
                      Download all {left.length}
                    </button>
                  )}
                </div>
                <Line p={dl.progressOf(id)} bar onCancel={() => void dl.cancel(id, id)} />

                {/* One card per family, rows inside — the LoRA list's own
                    shape, and the caption menu's. Twenty sibling cards made
                    the catalogue a wall of frames where the reading unit is
                    the family; a hairline per row is the same information at
                    a third of the chrome. */}
                {open && (
                  <div className="card">
                    {f.items.map((m) => {
                      const p = dl.progressOf(m.key)
                      return (
                        <div className="mrow" key={m.key}>
                          <div className="grow" style={{ minWidth: 0 }}>
                            <b>{m.label}</b> <span className="muted">{m.note}</span>
                            {m.gated && <span className="warn" style={{ fontSize: 12 }}> · gated</span>}
                            <div className="muted" style={{ marginTop: 3 }}><code>{m.repo_id}</code></div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            {m.present ? (
                              <span className="ok">✓ {m.size_gb} GB</span>
                            ) : (
                              <span className="row" style={{ gap: 12, justifyContent: 'flex-end' }}>
                                <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                                  {m.approx_gb} GB
                                </span>
                                {/* The size is the label, so the button can be a
                                    mark — a control whose value is beside it, in
                                    the row you are already reading. Cancel takes
                                    the slot while the pull runs: two controls in
                                    one place would be an invitation to press the
                                    dead one. */}
                                {p.running ? (
                                  <button className="s" type="button"
                                          onClick={() => void dl.cancel(m.key, `dl_${m.key}`)}>
                                    Cancel
                                  </button>
                                ) : (
                                  <button className="icx" type="button" disabled={dl.busy}
                                          title={`Download ${m.approx_gb} GB`}
                                          onClick={() => void dl.begin(m.key, `dl_${m.key}`, 'Done',
                                            () => startDownload(m.key), onReload)}>
                                    <IconDownload />
                                  </button>
                                )}
                              </span>
                            )}
                            {p.tone === 'err' ? (
                              // Left-aligned and capped by hand: this column is
                              // `text-align:right` and sized by its own content, so an
                              // err-box dropped into it would right-align a traceback and
                              // stretch the card until the label beside it wrapped a word
                              // per line.
                              <ErrorNote err={{ error: p.message, detail: p.detail }}
                                         style={{ textAlign: 'left', maxWidth: 280, margin: '8px 0 0' }} />
                            ) : (
                              <div className={`muted dl-state${p.tone === 'ok' ? ' ok' : ''}`}>
                                {p.message}
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * The captioner menu, editable.
 *
 * Any vision-language model on HuggingFace, by repo id. The add is validated
 * server-side against the repo's own config.json — a typo, a gated repo
 * without a token, or a text-only model is a named error here, in
 * milliseconds, rather than a cold GPU start that dies mid-pull. Built-ins
 * have no ✕ because they are baked into the image; deleting one could only
 * hide it until the next deploy.
 */
function CaptionModels({ state, onReload }: {
  state: AppState | null
  onReload: () => void
}) {
  const [repo, setRepo] = useState('')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState<{ text: string; err?: boolean } | null>(null)
  // Both paths on one flag. Add had a hand-rolled `busy` boolean and Remove had nothing,
  // so the same card said "Checking…" for one button and sat silent for the other — and
  // two mechanisms for one behaviour is how they drift apart.
  const { busy, run } = useBusy()
  const models = state?.caption_models ?? []

  const add = () => {
    // Only the empty-field check is left here: `run` refuses while anything is in
    // flight, which is the half the old `|| busy` was doing.
    if (!repo.trim()) return
    return run('add', async () => {
      setNote(null)
      const r = await addCaptionModel(repo.trim(), label.trim())
      if (failed(r)) return setNote({ text: r.error, err: true })
      setRepo('')
      setLabel('')
      setNote({ text: 'Added. The weights pull into the cache on its first run.' })
      onReload()
    })
  }

  const remove = (key: string, name: string) => {
    if (!confirm(`Remove “${name}” from the captioner menu?\n\n`
      + 'Only the menu entry goes — weights already in the cache stay cached.')) return
    return run(`rm:${key}`, async () => {
      const r = await deleteCaptionModel(key)
      if (failed(r)) return setNote({ text: r.error, err: true })
      onReload()
    })
  }

  return (
    <div className="card" id="caption-models">
      <label>Caption models</label>
      {models.map((m) => (
        <div className="lora-row" key={m.key}>
          <div className="grow" style={{ minWidth: 0 }}>
            <b>{m.label}</b> <span className="muted">{m.note}</span>
            {m.repo && <div className="muted" style={{ marginTop: 3 }}><code>{m.repo}</code></div>}
          </div>
          {m.custom && (
            // Same treatment as the LoRA rows above: the row survives the round trip and
            // the reload, so without this the press had no answer until the list redrew.
            <button className="lora-x" type="button" disabled={!!busy}
                    title={busy === `rm:${m.key}` ? 'Removing…' : 'Remove from the menu'}
                    onClick={() => void remove(m.key, m.label)}>
              {busy === `rm:${m.key}` ? '…' : <IconClose />}
            </button>
          )}
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <input id="cm-repo" className="grow" placeholder="owner/repo — any vision LM on HuggingFace"
               autoComplete="off" spellCheck={false} value={repo}
               onChange={(e) => setRepo(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
        {/* Same basis and the same explicit minimum as the Drive folder field, for the
            same reason: this row is repo + label + Add, and a fixed-width middle is what
            pushed Add off the edge on a narrow screen. */}
        <input id="cm-label" placeholder="label (optional)" autoComplete="off"
               spellCheck={false} style={{ flex: '1 1 158px', minWidth: 96 }} value={label}
               onChange={(e) => setLabel(e.target.value)} />
        <button className="s" type="button" disabled={!!busy || !repo.trim()}
                onClick={() => void add()}>
          {busy === 'add' ? 'Checking…' : 'Add'}
        </button>
      </div>
      {note && (
        <p className={note.err ? 'err' : 'ok'} style={{ marginTop: 8 }}>{note.text}</p>
      )}
    </div>
  )
}

/**
 * One warning, once per card, and only when you actually change it.
 *
 * Switching starts a container that does not exist yet — on the video side that is
 * 42.5 GB of weights, so the cost is worth a sentence before it is spent rather than a
 * progress bar that sits still for minutes afterwards. Declining puts the select back,
 * because a confirm that leaves the control showing the answer you refused is a control
 * that lies about what the next run will use.
 *
 * The choice is store state and not just a DOM value: `imageBody` and `videoBody` read
 * `gpu` off the store, so a select nothing wrote to would send the deployment's default
 * on every run no matter what this said.
 */
function GpuSelect({ id, label, side, spec }: {
  id: string
  label: string
  side: 'image' | 'video'
  spec: GpuChoice | undefined
}) {
  const value = useStore((s) => s.gpu[side])
  const setGpu = useStore((s) => s.setGpu)
  return (
    <div className="opt" data-lb={label}>
      <span className="lead">{label}</span>
      <select id={id} value={value || spec?.default || ''}
              onChange={(e) => {
                const next = e.target.value
                if (next === spec?.default
                    || confirm(`Switch to ${next}?\n\nThis card has no warm container, `
                      + 'so the next run pays a cold start while the model loads. '
                      + 'Runs after it are warm.')) {
                  setGpu({ [side]: next })
                }
              }}>
        {(spec?.options ?? []).map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  )
}

function Line({ p, bar, onCancel }: {
  p: { percent: number; message: string; tone: string; running: boolean; detail?: string }
  bar?: boolean
  onCancel: () => void
}) {
  if (!p.message) return null
  // A failure gets the box and its disclosure, not a red line of text. A refused start
  // is the one message here with a server behind it — "could not reach the server" with
  // the browser's own reason underneath — and a bare `<p className="err">` had nowhere
  // to put the reason, so it was dropped. Bar and Cancel are both gone by then anyway:
  // `running` is false on every path that sets this tone.
  if (p.tone === 'err') {
    return (
      <div className="fam-prog">
        <ErrorNote err={{ error: p.message, detail: p.detail }} style={{ marginBottom: 0 }} />
      </div>
    )
  }
  return (
    <div className="fam-prog">
      {bar && <div className="bar"><i style={{ width: `${p.percent}%` }} /></div>}
      <div className="row" style={{ gap: 10, marginTop: bar ? 7 : 0 }}>
        <p className={`grow${p.tone === 'ok' ? ' ok' : p.tone === 'err' ? ' err' : ' muted'}`}
           style={{ margin: 0 }}>
          {p.message}
        </p>
        {p.running && <button className="s" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  )
}

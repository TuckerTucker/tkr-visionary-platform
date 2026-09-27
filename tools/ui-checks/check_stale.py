"""
A re-render says what it made out of date, and redoes nothing on its own.

    python3 tools/ui-checks/check_stale.py                         # :8815
    python3 tools/ui-checks/check_stale.py 8815                    # a port
    python3 tools/ui-checks/check_stale.py http://localhost:5173   # a URL

Two halves.

**The walk, pure** (`web/src/edit/stale.ts`), bundled with the web build's own
esbuild and run under node — no page, no engine. It holds the rules the page
half cannot reach cheaply: staleness is transitive along a chain and names the
slot one step up; a source slot gone from the cut is not a different take; a
take with no record falls back to what the page remembers; a cycle ends; an
insert that took no frame is made from nothing a re-render changes.

**The page**, against `preview_ui.py` (a real 3-second mp4 per job when ffmpeg
is on the PATH). What it holds, and the failure each one is for:

- **A three-take chain (Generate, Continue, Continue) is not stale**, and
  neither is an insert over slot 2 that took V1's frame and rendered.
- **Re-rendering slot 2 marks slot 3 stale, naming slot 2**, and the insert
  too — and not slot 1, and not slot 2 itself. A mark on the wrong slot is a
  re-render somebody pays three minutes of GPU for.
- **The mark keeps off the trim handles**: a control under a handle is one the
  handle eats.
- **Nothing re-renders on its own.** Every `/api/video` request in the run is
  one this check pressed for.
- **It is derived, never stored**: one undo of the re-render clears every mark,
  redo brings them back; ‹ back to slot 2's old take clears them, › again
  brings them back; and after a reload the marks are where they were, read from
  the takes' own records.
- **Export names the stale slots before encoding** — inline on the control, no
  dialog, nothing sent to `/api/outputs` — and the second press encodes.
  *Re-render first* goes to the first stale slot's offer and renders nothing.
- **The offer on the insert renders it again, once, and its mark clears** —
  it was made from slot 2's new take.
- **The offer on a continuation renders it again in its own slot**, once,
  continued from slot 2's new take with its own sentence: V1 still holds three
  slots, slot 3's clip plays the new take, and its mark clears. It used to arm
  Continue and let Generate land a second slot beside the stale one.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8815"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = os.path.join(ROOT, "web")
# The timeline's scale — `PX_PER_SEC` in web/src/scene/Timeline.
PX = 30

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


# ---------------------------------------------------------------------------
# The walk, pure
# ---------------------------------------------------------------------------

PURE = r"""
import {
  conditioningEdges, insertCondition, playingBySlot, rootOf, slotLabel, staleSentence,
  staleSlots, staleSummary, staleWalk,
} from '%(stale)s'

const S = 1_000_000
const clip = (id, slot, job, from, len = 3, type = 'Video') => ({
  id, type, name: id, metadata: job ? { slotId: slot, jobId: job, file: 'clip.mp4' } : { slotId: slot },
  timing: { display: { from: from * S, to: (from + len) * S }, trim: { from: 0, to: len * S }, duration: len * S },
  transform: {},
})
const project = (clips, inserts = null) => ({
  settings: { width: 640, height: 360, fps: 24, duration: 0 },
  tracks: [
    ...(inserts ? [{ id: 't2', name: 'V2', type: 'video', clipIds: clips.filter((c) => c.track === 't2').map((c) => c.id), inserts }] : []),
    { id: 'v1', name: 'V1', type: 'video', clipIds: clips.filter((c) => c.track !== 't2').map((c) => c.id) },
  ],
  clips: Object.fromEntries(clips.map((c) => [c.id, c])),
})
const take = (jobId, slot, conditionedOn) => ({ jobId, file: 'clip.mp4', line: jobId, slot, ...(conditionedOn && { conditionedOn }) })
const keys = (m) => [...m.keys()].sort()
const out = {}

// a ← b ← c ← d, a chain of continuations
const chain = [take('j1', 'a'), take('j2', 'b', 'j1'), take('j3', 'c', 'j2'), take('j4', 'd', 'j3')]
const c4 = (bJob) => [clip('ca', 'a', 'j1', 0), clip('cb', 'b', bJob, 3), clip('cc', 'c', 'j3', 6), clip('cd', 'd', 'j4', 9)]
out.fresh = keys(staleSlots(project(c4('j2')), chain))
const retaken = staleSlots(project(c4('j2b')), [...chain, take('j2b', 'b')])
out.retaken = keys(retaken)
out.c = retaken.get('c')
out.d = retaken.get('d')
out.root_d = rootOf(retaken, 'd')
out.sentence_c = staleSentence(project(c4('j2b')), retaken.get('c'))
out.sentence_d = staleSentence(project(c4('j2b')), retaken.get('d'))

// the source slot left the cut: nothing to re-render from
const gone = [clip('ca', 'a', 'j1', 0), clip('cc', 'c', 'j3', 3)]
out.gone = keys(staleSlots(project(gone), [take('j1', 'a'), take('j2', 'b', 'j1'), take('j3', 'c', 'j2')]))

// no record on the take: the fallback answers
const bare = [take('j1', 'a'), take('j2', 'b'), take('j1b', 'a')]
const two = project([clip('ca', 'a', 'j1b', 0), clip('cb', 'b', 'j2', 3)])
out.no_record = keys(staleSlots(two, bare))
out.fallback = keys(staleSlots(two, bare, (j) => (j === 'j2' ? 'j1' : null)))

// a cycle ends
const cyc = [take('x1', 'x', 'y1'), take('y1', 'y', 'x1'), take('x2', 'x')]
const cp = project([clip('cx', 'x', 'x2', 0), clip('cy', 'y', 'y1', 3)])
out.cycle = keys(staleWalk(conditioningEdges(cp, cyc), playingBySlot(cp)))

// an insert over b at 4.5s that took the frame, and one that did not
const ins = (frame) => {
  const i = clip('ci', 'i', 'ji', 4.5)
  i.track = 't2'
  return project([...c4('j2b'), i], { i: { from: 'b', at: 4.5 * S, cast: [], style: '', grade: '', loras: [], frame } })
}
const withIns = [...chain, take('j2b', 'b'), take('ji', 'i', 'j2')]
const si = staleSlots(ins(true), withIns)
out.insert = si.get('i')
out.insert_label = slotLabel(ins(true), 'i')
out.summary = staleSummary(ins(true), si)
out.insert_sentence = staleSentence(ins(true), si.get('i'))
const empty = clip('ce', 'e', null, 4.5, 3, 'Text')
empty.track = 't2'
const withEmpty = (frame) => project([...c4('j2'), empty], { e: { from: 'b', at: 4.5 * S, cast: [], style: '', grade: '', loras: [], frame } })
out.cond_frame = insertCondition(withEmpty(true), 'e')
out.cond_noframe = insertCondition(withEmpty(false), 'e')
out.cond_v1 = insertCondition(project(c4('j2')), 'b')

console.log(JSON.stringify(out))
"""


def pure():
    print("\n=== the walk, pure ===")
    esbuild = os.path.join(WEB, "node_modules", ".bin", "esbuild")
    if not os.path.exists(esbuild):
        check("esbuild is in web/node_modules (npm --prefix web ci)", False, esbuild)
        return
    with tempfile.TemporaryDirectory() as tmp:
        entry = os.path.join(tmp, "stale_test.ts")
        bundle = os.path.join(tmp, "stale_test.mjs")
        with open(entry, "w") as f:
            f.write(PURE % {"stale": os.path.join(WEB, "src", "edit", "stale.ts")})
        built = subprocess.run([esbuild, entry, "--bundle", "--platform=node", "--format=esm",
                                "--log-level=error", f"--outfile={bundle}"],
                               capture_output=True, text=True, cwd=WEB)
        if built.returncode:
            check("stale.ts bundles for node", False, built.stderr[-400:])
            return
        ran = subprocess.run(["node", bundle], capture_output=True, text=True)
        if ran.returncode:
            check("the walk runs under node", False, ran.stderr[-400:])
            return
    r = json.loads(ran.stdout)
    check("a chain nothing was re-rendered in is not stale", r["fresh"] == [], str(r["fresh"]))
    check("re-rendering slot 2 makes slot 3 stale, and slot 4 behind it — not 1, not 2",
          r["retaken"] == ["c", "d"], str(r["retaken"]))
    check("slot 3 because slot 2 plays another take",
          r["c"] == {"because": "b", "reason": "retaken", "how": "continue"}, str(r["c"]))
    check("slot 4 because slot 3, which is itself out of date",
          r["d"] == {"because": "c", "reason": "upstream", "how": "continue"}, str(r["d"]))
    check("slot 4's remedy is slot 3's, up the chain", r["root_d"] == "c", r["root_d"])
    check("the sentence names the slot, not its id",
          r["sentence_c"].startswith("Continued from slot 2's earlier take"), r["sentence_c"])
    check("and the upstream one names the stale slot", "slot 3, which is itself out of date" in r["sentence_d"],
          r["sentence_d"])
    check("a source slot gone from the cut is not a different take", r["gone"] == [], str(r["gone"]))
    check("a take with no record is made from nothing", r["no_record"] == [], str(r["no_record"]))
    check("unless the page's fallback remembers its source", r["fallback"] == ["b"], str(r["fallback"]))
    check("a cycle ends the walk", r["cycle"] == ["y"], str(r["cycle"]))
    check("an insert that opened on slot 2's frame is stale too",
          r["insert"] == {"because": "b", "reason": "retaken", "how": "frame"}, str(r["insert"]))
    check("it is called by where it sits", r["insert_label"] == "insert at 0:04.5", r["insert_label"])
    check("the summary names them in cut order",
          r["summary"] == "3 slots are out of date: slot 3, slot 4, insert at 0:04.5", r["summary"])
    check("the insert's sentence says it was the frame",
          r["insert_sentence"].startswith("Opens on slot 2's frame from an earlier take"), r["insert_sentence"])
    check("an insert that took V1's frame is made from the V1 take under its start",
          r["cond_frame"] == "j2", str(r["cond_frame"]))
    check("one that took no frame is made from nothing a re-render changes",
          r["cond_noframe"] is None, str(r["cond_noframe"]))
    check("a V1 slot is not an insert", r["cond_v1"] is None, str(r["cond_v1"]))


# ---------------------------------------------------------------------------
# The page
# ---------------------------------------------------------------------------

CLIPS = """
() => [...document.querySelectorAll('#edit-tracks .et-lane')].flatMap((l) =>
  [...l.querySelectorAll('.et-clip')].map((c) => ({
    track: l.dataset.track, id: c.dataset.clip, slot: c.dataset.slot || '', job: c.dataset.job || '',
    left: parseFloat(c.style.left), width: parseFloat(c.style.width) })))
"""

STALE = """
() => Object.fromEntries([...document.querySelectorAll('#edit-tracks .et-stale')].map((m) => [
  m.dataset.slot, { because: m.dataset.because, reason: m.dataset.reason, how: m.dataset.how,
                    label: m.getAttribute('aria-label') || '',
                    offer: !!m.querySelector('.et-stale-offer') }]))
"""


def to_video(pg):
    if not pg.eval_on_selector("#c-video", "e => e.classList.contains('hide')"):
        return
    pg.click("#g-duration")
    pg.wait_for_selector(".menu button")
    pg.locator(".menu button").nth(1).click()
    pg.wait_for_timeout(500)


def write(pg, text):
    pg.click("#prompt")
    pg.fill("#prompt", text)
    pg.wait_for_timeout(150)


def generate(pg, n):
    before = pg.eval_on_selector("#vid-out", "e => e.querySelector('video')?.src || ''")
    pg.click("#go-vid")
    pg.wait_for_function(
        "(b) => { const v = document.querySelector('#vid-out video'); return v && v.src && v.src !== b }",
        arg=before, timeout=40_000)
    pg.wait_for_function(
        "(n) => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= n",
        arg=n, timeout=40_000)
    pg.wait_for_timeout(400)


def chain(pg):
    pg.click("#canvas-chain")
    pg.wait_for_selector("#v-motion", timeout=10_000)
    pg.wait_for_timeout(300)


def v1(pg):
    return sorted([c for c in pg.evaluate(CLIPS) if c["track"] == "v1"], key=lambda c: c["left"])


def by_slot(pg, slot):
    return next((c for c in pg.evaluate(CLIPS) if c["slot"] == slot), None)


def wait_job(pg, slot, not_job, timeout=40_000):
    try:
        pg.wait_for_function(
            "([s, j]) => { const c = document.querySelector(`#edit-tracks .et-clip[data-slot=\"${s}\"]`);"
            " return c && c.dataset.job && c.dataset.job !== j }",
            arg=[slot, not_job], timeout=timeout)
        pg.wait_for_timeout(400)
        return True
    except Exception:
        return False


def stale(pg, settle=400):
    pg.wait_for_timeout(settle)
    return pg.evaluate(STALE)


def seek_to(pg, x):
    b = pg.locator("#edit-tracks .et-body").bounding_box()
    pg.mouse.click(b["x"] + x, b["y"] + 3)
    pg.wait_for_timeout(300)


def page():
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome")
        print(f"\n=== {URL} ===")
        probe = urllib.request.urlopen(URL + "/api/file/vidprobe/clip.mp4", timeout=60)
        check("the preview serves a real mp4 (ffmpeg on PATH)",
              probe.headers.get("Content-Type") == "video/mp4", probe.headers.get("Content-Type", ""))
        ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        pg = ctx.new_page()
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        renders: list[str] = []
        outputs: list[str] = []
        pg.on("request", lambda q: renders.append(q.url) if q.url.endswith("/api/video") and q.method == "POST"
              else outputs.append(q.url) if q.url.endswith("/api/outputs") and q.method == "POST" else None)
        pg.goto(URL, wait_until="networkidle", timeout=60_000)
        pg.wait_for_timeout(800)
        to_video(pg)

        # A scene of its own: the preview keeps scenes and the page reopens the
        # newest, so a second run would count the last run's takes.
        write(pg, "a throwaway take")
        generate(pg, 1)
        pg.click("#canvas-clear")
        pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)
        pressed = 1

        # ---- a three-take chain ----------------------------------------
        write(pg, "k3nan walks out of the shop")
        generate(pg, 1)
        pg.wait_for_selector("#edit-stage canvas", timeout=15_000)
        chain(pg)
        write(pg, "he stops when he sees the car")
        generate(pg, 2)
        chain(pg)
        write(pg, "the car pulls away")
        generate(pg, 3)
        pressed += 3
        takes = v1(pg)
        check("three takes on V1", len(takes) == 3, str([c["job"] for c in takes]))
        if len(takes) != 3:
            return
        s1, s2, s3 = (c["slot"] for c in takes)
        check("a fresh chain is not stale", stale(pg) == {}, str(stale(pg)))

        # ---- an insert over slot 2 that takes V1's frame ------------------
        lanes0 = pg.evaluate("() => document.querySelectorAll('#edit-tracks .et-lane').length")
        seek_to(pg, 4.5 * PX)
        pg.focus("#edit-play")
        pg.keyboard.press("i")
        pg.wait_for_function("(n) => document.querySelectorAll('#edit-tracks .et-lane').length === n + 1",
                             arg=lanes0, timeout=15_000)
        ins = next((c for c in pg.evaluate(CLIPS) if c["track"] != "v1"), None)
        check("I makes an insert over slot 2", ins is not None and abs(ins["left"] - 4.5 * PX) < 1.5, str(ins))
        if not ins:
            return
        pg.click(f'.et-inherited[data-insert="{ins["slot"]}"] [data-offer="frame"]')
        pg.wait_for_timeout(300)
        write(pg, "close on his hands on the wheel")
        pg.click(f'#edit-tracks .et-clip[data-slot="{ins["slot"]}"] [data-act="render"]')
        pressed += 1
        check("the insert renders on slot 2's frame", wait_job(pg, ins["slot"], ""))
        check("an insert made from slot 2's take is not stale while slot 2 plays it",
              stale(pg) == {}, str(stale(pg)))

        # ---- re-render slot 2 --------------------------------------------
        old2 = by_slot(pg, s2)["job"]
        pg.click(f'#edit-tracks .et-clip[data-slot="{s2}"] [data-act="render"]')
        pressed += 1
        check("slot 2's new take lands", wait_job(pg, s2, old2))
        marks = stale(pg)
        m3 = marks.get(s3, {})
        check("slot 3 is marked stale, because of slot 2",
              m3.get("because") == s2 and m3.get("reason") == "retaken" and m3.get("how") == "continue", str(m3))
        check("its sentence names slot 2's earlier take",
              "Continued from slot 2's earlier take" in m3.get("label", ""), m3.get("label", "")[:120])
        mi = marks.get(ins["slot"], {})
        check("the insert that took slot 2's frame is stale too",
              mi.get("because") == s2 and mi.get("how") == "frame", str(mi))
        check("slot 1 and slot 2 are not", s1 not in marks and s2 not in marks, str(sorted(marks)))
        check("the stale slot carries its offer", m3.get("offer") is True)
        check("the offer keeps off the trim handles", pg.evaluate("""(s) => {
            const c = document.querySelector(`#edit-tracks .et-clip[data-slot="${s}"]`)
            const m = c.querySelector('.et-stale-offer').getBoundingClientRect()
            return [...c.querySelectorAll('.et-trim')].every((h) => {
              const r = h.getBoundingClientRect()
              return m.right <= r.left || m.left >= r.right
            })
          }""", s3))
        check("and off the slot's own controls", pg.evaluate("""(s) => {
            const c = document.querySelector(`#edit-tracks .et-clip[data-slot="${s}"]`)
            const m = c.querySelector('.et-stale-offer').getBoundingClientRect()
            return [...c.querySelectorAll('[data-act]:not(.et-stale-offer)')].every((h) => {
              const r = h.getBoundingClientRect()
              return m.right <= r.left || m.left >= r.right || m.bottom <= r.top || m.top >= r.bottom
            })
          }""", s3))
        pg.wait_for_timeout(3000)
        check("nothing re-renders on its own", len(renders) == pressed, f"{len(renders)} requests, {pressed} pressed")

        # ---- derived: undo, redo, ‹ › ------------------------------------
        pg.evaluate("() => window.__edit.undo()")
        check("one undo of the re-render clears every mark", stale(pg, 800) == {}, str(stale(pg)))
        pg.evaluate("() => window.__edit.redo()")
        check("redo brings them back", sorted(stale(pg, 800)) == sorted([s3, ins["slot"]]), str(sorted(stale(pg))))
        pg.click(f'#edit-tracks .et-clip[data-slot="{s2}"] [data-act="prev"]')
        check("‹ back to slot 2's old take clears them", stale(pg, 1200) == {}, str(stale(pg)))
        pg.click(f'#edit-tracks .et-clip[data-slot="{s2}"] [data-act="next"]')
        check("› to the new one marks them again", sorted(stale(pg, 1200)) == sorted([s3, ins["slot"]]),
              str(sorted(stale(pg))))
        check("still nothing re-rendered on its own", len(renders) == pressed, f"{len(renders)} vs {pressed}")

        # ---- Export names them before encoding ---------------------------
        pg.wait_for_selector("#export-go:not([disabled])", timeout=40_000)
        pg.click("#export-go")
        pg.wait_for_timeout(500)
        said = pg.text_content("#export-stale") if pg.locator("#export-stale").count() else ""
        check("the first press names the stale slots on the control",
              said == "2 slots are out of date: slot 3, insert at 0:04.5", said or "(no #export-stale)")
        check("and encodes nothing", pg.locator("#export-status").count() == 0 and not outputs)
        check("the control says the next press exports anyway",
              (pg.text_content("#export-go") or "").strip() == "Export anyway", pg.text_content("#export-go") or "")
        pg.click("#export-rerender")
        pg.wait_for_timeout(400)
        focused = pg.evaluate("() => { const a = document.activeElement;"
                              " return a && a.classList.contains('et-stale-offer') ? a.dataset.slot : '' }")
        check("Re-render first goes to the first stale slot's offer", focused == s3, focused)
        check("and renders nothing", len(renders) == pressed, f"{len(renders)} vs {pressed}")
        pg.click("#export-go")
        pg.wait_for_selector("#export-stale", timeout=5_000)
        pg.click("#export-go")
        try:
            pg.wait_for_selector("#export-status", timeout=15_000)
            encoding = True
        except Exception:
            encoding = False
        check("the second press encodes", encoding)
        if pg.locator("#export-stop").count():
            pg.click("#export-stop")
            pg.wait_for_selector("#export-go", timeout=10_000)

        # ---- the offer ------------------------------------------------------
        old_i = by_slot(pg, ins["slot"])["job"]
        pg.click(f'#edit-tracks .et-clip[data-slot="{ins["slot"]}"] .et-stale-offer')
        pressed += 1
        check("the insert's offer renders it again", wait_job(pg, ins["slot"], old_i))
        check("once", len(renders) == pressed, f"{len(renders)} vs {pressed}")
        marks = stale(pg, 800)
        check("and its mark clears — it was made from slot 2's new take",
              ins["slot"] not in marks and s3 in marks, str(sorted(marks)))

        # ---- after a reload -------------------------------------------------
        pg.wait_for_timeout(2500)
        pg.goto(URL, wait_until="networkidle", timeout=60_000)
        pg.wait_for_timeout(800)
        to_video(pg)
        pg.wait_for_function(
            "() => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= 3",
            timeout=40_000)
        pg.wait_for_timeout(1500)
        marks = stale(pg)
        check("after a reload slot 3 is still stale, read from the takes' records",
              marks.get(s3, {}).get("because") == s2 and ins["slot"] not in marks, str(marks))

        # ---- the continuation's offer, in place ------------------------------
        bodies: list[dict] = []
        pg.on("request", lambda q: bodies.append(q.post_data_json or {})
              if q.url.endswith("/api/video") and q.method == "POST" else None)
        old3 = by_slot(pg, s3)["job"]
        new2 = by_slot(pg, s2)["job"]
        line3 = pg.evaluate("(s) => document.querySelector(`#edit-tracks .et-clip[data-slot=\"${s}\"] .et-line`)"
                            "?.textContent || ''", s3)
        pg.click(f'#edit-tracks .et-clip[data-slot="{s3}"] .et-stale-offer')
        check("slot 3's offer renders it again in its own slot", wait_job(pg, s3, old3))
        pg.wait_for_timeout(1500)
        check("with one request", len(bodies) == 1, str(len(bodies)))
        body = bodies[0] if bodies else {}
        check("continued from slot 2's new take, with slot 3's own sentence",
              body.get("continue_from") == new2 and body.get("prompt") == line3,
              json.dumps({k: body.get(k) for k in ("continue_from", "prompt")}) + f" want {new2} {line3!r}")
        takes = v1(pg)
        check("V1 still holds three slots, in the same order",
              [c["slot"] for c in takes] == [s1, s2, s3], str([c["slot"] for c in takes]))
        check("and nothing is out of date any more", stale(pg, 800) == {}, str(stale(pg)))
        pg.evaluate("() => window.__edit.undo()")
        marks = stale(pg, 800)
        check("one undo puts the stale take back, mark and all",
              by_slot(pg, s3)["job"] == old3 and s3 in marks, f"{by_slot(pg, s3)['job']} {sorted(marks)}")
        pg.evaluate("() => window.__edit.redo()")
        check("redo clears it again", stale(pg, 800) == {}, str(stale(pg)))

        check("no uncaught errors", not errors, "; ".join(errors[:3]))
        ctx.close()
        b.close()


pure()
page()
print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

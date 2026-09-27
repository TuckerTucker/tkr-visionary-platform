"""
Rendering is an edit: a slot's takes step with ‹ ›, and undo reaches a render.

    python3 tools/ui-checks/check_slots.py                         # :8797
    python3 tools/ui-checks/check_slots.py 8794                    # a port
    python3 tools/ui-checks/check_slots.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per job
when ffmpeg is on the PATH — without one the engine has nothing to read and
this fails rather than passing on structure. Undo is reached through
`window.__edit` until the history has a control of its own.

What it holds, and the failure each one is for:

- **Rendering a slot again adds a take and replaces the clip's.** The slot
  shows the job's phase while it runs, then plays the new take in the same
  place — and ‹ 1 / 2 › steps back to the first, which is what makes a
  re-render safe to press.
- **Undo after a render returns the previous take, and the undone take's bytes
  stay on the volume.** Its file is still served; the slot still lists it.
- **A slot keeps every take it has had in the intent sidecar.** Each take is
  stamped with its slot in `scene.json`, so a reload still steps.
- **Continue from a slot lands after that slot, not at the end**, moving the
  rest of the track along — one undo takes it back out.
- **Stop cancels the slot's job** and leaves the slot on the take it had.
- **A refused job says so on the slot, verbatim.**
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8797"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def http(path):
    with urllib.request.urlopen(URL + path, timeout=10) as r:
        return json.loads(r.read())


FADES = """
() => [...document.querySelectorAll('#edit-tracks .et-fade')].map((f) =>
  ({ left: parseFloat(f.style.left), width: parseFloat(f.style.width) }))
"""

CLIPS = """
() => [...document.querySelectorAll('#edit-tracks .et-lane[data-track="v1"] .et-clip')]
  .map((c) => ({ id: c.dataset.clip, job: c.dataset.job || '', slot: c.dataset.slot || '',
                 left: parseFloat(c.style.left), width: parseFloat(c.style.width),
                 count: c.querySelector('.et-slot-nav .count')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
                 phase: c.querySelector('.et-slot-phase')?.textContent || '',
                 err: c.querySelector('.et-slot-err')?.textContent || '' }))
  .sort((a, b) => a.left - b.left)
"""


def clips(pg):
    return pg.evaluate(CLIPS)


def slot_el(slot):
    return f'#edit-tracks .et-clip[data-slot="{slot}"]'


def to_video(pg):
    """Duration is the switch — see check_edit.py."""
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


def generate(pg, n_takes=None):
    before = pg.eval_on_selector("#vid-out", "e => e.querySelector('video')?.src || ''")
    pg.click("#go-vid")
    pg.wait_for_function(
        "(b) => { const v = document.querySelector('#vid-out video'); return v && v.src && v.src !== b }",
        arg=before, timeout=40_000)
    if n_takes is not None:
        pg.wait_for_function(
            "(n) => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= n",
            arg=n_takes, timeout=40_000)
    pg.wait_for_timeout(400)


def wait_job(pg, slot, not_job, timeout=40_000):
    pg.wait_for_function(
        "([s, j]) => { const c = document.querySelector(`#edit-tracks .et-clip[data-slot=\"${s}\"]`);"
        " return c && c.dataset.job && c.dataset.job !== j }",
        arg=[slot, not_job], timeout=timeout)
    pg.wait_for_timeout(300)


def stage(pg):
    """The stage's picture at the playhead, once the Studio has had time to
    load a swapped clip and draw it."""
    pg.wait_for_timeout(1500)
    return pg.locator("#edit-stage").screenshot()


def seek_to(pg, x):
    """A press on the timeline's ruler, `x` px in — the one strip where no clip
    or control is under it (see check_cuts.py)."""
    b = pg.locator("#edit-tracks .et-body").bounding_box()
    pg.mouse.click(b["x"] + x, b["y"] + 3)
    pg.wait_for_timeout(300)


def by_slot(pg, slot):
    return next((c for c in clips(pg) if c["slot"] == slot), None)


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
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1000)
    to_video(pg)
    # A fresh scene: one throwaway take and Clear, as check_edit.py does.
    write(pg, "a throwaway take")
    generate(pg)
    pg.click("#canvas-clear")
    pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)

    write(pg, "k3nan walks out of the shop")
    generate(pg, 1)
    pg.click("#canvas-chain")
    pg.wait_for_timeout(600)
    write(pg, "he stops when he sees the car")
    generate(pg, 2)
    a, bb = clips(pg)
    check("two slots on V1, each a slot overlay", pg.locator("#edit-tracks .et-slot").count() == 2)
    check("one take each: no stepper yet", not a["count"] and not bb["count"], f"{a['count']!r} {bb['count']!r}")
    slot_a, job_a1 = a["slot"], a["job"]

    # ---- render slot A again --------------------------------------------
    write(pg, "")  # an empty prompt renders the slot's own sentence again
    pg.click(f'{slot_el(slot_a)} [data-act="render"]')
    pg.wait_for_selector(f"{slot_el(slot_a)} .et-slot-phase", timeout=10_000)
    phase = pg.text_content(f"{slot_el(slot_a)} .et-slot-phase") or ""
    check("the slot shows the job's phase while it renders", bool(phase.strip()), repr(phase))
    wait_job(pg, slot_a, job_a1)
    a2 = by_slot(pg, slot_a)
    job_a2 = a2["job"] if a2 else ""
    check("the landed take replaces the slot's clip, in place",
          a2 is not None and a2["id"] == a["id"] and abs(a2["left"] - a["left"]) < 1,
          str(a2))
    check("still two clips on V1", len(clips(pg)) == 2)
    check("the slot steps: 2 / 2", a2 is not None and a2["count"] == "2 / 2", a2["count"] if a2 else "")
    line = pg.text_content(f"{slot_el(slot_a)} .et-line") or ""
    check("the re-render used the slot's own sentence", "walks out" in line, repr(line))

    # ---- step between its two takes ------------------------------------
    # The stage is compared as well as the timeline: the Core can hold the new
    # take while the Studio still draws the old one (an update patch does not
    # reload a clip's file), and only the picture says which. The preview draws
    # the job id on every frame, so two takes are two pictures.
    #
    # The head is put inside slot A first. The stage holds the head at the
    # start of whatever landed last (slice 8), which here is slot B — so without
    # this all three pictures are B's and the comparison says nothing about A.
    seek_to(pg, a["left"] + a["width"] / 2)
    shot_2 = stage(pg)
    # Without this the comparisons below could pass on a stage that merely
    # repaints differently each time.
    check("the stage is the same picture when nothing changed", stage(pg) == shot_2)
    pg.click(f'{slot_el(slot_a)} [data-act="prev"]')
    wait_job(pg, slot_a, job_a2)
    a3 = by_slot(pg, slot_a)
    check("‹ steps back to the first take", a3 and a3["job"] == job_a1 and a3["count"] == "1 / 2", str(a3))
    shot_1 = stage(pg)
    check("and the stage shows it", shot_1 != shot_2)
    pg.click(f'{slot_el(slot_a)} [data-act="next"]')
    wait_job(pg, slot_a, job_a1)
    a4 = by_slot(pg, slot_a)
    check("› steps forward to the second", a4 and a4["job"] == job_a2 and a4["count"] == "2 / 2", str(a4))
    check("and the stage shows that", stage(pg) != shot_1)

    # ---- undo reaches it ------------------------------------------------
    pg.evaluate("() => window.__edit.undo()")  # the › step
    wait_job(pg, slot_a, job_a2)
    pg.evaluate("() => window.__edit.undo()")  # the ‹ step
    wait_job(pg, slot_a, job_a1)
    pg.evaluate("() => window.__edit.undo()")  # the render
    pg.wait_for_timeout(800)
    a5 = by_slot(pg, slot_a)
    check("undo after the render returns the previous take",
          a5 is not None and a5["job"] == job_a1, str(a5))
    check("and the slot still lists the undone take", a5 is not None and a5["count"] == "1 / 2",
          a5["count"] if a5 else "")
    got = urllib.request.urlopen(f"{URL}/api/file/{job_a2}/clip.mp4", timeout=30)
    check("the undone take's bytes are still served", got.status == 200
          and got.headers.get("Content-Type") == "video/mp4", f"{got.status} {got.headers.get('Content-Type')}")
    pg.evaluate("() => window.__edit.redo()")
    wait_job(pg, slot_a, job_a1)
    check("redo puts the render back", (by_slot(pg, slot_a) or {}).get("job") == job_a2)

    # ---- the intent keeps every take a slot has had ----------------------
    sid = None
    stamped = []
    deadline = time.time() + 10
    while time.time() < deadline:
        rows = http("/api/scenes")["scenes"]
        sid = rows[0]["id"] if rows else None
        takes = ((http(f"/api/scenes/{sid}") or {}).get("intent") or {}).get("takes") or []
        stamped = [t for t in takes if t.get("slot") == slot_a]
        if len(stamped) >= 2:
            break
        time.sleep(0.4)
    check("scene.json stamps both of the slot's takes with its slot",
          sorted(t["jobId"] for t in stamped) == sorted([job_a1, job_a2]), str(stamped))

    # ---- continue from slot A lands between A and B ----------------------
    before = clips(pg)
    b_left = next(c["left"] for c in before if c["slot"] == bb["slot"])
    pg.click(f'{slot_el(slot_a)} [data-act="continue"]')
    pg.wait_for_timeout(600)
    focused = pg.evaluate("() => document.activeElement?.id")
    check("continue hands the prompt over, empty", focused == "prompt"
          and pg.input_value("#prompt") == "", f"{focused} {pg.input_value('#prompt')!r}")
    write(pg, "the car door opens")
    generate(pg, 3)
    after = clips(pg)
    order = [c["slot"] for c in after]
    new = [c for c in after if c["slot"] not in (slot_a, bb["slot"])]
    check("the continuation lands directly after the slot it continues",
          len(after) == 3 and order[0] == slot_a and order[2] == bb["slot"], str(order))
    if len(after) == 3 and new:
        check("it starts where that slot ends",
              abs(after[0]["left"] + after[0]["width"] - new[0]["left"]) < 1.5,
              f"{after[0]['left']}+{after[0]['width']} vs {new[0]['left']}")
        check("and the slot after it moved along by its length",
              abs(after[2]["left"] - (b_left + new[0]["width"])) < 1.5, f"{b_left} -> {after[2]['left']}")
    pg.evaluate("() => window.__edit.undo()")
    pg.wait_for_function(
        "() => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length === 2",
        timeout=10_000)
    back = clips(pg)
    check("one undo takes the continuation out and closes the gap",
          [c["slot"] for c in back] == [slot_a, bb["slot"]] and abs(back[1]["left"] - b_left) < 1.5,
          str([(c["slot"], c["left"]) for c in back]))

    # ---- a re-render keeps each crossfade on its cut ---------------------
    # A take of a new length moves the cut after it, and the dissolve on that
    # cut has to move with it — rippling only the pictures once left it where
    # the cut used to be. Trim A by a second, dissolve A into B, render A again:
    # the new take plays whole, so the cut and its dissolve go back to 3s.
    a_id = by_slot(pg, slot_a)["id"]
    b_id = by_slot(pg, bb["slot"])["id"]
    full = by_slot(pg, slot_a)["width"]
    lane = pg.locator('#edit-tracks .et-lane[data-track="v1"]').bounding_box()
    body = pg.locator("#edit-tracks .et-body").bounding_box()
    y = lane["y"] + lane["height"] * 0.7
    pg.mouse.move(body["x"] + full - 3, y)
    pg.mouse.down()
    for i in range(1, 13):
        pg.mouse.move(body["x"] + full - 3 - 30 * i / 12, y)
        pg.wait_for_timeout(16)
    pg.mouse.up()
    pg.wait_for_timeout(700)
    trimmed = by_slot(pg, slot_a)["width"]
    check("slot A trimmed by a second", abs(trimmed - (full - 30)) < 1.5, str(trimmed))
    pg.click(f'.et-cut[data-from="{a_id}"][data-to="{b_id}"]')
    pg.wait_for_timeout(600)
    fades = pg.evaluate(FADES)
    check("a dissolve on the A|B cut", len(fades) == 1 and abs(fades[0]["left"] + fades[0]["width"] / 2 - trimmed) < 1,
          str(fades))
    job_before = by_slot(pg, slot_a)["job"]
    write(pg, "")
    pg.click(f'{slot_el(slot_a)} [data-act="render"]')
    wait_job(pg, slot_a, job_before)
    pg.wait_for_timeout(500)
    now_a, now_b = by_slot(pg, slot_a), by_slot(pg, bb["slot"])
    fades = pg.evaluate(FADES)
    check("the new take plays whole, and B starts where it ends",
          abs(now_a["width"] - full) < 1.5 and abs(now_b["left"] - now_a["width"]) < 1.5,
          f"A {now_a['width']} B@{now_b['left']}")
    check("and the dissolve moved with the cut",
          len(fades) == 1 and abs(fades[0]["left"] + fades[0]["width"] / 2 - now_a["width"]) < 1, str(fades))
    sid = http("/api/scenes")["scenes"][0]["id"]
    deadline = time.time() + 10
    ts = []
    while time.time() < deadline:
        proj = http(f"/api/scenes/{sid}").get("project") or {}
        ts = [c for c in (proj.get("clips") or {}).values() if c.get("type") == "Transition"]
        d = (ts[0].get("timing") or {}).get("display") or {} if ts else {}
        if ts and abs((d.get("from", 0) + d.get("to", 0)) / 2 - 3_000_000) < 50_000:
            break
        time.sleep(0.4)
    d = (ts[0].get("timing") or {}).get("display") or {} if ts else {}
    check("project.json has it centred on the new cut", len(ts) == 1
          and abs((d.get("from", 0) + d.get("to", 0)) / 2 - 3_000_000) < 50_000, json.dumps(d))
    job_a3 = now_a["job"]
    pg.evaluate("() => window.__edit.undo()")
    wait_job(pg, slot_a, job_a3)
    now_a, fades = by_slot(pg, slot_a), pg.evaluate(FADES)
    check("undo puts the trimmed take, the cut and the dissolve back",
          now_a["job"] == job_before and abs(now_a["width"] - trimmed) < 1.5 and len(fades) == 1
          and abs(fades[0]["left"] + fades[0]["width"] / 2 - trimmed) < 1, f"{now_a} {fades}")
    pg.evaluate("() => window.__edit.redo()")
    wait_job(pg, slot_a, job_before)

    # ---- stop -----------------------------------------------------------
    write(pg, "")
    pg.click(f'{slot_el(slot_a)} [data-act="render"]')
    pg.wait_for_selector(f'{slot_el(slot_a)} [data-act="stop"]:not([disabled])', timeout=10_000)
    pg.click(f'{slot_el(slot_a)} [data-act="stop"]')
    pg.wait_for_function(
        "(s) => !document.querySelector(`#edit-tracks .et-clip[data-slot=\"${s}\"] .et-slot-phase`)",
        arg=slot_a, timeout=10_000)
    pg.wait_for_timeout(1500)
    a6 = by_slot(pg, slot_a)
    check("stop cancels the render and the slot keeps its take",
          a6 is not None and a6["job"] == job_a3 and a6["count"] == "3 / 3" and not a6["err"], str(a6))

    # ---- a refused job ---------------------------------------------------
    refusal = "The scene names @mara, who is not in the cast. Add her or take the handle out."
    pg.route("**/api/video", lambda r: r.fulfill(status=200, content_type="application/json",
                                                 body=json.dumps({"error": refusal})))
    pg.click(f'{slot_el(slot_a)} [data-act="render"]')
    pg.wait_for_selector(f"{slot_el(slot_a)} .et-slot-err", timeout=10_000)
    shown = pg.text_content(f"{slot_el(slot_a)} .et-slot-err") or ""
    check("a refused job is on the slot, verbatim", refusal in shown, repr(shown))
    pg.unroute("**/api/video")
    pg.click(f'{slot_el(slot_a)} .et-slot-err [data-act="dismiss"]')
    check("and is dismissed by its ✕", pg.locator(f"{slot_el(slot_a)} .et-slot-err").count() == 0)

    # ---- a reload still steps --------------------------------------------
    pg.wait_for_timeout(1500)  # past the savers' debounce
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(1000)
    to_video(pg)
    pg.wait_for_function(
        "(s) => document.querySelector(`#edit-tracks .et-clip[data-slot=\"${s}\"] .et-slot-nav`)",
        arg=slot_a, timeout=40_000)
    a7 = by_slot(pg, slot_a)
    check("after a reload the slot still has all three takes", a7 is not None and a7["count"] == "3 / 3",
          str(a7))
    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

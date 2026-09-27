"""
One timeline on screen: the shot bars live inside the V1 slots.

    python3 tools/ui-checks/check_shots.py                         # :8813
    python3 tools/ui-checks/check_shots.py 8794                    # a port
    python3 tools/ui-checks/check_shots.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real 3-second MP4
per job when ffmpeg is on the PATH — without one the engine has nothing to read
and no V1 clip ever appears, so this fails rather than passing on structure.

What it holds, and the failure each one is for:

- **A scene with no takes shows the composer's own track.** Duration starts at
  zero: before the first render there is no edit timeline, and the shots have
  to be pullable somewhere.
- **With takes there is exactly one timeline.** No `.tl-rule` and no `.tl`
  outside `#edit-tracks` — the composer's track and the edit timeline were the
  same film drawn twice at one scale.
- **The composer's shots are the pending slot after V1**, starting where V1
  ends, one bar per shot, with their sentences.
- **A rendered slot holds the shots rendered in it** — the `[Shot N]` cut is a
  hairline inside the clip, not a clip of its own.
- **Pulling a pending bar sets its beats** — by mouse, by a touch pointer, and
  by keys (0.5s steps, Home the floor) — and a press on a pending bar selects
  the shot without seeking the playhead.
- **Past the cap the shots spill into a second pending slot**, and a shot
  longer than one generation spans several, numbered by part.
- **Clearing the takes brings the composer's track back.**
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8813"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def http(path):
    with urllib.request.urlopen(URL + path, timeout=10) as r:
        return json.loads(r.read())


V1 = '#edit-tracks .et-lane[data-track="v1"]'

# Timelines outside the edit tracks — the composer's own — counted by its
# ruler and its root, so a regression that mounts either half is caught.
OUTSIDE = """
() => ({
  rules: [...document.querySelectorAll('.tl-rule')].filter((e) => !e.closest('#edit-tracks')).length,
  tls: [...document.querySelectorAll('.tl')].filter((e) => !e.closest('#edit-tracks')).length,
})
"""

PENDING = """
() => [...document.querySelectorAll('#edit-tracks .et-pending')].map((p) => ({
  left: p.getBoundingClientRect().left, width: p.getBoundingClientRect().width,
  bars: [...document.querySelectorAll(`#edit-tracks .et-pending-slots .tl-shot[data-gen="${p.dataset.pending}"]`)]
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map((b) => ({
    shot: b.dataset.shot, part: +b.dataset.part, parts: +b.dataset.parts,
    text: b.querySelector('.tl-line')?.textContent || '',
    beats: b.querySelector('.tl-pull') ? +b.querySelector('.tl-pull').getAttribute('aria-valuenow') : null,
  })),
}))
"""

V1_END = """
() => Math.max(0, ...[...document.querySelectorAll('#edit-tracks .et-lane[data-track="v1"] .et-clip')]
  .map((c) => c.getBoundingClientRect().right))
"""

HEAD_X = """
() => {
  const h = document.querySelector('#edit-head');
  const m = h && /translateX\\(([-\\d.]+)px\\)/.exec(h.style.transform);
  return m ? parseFloat(m[1]) : null;
}
"""

# A touch pointer, dispatched: Playwright's touchscreen taps but does not drag,
# and the pull listens for pointer events whatever their type. Capture on a
# synthetic id throws, which the pull swallows — the listeners are on the
# handle itself, so the moves below still reach it.
TOUCH_PULL = """
([sel, dx]) => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const o = (cx) => ({ pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0,
                       buttons: 1, clientX: cx, clientY: y, bubbles: true, cancelable: true });
  el.dispatchEvent(new PointerEvent('pointerdown', o(x)));
  el.dispatchEvent(new PointerEvent('pointermove', o(x + dx / 2)));
  el.dispatchEvent(new PointerEvent('pointermove', o(x + dx)));
  el.dispatchEvent(new PointerEvent('pointerup', o(x + dx)));
  return true;
}
"""


def pending(pg):
    return pg.evaluate(PENDING)


def shot_ids(pg):
    ids: list[str] = []
    for g in pending(pg):
        for b in g["bars"]:
            if b["shot"] not in ids:
                ids.append(b["shot"])
    return ids


def pull_sel(pg, n):
    return f'#edit-tracks .et-pending-slots .tl-shot[data-shot="{shot_ids(pg)[n - 1]}"] .tl-pull'


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


def generate(pg, n_takes):
    before = pg.eval_on_selector("#vid-out", "e => e.querySelector('video')?.src || ''")
    pg.click("#go-vid")
    pg.wait_for_function(
        "(b) => { const v = document.querySelector('#vid-out video'); return v && v.src && v.src !== b }",
        arg=before, timeout=40_000)
    pg.wait_for_function(
        "(n) => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= n",
        arg=n_takes, timeout=40_000)
    pg.wait_for_timeout(600)


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    print(f"\n=== {URL} ===")
    probe = urllib.request.urlopen(URL + "/api/file/vidprobe/clip.mp4", timeout=60)
    check("the preview serves a real mp4 (ffmpeg on PATH)",
          probe.headers.get("Content-Type") == "video/mp4", probe.headers.get("Content-Type", ""))
    st = http("/api/state")
    check("/api/state serves the re-anchor interval",
          isinstance(st.get("h3mc_reanchor_takes"), int) and st["h3mc_reanchor_takes"] >= 1,
          repr(st.get("h3mc_reanchor_takes")))

    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1000)
    to_video(pg)
    # A fresh scene: the preview keeps the last run's scene, so one throwaway
    # take and Clear, as check_edit.py does.
    if pg.locator("#edit-tracks").count():
        pg.click("#canvas-clear")
        pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)

    # ---- no takes: the composer's own track -------------------------------
    o = pg.evaluate(OUTSIDE)
    check("no takes: the composer's timeline is on screen",
          o["tls"] == 1 and o["rules"] == 1 and pg.locator("#edit-tracks").count() == 0, str(o))

    write(pg, "a man walks into the kitchen")
    pg.press("#prompt", "Enter")
    pg.wait_for_timeout(200)
    write(pg, "he sits down at the table")
    check("two shots on the composer's track", pg.locator(".tl .tl-shot").count() == 2,
          str(pg.locator(".tl .tl-shot").count()))

    generate(pg, 1)

    # ---- with takes: one timeline -----------------------------------------
    o = pg.evaluate(OUTSIDE)
    check("with takes there is exactly one timeline (no composer track outside the edit tracks)",
          o["tls"] == 0 and o["rules"] == 0, str(o))
    check("the edit timeline keeps its own ruler", pg.locator("#edit-tracks .et-rule").count() == 1)

    p = pending(pg)
    check("one pending slot after V1", len(p) == 1, str(len(p)))
    bars = p[0]["bars"] if p else []
    check("the pending slot shows the composer's shots, one bar each, with their sentences",
          [x["text"] for x in bars] == ["a man walks into the kitchen", "he sits down at the table"],
          str([x["text"] for x in bars]))
    end = pg.evaluate(V1_END)
    check("the pending slot starts where V1 ends", p and abs(p[0]["left"] - end) < 2,
          f"pending {p[0]['left'] if p else None} v1 end {end}")
    check("a pending slot is as wide as its shots (8s at 30px/s)",
          p and abs(p[0]["width"] - 240) < 2, str(p[0]["width"] if p else None))

    cuts = pg.locator(f"{V1} .et-clip .et-shot-cut").count()
    check("the rendered slot holds its two shots: one [Shot N] cut inside the clip, not two clips",
          cuts == 1 and pg.locator(f"{V1} .et-clip").count() == 1, f"cuts={cuts}")
    cx = pg.evaluate(f"() => parseFloat(document.querySelector('{V1} .et-shot-cut')?.style.left || 'NaN')")
    # 4s + 4s recorded, scaled onto the 3s preview clip: the cut is at 1.5s.
    check("the cut sits where the recorded beats put it on the delivered file", abs(cx - 45) < 1.5, str(cx))

    # ---- pulling a pending bar --------------------------------------------
    ids = shot_ids(pg)
    head0 = pg.evaluate(HEAD_X)
    pg.click(f'#edit-tracks .et-pending-slots .tl-shot[data-shot="{ids[0]}"] .tl-line')
    pg.wait_for_timeout(300)
    check("pressing a pending bar does not seek", pg.evaluate(HEAD_X) == head0,
          f"{head0} -> {pg.evaluate(HEAD_X)}")
    check("pressing a pending bar selects that shot for writing",
          pg.evaluate("() => document.activeElement?.id") == "prompt"
          and pg.input_value("#prompt") == "a man walks into the kitchen",
          pg.input_value("#prompt"))

    h = pg.locator(pull_sel(pg, 2)).bounding_box()
    pg.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2)
    pg.mouse.down()
    pg.mouse.move(h["x"] + h["width"] / 2 + 30, h["y"] + h["height"] / 2, steps=4)
    pg.mouse.move(h["x"] + h["width"] / 2 + 60, h["y"] + h["height"] / 2, steps=4)
    pg.mouse.up()
    pg.wait_for_timeout(200)
    b2 = pending(pg)[0]["bars"][1]["beats"]
    check("dragging a pending shot's edge 60px sets its beats 4 → 6", b2 == 6, str(b2))
    check("the playhead did not move during the pull", pg.evaluate(HEAD_X) == head0)

    # Across the cap mid-drag: 4 + 6 → 4 + 14 carries shot 2 into a second
    # pending slot while the pointer is still down, and the pull has to survive
    # its bar moving.
    h = pg.locator(pull_sel(pg, 2)).bounding_box()
    x0, y0 = h["x"] + h["width"] / 2, h["y"] + h["height"] / 2
    pg.mouse.move(x0, y0)
    pg.mouse.down()
    pg.mouse.move(x0 + 150, y0, steps=6)
    pg.mouse.move(x0 + 240, y0, steps=6)
    pg.mouse.up()
    pg.wait_for_timeout(200)
    p = pending(pg)
    b2 = p[-1]["bars"][-1]["beats"] if p and p[-1]["bars"] else None
    check("a pull that carries a shot past the cap keeps pulling (6 → 14, into a second slot)",
          b2 == 14 and len(p) == 2, f"beats={b2} slots={len(p)}")

    pg.evaluate(TOUCH_PULL, [pull_sel(pg, 2), -45])
    pg.wait_for_timeout(200)
    b2 = pending(pg)[-1]["bars"][-1]["beats"]
    check("a touch pull works the same (−45px → 12.5s)", b2 == 12.5, str(b2))

    pg.focus(pull_sel(pg, 2))
    pg.keyboard.press("ArrowRight")
    pg.wait_for_timeout(100)
    b2 = pending(pg)[-1]["bars"][-1]["beats"]
    check("→ on the edge adds half a second", b2 == 13, str(b2))
    pg.keyboard.press("Home")
    pg.wait_for_timeout(100)
    b2 = pending(pg)[0]["bars"][-1]["beats"]
    check("Home pulls it to the floor (1s), back into one slot", b2 == 1 and len(pending(pg)) == 1, str(b2))
    check("the edge keeps keyboard focus across the move",
          pg.evaluate("() => document.activeElement?.classList.contains('tl-pull')"))

    # ---- spilling past one generation ---------------------------------------
    pg.keyboard.press("End")  # one whole generation: 4 + 14 crosses the cap
    pg.wait_for_timeout(150)
    p = pending(pg)
    check("past the cap the shots spill into a second pending slot",
          len(p) == 2 and [len(g["bars"]) for g in p] == [1, 1], str([len(g["bars"]) for g in p]))
    check("the two pending slots abut: the break is the slot boundary",
          len(p) == 2 and abs(p[0]["left"] + p[0]["width"] - p[1]["left"]) < 1.5)

    for _ in range(3):
        pg.keyboard.press("Shift+ArrowRight")  # 14 → 29
    pg.keyboard.press("ArrowRight")
    pg.keyboard.press("ArrowRight")  # → 30
    pg.wait_for_timeout(150)
    p = pending(pg)
    parts = [(x["part"], x["parts"]) for g in p for x in g["bars"] if x["shot"] == ids[1]]
    check("a 30-second shot spans three chained slots, numbered by part",
          len(p) == 4 and parts == [(1, 3), (2, 3), (3, 3)], f"slots={len(p)} parts={parts}")
    check("only the shot's last piece carries the pull",
          [x["beats"] for g in p for x in g["bars"] if x["shot"] == ids[1]] == [None, None, 30])

    # ---- clearing the takes -------------------------------------------------
    pg.click("#canvas-clear")
    pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)
    pg.wait_for_timeout(300)
    o = pg.evaluate(OUTSIDE)
    check("with the takes cleared the composer's timeline is back", o["tls"] == 1 and o["rules"] == 1, str(o))
    cut_marks = pg.locator(".tl .tl-cut").count()
    check("and draws the long shot's generation breaks inside its bar", cut_marks == 3, str(cut_marks))

    check("no page errors", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{'PASS' if not fails else 'FAIL'} — {len(fails)} failing")
sys.exit(1 if fails else 0)

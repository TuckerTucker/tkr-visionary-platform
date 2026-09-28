"""
The canvas is one surface: the frame layer draws a still, the stage draws a cut.

    python3 tools/ui-checks/check_stage.py                         # :8798
    python3 tools/ui-checks/check_stage.py 8794                    # a port
    python3 tools/ui-checks/check_stage.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per job when
ffmpeg is on the PATH — without one the engine has nothing to read, and this
says so and fails rather than passing on structure alone.

What it holds, and the failure each one is for:

- **A still never pays for motion.** A four-image batch renders on the frame
  layer with no stage mounted and no lazily-loaded script requested: the engine
  is 890 KB gzipped and "duration starts at zero" vetoes making a still wait for
  it.
- **Stepping a batch costs a compositor frame.** Every frame of the strip is
  mounted, so `‹ n / N ›` across all four issues no image request at all.
- **With time, the stage *is* the canvas.** It mounts inside `#vid-out` — not a
  96px monitor beside the timeline, and not a `<video>` — and it is the largest
  thing on screen. The slot stays shown, and the canvas keeps its actions and
  its receipt line. A picture dropped over the stage lands by where it is let
  go, the same as on the empty canvas — that is the canvas's, not the slot's,
  and `check_video_zones.py` holds it.
- **A render is replaced when the next lands.** After a second take, the stage
  has moved the playhead to that take's start, held there, and Play runs the
  cut from it at once.
- **Full screen is the stage.** The expand button full-screens the stage
  element itself rather than opening one file in the viewer.
"""
import json
import re
import sys
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8798"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []

# 30px a second — `PX_PER_SEC` in scene/Timeline, which the edit timeline shares.
PX_PER_SEC = 30
TAKE_SEC = 3


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def entry_scripts():
    """The scripts index.html loads; any other /assets/*.js is a lazy chunk."""
    with urllib.request.urlopen(URL + "/", timeout=10) as r:
        html = r.read().decode()
    return set(re.findall(r'/assets/[^"\']+\.js', html))


def lazy_js(requests, entry):
    return sorted({u for u in requests
                   if re.search(r"/assets/[^/?]+\.js", u)
                   and not any(u.endswith(e) for e in entry)})


TYPE = """
(text) => {
  const ta = document.querySelector('#prompt');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, text);
  ta.dispatchEvent(new Event('input', {bubbles: true}));
}
"""

HEAD_X = """
() => {
  const h = document.querySelector('#edit-head');
  const m = h && /translateX\\(([-\\d.]+)px\\)/.exec(h.style.transform);
  return m ? parseFloat(m[1]) : null;
}
"""

# The handover is done when the stage is drawn and the bridging clip is gone.
ON_STAGE = """
() => !!document.querySelector('#vid-out #edit-stage canvas')
      && !document.querySelector('#vid-out video')
"""


def to_video(pg):
    """Duration is the switch — see web/src/console/Duration.tsx."""
    if not pg.eval_on_selector("#c-video", "e => e.classList.contains('hide')"):
        return
    pg.click("#g-duration")
    pg.wait_for_selector(".menu button")
    pg.locator(".menu button").nth(1).click()
    pg.wait_for_timeout(500)


def render_take(pg, n_clips):
    pg.click("#go-vid")
    pg.wait_for_function(
        "(n) => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= n",
        arg=n_clips, timeout=60_000)
    pg.wait_for_function(ON_STAGE, timeout=30_000)
    pg.wait_for_timeout(400)


def four(route):
    """The batch count lives behind the Sampling popover; asking for four on
    the wire is the same request without driving a menu this check is not
    about."""
    body = json.loads(route.request.post_data or "{}")
    body["num_images"] = 4
    route.continue_(post_data=json.dumps(body))


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    entry = entry_scripts()
    print(f"\n=== {URL} ===")

    probe = urllib.request.urlopen(URL + "/api/file/vidprobe/clip.mp4", timeout=60)
    check("the preview serves a real mp4 (ffmpeg on PATH)",
          probe.headers.get("Content-Type") == "video/mp4", probe.headers.get("Content-Type", ""))

    # ---- a still: the frame layer, and nothing else ---------------------
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    reqs: list[str] = []
    pg.on("request", lambda r: reqs.append(r.url))
    pg.route("**/api/generate", four)
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1000)

    pg.evaluate(TYPE, "a dancer in soft window light")
    pg.wait_for_timeout(200)
    pg.evaluate("() => document.querySelector('#go-gen').click()")
    pg.wait_for_function(
        "() => { const i = [...document.querySelectorAll('#gen-out .shot img')];"
        " return i.length === 4 && i.every((x) => x.complete && x.naturalWidth > 0) }",
        timeout=40_000)
    pg.wait_for_timeout(800)

    check("a batch of four is four frames of one strip",
          pg.locator("#gen-out .film-cell").count() == 4 and pg.is_visible("#gen-nav"))
    check("still: no stage, no timeline", pg.locator("#edit-stage, #edit, #edit-tracks").count() == 0)
    check("still: the engine chunk is never requested", not lazy_js(reqs, entry),
          ", ".join(lazy_js(reqs, entry)))

    mark = len(reqs)
    for _ in range(3):
        pg.click("#gen-next")
        pg.wait_for_timeout(250)
    pg.click("#gen-prev")
    pg.wait_for_timeout(400)
    count = (pg.text_content("#gen-nav .count") or "").strip()
    check("stepping moved the strip", count == "3 / 4", repr(count))
    stepped = [u for u in reqs[mark:] if "/api/file/" in u or "/api/thumb" in u]
    check("stepping a batch re-fetches nothing", not stepped, ", ".join(stepped[:4]))
    check("still: no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()

    # ---- a scene with time: the stage in the canvas's video slot --------
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1000)
    to_video(pg)
    # The server keeps scenes across checks, so the page may have reopened one.
    # Clear starts a new scene — the only state in which "the second take" is a
    # claim about this run.
    if pg.locator("#canvas-clear").count():
        pg.click("#canvas-clear")
        pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)

    pg.evaluate(TYPE, "k3nan walks out of the shop")
    pg.wait_for_timeout(200)
    render_take(pg, 1)

    d = pg.evaluate("""() => {
      const out = document.querySelector('#vid-out');
      const st = document.querySelector('#edit-stage');
      const r = st?.getBoundingClientRect();
      return {
        inSlot: !!out?.contains(st),
        inEdit: !!document.querySelector('#edit #edit-stage'),
        video: document.querySelectorAll('#vid-out video').length,
        hidden: !!out?.classList.contains('hide'),
        drop: out?.dataset.drop || '',
        acts: [...document.querySelectorAll('#canvas-acts button')].map((b) => b.id),
        meta: !!document.querySelector('#vid-meta'),
        w: r ? r.width : 0, h: r ? r.height : 0,
      };
    }""")
    check("the stage is inside #vid-out", d["inSlot"], str(d))
    check("and not beside the timeline", not d["inEdit"])
    check("and there is no <video> in the slot", d["video"] == 0, str(d["video"]))
    check("the slot stays shown", not d["hidden"], f"hidden={d['hidden']}")
    check("the canvas keeps full screen, Continue and Clear",
          {"canvas-full", "canvas-chain", "canvas-clear"} <= set(d["acts"]), str(d["acts"]))
    check("and its receipt line", d["meta"])
    # At 1440x900 with the timeline and the console under it, a 16:9 take on
    # the canvas is far past the 96px the monitor was.
    check("the stage is the largest thing on screen", d["h"] > 300 and d["w"] > 500,
          f"{d['w']:.0f}x{d['h']:.0f}")

    # ---- the next take lands --------------------------------------------
    pg.click("#canvas-chain")
    pg.wait_for_timeout(600)
    pg.evaluate(TYPE, "he stops when he sees the car")
    pg.wait_for_timeout(200)
    render_take(pg, 2)
    x = pg.evaluate(HEAD_X)
    start = TAKE_SEC * PX_PER_SEC
    check("the playhead moved to the new take's start", x is not None and x >= start - 3,
          f"x={x} start={start}")
    # Held there rather than played — the cut has sound nobody asked for yet.
    # And Play works from it at once: the failure this is for is a handover
    # before the Studio had read the take, where Play was refused ("Cannot
    # play: invalid duration") while the Core went on saying it was playing.
    check("held, not playing", "Play" in (pg.get_attribute("#edit-play", "title") or ""))
    pg.click("#edit-play")
    pg.wait_for_timeout(1000)
    x2 = pg.evaluate(HEAD_X)
    pg.click("#edit-play")
    check("and Play runs the cut from there", x is not None and x2 is not None and x2 > x + 5,
          f"{x} -> {x2}")
    check("still no <video> once the stage has it", pg.locator("#vid-out video").count() == 0)

    # ---- full screen ----------------------------------------------------
    pg.hover("#canvas")
    pg.click("#canvas-full")
    pg.wait_for_timeout(600)
    fs = pg.evaluate("() => document.fullscreenElement?.id || ''")
    check("full screen is the stage element", fs == "edit-stage", repr(fs))
    check("and not the viewer", pg.locator(".lb").count() == 0)
    pg.evaluate("() => document.fullscreenElement && document.exitFullscreen()")
    pg.wait_for_timeout(300)
    check("scene: no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

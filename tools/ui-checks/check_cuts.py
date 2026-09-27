"""
The cut is shaped on the track: trims, order, and a crossfade on a cut.

    python3 tools/ui-checks/check_cuts.py                         # :8795
    python3 tools/ui-checks/check_cuts.py 8795                    # a port
    python3 tools/ui-checks/check_cuts.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real 3-second,
24fps test card per job when ffmpeg is on the PATH — each with its job id drawn
on it and a frame counter running, so two moments of two takes are two
different pictures. Without ffmpeg there is nothing for the engine to decode,
and this fails saying so rather than passing on structure.

What it holds, and the failure each one is for:

- **A trim changes the clip's length and moves the next clip's start.** V1 is
  gapless: the clips after a trim ripple, nothing is left behind.
- **The stage plays the trim, from what it already has.** After the trim, the
  frame at a time inside the next clip is that clip's frame at the same offset
  as before the trim — and no clip's file is requested again, through seeks and
  playback. A trim that re-fetched would be a download per nudge.
- **A trim cannot pass the file.** Dragging the out handle far past the end
  leaves the clip exactly as long as its file.
- **The keyboard trims too, a frame at a time.** Twenty-four presses of ← on a
  focused out handle take one second off at 24fps.
- **A drag reorders V1**, and the result is still gapless.
- **A crossfade toggles on one cut and is in project.json** — as OpenVideo's
  own Transition clip, `transitionKey: "fade"`, centred on the cut.
- **The stage draws the dissolve, and for as long as the Core says.** The frame
  at the cut differs from the hard cut's; a frame 0.4s before the cut does not
  (the engine's own default would be two seconds — see `keepFadesInStep`).
- **A reload keeps the trims, the order and the crossfade** — and the stage,
  mounted fresh, still dissolves for the saved length rather than its default.
"""
import base64
import json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8795"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")
PX = 30  # PX_PER_SEC, scene/Timeline

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def http(path):
    with urllib.request.urlopen(URL + path, timeout=10) as r:
        return json.loads(r.read())


CLIPS = """
() => [...document.querySelectorAll('#edit-tracks .et-lane[data-track="v1"] .et-clip')]
  .map((c) => ({ id: c.dataset.clip, job: c.dataset.job || '',
                 left: parseFloat(c.style.left), width: parseFloat(c.style.width) }))
  .sort((a, b) => a.left - b.left)
"""

CUTS = """
() => [...document.querySelectorAll('#edit-tracks .et-cut')].map((b) => ({
  from: b.dataset.from, to: b.dataset.to, on: b.getAttribute('aria-pressed') === 'true',
  left: parseFloat(b.style.left) }))
"""

FADES = """
() => [...document.querySelectorAll('#edit-tracks .et-fade')].map((f) =>
  ({ left: parseFloat(f.style.left), width: parseFloat(f.style.width) }))
"""

# A screenshot of the stage, as a 64x36 RGB thumbnail — decoded in the page,
# because the check's Python has no image library and the browser is one. In
# colour, not grey: the test card's moving band changes hue at nearly constant
# brightness, and a grey thumbnail averages a half-way dissolve into nothing.
SIG = """
async (b64) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(64, 36);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data;
  const out = [];
  for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
  return out;
}
"""


def diff(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / max(1, len(a))


def to_video(pg):
    """Duration is the switch — index 1 is always the model's shortest clip."""
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


def render(pg, n_takes=None):
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


class Timeline:
    """Where things are on screen, read fresh — the lanes move as the cut grows."""

    def __init__(self, pg):
        self.pg = pg

    def body(self):
        return self.pg.locator("#edit-tracks .et-body").bounding_box()

    def lane_y(self):
        box = self.pg.locator('#edit-tracks .et-lane[data-track="v1"]').bounding_box()
        # Below the middle: the cut diamonds sit on the lane's top edge.
        return box["y"] + box["height"] * 0.7

    def seek(self, x):
        """A press on the ruler — the one strip where nothing else is under it."""
        b = self.body()
        self.pg.mouse.click(b["x"] + x, b["y"] + 3)
        self.pg.wait_for_timeout(900)

    def sig(self, x):
        self.seek(x)
        png = self.pg.locator("#edit-stage").screenshot()
        return self.pg.evaluate(SIG, base64.b64encode(png).decode())

    def drag(self, x0, x1, steps=12):
        b = self.body()
        y = self.lane_y()
        self.pg.mouse.move(b["x"] + x0, y)
        self.pg.mouse.down()
        for i in range(1, steps + 1):
            self.pg.mouse.move(b["x"] + x0 + (x1 - x0) * i / steps, y)
            self.pg.wait_for_timeout(16)
        self.pg.mouse.up()
        self.pg.wait_for_timeout(700)


def project_of(sid):
    return (http(f"/api/scenes/{sid}").get("project") or {}) if sid else {}


def wait_project(pred, timeout=10):
    """The newest scene's project.json once `pred` holds, or the last seen."""
    deadline = time.time() + timeout
    sid, proj = None, {}
    while time.time() < deadline:
        rows = http("/api/scenes")["scenes"]
        sid = rows[0]["id"] if rows else None
        proj = project_of(sid)
        if pred(proj):
            break
        time.sleep(0.4)
    return sid, proj


def transitions(proj):
    return [c for c in (proj.get("clips") or {}).values() if c.get("type") == "Transition"]


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
    media: list[tuple[float, str]] = []
    pg.on("request", lambda r: media.append((time.time(), r.url)) if "/api/file/" in r.url else None)
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(800)
    tl = Timeline(pg)

    # ---- three takes, in a scene of their own ---------------------------
    to_video(pg)
    write(pg, "a throwaway take")
    render(pg)
    pg.click("#canvas-clear")
    pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)
    write(pg, "k3nan walks out of the shop")
    render(pg, 1)
    for n, line in ((2, "he stops when he sees the car"), (3, "the car pulls away")):
        pg.click("#canvas-chain")
        pg.wait_for_timeout(500)
        write(pg, line)
        render(pg, n)
    pg.wait_for_selector("#edit-stage canvas", timeout=10_000)
    pg.wait_for_timeout(1500)

    clips = pg.evaluate(CLIPS)
    check("three clips on V1", len(clips) == 3, str([c["job"] for c in clips]))
    if len(clips) != 3:
        print(f"\n{len(fails)} failure(s)")
        sys.exit(1)
    A, B, C = (c["id"] for c in clips)
    full = clips[0]["width"]
    check("every cut starts hard", all(not c["on"] for c in pg.evaluate(CUTS)) and not pg.evaluate(FADES),
          str(pg.evaluate(CUTS)))
    check("a cut control on each of the two cuts", len(pg.evaluate(CUTS)) == 2)

    # ---- trim -----------------------------------------------------------
    b_40 = tl.sig(full + 40)       # B, 1.33s in
    b_10 = tl.sig(full + 10)       # B, 0.33s in
    t_trim = time.time()
    tl.drag(full - 3, full - 33)   # A's out handle, a second to the left
    after = pg.evaluate(CLIPS)
    by = {c["id"]: c for c in after}
    check("a trim shortens the clip", abs(by[A]["width"] - (full - 30)) < 1.5, f"{by[A]['width']}")
    check("and the next clip starts where it now ends", abs(by[B]["left"] - by[A]["width"]) < 1.5,
          f"{by[B]['left']} vs {by[A]['width']}")
    check("the rest of V1 ripples with it", abs(by[C]["left"] - (by[B]["left"] + by[B]["width"])) < 1.5,
          f"{by[C]['left']}")
    check("the clips after it keep their length", abs(by[B]["width"] - full) < 1 and abs(by[C]["width"] - full) < 1)
    post = tl.sig(by[B]["left"] + 40)
    check("the stage plays the trim: B 1.33s in is where B 1.33s in was",
          diff(post, b_40) < 6 and diff(post, b_40) < diff(post, b_10) / 2,
          f"same={diff(post, b_40):.1f} other={diff(post, b_10):.1f}")
    pg.click("#edit-play")
    pg.wait_for_timeout(1500)
    pg.click("#edit-play")
    again = [u for t, u in media if t >= t_trim]
    check("no clip file is fetched again after a trim", not again, ", ".join(again[:4]))

    # ---- the file's end is a wall ---------------------------------------
    w = by[A]["width"]
    tl.drag(w - 3, w + 300)
    by = {c["id"]: c for c in pg.evaluate(CLIPS)}
    check("an out point cannot pass the end of its file", abs(by[A]["width"] - full) < 1.5,
          f"{by[A]['width']} vs {full}")

    # ---- the keyboard ---------------------------------------------------
    pg.focus(f'.et-clip[data-clip="{A}"] .et-trim.out')
    for _ in range(24):
        pg.keyboard.press("ArrowLeft")
    pg.wait_for_timeout(500)
    by = {c["id"]: c for c in pg.evaluate(CLIPS)}
    check("24 × ← on the out handle takes a second off", abs(by[A]["width"] - (full - 30)) < 1.5,
          f"{by[A]['width']}")
    check("and B follows it", abs(by[B]["left"] - by[A]["width"]) < 1.5)

    # ---- reorder --------------------------------------------------------
    cx = by[C]["left"] + by[C]["width"] / 2
    tl.drag(cx, cx - (by[C]["left"] - by[B]["left"]) - 20)
    order = pg.evaluate(CLIPS)
    check("a drag moves the third clip ahead of the second", [c["id"] for c in order] == [A, C, B],
          str([c["job"] for c in order]))
    check("and V1 is still gapless",
          all(abs(order[i]["left"] + order[i]["width"] - order[i + 1]["left"]) < 1.5 for i in range(2)),
          str([(c["left"], c["width"]) for c in order]))

    # ---- a crossfade on one cut -----------------------------------------
    cut_x = order[1]["left"]
    hard_at = tl.sig(cut_x)
    hard_before = tl.sig(cut_x - 12)       # 0.4s before the cut
    first = pg.locator(f'.et-cut[data-from="{A}"][data-to="{C}"]')
    first.click()
    pg.wait_for_timeout(600)
    cuts = pg.evaluate(CUTS)
    check("the cut's control turns the crossfade on",
          [c["on"] for c in cuts] == [True, False], str(cuts))
    fades = pg.evaluate(FADES)
    check("the dissolve is drawn centred on that cut, half a second long",
          len(fades) == 1 and abs(fades[0]["width"] - 15) < 1 and abs(fades[0]["left"] + 7.5 - cut_x) < 1,
          str(fades))
    sid, proj = wait_project(lambda p: len(transitions(p)) == 1)
    ts = transitions(proj)
    t = ts[0] if ts else {}
    check("project.json holds one Transition, fade, from A to C",
          len(ts) == 1 and t.get("transitionKey") == "fade" and t.get("fromClipId") == A and t.get("toClipId") == C,
          json.dumps(t)[:200])
    disp = (t.get("timing") or {}).get("display") or {}
    check("centred on the cut in the saved clip",
          abs((disp.get("from", 0) + disp.get("to", 0)) / 2 / 1e6 * PX - cut_x) < 1
          and abs((t.get("timing") or {}).get("duration", 0) - 500_000) < 2,
          json.dumps(t.get("timing")))
    fade_at = tl.sig(cut_x)
    fade_before = tl.sig(cut_x - 12)
    check("the stage draws the dissolve at the cut", diff(fade_at, hard_at) > 4,
          f"diff={diff(fade_at, hard_at):.1f}")
    check("and only for its own length, not the engine's two-second default",
          diff(fade_before, hard_before) < 3, f"diff={diff(fade_before, hard_before):.1f}")

    first.click()
    pg.wait_for_timeout(600)
    _, proj = wait_project(lambda p: not transitions(p))
    check("pressed again, the cut is hard", not any(c["on"] for c in pg.evaluate(CUTS))
          and not pg.evaluate(FADES) and not transitions(proj))
    first.click()
    pg.wait_for_timeout(600)

    # ---- a reload keeps it all ------------------------------------------
    want = [(c["id"], round(c["left"]), round(c["width"])) for c in pg.evaluate(CLIPS)]
    wait_project(lambda p: len(transitions(p)) == 1)
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(800)
    to_video(pg)
    pg.wait_for_function(
        "() => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= 3",
        timeout=40_000)
    pg.wait_for_selector("#edit-stage canvas", timeout=10_000)
    pg.wait_for_timeout(2500)
    got = [(c["id"], round(c["left"]), round(c["width"])) for c in pg.evaluate(CLIPS)]
    check("a reload keeps the trims and the order", got == want, f"{got} vs {want}")
    check("and the crossfade", [c["on"] for c in pg.evaluate(CUTS)] == [True, False], str(pg.evaluate(CUTS)))
    re_at = tl.sig(cut_x)
    re_before = tl.sig(cut_x - 12)
    check("the remounted stage dissolves at the cut", diff(re_at, hard_at) > 4, f"diff={diff(re_at, hard_at):.1f}")
    check("for the saved length, not the engine's default",
          diff(re_before, hard_before) < 3, f"diff={diff(re_before, hard_before):.1f}")

    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

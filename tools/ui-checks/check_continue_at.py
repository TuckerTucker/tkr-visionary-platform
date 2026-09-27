"""
Continue from a trimmed take sends its out-point; from an untrimmed one, nothing new.

    python3 tools/ui-checks/check_continue_at.py                         # :8812
    python3 tools/ui-checks/check_continue_at.py 8812                    # a port
    python3 tools/ui-checks/check_continue_at.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/video` stub runs app.py's own
`_validate_continue_at` and `_h3_cut_index` on what the page sends, so the snap
the Motion tile reports is the one the deployment would make. Its `/api/file`
serves a real 3-second 24fps clip per job when ffmpeg is on the PATH; without
ffmpeg the engine has nothing to lay out and this fails saying so.

What it holds, and the failure each one is for:

- **An untrimmed Continue sends no `continue_at`.** A take played to its end
  continues from its end, and a body that grew a field anyway would snap every
  untrimmed continuation back a whole 17-frame cycle for nothing.
- **A trimmed Continue sends the out-point**, ≈ the trimmed length, in seconds
  into the delivered take. The trim is Shift+← on the focused out handle: one
  second off a 3-second take.
- **The trim is read when Generate is pressed, not when Continue was.** A frame
  nudged after Continue moves what is sent.
- **The Motion tile says where the cut landed and how far the snap moved it**,
  from the route's reply — 2.00s snaps to 1.63s on a plain take, 0.38s back.
- **Clearing the Motion tile leaves the frame at the out-point**, and the row
  says so — the fallback when a take's latent is gone.
"""
import json
import sys

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8812"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


CLIPS = """
() => [...document.querySelectorAll('#edit-tracks .et-lane[data-track="v1"] .et-clip')]
  .map((c) => ({ id: c.dataset.clip, job: c.dataset.job || '',
                 left: parseFloat(c.style.left), width: parseFloat(c.style.width) }))
  .sort((a, b) => a.left - b.left)
"""


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


def render(pg, n_takes):
    """Generate, and return the /api/video body the page sent."""
    before = pg.eval_on_selector("#vid-out", "e => e.querySelector('video')?.src || ''")
    with pg.expect_request(lambda r: r.url.endswith("/api/video") and r.method == "POST") as req:
        pg.click("#go-vid")
    body = json.loads(req.value.post_data or "{}")
    pg.wait_for_function(
        "(b) => { const v = document.querySelector('#vid-out video'); return v && v.src && v.src !== b }",
        arg=before, timeout=40_000)
    pg.wait_for_function(
        "(n) => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= n",
        arg=n_takes, timeout=40_000)
    pg.wait_for_timeout(400)
    return body


def chain(pg):
    pg.click("#canvas-chain")
    pg.wait_for_selector("#v-motion", timeout=10_000)
    pg.wait_for_timeout(300)


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    print(f"\n=== {URL} ===")
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(800)

    to_video(pg)
    # A scene of its own: the preview keeps scenes across runs and the page
    # reopens the newest, so a second run would otherwise count last run's takes.
    write(pg, "a throwaway take")
    render(pg, 1)
    pg.click("#canvas-clear")
    pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)
    write(pg, "k3nan walks out of the shop")
    first = render(pg, 1)
    check("a plain Generate sends neither continue_from nor continue_at",
          "continue_from" not in first and "continue_at" not in first, str(sorted(first)))
    pg.wait_for_selector("#edit-stage canvas", timeout=15_000)

    # ---- untrimmed: Continue exactly as it was ---------------------------
    chain(pg)
    check("the Motion tile says it continues from the end",
          pg.inner_text("#v-motion-at").strip() == "Motion", pg.inner_text("#v-motion-at"))
    write(pg, "he stops when he sees the car")
    untrimmed = render(pg, 2)
    check("an untrimmed Continue sends continue_from", bool(untrimmed.get("continue_from")),
          str(untrimmed.get("continue_from")))
    check("and no continue_at", "continue_at" not in untrimmed, str(untrimmed.get("continue_at")))

    # ---- trimmed: the out-point travels ---------------------------------
    clips = pg.evaluate(CLIPS)
    check("two takes on V1", len(clips) == 2, str([c["job"] for c in clips]))
    if len(clips) != 2:
        print(f"\n{len(fails)} failure(s)")
        sys.exit(1)
    last = clips[-1]
    full = last["width"]
    pg.focus(f'.et-clip[data-clip="{last["id"]}"] .et-trim.out')
    pg.keyboard.press("Shift+ArrowLeft")
    pg.wait_for_timeout(600)
    trimmed_w = {c["id"]: c for c in pg.evaluate(CLIPS)}[last["id"]]["width"]
    check("Shift+← on the out handle takes a second off", abs(trimmed_w - (full - 30)) < 1.5,
          f"{full} → {trimmed_w}")
    out_point = float(pg.get_attribute(
        f'.et-clip[data-clip="{last["id"]}"] .et-trim.out', "aria-valuenow") or "nan")

    chain(pg)
    tile = pg.inner_text("#v-motion-at").strip()
    check("the armed Motion tile names the out-point", tile == f"Motion · {out_point:.2f}s", tile)
    write(pg, "the car pulls away")
    trimmed = render(pg, 3)
    at = trimmed.get("continue_at")
    check("a trimmed Continue sends continue_at", isinstance(at, (int, float)), str(at))
    check("continue_at is the trimmed length, in seconds into the delivered take",
          isinstance(at, (int, float)) and abs(at - out_point) < 1 / 24 and abs(at - 2.0) < 1 / 24,
          f"{at} vs out point {out_point}")
    check("it continues the take it was trimmed on",
          trimmed.get("continue_from") == last["job"], f"{trimmed.get('continue_from')} vs {last['job']}")

    # ---- the snap, as the route reported it -----------------------------
    pg.wait_for_function("() => document.querySelector('#v-motion')?.dataset.snap", timeout=5_000)
    snap = float(pg.get_attribute("#v-motion", "data-snap") or "nan")
    tile = pg.inner_text("#v-motion-at").strip()
    # 2.00s on a plain 3s take: 48 frames, down to 39 on the 17n+5 grid.
    check("the Motion tile shows where the cut landed and how far it moved",
          abs(snap - 0.375) < 1e-6 and tile == "Motion · 1.63s (−0.38s)", f"{snap} / {tile}")
    meta = pg.inner_text("#vid-meta") if pg.locator("#vid-meta").count() else ""
    check("the landed take's meta says the cut moved", "moved back 0.38s" in meta, meta[:160])

    # ---- live: a nudge after Continue moves what is sent -----------------
    clips = pg.evaluate(CLIPS)
    by = {c["id"]: c for c in clips}
    pg.focus(f'.et-clip[data-clip="{last["id"]}"] .et-trim.out')
    pg.keyboard.press("ArrowLeft")
    pg.wait_for_timeout(600)
    nudged = float(pg.get_attribute(
        f'.et-clip[data-clip="{last["id"]}"] .et-trim.out', "aria-valuenow") or "nan")
    write(pg, "the car is gone")
    again = render(pg, 4)
    check("a frame nudged after Continue is what Generate sends",
          abs((again.get("continue_at") or 0) - nudged) < 1e-3 and nudged < out_point,
          f"{again.get('continue_at')} vs {nudged}")

    # ---- the fallback: the frame at the out-point ------------------------
    pg.click("#v-motion")
    pg.wait_for_timeout(300)
    check("clearing the Motion tile sends no continuation",
          pg.locator("#v-motion").count() == 0)
    note = pg.inner_text("#v-cut-frame").strip() if pg.locator("#v-cut-frame").count() else ""
    check("and the row says the first frame is the out-point's",
          note == f"at {out_point:.2f}s", note or "(no #v-cut-frame)")

    check("no page errors", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{len(fails)} failure(s)" if fails else "\nall ok")
sys.exit(1 if fails else 0)

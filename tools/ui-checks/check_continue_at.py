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
  into the delivered take. The trim is six ← on the focused out handle: 2.75s
  of a 3-second take.
- **The trim is read when Generate is pressed, not when Continue was.** A frame
  nudged after Continue moves what is sent.
- **The route says where the cut landed and how far the snap moved it** —
  2.75s snaps to 2.33s on a plain take, 0.42s back.
- **The join does not repeat motion.** When the continuation lands, the source
  clip's out-point moves back to `continued_at` in the same edit, so the up to
  16 frames the snap moved over are not played twice. The Motion tile follows
  it (nothing left to snap), both slots carry a `−0.42s` mark off the trim
  handles, and one undo puts the source's trim back *and* takes the
  continuation out.
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


def render(pg, n_takes, reply=False):
    """Generate, and return the /api/video body the page sent — and, with
    `reply`, what the route answered."""
    before = pg.eval_on_selector("#vid-out", "e => e.querySelector('video')?.src || ''")
    with pg.expect_response(lambda r: r.url.endswith("/api/video") and r.request.method == "POST") as res:
        pg.click("#go-vid")
    body = json.loads(res.value.request.post_data or "{}")
    said = res.value.json()
    pg.wait_for_function(
        "(b) => { const v = document.querySelector('#vid-out video'); return v && v.src && v.src !== b }",
        arg=before, timeout=40_000)
    pg.wait_for_function(
        "(n) => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= n",
        arg=n_takes, timeout=40_000)
    pg.wait_for_timeout(400)
    return (body, said) if reply else body


def out_of(pg, clip_id):
    """A clip's out-point, in seconds into its file, as its handle reports it."""
    return float(pg.get_attribute(
        f'.et-clip[data-clip="{clip_id}"] .et-trim.out', "aria-valuenow") or "nan")


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
    # Six frames, not a second: the source is cut back further by the snap, and
    # a clip shorter than ~2s has no room left for the mark that says so.
    pg.focus(f'.et-clip[data-clip="{last["id"]}"] .et-trim.out')
    for _ in range(6):
        pg.keyboard.press("ArrowLeft")
        pg.wait_for_timeout(120)
    pg.wait_for_timeout(500)
    trimmed_w = {c["id"]: c for c in pg.evaluate(CLIPS)}[last["id"]]["width"]
    check("six ← on the out handle take six frames off", abs(trimmed_w - (full - 7.5)) < 1.5,
          f"{full} → {trimmed_w}")
    out_point = out_of(pg, last["id"])

    chain(pg)
    tile = pg.inner_text("#v-motion-at").strip()
    check("the armed Motion tile names the out-point", tile == f"Motion · {out_point:.2f}s", tile)
    write(pg, "the car pulls away")
    trimmed, said = render(pg, 3, reply=True)
    at = trimmed.get("continue_at")
    check("a trimmed Continue sends continue_at", isinstance(at, (int, float)), str(at))
    check("continue_at is the trimmed length, in seconds into the delivered take",
          isinstance(at, (int, float)) and abs(at - out_point) < 1 / 24 and abs(at - 2.75) < 1 / 24,
          f"{at} vs out point {out_point}")
    check("it continues the take it was trimmed on",
          trimmed.get("continue_from") == last["job"], f"{trimmed.get('continue_from')} vs {last['job']}")

    # ---- the snap, as the route reported it -----------------------------
    # 2.75s on a plain 3s take: 66 frames, down to 56 on the 17n+5 grid.
    continued_at = said.get("continued_at")
    snap = said.get("continue_snap")
    check("the route says where the cut landed and how far it moved",
          continued_at == 2.333 and snap == 0.417, f"{continued_at} / {snap}")
    meta = pg.inner_text("#vid-meta") if pg.locator("#vid-meta").count() else ""
    check("the landed take's meta says the cut moved", "moved back 0.42s" in meta, meta[:160])

    # ---- the join does not repeat motion: the source meets the snap -------
    source_out = out_of(pg, last["id"])
    check("the source clip's out-point moved back to continued_at",
          abs(source_out - (continued_at or 0)) < 1 / 48, f"{source_out} vs {continued_at}")
    clips = pg.evaluate(CLIPS)
    by = {c["id"]: c for c in clips}
    new = clips[-1]
    check("the source is drawn at its new length, and the continuation right after it",
          abs(by[last["id"]]["width"] - 2.333 * 30) < 1.5
          and abs(new["left"] - (by[last["id"]]["left"] + by[last["id"]]["width"])) < 1.5,
          f"{by[last['id']]} / {new}")
    tile = pg.inner_text("#v-motion-at").strip()
    check("the Motion tile follows the moved out-point, with nothing left to snap",
          tile == "Motion · 2.33s" and pg.get_attribute("#v-motion", "data-snap") is None, tile)
    src_mark = pg.locator(f'.et-snap[data-cut="source"]')
    check("the source slot carries the snap mark",
          src_mark.count() == 1 and src_mark.inner_text().strip() == "−0.42s"
          and pg.locator(f'.et-clip[data-clip="{last["id"]}"] .et-snap[data-cut="source"]').count() == 1,
          f"{src_mark.count()} / {src_mark.inner_text() if src_mark.count() else ''}")
    check("its sentence says the cut moved to meet the continuation",
          "moved back 0.42s" in (src_mark.get_attribute("title") or "")
          and "twice" in (src_mark.get_attribute("title") or ""),
          (src_mark.get_attribute("title") or "")[:120])
    check("the continuation's slot carries its own mark",
          pg.locator(f'.et-clip[data-clip="{new["id"]}"] .et-snap[data-cut="continued"]').count() == 1)
    check("the mark keeps off the trim handles",
          pg.evaluate("""(id) => {
            const c = document.querySelector(`.et-clip[data-clip="${id}"]`)
            const m = c.querySelector('.et-snap').getBoundingClientRect()
            return [...c.querySelectorAll('.et-trim')].every((h) => {
              const r = h.getBoundingClientRect()
              return m.right <= r.left || m.left >= r.right
            })
          }""", last["id"]))

    # ---- one undo restores both -----------------------------------------
    pg.evaluate("() => window.__edit.undo()")
    pg.wait_for_timeout(600)
    clips = pg.evaluate(CLIPS)
    check("one undo takes the continuation out", len(clips) == 2, str([c["job"] for c in clips]))
    check("and puts the source's out-point back",
          abs(out_of(pg, last["id"]) - out_point) < 1e-3, f"{out_of(pg, last['id'])} vs {out_point}")
    check("and the source mark goes with it", pg.locator('.et-snap[data-cut="source"]').count() == 0)
    pg.evaluate("() => window.__edit.redo()")
    pg.wait_for_timeout(600)
    clips = pg.evaluate(CLIPS)
    check("redo brings both back", len(clips) == 3
          and abs(out_of(pg, last["id"]) - (continued_at or 0)) < 1 / 48,
          f"{len(clips)} / {out_of(pg, last['id'])}")

    # ---- live: a nudge after Continue moves what is sent -----------------
    pg.focus(f'.et-clip[data-clip="{last["id"]}"] .et-trim.out')
    pg.keyboard.press("ArrowLeft")
    pg.wait_for_timeout(600)
    nudged = out_of(pg, last["id"])
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

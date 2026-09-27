"""
One undo stack for every scene edit: ⌘Z, ⇧⌘Z and the two buttons beside
Export all drive the Core's history, and nothing else's.

    python3 tools/ui-checks/check_undo.py                         # :8811
    python3 tools/ui-checks/check_undo.py 8794                    # a port
    python3 tools/ui-checks/check_undo.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per job
when ffmpeg is on the PATH — without one the engine has nothing to read and
this fails rather than passing on structure. The chords are the Mac's (the
browser here reports a Mac platform); Ctrl+Z is checked to do nothing there.

What it holds, and the failure each one is for:

- **Undo takes back the newest edit first.** A trim then a render, and ⌘Z
  twice: the render goes first (the slot is back on its first take), then the
  trim (the clip is its full length again). An undo stack that were two stacks
  — the Studio's and the Core's — would answer in some other order.
- **Undoing a render leaves its bytes on the volume.** The undone take's file
  still serves 200; undo is only safe to press because nothing is deleted.
- **The keys never steal the prompt's own undo.** ⌘Z and ⇧⌘Z typed inside
  `#prompt` leave the timeline exactly as it was.
- **The buttons are disabled, not hidden, and say what they would undo.**
  "Undo render" before the first ⌘Z, "Undo trim" after it; redo greyed until
  something has been undone, and undo greyed once the history is empty.
- **Redo puts both back**, from the button — the touch path.
"""
import sys
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8811"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


CLIPS = """
() => [...document.querySelectorAll('#edit-tracks .et-lane[data-track="v1"] .et-clip')]
  .map((c) => ({ id: c.dataset.clip, job: c.dataset.job || '', slot: c.dataset.slot || '',
                 left: parseFloat(c.style.left), width: parseFloat(c.style.width) }))
  .sort((a, b) => a.left - b.left)
"""

BUTTONS = """
() => ['#edit-undo-go', '#edit-redo-go'].map((s) => {
  const b = document.querySelector(s)
  return b ? { disabled: b.disabled, title: b.title, label: b.getAttribute('aria-label') } : null
})
"""


def clips(pg):
    return pg.evaluate(CLIPS)


def buttons(pg):
    u, r = pg.evaluate(BUTTONS)
    return u, r


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


def slot_el(slot):
    return f'#edit-tracks .et-clip[data-slot="{slot}"]'


def settle(pg):
    """Focus on nothing — the body — as it is after a click on bare page."""
    pg.evaluate("() => document.activeElement && document.activeElement.blur()")
    pg.wait_for_timeout(100)


def wait_clip(pg, pred, arg, timeout=10_000):
    pg.wait_for_function(
        "([p, a]) => { const c = [...document.querySelectorAll("
        "'#edit-tracks .et-lane[data-track=\"v1\"] .et-clip')][0];"
        " return !!c && new Function('c', 'a', p)(c, a) }",
        arg=[pred, arg], timeout=timeout)
    pg.wait_for_timeout(300)


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
    check("the page reports a Mac, so the chords are ⌘",
          pg.evaluate("() => /mac/i.test(navigator.userAgentData?.platform || navigator.platform)"))
    to_video(pg)
    # A fresh scene: one throwaway take and Clear, as check_edit.py does.
    write(pg, "a throwaway take")
    generate(pg)
    pg.click("#canvas-clear")
    pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)

    write(pg, "k3nan walks out of the shop")
    generate(pg, 1)
    pg.wait_for_selector("#edit-undo-go", timeout=40_000)
    (a,) = clips(pg)
    full, slot_a, job_1 = a["width"], a["slot"], a["job"]
    u, r = buttons(pg)
    check("undo and redo sit in the transport row beside Export",
          pg.locator("#edit-tracks .et-head #edit-undo-go + #edit-redo-go").count() == 1
          and pg.locator("#edit-tracks .et-head #edit-export").count() == 1)
    check("redo is there and disabled before anything is undone",
          r is not None and r["disabled"] and r["title"] == "Nothing to redo", str(r))

    # ---- a trim, then a render --------------------------------------------
    pg.focus(f'{slot_el(slot_a)} .et-trim.out')
    pg.keyboard.press("Shift+ArrowLeft")   # one second off: one gesture, one entry
    wait_clip(pg, "return Math.abs(parseFloat(c.style.width) - a) > 5", full)
    trimmed = clips(pg)[0]["width"]
    check("the trim shortens the clip", trimmed < full - 5, f"{full} -> {trimmed}")
    u, r = buttons(pg)
    check("after a trim the button says so", u and not u["disabled"] and u["title"].startswith("Undo trim"),
          str(u))

    write(pg, "")  # an empty prompt renders the slot's own sentence again
    pg.click(f'{slot_el(slot_a)} [data-act="render"]')
    wait_clip(pg, "return c.dataset.job && c.dataset.job !== a", job_1, timeout=40_000)
    job_2 = clips(pg)[0]["job"]
    # A new take plays its whole length (slice 7), so the render has a width of
    # its own; what undo has to restore is the trimmed one under it.
    rendered = clips(pg)[0]["width"]
    check("the render lands in the slot", job_2 and job_2 != job_1, f"{job_1} -> {job_2}")
    u, r = buttons(pg)
    check("after a render the button says 'Undo render'",
          u and not u["disabled"] and u["title"].startswith("Undo render") and u["label"] == "Undo render",
          str(u))

    # ---- the prompt keeps its own undo ------------------------------------
    write(pg, "the car door opens")
    pg.keyboard.press("Meta+z")
    pg.keyboard.press("Meta+z")
    pg.keyboard.press("Meta+Shift+z")
    pg.wait_for_timeout(500)
    now = clips(pg)[0]
    check("⌘Z / ⇧⌘Z inside #prompt leave the timeline alone",
          now["job"] == job_2 and abs(now["width"] - rendered) < 0.5
          and buttons(pg)[0]["title"].startswith("Undo render") and buttons(pg)[1]["disabled"],
          str(now))
    write(pg, "")

    # ---- Ctrl+Z is not a Mac's undo ---------------------------------------
    settle(pg)
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(500)
    check("Ctrl+Z on a Mac does nothing", clips(pg)[0]["job"] == job_2)

    # ---- ⌘Z twice: the render first, then the trim ------------------------
    settle(pg)
    pg.keyboard.press("Meta+z")
    wait_clip(pg, "return c.dataset.job === a", job_1)
    after_1 = clips(pg)[0]
    check("the first ⌘Z undoes the render: the slot is back on its first take",
          after_1["job"] == job_1, str(after_1))
    check("and leaves the trim", abs(after_1["width"] - trimmed) < 1.5, f"{after_1['width']} vs {trimmed}")
    u, r = buttons(pg)
    check("undo now names the trim, redo the render",
          u and u["title"].startswith("Undo trim") and r and not r["disabled"]
          and r["title"].startswith("Redo render"), f"{u} {r}")
    got = urllib.request.urlopen(f"{URL}/api/file/{job_2}/clip.mp4", timeout=30)
    check("the undone render's bytes are still served",
          got.status == 200 and got.headers.get("Content-Type") == "video/mp4",
          f"{got.status} {got.headers.get('Content-Type')}")

    # From a focused trim handle — a slider, not a text field — ⌘Z still undoes.
    pg.focus(f'{slot_el(slot_a)} .et-trim.out')
    pg.keyboard.press("Meta+z")
    wait_clip(pg, "return Math.abs(parseFloat(c.style.width) - a) < 1.5", full)
    after_2 = clips(pg)[0]
    check("the second ⌘Z undoes the trim", abs(after_2["width"] - full) < 1.5 and after_2["job"] == job_1,
          str(after_2))

    # ---- redo, from the buttons -------------------------------------------
    pg.click("#edit-redo-go")
    wait_clip(pg, "return Math.abs(parseFloat(c.style.width) - a) < 1.5", trimmed)
    check("the first redo puts the trim back", abs(clips(pg)[0]["width"] - trimmed) < 1.5
          and clips(pg)[0]["job"] == job_1, str(clips(pg)[0]))
    pg.click("#edit-redo-go")
    wait_clip(pg, "return c.dataset.job === a", job_2)
    now = clips(pg)[0]
    check("the second puts the render back, at the render's own length",
          now["job"] == job_2 and abs(now["width"] - rendered) < 1.5, str(now))
    check("and greys out with nothing left to redo", buttons(pg)[1]["disabled"])

    # ---- ⇧⌘Z --------------------------------------------------------------
    settle(pg)
    pg.keyboard.press("Meta+z")
    wait_clip(pg, "return c.dataset.job === a", job_1)
    settle(pg)
    pg.keyboard.press("Meta+Shift+z")
    wait_clip(pg, "return c.dataset.job === a", job_2)
    check("⇧⌘Z redoes", clips(pg)[0]["job"] == job_2)

    # ---- to the bottom of the stack ---------------------------------------
    for _ in range(12):
        if buttons(pg)[0]["disabled"]:
            break
        pg.click("#edit-undo-go")
        pg.wait_for_timeout(300)
    u, r = buttons(pg)
    check("undo greys out, still drawn, when the history is empty",
          u is not None and u["disabled"] and u["title"] == "Nothing to undo", str(u))
    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

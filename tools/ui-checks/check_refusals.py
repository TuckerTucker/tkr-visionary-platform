"""
A refused gesture is said on the surface it landed on — never in a dialog.

    python3 tools/ui-checks/check_refusals.py                        # 8791
    python3 tools/ui-checks/check_refusals.py http://localhost:8816

Twelve `alert()` calls were the page's way of refusing a drop, a hand-off or a
save: the whole app stopped to deliver one sentence, in the middle of the screen,
away from the target that had just lit up for the file. They are `ui/Refusal` now
— the sentence on the surface, cleared by whatever you do next — and this is what
holds them there:

- **No dialog, ever.** Any `alert`/`confirm` during the run fails it.
- **The video canvas says why it took nothing,** on the canvas.
- **A tile in the console says it above itself.** `.console` clips anything of its
  own that floats, so the sentence is portalled and fixed; the check is that it
  sits above the tile it is about and inside the window.
- **An unreadable file is named,** with the format that fixes it — the half
  "Could not read that image." never had.
- **A drop past the cap says what it left out.** Twelve onto a cap of nine used to
  keep nine and say nothing, which reads as the tray losing pictures.
- **The next gesture clears it.** No timer, nothing to dismiss.
"""
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8791"
if URL.isdigit():
    URL = f"http://localhost:{URL}"
fails: list[str] = []

# A 2x2 PNG the page can really decode, and bytes that claim to be one and are not.
PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8"
       "z8Dwn4GBgYEJTAAAHAcCAKvHBh4AAAAASUVORK5CYII=")
JUNK = "bm90IGEgcGljdHVyZQ=="
TEXT = "aGVsbG8="

# `check_drop.py`'s drop, taking several files: real DataTransfer, real events,
# aimed at the middle of the target.
DROP = """
([sel, files]) => {
  const el = document.querySelector(sel);
  if (!el) return 'MISSING';
  const dt = new DataTransfer();
  for (const [b64, mime, name] of files) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    dt.items.add(new File([buf], name, {type: mime}));
  }
  const r = el.getBoundingClientRect();
  for (const type of ['dragenter', 'dragover', 'drop']) {
    el.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2}));
  }
  return true;
}
"""

SAID = """
(scope) => [...document.querySelectorAll(scope)].map((p) => p.textContent).join(' | ')
"""

PLACED = """
(sel) => {
  const p = document.querySelector('.refusal.anchored');
  const t = document.querySelector(sel);
  if (!p || !t) return null;
  const a = p.getBoundingClientRect(), b = t.getBoundingClientRect();
  return {above: a.bottom <= b.top + 1, inWindow: a.top >= 0 && a.right <= innerWidth,
          fixed: getComputedStyle(p).position === 'fixed'};
}
"""


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + repr(detail) if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1400, "height": 950}, color_scheme="dark")
    dialogs: list[str] = []
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1200)
    print(f"\n=== {URL} ===")

    def drop(sel, files):
        r = pg.evaluate(DROP, [sel, files])
        if r == "MISSING":
            check(f"{sel} is on the page", False)
        pg.wait_for_timeout(400)

    def said(scope=".refusal"):
        return pg.evaluate(SAID, scope)

    def clear_refs():
        while pg.locator("#v-refs button.x").count():
            pg.locator("#v-refs button.x").first.click()
            pg.wait_for_timeout(120)

    # To the video side: duration is the switch — see check_drop.set_duration.
    if pg.eval_on_selector("#c-video", "e => e.classList.contains('hide')"):
        pg.click("#g-duration")
        pg.wait_for_selector(".menu button")
        pg.locator(".menu button").nth(1).click()
        pg.wait_for_timeout(500)

    # ---- the video canvas ------------------------------------------------------
    # The middle of the canvas is the reference zone — see check_video_zones.py.
    drop("#canvas", [[TEXT, "text/plain", "notes.txt"]])
    text = said("#canvas .refusal")
    check("canvas: a text file is refused on the canvas", "is an image or a video" in text, text)
    pg.mouse.click(700, 60)
    pg.wait_for_timeout(200)
    check("canvas: the next press clears it", said("#canvas .refusal") == "", said())

    # ---- a keyframe tile in the console ----------------------------------------
    drop("#v-drop-first", [[TEXT, "text/plain", "notes.txt"]])
    text = said(".refusal.anchored")
    check("tile: a text file is refused above the tile", "takes an image" in text, text)
    where = pg.evaluate(PLACED, "#v-drop-first")
    check("tile: the sentence sits above the tile it is about", bool(where and where["above"]), where)
    check("tile: and inside the window, unclipped by the console",
          bool(where and where["inWindow"] and where["fixed"]), where)
    pg.keyboard.press("Shift")
    pg.wait_for_timeout(200)
    check("tile: a key clears it", said(".refusal.anchored") == "", said())

    # ---- the reference tray ----------------------------------------------------
    clear_refs()
    drop("#v-add-ref", [[JUNK, "image/png", "broken.png"]])
    text = said(".refusal.anchored")
    check("tray: an undecodable picture is named", "broken.png" in text, text)
    check("tray: with the format that fixes it", "PNG or JPEG" in text, text)

    cap = pg.evaluate("() => fetch('/api/state').then(r => r.json()).then(s => s.max_refs ?? 9)")
    drop("#v-add-ref", [[PNG, "image/png", f"p{i}.png"] for i in range(cap + 2)])
    pg.wait_for_timeout(600)
    kept = pg.locator("#v-refs .ref").count()
    text = said(".refusal.anchored")
    check("tray: a drop past the cap keeps the cap", kept == cap, kept)
    check("tray: and says what it left out", "2 left out" in text, text)
    drop("#v-add-ref", [[PNG, "image/png", "one-more.png"]])
    text = said(".refusal.anchored")
    check("tray: a full tray says so on the next drop", "limit" in text, text)
    clear_refs()

    check("no alert() or confirm() at any point", not dialogs, dialogs)
    check("no uncaught errors", not errors, errors)
    b.close()

print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)

"""
Where a picture dropped on the video canvas goes is where you let go of it.

    python3 tools/ui-checks/check_video_zones.py                        # 8791
    python3 tools/ui-checks/check_video_zones.py http://localhost:8816

The video canvas took one kind of drop — anywhere was the first frame — and took
it only once a clip had landed, because the element carrying the handler was
`display:none` until then. Everything else a take can be given came through the
console's tiles. Now the canvas is three zones read as a strip of time (see
`web/src/canvas/drop/VideoDrops.tsx`), and this is what holds them:

- **The empty video canvas takes a drop.** The moment a first frame is most
  wanted is before anything has rendered.
- **The left edge is the first frame, the middle a reference,** and the right
  edge the last frame on a model that takes one.
- **Only the zone under the cursor is captioned.**
- **A zone out of play says so before the drop** — "references win" while
  references are attached — **and refuses the drop in words** if you let go
  anyway, leaving what was attached alone.
- **No dialog, ever.**

Driven with real DataTransfer and real `dragover`s aimed at a point, because the
zone is decided from the pointer and the overlay appears off `dragover` reaching
the window — a check that set state directly would pass with both broken.
"""
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8791"
if URL.isdigit():
    URL = f"http://localhost:{URL}"
fails: list[str] = []

PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8"
       "z8Dwn4GBgYEJTAAAHAcCAKvHBh4AAAAASUVORK5CYII=")

# Hover a file over a point on the canvas, as a fraction of its width, and report
# what the page says there. `release` also lets go.
AT = """
([fx, b64, release]) => {
  const c = document.querySelector('#canvas');
  const r = c.getBoundingClientRect();
  const x = r.left + r.width * fx, y = r.top + r.height / 2;
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'still.png', {type: 'image/png'}));
  const target = document.elementFromPoint(x, y) || c;
  const fire = (type) => target.dispatchEvent(new DragEvent(type,
    {bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y}));
  fire('dragenter');
  const over = new DragEvent('dragover',
    {bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y});
  target.dispatchEvent(over);
  if (release) fire('drop');
  return {accepted: over.defaultPrevented};
}
"""

READ = """
() => ({
  zones: [...document.querySelectorAll('#vid-drops .vzone')].map((z) => z.dataset.role),
  hot: [...document.querySelectorAll('#vid-drops .vzone.hot')]
         .map((z) => ({role: z.dataset.role, says: z.dataset.drop,
                       off: z.classList.contains('off')})),
})
"""


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + repr(detail) if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1400, "height": 950}, color_scheme="dark")
    # No saved scene, so the video side opens on the empty canvas: the preview keeps
    # the scenes earlier checks made, and with takes the canvas is the stage.
    pg.route("**/api/scenes", lambda r: r.fulfill(json={"scenes": []}))
    dialogs: list[str] = []
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1200)
    print(f"\n=== {URL} ===")

    def hover(fx):
        r = pg.evaluate(AT, [fx, PNG, False])
        pg.wait_for_timeout(60)
        return r, pg.evaluate(READ)

    def release(fx):
        pg.evaluate(AT, [fx, PNG, True])
        pg.wait_for_timeout(500)

    def said():
        return pg.evaluate("() => document.querySelector('#canvas > .refusal-slot .refusal')"
                           "?.textContent || ''")

    def first_set():
        return pg.eval_on_selector("#v-drop-first", "e => e.classList.contains('set')")

    def refs():
        return pg.locator("#v-refs .ref").count()

    def clear_all():
        while pg.locator("#v-refs button.x").count():
            pg.locator("#v-refs button.x").first.click()
            pg.wait_for_timeout(120)
        for sel in ("#v-drop-first", "#v-drop-last"):
            if pg.locator(sel).count() and pg.eval_on_selector(sel, "e => e.classList.contains('set')"):
                pg.click(sel)
                pg.wait_for_timeout(120)

    if pg.eval_on_selector("#c-video", "e => e.classList.contains('hide')"):
        pg.click("#g-duration")
        pg.wait_for_selector(".menu button")
        pg.locator(".menu button").nth(1).click()
        pg.wait_for_timeout(500)
    clear_all()

    check("no zones are drawn at rest", pg.locator("#vid-drops").count() == 0)
    check("the empty video canvas is showing", pg.locator("#vid-out.hide").count() == 1)

    # ---- the strip ---------------------------------------------------------------
    r, seen = hover(0.1)
    check("the empty canvas accepts a dragged file", r["accepted"], r)
    check("the zones appear while a file is over the window", len(seen["zones"]) >= 2, seen)
    check("the left edge is the first frame", [h["role"] for h in seen["hot"]] == ["first"], seen)
    check("and only it is captioned", len(seen["hot"]) == 1 and seen["hot"][0]["says"] == "First frame",
          seen)
    _, mid = hover(0.5)
    check("the middle is a reference", [h["role"] for h in mid["hot"]] == ["reference"], mid)
    if "last" in seen["zones"]:
        _, right = hover(0.9)
        check("the right edge is the last frame", [h["role"] for h in right["hot"]] == ["last"], right)

    # ---- letting go ----------------------------------------------------------------
    release(0.1)
    check("a drop on the empty canvas's left edge sets the first frame", first_set())
    check("and the zones are gone once it has landed", pg.locator("#vid-drops").count() == 0)
    clear_all()
    release(0.5)
    check("a drop in the middle adds a reference", refs() == 1, refs())

    # ---- out of play ----------------------------------------------------------------
    _, blocked = hover(0.1)
    hot = blocked["hot"][0] if blocked["hot"] else {}
    check("with a reference attached, the first-frame zone says references win before the drop",
          hot.get("off") and "references win" in hot.get("says", ""), hot)
    release(0.1)
    check("letting go anyway is refused in words", "References are attached" in said(), said())
    check("and sets no first frame", not first_set())
    clear_all()
    release(0.1)
    _, framed = hover(0.5)
    hot = framed["hot"][0] if framed["hot"] else {}
    check("with a keyframe set, the reference zone says so", hot.get("off"), hot)
    release(0.5)
    check("and refuses a reference in words", "keyframe is set" in said(), said())
    check("adding none", refs() == 0, refs())
    clear_all()

    # ---- over the stage ---------------------------------------------------------------
    # A scene with takes draws the stage in the same slot; the zones are the canvas's,
    # so a drop there lands the same way.
    st = b.new_page(viewport={"width": 1400, "height": 950}, color_scheme="dark")
    st.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    st.goto(URL, wait_until="networkidle", timeout=60_000)
    st.wait_for_timeout(1200)
    if st.eval_on_selector("#c-video", "e => e.classList.contains('hide')"):
        st.click("#g-duration")
        st.wait_for_selector(".menu button")
        st.locator(".menu button").nth(1).click()
        st.wait_for_timeout(800)
    if st.locator("#edit-stage").count():
        r = st.evaluate(AT, [0.1, PNG, False])
        st.wait_for_timeout(60)
        seen = st.evaluate(READ)
        check("over the stage, the canvas still accepts a dragged file", r["accepted"], r)
        check("and the left edge is still the first frame",
              [h["role"] for h in seen["hot"]] == ["first"], seen)
    else:
        print("  skip over the stage — this preview has no scene with takes")
    st.close()

    check("no alert() or confirm() at any point", not dialogs, dialogs)
    check("no uncaught errors", not errors, errors)
    b.close()

print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)

"""
A saved character is a likeness on the image side too, not only in a composed scene.

    python3 tools/ui-checks/check_recall.py                        # 8791
    python3 tools/ui-checks/check_recall.py http://localhost:8816

The Arsenal stores a character in no model's syntax, which is what lets it cross
families — and until this, only the scene composer's `@` menu read one back, so a
Krea 2 box could not take a likeness somebody had saved (backlog work-fPmIu6PF).
The recall is the region's own "which character" menu now:

- **The saved cast is in the menu the LoRAs are in**, below them, because both
  answer which character a box is.
- **Picking one fills the box's Photo** with that character's photograph, and its
  sentence with the saved note when the box has none. The LoRA is left alone —
  the two stack.
- **It reaches the run.** The Photo tile is a picture of the request; the request
  is checked at the network.
- **A photograph that does not come back is said by name, on the card** — and the
  box is left as it was rather than holding a likeness it does not have.
- **No dialog, no page error.**
"""
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8791"
if URL.isdigit():
    URL = f"http://localhost:{URL}"
fails: list[str] = []

# A 2x2 PNG the page can really decode.
PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8"
       "z8Dwn4GBgYEJTAAAHAcCAKvHBh4AAAAASUVORK5CYII=")
NOTE = "a woman with short red hair and a green raincoat"


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + repr(detail) if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1400, "height": 950}, color_scheme="dark")
    pg.route("**/api/scenes", lambda r: r.fulfill(json={"scenes": []}))
    dialogs: list[str] = []
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    print(f"\n=== {URL} ===")

    # Two saved characters through the preview's own save route: one whose
    # photograph comes back, and one whose photograph the volume has lost. The
    # sheet on `maya` is saved first, so taking the first image would take it.
    for handle, note in (("maya", NOTE), ("ghost", "")):
        r = pg.evaluate("""async ([h, note, png]) => (await fetch('/api/characters/' + h, {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({note, retention: '', refs: [
              {kind: 'image', b64: png, sheet: true}, {kind: 'image', b64: png}]})})).json()""",
                        [handle, note, PNG])
        check(f"{handle} is saved", bool(r.get("ok")), r)
    sheet_asked: list[str] = []
    pg.on("request", lambda req: sheet_asked.append(req.url)
          if "/api/character-file/maya/00-" in req.url else None)
    pg.route("**/api/character-file/ghost/**",
             lambda r: r.fulfill(status=404, json={"error": "no such file"}))
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(800)

    def row_press(text):
        """A real press on the menu row — see check_regions.press_row for why a
        scripted click proves nothing here."""
        row = pg.locator(".menu button", has_text=text).first
        box = row.bounding_box()
        if not box:
            check(f"the menu has a row for {text}", False)
            return
        lay = pg.eval_on_selector("#region-layer", "e=>e.getBoundingClientRect().toJSON()")
        x = max(box["x"] + 12, lay["x"] + 30)
        pg.mouse.move(x, box["y"] + box["height"] / 2, steps=4)
        pg.mouse.down()
        pg.wait_for_timeout(40)
        pg.mouse.up()
        pg.wait_for_timeout(600)

    def open_box(fx, fy):
        """A new box at (fx, fy) on bare canvas, with its card open. A double
        click inside an existing box makes nothing, so each call needs its own
        clear patch of frame."""
        lay = pg.eval_on_selector("#region-layer", "e=>e.getBoundingClientRect().toJSON()")
        cx, cy = lay["x"] + lay["width"] * fx, lay["y"] + lay["height"] * fy
        pg.mouse.dblclick(cx, cy)
        pg.wait_for_timeout(250)
        pg.mouse.click(cx + 10, cy + 10)
        pg.wait_for_timeout(250)

    open_box(0.05, 0.3)
    check("a box's card is open", pg.locator("#region-inspector").count() == 1)
    pg.click("#r-lora")
    pg.wait_for_timeout(300)
    labels = pg.eval_on_selector_all(".menu button", "els=>els.map(e=>e.textContent)")
    check("the saved cast is in the character menu",
          any("maya" in l for l in labels) and any("ghost" in l for l in labels), labels)
    check("below the LoRAs",
          bool(labels) and "maya" not in labels[0] and "ghost" not in labels[0], labels)
    row_press("maya")

    has_photo = pg.eval_on_selector("#r-ref", "e => !!e.querySelector('img')")
    check("picking one fills the box's Photo", has_photo)
    check("and its empty sentence with the saved note",
          pg.input_value("#r-prompt") == NOTE, pg.input_value("#r-prompt"))
    check("from the plain photograph, not the sheet", not sheet_asked, sheet_asked)

    # The request, not the tile. Aborted after it is read so nothing is rendered.
    seen: dict = {}

    def grab(route, request):
        seen["body"] = request.post_data_json
        route.fulfill(json={"error": "held by check_recall"})

    pg.route("**/api/generate", grab)
    pg.keyboard.press("Escape")
    pg.fill("#prompt", "a quiet street at dusk") if pg.locator("#prompt").count() else None
    pg.keyboard.press("Meta+Enter")
    pg.wait_for_timeout(800)
    regions = (seen.get("body") or {}).get("regions") or []
    check("the likeness reaches the run",
          bool(regions) and isinstance(regions[0].get("ref"), str) and len(regions[0]["ref"]) > 40,
          [{k: (v[:24] + "…" if isinstance(v, str) and len(v) > 24 else v)
            for k, v in r.items()} for r in regions])
    pg.unroute("**/api/generate")

    # A second box for the lost one, so the first box's photo cannot mask the answer.
    open_box(0.7, 0.3)
    check("the second card is a new box", pg.input_value("#r-prompt") == "",
          pg.input_value("#r-prompt"))
    pg.click("#r-lora")
    pg.wait_for_timeout(300)
    row_press("ghost")
    said = pg.eval_on_selector_all("#region-inspector .refusal",
                                   "els=>els.map(e=>e.textContent).join(' | ')")
    check("a lost photograph is said on the card, by name",
          "ghost" in said and "not on the volume" in said, said)
    check("and the box is left without a likeness",
          not pg.eval_on_selector("#r-ref", "e => !!e.querySelector('img')"))

    check("no dialog", not dialogs, dialogs)
    check("no page error", not errors, errors)
    b.close()

print(f"\n{len(fails)} failure(s)" if fails else "\nall ok")
sys.exit(1 if fails else 0)

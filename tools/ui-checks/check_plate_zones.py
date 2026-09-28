"""
Where a picture dropped on the image frame goes is where you let go of it.

    python3 tools/ui-checks/check_plate_zones.py                        # 8791
    python3 tools/ui-checks/check_plate_zones.py http://localhost:8816

The frame took two kinds of drop: a box was the character and bare canvas was
the scene. The outfit, both objects and the style came in only through
PlateRow's tiles — and under the two full-height columns the region mode seeds
there is no bare canvas, so the scene was a tile too. Now a band along the
frame's bottom edge holds the four (see `web/src/canvas/drop/ImageDrops.tsx`),
and this is what holds it:

- **The band is drawn while a file is over the frame, four zones, and only the
  one under the cursor is captioned.**
- **It takes the drop ahead of the boxes under it**, which is the whole reason it
  exists: with the frame covered by columns, a scene still lands as the scene and
  neither character gets it.
- **Above the band a box is still the character**, and the band does not claim it.
- **An object arrives with its note focused.**
- **PlateRow's tiles do not outline themselves under a drag** — one target per
  picture.
- **Without the identity-edit LoRA the three plate zones say so before the drop,
  refuse in words after it, and Style still takes one.**
- **The empty frame's invitation names the band.**
- **No dialog, no page error.**

Driven with real DataTransfer and real `dragover`s aimed at a point, for
`check_video_zones.py`'s reason: the zone is decided from the pointer.
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8791"
if URL.isdigit():
    URL = f"http://localhost:{URL}"
fails: list[str] = []

PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8"
       "z8Dwn4GBgYEJTAAAHAcCAKvHBh4AAAAASUVORK5CYII=")

# Hover a file over a point on the region layer, in fractions of it; `release`
# also lets go.
AT = """
([fx, fy, b64, release]) => {
  const c = document.querySelector('#region-layer');
  const r = c.getBoundingClientRect();
  const x = r.left + r.width * fx, y = r.top + r.height * fy;
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'plate.png', {type: 'image/png'}));
  const target = document.elementFromPoint(x, y) || c;
  const fire = (type) => target.dispatchEvent(new DragEvent(type,
    {bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y}));
  fire('dragenter');
  fire('dragover');
  if (release) fire('drop');
  return true;
}
"""

READ = """
() => ({
  zones: [...document.querySelectorAll('#img-drops .pzone')].map((z) => z.dataset.plate),
  hot: [...document.querySelectorAll('#img-drops .pzone.hot')]
         .map((z) => ({plate: z.dataset.plate, says: z.dataset.drop,
                       off: z.classList.contains('off')})),
  boxHit: document.querySelectorAll('#region-layer .rbox.drop-hit').length,
  faces: document.querySelectorAll('#region-layer .rbox img.face').length,
  tilesLit: [...document.querySelectorAll('#g-plate-sec .can-drop')].map((e) => e.id),
})
"""


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + repr(detail) if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def run(pg, edit_lora: bool):
    def hover(fx, fy):
        pg.evaluate(AT, [fx, fy, PNG, False])
        pg.wait_for_timeout(80)
        return pg.evaluate(READ)

    def release(fx, fy):
        pg.evaluate(AT, [fx, fy, PNG, True])
        pg.wait_for_timeout(600)
        pg.evaluate("() => window.dispatchEvent(new DragEvent('dragleave', {bubbles: true}))")
        pg.wait_for_timeout(100)

    def tile_set(slot):
        return pg.eval_on_selector(f"#g-drop-{slot}", "e => e.classList.contains('set')")

    def said():
        return pg.evaluate("() => [...document.querySelectorAll('#region-layer .refusal')]"
                           ".map((p) => p.textContent).join(' | ')")

    def draw(x0, y0, x1, y1):
        lay = pg.eval_on_selector("#region-layer", "e=>e.getBoundingClientRect().toJSON()")
        pg.keyboard.down("Meta")
        pg.mouse.move(lay["x"] + lay["width"] * x0, lay["y"] + lay["height"] * y0)
        pg.mouse.down()
        pg.mouse.move(lay["x"] + lay["width"] * x1, lay["y"] + lay["height"] * y1, steps=6)
        pg.mouse.up()
        pg.keyboard.up("Meta")
        pg.wait_for_timeout(200)

    invite = pg.evaluate("() => document.querySelector('.rl-invite')?.textContent || ''")
    if edit_lora:
        check("the empty frame's invitation names the band", "lower edge" in invite, invite)

    # The seeded arrangement: two columns, the whole frame covered.
    draw(0.01, 0.01, 0.49, 0.99)
    draw(0.51, 0.01, 0.99, 0.99)
    boxes = pg.evaluate("() => document.querySelectorAll('#region-layer .rbox').length")
    check("two full-height boxes cover the frame", boxes == 2, boxes)

    if edit_lora:
        r = hover(0.12, 0.95)
        check("a file over the frame draws the band's four zones",
              r["zones"] == ["scene", "outfit", "object", "style"], r["zones"])
        check("over the band's first zone, only Scene is captioned",
              [h["plate"] for h in r["hot"]] == ["scene"] and r["hot"][0]["says"] == "Scene",
              r["hot"])
        check("and the box under the band does not claim it", r["boxHit"] == 0, r["boxHit"])
        check("the tiles do not outline themselves", not r["tilesLit"], r["tilesLit"])
        for fx, plate in ((0.37, "outfit"), (0.62, "object"), (0.87, "style")):
            r = hover(fx, 0.95)
            check(f"over {plate}, only {plate} is captioned",
                  [h["plate"] for h in r["hot"]] == [plate], r["hot"])
        r = hover(0.25, 0.4)
        check("above the band a box is the character",
              r["boxHit"] == 1 and not r["hot"], {"boxHit": r["boxHit"], "hot": r["hot"]})

        release(0.12, 0.95)
        check("Scene: the drop is the scene plate", tile_set("scene"))
        check("and neither character got it", pg.evaluate(READ)["faces"] == 0)
        release(0.37, 0.95)
        check("Outfit: the drop is the outfit plate", tile_set("outfit"))
        release(0.62, 0.95)
        objs = pg.evaluate("() => document.querySelectorAll('#g-plate-sec .plate-obj').length")
        check("Object: the drop is an object plate", objs == 1, objs)
        focused = pg.evaluate("() => document.activeElement?.id || ''")
        check("with its note focused", focused == "g-object1-note", focused)
        release(0.87, 0.95)
        check("Style: the drop is the style reference", tile_set("style1"))
        release(0.25, 0.4)
        check("a drop above the band is still the character",
              pg.evaluate(READ)["faces"] == 1)
    else:
        r = hover(0.37, 0.95)
        hot = r["hot"][0] if r["hot"] else {}
        check("no edit LoRA: Outfit says so before the drop",
              hot.get("off") and "edit LoRA" in hot.get("says", ""), r["hot"])
        release(0.37, 0.95)
        text = said()
        check("and refuses in words after it", "identity-edit LoRA" in text, text)
        check("leaving the outfit unattached", not tile_set("outfit"))
        r = hover(0.87, 0.95)
        check("Style needs no weight and is not out",
              r["hot"] and not r["hot"][0]["off"], r["hot"])
        release(0.87, 0.95)
        check("and takes the drop", tile_set("style1"))


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    for edit_lora in (True, False):
        pg = b.new_page(viewport={"width": 1400, "height": 950}, color_scheme="dark")
        pg.route("**/api/scenes", lambda r: r.fulfill(json={"scenes": []}))
        if not edit_lora:
            def no_edit(route):
                resp = route.fetch()
                body = resp.json()
                body["edit_lora"] = False
                route.fulfill(response=resp, body=json.dumps(body))
            pg.route("**/api/state", no_edit)
        dialogs: list[str] = []
        pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(URL, wait_until="networkidle", timeout=60_000)
        pg.wait_for_timeout(1200)
        print(f"\n=== {URL} — edit LoRA {'present' if edit_lora else 'absent'} ===")
        run(pg, edit_lora)
        check("no dialog", not dialogs, dialogs)
        check("no page error", not errors, errors)
        pg.close()
    b.close()

print(f"\n{len(fails)} failure(s)" if fails else "\nall ok")
sys.exit(1 if fails else 0)

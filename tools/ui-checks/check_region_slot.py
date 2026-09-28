"""
Regions belong to the still slot; over a take the region tool says why it is off.

    python3 tools/ui-checks/check_region_slot.py                         # :8816
    python3 tools/ui-checks/check_region_slot.py 8794                    # a port
    python3 tools/ui-checks/check_region_slot.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per job when
ffmpeg is on the PATH — the stage has to be drawn for the video half to mean
anything, so without one this says so and fails.

What it holds, and the failure each one is for:

- **The still side draws as it did.** A double-click and a ⌘-drag on the empty
  frame each place a box — the two gestures that make a region, unchanged by
  regions becoming the still slot's.
- **Over a take, the tool is present and disabled.** The stage carries no
  `#region-layer` — a box drawn there would be sent nowhere, since
  `/api/video` has no regions field — but it does carry the disabled tool, with
  the reason on it for a screen reader and nothing painted at rest.
- **Reaching for it says why, on the stage.** A plain drag, a ⌘-press and a
  double-click each put the sentence on the picture; a plain click does not
  (it is not a region gesture), and the next press clears it. The failure this
  is for is silence: the same gesture draws on a still, so on a take it read as
  the app not having heard.
- **Never `alert()`.** Any dialog the page opens fails the run.
- **The boxes are the still slot's, not the surface's.** Back on the still
  side after a take, both boxes are where they were.
"""
import sys

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8816"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


TYPE = """
(text) => {
  const ta = document.querySelector('#prompt');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, text);
  ta.dispatchEvent(new Event('input', {bubbles: true}));
}
"""

# The handover is done when the stage is drawn and the bridging clip is gone.
ON_STAGE = """
() => !!document.querySelector('#vid-out #edit-stage canvas')
      && !document.querySelector('#vid-out video')
"""

SAID = "() => document.querySelector('#stage-regions .refusal')?.textContent || ''"
BOXES = "() => document.querySelectorAll('#region-layer .rbox').length"


def duration(pg, nth):
    """Duration is the switch — `Still` is the first row, seconds after it."""
    pg.click("#g-duration")
    pg.wait_for_selector(".menu button")
    pg.locator(".menu button").nth(nth).click()
    pg.wait_for_timeout(500)


def centre(pg, sel):
    b = pg.eval_on_selector(sel, "e => e.getBoundingClientRect().toJSON()")
    return b, b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    print(f"\n=== {URL} ===")
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    dialogs: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    def on_dialog(d):
        dialogs.append(f"{d.type}: {d.message}")
        d.dismiss()

    pg.on("dialog", on_dialog)
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1000)

    # ---- the still slot: boxes draw as they always did -------------------
    if pg.eval_on_selector("#c-video", "e => !e.classList.contains('hide')"):
        duration(pg, 0)
    pg.wait_for_selector("#frame #region-layer", timeout=10_000)
    lay, cx, cy = centre(pg, "#frame #region-layer")
    pg.mouse.dblclick(lay["x"] + lay["width"] * 0.1, lay["y"] + lay["height"] * 0.2)
    pg.wait_for_timeout(300)
    check("still: a double-click places a box", pg.evaluate(BOXES) == 1, str(pg.evaluate(BOXES)))
    # Put the first box's card away before framing the next, the way a person
    # would — a press on bare canvas.
    pg.keyboard.press("Escape")
    pg.keyboard.down("Meta")
    pg.mouse.move(lay["x"] + lay["width"] * 0.6, lay["y"] + lay["height"] * 0.2)
    pg.mouse.down()
    pg.mouse.move(lay["x"] + lay["width"] * 0.75, lay["y"] + lay["height"] * 0.5, steps=4)
    pg.mouse.move(lay["x"] + lay["width"] * 0.9, lay["y"] + lay["height"] * 0.8, steps=4)
    pg.mouse.up()
    pg.keyboard.up("Meta")
    pg.wait_for_timeout(300)
    check("still: a ⌘-drag places another", pg.evaluate(BOXES) == 2, str(pg.evaluate(BOXES)))

    # ---- a take: the tool is here, disabled, and says why ----------------
    duration(pg, 1)
    # The server keeps scenes across checks, so the page may have reopened one.
    if pg.locator("#canvas-clear").count():
        pg.click("#canvas-clear")
        pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)
    pg.evaluate(TYPE, "k3nan walks out of the shop")
    pg.wait_for_timeout(200)
    pg.click("#go-vid")
    pg.wait_for_function(
        "() => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= 1",
        timeout=60_000)
    pg.wait_for_function(ON_STAGE, timeout=30_000)
    pg.wait_for_timeout(400)

    d = pg.evaluate("""() => {
      const t = document.querySelector('#edit-stage #stage-regions');
      return {
        tool: !!t,
        disabled: t?.getAttribute('aria-disabled') || '',
        reason: t?.getAttribute('aria-description') || '',
        layer: document.querySelectorAll('#vid-out #region-layer').length,
        painted: document.querySelectorAll('#stage-regions .refusal').length,
      };
    }""")
    check("take: the region tool is on the stage", d["tool"], str(d))
    check("and disabled", d["disabled"] == "true", repr(d["disabled"]))
    check("with the reason on it", "/api/video" in d["reason"] and "H3" in d["reason"], repr(d["reason"]))
    check("take: no region layer to draw boxes nothing will read", d["layer"] == 0, str(d["layer"]))
    check("take: nothing painted at rest", d["painted"] == 0, str(d["painted"]))

    st, sx, sy = centre(pg, "#edit-stage")

    # A plain click is not a region gesture.
    pg.mouse.click(sx, sy)
    pg.wait_for_timeout(200)
    check("take: a plain click says nothing", pg.evaluate(SAID) == "", repr(pg.evaluate(SAID)))

    # A drag across the picture — what somebody who has not met ⌘ tries first.
    pg.mouse.move(st["x"] + st["width"] * 0.2, st["y"] + st["height"] * 0.2)
    pg.mouse.down()
    pg.mouse.move(st["x"] + st["width"] * 0.4, st["y"] + st["height"] * 0.4, steps=4)
    pg.mouse.move(st["x"] + st["width"] * 0.6, st["y"] + st["height"] * 0.6, steps=4)
    pg.mouse.up()
    pg.wait_for_timeout(200)
    said = pg.evaluate(SAID)
    check("take: a drag says why, on the stage", "/api/video" in said and "H3" in said, repr(said))
    inside = pg.evaluate("""() => {
      const p = document.querySelector('#stage-regions .refusal')?.getBoundingClientRect();
      const s = document.querySelector('#edit-stage').getBoundingClientRect();
      return !!p && p.width > 0 && p.left >= s.left && p.right <= s.right
             && p.top >= s.top && p.bottom <= s.bottom;
    }""")
    check("and the sentence is on the picture", inside)

    pg.mouse.click(sx, sy)
    pg.wait_for_timeout(200)
    check("take: the next press clears it", pg.evaluate(SAID) == "", repr(pg.evaluate(SAID)))

    # ⌘ — the gesture that draws on a still. The cursor answers before the press.
    pg.keyboard.down("Meta")
    pg.mouse.move(sx + 10, sy + 10)
    pg.mouse.move(sx + 12, sy + 12)
    pg.wait_for_timeout(100)
    cur = pg.eval_on_selector("#edit-stage", "e => getComputedStyle(e).cursor")
    check("take: ⌘ over the stage turns the cursor to not-allowed", cur == "not-allowed", repr(cur))
    pg.mouse.down()
    pg.mouse.up()
    pg.keyboard.up("Meta")
    pg.wait_for_timeout(200)
    check("take: a ⌘-press says why", "H3" in pg.evaluate(SAID), repr(pg.evaluate(SAID)))

    pg.mouse.click(sx, sy)
    pg.wait_for_timeout(200)
    pg.mouse.dblclick(sx, sy)
    pg.wait_for_timeout(200)
    check("take: a double-click says why", "H3" in pg.evaluate(SAID), repr(pg.evaluate(SAID)))
    check("take: the stage is still a stage (no box was drawn)",
          pg.locator("#vid-out .rbox").count() == 0)

    # ---- back to the still slot: the boxes are where they were -----------
    duration(pg, 0)
    pg.wait_for_selector("#region-layer", timeout=10_000)
    check("still: both boxes survived the take", pg.evaluate(BOXES) == 2, str(pg.evaluate(BOXES)))

    check("no alert() or confirm() at any point", not dialogs, "; ".join(dialogs[:3]))
    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

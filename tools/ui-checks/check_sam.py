"""
A tap on a render asks SAM what is there, and the page shows it is asking.

    python3 tools/ui-checks/check_sam.py                        # 8791
    python3 tools/ui-checks/check_sam.py http://localhost:8816

Touch-to-select had never been driven off a deployment: `preview_ui.py` had no
`/api/segment`, so the tap that is the way into an inpaint was untested until the
first live try — where a cold segmenter took about twenty seconds and the page
showed nothing for all of them, which read as a tap that missed. This holds:

- **A ring on the tapped point at once**, and no words while the answer is quick.
- **Words once it is slow**, saying why it is waiting.
- **The mask and `+ Region` when it answers**, and the ring gone.
- **A failed answer said on the layer**, not dropped.
- **`+ Region` makes the box.**

The segment reply is held by the route and released by hand, so "slow" is a
state this check puts the page in rather than a race it hopes to win.
"""
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8791"
if URL.isdigit():
    URL = f"http://localhost:{URL}"
fails: list[str] = []

TYPE = """
(text) => {
  const ta = document.querySelector('#prompt');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, text);
  ta.dispatchEvent(new Event('input', {bubbles: true}));
}
"""

READ = """
() => ({
  ring: !!document.querySelector('#region-layer .sam-ask'),
  words: document.querySelector('#region-layer .sam-ask span')?.textContent || '',
  overlay: !!document.querySelector('#region-layer .sam-overlay'),
  promote: document.querySelector('#region-layer .sam-promote')?.textContent?.trim() || '',
  said: [...document.querySelectorAll('#region-layer .refusal')].map((p) => p.textContent).join(' | '),
  boxes: document.querySelectorAll('#region-layer .rbox').length,
})
"""


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + repr(detail) if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg.route("**/api/scenes", lambda r: r.fulfill(json={"scenes": []}))
    dialogs: list[str] = []
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1200)
    print(f"\n=== {URL} ===")

    pg.evaluate(TYPE, "a man on a wet street under a streetlight")
    pg.wait_for_timeout(200)
    pg.evaluate("() => document.querySelector('#go-gen').click()")
    pg.wait_for_selector("#gen-out .shot img", timeout=40_000)
    pg.wait_for_timeout(800)

    held: list = []
    pg.route("**/api/segment", lambda route: held.append(route))

    def tap(fx, fy):
        lay = pg.eval_on_selector("#region-layer", "e=>e.getBoundingClientRect().toJSON()")
        pg.mouse.click(lay["x"] + lay["width"] * fx, lay["y"] + lay["height"] * fy)

    tap(0.5, 0.45)
    pg.wait_for_timeout(300)
    r = pg.evaluate(READ)
    check("a tap puts a ring on the point at once", r["ring"], r)
    check("with no words while the answer may still be quick", not r["words"], r["words"])
    pg.wait_for_timeout(1600)
    r = pg.evaluate(READ)
    check("once it is slow it says why it is waiting", "Waking the segmenter" in r["words"], r["words"])
    check("the request reached the route", len(held) == 1, len(held))
    if held:
        held.pop().continue_()
    pg.wait_for_timeout(800)
    r = pg.evaluate(READ)
    check("the answer paints the mask", r["overlay"], r)
    check("and offers + Region", r["promote"] == "+ Region", r["promote"])
    check("and the ring is gone", not r["ring"], r)

    tap(0.2, 0.2)
    pg.wait_for_timeout(300)
    if held:
        held.pop().fulfill(json={"error": "The segmenter ran out of memory."})
    pg.wait_for_timeout(600)
    r = pg.evaluate(READ)
    check("a failed answer is said on the layer", "ran out of memory" in r["said"], r["said"])
    check("and leaves no ring behind", not r["ring"], r)

    pg.unroute("**/api/segment")
    tap(0.5, 0.45)
    pg.wait_for_selector("#region-layer .sam-promote", timeout=10_000)
    pg.click("#region-layer .sam-promote")
    pg.wait_for_timeout(400)
    r = pg.evaluate(READ)
    check("+ Region makes the box", r["boxes"] == 1, r["boxes"])

    check("no dialog", not dialogs, dialogs)
    check("no page error", not errors, errors)
    b.close()

print(f"\n{len(fails)} failure(s)" if fails else "\nall ok")
sys.exit(1 if fails else 0)

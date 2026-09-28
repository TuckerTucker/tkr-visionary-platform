"""
A status read that never answers does not stop the render from landing.

    python3 tools/ui-checks/check_poll.py                        # 8791
    python3 tools/ui-checks/check_poll.py http://localhost:8816

Every job poll is an `everyMs`, which skips a tick while the last one is out,
and a status read had no timeout. On the deployed app one read did not come
back: the job completed, the page sat on "generate" with the picture on the
server, and a reload was the only way out — which lost the render from the
canvas. This holds one status read forever, as that one was held, and asserts
the render lands anyway, on the retry after the read is abandoned.
"""
import sys
import time

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


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + repr(detail) if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg.route("**/api/scenes", lambda r: r.fulfill(json={"scenes": []}))
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1200)
    print(f"\n=== {URL} ===")

    # The third status read of the run is held and never answered; every other
    # one goes through.
    seen = {"n": 0}
    held: list = []

    def gate(route):
        seen["n"] += 1
        if seen["n"] == 3:
            held.append(route)
            return
        route.continue_()

    pg.route("**/api/status/**", gate)
    pg.evaluate(TYPE, "a quiet street at dusk")
    pg.wait_for_timeout(200)
    t0 = time.time()
    pg.evaluate("() => document.querySelector('#go-gen').click()")
    try:
        pg.wait_for_selector("#gen-out .shot img", timeout=45_000)
        landed = time.time() - t0
    except Exception:  # noqa: BLE001 — not landing is the failure being checked
        landed = None
    check("one status read was held and never answered", len(held) == 1, len(held))
    check("the render lands anyway", landed is not None,
          f"{landed:.1f}s" if landed else "never")
    check("because polling went on past the held read", seen["n"] > 3, seen["n"])
    check("no page error", not errors, errors)
    b.close()

print(f"\n{len(fails)} failure(s)" if fails else "\nall ok")
sys.exit(1 if fails else 0)

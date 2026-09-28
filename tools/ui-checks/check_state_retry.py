"""
A stale first answer from /api/state does not lock the plates for the whole visit.

    python3 tools/ui-checks/check_state_retry.py                        # 8791
    python3 tools/ui-checks/check_state_retry.py http://localhost:8816

The page reads /api/state once at load, and the volume listing behind it can lag
on that first read — App.tsx records the DiT reading absent while 26 GB of it
sat on the volume, and re-checks while it does. The identity-edit LoRA comes off
the same listing and was not in that re-check, so on the deployed app the scene,
outfit and object tiles came up locked on every fresh load while the route
answered `edit_lora: true` a moment later. This serves exactly that: the first
state read says the edit LoRA is absent, every later one says it is there.
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8791"
if URL.isdigit():
    URL = f"http://localhost:{URL}"
fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + repr(detail) if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    pg = b.new_page(viewport={"width": 1400, "height": 950}, color_scheme="dark")
    pg.route("**/api/scenes", lambda r: r.fulfill(json={"scenes": []}))
    reads = {"n": 0}

    def lagging(route):
        reads["n"] += 1
        resp = route.fetch()
        body = resp.json()
        if reads["n"] == 1:
            body["edit_lora"] = False
        route.fulfill(response=resp, body=json.dumps(body))

    pg.route("**/api/state", lagging)
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(3500)
    print(f"\n=== {URL} ===")
    locked = pg.eval_on_selector_all(
        "#g-plate-sec [id^=g-drop]", "els => els.filter(e => e.classList.contains('locked')).map(e => e.id)")
    check("the page read the state more than once", reads["n"] > 1, reads["n"])
    check("and the plates are not left locked by the stale first answer", not locked, locked)
    check("no page error", not errors, errors)
    b.close()

print(f"\n{len(fails)} failure(s)" if fails else "\nall ok")
sys.exit(1 if fails else 0)

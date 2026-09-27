"""
The cut exports in the page and lands in the gallery.

    python3 tools/ui-checks/check_export.py                         # :8796
    python3 tools/ui-checks/check_export.py 8791                    # a port
    python3 tools/ui-checks/check_export.py http://localhost:5173   # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per take
when ffmpeg is on the PATH and whose `POST /api/outputs` keeps what it is sent
and serves those bytes back. The encode is real — OpenVideo's Compositor on
WebCodecs, in Chrome — so what arrives at the stub is the page's own MP4.

What it holds, and the failure each one is for:

- **No control until there is time.** A still session has no Export at all.
- **Export produces an item in the gallery.** The control shows which take is
  encoding while it runs; the server receives an MP4 (ftyp box) with the scene's
  sidecar; the item is recorded into the drawer the way a render is; and
  `/api/file` plays back the bytes that were sent, not a test card.
- **A failed upload keeps the encode.** With the route failing, the control
  offers Save to disk (a blob: link to an MP4) and Send again, and Send again
  lands it without encoding twice.
- **Stop uploads nothing.**
- **Unsupported is disabled with the reason on the control.** With
  `VideoEncoder` removed before the page loads — the Firefox case — the button
  is there, greyed, and the text beside it names `VideoEncoder`.
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8796"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def http(path):
    with urllib.request.urlopen(URL + path, timeout=30) as r:
        return r.headers.get("Content-Type", ""), r.read()


def exports():
    _, body = http("/api/gallery")
    return [i for i in json.loads(body)["items"] if i["job_id"].startswith("exp")]


def to_video(pg):
    """Duration is the switch — see check_edit.py."""
    if not pg.eval_on_selector("#c-video", "e => e.classList.contains('hide')"):
        return
    pg.click("#g-duration")
    pg.wait_for_selector(".menu button")
    pg.locator(".menu button").nth(1).click()
    pg.wait_for_timeout(500)


V1_CLIPS = '#edit-tracks .et-lane[data-track="v1"] .et-clip'


def has_time(pg, takes=1):
    """A scene with at least `takes` clips on V1 — rendered here when the
    server has not kept enough from an earlier check. Every finished take joins
    the scene (`useVideo.finish`), so no Continue is needed to make a second;
    after a reload there is no clip on the canvas to Continue from anyway."""
    to_video(pg)
    try:
        pg.wait_for_selector(V1_CLIPS, timeout=8_000)
    except Exception:
        pass
    lines = ["k3nan walks out of the shop", "he stops when he sees the car"]
    while pg.locator(V1_CLIPS).count() < takes:
        n = pg.locator(V1_CLIPS).count()
        pg.click("#prompt")
        pg.fill("#prompt", lines[n % 2])
        pg.click("#go-vid")
        pg.wait_for_function("(n) => document.querySelectorAll(%r).length > n" % V1_CLIPS,
                             arg=n, timeout=40_000)
        pg.wait_for_timeout(400)


# Every label the status shows, as the page shows it — the encode of a short cut
# is over in a second or two, far quicker than a poll from here.
WATCH = """
() => {
  window.__labels = [];
  new MutationObserver(() => {
    const s = document.querySelector('#export-status');
    if (s && window.__labels[window.__labels.length - 1] !== s.textContent)
      window.__labels.push(s.textContent);
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}
"""

BLOB = """
async () => {
  const a = document.querySelector('#export-save');
  if (!a) return null;
  const b = await (await fetch(a.href)).blob();
  const head = new Uint8Array(await b.slice(0, 8).arrayBuffer());
  return { href: a.href, download: a.download, size: b.size, type: b.type,
           ftyp: String.fromCharCode(...head.slice(4, 8)) };
}
"""

with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    print(f"\n=== {URL} ===")
    ctype, _ = http("/api/file/vidprobe/clip.mp4")
    check("the preview serves a real mp4 (ffmpeg on PATH)", ctype == "video/mp4", ctype)

    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1000)
    check("still session: no export control", pg.locator("#edit-export").count() == 0)

    # ---- export lands in the gallery -----------------------------------
    # Two takes, so which-take-is-encoding is a claim about more than one.
    has_time(pg, 2)
    go = pg.locator("#export-go")
    check("the control exists once the scene has time", go.count() == 1)
    pg.wait_for_function("() => { const b = document.querySelector('#export-go');"
                         " return b && !b.disabled }", timeout=40_000)
    check("and is enabled in Chrome", go.is_enabled())
    n_clips = pg.locator('#edit-tracks .et-lane[data-track="v1"] .et-clip:not(.broken)').count()
    before = {i["job_id"] for i in exports()}
    pg.evaluate(WATCH)
    go.click()
    pg.wait_for_function(
        "() => (document.querySelector('#export-done')?.textContent || '').includes('in the gallery')",
        timeout=120_000)
    labels = pg.evaluate("() => window.__labels")
    check("progress names the take being encoded, against the cut's clips",
          any(f"take {n_clips} of {n_clips}" in l for l in labels)
          and all(f" of {n_clips}" in l for l in labels if l.startswith("Encoding take")),
          " | ".join(labels[:8]))
    new = [i for i in exports() if i["job_id"] not in before]
    check("the server received one export", len(new) == 1, str([i["job_id"] for i in new]))
    if new:
        it = new[0]
        check("filed as an edited video with its takes",
              it.get("kind") == "video" and it.get("source") == "edit"
              and len(it.get("takes") or []) == n_clips and it.get("width") and it.get("seconds"),
              json.dumps({k: it.get(k) for k in ("kind", "source", "width", "seconds", "scene")}))
        ctype, body = http(f"/api/file/{it['job_id']}/{it['files'][0]}")
        check("/api/file serves the page's own MP4",
              ctype == "video/mp4" and body[4:8] == b"ftyp" and len(body) > 10_000,
              f"{ctype} {len(body)} bytes {body[4:8]!r}")
        pg.click("#t-drawer")
        pg.wait_for_timeout(600)
        cards = pg.locator("#drawer-grid .gal").first
        vid = cards.locator("video")
        src = vid.get_attribute("src") if vid.count() else ""
        check("the drawer's newest card is the export, as a video",
              it["job_id"] in (src or ""), str(src))
        pg.click("#t-drawer")

    # ---- a failed upload keeps the encode --------------------------------
    pg.click("#export-done")
    pg.wait_for_selector("#export-go:not([disabled])", timeout=10_000)
    pg.route("**/api/outputs", lambda r: r.fulfill(status=502, body="upstream went away"))
    before = {i["job_id"] for i in exports()}
    pg.click("#export-go")
    pg.wait_for_selector("#export-save", timeout=120_000)
    err = pg.text_content("#export-error") or ""
    check("the failure is named on the control", "did not reach the gallery" in err, err[:90])
    saved = pg.evaluate(BLOB)
    check("Save to disk is the encoded MP4",
          bool(saved) and saved["href"].startswith("blob:") and saved["download"].endswith(".mp4")
          and saved["type"] == "video/mp4" and saved["ftyp"] == "ftyp" and saved["size"] > 10_000,
          json.dumps(saved))
    pg.unroute("**/api/outputs")
    pg.evaluate(WATCH)
    pg.click("#export-retry")
    pg.wait_for_function(
        "() => (document.querySelector('#export-done')?.textContent || '').includes('in the gallery')",
        timeout=60_000)
    labels = pg.evaluate("() => window.__labels")
    check("Send again uploads without encoding again",
          not any("Encoding" in l for l in labels), " | ".join(labels[:4]))
    new = [i for i in exports() if i["job_id"] not in before]
    check("and lands it", len(new) == 1, str([i["job_id"] for i in new]))

    # ---- stop uploads nothing -------------------------------------------
    pg.wait_for_selector("#export-go:not([disabled])", timeout=10_000)
    check("the landed state returns to Export on its own", True)
    before = {i["job_id"] for i in exports()}
    pg.click("#export-go")
    pg.wait_for_selector("#export-stop", timeout=10_000)
    pg.click("#export-stop")
    pg.wait_for_selector("#export-go", timeout=10_000)
    pg.wait_for_timeout(1500)
    check("Stop returns to Export", "Export" in (pg.text_content("#export-go") or ""))
    check("and uploads nothing", not [i for i in exports() if i["job_id"] not in before])
    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()

    # ---- unsupported: disabled, with the reason -------------------------
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    ctx.add_init_script("Object.defineProperty(window, 'VideoEncoder', "
                        "{ value: undefined, configurable: true, writable: true })")
    pg = ctx.new_page()
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(800)
    has_time(pg)
    pg.wait_for_selector("#export-why", timeout=40_000)
    why = pg.text_content("#export-why") or ""
    check("without VideoEncoder the control stays, disabled", pg.locator("#export-go").is_disabled())
    check("with the reason on it, naming what is missing", "VideoEncoder" in why, why[:100])
    check("and the reason is the button's description too",
          pg.get_attribute("#export-go", "aria-describedby") == "export-why")
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

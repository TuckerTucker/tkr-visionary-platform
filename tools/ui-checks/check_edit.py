"""
Takes become clips on V1, in order, and the cut survives a reload.

    python3 tools/ui-checks/check_edit.py                         # :8791
    python3 tools/ui-checks/check_edit.py 8794                    # a port
    python3 tools/ui-checks/check_edit.py http://localhost:5173   # a URL

Driven the way a person does it — the duration menu to reach the video side,
the prompt, Generate, Continue — against `preview_ui.py`, whose `/api/file`
serves a real MP4 per job when ffmpeg is on the PATH. Without one there is no
clip the engine can read, and this says so and fails rather than passing on
structure alone: the thing under test is that OpenVideo actually plays them.

What it holds, and the failure each one is for:

- **A still session never meets the editor.** No timeline, no stage, and no
  lazily-loaded script requested at all — the engine is 3.4 MB, and the rule is
  that somebody making one image never downloads it. Checked twice: on a fresh
  page, and at the end on a page that *restored a scene with takes* while on
  stills, which is the case a looser gate would get wrong.
- **Two runs with Continue between them are two clips on V1, in that order,
  end to end.** The second starts where the first ends; nothing was dragged.
- **The cut plays.** Play moves the playhead; a press on the lanes seeks.
- **The engine's cache is the scene's.** The files the engine wrote into OPFS
  `assets/` are named by the keys `useEdit.assetKey` computes — so pruning,
  which deletes by those keys, is deleting the right files — and a stray file
  planted there is gone after the scene reopens.
- **A reload restores the arrangement from project.json, not by recompiling.**
  The clip ids after the reload are the ids before it; a recompile would mint
  new ones.
- **A take whose file is gone shows it on itself and the rest still plays.**
"""
import json
import re
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8791"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def http(path, body=None):
    req = urllib.request.Request(
        URL + path, method="POST" if body is not None else "GET",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def entry_scripts():
    """The scripts index.html loads. Anything else under /assets that ends in
    .js is a chunk somebody imported lazily — today that is only the engine."""
    with urllib.request.urlopen(URL + "/", timeout=10) as r:
        html = r.read().decode()
    return set(re.findall(r'/assets/[^"\']+\.js', html))


# The engine's key for a URL, written out a second time in the check rather
# than read off the page: the point is to compare it with the names the engine
# itself wrote into OPFS.
KEYS_AND_ASSETS = """
async (urls) => {
  const key = (s) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  };
  const names = [];
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('assets');
    for await (const n of dir.keys()) names.push(n);
  } catch (e) {}
  return { keys: urls.map((u) => key(new URL(u, location.origin).href)), names };
}
"""

PLANT = """
async () => {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('assets', { create: true });
  const f = await dir.getFileHandle('0ddba11', { create: true });
  const w = await f.createWritable(); await w.write('stale'); await w.close();
  return true;
}
"""

CLIPS = """
() => [...document.querySelectorAll('#edit-tracks .et-lane[data-track="v1"] .et-clip')]
  .map((c) => ({ id: c.dataset.clip, job: c.dataset.job || '', slot: c.dataset.slot || '',
                 left: parseFloat(c.style.left), width: parseFloat(c.style.width),
                 broken: c.classList.contains('broken'), text: c.textContent }))
  .sort((a, b) => a.left - b.left)
"""

HEAD_X = """
() => {
  const h = document.querySelector('#edit-head');
  const m = h && /translateX\\(([-\\d.]+)px\\)/.exec(h.style.transform);
  return m ? parseFloat(m[1]) : null;
}
"""


def to_video(pg):
    """Duration is the switch — index 1 is always the model's shortest clip.
    See web/src/console/Duration.tsx."""
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


def render(pg, n_takes=None):
    """One stubbed take, to completion: the clip on the canvas changes, and —
    when `n_takes` is given — V1 has that many clips."""
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


def lazy_js(requests, entry):
    return sorted({u for u in requests
                   if re.search(r"/assets/[^/?]+\.js", u)
                   and not any(u.endswith(e) for e in entry)})


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    entry = entry_scripts()
    print(f"\n=== {URL} ===")

    probe = urllib.request.urlopen(URL + "/api/file/vidprobe/clip.mp4", timeout=60)
    real = probe.headers.get("Content-Type") == "video/mp4"
    check("the preview serves a real mp4 (ffmpeg on PATH)", real,
          probe.headers.get("Content-Type", ""))

    # ---- a still session ------------------------------------------------
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    reqs: list[str] = []
    pg.on("request", lambda r: reqs.append(r.url))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1200)
    check("still session: no edit surface", pg.locator("#edit, #edit-tracks, #edit-stage").count() == 0)
    check("still session: no lazily-loaded script", not lazy_js(reqs, entry), ", ".join(lazy_js(reqs, entry)))

    # ---- two takes with Continue between them ---------------------------
    to_video(pg)
    # The server keeps scenes across checks, so the page may have restored one
    # with takes in it. One throwaway render and Clear starts a new scene —
    # the only state in which "two runs make two clips" is a claim.
    write(pg, "a throwaway take")
    render(pg)
    pg.click("#canvas-clear")
    pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)
    write(pg, "k3nan walks out of the shop")
    render(pg, 1)
    pg.click("#canvas-chain")
    pg.wait_for_timeout(600)
    write(pg, "he stops when he sees the car")
    render(pg, 2)
    engine_js = lazy_js(reqs, entry)
    check("the engine loaded once there was time", bool(engine_js), ", ".join(engine_js))

    clips = pg.evaluate(CLIPS)
    jobs = [c["job"] for c in clips]
    check("two clips on V1", len(clips) == 2, str(jobs))
    ordered = len(clips) == 2 and jobs[0] < jobs[1]
    check("in the order they were rendered", ordered, str(jobs))
    if len(clips) == 2:
        a, c2 = clips
        check("the second starts where the first ends", abs(a["left"] + a["width"] - c2["left"]) < 1.5,
              f"{a['left']}+{a['width']} vs {c2['left']}")
        # 3s at 30px/s — the delivered length, read off the file.
        check("each is as long as its file", all(abs(c["width"] - 90) < 3 for c in clips),
              str([c["width"] for c in clips]))
        check("each carries a slot id", all(c["slot"] for c in clips) and clips[0]["slot"] != clips[1]["slot"])
        check("each shows its take's sentence",
              "walks out" in clips[0]["text"] and "sees the car" in clips[1]["text"])

    # ---- it plays -------------------------------------------------------
    pg.wait_for_selector("#edit-stage canvas", timeout=10_000)
    x0 = pg.evaluate(HEAD_X) or 0
    pg.click("#edit-play")
    pg.wait_for_timeout(1500)
    x1 = pg.evaluate(HEAD_X) or 0
    pg.click("#edit-play")
    check("play moves the playhead", x1 > x0 + 5, f"{x0} -> {x1}")
    lane = pg.locator('#edit-tracks .et-lane[data-track="v1"]')
    box = lane.bounding_box()
    body = pg.locator("#edit-tracks .et-body").bounding_box()
    if box and body:
        pg.mouse.click(body["x"] + 150, box["y"] + box["height"] / 2)
        pg.wait_for_timeout(300)
        xs = pg.evaluate(HEAD_X)
        check("a press on the lanes seeks there", xs is not None and abs(xs - 150) < 3, str(xs))

    # ---- the engine's cache ---------------------------------------------
    urls = [f"/api/file/{j}/clip.mp4" for j in jobs]
    deadline = time.time() + 15
    cache = pg.evaluate(KEYS_AND_ASSETS, urls)
    while time.time() < deadline and not set(cache["keys"]) <= set(cache["names"]):
        pg.wait_for_timeout(500)
        cache = pg.evaluate(KEYS_AND_ASSETS, urls)
    check("the engine cached each take under the key useEdit computes",
          set(cache["keys"]) <= set(cache["names"]), f"keys={cache['keys']} names={cache['names']}")

    # ---- a reload restores the arrangement ------------------------------
    ids_before = [c["id"] for c in clips]
    sid = None
    deadline = time.time() + 10
    while time.time() < deadline:
        rows = http("/api/scenes")["scenes"]
        sid = rows[0]["id"] if rows else None
        rec = http(f"/api/scenes/{sid}") if sid else {}
        proj = rec.get("project") or {}
        if len(proj.get("clips") or {}) == 2:
            break
        time.sleep(0.4)
    check("project.json holds both clips", len(((rec or {}).get("project") or {}).get("clips") or {}) == 2,
          str(sid))
    pg.evaluate(PLANT)
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(1000)
    to_video(pg)
    pg.wait_for_function(
        "() => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= 2",
        timeout=40_000)
    pg.wait_for_timeout(600)
    after = pg.evaluate(CLIPS)
    check("reload restores both clips in order", [c["job"] for c in after] == jobs, str([c["job"] for c in after]))
    check("from project.json, not a recompile", [c["id"] for c in after] == ids_before,
          f"{ids_before} vs {[c['id'] for c in after]}")
    cache = pg.evaluate(KEYS_AND_ASSETS, urls)
    check("opening the scene pruned what it does not reference", "0ddba11" not in cache["names"],
          str(cache["names"]))

    # ---- a take whose file is gone --------------------------------------
    intent = dict(rec.get("intent") or {})
    good = (intent.get("takes") or [{}])[0]
    intent["takes"] = [good, {"jobId": "vidmissing01", "file": "clip.mp4", "line": "the car pulls away",
                              "seconds": 3}]
    broken_sid = "scn20990101000000beef"
    http(f"/api/scenes/{broken_sid}", {"intent": intent})
    pg.reload(wait_until="networkidle")
    pg.wait_for_timeout(1000)
    to_video(pg)
    pg.wait_for_function(
        "() => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= 2",
        timeout=40_000)
    pg.wait_for_timeout(800)
    mixed = pg.evaluate(CLIPS)
    gone = [c for c in mixed if c["broken"]]
    check("the missing take is drawn broken, on itself",
          len(gone) == 1 and "clip.mp4" in gone[0]["text"] and "vidmissing01" in gone[0]["text"],
          str([c["text"] for c in gone]))
    check("and keeps its place after the first", len(mixed) == 2 and mixed[1]["broken"] and not mixed[0]["broken"])
    pg.wait_for_selector("#edit-stage canvas", timeout=10_000)
    x0 = pg.evaluate(HEAD_X) or 0
    pg.click("#edit-play")
    pg.wait_for_timeout(1200)
    x1 = pg.evaluate(HEAD_X) or 0
    pg.click("#edit-play")
    check("the rest of the cut still plays", x1 > x0 + 5, f"{x0} -> {x1}")
    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()

    # ---- stills, with a scene that has takes restored under them --------
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    reqs = []
    pg.on("request", lambda r: reqs.append(r.url))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1500)
    asked = [u for u in reqs if any(u.endswith(e.rsplit("/", 1)[-1]) for e in engine_js)]
    check("a restored scene on stills has no timeline", pg.locator("#edit-tracks, #edit-stage").count() == 0)
    check("and never requests the engine", not asked and not lazy_js(reqs, entry), ", ".join(asked))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

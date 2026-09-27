"""
Tracks are made by a drop: your own photograph over the take, your own sound
under it, a title typed at the playhead — each one undo.

    python3 tools/ui-checks/check_drop_tracks.py                  # :8806
    python3 tools/ui-checks/check_drop_tracks.py 8806             # a port
    python3 tools/ui-checks/check_drop_tracks.py http://host:5173 # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per job
when ffmpeg is on the PATH and whose `/api/scenes/{id}/media` lands a dropped
file with app.py's own sniff and naming. The files dropped are made here — a
solid red PNG, a second of WAV, a PDF — and handed to the page as a real
`drop` event carrying a `DataTransfer`, the same object the Finder hands it.

What it holds, and the failure each one is for:

- **A photograph dropped below V1 makes V2, at the drop time, over V1.** The
  lane appears, its clip starts where it was let go, project.json has the new
  track ahead of V1 (OpenVideo composites the first track on top), and the
  stage's own pixels are the photograph's red — the check that the order is
  not merely written down but drawn.
- **Audio makes an A track**, at the bottom, holding the sound.
- **Each drop is one undo.** `window.__edit.undo()` once takes away the track
  *and* its clip; an empty lane left behind would be an undo that did not put
  the page back.
- **A file the timeline cannot place is refused on the zone, naming it** —
  and nothing is added.
- **Dropped files never reach a dataset.** The datasets listing is the same
  before and after, and the file is served back from the scene's folder.
- **Keyboard parity.** Enter on the strip opens the picker; T on the timeline
  makes a title that is typed in place and kept with Enter.
"""
import base64
import json
import struct
import sys
import time
import urllib.request
import wave
import zlib
from io import BytesIO

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8806"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")
# The timeline's scale — `PX_PER_SEC` in web/src/scene/Timeline.
PX = 30

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
        return r.status, dict(r.headers), r.read()


def get_json(path):
    return json.loads(http(path)[2])


# ---- the files --------------------------------------------------------------

def png(w, h, rgb):
    """A solid PNG, by hand — this runs where Pillow may not be installed."""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def wav(seconds=2.0, rate=22050):
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        # A quiet ramp rather than silence: some decoders report an all-zero
        # file with no duration.
        w.writeframes(b"".join(struct.pack("<h", (i % 200) * 40 - 4000)
                               for i in range(int(seconds * rate))))
    return buf.getvalue()


def pixel(png_bytes):
    """The one pixel of a 1x1 PNG screenshot. With a single pixel every PNG
    filter reduces to the raw bytes (there is nothing left of or above it), so
    this needs no decoder beyond zlib."""
    pos, idat = 8, b""
    while pos < len(png_bytes):
        n = struct.unpack(">I", png_bytes[pos:pos + 4])[0]
        kind = png_bytes[pos + 4:pos + 8]
        if kind == b"IDAT":
            idat += png_bytes[pos + 8:pos + 8 + n]
        pos += 12 + n
    row = zlib.decompress(idat)
    return tuple(row[1:4])


RED = png(640, 360, (230, 20, 20))
SOUND = wav()
PDF = b"%PDF-1.4\n% not a picture\n" + b"0" * 200

DROP = """
async ({ sel, name, type, b64, x }) => {
  const el = document.querySelector(sel);
  if (!el) return 'no ' + sel;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type }));
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + x, clientY: r.top + r.height / 2 };
  for (const t of ['dragenter', 'dragover', 'drop']) {
    el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
  }
  return 'ok';
}
"""

LANES = """
() => [...document.querySelectorAll('#edit-tracks .et-lane')].map((l) => ({
  track: l.dataset.track, audio: l.classList.contains('audio'),
  clips: [...l.querySelectorAll('.et-clip')].map((c) => ({
    id: c.dataset.clip, left: parseFloat(c.style.left), text: c.textContent })),
}))
"""


def to_video(pg):
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


def lane_count(pg):
    return pg.evaluate("() => document.querySelectorAll('#edit-tracks .et-lane').length")


def wait_lanes(pg, n, timeout=20_000):
    try:
        pg.wait_for_function(
            "(n) => document.querySelectorAll('#edit-tracks .et-lane').length === n",
            arg=n, timeout=timeout)
        return True
    except Exception:
        return False


def saved_project(sid, want):
    """project.json once it satisfies `want` — the saver is debounced."""
    deadline = time.time() + 10
    proj = {}
    while time.time() < deadline:
        proj = get_json(f"/api/scenes/{sid}").get("project") or {}
        if want(proj):
            return proj
        time.sleep(0.3)
    return proj


def stage_pixel(pg):
    box = pg.locator("#edit-stage").bounding_box()
    if not box:
        return None
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    return pixel(pg.screenshot(clip={"x": cx, "y": cy, "width": 1, "height": 1}))


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    print(f"\n=== {URL} ===")
    probe = urllib.request.urlopen(URL + "/api/file/vidprobe/clip.mp4", timeout=60)
    check("the preview serves a real mp4 (ffmpeg on PATH)",
          probe.headers.get("Content-Type") == "video/mp4", probe.headers.get("Content-Type", ""))

    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(1000)
    to_video(pg)
    write(pg, "a throwaway take")
    render(pg)
    pg.click("#canvas-clear")
    pg.wait_for_function("() => !document.querySelector('#edit-tracks')", timeout=10_000)
    write(pg, "k3nan sits at the window")
    render(pg, 1)
    pg.wait_for_selector("#edit-drop", timeout=20_000)
    pg.wait_for_selector("#edit-stage canvas", timeout=20_000)
    pg.wait_for_timeout(800)

    sid = get_json("/api/scenes")["scenes"][0]["id"]
    datasets_before = http("/api/datasets")[2]
    lanes0 = lane_count(pg)
    check("one lane before anything is dropped", lanes0 == 1, str(lanes0))
    before_px = stage_pixel(pg)

    # ---- a photograph below V1 ------------------------------------------
    at_px = 45  # 1.5s at 30px/s
    said = pg.evaluate(DROP, {"sel": "#edit-drop", "name": "Red Card.png", "type": "image/png",
                              "b64": base64.b64encode(RED).decode(), "x": at_px})
    check("the drop reached the zone", said == "ok", said)
    check("a new lane appears", wait_lanes(pg, lanes0 + 1), str(lane_count(pg)))
    lanes = pg.evaluate(LANES)
    check("V1 stays first on the timeline, the new lane below it",
          len(lanes) == 2 and lanes[0]["track"] == "v1" and not lanes[1]["audio"], str(lanes)[:200])
    new = lanes[1] if len(lanes) == 2 else {"clips": []}
    check("the photograph sits at the drop time",
          len(new["clips"]) == 1 and abs(new["clips"][0]["left"] - at_px) < 1.5,
          str(new["clips"])[:120])
    check("named on the clip after the file", bool(new["clips"]) and "Red Card" in new["clips"][0]["text"])
    proj = saved_project(sid, lambda p: len(p.get("tracks") or []) == 2)
    tracks = proj.get("tracks") or []
    v2 = tracks[0] if tracks else {}
    check("project.json names it V2", v2.get("name") == "V2" and v2.get("type") == "video", str(v2)[:120])
    check("ahead of V1 in the engine's order, so it composites over it",
          [t.get("id") for t in tracks][1:] == ["v1"], str([t.get("id") for t in tracks]))
    clip = (proj.get("clips") or {}).get((v2.get("clipIds") or [""])[0]) or {}
    check("its clip is an Image from the scene's own folder, starting at 1.5s",
          clip.get("type") == "Image" and f"/api/scene-file/{sid}/" in str(clip.get("src"))
          and (clip.get("timing") or {}).get("display", {}).get("from") == 1_500_000,
          f"{clip.get('type')} {clip.get('src')} {(clip.get('timing') or {}).get('display')}")
    name = (clip.get("metadata") or {}).get("media", "")
    status, headers, body = http(f"/api/scene-file/{sid}/{name}") if name else (0, {}, b"")
    check("the file is served back from the scene, byte for byte, as image/png",
          status == 200 and body == RED and headers.get("Content-Type") == "image/png",
          f"{name} {status} {headers.get('Content-Type')}")
    pg.wait_for_timeout(1500)
    red = stage_pixel(pg)
    check("the stage shows the photograph over the take",
          red is not None and red[0] > 180 and red[1] < 70 and red[2] < 70,
          f"before {before_px} after {red}")

    pg.evaluate("() => window.__edit.undo()")
    check("one undo takes the track and its clip away together", wait_lanes(pg, lanes0), str(lane_count(pg)))
    proj = saved_project(sid, lambda p: len(p.get("tracks") or []) == 1)
    check("and project.json is back to V1 alone",
          [t.get("id") for t in proj.get("tracks") or []] == ["v1"]
          and all(c.get("type") != "Image" for c in (proj.get("clips") or {}).values()),
          str([t.get("id") for t in proj.get("tracks") or []]))

    # ---- audio ----------------------------------------------------------
    said = pg.evaluate(DROP, {"sel": "#edit-drop", "name": "room tone.wav", "type": "audio/wav",
                              "b64": base64.b64encode(SOUND).decode(), "x": 0})
    check("an audio drop makes a lane", wait_lanes(pg, lanes0 + 1), str(lane_count(pg)))
    lanes = pg.evaluate(LANES)
    check("an A lane, at the bottom, holding the sound",
          len(lanes) == 2 and lanes[-1]["audio"] and len(lanes[-1]["clips"]) == 1, str(lanes)[:200])
    proj = saved_project(sid, lambda p: len(p.get("tracks") or []) == 2)
    tracks = proj.get("tracks") or []
    a1 = tracks[-1] if tracks else {}
    check("project.json names it A1, after V1",
          a1.get("name") == "A1" and a1.get("type") == "audio" and tracks[0].get("id") == "v1",
          str([(t.get("id"), t.get("name")) for t in tracks]))
    pg.evaluate("() => window.__edit.undo()")
    check("one undo takes the sound away", wait_lanes(pg, lanes0), str(lane_count(pg)))

    # ---- a refusal ------------------------------------------------------
    said = pg.evaluate(DROP, {"sel": "#edit-drop", "name": "call sheet.pdf", "type": "application/pdf",
                              "b64": base64.b64encode(PDF).decode(), "x": 10})
    try:
        pg.wait_for_selector("#edit-drop-error", timeout=5_000)
        msg = pg.inner_text("#edit-drop-error")
    except Exception:
        msg = ""
    check("a PDF is refused on the zone, naming the file and what it is",
          "call sheet.pdf" in msg and "PDF" in msg, msg[:120])
    pg.wait_for_timeout(300)
    check("and nothing is added", lane_count(pg) == lanes0, str(lane_count(pg)))

    # ---- keyboard: the picker, and a title ------------------------------
    pg.focus("#edit-drop")
    try:
        with pg.expect_file_chooser(timeout=5_000) as fc:
            pg.keyboard.press("Enter")
        chooser = fc.value
        chooser.set_files([{"name": "red.png", "mimeType": "image/png", "buffer": RED}])
        picked = wait_lanes(pg, lanes0 + 1)
    except Exception as exc:
        picked = False
        print("   ", exc)
    check("Enter on the strip opens the picker, and a picked file makes a track", picked)
    if picked:
        pg.evaluate("() => window.__edit.undo()")
        wait_lanes(pg, lanes0)

    pg.focus("#edit-play")
    pg.keyboard.press("t")
    try:
        pg.wait_for_selector("[data-title-edit]", timeout=5_000)
        opened = True
    except Exception:
        opened = False
    check("T on the timeline puts a title at the playhead, open for typing", opened)
    if opened:
        pg.keyboard.type("Chapter one")
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(400)
        lanes = pg.evaluate(LANES)
        texts = [c["text"] for l in lanes for c in l["clips"]]
        check("the typed words are the title", any("Chapter one" in t for t in texts), str(texts)[:160])
        proj = saved_project(sid, lambda p: any(c.get("type") == "Text" and c.get("text") == "Chapter one"
                                                for c in (p.get("clips") or {}).values()))
        tracks = proj.get("tracks") or []
        check("on a T track above every picture track",
              bool(tracks) and tracks[0].get("name") == "T1" and tracks[0].get("type") == "text",
              str([(t.get("id"), t.get("name")) for t in tracks]))
        fonts = [str(((c.get("style") or {}).get("fontUrl")) or "")
                 for c in (proj.get("clips") or {}).values() if c.get("type") == "Text"]
        check("in the page's own face, fetched from nowhere else",
              bool(fonts) and all(f.startswith(URL) for f in fonts), str(fonts))
        pg.evaluate("() => window.__edit.undo()")
        pg.wait_for_timeout(300)
        texts = [c["text"] for l in pg.evaluate(LANES) for c in l["clips"]]
        check("one undo takes the words back", any(t.strip().startswith("Title") for t in texts), str(texts)[:160])
        pg.evaluate("() => window.__edit.undo()")
        check("and a second takes the title away", wait_lanes(pg, lanes0), str(lane_count(pg)))

    check("the datasets are exactly as they were", http("/api/datasets")[2] == datasets_before)
    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

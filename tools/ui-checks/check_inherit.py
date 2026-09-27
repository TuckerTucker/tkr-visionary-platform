"""
An insert over V1 opens with the scene it covers — cast, look — each marked
inherited, and dropping one touches only the insert.

    python3 tools/ui-checks/check_inherit.py                  # :8805
    python3 tools/ui-checks/check_inherit.py 8805             # a port
    python3 tools/ui-checks/check_inherit.py http://host:5173 # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per job
when ffmpeg is on the PATH. The scene is seeded the way a reload finds one —
`POST /api/scenes/{id}` with a cast of two (one with a photograph), a style, a
grade and three takes — so the check starts from a scene the page *restored*,
which is the case an insert has to survive anyway.

What it holds, and the failure each one is for:

- **I at 0:04.5 makes an empty insert on V2 over the V1 slot playing there**
  (the second of three), and project.json records which slot it covers and
  what it copied: both cast members, the style and the grade. A copy read off
  the wrong slot, or off nothing, is a cutaway rebuilt by hand.
- **Every inherited item is on the insert and marked inherited** — a chip per
  thing, `data-inherited`, dashed — not in a panel.
- **The empty insert draws nothing.** The stage at its start is V1's picture,
  pixel for pixel: an empty slot that covered the take would be a black hole in
  the cut until it was rendered.
- **Dropping @maya is one press and touches only the insert.** The chip goes;
  V1's clips, V1's track in project.json and the scene's cast are exactly as
  they were; one undo brings the chip back, one redo takes it away again.
- **A drag along the drop strip draws an insert over the stretch it covered**,
  one undo — and a plain press still opens the file picker.
- **The empty insert survives a reload**, with what it inherited less what was
  dropped — OpenVideo's import keeps no src-less clip but a Text, which is the
  failure an empty-src placeholder would have.
- **Rendering the insert sends its own context**: the request carries kai and
  not maya, the style and grade, V1's frame as the first frame once taken, and
  no continuation. The take lands in the insert, where it was, on its track —
  and the insert keeps its chips after it lands and after another reload.
"""
import base64
import json
import struct
import sys
import time
import urllib.request
import zlib

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8805"
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
        return json.loads(r.read())


def png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def pixel(png_bytes):
    pos, idat = 8, b""
    while pos < len(png_bytes):
        n = struct.unpack(">I", png_bytes[pos:pos + 4])[0]
        if png_bytes[pos + 4:pos + 8] == b"IDAT":
            idat += png_bytes[pos + 8:pos + 8 + n]
        pos += 12 + n
    return tuple(zlib.decompress(idat)[1:4])


SID = "scn20990101000000beef"
FACE = png(64, 64, (200, 120, 60))
TAKES = [{"jobId": f"vidinh{i}", "file": "clip.mp4", "line": line, "seconds": 3}
         for i, line in enumerate(["@maya and @kai at the window", "@maya turns to @kai",
                                   "@kai answers"], start=1)]
INTENT = {
    "scene": {
        "cast": [
            {"id": "c1", "kind": "subject", "name": "maya", "note": "the older sister",
             "retention": "fully_preserved", "refs": [{"fileId": "pmaya", "slots": ["image"]}]},
            {"id": "c2", "kind": "subject", "name": "kai", "note": "", "retention": "fully_preserved",
             "refs": []},
        ],
        "shots": [{"line": "@kai answers", "beats": None, "pills": [],
                   "say": {"who": [], "text": "", "lang": "English", "voice": "",
                           "carry": False, "cutoff": False, "offscreen": False}}],
        "sources": {},
        "style": "35mm, handheld",
        "grade": "teal shadows, warm skin",
    },
    "pool": {"pmaya": {"name": "maya.png", "kind": "image", "ref": "00-image.png"}},
    "takes": TAKES,
    "slots": {},
}

LANES = """
() => [...document.querySelectorAll('#edit-tracks .et-lane')].map((l) => ({
  track: l.dataset.track,
  clips: [...l.querySelectorAll('.et-clip')].map((c) => ({
    id: c.dataset.clip, slot: c.dataset.slot || '', job: c.dataset.job || '',
    left: parseFloat(c.style.left), width: parseFloat(c.style.width) })),
}))
"""

CHIPS = """
() => [...document.querySelectorAll('.et-inherited .et-inh')].map((c) => ({
  key: c.dataset.key, inherited: c.dataset.inherited || '', label: c.getAttribute('aria-label'),
  dashed: getComputedStyle(c).borderTopStyle, insert: c.closest('.et-inherited').dataset.insert }))
"""


def to_video(pg):
    if not pg.eval_on_selector("#c-video", "e => e.classList.contains('hide')"):
        return
    pg.click("#g-duration")
    pg.wait_for_selector(".menu button")
    pg.locator(".menu button").nth(1).click()
    pg.wait_for_timeout(500)


def open_page(pg):
    pg.goto(URL, wait_until="networkidle", timeout=60_000)
    pg.wait_for_timeout(800)
    to_video(pg)
    pg.wait_for_function(
        "() => document.querySelectorAll('#edit-tracks .et-lane[data-track=\"v1\"] .et-clip').length >= 3",
        timeout=40_000)
    pg.wait_for_selector("#edit-stage canvas", timeout=20_000)
    pg.wait_for_timeout(1200)


def lanes(pg):
    return pg.evaluate(LANES)


def lane_count(pg):
    return len(lanes(pg))


def wait_lanes(pg, n, timeout=15_000):
    try:
        pg.wait_for_function("(n) => document.querySelectorAll('#edit-tracks .et-lane').length === n",
                             arg=n, timeout=timeout)
        return True
    except Exception:
        return False


def seek_to(pg, x):
    b = pg.locator("#edit-tracks .et-body").bounding_box()
    pg.mouse.click(b["x"] + x, b["y"] + 3)
    pg.wait_for_timeout(300)


def saved(want, timeout=10):
    deadline = time.time() + timeout
    rec = {}
    while time.time() < deadline:
        rec = http(f"/api/scenes/{SID}")
        if want(rec):
            return rec
        time.sleep(0.3)
    return rec


def inserts_of(rec):
    out = {}
    for t in (rec.get("project") or {}).get("tracks") or []:
        for sid, ctx in (t.get("inserts") or {}).items():
            out[sid] = dict(ctx, track=t.get("id"), track_name=t.get("name"))
    return out


def v1_of(rec):
    p = rec.get("project") or {}
    t = next((t for t in p.get("tracks") or [] if t.get("id") == "v1"), {})
    return json.dumps({"track": t, "clips": {i: (p.get("clips") or {}).get(i) for i in t.get("clipIds") or []}},
                      sort_keys=True)


def stage_pixel(pg):
    box = pg.locator("#edit-stage").bounding_box()
    if not box:
        return None
    x, y = box["x"] + box["width"] * 0.7, box["y"] + box["height"] * 0.7
    return pixel(pg.screenshot(clip={"x": x, "y": y, "width": 1, "height": 1}))


def cast_names(rec):
    return [c.get("name") for c in ((rec.get("intent") or {}).get("scene") or {}).get("cast") or []]


with sync_playwright() as pw:
    b = pw.chromium.launch(channel="chrome")
    print(f"\n=== {URL} ===")
    probe = urllib.request.urlopen(URL + "/api/file/vidprobe/clip.mp4", timeout=60)
    check("the preview serves a real mp4 (ffmpeg on PATH)",
          probe.headers.get("Content-Type") == "video/mp4", probe.headers.get("Content-Type", ""))

    r = http(f"/api/scenes/{SID}", {"intent": INTENT,
                                    "refs": {"00-image.png": base64.b64encode(FACE).decode()}})
    check("the three-take scene is seeded", r.get("ok") is True, str(r)[:120])

    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    bodies: list[dict] = []
    pg.on("request", lambda q: bodies.append(json.loads(q.post_data or "{}"))
          if q.url.endswith("/api/video") and q.method == "POST" else None)
    open_page(pg)

    v1 = [c for l in lanes(pg) if l["track"] == "v1" for c in l["clips"]]
    v1.sort(key=lambda c: c["left"])
    check("V1 holds the three takes end to end", len(v1) == 3, str(v1)[:200])
    slot2 = v1[1]["slot"] if len(v1) == 3 else ""
    rec0 = saved(lambda r: bool((r.get("project") or {}).get("tracks")))
    v1_before = v1_of(rec0)
    lanes0 = lane_count(pg)

    # ---- I at 0:04.5 ----------------------------------------------------
    seek_to(pg, 4.5 * PX)
    px_before = stage_pixel(pg)
    pg.focus("#edit-play")
    pg.keyboard.press("i")
    check("I makes a lane", wait_lanes(pg, lanes0 + 1), str(lane_count(pg)))
    ls = lanes(pg)
    ins_lane = ls[1] if len(ls) > 1 else {"clips": [], "track": ""}
    ins = ins_lane["clips"][0] if ins_lane["clips"] else {}
    check("the insert sits under V1, at the playhead, three seconds long",
          ls[0]["track"] == "v1" and abs(ins.get("left", -1) - 4.5 * PX) < 1.5
          and abs(ins.get("width", 0) - 3 * PX) < 1.5, str(ins))
    rec = saved(lambda r: bool(inserts_of(r)))
    got = inserts_of(rec)
    ctx1 = got.get(ins.get("slot", ""), {})
    check("project.json records the insert on its own track, V2", ctx1.get("track_name") == "V2",
          str({k: (v.get("track_name"), v.get("from")) for k, v in got.items()}))
    check("it covers the V1 slot under 0:04.5 — the second take", bool(slot2) and ctx1.get("from") == slot2,
          f"{ctx1.get('from')} vs {slot2}")
    check("it copied both cast members, the style and the grade",
          [c.get("name") for c in ctx1.get("cast") or []] == ["maya", "kai"]
          and ctx1.get("style") == "35mm, handheld" and ctx1.get("grade") == "teal shadows, warm skin",
          str({k: ctx1.get(k) for k in ("style", "grade")}))
    clip = ((rec.get("project") or {}).get("clips") or {}).get(ins.get("id", ""), {})
    check("the empty insert is a Text clip at zero opacity, named for what it is",
          clip.get("type") == "Text" and (clip.get("transform") or {}).get("opacity") == 0
          and (clip.get("metadata") or {}).get("insert") is True, str(clip.get("type")))

    chips = pg.evaluate(CHIPS)
    keys = [c["key"] for c in chips]
    check("the insert shows each inherited item on itself",
          keys[:2] == [f"cast:{c['id']}" for c in ctx1.get("cast") or []][:2]
          and "style" in keys and "grade" in keys, str(keys))
    check("every chip is marked inherited, and says from where",
          bool(chips) and all(c["inherited"] == "v1" and c["dashed"] == "dashed"
                              and "inherited from V1 at 0:04.5" in (c["label"] or "") for c in chips),
          str([(c["key"], c["dashed"]) for c in chips])[:200])
    check("maya's chip is her face", pg.evaluate(
        "() => !!document.querySelector('.et-inherited .et-inh[data-key^=\"cast:\"] img')"))
    pg.wait_for_timeout(800)
    px_after = stage_pixel(pg)
    check("the empty insert draws nothing: the stage still shows V1 there",
          px_before is not None and px_before == px_after, f"{px_before} → {px_after}")

    # ---- drop @maya -----------------------------------------------------
    maya = next((c for c in chips if "@maya" in (c["label"] or "")), None)
    rail_before = pg.evaluate("() => document.querySelectorAll('.chip[data-cast]').length")
    v1_dom_before = [l for l in lanes(pg) if l["track"] == "v1"]
    if maya:
        pg.click(f'.et-inh[data-key="{maya["key"]}"]')
    pg.wait_for_timeout(300)
    keys2 = [c["key"] for c in pg.evaluate(CHIPS)]
    check("one press drops @maya from the insert", maya is not None and maya["key"] not in keys2
          and len(keys2) == len(keys) - 1, str(keys2))
    check("V1 on the timeline is unchanged", [l for l in lanes(pg) if l["track"] == "v1"] == v1_dom_before)
    check("the scene's cast is unchanged on the rail",
          pg.evaluate("() => document.querySelectorAll('.chip[data-cast]').length") == rail_before,
          str(rail_before))
    rec = saved(lambda r: [c.get("name") for c in inserts_of(r).get(ins.get("slot", ""), {}).get("cast") or []]
                == ["kai"])
    check("project.json: the insert has kai alone",
          [c.get("name") for c in inserts_of(rec).get(ins.get("slot", ""), {}).get("cast") or []] == ["kai"])
    check("project.json: V1's track and clips are byte-for-byte as before", v1_of(rec) == v1_before)
    check("the scene's intent still casts maya and kai", cast_names(rec) == ["maya", "kai"], str(cast_names(rec)))

    pg.evaluate("() => window.__edit.undo()")
    pg.wait_for_timeout(300)
    check("one undo brings @maya back", maya is not None and maya["key"] in [c["key"] for c in pg.evaluate(CHIPS)])
    pg.evaluate("() => window.__edit.redo()")
    pg.wait_for_timeout(300)
    check("and redo drops her again", maya is not None and maya["key"] not in [c["key"] for c in pg.evaluate(CHIPS)])

    # ---- drawing one on the strip --------------------------------------
    n = lane_count(pg)
    zb = pg.locator("#edit-drop").bounding_box()
    y = zb["y"] + zb["height"] / 2
    pg.mouse.move(zb["x"] + 0.5 * PX, y)
    pg.mouse.down()
    pg.mouse.move(zb["x"] + 1.5 * PX, y, steps=4)
    pg.mouse.move(zb["x"] + 2.5 * PX, y, steps=4)
    drawn_label = pg.inner_text("#edit-drop .et-drop-say")
    pg.mouse.up()
    check("while drawing, the strip says what it will make", "Empty insert on V3" in drawn_label, drawn_label)
    check("a drag along the strip draws an insert", wait_lanes(pg, n + 1), str(lane_count(pg)))
    drawn = [c for l in lanes(pg)[1:] for c in l["clips"] if abs(c["left"] - 0.5 * PX) < 2]
    check("over the stretch it covered", len(drawn) == 1 and abs(drawn[0]["width"] - 2 * PX) < 2, str(drawn))
    pg.wait_for_timeout(300)
    check("and no file picker opened for it", not pg.evaluate(
        "() => !!document.querySelector('#edit-drop-error')"))
    pg.evaluate("() => window.__edit.undo()")
    check("one undo takes the drawn insert away", wait_lanes(pg, n), str(lane_count(pg)))

    # ---- the empty insert survives a reload ------------------------------
    saved(lambda r: len(inserts_of(r)) == 1
          and [c.get("name") for c in next(iter(inserts_of(r).values())).get("cast") or []] == ["kai"])
    open_page(pg)
    ls = lanes(pg)
    back = [c for l in ls[1:] for c in l["clips"] if c["slot"] == ins.get("slot")]
    check("after a reload the empty insert is where it was",
          len(back) == 1 and abs(back[0]["left"] - 4.5 * PX) < 1.5, str(back))
    keys3 = [c["key"] for c in pg.evaluate(CHIPS)]
    check("with what it inherited, less @maya", "style" in keys3 and "grade" in keys3
          and len([k for k in keys3 if k.startswith("cast:")]) == 1, str(keys3))

    # ---- V1's frame, and rendering it ------------------------------------
    pg.click(f'.et-inherited[data-insert="{ins.get("slot")}"] [data-offer="frame"]')
    pg.wait_for_timeout(300)
    check("V1's frame, taken, is an inherited chip like the rest",
          "frame" in [c["key"] for c in pg.evaluate(CHIPS) if c["inherited"] == "v1"])
    pg.click("#prompt")
    pg.fill("#prompt", "close on @kai's hands on the table")
    pg.wait_for_timeout(200)
    bodies.clear()
    pg.click(f'#edit-tracks .et-clip[data-slot="{ins.get("slot")}"] [data-act="render"]')
    try:
        pg.wait_for_function(
            "(s) => { const c = document.querySelector(`#edit-tracks .et-clip[data-slot=\"${s}\"]`);"
            " return c && c.dataset.job }", arg=ins.get("slot"), timeout=40_000)
        landed = True
    except Exception:
        landed = False
    body = bodies[-1] if bodies else {}
    cast = [c.get("name") for c in ((body.get("scene") or {}).get("cast") or [])]
    check("the render sends the insert's cast — kai, not maya", cast == ["kai"], str(cast))
    check("with the inherited style and grade",
          (body.get("scene") or {}).get("style") == "35mm, handheld"
          and (body.get("scene") or {}).get("grade") == "teal shadows, warm skin")
    check("V1's frame as its first frame, and no continuation",
          isinstance(body.get("first_frame"), str) and len(body.get("first_frame") or "") > 1000
          and not body.get("continue_from"), str(len(body.get("first_frame") or "")))
    check("the take lands in the insert", landed)
    ls = lanes(pg)
    filled = [c for l in ls[1:] for c in l["clips"] if c["slot"] == ins.get("slot")]
    check("where it was, on its own track", len(filled) == 1 and abs(filled[0]["left"] - 4.5 * PX) < 1.5
          and [l["track"] for l in ls if l["clips"] and l["clips"][0]["slot"] == ins.get("slot")] == [ins_lane["track"]],
          str(filled))
    check("V1 still holds its three takes",
          len([c for l in ls if l["track"] == "v1" for c in l["clips"]]) == 3)
    keys4 = [c["key"] for c in pg.evaluate(CHIPS)]
    check("the filled insert keeps its chips", "style" in keys4 and "frame" in keys4, str(keys4))

    saved(lambda r: any(c.get("type") == "Video" and (c.get("metadata") or {}).get("slotId") == ins.get("slot")
                        for c in ((r.get("project") or {}).get("clips") or {}).values()))
    open_page(pg)
    keys5 = [c["key"] for c in pg.evaluate(CHIPS)]
    filled = [c for l in lanes(pg)[1:] for c in l["clips"] if c["slot"] == ins.get("slot")]
    check("after another reload the filled insert and its context are back",
          len(filled) == 1 and filled[0]["job"] and "frame" in keys5 and "grade" in keys5, str(keys5))

    check("no uncaught errors", not errors, "; ".join(errors[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

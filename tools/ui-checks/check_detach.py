"""
A take's soundtrack travels with it until it is dragged onto an A track, and
one undo links it again.

    python3 tools/ui-checks/check_detach.py                  # :8809
    python3 tools/ui-checks/check_detach.py 8809             # a port
    python3 tools/ui-checks/check_detach.py http://host:5173 # a URL

Driven against `preview_ui.py`, whose `/api/file` serves a real MP4 per take —
picture and a sine tone, as H3's takes carry picture and sound — when ffmpeg
is on the PATH. The drag is a real pointer drag on the page; the export is
OpenVideo's own Compositor in Chrome, measured afterwards with ffprobe/ffmpeg
when they are installed.

What it holds, and the failure each one is for:

- **Attached, the sound is the clip's.** A take lands with a sound strip, no
  Audio clip anywhere, and nothing silencing its Video — so a trim or a move of
  it is a trim or a move of its sound, with nothing to keep in step.
- **Dragging the strip below the last track detaches it onto a new A track**:
  an Audio clip with the take's own src and timing, `audio: false` (what the
  export reads) and `muted: true` (what the stage's video element reads) on the
  Video, each naming the other in `metadata.linkedTo` — in project.json.
- **The undo control names it** ("Undo detach"), and one undo links it again:
  the A track and the Audio clip gone, the Video's sound back and unmarked.
- **D on the focused clip detaches too**, and the D does not leak into the
  prompt (the page routes stray letters there).
- **Dragged onto an A track that is free there, it lands on that track** — no
  new lane.
- **Detached, the two are independent**: a trim of the Video re-times V1 and
  leaves the Audio clip exactly where it was.
- **The export carries the detached sound once, not twice**: the MP4 has an
  audio stream, and its loudness matches the attached export's (a Video still
  playing its own sound under the detached one would be ~6 dB louder).
"""
import base64
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from io import BytesIO
from pathlib import Path

from playwright.sync_api import sync_playwright

ARG = sys.argv[1] if len(sys.argv) > 1 else "8809"
URL = f"http://localhost:{ARG}" if ARG.isdigit() else ARG.rstrip("/")

fails: list[str] = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(f"{label} {detail}".strip())


def http(path):
    with urllib.request.urlopen(URL + path, timeout=30) as r:
        return r.status, dict(r.headers), r.read()


def get_json(path):
    return json.loads(http(path)[2])


def wav(seconds=1.0, rate=22050):
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", (i % 200) * 40 - 4000)
                               for i in range(int(seconds * rate))))
    return buf.getvalue()


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
  clips: [...l.querySelectorAll('.et-clip')].map((c) => ({ id: c.dataset.clip, sound: c.dataset.sound || '' })),
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


def wait_lanes(pg, n, timeout=15_000):
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


def undo_title(pg):
    return pg.get_attribute("#edit-undo-go", "title") or ""


def clips_of(proj, kind):
    return [c for c in (proj.get("clips") or {}).values() if c.get("type") == kind]


def drag_strip(pg, clip_id, to):
    """A real pointer drag from the clip's sound strip to the point `to`."""
    strip = pg.locator(f'.et-sound[data-sound-strip="{clip_id}"]')
    box = strip.bounding_box()
    if not box:
        return False
    x, y = box["x"] + box["width"] / 3, box["y"] + box["height"] / 2
    pg.mouse.move(x, y)
    pg.mouse.down()
    for i in range(1, 9):
        pg.mouse.move(x + (to[0] - x) * i / 8, y + (to[1] - y) * i / 8)
        pg.wait_for_timeout(30)
    label = pg.evaluate("() => document.querySelector('.et-sound-carry')?.textContent || ''")
    pg.mouse.up()
    return label


# Every media element the Studio plays through, recorded as it is played, so
# what is audible on the stage can be read: the Studio builds its <video> and
# <audio> elements off-document, where no selector reaches them.
MEDIA_SPY = """
(() => {
  const seen = new Set();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { seen.add(this); return play.call(this); };
  window.__audible = () => [...seen]
    .filter((m) => !m.paused)
    .map((m) => ({ tag: m.tagName, audible: !m.muted && m.volume > 0 }));
})();
"""


def audible_while_playing(pg):
    """What is playing on the stage, and whether each one can be heard."""
    pg.click("#edit-play")
    pg.wait_for_timeout(900)
    heard = pg.evaluate("() => window.__audible()")
    pg.click("#edit-play")
    pg.wait_for_timeout(300)
    return heard


def export_mp4(pg, dest):
    """Export the cut and return the MP4's path, or None."""
    def exports():
        return [i for i in get_json("/api/gallery")["items"] if i["job_id"].startswith("exp")]
    before = {i["job_id"] for i in exports()}
    try:
        pg.wait_for_function("() => { const b = document.querySelector('#export-go');"
                             " return b && !b.disabled }", timeout=40_000)
        pg.click("#export-go")
        pg.wait_for_function(
            "() => (document.querySelector('#export-done')?.textContent || '').includes('in the gallery')",
            timeout=120_000)
    except Exception as exc:
        print("   ", exc)
        return None
    new = [i for i in exports() if i["job_id"] not in before]
    pg.click("#export-done")
    if not new:
        return None
    _, _, body = http(f"/api/file/{new[0]['job_id']}/{new[0]['files'][0]}")
    Path(dest).write_bytes(body)
    return dest


def audio_facts(path):
    """(has an audio stream, its mean volume in dB) — or None without ffmpeg."""
    if not (shutil.which("ffprobe") and shutil.which("ffmpeg")):
        return None
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
                            "stream=codec_type", "-of", "csv=p=0", path],
                           capture_output=True, text=True)
    has = "audio" in probe.stdout
    vol = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-map", "0:a:0", "-t", "1.5",
                          "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", vol.stderr)
    return has, float(m.group(1)) if m else None


with sync_playwright() as pw, tempfile.TemporaryDirectory() as tmp:
    b = pw.chromium.launch(channel="chrome")
    print(f"\n=== {URL} ===")
    probe = urllib.request.urlopen(URL + "/api/file/vidprobe/clip.mp4", timeout=60)
    check("the preview serves a real mp4 (ffmpeg on PATH)",
          probe.headers.get("Content-Type") == "video/mp4", probe.headers.get("Content-Type", ""))

    ctx = b.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
    ctx.add_init_script(MEDIA_SPY)
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
    lanes0 = lane_count(pg)
    vid = pg.get_attribute('#edit-tracks .et-lane[data-track="v1"] .et-clip', "data-clip") or ""

    # ---- attached ---------------------------------------------------------
    proj = saved_project(sid, lambda p: bool(clips_of(p, "Video")))
    v = (proj.get("clips") or {}).get(vid) or {}
    check("a landed take carries its own sound: no Audio clip, nothing silencing the Video",
          not clips_of(proj, "Audio") and v.get("audio") is not False and not v.get("muted"),
          json.dumps({k: v.get(k) for k in ("type", "audio", "muted")}))
    check("and a sound strip along its bottom edge",
          pg.locator(f'.et-sound[data-sound-strip="{vid}"]').count() == 1)
    heard = audible_while_playing(pg)
    check("playing, the stage's sound is the take's own video",
          [h["tag"] for h in heard if h["audible"]] == ["VIDEO"], str(heard))
    attached_mp4 = export_mp4(pg, f"{tmp}/attached.mp4")

    # ---- drag below the last track ---------------------------------------
    drop = pg.locator("#edit-drop").bounding_box()
    said = drag_strip(pg, vid, (drop["x"] + 40, drop["y"] + drop["height"] / 2)) if drop else False
    check("the ghost says where the sound will land", "new A1" in (said or ""), repr(said))
    check("dropped below the last track, the sound makes an A track", wait_lanes(pg, lanes0 + 1),
          str(lane_count(pg)))
    lanes = pg.evaluate(LANES)
    a_lane = lanes[-1] if lanes else {}
    check("an A lane at the bottom, holding one clip",
          a_lane.get("audio") and len(a_lane.get("clips") or []) == 1, str(lanes)[:200])
    check("the take's strip is gone — its sound is on the A track now",
          pg.locator(f'.et-sound[data-sound-strip="{vid}"]').count() == 0
          and pg.get_attribute(f'.et-clip[data-clip="{vid}"]', "data-sound") == "detached")
    proj = saved_project(sid, lambda p: bool(clips_of(p, "Audio")))
    v = (proj.get("clips") or {}).get(vid) or {}
    a = (clips_of(proj, "Audio") or [{}])[0]
    check("project.json: the Video is silent — audio:false for the export, muted for the stage",
          v.get("audio") is False and v.get("muted") is True,
          json.dumps({k: v.get(k) for k in ("audio", "muted")}))
    check("an Audio clip with the take's own src and timing",
          a.get("src") == v.get("src") and (a.get("timing") or {}).get("display") == (v.get("timing") or {}).get("display")
          and (a.get("timing") or {}).get("trim") == (v.get("timing") or {}).get("trim"),
          f"{a.get('src')} {(a.get('timing') or {}).get('display')} vs {(v.get('timing') or {}).get('display')}")
    check("linked both ways by metadata.linkedTo",
          (a.get("metadata") or {}).get("linkedTo") == vid and (v.get("metadata") or {}).get("linkedTo") == a.get("id"),
          f"{(a.get('metadata') or {}).get('linkedTo')} / {(v.get('metadata') or {}).get('linkedTo')}")
    check("and never the slot's id, so the slot's controls still find the Video",
          "slotId" not in (a.get("metadata") or {}), str(a.get("metadata")))
    tracks = proj.get("tracks") or []
    check("the A track is named A1 and sits after V1",
          bool(tracks) and tracks[-1].get("name") == "A1" and tracks[-1].get("type") == "audio"
          and tracks[-1].get("clipIds") == [a.get("id")], str([(t.get("id"), t.get("name")) for t in tracks]))
    check("the undo control names it", undo_title(pg).startswith("Undo detach"), undo_title(pg))
    pg.wait_for_timeout(500)
    heard = audible_while_playing(pg)
    check("playing, the stage sounds the A track once — the picture's own sound silent",
          [h["tag"] for h in heard if h["audible"]] == ["AUDIO"], str(heard))

    # ---- the export -------------------------------------------------------
    detached_mp4 = export_mp4(pg, f"{tmp}/detached.mp4")
    check("the cut exports with the sound detached", bool(detached_mp4))
    facts_a = audio_facts(attached_mp4) if attached_mp4 else None
    facts_d = audio_facts(detached_mp4) if detached_mp4 else None
    if facts_a is None or facts_d is None:
        print("   (ffmpeg/ffprobe missing or an export failed — the export's sound was not measured)")
    else:
        check("the exported MP4 has an audio stream", facts_d[0], str(facts_d))
        check("and it is the sound once — as loud as the attached export, not doubled",
              facts_a[1] is not None and facts_d[1] is not None and abs(facts_a[1] - facts_d[1]) < 3.0,
              f"attached {facts_a[1]} dB, detached {facts_d[1]} dB")

    # ---- independent ------------------------------------------------------
    a_before = json.dumps((a.get("timing") or {}), sort_keys=True)
    handle = pg.locator(f'.et-clip[data-clip="{vid}"] .et-trim.out')
    handle.focus()
    pg.keyboard.press("Shift+ArrowLeft")
    proj = saved_project(sid, lambda p: ((p.get("clips") or {}).get(vid) or {}).get("timing", {})
                         .get("display", {}).get("to") != (v.get("timing") or {}).get("display", {}).get("to"))
    v2 = (proj.get("clips") or {}).get(vid) or {}
    a2 = next((c for c in clips_of(proj, "Audio") if c.get("id") == a.get("id")), {})
    check("a trim of the Video re-times it", (v2.get("timing") or {}).get("display") != (v.get("timing") or {}).get("display"),
          f"{(v.get('timing') or {}).get('display')} -> {(v2.get('timing') or {}).get('display')}")
    check("and leaves the detached sound exactly where it was",
          json.dumps((a2.get("timing") or {}), sort_keys=True) == a_before,
          f"{(a2.get('timing') or {}).get('display')}")
    pg.evaluate("() => window.__edit.undo()")  # the trim
    pg.wait_for_timeout(300)
    check("undoing the trim leaves the detach as the next undo", undo_title(pg).startswith("Undo detach"),
          undo_title(pg))

    # ---- one undo re-links --------------------------------------------------
    pg.evaluate("() => window.__edit.undo()")
    check("one undo takes the A track and the Audio clip away", wait_lanes(pg, lanes0), str(lane_count(pg)))
    proj = saved_project(sid, lambda p: not clips_of(p, "Audio"))
    v = (proj.get("clips") or {}).get(vid) or {}
    check("and the Video has its sound again, unmarked",
          not clips_of(proj, "Audio") and v.get("audio") is not False and not v.get("muted")
          and "linkedTo" not in (v.get("metadata") or {}),
          json.dumps({k: v.get(k) for k in ("audio", "muted", "metadata")}))
    check("its strip is back", pg.locator(f'.et-sound[data-sound-strip="{vid}"]').count() == 1)
    pg.wait_for_timeout(500)
    heard = audible_while_playing(pg)
    # The failure this is for: an undo by update left the stage's video muted,
    # because the Studio copies `muted` only when the restored clip defines it.
    check("playing again, the take's own video is heard — re-linked on the stage too",
          [h["tag"] for h in heard if h["audible"]] == ["VIDEO"], str(heard))

    # ---- the key ------------------------------------------------------------
    prompt_before = pg.input_value("#prompt")
    pg.focus(f'.et-clip[data-clip="{vid}"]')
    pg.keyboard.press("d")
    check("D on the focused clip detaches its sound onto a new A track", wait_lanes(pg, lanes0 + 1),
          str(lane_count(pg)))
    check("and the D stays out of the prompt", pg.input_value("#prompt") == prompt_before,
          repr(pg.input_value("#prompt")))
    check("the undo control names it", undo_title(pg).startswith("Undo detach"), undo_title(pg))
    pg.click("#edit-undo-go")
    check("the on-surface undo re-links it", wait_lanes(pg, lanes0), str(lane_count(pg)))
    pg.click("#edit-redo-go")
    check("and redo detaches it again", wait_lanes(pg, lanes0 + 1), str(lane_count(pg)))
    pg.evaluate("() => window.__edit.undo()")
    wait_lanes(pg, lanes0)

    # ---- onto an existing A track -------------------------------------------
    # Music dropped after the take, so A1 is free over the take's stretch.
    end_px = pg.evaluate(f"""() => {{ const c = document.querySelector('.et-clip[data-clip="{vid}"]');
      return c.offsetLeft + c.offsetWidth }}""")
    said = pg.evaluate(DROP, {"sel": "#edit-drop", "name": "room tone.wav", "type": "audio/wav",
                              "b64": base64.b64encode(wav()).decode(), "x": end_px + 15})
    check("music dropped after the take makes A1", said == "ok" and wait_lanes(pg, lanes0 + 1),
          f"{said} {lane_count(pg)}")
    music_title = undo_title(pg)
    check("and the history does not call that drop a detach", not music_title.startswith("Undo detach"),
          music_title)
    a1 = pg.locator("#edit-tracks .et-lane.audio").first.bounding_box()
    said = drag_strip(pg, vid, (a1["x"] + 20, a1["y"] + a1["height"] / 2)) if a1 else False
    check("the ghost names A1", "onto A1" in (said or ""), repr(said))
    pg.wait_for_timeout(800)
    lanes = pg.evaluate(LANES)
    audio_lanes = [l for l in lanes if l["audio"]]
    check("dragged onto a free A1, the sound lands there — no new lane",
          len(lanes) == lanes0 + 1 and len(audio_lanes) == 1 and len(audio_lanes[0]["clips"]) == 2,
          str(lanes)[:240])
    pg.evaluate("() => window.__edit.undo()")
    pg.wait_for_timeout(600)
    lanes = pg.evaluate(LANES)
    audio_lanes = [l for l in lanes if l["audio"]]
    check("one undo takes only the sound back off A1",
          len(audio_lanes) == 1 and len(audio_lanes[0]["clips"]) == 1, str(lanes)[:240])

    # A Video clip built again by the Studio (the detach's remove-and-add, as a
    # take swap's) gets a fresh Pixi VideoSource whose `autoPlay` calls
    # `video.play()` without a catch, and the engine pauses the clip in the same
    # tick. The rejection is the browser saying that play was cancelled — which
    # is the intent — and it comes from inside the engine, so it is let through
    # here by its exact words and nothing else is.
    ENGINE_NOISE = "The play() request was interrupted by a call to pause()"
    real = [e for e in errors if ENGINE_NOISE not in e]
    check("no uncaught errors", not real, "; ".join(real[:3]))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
for f in fails:
    print("  -", f)
sys.exit(1 if fails else 0)

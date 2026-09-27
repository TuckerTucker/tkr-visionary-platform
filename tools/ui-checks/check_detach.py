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
- **A detached slot stays detached across a new take.** ↻ and ‹ › land the
  new take silent and swap the linked Audio clip to its file — one
  soundtrack, not the new take's attached sound over the old take's detached
  one — and one undo puts back the old take and the old sound together. A
  new take longer than its sound's A track has room for moves the sound to a
  free A track, whole, rather than overlapping or clamping it.
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


# How much of a clip's sound strip a pointer can reach, 0..1 — the rest is
# under the slot's controls. A short clip with two takes used to draw its
# ‹ n / N › over all but 16px of it, and this check pressed the one sliver left.
REACHABLE = """
(id) => {
  const s = document.querySelector(`.et-sound[data-sound-strip="${id}"]`);
  if (!s) return null;
  const r = s.getBoundingClientRect();
  const y = r.top + r.height / 2;
  let hit = 0;
  for (let x = r.left + 0.5; x < r.right; x += 1) {
    if (document.elementFromPoint(x, y)?.closest('.et-sound') === s) hit += 1;
  }
  return hit / Math.max(1, Math.floor(r.width));
}
"""


def drag_strip(pg, clip_id, to, at=1 / 3):
    """A real pointer drag from the clip's sound strip to the point `to`,
    pressed `at` of the way along it."""
    strip = pg.locator(f'.et-sound[data-sound-strip="{clip_id}"]')
    box = strip.bounding_box()
    if not box:
        return False
    y = box["y"] + box["height"] / 2
    x = box["x"] + box["width"] * at
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


def take_sounds(proj):
    """Audio clips playing a take's file — every soundtrack the slots have,
    and nothing a person dropped (those play a scene file)."""
    return [c for c in clips_of(proj, "Audio") if "/api/file/" in (c.get("src") or "")]


def job_of(proj, clip_id):
    return (((proj.get("clips") or {}).get(clip_id) or {}).get("metadata") or {}).get("jobId")


def track_of(proj, clip_id):
    return next((t for t in proj.get("tracks") or [] if clip_id in (t.get("clipIds") or [])), {})


def one_soundtrack(label, proj, vid, sound_id, job):
    """The slot plays take `job`, silent, and its one soundtrack is `sound_id`
    playing that take's file under it, linked both ways."""
    v = (proj.get("clips") or {}).get(vid) or {}
    sounds = take_sounds(proj)
    a = sounds[0] if len(sounds) == 1 else {}
    vt, at = v.get("timing") or {}, a.get("timing") or {}
    check(f"{label}: the slot plays take {job}", (v.get("metadata") or {}).get("jobId") == job,
          str((v.get("metadata") or {}).get("jobId")))
    check(f"{label}: one soundtrack, not two", len(sounds) == 1 and a.get("id") == sound_id,
          str([(c.get("id"), c.get("src")) for c in sounds]))
    check(f"{label}: the Video is still silent — audio:false and muted",
          v.get("audio") is False and v.get("muted") is True,
          json.dumps({k: v.get(k) for k in ("audio", "muted")}))
    check(f"{label}: the sound plays the take's own file",
          bool(a) and a.get("src") == v.get("src") and job in (a.get("src") or "")
          and (a.get("metadata") or {}).get("jobId") == job, f"{a.get('src')} vs {v.get('src')}")
    check(f"{label}: its timing is the take's — display and trim",
          at.get("display") == vt.get("display") and at.get("trim") == vt.get("trim"),
          f"{at.get('display')} {at.get('trim')} vs {vt.get('display')} {vt.get('trim')}")
    check(f"{label}: still linked both ways",
          (a.get("metadata") or {}).get("linkedTo") == vid and (v.get("metadata") or {}).get("linkedTo") == sound_id,
          f"{(a.get('metadata') or {}).get('linkedTo')} / {(v.get('metadata') or {}).get('linkedTo')}")
    return v, a


def sound_clips(pg):
    """The ids of every clip on an A lane, as drawn."""
    return {c["id"] for lane in pg.evaluate(LANES) if lane["audio"] for c in lane["clips"]}


def new_sound(pg, sid, had):
    """The one A-lane clip that was not there before, and project.json once it
    holds it — read off the page, because the saver is debounced and a stale
    project.json can still hold an earlier detach's sound."""
    deadline = time.time() + 10
    new = set()
    while time.time() < deadline:
        new = sound_clips(pg) - had
        if new:
            break
        time.sleep(0.2)
    if len(new) != 1:
        return None, {}
    sid_ = next(iter(new))
    return sid_, saved_project(sid, lambda p: [c.get("id") for c in take_sounds(p)] == [sid_])


def stays_detached(pg, sid, vid):
    """A detached slot stays detached across a re-render and a take step.

    The failure: the new take landed with its own sound attached, and the old
    Audio clip stayed on its A track pointing at the slot — two soundtracks,
    one for a take no longer in the cut. Now the new take lands silent and the
    linked Audio clip is swapped to its file, in the same undo entry.
    """
    print("  -- a detached slot stays detached --")
    clip_sel = f'#edit-tracks .et-clip[data-clip="{vid}"]'
    slot = pg.get_attribute(clip_sel, "data-slot") or ""
    job1 = pg.get_attribute(clip_sel, "data-job") or ""
    lanes1 = lane_count(pg)

    had = sound_clips(pg)
    pg.focus(clip_sel)
    pg.keyboard.press("d")
    sound_id, proj = new_sound(pg, sid, had)
    sounds = take_sounds(proj)
    check("D detaches onto the free A1 — no new lane",
          len(sounds) == 1 and lane_count(pg) == lanes1, f"{len(sounds)} {lane_count(pg)}/{lanes1}")
    if not sound_id or len(sounds) != 1:
        return
    before_timing = json.dumps(sounds[0].get("timing"), sort_keys=True)

    # ---- ↻ re-renders the slot ---------------------------------------------
    write(pg, "")  # an empty prompt renders the slot's own sentence again
    pg.click(f'#edit-tracks .et-clip[data-slot="{slot}"] [data-act="render"]')
    wait_job(pg, slot, job1)
    job2 = pg.get_attribute(clip_sel, "data-job") or ""
    proj = saved_project(sid, lambda p: job_of(p, vid) == job2
                         and all(job2 in (c.get("src") or "") for c in take_sounds(p)))
    one_soundtrack("after ↻", proj, vid, sound_id, job2)
    check("after ↻: the sound stays on its A track",
          track_of(proj, sound_id).get("name") == "A1", str(track_of(proj, sound_id).get("name")))
    check("after ↻: the history names the render", undo_title(pg).startswith("Undo render"), undo_title(pg))
    pg.wait_for_timeout(500)
    heard = audible_while_playing(pg)
    check("after ↻: playing, the stage sounds the A track — the new take's picture silent",
          [h["tag"] for h in heard if h["audible"]] == ["AUDIO"], str(heard))

    # ---- ‹ back to the first take --------------------------------------------
    pg.click(f'#edit-tracks .et-clip[data-slot="{slot}"] [data-act="prev"]')
    wait_job(pg, slot, job2)
    proj = saved_project(sid, lambda p: job_of(p, vid) == job1
                         and all(job1 in (c.get("src") or "") for c in take_sounds(p)))
    one_soundtrack("after ‹", proj, vid, sound_id, job1)

    # ---- one undo per edit ---------------------------------------------------
    pg.evaluate("() => window.__edit.undo()")  # the ‹ step
    wait_job(pg, slot, job1)
    pg.evaluate("() => window.__edit.undo()")  # the render
    wait_job(pg, slot, job2)
    proj = saved_project(sid, lambda p: job_of(p, vid) == job1
                         and all(job1 in (c.get("src") or "") for c in take_sounds(p)))
    _, a = one_soundtrack("one undo after ↻", proj, vid, sound_id, job1)
    check("one undo after ↻: the old sound exactly as it was",
          json.dumps(a.get("timing"), sort_keys=True) == before_timing,
          f"{(a.get('timing') or {}).get('display')}")
    check("and the next undo is the detach", undo_title(pg).startswith("Undo detach"), undo_title(pg))
    pg.evaluate("() => window.__edit.undo()")  # the detach
    proj = saved_project(sid, lambda p: not take_sounds(p))
    v = (proj.get("clips") or {}).get(vid) or {}
    check("undoing the detach too: the take's own sound, nothing on the A track",
          not take_sounds(proj) and v.get("audio") is not False and not v.get("muted"),
          json.dumps({k: v.get(k) for k in ("audio", "muted")}))

    # ---- a longer take than its sound's track has room for ---------------------
    # The slot's picture trimmed three frames short, its sound detached onto a new
    # A track with music right after it, then the full-length take chosen: the
    # sound would overlap the music, so it goes to the first A track free for
    # the whole take (A1, whose room tone starts after 3 s) — never clamped.
    handle = pg.locator(f"{clip_sel} .et-trim.out")
    handle.focus()
    for _ in range(3):
        pg.keyboard.press("ArrowLeft")
    pg.wait_for_timeout(500)
    end_px = pg.evaluate(f"""() => {{ const c = document.querySelector('{clip_sel}');
      return c.offsetLeft + c.offsetWidth }}""")
    said = pg.evaluate(DROP, {"sel": "#edit-drop", "name": "music.wav", "type": "audio/wav",
                              "b64": base64.b64encode(wav(0.8)).decode(), "x": end_px + 1})
    check("music dropped after the trimmed take makes A2", said == "ok" and wait_lanes(pg, lanes1 + 1),
          f"{said} {lane_count(pg)}")
    had = sound_clips(pg)
    a2 = pg.locator("#edit-tracks .et-lane.audio").nth(1).bounding_box()
    # Two takes on a 3-second clip: the stepper sits in the top row, so the
    # whole strip is there to press, the middle included.
    reach = pg.evaluate(REACHABLE, vid)
    check("a short clip with two takes keeps its whole sound strip reachable",
          reach is not None and reach > 0.95, str(reach))
    said = drag_strip(pg, vid, (a2["x"] + 20, a2["y"] + a2["height"] / 2), at=1 / 2) if a2 else False
    check("the ghost names A2", "onto A2" in (said or ""), repr(said))
    sound_id, proj = new_sound(pg, sid, had)
    sounds = take_sounds(proj)
    if not sound_id or len(sounds) != 1:
        check("the sound detached onto A2", False, str(sounds))
        return
    before_timing = json.dumps(sounds[0].get("timing"), sort_keys=True)
    check("the sound is on A2, beside the music", track_of(proj, sound_id).get("name") == "A2",
          str(track_of(proj, sound_id).get("name")))
    lanes2 = lane_count(pg)

    pg.click(f'#edit-tracks .et-clip[data-slot="{slot}"] [data-act="next"]')
    wait_job(pg, slot, job1)
    proj = saved_project(sid, lambda p: job_of(p, vid) == job2
                         and all(job2 in (c.get("src") or "") for c in take_sounds(p)))
    _, a = one_soundtrack("after › onto a longer take", proj, vid, sound_id, job2)
    on = track_of(proj, sound_id)
    clips = proj.get("clips") or {}
    d = (a.get("timing") or {}).get("display") or {}
    overlaps = [c for cid in on.get("clipIds") or [] if cid != sound_id
                for c in [clips.get(cid) or {}]
                if not ((c.get("timing") or {}).get("display", {}).get("to", 0) <= d.get("from", 0)
                        or (c.get("timing") or {}).get("display", {}).get("from", 0) >= d.get("to", 0))]
    check("the sound moved to the free A1 rather than overlap the music, whole",
          on.get("name") == "A1" and not overlaps and lane_count(pg) == lanes2,
          f"{on.get('name')} overlaps={len(overlaps)} lanes={lane_count(pg)}/{lanes2}")
    pg.evaluate("() => window.__edit.undo()")
    wait_job(pg, slot, job2)
    proj = saved_project(sid, lambda p: job_of(p, vid) == job1
                         and all(job1 in (c.get("src") or "") for c in take_sounds(p)))
    _, a = one_soundtrack("one undo after the move", proj, vid, sound_id, job1)
    check("one undo after the move: the sound back on A2, exactly as it was",
          track_of(proj, sound_id).get("name") == "A2"
          and json.dumps(a.get("timing"), sort_keys=True) == before_timing,
          f"{track_of(proj, sound_id).get('name')} {(a.get('timing') or {}).get('display')}")


def wait_job(pg, slot, not_job, timeout=40_000):
    """Until the slot's clip plays a take other than `not_job`."""
    pg.wait_for_function(
        "([s, j]) => { const c = document.querySelector(`#edit-tracks .et-clip[data-slot=\"${s}\"]`);"
        " return c && c.dataset.job && c.dataset.job !== j }",
        arg=[slot, not_job], timeout=timeout)
    pg.wait_for_timeout(300)


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

    stays_detached(pg, sid, vid)

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

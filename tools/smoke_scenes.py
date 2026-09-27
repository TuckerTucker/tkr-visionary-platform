"""
The scene store, exercised against app.py's own source rather than a copy.

    python3 tools/smoke_scenes.py

**Why this file exists.** A scene is saved continuously and read back on the
next page load, so its failures arrive a session late and look like the page
forgetting: a field a later page wrote that an earlier page's save dropped, a
photograph that vanished because a save did not re-send it, a traversal that
served a file from outside the folder. None of those shows on the save that
causes it.

**Nothing here is retyped.** The storage helpers are pulled from app.py by
name (`_from_app.pull`) and the four routes are lifted out of `web()` by AST
and mounted on a bare FastAPI app, the way `smoke_auth.py` lifts the gate.
`SCENES` points at a temporary directory and the volume is a stub that counts
commits. No network, no Modal.

Two halves: the helpers need only the standard library; the routes need
`fastapi` and skip rather than fail without it.
"""

import ast
import base64
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from _from_app import APP, pull

SRC = APP.read_text()
fails: list[str] = []


def check(label: str, cond: object, detail: str = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not cond:
        fails.append(label)


HELPERS = {"NAME_RE", "MEDIA_TYPES", "SCENE_JSON", "SCENE_VERSION",
           "SCENE_FILE_DIRS", "SCENE_FILE_RE", "_check_scene_id",
           "_check_scene_file", "_read_scene", "_scene_refs", "_list_scenes",
           "_save_scene", "_scene_file", "PROJECT_JSON", "OPENVIDEO_RE",
           "_read_project", "_save_project",
           # Media dropped on the timeline.
           "SCENE_MEDIA_TYPES", "SCENE_MEDIA_MAX_BYTES", "SCENE_MEDIA_STEM_MAX",
           "SCENE_MEDIA_ACCEPTS", "_STILL_BRANDS", "_sniff_scene_media",
           "_scene_media_name"}
ns = pull(HELPERS)
# `os` is app.py's own import, and `_from_app` seeds only the ones its other
# callers need; `SCENES` is a path under /workspace, which is the one thing
# this file must not touch.
ns["os"] = os
ROOT = Path(tempfile.mkdtemp())
ns["SCENES"] = ROOT / "scenes"

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n fake").decode()

# ---- the helpers -----------------------------------------------------------

print("\n=== ids and names ===")
for bad in ("../x", "a b", "", "x" * 65, "scn/1"):
    try:
        ns["_check_scene_id"](bad)
        check(f"refuses id {bad!r}", False)
    except ValueError as exc:
        check(f"refuses id {bad!r} by name", repr(bad) in str(exc), str(exc)[:60])
ok = "scn20260926120000abcd"
check("accepts a minted id", ns["_check_scene_id"](ok) == ok)
check("strips path components", ns["_check_scene_file"]("a/b/00-image.png") == "00-image.png")
for bad in (".hidden", "..", "../", "x" * 81, "a b.png"):
    try:
        ns["_check_scene_file"](bad)
        check(f"refuses file {bad!r}", False)
    except ValueError:
        check(f"refuses file {bad!r}", True)

print("\n=== round trip ===")
intent = {"scene": {"cast": [], "shots": [{"id": "s1", "line": "hi"}]},
          "takes": [{"jobId": "vid1", "file": "a.mp4", "line": "hi"}],
          "slots": {}, "from_the_future": {"kept": True}}
out = ns["_save_scene"](ok, intent, {"00-image.png": PNG})
check("save answers ok with the id", out.get("ok") and out.get("id") == ok)
rec = json.loads((ns["SCENES"] / ok / "scene.json").read_text())
check("intent is stored verbatim", rec["intent"] == intent)
check("version and times are written",
      rec["version"] == 1 and rec["created"] and rec["modified"])
check("the ref is on disk",
      (ns["SCENES"] / ok / "refs" / "00-image.png").read_bytes()
      == base64.b64decode(PNG))

# An unknown top-level field, as a later writer would leave it.
rec["annotations"] = ["somebody's"]
(ns["SCENES"] / ok / "scene.json").write_text(json.dumps(rec))
created = rec["created"]
ns["_save_scene"](ok, {**intent, "takes": []}, None)
rec2 = json.loads((ns["SCENES"] / ok / "scene.json").read_text())
check("an unknown top-level field survives a save",
      rec2.get("annotations") == ["somebody's"])
check("created is kept", rec2["created"] == created)
check("modified moves", rec2["modified"] >= rec["modified"])
check("a ref not re-sent survives",
      (ns["SCENES"] / ok / "refs" / "00-image.png").is_file())
check("refs are listed", ns["_scene_refs"](ns["SCENES"] / ok) == ["00-image.png"])

print("\n=== damage is refused, not overwritten ===")
bad_id = "scn20260101000000dead"
(ns["SCENES"] / bad_id).mkdir(parents=True)
(ns["SCENES"] / bad_id / "scene.json").write_text("{not json")
# Older than the good one, so the listing's order is what is being tested
# rather than which folder this script happened to make last.
os.utime(ns["SCENES"] / bad_id, (1, 1))
try:
    ns["_save_scene"](bad_id, intent, None)
    check("a save over an unparseable record is refused", False)
except ValueError as exc:
    check("a save over an unparseable record is refused naming the file",
          "scene.json" in str(exc) and "does not parse" in str(exc), str(exc)[:80])
check("and the damaged file is untouched",
      (ns["SCENES"] / bad_id / "scene.json").read_text() == "{not json")
listing = ns["_list_scenes"]()
check("the listing is newest first",
      [r["id"] for r in listing] == [ok, bad_id], str([r["id"] for r in listing]))
check("it counts takes", listing[0]["takes"] == 0)
check("a damaged scene lists with its error",
      "does not parse" in (listing[1].get("error") or ""))
try:
    ns["_save_scene"](ok, intent, {"../evil.png": "!!!"})
    check("a non-base64 ref is refused", False)
except ValueError as exc:
    check("a non-base64 ref is refused by name", "evil.png" in str(exc), str(exc)[:60])

# ---- the routes ------------------------------------------------------------

try:
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, JSONResponse
    from fastapi.testclient import TestClient
except ImportError:
    print("\n=== routes: skipped (no fastapi locally; pip install 'fastapi[standard]') ===")
    raise SystemExit(1 if fails else 0)

print("\n=== routes, lifted from web() ===")
lines = SRC.splitlines(keepends=True)
web = next(n for n in ast.parse(SRC).body
           if isinstance(n, ast.FunctionDef) and n.name == "web")
wanted = {"list_scenes", "get_scene", "save_scene", "scene_file",
          "save_scene_project", "scene_media", "_do_scene_media"}
pieces: list[str] = []
for node in web.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted:
        first = min(d.lineno for d in node.decorator_list) if node.decorator_list else node.lineno
        pieces.append("".join(l[4:] if l.startswith("    ") else l
                              for l in lines[first - 1:node.end_lineno]))
        wanted.discard(node.name)
assert not wanted, f"could not lift: {wanted}"


class Commit:
    """`volume.commit`, and its `.aio()` — the media route is async and
    awaits the latter."""
    count = 0

    def __call__(self) -> None:
        Commit.count += 1

    async def aio(self) -> None:
        Commit.count += 1


class Volume:
    commit = Commit()


api = FastAPI()
ns.update(api=api, JSONResponse=JSONResponse, FileResponse=FileResponse,
          Request=Request, Any=Any, volume=Volume(), _reload_volume=lambda: True)
exec(compile("\n".join(pieces), "app.py:web", "exec"), ns)
c = TestClient(api)

r = c.get("/api/scenes").json()
check("GET /api/scenes lists both", [s["id"] for s in r["scenes"]] == [ok, bad_id])

sid = "scn20260926130000beef"
body = {"intent": {"scene": {"cast": []}, "takes": [1, 2], "slots": {},
                   "unmodelled": "yes"},
        "refs": {"00-image.png": PNG, "01-audio.wav": base64.b64encode(b"RIFF").decode()}}
before = Commit.count
r = c.post(f"/api/scenes/{sid}", json=body).json()
check("POST saves and answers {ok, id, modified}",
      r.get("ok") and r.get("id") == sid and r.get("modified"), str(r))
check("and commits the volume", Commit.count == before + 1)
r = c.get(f"/api/scenes/{sid}").json()
check("GET returns the intent exactly as stored", r.get("intent") == body["intent"], str(r)[:80])
check("with its refs", r.get("refs") == ["00-image.png", "01-audio.wav"], str(r.get("refs")))
c.post(f"/api/scenes/{sid}", json={"intent": {**body["intent"], "takes": [1, 2, 3]}})
r = c.get(f"/api/scenes/{sid}").json()
check("refs not re-sent survive a route save",
      r.get("refs") == ["00-image.png", "01-audio.wav"])
check("the listing counts its takes",
      next(s for s in c.get("/api/scenes").json()["scenes"] if s["id"] == sid)["takes"] == 3)

r = c.post("/api/scenes/bad%20id", json=body)
check("a bad id is refused with 200 {error}",
      r.status_code == 200 and "'bad id'" in r.json().get("error", ""), r.text[:80])
r = c.get("/api/scenes/bad%20id").json()
check("GET of a bad id names it", "'bad id'" in r.get("error", ""))
r = c.get(f"/api/scenes/{bad_id}").json()
check("GET of a damaged scene names the file and the parse error",
      "scene.json" in r.get("error", "") and "does not parse" in r["error"])
r = c.post("/api/scenes/x", json={"intent": "a string"}).json()
check("an intent that is not an object is refused", "object" in r.get("error", ""))

r = c.get(f"/api/scene-file/{sid}/00-image.png")
check("scene-file serves a ref",
      r.status_code == 200 and r.content == base64.b64decode(PNG))
check("with its media type", r.headers.get("content-type") == "image/png",
      r.headers.get("content-type", ""))
(ns["SCENES"] / sid / "media").mkdir()
(ns["SCENES"] / sid / "media" / "cut.mp4").write_bytes(b"mp4")
r = c.get(f"/api/scene-file/{sid}/cut.mp4")
check("and a file under media/", r.status_code == 200 and r.content == b"mp4")
(ROOT / "secret.txt").write_text("outside")
# The router will not match an encoded slash into a path parameter at all, so
# the helper is asked directly: it is what a future route shape would reach.
check("a traversal is stripped to its last component and not found",
      ns["_scene_file"](sid, "../../../secret.txt") is None)
(ns["SCENES"] / sid / "refs" / "secret.txt").write_text("inside")
check("and the stripped name resolves inside the folder",
      ns["_scene_file"](sid, "../../../secret.txt")
      == ns["SCENES"] / sid / "refs" / "secret.txt")
r = c.get(f"/api/scene-file/{sid}/..%2F..%2F..%2Fsecret.txt")
check("the route never serves the outside file", "outside" not in r.text,
      f"{r.status_code} {r.text[:60]}")
r = c.get(f"/api/scene-file/{sid}/.hidden")
check("a dotfile is refused 400", r.status_code == 400, str(r.status_code))
r = c.get("/api/scene-file/bad%20id/00-image.png")
check("a bad id is 400", r.status_code == 400)
r = c.get(f"/api/scene-file/{sid}/nope.png")
check("a missing file is 404", r.status_code == 404)

print("\n=== the arrangement ===")
# An IProject as a later engine might write it: fields nobody here models, at
# every depth, in an order that is not sorted. The server reads none of them,
# so every one has to come back — and in the same order, since "byte-for-byte"
# is what the page relies on when it compares what it exported to what it read.
project = {"settings": {"width": 1280, "height": 720, "fps": 24, "duration": 5.5e6,
                        "zz_future": {"nested": [1, 2.5, None, "ü"]}},
           "tracks": [{"id": "t1", "name": "Video Track", "type": "video",
                       "clipIds": ["c1"], "accepts": ["video", "image"]}],
           "clips": {"c1": {"id": "c1", "type": "Video", "name": "take",
                            "timing": {"display": {"from": 0, "to": 5500000},
                                       "trim": {"from": 250000, "to": 5750000}},
                            "metadata": {"jobId": "vid1", "unknown": {"deep": True}}}},
           "aaa_unmodelled": ["kept"]}
before = Commit.count
r = c.post(f"/api/scenes/{sid}/project",
           json={"openvideo": "1.4.0", "project": project}).json()
check("POST project answers {ok, modified}", r.get("ok") and r.get("modified"), str(r))
check("and commits the volume", Commit.count == before + 1)
r = c.get(f"/api/scenes/{sid}").json()
check("GET returns the project with its unknown fields", r.get("project") == project)
check("in the order it was sent",
      json.dumps(r.get("project")) == json.dumps(project))
check("and the pin it was written at", r.get("openvideo") == "1.4.0")
check("the intent is still there beside it", r.get("intent", {}).get("unmodelled") == "yes")
stored = json.loads((ns["SCENES"] / sid / "project.json").read_text())
check("project.json is {openvideo, saved, project}",
      set(stored) == {"openvideo", "saved", "project"} and stored["project"] == project)

r = c.get(f"/api/scenes/{ok}").json()
check("a scene with no arrangement answers null for both",
      r.get("project") is None and r.get("openvideo") is None and "project_error" not in r)
check("the older scene lists below the newer one",
      [s["id"] for s in c.get("/api/scenes").json()["scenes"]][:2] == [sid, ok])
c.post(f"/api/scenes/{ok}/project", json={"openvideo": "1.4.0", "project": {}})
listing = [s["id"] for s in c.get("/api/scenes").json()["scenes"]]
check("an arrangement save moves a scene to the top of the listing",
      listing[:2] == [ok, sid], str(listing))

for bad, why in (({"openvideo": "1.4.0", "project": [1]}, "object"),
                 ({"openvideo": "", "project": {}}, "version"),
                 ({"openvideo": "1.4.0 ; rm", "project": {}}, "version"),
                 ({"project": {}}, "version")):
    r = c.post(f"/api/scenes/{sid}/project", json=bad).json()
    check(f"refuses {bad!r} naming the {why}", why in r.get("error", ""), r.get("error", "")[:70])
r = c.post("/api/scenes/bad%20id/project", json={"openvideo": "1.4.0", "project": {}}).json()
check("a bad id is refused naming it", "'bad id'" in r.get("error", ""))

(ns["SCENES"] / sid / "project.json").write_text('{"openvideo": "1.4.0", "proj')
r = c.get(f"/api/scenes/{sid}").json()
check("a corrupt project.json is reported naming the file and the parse error",
      "project.json" in (r.get("project_error") or "")
      and "does not parse" in r["project_error"], str(r.get("project_error"))[:80])
check("while the intent still loads, so the page can recompile from it",
      r.get("intent", {}).get("unmodelled") == "yes" and r.get("project") is None
      and "error" not in r)
r = c.post(f"/api/scenes/{sid}/project",
           json={"openvideo": "1.4.0", "project": {"recompiled": True}}).json()
check("the recompiled arrangement saves over it", r.get("ok"), str(r))
aside = sorted((ns["SCENES"] / sid).glob("project.damaged-*.json"))
check("and the damaged bytes are set aside, not destroyed",
      len(aside) == 1 and aside[0].read_text() == '{"openvideo": "1.4.0", "proj')
check("the new one reads back",
      c.get(f"/api/scenes/{sid}").json().get("project") == {"recompiled": True})

new_sid = "scn20260926140000cafe"
r = c.post(f"/api/scenes/{new_sid}/project",
           json={"openvideo": "1.4.0", "project": project}).json()
check("an arrangement saved before any intent creates the folder", r.get("ok"), str(r))
r = c.get(f"/api/scenes/{new_sid}").json()
check("and reads back with a null intent and no error",
      r.get("project") == project and r.get("intent") is None and "error" not in r, str(r)[:80])
row = next(s for s in c.get("/api/scenes").json()["scenes"] if s["id"] == new_sid)
check("it lists undamaged, with no takes", "error" not in row and row["takes"] == 0, str(row))
c.post(f"/api/scenes/{new_sid}", json={"intent": {"takes": [1]}})
r = c.get(f"/api/scenes/{new_sid}").json()
check("the intent that follows lands beside it",
      r.get("intent") == {"takes": [1]} and r.get("project") == project)

print("\n=== media dropped on the timeline ===")
# The first bytes of each kind the timeline takes, as the files themselves
# start. The sniff reads 64 bytes, so a little padding is all a body needs.
PAD = b"\x00" * 64
KINDS = {
    "clip.mp4": (b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00" + PAD, "video", ".mp4", "video/mp4"),
    "phone.mov": (b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00" + PAD, "video", ".mov", "video/quicktime"),
    "screen.webm": (b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm" + PAD, "video", ".webm", "video/webm"),
    "still.png": (b"\x89PNG\r\n\x1a\n" + PAD, "image", ".png", "image/png"),
    "still.jpeg": (b"\xff\xd8\xff\xe0" + PAD, "image", ".jpg", "image/jpeg"),
    "still.webp": (b"RIFF\x00\x00\x00\x00WEBPVP8 " + PAD, "image", ".webp", "image/webp"),
    "song.mp3": (b"ID3\x04\x00" + PAD, "audio", ".mp3", "audio/mpeg"),
    "raw.mp3": (b"\xff\xfb\x90\x64" + PAD, "audio", ".mp3", "audio/mpeg"),
    "voice.wav": (b"RIFF\x00\x00\x00\x00WAVEfmt " + PAD, "audio", ".wav", "audio/wav"),
    "memo.m4a": (b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00" + PAD, "audio", ".m4a", "audio/mp4"),
    "bare.aac": (b"\xff\xf1\x50\x80" + PAD, "audio", ".aac", "audio/aac"),
    "take.ogg": (b"OggS\x00\x02" + PAD, "audio", ".ogg", "audio/ogg"),
}
for fname, (head, kind, ext, _) in KINDS.items():
    got = ns["_sniff_scene_media"](head[:64], fname)
    check(f"{fname} sniffs as {kind} {ext}", got == (kind, ext), str(got))
for head, what in ((b"GIF89a" + PAD, "a GIF"), (b"%PDF-1.7" + PAD, "a PDF"),
                   (b"\x00\x00\x00\x18ftypheic" + PAD, "HEIC"),
                   (b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x88matroska" + PAD, "Matroska"),
                   (b"", "an empty file"), (b"PK\x03\x04" + PAD, "zip"),
                   (b"hello world, not media" + PAD, "bytes starting")):
    try:
        ns["_sniff_scene_media"](head[:64], "x/y/thing.bin")
        check(f"refuses {what}", False)
    except ValueError as exc:
        said = str(exc)
        check(f"refuses {what} naming it, the file and what it takes",
              what in said and "'thing.bin'" in said and "MP4" in said and "MP3" in said, said[:100])

name_sid = "scn20260926150000f00d"
(ns["SCENES"] / name_sid / "refs").mkdir(parents=True)
(ns["SCENES"] / name_sid / "refs" / "00-image.png").write_bytes(b"ref")
nm = ns["_scene_media_name"]
check("a plain name is kept", nm(name_sid, "Beach Day!.PNG", ".png") == "Beach-Day.png")
check("a path and dots are stripped to a safe stem",
      nm(name_sid, "../../..hidden.mov", ".mp4") == "hidden.mp4", nm(name_sid, "../../..hidden.mov", ".mp4"))
check("an unusable stem becomes media", nm(name_sid, "…", ".wav") == "media.wav")
long = nm(name_sid, "a" * 200 + ".mp4", ".mp4")
check("a long stem is cut to fit the name rule", bool(ns["SCENE_FILE_RE"].match(long)), long)
clash = nm(name_sid, "00-image.png", ".png")
check("a name a ref already has is suffixed, so the ref is not what gets served",
      clash != "00-image.png" and clash.startswith("00-image-") and clash.endswith(".png"), clash)

DATASETS = ROOT / "datasets"
(DATASETS / "k3nan").mkdir(parents=True)
(DATASETS / "k3nan" / "01.png").write_bytes(b"\x89PNG dataset")
(DATASETS / "k3nan" / "01.txt").write_text("a man at a desk")


def tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


outside_before = {k: v for k, v in tree(ROOT).items() if not k.startswith("scenes/")}
media_sid = "scn20260926160000d00d"
landed: dict[str, str] = {}
for fname, (head, kind, ext, ctype) in KINDS.items():
    before = Commit.count
    r = c.post(f"/api/scenes/{media_sid}/media", files={"file": (fname, head, "application/octet-stream")})
    body = r.json()
    answered = r.status_code == 200 and body.get("ok") and body.get("kind") == kind \
        and str(body.get("name", "")).endswith(ext) and body.get("bytes") == len(head)
    check(f"POST media {fname} answers {{ok, name, kind, bytes}}", answered, r.text[:100])
    check(f"  and commits the volume", Commit.count == before + 1)
    landed[fname] = body.get("name", "")
    on_disk = ns["SCENES"] / media_sid / "media" / landed[fname]
    check(f"  it lands under scenes/{{id}}/media, whole", on_disk.is_file()
          and on_disk.read_bytes() == head, str(on_disk))
    r = c.get(f"/api/scene-file/{media_sid}/{landed[fname]}")
    check(f"  and is served back as {ctype}",
          r.status_code == 200 and r.content == head
          and r.headers.get("content-type", "").split(";")[0] == ctype,
          f"{r.status_code} {r.headers.get('content-type')}")
check("two files with one stem get two names",
      landed["raw.mp3"] == "raw.mp3" and landed["song.mp3"] == "song.mp3"
      and len(set(landed.values())) == len(landed), str(sorted(landed.values())))
check("the extension is the sniffed one, not the client's",
      landed["still.jpeg"] == "still.jpg", landed["still.jpeg"])
r = c.post(f"/api/scenes/{media_sid}/media", files={"file": ("clip.mp4", KINDS["clip.mp4"][0], "video/mp4")})
check("the same file dropped again is a second file, not an overwrite",
      r.json().get("name", "").startswith("clip-") and (ns["SCENES"] / media_sid / "media" / "clip.mp4").is_file(),
      r.text[:80])
check("no partial file is left beside them",
      not [p.name for p in (ns["SCENES"] / media_sid / "media").iterdir() if p.name.startswith(".")])

n_media = len(list((ns["SCENES"] / media_sid / "media").iterdir()))
r = c.post(f"/api/scenes/{media_sid}/media", files={"file": ("notes.pdf", b"%PDF-1.4" + PAD, "application/pdf")})
check("a PDF is refused with 200 {error} naming it and the file",
      r.status_code == 200 and "a PDF" in r.json().get("error", "") and "notes.pdf" in r.json()["error"],
      r.text[:100])
r = c.post(f"/api/scenes/{media_sid}/media", data={"x": "1"})
check("a drop without a file is refused naming the field", "`file`" in r.json().get("error", ""), r.text[:80])
r = c.post("/api/scenes/bad%20id/media", files={"file": ("a.png", KINDS["still.png"][0], "image/png")})
check("a bad scene id is refused naming it", "'bad id'" in r.json().get("error", ""), r.text[:80])
ns["SCENE_MEDIA_MAX_BYTES"] = 32
r = c.post(f"/api/scenes/{media_sid}/media",
           files={"file": ("big.mp4", KINDS["clip.mp4"][0] + b"\x00" * (2 << 20), "video/mp4")})
check("a file past the ceiling is refused naming it and the ceiling",
      "big.mp4" in r.json().get("error", "") and "GiB" in r.json()["error"], r.text[:100])
check("no refusal leaves a file behind",
      len(list((ns["SCENES"] / media_sid / "media").iterdir())) == n_media)

outside_after = {k: v for k, v in tree(ROOT).items() if not k.startswith("scenes/")}
check("nothing outside scenes/ changed — the datasets least of all",
      outside_after == outside_before, str(sorted(set(outside_after) ^ set(outside_before))))
check("media is scene-local: no other scene folder gained a file",
      not (ns["SCENES"] / ok / "media").exists())

print()
if fails:
    print(f"{len(fails)} FAILED: {fails}")
    sys.exit(1)
print("all passed")

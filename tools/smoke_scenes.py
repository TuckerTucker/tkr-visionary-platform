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
           "_save_scene", "_scene_file"}
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
    from fastapi import FastAPI
    from fastapi.responses import FileResponse, JSONResponse
    from fastapi.testclient import TestClient
except ImportError:
    print("\n=== routes: skipped (no fastapi locally; pip install 'fastapi[standard]') ===")
    raise SystemExit(1 if fails else 0)

print("\n=== routes, lifted from web() ===")
lines = SRC.splitlines(keepends=True)
web = next(n for n in ast.parse(SRC).body
           if isinstance(n, ast.FunctionDef) and n.name == "web")
wanted = {"list_scenes", "get_scene", "save_scene", "scene_file"}
pieces: list[str] = []
for node in web.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted:
        first = min(d.lineno for d in node.decorator_list) if node.decorator_list else node.lineno
        pieces.append("".join(l[4:] if l.startswith("    ") else l
                              for l in lines[first - 1:node.end_lineno]))
        wanted.discard(node.name)
assert not wanted, f"could not lift: {wanted}"


class Volume:
    commits = 0

    def commit(self) -> None:
        Volume.commits += 1


api = FastAPI()
ns.update(api=api, JSONResponse=JSONResponse, FileResponse=FileResponse,
          Any=Any, volume=Volume(), _reload_volume=lambda: True)
exec(compile("\n".join(pieces), "app.py:web", "exec"), ns)
c = TestClient(api)

r = c.get("/api/scenes").json()
check("GET /api/scenes lists both", [s["id"] for s in r["scenes"]] == [ok, bad_id])

sid = "scn20260926130000beef"
body = {"intent": {"scene": {"cast": []}, "takes": [1, 2], "slots": {},
                   "unmodelled": "yes"},
        "refs": {"00-image.png": PNG, "01-audio.wav": base64.b64encode(b"RIFF").decode()}}
before = Volume.commits
r = c.post(f"/api/scenes/{sid}", json=body).json()
check("POST saves and answers {ok, id, modified}",
      r.get("ok") and r.get("id") == sid and r.get("modified"), str(r))
check("and commits the volume", Volume.commits == before + 1)
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

print()
if fails:
    print(f"{len(fails)} FAILED: {fails}")
    sys.exit(1)
print("all passed")

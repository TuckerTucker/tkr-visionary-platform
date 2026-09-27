"""
An exported cut lands as an output, exercised against app.py's own source.

    python3 tools/smoke_outputs.py

**Why this file exists.** `POST /api/outputs` is the one place a result
arrives from the page rather than from a GPU job, so every assumption the
gallery makes about a job folder — an id NAME_RE accepts, a filename
OUTPUT_FILE_RE accepts, a sidecar whose fields are the kinds the cards read —
is here a promise about bytes somebody else chose. The failures would all land
a step later and look like something else: a card that never appears (the id or
the name fails a regex the listing applies), a clip that will not play (a WebM
saved as `.mp4`), a card drawn at the wrong shape (a width that arrived as a
string), a metadata sheet serving a field the client invented.

**Nothing here is retyped.** The helpers are pulled from app.py by name
(`_from_app.pull`), and the export route plus `/api/file` and `/api/gallery`
are lifted out of `web()` by AST and mounted on a bare FastAPI app, the way
`smoke_scenes.py` does it. `OUTPUTS` is a temporary directory; the volume is a
stub that counts commits; the listing is `_gallery` itself with its RPC halves
pointed at the temporary directory. No network, no Modal.
"""

import ast
import asyncio
import json
import os
import shutil
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


HELPERS = {"NAME_RE", "OUTPUT_FILE_RE", "OPENVIDEO_RE", "OUTPUT_META", "MEDIA_TYPES",
           "SHOT_VALUE_MAX", "_oneline", "_check_scene_id", "_write_output_meta",
           "_keep_entry", "_entries_by_walk", "_gallery", "_META_CACHE",
           "EXPORT_MAX_BYTES", "EXPORT_META_MAX", "EXPORT_MAX_TAKES",
           "_export_job_id", "_sniff_mp4", "_export_meta"}
ns = pull(HELPERS)
ns.update(os=os, shutil=shutil)
ROOT = Path(tempfile.mkdtemp())
ns["OUTPUTS"] = ROOT / "outputs"
ns["OUTPUTS"].mkdir()
# `_gallery`'s two reads of the volume, pointed at the temporary tree — the
# walk is app.py's own fallback, so the listing logic under test is unchanged.
ns["_output_entries"] = ns["_entries_by_walk"]
ns["_volume_bytes"] = lambda rel: ((ROOT / rel).read_bytes()
                                   if (ROOT / rel).is_file() else None)

# The first bytes of an MP4 as the engine's muxer writes it: a box size, then
# `ftyp`, then a brand. Enough for the sniff, which is all the server reads.
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 4096
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 64

# ---- the helpers -----------------------------------------------------------

print("\n=== ids ===")
jid = ns["_export_job_id"]()
check("an export id passes NAME_RE", bool(ns["NAME_RE"].match(jid)), jid)
check("and reads as an export", jid.startswith("exp") and len(jid) == 3 + 14 + 4, jid)

print("\n=== the sniff ===")
check("an ftyp box is an MP4", ns["_sniff_mp4"](MP4[:64]) is None)
for head, name in ((WEBM, "WebM"), (b"\x89PNG\r\n\x1a\n", "PNG"), (b"", "empty"),
                   (b"\xff\xd8\xff\xe0", "JPEG"), (b"RIFF\x00\x00WAVE", "RIFF"),
                   (b'{"error": 1}', "text"), (b"\x01\x02\x03\x04\x05\x06\x07\x08\x09", "01 02")):
    said = ns["_sniff_mp4"](head) or ""
    check(f"refuses {name} by name", name in said and "not an MP4" in said, said[:80])

print("\n=== meta ===")
good = {"scene": "scn20260926120000abcd", "width": 640, "height": 360, "fps": 24,
        "seconds": 6.0, "openvideo": "1.4.0",
        "takes": [{"job_id": "vid20260926120000aaaa", "file": "120000.mp4",
                   "line": "he walks\nout"}],
        "prompt": "a client-chosen field", "kind": "image", "job_id": "../x"}
m = ns["_export_meta"](json.dumps(good))
check("keeps the known fields", m.get("scene") == good["scene"] and m.get("width") == 640
      and m.get("seconds") == 6.0 and m.get("openvideo") == "1.4.0", str(m)[:100])
check("drops what it does not know, including kind and job_id",
      not {"prompt", "kind", "job_id"} & set(m), str(sorted(m)))
check("a take's line is one line", m["takes"][0]["line"] == "he walks out")
check("empty meta is no fields", ns["_export_meta"]("") == {})
for bad, why in (("{not json", "does not parse"), ("[1]", "not an object"),
                 (json.dumps({"scene": "../x"}), "'../x'"),
                 (json.dumps({"width": "640"}), "width"),
                 (json.dumps({"width": True}), "width"),
                 (json.dumps({"fps": 0}), "fps"),
                 (json.dumps({"seconds": -1}), "seconds"),
                 (json.dumps({"openvideo": "1.4 ; rm"}), "version"),
                 (json.dumps({"takes": "x"}), "list"),
                 (json.dumps({"takes": [{"job_id": "vid1", "file": "../../x.mp4"}]}), "take 1"),
                 ("x" * (ns["EXPORT_META_MAX"] + 1), "limit")):
    try:
        ns["_export_meta"](bad)
        check(f"refuses meta {bad[:30]!r}", False)
    except ValueError as exc:
        check(f"refuses meta {bad[:30]!r} naming the {why}", why in str(exc), str(exc)[:70])

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
wanted = {"save_export", "_do_export", "output_file", "gallery"}
pieces: list[str] = []
for node in web.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted:
        first = min(d.lineno for d in node.decorator_list) if node.decorator_list else node.lineno
        pieces.append("".join(l[4:] if l.startswith("    ") else l
                              for l in lines[first - 1:node.end_lineno]))
        wanted.discard(node.name)
assert not wanted, f"could not lift: {wanted}"


class Commit:
    """`volume.commit`, and its `.aio()` — the async route awaits the latter."""
    count = 0

    def __call__(self) -> None:
        Commit.count += 1

    async def aio(self) -> None:
        Commit.count += 1


class Volume:
    commit = Commit()


def spooled(rel: str) -> Path | None:
    # The spool's answer for a committed file: the file. What the route does
    # with the name before it gets here is what is under test.
    p = ROOT / rel
    return p if p.is_file() else None


api = FastAPI()
ns.update(api=api, JSONResponse=JSONResponse, FileResponse=FileResponse, Request=Request,
          Any=Any, volume=Volume(), _reload_volume=lambda: True, _spooled=spooled,
          _listed=lambda *a: False, _sizes_on_disk=lambda ps: {p: 0 for p in ps})
exec(compile("\n".join(pieces), "app.py:web", "exec"), ns)
c = TestClient(api)


def post(data: bytes, meta: object, filename: str = "cut.mp4") -> Any:
    return c.post("/api/outputs", files={"file": (filename, data, "video/mp4")},
                  data={"meta": meta if isinstance(meta, str) else json.dumps(meta)})


before = Commit.count
r = post(MP4, good)
body = r.json()
check("POST answers {ok, job_id, name}",
      r.status_code == 200 and body.get("ok") and body.get("job_id") and body.get("name"), r.text[:100])
job, name = body.get("job_id", ""), body.get("name", "")
check("the job id is an export's", job.startswith("exp") and bool(ns["NAME_RE"].match(job)), job)
check("the name is one the file route accepts", bool(ns["OUTPUT_FILE_RE"].match(name)), name)
check("and commits the volume", Commit.count == before + 1)
d = ns["OUTPUTS"] / job
check("the MP4 is on disk, whole", (d / name).read_bytes() == MP4)
check("no partial file is left beside it",
      sorted(p.name for p in d.iterdir()) == sorted([name, "visionary.json"]),
      str(sorted(p.name for p in d.iterdir())))
side = json.loads((d / "visionary.json").read_text())
check("the sidecar says kind video, source edit",
      side.get("kind") == "video" and side.get("source") == "edit", str(side)[:100])
check("with the scene and the takes", side.get("scene") == good["scene"]
      and side.get("takes", [{}])[0].get("job_id") == "vid20260926120000aaaa")
check("and nothing the client invented", "prompt" not in side and side.get("job_id") == job)

items = c.get("/api/gallery").json()["items"]
row = next((i for i in items if i["job_id"] == job), None)
check("the gallery lists it", row is not None, str([i["job_id"] for i in items]))
check("as a video, with its file",
      bool(row) and row["kind"] == "video" and row["files"] == [name], str(row)[:100])
check("carrying the sidecar's size for the card's shape",
      bool(row) and row.get("width") == 640 and row.get("height") == 360)

r = c.get(f"/api/file/{job}/{name}")
check("/api/file serves it back", r.status_code == 200 and r.content == MP4, str(r.status_code))
check("as video/mp4", r.headers.get("content-type") == "video/mp4", r.headers.get("content-type", ""))

n_before = len(list(ns["OUTPUTS"].iterdir()))
r = post(WEBM, good, filename="cut.mp4")
check("a WebM named .mp4 is refused by what it is",
      r.status_code == 200 and "WebM" in r.json().get("error", ""), r.text[:100])
r = post(b"", good)
check("an empty file is refused by name", "empty" in r.json().get("error", ""), r.text[:100])
r = post(MP4, "{broken")
check("bad meta is refused naming the parse", "does not parse" in r.json().get("error", ""),
      r.text[:100])
r = post(MP4, {"scene": "a b"})
check("a bad scene id is refused naming it", "'a b'" in r.json().get("error", ""), r.text[:100])
r = c.post("/api/outputs", data={"meta": "{}"})
check("meta without a file is refused naming the file",
      "`file`" in r.json().get("error", ""), r.text[:100])
check("no refusal leaves a folder behind",
      len(list(ns["OUTPUTS"].iterdir())) == n_before, str(list(ns["OUTPUTS"].iterdir())))

# The ceiling, at a size a test can afford: the same route with a lower cap.
ns["EXPORT_MAX_BYTES"] = 2048
r = post(MP4, {})
check("an export past the ceiling is refused naming it",
      "GiB" in r.json().get("error", "") and "refused" in r.json().get("error", ""), r.text[:100])
check("and its partial folder is gone", len(list(ns["OUTPUTS"].iterdir())) == n_before)

shutil.rmtree(ROOT, ignore_errors=True)
print()
if fails:
    print(f"{len(fails)} FAILED: {fails}")
    sys.exit(1)
print("all passed")

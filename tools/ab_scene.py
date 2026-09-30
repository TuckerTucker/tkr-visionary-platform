"""
Does the scene composer make a better clip than the same words in one box?

    modal run tools/ab_scene.py --stage docs                 # CPU: both documents
    modal run tools/ab_scene.py --stage render --out out/scene-ab

Normally reached through `prompt_ab.py --scene`, which runs this and then the
judge. Two arms per scene, one seed, one canvas, one length, with what the
encoder is handed as the only variable:

  prose     (`_bare`) the flat path. Every word the composer held — each cast
            member's description as a sentence, then each shot's line with the
            handle written as the name — in one paragraph, with the same
            pictures attached in the same order and no roles, which is what
            the reference tray sends. `_compile_h3_prompt` with no scene:
            the typed text untouched when nothing is attached, the generic
            six-field form when something is.
  composer  (`_rich`) the payload `readScene` builds — cast, two shots at the
            composer's default four seconds each, pictures bound to people by
            index — through `_validate_scene` and `_compile_h3_scene`.

So what separates them is exactly what the composer claims to add: shots with
cut times, `<Subject N>` bound to a named picture, a retention line per subject,
the style lead. Not information — the prose carries every description and every
line.

**What is judged is a contact sheet, not the clip.** Six frames sampled evenly,
two across and three down, read in order — three either side of the four-second
cut. A vision judge reads stills; a sheet is the clip reduced to the one axis
the composer's claim is about, which shot is on screen when, and who is in it.
Sound is not judged at all, so nothing here says anything about
`overall_soundscape`, `non_diegetic_music` or dialogue.

**The portraits are made here**, by Krea 2 Turbo from a sentence, so a scene
with pictures uses nobody's photographs. They are also laid out as
`<name>_cast.png`, labelled by name, which `judge_renders.py --rubric scene`
shows the judge first — likeness cannot be judged without the likeness.

Everything the routes do on CPU is called here, in the route's order —
`_validate_ref_roles`, `_validate_scene`, `_h3_task`, `_compile_h3_prompt` — and
the GPU half is `VideoGenerator._plan_h3`, the staging and graph the job runs.
The route is not called because it is behind the password, and a harness that
held the password would be a harness that could leak it.

Renders land in the harness container's ComfyUI output and come back as bytes,
never on the volume's `outputs/`, so nothing here appears in the gallery.

## What it found, 2026-09-29

Seeds 774411 and 991733, five scenes each. The judge: composer 4, prose 0, tie
6. Every one of the six ties was the judge answering the same letter in both
orders, so they say nothing either way. By eye, over all twenty sheets: the
composer cut at the four-second boundary in 10 of 10, the prose in about 4. The
composer was better in 6 pairs, close in 1, mixed in 2, and worse in 1. **Its
failure is a duplicated subject** — a second Lee in the diner booth, a second
Nia on the bicycle, an extra cook at the wok, 3 of 10 against none in the
prose arm. That is a candidate, not a finding, at this n; it is the thing to
look for first if this is run again.
"""

import base64
import json
import sys
from pathlib import Path
from typing import Any

import modal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import (  # noqa: E402
    COMFY,
    IMAGE_DEFAULTS,
    KREA2_DEFAULTS,
    VIDEO_MODELS,
    VideoGenerator,
    _Comfy,
    _compile_h3_prompt,
    _h3_task,
    _krea2_graph,
    _validate_ref_roles,
    _validate_scene,
    comfy_image,
    models_volume,
    volume,
)

ab = modal.App("visionary-ab-scene")
ab_image = comfy_image.add_local_python_source("app")

SEED = 774411
# The composer's own default for a shot it has not been told the length of —
# `SHOT_SECONDS` in web/src/scene/model.ts — so a two-shot scene is eight
# seconds because that is what the page would send, not because it was picked.
SHOT_SECONDS = 4.0
SHEET_FRAMES = 6

# Five scenes, written the way the composer is written in: fragments, handles,
# a cast of one or two. Three with described cast and no pictures, which
# compile in base mode; two with a picture per person and nothing written about
# them, which is where binding a name to a picture is the whole difference — the
# prose arm attaches the same pictures and cannot say whose face is whose.
SCENES: list[dict[str, Any]] = [
    {"name": "bookshop",
     "cast": [{"name": "Maya", "note": "a woman in her sixties with cropped "
               "silver hair and a mustard cardigan"}],
     "shots": ["@maya unlocks the front door of her bookshop at dawn, the "
               "street still blue behind her",
               "inside, @maya pulls the chain on a green desk lamp, shelves up "
               "to the ceiling, dust in the light"]},
    {"name": "ferry",
     "cast": [{"name": "Jonah", "note": "a boy of about ten in a yellow raincoat"},
              {"name": "Ruth", "note": "his grandmother, tall, in a long black "
               "wool coat, silver hair in a bun"}],
     "shots": ["@jonah and @ruth at the rail of a small ferry, grey sea, wind "
               "pulling at their coats",
               "close on @ruth pointing at a lighthouse on the shore, @jonah "
               "leaning in beside her to look"]},
    {"name": "market",
     "cast": [{"name": "Dev", "note": "a cook in his forties in a white t-shirt "
               "and a red bandana"}],
     "shots": ["@dev tosses noodles in a wok over a roaring flame at a night "
               "market stall, steam everywhere",
               "@dev slides a plate across the counter toward the camera, neon "
               "signs blurred behind him"]},
    {"name": "rooftop",
     "cast": [{"name": "Nia", "portrait": "a young Black woman with short "
               "bleached-blond hair wearing a green bomber jacket"}],
     "shots": ["@nia crouches on a rooftop at dusk fixing the chain of an old "
               "bicycle, the city behind her",
               "@nia rides away across the empty rooftop car park, seen from "
               "behind"]},
    {"name": "diner",
     "cast": [{"name": "Sam", "portrait": "a heavyset man in his fifties with a "
               "grey beard, round glasses and a navy knit sweater"},
              {"name": "Lee", "portrait": "a slim East Asian woman in her "
               "thirties with a black bob and a red raincoat"}],
     "shots": ["@sam and @lee sit across from each other in a booth in an empty "
               "diner at night, rain on the window",
               "@lee laughs and slides a cup of coffee across the table to @sam"]},
]


def _portrait_prompt(look: str) -> str:
    return (f"head and shoulders photograph of {look}, looking at the camera, "
            f"plain light grey studio background, soft window light")


def _sentence(text: str) -> str:
    text = text.strip()
    text = text[0].upper() + text[1:]
    return text if text.endswith((".", "!", "?")) else text + "."


def _named(line: str, cast: list[dict[str, Any]]) -> str:
    for member in cast:
        line = line.replace(f"@{member['name'].lower()}", member["name"])
    return line


def prose(scene: dict[str, Any]) -> str:
    """Every word the composer holds, as one paragraph a person could have typed."""
    cast = scene["cast"]
    said = [f"{m['name']} is {m['note']}." for m in cast if m.get("note")]
    said += [_sentence(_named(line, cast)) for line in scene["shots"]]
    return " ".join(said)


def brief(scene: dict[str, Any]) -> str:
    """The intent, in words, for the judge — neither arm's document."""
    cast = scene["cast"]
    people = [f"{m['name']} is {m['note']}" if m.get("note")
              else f"{m['name']} looks like the cast photograph labelled "
                   f"{m['name']}" for m in cast]
    shots = [f"Shot {i + 1}: {_sentence(_named(line, cast))}"
             for i, line in enumerate(scene["shots"])]
    return (f"{'; '.join(people)}. A clip of {len(shots)} shots, in this order. "
            + " ".join(shots))


def page_scene(scene: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """
    What `readScene` sends, and the order the pictures travel in.

    One picture per pictured member, indexed in cast order, which is the order
    `assets()` walks the pool in for a cast built top to bottom.
    """
    cast, order = [], []
    for member in scene["cast"]:
        refs = []
        if member.get("portrait"):
            refs.append({"kind": "image", "index": len(order), "slots": ["image"],
                         "role": "reference"})
            order.append(member["name"].lower())
        cast.append({"id": member["name"].lower(), "kind": "subject",
                     "name": member["name"], "note": member.get("note", ""),
                     "retention": "fully_preserved", "refs": refs})
    shots = [{"line": line, "beats": SHOT_SECONDS, "pills": [],
              "say": {"who": [], "text": "", "lang": "English", "voice": "",
                      "carry": False, "cutoff": False, "offscreen": False}}
             for line in scene["shots"]]
    return ({"style": "", "grade": "", "sources": {}, "cast": cast,
             "shots": shots}, order)


def documents(scene: dict[str, Any]) -> dict[str, Any]:
    """Both arms' documents, through the route's own CPU steps in its order."""
    raw, order = page_scene(scene)
    seconds = SHOT_SECONDS * len(scene["shots"])
    n = len(order)
    roles = _validate_ref_roles(None, n)
    task = _h3_task(None, None, order, [], [])
    validated = _validate_scene(raw, n_refs=n, n_vids=0, n_auds=0, seconds=seconds)
    typed = "\n".join(line.strip() for line in scene["shots"])
    return {
        "seconds": seconds, "pictures": order,
        "rich": _compile_h3_prompt(typed=typed, pills=[], seconds=seconds,
                                   roles=roles, scene=validated, task=task),
        "bare": _compile_h3_prompt(typed=prose(scene), pills=[], seconds=seconds,
                                   roles=roles, scene=None, task=task),
    }


def _sheet(frames: list, cols: int, label: bool = True) -> bytes:
    """Frames in reading order on one image, each numbered in its corner."""
    import io

    from PIL import Image, ImageDraw

    w, h = frames[0].size
    rows = -(-len(frames) // cols)
    gap = 6
    sheet = Image.new("RGB", (cols * w + (cols - 1) * gap,
                              rows * h + (rows - 1) * gap), "white")
    draw = ImageDraw.Draw(sheet)
    for k, im in enumerate(frames):
        x, y = (k % cols) * (w + gap), (k // cols) * (h + gap)
        sheet.paste(im, (x, y))
        if label:
            draw.rectangle((x, y, x + 34, y + 30), fill="black")
            draw.text((x + 10, y + 6), str(k + 1), fill="white",
                      font_size=22)
    buf = io.BytesIO()
    sheet.save(buf, "PNG")
    return buf.getvalue()


@ab.cls(image=ab_image, gpu="H100", timeout=30 * 60,
        volumes={"/workspace": volume, "/models": models_volume})
class Portraits:
    @modal.enter()
    def up(self) -> None:
        self.comfy = _Comfy("image")
        self.comfy.start()

    @modal.method()
    def make(self, looks: dict[str, str], seed: int) -> dict[str, str]:
        out = {}
        for handle, look in looks.items():
            graph = _krea2_graph(
                model="turbo", prompt=_portrait_prompt(look), negative_prompt="",
                width=1024, height=1024, batch_size=1, seed=seed,
                steps=KREA2_DEFAULTS["turbo"]["steps"],
                cfg=KREA2_DEFAULTS["turbo"]["cfg"], shift=1.15,
                sampler=IMAGE_DEFAULTS["sampler"],
                scheduler=IMAGE_DEFAULTS["scheduler"], loras=[])
            names = self.comfy.run(f"ab-scene-portrait-{handle}", graph, what="image")
            out[handle] = base64.b64encode(
                (COMFY / "output" / names[0]).read_bytes()).decode()
            print(f"[ab-scene] portrait {handle}", flush=True)
        return out

    @modal.method()
    def cast_sheet(self, portraits: list[tuple[str, str]]) -> bytes:
        """Each portrait with its name under it, the judge's key to who is who."""
        import io

        from PIL import Image, ImageDraw

        tiles = []
        for name, b64 in portraits:
            face = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
            face = face.resize((384, 384))
            tile = Image.new("RGB", (384, 430), "white")
            tile.paste(face, (0, 0))
            ImageDraw.Draw(tile).text((12, 392), name, fill="black", font_size=30)
            tiles.append(tile)
        return _sheet(tiles, cols=len(tiles), label=False)


@ab.cls(image=ab_image, gpu="H100", timeout=90 * 60,
        # Both volumes, as VideoGenerator mounts them: the weights are on
        # models_volume, and `_plan_h3` refuses before a graph without them.
        volumes={"/workspace": volume, "/models": models_volume},
        scaledown_window=300)
class Takes:
    @modal.enter()
    def up(self) -> None:
        self.comfy = _Comfy("video")
        self.comfy.start()

    def _contact(self, clip: Path) -> bytes:
        """Six frames from the middles of six equal spans, two across."""
        import av

        with av.open(str(clip)) as c:
            n = sum(1 for _ in c.decode(video=0))
        want = {int((k + 0.5) / SHEET_FRAMES * n): k for k in range(SHEET_FRAMES)}
        got: dict[int, Any] = {}
        with av.open(str(clip)) as c:
            for i, frame in enumerate(c.decode(video=0)):
                if i in want:
                    got[want[i]] = frame.to_image().convert("RGB")
        w, h = got[0].size
        # Half size: the judge downscales the whole sheet to 768 on its long
        # edge anyway, and a sheet that is already near that size is one resize
        # rather than two.
        frames = [got[k].resize((w // 2, h // 2)) for k in range(SHEET_FRAMES)]
        return _sheet(frames, cols=2)

    @modal.method()
    def render(self, jobs: list[dict[str, Any]], seed: int) -> list[dict[str, Any]]:
        import time

        plan_h3 = VideoGenerator._get_user_cls()._plan_h3
        d = VIDEO_MODELS["h3"]["defaults"]
        results = []
        for k, job in enumerate(jobs):
            # Rotated per scene so the first take in a container — the one that
            # pays for loading the checkpoint into memory — is not always the
            # same arm.
            arms = ["bare", "rich"] if k % 2 == 0 else ["rich", "bare"]
            row: dict[str, Any] = {"name": job["name"]}
            for arm in arms:
                tag = f"ab-scene-{job['name']}-{arm}"

                def stage(blob: str, slot: str, ext: str = "png",
                          _tag: str = tag) -> str:
                    return self.comfy.stage(_tag, blob, slot, ext)

                params = {"prompt": job[arm], "aspect": "16:9", "tier": d["tier"],
                          "seconds": job["seconds"], "steps": d["steps"],
                          "sampler": d["sampler"], "scheduler": d["scheduler"],
                          "seed": seed, "references": job["references"],
                          "ref_size": "match"}
                plan = plan_h3(params, stage, job_id="")
                t0 = time.time()
                names = self.comfy.run(tag, plan["graph"], what="video")
                took = time.time() - t0
                clip = COMFY / "output" / names[0]
                row[arm] = {"mp4": base64.b64encode(clip.read_bytes()).decode(),
                            "sheet": base64.b64encode(self._contact(clip)).decode(),
                            "seconds": round(took, 1), "info": plan["info"],
                            "mode": plan["meta"]["mode"]}
                print(f"[ab-scene] {job['name']} {arm}: {plan['meta']['mode']} "
                      f"{plan['info']['width']}x{plan['info']['height']} "
                      f"{plan['info']['frames']}f in {took:.0f}s", flush=True)
            results.append(row)
        return results


@ab.local_entrypoint()
def main(stage: str = "docs", out: str = "out/scene-ab", seed: int = SEED,
         only: str = ""):
    scenes = [s for s in SCENES if not only or s["name"] in only.split(",")]
    docs = {s["name"]: documents(s) for s in scenes}
    if stage == "docs":
        for s in scenes:
            d = docs[s["name"]]
            print(f"\n==== {s['name']}  ({d['seconds']:.0f}s, "
                  f"{len(d['pictures'])} pictures)\n-- brief\n{brief(s)}"
                  f"\n-- prose (_bare)\n{d['bare']}\n-- composer (_rich)\n{d['rich']}")
        return
    if stage != "render":
        raise SystemExit("--stage is docs or render.")

    out_dir = Path(out)
    clips = out_dir.parent / f"{out_dir.name}-clips"
    out_dir.mkdir(parents=True, exist_ok=True)
    clips.mkdir(parents=True, exist_ok=True)

    looks = {m["name"].lower(): m["portrait"]
             for s in scenes for m in s["cast"] if m.get("portrait")}
    portraits: dict[str, str] = {}
    if looks:
        maker = Portraits()
        portraits = maker.make.remote(looks, seed)
        for handle, b64 in portraits.items():
            (clips / f"portrait-{handle}.png").write_bytes(base64.b64decode(b64))
        for s in scenes:
            pictured = [(m["name"], portraits[m["name"].lower()])
                        for m in s["cast"] if m.get("portrait")]
            if pictured:
                (out_dir / f"{s['name']}_cast.png").write_bytes(
                    maker.cast_sheet.remote(pictured))

    jobs = [{"name": s["name"], "seconds": docs[s["name"]]["seconds"],
             "bare": docs[s["name"]]["bare"], "rich": docs[s["name"]]["rich"],
             "references": [portraits[h] for h in docs[s["name"]]["pictures"]]}
            for s in scenes]
    # One container per checkpoint: the pictured scenes load the ref2va
    # transformer and the rest load fl2va, so splitting on that is two loads
    # rather than a swap per scene — and the two run side by side.
    groups = [g for g in ([j for j in jobs if not j["references"]],
                          [j for j in jobs if j["references"]]) if g]
    rows = [r for batch in Takes().render.map(groups, kwargs={"seed": seed})
            for r in batch]

    for row in rows:
        for arm in ("bare", "rich"):
            got = row[arm]
            (out_dir / f"{row['name']}_{arm}.png").write_bytes(
                base64.b64decode(got["sheet"]))
            (clips / f"{row['name']}_{arm}.mp4").write_bytes(
                base64.b64decode(got["mp4"]))
            print(f"{row['name']:<9} {arm:<4} {got['mode']:<6} "
                  f"{got['info']['frames']}f seed {got['info']['seed']} "
                  f"in {got['seconds']:.0f}s")
    (out_dir / "briefs.json").write_text(json.dumps(
        {s["name"]: brief(s) for s in scenes}, indent=2))
    (clips / "documents.json").write_text(json.dumps(docs, indent=2))
    print(f"\n{len(rows)} scenes: sheets and briefs in {out_dir}, clips and "
          f"both documents in {clips}")

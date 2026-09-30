"""
Does sampling from the source make a better inpaint than pasting a fresh frame?

    modal run tools/ab_inpaint.py --stage sources --out out/inpaint
    modal run tools/ab_inpaint.py --stage compare --out out/inpaint --cases cases.json
    modal run tools/ab_inpaint.py --stage compare ... --arms soft,figure --seed 7

Three arms, one seed, one caption, one SAM mask each, with how sampling treats
the mask as the only variable:

  paste    the old path: an empty latent, and SAM's edge feathered 5px pasted
           onto the source after decode.
  hard     the first fix (90f197d, deployed 2026-09-28): the source encoded and
           noised inside SAM's mask grown 16px, hard at every step, pasted on
           SAM's 5px-feathered edge.
  soft     the current path: one mask, grown, blurred and floored at SAM's own
           (`_inpaint_soft_mask`), read by SetLatentNoiseMask and used by the
           paste.

The hard arm is here because it passed this harness and then failed on the
deployed app: a man restyled in a leather coat kept his old outline and a
second head as pale fog, because between the old silhouette and the new one the
model painted background from nothing and the paste cut back along the old
edge. The `person` case below is that gesture.

Three more arms hold the soft mask and vary what the text encoder reads, because
the lamp case — a mug asked to become a glass of wine — came back from every
sampled arm with a small figure standing where the handle had been:

  figure    the box composed as a performer's, framed by its height — "a small
            distant background figure far from the camera, whole body". What
            every inpaint read until a box knew it was SAM's cut.
  plain     the typed prompt with the edit appended, and no clause placing it.
  unrouted  `figure`'s caption with no regional node in the graph.

What they settled (2026-09-29, seeds 42 and 7, twelve pictures each):
`unrouted` is bit-identical to `figure` in all twelve, because a box with no
LoRA and no photo arms nothing in V12 and it passes through
(`[V9/V2] no active regions`) — so the node is not the cause. `plain` loses
the figure and the edit with it: the mug came back a mug and the coat came
back a shirt, because nothing put the new thing inside the mask. The cause is
the framing clause, and `soft` now places a segment without it. The figure
only shows on the lamp because only there does the new thing leave the mask
room to fill — the glass is narrower than a mug and its handle — while the
fern fills the vase's footprint, the chair its own, and on the street the
figure the caption asks for is the man already there.

**DifferentialDiffusion was an arm here and lost.** It is the node for a graded
mask, and with it a mug asked to become a glass of wine stayed a mug — on the
soft mask and on a binary one alike — while every arm without it made the glass.
It is recorded so the obvious next idea is not re-tried blind.

Two stages, because the mask has to come from SAM clicking on a render, and the
point worth clicking is only known once the render has been looked at:

  sources   renders one plain picture per prompt and saves it.
  compare   takes `[{name, prompt, click: [x, y], edit, batch?}]`, gets a SAM
            mask for each click and renders both arms at that mask.

**Two numbers per arm, both excess over the source**, read over the rim of the
edit — a band either side of SAM's edge, and every pixel the soft mask only
partly covers — so a seam the source already had is not charged to any arm,
and a ghost left between the old silhouette and the new one is inside what is
read:

  edge   mean luminance gradient over the rim — a hard, visible line.
  light  the same after a wide blur — a step in light or colour that a feather
         hides from `edge` and not from an eye.

Lower is better for both, and they measure the rim and nothing else: whether
the edit shows what was asked for is for eyes or `judge_renders.py`, so the
pictures are saved as `<name>_bare.png` (paste), `<name>_hard.png` and `<name>_rich.png`
(soft), and the text arms under their own names. `scores.json` holds every
picture's numbers, because a mean over five cases is how the one case with a
figure in it hid behind four without one.

Renders land in this container's ComfyUI output, never on the volume's
`outputs/`, so nothing here appears in the gallery.
"""

import base64
import io
import json
import sys
from pathlib import Path
from typing import Any

import modal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import (  # noqa: E402
    COMFY,
    IMAGE_DEFAULTS,
    INPAINT_GROW_PX,
    KREA2_DEFAULTS,
    _Comfy,
    _compose_caption,
    _inpaint_soft_mask,
    _krea2_graph,
    _validate_regions,
    HF_CACHE,
    comfy_image,
    hf_cache,
    models_volume,
    segment_image,
    volume,
)

ab = modal.App("visionary-ab-inpaint")
ab_image = comfy_image.add_local_python_source("app")
# This file imports app.py at module scope, so every container it runs in
# needs the source — the SAM one included, or it crash-loops on the import.
sam_image = segment_image.add_local_python_source("app")

WIDTH, HEIGHT, SEED = 1024, 1024, 42
MODEL = "turbo"

# Scenes whose light has a direction, because that is what a paste gets wrong: a
# region drawn for an unseen frame guesses the light, and a guess against a
# low sun or a single lamp is a guess that shows.
PROMPTS = {
    "window": "a woman reading in an armchair beside a tall window, low "
              "golden-hour sun raking across the room",
    "lamp": "a cluttered writing desk at night lit by one green banker's lamp, "
            "an open notebook and a mug",
    "street": "a man in a grey coat standing on a wet cobbled street under a "
              "streetlight, fog behind him",
}

# Every arm, and the suffix its pictures are saved under. `bare` and `rich` are
# the names the first runs used for paste and soft, kept so a folder of old
# pictures still reads the same way.
ARMS = {"paste": "bare", "hard": "hard", "soft": "rich",
        "figure": "figure", "plain": "plain", "unrouted": "unrouted"}

# The band either side of the boundary the numbers are read over, and the blur
# that turns `edge` into `light`. The band is wider than the feather so the
# whole blend is inside it; the blur is wide enough that texture averages out
# and only a change of level survives.
BAND_PX = 9
LIGHT_BLUR_PX = 12


def _graph(prompt: str, seed: int, regions: list[dict], inpaint: dict | None,
           batch: int = 1) -> dict:
    return _krea2_graph(
        model=MODEL, prompt=prompt, negative_prompt="",
        width=WIDTH, height=HEIGHT, batch_size=batch, seed=seed,
        steps=KREA2_DEFAULTS[MODEL]["steps"], cfg=KREA2_DEFAULTS[MODEL]["cfg"],
        shift=1.15, sampler=IMAGE_DEFAULTS["sampler"],
        scheduler=IMAGE_DEFAULTS["scheduler"], loras=[], regions=regions,
        **(inpaint or {}),
    )


def _seam(result, source, mask, soft) -> dict[str, float]:
    """`edge` and `light` for one result over the edit's rim, as excess over the source."""
    import numpy as np
    from PIL import ImageFilter

    size = 2 * BAND_PX + 1
    band = (np.asarray(mask.filter(ImageFilter.MaxFilter(size)), dtype=bool)
            & ~np.asarray(mask.filter(ImageFilter.MinFilter(size)), dtype=bool))
    partial = np.asarray(soft)
    rim = band | ((partial > 5) & (partial < 250))

    def grad(im, blur: int) -> float:
        lum = im.convert("L")
        if blur:
            lum = lum.filter(ImageFilter.GaussianBlur(blur))
        a = np.asarray(lum, dtype=np.float32)
        gy, gx = np.gradient(a)
        return float(np.hypot(gx, gy)[rim].mean())

    return {"edge": round(grad(result, 0) - grad(source, 0), 3),
            "light": round(grad(result, LIGHT_BLUR_PX)
                           - grad(source, LIGHT_BLUR_PX), 3)}


@ab.cls(image=sam_image, gpu="T4", volumes={str(HF_CACHE): hf_cache})
class Sam:
    """
    `Segmenter`, run here rather than looked up on the deployment.

    Looked up first, and a deployment older than SAM has no such class — which
    is exactly the deployment somebody measuring an unshipped change has. So
    this is the same checkpoint and the same predict call as app.py's
    `Segmenter.segment`, returning the same fields, and it must stay that: the
    mask this measures is only worth measuring if a click on the canvas would
    have produced it.
    """

    @modal.enter()
    def load(self) -> None:
        from sam2.build_sam import build_sam2_hf
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        self.predictor = SAM2ImagePredictor(
            build_sam2_hf("facebook/sam2.1-hiera-small", device="cuda"))

    @modal.method()
    def segment(self, image_bytes: bytes, x: float, y: float) -> dict[str, Any]:
        import numpy as np
        from PIL import Image

        arr = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))
        self.predictor.set_image(arr)
        masks, scores, _ = self.predictor.predict(
            point_coords=np.array([[x * arr.shape[1], y * arr.shape[0]]]),
            point_labels=np.array([1]), multimask_output=True)
        best = int(np.argmax(scores))
        mask = masks[best]
        buf = io.BytesIO()
        Image.fromarray((mask * 255).astype(np.uint8), mode="L").save(buf, "PNG")
        ys, xs = np.where(mask)
        h, w = arr.shape[:2]
        return {"mask": base64.b64encode(buf.getvalue()).decode(),
                "score": float(scores[best]),
                "bbox": [float(xs.min() / w), float(ys.min() / h),
                         float(xs.max() / w), float(ys.max() / h)]
                if len(xs) else [0, 0, 1, 1]}


@ab.cls(image=ab_image, gpu="H100", timeout=45 * 60,
        # Both volumes, as ImageGenerator mounts them: the weights are on
        # models_volume, and without it every loader combo is empty.
        volumes={"/workspace": volume, "/models": models_volume},
        scaledown_window=600)
class Bench:
    @modal.enter()
    def up(self) -> None:
        self.comfy = _Comfy("image")
        self.comfy.start()

    def _run(self, tag: str, graph: dict) -> list[str]:
        """`_Comfy.run`, with a refused graph said rather than lost.

        ComfyUI answers a bad graph with a 400 whose body names the node, and
        the HTTPError carrying it cannot be pickled back to the caller — so the
        first run of this harness reported a serialization error and nothing
        about which input was wrong.
        """
        import urllib.error

        try:
            return self.comfy.run(tag, graph, what="image")
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"ComfyUI refused {tag}: "
                               f"{exc.read().decode(errors='replace')[:2000]}") from None

    @modal.method()
    def sources(self, prompts: dict[str, str], seed: int) -> dict[str, str]:
        out = {}
        for name, prompt in prompts.items():
            names = self._run(f"src-{name}", _graph(prompt, seed, [], None))
            out[name] = base64.b64encode(
                (COMFY / "output" / names[0]).read_bytes()).decode()
            print(f"[ab-inpaint] source {name}", flush=True)
        return out

    @modal.method()
    def compare(self, cases: list[dict[str, Any]], seed: int,
                arms_wanted: list[str]) -> list[dict]:
        from PIL import Image, ImageFilter

        results = []
        for case in cases:
            name = case["name"]
            source_png = base64.b64decode(case["source"])
            mask_png = base64.b64decode(case["mask"])
            (COMFY / "input" / f"ab-{name}-source.png").write_bytes(source_png)
            (COMFY / "input" / f"ab-{name}-mask.png").write_bytes(mask_png)
            source = Image.open(io.BytesIO(source_png)).convert("RGB")
            mask = Image.open(io.BytesIO(mask_png)).convert("L")
            # Each arm's own masks, as each version of the job made them.
            feathered = mask.filter(ImageFilter.GaussianBlur(5))
            grown = mask
            for _ in range(INPAINT_GROW_PX):
                grown = grown.filter(ImageFilter.MaxFilter(3))
            soft = _inpaint_soft_mask(mask)
            for tag, im in (("hard", grown), ("soft", soft)):
                buf = io.BytesIO()
                im.save(buf, "PNG")
                (COMFY / "input" / f"ab-{name}-{tag}.png").write_bytes(buf.getvalue())

            # The region the page makes from a SAM hit: the mask's box, holding
            # what the person typed about it, marked as SAM's cut. Through the
            # validator and the caption composer, so every arm reads what a real
            # inpaint reads.
            x1, y1, x2, y2 = case["bbox"]
            row = {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1,
                   "prompt": case["edit"]}
            regions = _validate_regions([{**row, "segment": True}])
            caption = _compose_caption(case["prompt"], regions)
            # The same box read as a performer to place — what every inpaint
            # composed before a region knew it was a segment, and the caption
            # that painted a figure beside the lamp case's glass.
            performer = _validate_regions([row])
            figure = _compose_caption(case["prompt"], performer)
            batch = int(case.get("batch", 1))
            def sampled(text: str, rows: list[dict], mask_file: str) -> dict:
                return _graph(text, seed, rows,
                              {"inpaint_image": f"ab-{name}-source.png",
                               "inpaint_mask": mask_file}, batch)
            soft_file = f"ab-{name}-soft.png"
            plan = {"paste": (_graph(caption, seed, regions, None, batch), feathered),
                    "hard": (sampled(caption, regions, f"ab-{name}-hard.png"), feathered),
                    "soft": (sampled(caption, regions, soft_file), soft),
                    "figure": (sampled(figure, performer, soft_file), soft),
                    "plain": (sampled(f"{case['prompt'].rstrip('.')}. "
                                      f"{case['edit'].rstrip('.')}.",
                                      regions, soft_file), soft),
                    "unrouted": (sampled(figure, [], soft_file), soft)}
            plan = {k: v for k, v in plan.items() if k in arms_wanted}

            arms = {}
            # Rotated per case so a container drifting warmer does not hand the
            # drift to one arm.
            order = list(plan)
            k = len(results) % len(order)
            for arm in order[k:] + order[:k]:
                graph, alpha = plan[arm]
                names = self._run(f"{arm}-{name}", graph)
                pics = []
                for n in names:
                    with Image.open(COMFY / "output" / n) as im:
                        # Each arm's own composite, so none is scored on
                        # something its version of the job would never show.
                        out = Image.composite(im.convert("RGB"), source, alpha)
                    buf = io.BytesIO()
                    out.save(buf, "PNG")
                    pics.append({"png": base64.b64encode(buf.getvalue()).decode(),
                                 **_seam(out, source, mask, soft)})
                arms[arm] = pics
                print(f"[ab-inpaint] {name} {arm}: "
                      + ", ".join(f"edge {p['edge']:+.3f} light {p['light']:+.3f}"
                                  for p in pics), flush=True)
            results.append({"name": name, "caption": caption, "figure": figure,
                            "arms": arms})
        return results


@ab.local_entrypoint()
def main(stage: str = "sources", out: str = "out/inpaint", cases: str = "",
         seed: int = SEED, arms: str = ",".join(ARMS)):
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if stage == "sources":
        for name, b64 in Bench().sources.remote(PROMPTS, seed).items():
            p = out_dir / f"{name}_source.png"
            p.write_bytes(base64.b64decode(b64))
            print(f"saved {p}")
        print("\nLook at them, then write the cases file: "
              '[{"name", "prompt", "click": [x, y], "edit"}] — click in 0..1.')
        return

    if stage != "compare" or not cases:
        raise SystemExit("--stage compare needs --cases <json file>.")

    segmenter = Sam()
    todo = []
    for case in json.loads(Path(cases).read_text()):
        source = (out_dir / f"{case['name']}_source.png").read_bytes()
        hit = segmenter.segment.remote(source, *case["click"])
        (out_dir / f"{case['name']}_mask.png").write_bytes(base64.b64decode(hit["mask"]))
        print(f"mask {case['name']}: score {hit['score']:.3f} bbox "
              f"{[round(v, 3) for v in hit['bbox']]}")
        todo.append({**case, "source": base64.b64encode(source).decode(),
                     "mask": hit["mask"], "bbox": hit["bbox"]})

    wanted = [a for a in arms.split(",") if a]
    unknown = sorted(set(wanted) - set(ARMS))
    if unknown:
        raise SystemExit(f"Unknown arm(s) {unknown}; the arms are {list(ARMS)}.")
    rows = Bench().compare.remote(todo, seed, wanted)
    totals: dict[str, list[dict]] = {a: [] for a in wanted}
    scores: list[dict] = []
    for row in rows:
        for arm, pics in row["arms"].items():
            for i, pic in enumerate(pics):
                suffix = ARMS[arm]
                tag = row["name"] + (f"-{i}" if len(pics) > 1 else "")
                (out_dir / f"{tag}_{suffix}.png").write_bytes(base64.b64decode(pic["png"]))
                totals[arm].append(pic)
                scores.append({"picture": f"{tag}_{suffix}.png", "arm": arm,
                               "seed": seed, "edge": pic["edge"],
                               "light": pic["light"]})
    (out_dir / "briefs.json").write_text(json.dumps(
        {r["name"]: {"caption": r["caption"], "figure": r["figure"]}
         for r in rows}, indent=2))
    (out_dir / "scores.json").write_text(json.dumps(scores, indent=2))

    print(f"\n{'arm':<8} {'n':>2} {'edge':>8} {'light':>8}   (excess over source; lower is better)")
    for arm, pics in totals.items():
        n = len(pics)
        print(f"{arm:<8} {n:>2} {sum(p['edge'] for p in pics) / n:>+8.3f} "
              f"{sum(p['light'] for p in pics) / n:>+8.3f}")

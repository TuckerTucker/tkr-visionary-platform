"""
Does sampling from the source make a better inpaint than pasting a fresh frame?

    modal run tools/ab_inpaint.py --stage sources --out out/inpaint
    modal run tools/ab_inpaint.py --stage compare --out out/inpaint --cases cases.json

`_krea2_graph` used to render an inpaint from an empty latent and paste only the
masked area back, so the model drew the region for a frame it was never shown.
It now encodes the source and noises only inside the mask (`SetLatentNoiseMask`).
That was decided from the mechanism — backlog work-UvrttALb — and a mechanism is
not a measurement. This renders the same edit both ways, one seed, one caption,
one mask, with where sampling starts as the only variable, and pastes both
through the same feathered composite the job uses.

Two stages, because the mask has to come from SAM clicking on a render, and the
point worth clicking is only known once the render has been looked at:

  sources   renders one plain picture per prompt and saves it.
  compare   takes `[{name, prompt, click: [x, y], edit, batch?}]`, gets a SAM
            mask for each click and renders both arms at that mask.

**Two numbers per arm, both excess over the source along the mask's edge**, so a
seam the source already had is not charged to either arm:

  edge   mean luminance gradient in a band straddling the boundary — a hard,
         visible line.
  light  the same after a wide blur — a step in light or colour across the edge
         that the feather hides from `edge` and not from an eye.

Lower is better for both. They measure the seam and nothing else: whether the
edit shows what was asked for is a question for eyes or `judge_renders.py`, which
is why the pictures are saved as `<name>_bare.png` (paste) beside
`<name>_rich.png` (sampled) — the pair layout that tool reads.

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
    INPAINT_FEATHER_PX,
    KREA2_DEFAULTS,
    _Comfy,
    _compose_caption,
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

# The band either side of the boundary the numbers are read over, and the blur
# that turns `edge` into `light`. The band is wider than the feather so the
# whole blend is inside it; the blur is wide enough that texture averages out
# and only a change of level survives.
BAND_PX = INPAINT_FEATHER_PX + 4
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


def _seam(result, source, mask) -> dict[str, float]:
    """`edge` and `light` for one result, as excess over the source."""
    import numpy as np
    from PIL import ImageFilter

    size = 2 * BAND_PX + 1
    band = (np.asarray(mask.filter(ImageFilter.MaxFilter(size)), dtype=bool)
            & ~np.asarray(mask.filter(ImageFilter.MinFilter(size)), dtype=bool))

    def grad(im, blur: int) -> float:
        lum = im.convert("L")
        if blur:
            lum = lum.filter(ImageFilter.GaussianBlur(blur))
        a = np.asarray(lum, dtype=np.float32)
        gy, gx = np.gradient(a)
        return float(np.hypot(gx, gy)[band].mean())

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
    def compare(self, cases: list[dict[str, Any]], seed: int) -> list[dict]:
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
            alpha = mask.filter(ImageFilter.GaussianBlur(INPAINT_FEATHER_PX))

            # The region the page makes from a SAM hit: the mask's box, holding
            # what the person typed about it. Through the validator and the
            # caption composer, so both arms read what a real inpaint reads.
            x1, y1, x2, y2 = case["bbox"]
            regions = _validate_regions([{
                "x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1,
                "prompt": case["edit"]}])
            caption = _compose_caption(case["prompt"], regions)
            inpaint = {"inpaint_image": f"ab-{name}-source.png",
                       "inpaint_mask": f"ab-{name}-mask.png"}
            batch = int(case.get("batch", 1))

            arms = {}
            # Alternated per case so a container drifting warmer does not
            # hand the drift to one arm.
            order = ("paste", "sampled") if len(results) % 2 == 0 \
                else ("sampled", "paste")
            for arm in order:
                graph = _graph(caption, seed, regions,
                               inpaint if arm == "sampled" else None, batch)
                names = self._run(f"{arm}-{name}", graph)
                pics = []
                for n in names:
                    with Image.open(COMFY / "output" / n) as im:
                        # The job's own composite, so neither arm is scored on
                        # something a real inpaint would never show.
                        out = Image.composite(im.convert("RGB"), source, alpha)
                    buf = io.BytesIO()
                    out.save(buf, "PNG")
                    pics.append({"png": base64.b64encode(buf.getvalue()).decode(),
                                 **_seam(out, source, mask)})
                arms[arm] = pics
                print(f"[ab-inpaint] {name} {arm}: "
                      + ", ".join(f"edge {p['edge']:+.3f} light {p['light']:+.3f}"
                                  for p in pics), flush=True)
            results.append({"name": name, "caption": caption, "arms": arms})
        return results


@ab.local_entrypoint()
def main(stage: str = "sources", out: str = "out/inpaint", cases: str = "",
         seed: int = SEED):
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

    rows = Bench().compare.remote(todo, seed)
    totals: dict[str, list[dict]] = {"paste": [], "sampled": []}
    for row in rows:
        for arm, pics in row["arms"].items():
            for i, pic in enumerate(pics):
                suffix = "bare" if arm == "paste" else "rich"
                tag = row["name"] + (f"-{i}" if len(pics) > 1 else "")
                (out_dir / f"{tag}_{suffix}.png").write_bytes(base64.b64decode(pic["png"]))
                totals[arm].append(pic)
    (out_dir / "briefs.json").write_text(json.dumps(
        {r["name"]: r["caption"] for r in rows}, indent=2))

    print(f"\n{'arm':<8} {'n':>2} {'edge':>8} {'light':>8}   (excess over source; lower is better)")
    for arm, pics in totals.items():
        n = len(pics)
        print(f"{arm:<8} {n:>2} {sum(p['edge'] for p in pics) / n:>+8.3f} "
              f"{sum(p['light'] for p in pics) / n:>+8.3f}")

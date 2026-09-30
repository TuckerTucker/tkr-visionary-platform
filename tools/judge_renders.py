"""
Score the picture, not the text. The last proxy removed.

Everything else that measures this feature is one remove from the thing it is
about. A text judge scores a rewrite against the sentence it came from;
`--judge` scores the rewritten prompt against the original description, which is
better and is still text. All four criteria are finally about a **render**, and
until something reads the render they are being answered by proxy.

`does_it_help.py` produces the pairs — the same fragment rendered bare and
rendered from what the model wrote, one seed, one size, the sentence as the only
variable. This reads those pairs and says which one better realises what the
person asked for.

    python3.11 tools/judge_renders.py --pairs out/            # local vLLM
    python3.11 tools/judge_renders.py --pairs out/ --backend http://…/v1
    python3.11 tools/judge_renders.py --pairs out/scene-ab --rubric scene \\
        --briefs out/scene-ab/briefs.json

**A clip is judged as a contact sheet.** `ab_scene.py` writes each clip as six
frames in time order, and `--rubric scene` tells the judge so and asks the
question a still rubric has no words for — are the shots there, in order, with
the same people in them. Where a scene has pictures, `<name>_cast.png` goes in
ahead of both sheets, identical in both orders, because likeness cannot be
judged without the likeness. What it cannot do is listen: nothing about a
clip's sound reaches this judge.

**The ties were the instrument, not the pairs.** On the first scene run
(2026-09-29, 10 pairs) all six ties were the 4B answering "A" in both orders.
It never split on a close pair; it went to position whenever the sheets did not
settle it. So on sheets, a tie from this judge means *undecided* rather than
*close*. That is what the both-orders rule exists to catch, and it is why the
scene result was also read by eye.

**The VLM variant of the same family**, which is the cheap part of this and the
reason it is worth doing at all: `docs/vendor-parse-model.md` already pins
`Qwen/Qwen3-VL-4B-Instruct` as the encoder the parse writes for. Serving it costs
the same L4 the parse costs, and it is not the model being judged — the parse
runs on the abliterated text-only fork, so this is a different checkpoint reading
a different modality, which is the separation `--judge` had to arrange
deliberately and this gets for free.

## What makes the verdict worth having

**Blind, by construction.** The two images go in as A and B in an order fixed by
a hash of the pair's name, and the prompts are never shown. The judge cannot know
which is the replacement, so it cannot prefer one for being longer, more
detailed, or more like a prompt — it can only prefer the picture. Every other
measurement in this repo could be gamed by writing more; this one cannot.

**Both directions of the same question.** A judge asked "which is better" will
pick one, always, and a coin flip reported as a preference is worse than no
number. So each pair is asked twice with the order swapped, and a pair only
counts as decided when both answers agree. Disagreement is reported as a tie
rather than resolved, because a judge that changes its mind when the images swap
places is telling you the two pictures are close.

**A quote, or it did not happen.** The verdict carries what in the image decided
it. The discipline is `--judge`'s and the reason is the same: a judge that cannot
point at the thing it marked has usually invented it.
"""

import argparse
import base64
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

RUBRIC = """\
You are shown two images, A and B, made from the same brief by different means.
Decide which one better realises the brief.

THE BRIEF: {brief}

Judge only these, in this order:
1. Does the image show what the brief asks for, including any state the brief
   implies? "After the party" means the party is over.
2. Is the feeling of the brief staged in the picture, rather than absent?
3. Do the things in the frame stand in a deliberate arrangement, or is the
   picture a list of objects?
4. Are the literal, specific facts of the brief present and correct?

Ignore which image looks more elaborate. A picture with more things in it is not
better; a picture that answers the brief is. If neither is clearly better, say
"tie" — that is a real answer and is preferred to a guess.

Return JSON: {{"winner": "A"|"B"|"tie", "because": "<one sentence naming what in
the winning image decided it>", "against": "<one sentence naming what the other
image got wrong or missed>"}}
"""

# The same judge for a video clip, which it cannot watch. Each of A and B is a
# contact sheet — six frames sampled evenly through one clip — so what it can
# still see is the axis a scene is about: which shot is on screen when, and who
# is in it. Criterion 1 is the one a still rubric has no words for, which is
# the reason this is a second rubric rather than a sentence added to the first.
SCENE_RUBRIC = """\
You are shown two short video clips, A and B, made from the same brief by
different means. You cannot watch them: each is a contact sheet of six frames
sampled evenly through the clip, numbered 1 to 6 in time order, left to right
and top to bottom. {cast}Decide which clip better realises the brief.

THE BRIEF: {brief}

Judge only these, in this order:
1. Does the clip show each shot the brief asks for, in the order it gives them?
   Where the brief has two shots, the early frames should show the first and
   the late frames the second.
2. Are the named people there, and are they recognisably the same people from
   frame to frame? Where cast photographs are given, does each named person
   look like their own photograph and not like somebody else's?
3. Do the people and things stand in the arrangement the brief describes — who
   is doing what, with or to whom?
4. Are the literal, specific facts of the brief present and correct?

Ignore which clip looks more elaborate or more polished. If neither is clearly
better, say "tie" — that is a real answer and is preferred to a guess.

Return JSON: {{"winner": "A"|"B"|"tie", "because": "<one sentence naming what in
the winning clip's frames decided it>", "against": "<one sentence naming what
the other clip got wrong or missed>"}}
"""

CAST_NOTE = ("Before the clips you are shown the cast: one photograph per named "
             "person, labelled with their name. ")

RUBRICS = {"still": RUBRIC, "scene": SCENE_RUBRIC}
# What `_rich` and `_bare` are called in the tally, per rubric — the files are
# named for the harness that wrote them, and the reader wants the arms.
ARMS = {"still": ("replacement", "bare"), "scene": ("composer", "prose")}


# Long edge in pixels before the image is sent. Qwen3-VL tiles an image into
# patches, so a 1152x864 render is thousands of vision tokens and *two* of them
# overrun a 16k window before a word of the rubric is read — which does not
# arrive as a context error, it arrives as a server that dies mid-decode and a
# Sandbox that terminates with no log. 768 is comfortably inside the window and
# is far more than the questions need: every one of the four criteria is about
# composition, staging and whether a named thing is present, and none of them is
# decided by detail this throws away.
JUDGE_LONG_EDGE = 768


def data_uri(path: Path) -> str:
    """The image, downscaled and re-encoded as JPEG, as a data URI."""
    try:
        from PIL import Image
    except ImportError:  # judged without Pillow: send it as it lies
        kind = "png" if path.suffix.lower() == ".png" else "jpeg"
        return f"data:image/{kind};base64," + base64.b64encode(path.read_bytes()).decode()

    import io
    with Image.open(path) as im:
        im = im.convert("RGB")
        if max(im.size) > JUDGE_LONG_EDGE:
            scale = JUDGE_LONG_EDGE / max(im.size)
            im = im.resize((round(im.width * scale), round(im.height * scale)),
                           Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def ask(base_url: str, model: str, brief: str, first: Path, second: Path,
        timeout: float = 300.0, rubric: str = "still",
        cast: Path | None = None) -> dict:
    """One verdict. `first` is shown as A and `second` as B — the caller decides.

    `cast`, when there is one, goes in ahead of both and is the same file in
    both orders, so it can inform the verdict and cannot bias it.
    """
    text = (RUBRIC.format(brief=brief) if rubric == "still" else
            RUBRICS[rubric].format(brief=brief, cast=CAST_NOTE if cast else ""))
    content: list[dict] = [{"type": "text", "text": text}]
    if cast:
        content += [{"type": "text", "text": "The cast:"},
                    {"type": "image_url", "image_url": {"url": data_uri(cast)}}]
    noun = "Image" if rubric == "still" else "Clip"
    content += [
        {"type": "text", "text": f"{noun} A:"},
        {"type": "image_url", "image_url": {"url": data_uri(first)}},
        {"type": "text", "text": f"{noun} B:"},
        {"type": "image_url", "image_url": {"url": data_uri(second)}},
    ]
    body = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 400,
        "temperature": 0.0,
    }
    req = urllib.request.Request(
        f"{base_url}/chat/completions", json.dumps(body).encode(),
        {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        said = json.load(r)["choices"][0]["message"]["content"]
    # The rubric asks for JSON and a 4B does not always oblige on the first
    # token. Pull the first object out rather than failing the pair — a judge
    # that answers well in a code fence is not a judge that failed.
    match = re.search(r"\{.*\}", said, re.S)
    if not match:
        return {"winner": "tie", "because": "", "against": "", "raw": said[:200]}
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"winner": "tie", "because": "", "against": "", "raw": said[:200]}


def pairs_in(folder: Path) -> list[tuple[str, Path, Path]]:
    """`<name>_bare.png` beside `<name>_rich.png`, which is what `does_it_help` writes."""
    out = []
    for bare in sorted(folder.glob("*_bare.png")):
        rich = bare.with_name(bare.name.replace("_bare.png", "_rich.png"))
        if rich.exists():
            out.append((bare.name[: -len("_bare.png")], bare, rich))
    return out


def briefs_from(dump: Path | None) -> dict[str, str]:
    """The person's own fragment, keyed the way the harness named its files.

    Two shapes: an `--enrich` dump, keyed the way `does_it_help.py` derives a
    name from the prose, or a JSON object of name to brief, which is what
    `ab_scene.py` and `ab_inpaint.py` write — they name their own pairs, so
    there is nothing to derive.
    """
    if not dump:
        return {}
    if dump.suffix == ".json":
        return {str(k): str(v) for k, v in json.loads(dump.read_text()).items()}
    out = {}
    for line in dump.read_text().splitlines():
        if not line.startswith("ENRICH "):
            continue
        row = json.loads(line[7:])
        name = "".join(c if c.isalnum() else "_" for c in row["prose"])[:24]
        out[name] = row["prose"]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", required=True, type=Path,
                    help="A folder of <name>_bare.png / <name>_rich.png")
    ap.add_argument("--briefs", type=Path, default=None,
                    help="The `--enrich` dump the pairs were rendered from, so "
                         "the judge is given the person's fragment rather than "
                         "a filename.")
    ap.add_argument("--backend", default="http://localhost:8000/v1")
    ap.add_argument("--model", default="Qwen/Qwen3-VL-4B-Instruct")
    ap.add_argument("--rubric", choices=sorted(RUBRICS), default="still",
                    help="`scene` when each image is a contact sheet of a clip, "
                         "as `ab_scene.py` writes them; a `<name>_cast.png` "
                         "beside a pair is then shown to the judge first.")
    args = ap.parse_args()

    found = pairs_in(args.pairs)
    if not found:
        print(f"no *_bare.png / *_rich.png pairs in {args.pairs}", file=sys.stderr)
        return 1
    briefs = briefs_from(args.briefs)

    print(f"backend {args.backend}\nmodel   {args.model}\npairs   {len(found)}\n")
    print("  Each pair judged twice with the order swapped. A win counts only")
    print("  when both orders agree; disagreement is a tie, not a tiebreak.\n")

    rich_arm, bare_arm = ARMS[args.rubric]
    wins = {"rich": 0, "bare": 0, "tie": 0}
    for name, bare, rich in found:
        brief = briefs.get(name) or name.replace("_", " ")
        cast = bare.with_name(f"{name}_cast.png")
        cast = cast if args.rubric == "scene" and cast.exists() else None
        # The order is fixed per pair rather than random, so a re-run of this
        # harness on the same folder gives the same answer — the property
        # `--judge` is kept for and the one reading by hand never had.
        rich_first = int(hashlib.sha1(name.encode()).hexdigest(), 16) % 2 == 0
        a, b = (rich, bare) if rich_first else (bare, rich)

        first = ask(args.backend.rstrip("/"), args.model, brief, a, b,
                    rubric=args.rubric, cast=cast)
        second = ask(args.backend.rstrip("/"), args.model, brief, b, a,
                     rubric=args.rubric, cast=cast)

        def side(v: dict, flipped: bool) -> str:
            w = str(v.get("winner", "tie")).strip().upper()
            if w not in ("A", "B"):
                return "tie"
            is_rich = (w == "A") == (rich_first != flipped)
            return "rich" if is_rich else "bare"

        one, two = side(first, False), side(second, True)
        verdict = one if one == two else "tie"
        wins[verdict] += 1
        mark = {"rich": rich_arm.upper(), "bare": bare_arm,
                "tie": "tie"}[verdict].ljust(11)
        print(f"  {mark} {name}: {brief[:52]}")
        # Both verdicts, whole, whatever the outcome: a scene is judged on four
        # criteria at once and a one-line reason for a tie is the part a person
        # spot-checking the sheets needs most.
        for order, v in (("A/B", first), ("B/A", second)):
            print(f"      {order} {v.get('winner', '?')}: because "
                  f"{v.get('because', '')[:160]} | against "
                  f"{v.get('against', '')[:160]}"
                  + (f" | raw {v['raw']}" if v.get("raw") else ""))
        if verdict == "tie" and one != two:
            print(f"      (order-dependent: {one} then {two} — the pair is close)")

    n = len(found)
    print()
    for key, label in (("rich", f"{rich_arm} wins"), ("bare", f"{bare_arm} wins"),
                       ("tie", "tie")):
        print(f"  {label:<18}{wins[key]}/{n}")
    print("\n  Read this as the only measurement here that is not a proxy — and")
    print("  read a tie as a tie. A pair the judge flips on is two pictures that")
    print("  are genuinely close, which is a result about the feature rather")
    print("  than a failure of the instrument.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

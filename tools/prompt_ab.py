"""
Does this prompt beat that one? One command, judged by looking at the pictures.

**The only measurement of this feature that is not a proxy.** Everything else
scores text against text — preserved, covered, round-tripped, idempotent — and a
prompt can pass every one of those and make a worse picture, which is what
happened: the semantic layer scored as maximum restraint and lost 0-4 to doing
nothing. This renders both and has a vision model say which one answered the
brief.

    python3.11 tools/prompt_ab.py --scene                     # the scene composer
    python3.11 tools/prompt_ab.py --url https://…modal.run --from enrich.jsonl

Three stages, and the two halves already existed — this is the one command that
runs them in order, which is the whole of what it adds:

  1. A renderer writes `<name>_bare.png` beside `<name>_rich.png`.
  2. `serve_judge.py --pairs` serves a vision model in a throwaway Sandbox.
  3. `judge_renders.py` scores the pairs inside it.

**Two subjects, and the renderer is what differs.**

`--scene` measures the scene composer, which is the claim this command was
written for: `ab_scene.py` renders each scene twice on H3 — the composer's
compiled document, and the same words typed into one box — and writes a contact
sheet per clip, which the judge reads under `--rubric scene`. It runs inside
Modal against the app's own compiler and graph, so it needs no deployment and
no password. First run 2026-09-29; the result is in the README's coverage
ledger.

Without `--scene` it is the older experiment: `does_it_help.py` renders a Krea 2
fragment bare and rewritten against a deployed app. `--from` takes a JSONL of
`{name, prose, compiled}`, so the rewritten half is what a model actually wrote
rather than what somebody hoped it would write. That distinction is not
academic: hand-written replacements won their pairs and every model-written one
lost. **That path sends no cookie**, and every route on a deployment is behind
the password now, so against a live URL it is refused at the gate — it predates
the gate.

## Reading the result

**A tie is a tie.** Each pair is judged twice with the images swapped and counts
only when both orders agree, so a judge with positional bias scores all ties and
no wins — verified against stub oracles rather than assumed. A pair it flips on
is two pictures that are genuinely close.

**The judge is not the subject.** It is a different checkpoint and a different
modality from the model being scored, which is the separation that keeps a model
from marking its own work.

**It is an instrument, not an oracle.** Spot-check by looking. What earns it its
place is not that it is right, it is that it is repeatable, which reading by
hand is not.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(cmd: list[str]) -> int:
    print(f"\n$ {' '.join(cmd)}\n", flush=True)
    return subprocess.call(cmd)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Render a prompt pair and judge which picture answered the brief.")
    ap.add_argument("--url", default=None,
                    help="The deployed web URL. Not used by --scene.")
    ap.add_argument("--scene", action="store_true",
                    help="Measure the scene composer: ab_scene.py renders each "
                         "scene as prose and as the composer's document, and "
                         "the judge reads contact sheets of the clips.")
    ap.add_argument("--from", dest="dump", default=None,
                    help="An --enrich / rewrite JSONL. Omit for the built-in pairs.")
    ap.add_argument("--out", default=None,
                    help="Where the renders land, and what the judge reads. "
                         "tools/ab-pairs, or out/scene-ab with --scene.")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--seed", type=int, default=774411)
    ap.add_argument("--only", default="",
                    help="With --scene, a comma list of scene names to render.")
    ap.add_argument("--judge-model", default="Qwen/Qwen3-VL-4B-Instruct",
                    help="A *vision* model, and deliberately not the one being judged.")
    ap.add_argument("--gpu", default="L4")
    ap.add_argument("--render-only", action="store_true",
                    help="Stop after the pictures — useful when you want to look "
                         "before spending a Sandbox on the judge.")
    ap.add_argument("--judge-only", action="store_true",
                    help="Judge what is already in --out, without rendering — "
                         "for a second look by a different judge, or after "
                         "--render-only.")
    args = ap.parse_args()
    if not args.scene and not args.url:
        ap.error("--url is required unless --scene")

    out = Path(args.out or ("out/scene-ab" if args.scene else "tools/ab-pairs"))
    if args.scene:
        # `modal run`, not a request to the deployment: the composer's
        # documents are compiled and rendered by the app's own functions inside
        # Modal, which is what lets this run without the password.
        render = ["modal", "run", str(ROOT / "tools" / "ab_scene.py"),
                  "--stage", "render", "--out", str(out),
                  "--seed", str(args.seed)]
        if args.only:
            render += ["--only", args.only]
    else:
        render = [sys.executable, str(ROOT / "tools" / "does_it_help.py"),
                  "--url", args.url, "--out", str(out),
                  "--limit", str(args.limit), "--seed", str(args.seed)]
        if args.dump:
            render += ["--from", args.dump]
    if not args.judge_only and (code := run(render)):
        print("render failed; not judging half a set", file=sys.stderr)
        return code

    pairs = sorted(out.glob("*_bare.png"))
    if not pairs:
        print(f"no pairs in {out} — nothing to judge", file=sys.stderr)
        return 1
    print(f"\n{len(pairs)} pairs rendered into {out}")
    if args.render_only:
        return 0

    judge = [sys.executable, str(ROOT / "tools" / "serve_judge.py"),
             "--pairs", str(out), "--model", args.judge_model, "--gpu", args.gpu]
    if args.scene:
        judge += ["--rubric", "scene", "--briefs", str(out / "briefs.json")]
    elif args.dump:
        judge += ["--briefs", args.dump]
    return run(judge)


if __name__ == "__main__":
    raise SystemExit(main())

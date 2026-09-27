"""
Ask whether every pinned wheel in app.py still exists, before a deploy does.

    python3 tools/smoke_pins.py                 # the web pins, then every image
    python3 tools/smoke_pins.py trainer_image   # one image
    python3 tools/smoke_pins.py web             # the web pins only; no Modal

`modal deploy app.py` answers this question too, in about twenty minutes, by
downloading tens of gigabytes and compiling CUDA kernels — and then reporting
the answer as an image id and four interleaved logs. This asks it in about a
minute by resolving the pins and installing nothing.

**Why it runs remotely rather than on your laptop.** The obvious version is a
local `pip install --dry-run --platform manylinux2014_x86_64`, and it looks
like it works: it fails before a bad pin is fixed and passes after. It is
lying. With `--platform`, pip cannot evaluate `platform_system == "Linux"`
markers against a Darwin host, so it silently drops every `nvidia-*`
dependency — which is the exact class this file exists to catch. It failed for
a different reason than the deploy did. So the resolve happens in a Sandbox on
the image's own base layer: same OS, same interpreter, same indexes, and none
of the cost, because `--dry-run` downloads metadata rather than wheels.

**What it catches**, and it is one specific thing that has happened here: a
pinned version disappearing from the index that serves it. torch 2.5.1 requires
`nvidia-cudnn-cu12==9.1.0.70`; the PyTorch index is a proxy whose listing for
that package is a page of hrefs pointing at pypi.nvidia.com; NVIDIA pruned the
file; the listing lost the version; the build died naming a package app.py does
not mention. Nothing in the repo had changed.

**What it does not catch.** Each pip group is resolved against the bare base
rather than against the layers before it, so this answers "do these pins still
exist and agree with each other" and not "does the whole image converge". And
pins installed through `run_commands` — ComfyUI's requirements.txt, musubi's
`pip install -e .` — are invisible to it, because they are shell strings rather
than arguments. Both are deliberate: the failure being guarded against is
upstream deletion, which hits the declared pins first and hardest.

The pin lists are read out of app.py by AST rather than copied, for the reason
`_from_app.py` exists: a second list of versions is a list that drifts, and a
checker checking a copy is checking the copy.

**What it printed on the first run that is worth acting on.** `trainer_image`
now carries a pypi.org fallback because it was the one that broke;
`caption_image` and `comfy_image` name a PyTorch index with no fallback at all,
so they are exposed to exactly the same deletion. They resolve today. That is
the difference between a checker and a fix, and this file is only the checker.

**The web pins are checked here too, and locally.** `@openvideo/core` and
`@openvideo/engine-pixi` are built into the image with the rest of `web/`.
They are published from a monorepo, so the SHA the root rule asks for would
mean building them from source; an exact npm version is the equivalent, because
a published version cannot be re-pointed — but only if the manifest says `1.4.0`
and not `^1.4.0`, and only if the lockfile carries the integrity hash that makes
a re-uploaded tarball fail `npm ci` rather than install. Both are properties of
two files in the repo, so this needs no Sandbox and no Modal: `web` runs it
alone, and every other invocation runs it first because it costs nothing.

It also holds `OPENVIDEO_PIN` in `web/src/edit/engine.ts` equal to the pinned
core. The page writes that string into every arrangement it saves as the version
the IProject was written at; a bump that forgot it would mislabel every save
after it, silently, which is the failure a reader years later cannot undo.
"""
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app.py"
WEB = ROOT / "web"

# The web packages pinned exactly, and the one whose version the page records.
WEB_PINS = ("@openvideo/core", "@openvideo/engine-pixi")
WEB_PIN_RECORDED = "@openvideo/core"
EXACT = re.compile(r"^\d+\.\d+\.\d+$")


def _const(node):
    """Literal args only. A pin built by an expression is one this cannot read,
    and reporting it as absent would be worse than skipping it."""
    return node.value if isinstance(node, ast.Constant) else None


def images():
    """Every `*_image = modal.Image...` in app.py, with its base and pin groups."""
    tree = ast.parse(APP.read_text())
    out = {}
    for node in tree.body:
        if not (isinstance(node, ast.Assign)
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id.endswith("_image")):
            continue

        # The chain is built inside-out, so walk to the root and reverse.
        calls, cur = [], node.value
        while isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute):
            calls.append(cur)
            cur = cur.func.value
        calls.reverse()

        base, groups = None, []
        for call in calls:
            name = call.func.attr
            kw = {k.arg: _const(k.value) for k in call.keywords}
            if name == "from_registry":
                base = {"kind": "registry", "ref": _const(call.args[0]),
                        "python": kw.get("add_python")}
            elif name == "debian_slim":
                base = {"kind": "slim", "python": kw.get("python_version")}
            elif name == "pip_install":
                pkgs = [p for p in (_const(a) for a in call.args) if p]
                if pkgs:
                    groups.append({"pkgs": pkgs,
                                   "index_url": kw.get("index_url"),
                                   "extra_index_url": kw.get("extra_index_url")})
        if base and groups:
            out[node.targets[0].id] = {"base": base, "groups": groups}
    return out


def web_pins():
    """Every problem with the web pins, as sentences. Empty means pinned.

    Each line names the file, the package and what was found, because the fix
    differs by which of the three is wrong: a range is edited in package.json, a
    missing hash is a lockfile regenerated with `npm install`, and a drifted
    OPENVIDEO_PIN is one line in engine.ts."""
    bad = []
    manifest = json.loads((WEB / "package.json").read_text())
    lock = json.loads((WEB / "package-lock.json").read_text())
    deps = {**manifest.get("devDependencies", {}), **manifest.get("dependencies", {})}
    pinned = {}
    for name in WEB_PINS:
        want = deps.get(name)
        if want is None:
            bad.append(f"web/package.json: {name} is not a dependency")
            continue
        if not EXACT.match(want):
            bad.append(f"web/package.json: {name} is {want!r}, not an exact "
                       f"version — a range lets the next `npm install` move it")
            continue
        pinned[name] = want
        entry = lock.get("packages", {}).get(f"node_modules/{name}")
        if entry is None:
            bad.append(f"web/package-lock.json: no entry for {name}")
            continue
        if entry.get("version") != want:
            bad.append(f"web/package-lock.json: {name} is locked at "
                       f"{entry.get('version')!r} but package.json pins {want!r}")
        if not str(entry.get("integrity", "")).startswith("sha512-"):
            bad.append(f"web/package-lock.json: {name} has no sha512 integrity "
                       f"hash, so a re-uploaded tarball would install")

    engine = WEB / "src" / "edit" / "engine.ts"
    m = re.search(r"export const OPENVIDEO_PIN = '([^']*)'", engine.read_text()) \
        if engine.is_file() else None
    recorded = pinned.get(WEB_PIN_RECORDED)
    if m is None:
        bad.append(f"{engine.relative_to(ROOT)}: no `export const OPENVIDEO_PIN = '…'`")
    elif recorded and m.group(1) != recorded:
        bad.append(f"{engine.relative_to(ROOT)}: OPENVIDEO_PIN is {m.group(1)!r} "
                   f"but {WEB_PIN_RECORDED} is pinned at {recorded!r}")
    return bad


def check_web():
    print("\n=== web ===")
    bad = web_pins()
    if bad:
        for line in bad:
            print(f"  FAIL {line}")
    else:
        for name in WEB_PINS:
            print(f"  ok   {name} exact, with integrity")
        print("  ok   OPENVIDEO_PIN matches")
    return bad


def base_image(spec):
    import modal
    if spec["kind"] == "registry":
        return modal.Image.from_registry(spec["ref"], add_python=spec["python"])
    return modal.Image.debian_slim(python_version=spec["python"])


def command(groups):
    """One shell script, so one sandbox answers for the whole image."""
    lines = ["set -u"]
    for i, g in enumerate(groups):
        flags = ""
        if g["index_url"]:
            flags += f" --index-url {g['index_url']}"
        if g["extra_index_url"]:
            flags += f" --extra-index-url {g['extra_index_url']}"
        pkgs = " ".join(f"'{p}'" for p in g["pkgs"])
        lines += [
            f"echo '@@@ group {i}'",
            # --dry-run resolves and reports; --ignore-installed makes the base
            # layer's own packages irrelevant to the answer.
            f"pip install --dry-run --ignore-installed --quiet{flags} {pkgs}"
            f" >/dev/null 2>/tmp/err{i} && echo '@@@ ok' ||"
            f" {{ echo '@@@ FAIL'; tail -4 /tmp/err{i}; }}",
        ]
    return "\n".join(lines)


def check(name, spec, app):
    import modal
    print(f"\n=== {name} ===")
    for g in spec["groups"]:
        where = g["index_url"] or "pypi.org"
        extra = f" (+{g['extra_index_url']})" if g["extra_index_url"] else ""
        print(f"  {len(g['pkgs'])} pins from {where}{extra}")

    sb = modal.Sandbox.create(
        "sh", "-c", command(spec["groups"]),
        image=base_image(spec["base"]), app=app, timeout=900,
    )
    sb.wait()
    out = sb.stdout.read()

    bad = []
    idx = -1
    for line in out.splitlines():
        if line.startswith("@@@ group"):
            idx = int(line.split()[-1])
        elif line.startswith("@@@ ok"):
            print(f"  ok   group {idx}")
        elif line.startswith("@@@ FAIL"):
            bad.append(idx)
            print(f"  FAIL group {idx}: {', '.join(spec['groups'][idx]['pkgs'][:3])}…")
        elif bad and line.strip() and not line.startswith("@@@"):
            print(f"       {line.strip()[:150]}")
    return bad


def main():
    want = sys.argv[1:]
    web_bad = check_web() if not want or "web" in want else []
    want = [w for w in want if w != "web"]
    if sys.argv[1:] and not want:
        if web_bad:
            sys.exit("\nweb pins are not exact — see FAIL lines above")
        print("\nweb pins are exact")
        return

    # Imported here so `web` runs on a laptop without Modal installed.
    import modal

    found = images()
    if want:
        missing = [w for w in want if w not in found]
        if missing:
            sys.exit(f"no such image in app.py: {', '.join(missing)} "
                     f"(have: {', '.join(found)})")
        found = {k: v for k, v in found.items() if k in want}

    failed = {}
    app = modal.App("visionary-smoke-pins")
    with modal.enable_output(), app.run():
        for name, spec in found.items():
            bad = check(name, spec, app)
            if bad:
                failed[name] = bad

    print()
    if web_bad:
        print("web pins are not exact — see FAIL lines above", file=sys.stderr)
    if failed:
        for name, groups in failed.items():
            print(f"{name}: group(s) {groups} no longer resolve", file=sys.stderr)
        print("\nA pin that vanished is almost never yours to fix by changing the "
              "version — check whether the index still serves it, and give pip "
              "somewhere else to look before bumping anything.", file=sys.stderr)
        sys.exit(1)
    if web_bad:
        sys.exit(1)
    print(f"every declared pin still resolves ({len(found)} image(s))")


if __name__ == "__main__":
    main()

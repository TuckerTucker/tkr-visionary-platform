"""
Deploy this app, or say exactly why it should not be deployed right now.

    python3 tools/deploy.py             # gates, deploy, read the version back
    python3 tools/deploy.py --check     # the gates alone; nothing is deployed
    python3 tools/deploy.py --quick     # skip the CPU smoke when nothing wired changed
    python3 tools/deploy.py --watch     # …then follow the logs until a take answers

`modal deploy app.py` stays the whole install — this does not replace it, and
nothing here is required to ship. What it automates is the part that is not the
command: the four questions that have each already cost something.

**Can you name what is running?** `modal app history` records the commit a
version was built from and marks it `*` when the tree was dirty. v1 and v2 of
this app both read `65798d2*`, which is not an answer: a bug traced from the
outside could not be pinned to a source state, and a fix that looked deployed
was not. A tree you cannot name is refused.

**Is something in flight?** One generator container at a time, and a take is
minutes while a training run is longer. A redeploy replaces that container.
This reads the same `visionary-jobs` record the page polls and applies the same
liveness rule `_session_view` does — a status is a claim about a container that
may be gone, so it is only believed as far as its `beat`.

**Do the graphs still exist?** ComfyUI validates names after the container is
up, which for video is an H100 cold start behind up to 28.6 GB of weights.
`smoke_graphs.py` asks `/object_info` the same question on CPU with no weights,
and it builds both halves of the chain. A minute here or a cold start there.

**Did it land?** The motion-context fix was committed at 21:01 and a take ran at
21:13 against a build from 19:38 — the log said `no motion context saved` and
nothing on the machine said which version had printed it. The version is read
back after every deploy and checked against HEAD.

What this cannot do is tell you a clip is good. Only a render does that, and
`tools/chain_ab.py` is the one written for the chain specifically.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _from_app import pull  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# app.py's own name for itself and for the record the page polls. Literals here
# and literals there is the one duplication worth taking: pulling them through
# the AST to save two strings would make this tool fail to *start* for a reason
# unrelated to deploying.
APP_NAME = "visionary"
JOBS_DICT = "visionary-jobs"

# A record claiming to run is only believed this far past its last beat, which
# is app.py's rule rather than a second one invented here — a `_run` that has
# gone quiet for a cold image pull is fine, and calling it dead would block a
# deploy on a job that finished hours ago.
SESSION_STALE_S = pull({"SESSION_STALE_S"})["SESSION_STALE_S"]

# Statuses that mean a container is (or is about to be) doing work.
BUSY = ("queued", "running")

# Diff signals that make the two optional smokes worth their minute. Named, not
# clever: the point is that the tool can say *why* it chose to run one.
PIN_SIGNALS = ("pip_install", "run_commands", "_SHA", "add_local", "nodejs.org")
GRAPH_SIGNALS = ("_h3_graph", "_krea2_graph", "class_type", "graph[")


def sh(*cmd, **kw):
    """Run a command and hand back the completed process, output captured."""
    return subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True, **kw)


def modal_python() -> str:
    """
    An interpreter that can `import modal`, or "" when there is not one.

    The client is as often installed as an isolated tool (uv, pipx) as it is
    into the interpreter you happen to be running — and then `modal` is on PATH,
    deploys work, and `import modal` fails, which is a confusing way for a smoke
    test to die on a machine that is fine. The binary's shebang names the
    interpreter that definitely has it, so that is the second thing tried.
    """
    for python in (sys.executable, _shebang(shutil.which("modal"))):
        if python and subprocess.run([python, "-c", "import modal"],
                                     capture_output=True).returncode == 0:
            return python
    return ""


def _shebang(binary) -> str:
    if not binary:
        return ""
    try:
        first = Path(binary).read_text(errors="ignore").splitlines()[0]
    except (OSError, IndexError):
        return ""
    return first[2:].strip() if first.startswith("#!") else ""


def fail(*lines):
    for line in lines:
        print(line, file=sys.stderr)
    sys.exit(1)


# ── gate 1: a tree you can name ─────────────────────────────────────────────

def gate_named(args) -> str:
    """The HEAD sha, once the tree is one a deployment could be traced to."""
    dirty = sh("git", "status", "--porcelain").stdout.strip()
    head = sh("git", "rev-parse", "--short", "HEAD").stdout.strip()
    if dirty and not args.dirty:
        fail("The tree has uncommitted changes, so the deployment would record "
             f"{head}* and name a source state that exists nowhere:",
             *(f"    {line}" for line in dirty.splitlines()[:20]),
             "",
             "Commit them, or pass --dirty to deploy something you will not be "
             "able to check out later.")
    if dirty:
        print(f"·  tree is dirty; this will deploy as {head}* (--dirty)")
    else:
        print(f"·  tree is clean at {head}")
    return head


# ── gate 2: nothing in flight ───────────────────────────────────────────────

def gate_idle(args) -> None:
    """Refuse to pull the container out from under a job that is still running."""
    # **The CLI, not `import modal`.** The client is commonly installed as an
    # isolated tool (uv, pipx) whose interpreter is not the one running this,
    # so importing it fails on a machine that deploys perfectly well. The only
    # dependency worth having here is the binary the deploy itself needs.
    out = sh("modal", "dict", "items", JOBS_DICT, "--all", "--json")
    if out.returncode != 0:
        # A fresh account has no Dict yet, and a credentials problem will fail
        # the deploy in a moment with a better message than this one.
        print(f"·  could not read {JOBS_DICT} — deploying without the "
              f"in-flight check ({out.stderr.strip().splitlines()[-1:] or ['no reason given']})")
        return
    try:
        records = json.loads(out.stdout)
    except json.JSONDecodeError:
        print(f"·  {JOBS_DICT} did not come back as JSON — deploying without "
              f"the in-flight check")
        return

    now = time.time()
    live = []
    for entry in records:
        job_id, rec = entry.get("key"), entry.get("value")
        if not isinstance(rec, dict) or rec.get("status") not in BUSY:
            continue
        beat = float(rec.get("beat") or rec.get("started") or 0)
        age = now - beat
        if beat and age > SESSION_STALE_S:
            continue  # the container that wrote this is gone; see _session_view
        live.append((job_id, rec, age))

    if not live:
        print(f"·  nothing in flight ({len(records)} job records)")
        return
    if args.force:
        print(f"·  {len(live)} job(s) in flight, deploying anyway (--force)")
        return

    fail(f"{len(live)} job(s) are still running, and a deploy replaces the "
         f"container running them:",
         *(f"    {jid}  {rec.get('status')}  {rec.get('phase') or '—'}  "
           f"{rec.get('percent') or 0}%  last beat {int(age)}s ago"
           for jid, rec, age in live),
         "",
         "Let them finish, stop them in the app, or pass --force to end them "
         "mid-run.")


# ── gate 3: the graphs are still wired to nodes that exist ──────────────────

def deployed_commit() -> str:
    """The sha the live version was built from, or "" when there is no answer."""
    out = sh("modal", "app", "history", APP_NAME, "--json")
    if out.returncode != 0:
        return ""
    try:
        rows = json.loads(out.stdout)
    except json.JSONDecodeError:
        return ""
    if not rows:
        return ""
    # The trailing `*` means that version was built from a dirty tree, so its
    # sha is a lower bound on what shipped rather than a description of it.
    return str(rows[0].get("commit") or "").rstrip("*")


def changed_since(sha: str):
    """
    The diff the live deployment has not seen, or None when that is unknowable.

    None and "" are deliberately different answers, and collapsing them was a
    live bug for one run: an empty diff means *nothing changed since the live
    version*, which is the case where the expensive smokes can be skipped, and
    treating it as "no information" ran every one of them at their most useless.
    """
    if sha and sh("git", "cat-file", "-e", f"{sha}^{{commit}}").returncode == 0:
        return sh("git", "diff", f"{sha}..HEAD").stdout
    return None  # no live version, or a sha this clone does not have


def gate_smokes(args) -> None:
    diff = changed_since(deployed_commit())

    def touches(signals):
        # Unknown means assume the worst; known-and-empty means the live
        # version already ran exactly this code.
        return True if diff is None else any(s in diff for s in signals)

    checks = [
        # Free, and it is the compiler every video prompt goes through.
        (True, "the prompt compiler", [sys.executable, "tools/smoke_prompt.py"]),
        # Free, and the gate is the one thing in front of everything else.
        (True, "the password gate", [sys.executable, "tools/smoke_auth.py"]),
        # A CPU container. Skipped only when the diff cannot have touched a
        # graph, because the failure it catches is otherwise paid for at an
        # H100 cold start.
        (touches(GRAPH_SIGNALS), "every graph against /object_info",
         ["modal", "run", "tools/smoke_graphs.py"]),
        # A CPU container, and only worth it when a pin actually moved. It
        # builds its own `modal.App`, so it needs modal *importable* rather
        # than merely on PATH.
        (touches(PIN_SIGNALS), "every pinned wheel still resolves",
         [modal_python() or sys.executable, "tools/smoke_pins.py"]),
    ]

    for wanted, what, cmd in checks:
        if not wanted:
            print(f"·  skipped {what} — the diff since the live version does "
                  f"not touch it")
            continue
        if args.quick and cmd[0] == "modal":
            print(f"·  skipped {what} (--quick)")
            continue
        if "tools/smoke_pins.py" in cmd and not modal_python():
            # Skipped loudly, with the reason and the fix, rather than failing
            # a deploy on a missing import that has nothing to do with it.
            print(f"·  skipped {what} — no interpreter here can import modal "
                  f"(the client is on PATH but isolated). Fix: "
                  f"pip install modal into {sys.executable}")
            continue
        print(f"·  {what}…", flush=True)
        if subprocess.run(cmd, cwd=ROOT).returncode != 0:
            fail("", f"{what}: FAILED. Nothing was deployed.",
                 f"    {shlex.join(cmd)}")


# ── the deploy, and reading it back ─────────────────────────────────────────

def gate_one_app(args) -> None:
    """
    A second copy needs a second *app*, not only a second volume.

    `VISIONARY_VOLUME=… modal deploy app.py` is documented as an isolated copy,
    but `APP_NAME` is a literal: the deploy lands on the same app, at the same
    URL, and the only thing that changed is which volume production is now
    reading. That is not a staging copy, it is production pointed at an empty
    disk — so it is refused here rather than discovered by a gallery that has
    gone blank.
    """
    vol = os.environ.get("VISIONARY_VOLUME")
    if vol and vol != "visionary" and not args.env:
        fail(f"VISIONARY_VOLUME={vol!r} is set, but the app name is a constant "
             f"({APP_NAME!r}) — this would redeploy the *live* app against a "
             f"different volume rather than stand a second one beside it.",
             "",
             "Pass --env <name> to put it in its own Modal environment, or "
             "unset VISIONARY_VOLUME.")


def deploy(args, head: str) -> None:
    cmd = ["modal", "deploy", "app.py"]
    if args.env:
        cmd += ["--env", args.env]
    print(f"·  {' '.join(cmd)}", flush=True)
    if subprocess.run(cmd, cwd=ROOT).returncode != 0:
        fail("", "The deploy failed. The previous version is still serving.")

    landed = deployed_commit()
    rows = json.loads(sh("modal", "app", "history", APP_NAME, "--json").stdout or "[]")
    version = rows[0].get("version") if rows else "?"
    if landed != head:
        fail("", f"Deployed, but the live version records {landed!r} and HEAD "
                 f"is {head!r}. Something else deployed between the check and "
                 f"now — read `modal app history {APP_NAME}` before trusting it.")
    print(f"·  {version} is live, from {landed}")


# ── the part only a render can answer ───────────────────────────────────────

# The log line the motion-context harvest prints on a miss, and the pack's own
# line on a save. Watching for the pair is the difference between "it deployed"
# and "the chain works", and it is the check that would have caught in one take
# what a source read had to answer instead.
SAVED = re.compile(r"h3_motion_context: saved AV latent to (\S+)")
MISSED = re.compile(r"(\S+) no motion context saved \(wanted (\S+)(?:; folder "
                    r"holds ([^)]*))?\)")


def watch(seconds: float) -> None:
    print(f"·  following logs for {int(seconds)}s — render a take, then "
          f"Continue on it")
    proc = subprocess.Popen(["modal", "app", "logs", APP_NAME], cwd=ROOT,
                            stdout=subprocess.PIPE, text=True)
    deadline = time.time() + seconds
    saved = None
    try:
        for line in proc.stdout:
            if time.time() > deadline:
                break
            m = SAVED.search(line)
            if m:
                saved = m.group(1)
                print(f"   pack saved   {saved}")
            m = MISSED.search(line)
            if m:
                print(f"   harvest miss  wanted {m.group(2)}")
                if m.group(3):
                    print(f"                 folder holds {m.group(3)}")
                elif saved:
                    print(f"                 the pack wrote {saved} — this is "
                          f"the old build; the fixed one names the folder")
                fail("", "The chain is still broken. See H3MC_SLOT in app.py.")
            if saved and "no motion context saved" not in line and \
                    "duration_s" in line:
                print("·  a take completed with its context harvested — "
                      "Continue has motion to pin.")
                return
    finally:
        proc.terminate()
    print("·  no take finished inside the window; nothing proved either way.")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Deploy visionary with the checks that are not in "
                    "`modal deploy`.")
    ap.add_argument("--check", action="store_true",
                    help="run every gate and stop; deploy nothing")
    ap.add_argument("--dirty", action="store_true",
                    help="deploy a tree whose commit cannot be checked out")
    ap.add_argument("--force", action="store_true",
                    help="deploy while a job is still running")
    ap.add_argument("--quick", action="store_true",
                    help="skip the smokes that cost a CPU container")
    ap.add_argument("--watch", nargs="?", const=1800, type=float,
                    metavar="SECONDS",
                    help="after deploying, follow the logs until a take "
                         "reports its motion context (default 1800s)")
    ap.add_argument("--env", help="Modal environment, for a second copy")
    args = ap.parse_args()

    gate_one_app(args)
    head = gate_named(args)
    gate_idle(args)
    gate_smokes(args)

    if args.check:
        print("\nEvery gate passed. Nothing was deployed (--check).")
        return

    deploy(args, head)
    if args.watch:
        watch(args.watch)


if __name__ == "__main__":
    main()

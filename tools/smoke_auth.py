"""
The gate, exercised against app.py's own source rather than a copy of it.

    python3 tools/smoke_auth.py

**Why this file exists.** Auth is the one thing here whose failure is silent.
A route that stops working says so on the next press; a gate that stops
gating says nothing at all, and the deployment behind it holds photographs of
real people and a button that rents an H100. Nothing else in the repo would
notice, because the checks under `tools/ui-checks/` point at
`tools/preview_ui.py`, which has no gate and should not have one.

**Nothing here is retyped.** The auth helpers are located by their banner
comments and `exec`d with a stubbed Modal Dict; the routes are lifted out of
`web()` by AST and mounted on a bare FastAPI app. So the allowlist, the cookie
flags and the lockout are asserted as they are written in `app.py` — widen
`OPEN_PATHS` or drop `secure=True` and this fails, which is the only reason it
is worth running.

Two halves. The first needs nothing but the standard library and covers the
crypto: what a cookie accepts, what a rotation kills, what an unreachable Dict
does. The second needs `fastapi` and covers the wiring — that the middleware
actually shuts the fifty routes it is supposed to shut. It skips rather than
fails when FastAPI is not installed locally, because a laptop with no deploy
tooling should still be able to run the first half.
"""

import ast
import hashlib
import hmac
import re
import secrets
import sys
import tempfile
import time
from collections import deque
from pathlib import Path
from typing import Any

APP = Path(__file__).resolve().parent.parent / "app.py"
SRC = APP.read_text()

fails: list[str] = []


def check(label: str, cond: object, detail: str = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {label}{'  ' + detail if detail else ''}")
    if not cond:
        fails.append(label)


class FakeDict(dict):
    """A Modal Dict, minus the network. `fail` makes it unreachable."""

    fail = False

    def get(self, k, default=None):
        if self.fail:
            raise RuntimeError("dict unreachable")
        return dict.get(self, k, default)


def auth_module() -> dict:
    """
    app.py's auth section, executed as a module.

    Located by its banners rather than by line number: a slice by line survives
    exactly until somebody adds a comment above it, and then it silently tests
    half the file.
    """
    start = SRC.rindex("# ----", 0, SRC.index("# Auth — one password"))
    end = SRC.rindex("# ----", 0, SRC.index("# Web app — UI + API"))
    block = SRC[start:end].replace(
        'auth = modal.Dict.from_name("visionary-auth", create_if_missing=True)',
        "auth = FakeDict()")
    assert "def _gate_page" in block, "the auth section did not slice cleanly"
    g = {"hashlib": hashlib, "hmac": hmac, "secrets": secrets, "time": time,
         "deque": deque, "Any": Any, "FakeDict": FakeDict}
    exec(compile(block, "app.py:auth", "exec"), g)
    return g


# ---- the crypto -----------------------------------------------------------

g = auth_module()
auth = g["auth"]

print("\n=== unclaimed ===")
check("no password set", g["_password_set"]() is False)
check("no signing secret", g["_auth_secret"]() is None)
check("so no cookie can verify", g["_valid_cookie"]("v1.99999999999.abcd") is False)
gate = g["_gate_page"]()
check("the gate offers to claim it", "Set password" in gate and "Nobody has claimed" in gate)
left = re.findall(r"__[A-Z_]+__", gate)
check("every placeholder is substituted", not left, str(left))

print("\n=== claiming it ===")
g["_set_password"]("correct horse battery")
check("the password is set", g["_password_set"]() is True)
check("the plaintext is nowhere in the Dict",
      "correct horse battery" not in repr(dict(auth)))
check("the record is one atomic value", set(auth["password"]) == {"salt", "hash"})

print("\n=== the cookie ===")
c = g["_issue_cookie"]()
head, exp, sig = c.split(".")
check("accepts its own", g["_valid_cookie"](c) is True)
check("rejects a flipped signature",
      g["_valid_cookie"](c[:-1] + ("0" if c[-1] != "0" else "1")) is False)
# The one that matters: an expiry is attacker-controlled text until the HMAC
# over it has been checked, so it must never be trusted before the signature.
check("rejects an extended expiry",
      g["_valid_cookie"](f"{head}.{int(exp) + 86400}.{sig}") is False)
check("rejects a wrong version", g["_valid_cookie"](f"v2.{exp}.{sig}") is False)
check("rejects junk", g["_valid_cookie"]("nonsense") is False)
secret = g["_auth_secret"]()
body = f"v1.{int(time.time()) - 10}"
check("rejects a correctly-signed expired one",
      g["_valid_cookie"](
          f"{body}.{hmac.new(secret, body.encode(), hashlib.sha256).hexdigest()}") is False)

print("\n=== the password ===")
check("accepts the right one", g["_check_password"]("correct horse battery") is True)
check("refuses one character off", g["_check_password"]("correct horse batter") is False)
check("refuses empty", g["_check_password"]("") is False)

print("\n=== rotation is revocation ===")
before = g["_issue_cookie"]()
g["_rotate_secret"]()
check("signing out kills the old cookie", g["_valid_cookie"](before) is False)
before = g["_issue_cookie"]()
g["_set_password"]("another twelve chars")
check("a password change kills it too", g["_valid_cookie"](before) is False)
check("and the old password with it",
      g["_check_password"]("correct horse battery") is False)
check("the gate now says sign in", "Sign in" in g["_gate_page"]())

print("\n=== lockout ===")
g["_attempts"].clear()
check("open at rest", g["_locked_for"]() == 0)
for _ in range(g["LOCKOUT_TRIES"]):
    g["_attempts"].append(time.time())
check("shuts at the limit", g["_locked_for"]() > 0, f"{g['_locked_for']()}s")
g["_attempts"].clear()
for _ in range(g["LOCKOUT_TRIES"]):
    g["_attempts"].append(time.time() - g["LOCKOUT_WINDOW_S"] - 1)
check("attempts age out of the window", g["_locked_for"]() == 0)

print("\n=== an unreachable Dict ===")
g["_attempts"].clear()
g["_secret_cache"] = None
auth.fail = True
# Both directions of the same rule: a network blip must never be mistaken for
# "nobody has claimed this", and must never answer a password check with yes.
check("_password_set fails closed", g["_password_set"]() is True)
check("_check_password fails closed", g["_check_password"]("another twelve chars") is False)
auth.fail = False
good = g["_issue_cookie"]()
g["_secret_cache"] = (g["_secret_cache"][0], 0)  # force a re-read
auth.fail = True
# Fail-static, not fail-open: the cached key was read legitimately, and holding
# it delays a rotation rather than opening the gate.
check("a cached secret survives the blip", g["_valid_cookie"](good) is True)
auth.fail = False

print("\n=== cost ===")
t0 = time.time()
g["_check_password"]("wrong")
attempt_ms = (time.time() - t0) * 1000
t0 = time.time()
for _ in range(10_000):
    g["_valid_cookie"](good)
verify_ms = (time.time() - t0) / 10
# The two numbers the design rests on. scrypt is the brake on guessing, so it
# must stay expensive; the cookie is checked on a 400ms poll for the length of
# a training run, so it must stay free.
check("an attempt costs real work", attempt_ms > 20, f"{attempt_ms:.0f}ms of scrypt")
check("a verify costs nothing", verify_ms < 0.05, f"{verify_ms:.4f}ms on the poll path")


# ---- the wiring -----------------------------------------------------------

try:
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
    from fastapi.testclient import TestClient
except ImportError:
    print("\n=== routes: skipped (no fastapi locally; pip install 'fastapi[standard]') ===")
    raise SystemExit(1 if fails else 0)

print("\n=== routes, lifted from web() ===")
lines = SRC.splitlines(keepends=True)
web = next(n for n in ast.parse(SRC).body
           if isinstance(n, ast.FunctionDef) and n.name == "web")
wanted = {"_gate", "index", "login", "logout", "change_password"}
pieces: list[str] = []
for node in web.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "OPEN_PATHS":
        pieces.append(ast.get_source_segment(SRC, node) or "")
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted:
        first = min(d.lineno for d in node.decorator_list) if node.decorator_list else node.lineno
        # Dedented by exactly one level: these are nested in web(), and the
        # bodies below rely on that indentation being uniform.
        pieces.append("".join(l[4:] if l.startswith("    ") else l
                              for l in lines[first - 1:node.end_lineno]))
        wanted.discard(node.name)
assert not wanted, f"could not lift: {wanted}"

DIST = Path(tempfile.mkdtemp())
(DIST / "index.html").write_text("<!doctype html><title>THE BUNDLE</title>")

g = auth_module()
auth = g["auth"]
api = FastAPI()
ns = dict(g, api=api, Request=Request, HTMLResponse=HTMLResponse,
          JSONResponse=JSONResponse, FileResponse=FileResponse,
          DIST=DIST, Path=Path, Any=Any, time=time)
exec(compile("\n".join(pieces), "app.py:web", "exec"), ns)


@api.get("/api/state")
def _stand_in_for_the_other_fifty():
    return {"ok": True, "secret": "the volume listing"}


c = TestClient(api, base_url="https://x.modal.run")

r = c.get("/")
check("an unclaimed / is the gate", r.status_code == 200 and "Set password" in r.text)
check("and not the bundle", "THE BUNDLE" not in r.text)
check("the gate is uncacheable", r.headers.get("cache-control") == "no-store")
r = c.get("/api/state")
check("a guarded route 401s", r.status_code == 401, str(r.status_code))
check("and leaks nothing", "volume listing" not in r.text)
# The bundle is inside the fence, which is what keeps OPEN_PATHS at two.
check("/assets is guarded too", c.get("/assets/index-abc.js").status_code == 401)

check("a short first password is refused",
      c.post("/api/login", json={"password": "short"}).status_code == 400)
check("still unclaimed after that", not g["_password_set"]())

r = c.post("/api/login", json={"password": "a good long password"})
check("the first password claims it",
      r.status_code == 200 and r.json() == {"ok": True, "claimed": True})
raw = r.headers["set-cookie"]
for flag in ("HttpOnly", "Secure", "Path=/", f"Max-Age={g['AUTH_TTL_S']}"):
    check(f"cookie is {flag}", flag in raw, raw if flag not in raw else "")
check("cookie is SameSite=lax", "samesite=lax" in raw.lower())

check("/ now serves the bundle", "THE BUNDLE" in c.get("/").text)
check("guarded routes open", c.get("/api/state").status_code == 200)

anon = TestClient(api, base_url="https://x.modal.run")
check("a stranger meets sign-in, not a claim",
      "Sign in" in anon.get("/").text and "Nobody has claimed" not in anon.get("/").text)
r = anon.post("/api/login", json={"password": "not it"})
check("a wrong password is 401", r.status_code == 401)
check("and says nothing about the real one", "character" not in r.json()["error"])

# The countdown, refusal by refusal. Asserted as a sequence rather than at the
# ends, because the bug this replaces was in the middle of it: `0 < left <= 2`
# went silent on the fifth press — the one that starts the lockout and the one
# where the wait most needs saying — so the counter read "2 left", "1 left",
# nothing, 429. Every refusal from here has to carry its own next step.
g["_attempts"].clear()
said = []
for _ in range(g["LOCKOUT_TRIES"]):
    said.append(anon.post("/api/login", json={"password": "wrong"}).json()["error"])
check("early refusals do not count down", said[0] == "Wrong password.", said[0])
check("the last two do",
      said[-3] == "Wrong password. 2 attempts left."
      and said[-2] == "Wrong password. 1 attempt left.", str(said[-3:-1]))
check("the one that locks says the wait",
      said[-1].startswith("Wrong password. Locked now — try again in "), said[-1])
check("no refusal is silent about what happens next",
      all(m != "Wrong password." for m in said[-3:]), str(said[-3:]))

r = anon.post("/api/login", json={"password": "a good long password"})
check("lockout refuses even the right password", r.status_code == 429)
check("and names the wait", "try again in" in r.json()["error"])
check("a signed-in session is untouched by it", c.get("/api/state").status_code == 200)
g["_attempts"].clear()

check("a change needs the current password",
      c.post("/api/password",
             json={"current": "nope", "next": "another good one"}).status_code == 401)
old = c.cookies.get(g["AUTH_COOKIE"])
check("the change lands",
      c.post("/api/password", json={"current": "a good long password",
                                    "next": "another good one"}).status_code == 200)
check("this browser stays in", c.get("/api/state").status_code == 200)
other = TestClient(api, base_url="https://x.modal.run")
other.cookies.set(g["AUTH_COOKIE"], old)
check("every other browser is out", other.get("/api/state").status_code == 401)

stolen = c.cookies.get(g["AUTH_COOKIE"])
thief = TestClient(api, base_url="https://x.modal.run")
thief.cookies.set(g["AUTH_COOKIE"], stolen)
check("a copied cookie works while the session lives",
      thief.get("/api/state").status_code == 200)
c.post("/api/logout")
check("and dies the moment you sign out", thief.get("/api/state").status_code == 401)
check("your own cookie is cleared", not c.cookies.get(g["AUTH_COOKIE"]))
check("/ is the gate again", "Sign in" in c.get("/").text)
check("login stays reachable while signed out",
      c.post("/api/login", json={"password": "another good one"}).status_code == 200)

print()
if fails:
    print(f"{len(fails)} FAILED: {fails}")
    sys.exit(1)
print("all passed")

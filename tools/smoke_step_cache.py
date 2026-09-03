"""
Does the step cache skip the right steps, and does it stop skipping when only
the audio moves?

    python3.11 tools/smoke_step_cache.py

CPU-only, no ComfyUI, no GPU, no torch. The node's arithmetic is four
operations wide — subtract, abs, mean, divide — so a fake tensor exercises the
control flow honestly and the H100 is left to answer the only question it is
needed for, which is wall clock (tools/ab_cache.py).

What this exists to hold down, in the order the mistakes would cost most:

  * **Audio cannot hide behind a still frame.** The whole reason the wrapper
    moved to the diffusion model is that a single scalar over the flat pack is
    a video score with a rounding error attached. A run whose picture is
    frozen and whose audio is moving must compute, and if this test ever goes
    green with the max() turned into a mean, the move bought nothing.
  * **State is per run.** The bug that made this node first-party was spent
    state surviving into take two and silently disabling the cache. Two
    identical takes must read identically.
  * **The guards hold at the ends**, which is the fidelity argument for the
    whole thing: structure locks in early and detail resolves late.
  * **A skip is the current input plus the last delta**, not the last output.
    Getting this backwards is invisible in a step count and visible only in
    the take, which is the expensive way to find it.
"""

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class T:
    """Just enough tensor: the four ops the node's rel-L1 is made of."""

    def __init__(self, values, shape=None):
        self.v = list(values)
        self.shape = shape or (len(self.v),)

    def _pair(self, other):
        o = other.v if len(other.v) == len(self.v) else other.v * len(self.v)
        return zip(self.v, o)

    def __sub__(self, o):
        return T([a - b for a, b in self._pair(o)], self.shape)

    def __add__(self, o):
        return T([a + b for a, b in self._pair(o)], self.shape)

    def __truediv__(self, o):
        return T([a / b for a, b in self._pair(o)], self.shape)

    def abs(self):
        return T([abs(a) for a in self.v], self.shape)

    def mean(self):
        return T([sum(self.v) / len(self.v)], (1,))

    def clamp(self, min=None):
        return T([max(a, min) for a in self.v], self.shape)

    def detach(self):
        return self

    def flatten(self):
        return self

    def __getitem__(self, i):
        return self.v[i]

    def __float__(self):
        return float(self.v[0])


def _install_comfy_stubs():
    """The node imports three comfy modules for two constants and a type."""
    def copy_nested_dicts(d):  # comfy.patcher_extension's own semantics
        out = dict(d)
        for k, v in d.items():
            if isinstance(v, dict):
                out[k] = copy_nested_dicts(v)
            elif isinstance(v, list):
                out[k] = v.copy()
        return out

    for name in ("comfy", "comfy.ldm", "comfy.ldm.minimax"):
        sys.modules.setdefault(name, types.ModuleType(name))
    model = types.ModuleType("comfy.ldm.minimax.model")
    model.MiniMaxH3Model = type("MiniMaxH3Model", (), {})
    patcher = types.ModuleType("comfy.model_patcher")
    patcher.create_model_options_clone = copy_nested_dicts
    extension = types.ModuleType("comfy.patcher_extension")
    extension.WrappersMP = types.SimpleNamespace(
        OUTER_SAMPLE="outer_sample", DIFFUSION_MODEL="diffusion_model")
    sys.modules["comfy.ldm.minimax.model"] = model
    sys.modules["comfy.model_patcher"] = patcher
    sys.modules["comfy.patcher_extension"] = extension
    sys.modules["comfy.ldm.minimax"].model = model
    sys.modules["comfy.ldm"].minimax = sys.modules["comfy.ldm.minimax"]
    sys.modules["comfy"].ldm = sys.modules["comfy.ldm"]
    sys.modules["comfy"].model_patcher = patcher
    sys.modules["comfy"].patcher_extension = extension
    return model.MiniMaxH3Model


H3Model = _install_comfy_stubs()
spec = importlib.util.spec_from_file_location(
    "vsc", ROOT / "comfy_nodes" / "visionary_step_cache" / "__init__.py")
vsc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vsc)


class FakePatcher:
    """ModelPatcher's four surfaces the node touches, and clone's deep copy."""

    def __init__(self):
        self.model_options = {}
        self.wrappers = {}
        self.model = types.SimpleNamespace(model_sampling=types.SimpleNamespace(
            # ModelSamplingDiscreteFlow's shape: percent walks sigma down.
            percent_to_sigma=lambda p: 1.0 if p <= 0.0 else (0.0 if p >= 1.0
                                                             else 1.0 - p)))

    def clone(self):
        n = FakePatcher()
        n.model_options = vsc.comfy.model_patcher.create_model_options_clone(
            self.model_options)
        n.wrappers = {k: dict(v) for k, v in self.wrappers.items()}
        n.model = self.model
        return n

    def get_model_object(self, name):
        return H3Model()

    def add_wrapper_with_key(self, wrapper_type, key, wrapper):
        self.wrappers.setdefault(wrapper_type, {})[key] = wrapper


class _Executor:
    """WrapperExecutor is a callable carrying class_obj; that is all we need."""

    def __init__(self, class_obj, fn):
        self.class_obj = class_obj
        self._fn = fn

    def __call__(self, *args, **kwargs):
        return self._fn(*args, **kwargs)


def take(patched, steps=20, video=None, audio=None):
    """Run one sampling pass through both wrappers; report it step by step."""
    video = video or (lambda i: [1.0 + 0.001 * i] * 8)
    audio = audio or (lambda i: [0.5 + 0.001 * i] * 4)
    guider = types.SimpleNamespace(model_options=patched.model_options,
                                   model_patcher=patched)
    forward = patched.wrappers["diffusion_model"][vsc.PATCH_KEY]
    sample = patched.wrappers["outer_sample"][vsc.PATCH_KEY]
    log = []

    def model(streams, timestep, context, topts):
        # A velocity that is a fixed offset from its input, so a correct
        # residual reuse reproduces the real forward exactly and a stale
        # output reuse does not.
        log[-1]["computed"] = True
        return [T([-v * 0.1 for v in streams[0].v], streams[0].shape),
                T([-a * 0.1 for a in streams[1].v], streams[1].shape)]

    def sampling(*args, **kwargs):
        topts = guider.model_options["transformer_options"]
        for i in range(steps):
            sigma = 1.0 - i / steps
            streams = [T(video(i)), T(audio(i))]
            log.append({"step": i, "sigma": sigma, "computed": False,
                        "streams": streams})
            topts["sigmas"] = T([sigma])
            topts["uuids"] = ["cond"]
            out = forward(model, streams, T([sigma * 1000]), None, topts)
            log[-1]["out"] = out
        return "samples"

    assert vsc._sample_wrapper(_Executor(guider, sampling)) == "samples"
    return log


def build(**overrides):
    settings = {"rel_l1_thresh": 0.15, "start_percent": 0.10,
                "end_percent": 0.90, "max_consecutive_skips": 2}
    settings.update(overrides)
    return vsc.VisionaryStepCache().patch(FakePatcher(), **settings)[0]


def check(name, condition, detail=""):
    print(f"{'ok  ' if condition else 'FAIL'} {name}{'  ' + detail if detail else ''}")
    return bool(condition)


def main():
    ok = True

    # ── the measured window ────────────────────────────────────────────────
    log = take(build())
    skipped = [e["step"] for e in log if not e["computed"]]
    ok &= check("something is reused on a barely-moving take", skipped,
                f"skipped {skipped}")
    ok &= check("the first two steps of twenty are always real",
                all(s >= 2 for s in skipped))
    ok &= check("the last two steps of twenty are always real",
                all(s < 18 for s in skipped))

    runs = []
    streak = 0
    for e in log:
        streak = streak + 1 if not e["computed"] else 0
        runs.append(streak)
    ok &= check("never more than max_consecutive_skips in a row",
                max(runs) <= 2, f"longest run {max(runs)}")

    # ── residual reuse, not stale output ───────────────────────────────────
    # Both reuses are approximations; the question is which one. A skip has to
    # be this step's input plus the last real delta, so that whatever the
    # sampler did to the latent since is still carried.
    exact, discriminating, last_real = True, 0, None
    for e in log:
        if e["computed"]:
            last_real = (e["streams"], e["out"])
            continue
        prev_in, prev_out = last_real
        want = [s + (o - p) for s, o, p in zip(e["streams"], prev_out, prev_in)]
        for got, w in zip(e["out"], want):
            exact &= all(abs(a - b) < 1e-12 for a, b in zip(got.v, w.v))
        if any(abs(a - b) > 1e-9 for got, o in zip(e["out"], prev_out)
               for a, b in zip(got.v, o.v)):
            discriminating += 1
    ok &= check("a skip is this step's input plus the last real delta", exact)
    ok &= check("and demonstrably not the previous output handed back",
                discriminating == len(skipped),
                f"{discriminating} of {len(skipped)} skips differ from it")

    # ── the reason the hook moved ──────────────────────────────────────────
    still = lambda i: [1.0] * 8
    quiet = lambda i: [0.5] * 4
    loud = lambda i: [0.5 * (1.0 if i % 2 else -1.0)] * 4
    frozen = take(build(), video=still, audio=quiet)
    talking = take(build(), video=still, audio=loud)
    frozen_skips = sum(1 for e in frozen if not e["computed"])
    talking_skips = sum(1 for e in talking if not e["computed"])
    ok &= check("a frozen picture with quiet audio reuses freely",
                frozen_skips > 0, f"{frozen_skips} skipped")
    ok &= check("a frozen picture with moving audio does not",
                talking_skips == 0,
                f"{talking_skips} skipped — audio is hiding behind the frame")

    # ── state belongs to one run ───────────────────────────────────────────
    patched = build()
    first = [e["computed"] for e in take(patched)]
    second = [e["computed"] for e in take(patched)]
    ok &= check("a second take on the same patched model reads identically",
                first == second,
                f"{sum(first)} computed then {sum(second)}")

    # ── the range is resolved, not counted ─────────────────────────────────
    short = take(build(), steps=12)
    short_skips = [e["step"] for e in short if not e["computed"]]
    ok &= check("the window scales with the schedule, not a typed step count",
                short_skips and min(short_skips) >= 1 and max(short_skips) < 11,
                f"12-step run skipped {short_skips}")

    try:
        build(start_percent=0.9, end_percent=0.1)
        ok &= check("an inverted range is refused", False)
    except ValueError as exc:
        ok &= check("an inverted range is refused", "never be active" in str(exc))

    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

"""
TeaCache for H3, as our own hundred lines rather than a pinned pack.

The mechanism is Liu et al. 2024 (arXiv:2411.19108), first proven against
this app by Icyoung/ComfyUI-MiniMaxH3-TeaCache in tools/ab_cache.py — 220.0s
to 97.4s on a 20-step 1344x768 take, with computed steps at exactly stock
price. Adjacent denoising steps produce nearly identical outputs, so when the
*input* latent has barely moved since the last real forward, the last real
delta is applied instead of running 33B parameters to recompute it. The skip
test is one rel-L1 over the latent — a few million elements — which is why
this survives the shape that killed the block-level cache the day before:
overhead that scales with hidden-state size loses at 768p, and this has none.
See docs/decisions.md, "CacheDiT lasted one day".

Written first-party for one reason beyond size: a pack's state lives in its
node execute, and ComfyUI caches node outputs — a second take with the same
settings reuses the patched MODEL together with the *spent* state, and its
step counter, never reset, disables caching silently from take two on.

**The hook is the diffusion model, not apply_model.** The sampler runs H3 on
one flat packed tensor, video and audio concatenated with the audio slice
carried at sigma_a/sigma_v, so at apply_model level there is no audio to look
at — only a tail of the pack whose magnitude is a schedule artefact. H3's own
`forward` undoes that carry before it runs this chain, "so they and the
network see the stream's own latent and velocity" in its words, and hands us
[video, audio] as two tensors. That is the only place the two streams can be
scored apart, which is the whole point of the move.

Moving there also retires the sigma-monotonic reset this node used to carry.
That existed to notice a new run without a per-run hook; OUTER_SAMPLE *is*
the per-run hook, and it clones fresh state at the top of every sample and
drops it in the finally. One way to do it, and the one ComfyUI's own
`nodes_easycache.py` uses.

Four mechanisms came from Mozer/ComfyUI-MiniMax-H3-MotionCache-FastVAE, read
2026-09-03 and reimplemented rather than depended on — one commit, one
author, and a README whose install line clones a different repository:

  * **Residual reuse.** A skip returns the *current* input plus the last real
    delta, not the last output verbatim. A stale output throws away whatever
    the sampler did to the latent on the step being stood in for; the delta
    keeps it. This is what the TeaCache paper actually describes and what
    core's EasyCache does.
  * **Both streams scored, worst one wins.** Audio is a rounding error by
    element count, so any single scalar over the pack lets a whole spoken
    syllable hide behind a still frame. Same rel-L1 on each stream, so the
    threshold keeps the meaning it was measured with and can only ever get
    stricter — the 2.26x above is an upper bound on what this reads now.
  * **A percent range instead of a typed step count.** `total_steps` had to
    be handed the same number the sampler got, which is two copies of one
    fact and wrong the moment anything samples at denoise < 1.0. The range
    is resolved against the model's own schedule and cannot drift.
  * **A cap on consecutive skips.** Accumulated change bounds drift in the
    aggregate; nothing bounded how many reuses could land in a row.

Two of that pack's ideas were left out on purpose. Its motion weighting
builds a per-pixel weight tensor from frame differences on every computed
step — cost that scales with tensor size against skips that do not, which is
precisely the arithmetic that made CacheDiT a net loss at 768p. And its 8x
subsampling of the score inputs changes what the threshold means, which would
retire the only number here anybody measured. Both are harness questions
(tools/ab_cache.py, at production shape), not defaults.
"""

import logging

import comfy.ldm.minimax.model
import comfy.model_patcher
import comfy.patcher_extension

# Namespaced because it lands in transformer_options beside core's own
# "easycache" key, and the node refuses to sit next to that one.
PATCH_KEY = "visionary_step_cache"


class _State:
    __slots__ = ("thresh", "max_skips", "start_percent", "end_percent",
                 "start_sigma", "end_sigma", "fingerprint", "accumulated",
                 "streak", "computed", "reused", "prev", "residual")

    def __init__(self, thresh, max_skips, start_percent, end_percent):
        self.thresh = thresh
        self.max_skips = max_skips
        self.start_percent = start_percent
        self.end_percent = end_percent
        self.start_sigma = 0.0
        self.end_sigma = 0.0
        self.reset()

    def clone(self):
        """A run's own state. The node's copy stays a template, never a tally."""
        return _State(self.thresh, self.max_skips,
                      self.start_percent, self.end_percent)

    def prepare(self, model_sampling):
        # Resolved here rather than in the node because percent_to_sigma
        # answers for the schedule this run will actually walk.
        self.start_sigma = float(model_sampling.percent_to_sigma(self.start_percent))
        self.end_sigma = float(model_sampling.percent_to_sigma(self.end_percent))
        return self

    def reset(self):
        self.fingerprint = None
        self.accumulated = 0.0
        self.streak = 0
        self.computed = 0
        self.reused = 0
        self.prev = None      # [video, audio] inputs of the last real forward
        self.residual = None  # its outputs minus those inputs


def _rel_l1(current, previous):
    """Mean absolute change, normalised by the previous tensor's own scale.

    Kept to the letter of the arithmetic the 0.15 threshold was measured
    with, including the bf16 reduction: torch accumulates these in fp32, and
    casting the whole latent to float first would buy nothing but a copy.
    """
    return float((current - previous).abs().mean()
                 / previous.abs().mean().clamp(min=1e-8))


def _forward_wrapper(executor, *args, **kwargs):
    # comfy/ldm/minimax/model.py runs this chain as
    # (x, timestep, context, transformer_options). A signature change fails
    # loudly on the unpack below, which is what COMFY_SHA bumps re-check for.
    streams, transformer_options = args[0], args[3]
    video, audio = streams
    state = transformer_options[PATCH_KEY]
    sigma = float(transformer_options["sigmas"].flatten()[0])

    # A shape or conditioning change mid-run means the stored delta describes
    # a different picture. Resetting is the safe direction: a guider that
    # batches its conds separately loses the cache rather than reusing the
    # wrong half of it.
    fingerprint = (video.shape, audio.shape, tuple(transformer_options["uuids"]))
    if state.fingerprint != fingerprint:
        state.reset()
        state.fingerprint = fingerprint

    reusable = (state.residual is not None
                and state.end_sigma < sigma <= state.start_sigma
                and state.streak < state.max_skips)
    if reusable:
        state.accumulated += max(_rel_l1(new, old)
                                 for new, old in zip(streams, state.prev))
        if state.accumulated < state.thresh:
            state.streak += 1
            state.reused += 1
            return [s + r for s, r in zip(streams, state.residual)]
        state.accumulated = 0.0

    state.streak = 0
    output = executor(*args, **kwargs)
    state.computed += 1
    # Detached, not cloned: k-diffusion allocates a fresh x each step rather than
    # writing through the one it was handed, so there is nothing to copy away
    # from. Cloning here would put a second latent on the card per step.
    state.prev = [s.detach() for s in streams]
    state.residual = [(o - s).detach() for o, s in zip(output, streams)]
    return output


def _sample_wrapper(executor, *args, **kwargs):
    guider = executor.class_obj
    original = guider.model_options
    # Cloned even though CFGGuider.sample already clones on the way in: that
    # is an implementation detail of a file we pin and re-read on every bump,
    # and this node's counters must belong to one run whatever it does.
    guider.model_options = comfy.model_patcher.create_model_options_clone(original)
    state = (guider.model_options["transformer_options"][PATCH_KEY]
             .clone().prepare(guider.model_patcher.model.model_sampling))
    guider.model_options["transformer_options"][PATCH_KEY] = state
    try:
        return executor(*args, **kwargs)
    finally:
        total = state.computed + state.reused
        # Counts, never an estimated speedup. Pricing the skips and not the
        # overhead is exactly how CacheDiT's own dashboard read 1.33x while
        # the take got slower. Wall clock is the harness's to report.
        if state.reused:
            logging.info("[step-cache] reused %d of %d forwards",
                         state.reused, total)
        state.reset()
        guider.model_options = original


class VisionaryStepCache:
    """Reuse the last forward's delta while both streams have barely moved."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            # The default is the measured configuration, not a preference:
            # tools/ab_cache.py, 2.26x, 12 of 20 steps reused, judged on the
            # takes. This threshold is the speed/fidelity dial — 0.25 was
            # considered as "top of the fidelity range" and walked back to
            # the number that was actually measured. Turning it up means
            # re-measuring, which the harness makes cheap.
            "rel_l1_thresh": ("FLOAT", {"default": 0.15, "min": 0.0,
                                        "max": 0.5, "step": 0.01}),
            # 0.10/0.90 is the old start_step 2 / final_steps 2 read back off
            # a 20-step schedule, which is where it was measured. At the
            # 12-step floor the tail guard is a step and a bit rather than
            # two — the range scales with the schedule, which is the point.
            "start_percent": ("FLOAT", {"default": 0.10, "min": 0.0,
                                        "max": 1.0, "step": 0.01}),
            "end_percent": ("FLOAT", {"default": 0.90, "min": 0.0,
                                      "max": 1.0, "step": 0.01}),
            "max_consecutive_skips": ("INT", {"default": 2, "min": 1,
                                              "max": 10}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "visionary"

    def patch(self, model, rel_l1_thresh, start_percent, end_percent,
              max_consecutive_skips):
        if start_percent >= end_percent:
            raise ValueError(
                f"Step cache start_percent ({start_percent}) must be below "
                f"end_percent ({end_percent}); as given it would never be "
                f"active and the node would silently do nothing.")

        patched = model.clone()
        # The wrapper reads the diffusion model's input as [video, audio].
        # Every other model in ComfyUI hands its diffusion model one tensor,
        # so say that here rather than fail on an unpack mid-render.
        if not isinstance(patched.get_model_object("diffusion_model"),
                          comfy.ldm.minimax.model.MiniMaxH3Model):
            raise ValueError(
                "Visionary Step Cache is H3-only: it scores the video and "
                "audio streams separately, which a single-stream model has "
                "nothing to answer with.")
        options = patched.model_options.setdefault("transformer_options", {})
        if "easycache" in options:
            raise ValueError(
                "Remove EasyCache before Visionary Step Cache: two step "
                "caches on one model each measure their skips against the "
                "other's reused output, so neither threshold means anything.")
        options[PATCH_KEY] = _State(float(rel_l1_thresh),
                                    int(max_consecutive_skips),
                                    float(start_percent), float(end_percent))
        # Wrappers on a ModelPatcher clone, not a patch of model internals, so
        # nothing persists on the resident model of a warm container: dropping
        # the node from a graph is the whole uninstall. That is a lesson with
        # a receipt — see docs/decisions.md on cache_dit.enable_cache.
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
            PATCH_KEY, _sample_wrapper)
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
            PATCH_KEY, _forward_wrapper)
        return (patched,)


NODE_CLASS_MAPPINGS = {"VisionaryStepCache": VisionaryStepCache}
NODE_DISPLAY_NAME_MAPPINGS = {"VisionaryStepCache": "Visionary Step Cache"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

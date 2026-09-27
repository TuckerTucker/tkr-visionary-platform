/**
 * The one door to OpenVideo.
 *
 * Nothing else in the page imports `@openvideo/core` or `@openvideo/engine-pixi`,
 * and this file only imports them *dynamically*. The engine is 3.4 MB (about
 * 890 kB gzipped) of Pixi, WebCodecs muxing and inlined workers; the image side
 * of the page never arranges time and should never download it. A static import
 * anywhere — even one that looks harmless in a type position without `import
 * type` — puts it in the entry chunk and every first load pays for it.
 *
 * `import type` below is free: `verbatimModuleSyntax` erases it, so it names the
 * shapes without pulling a byte.
 *
 * Failure is a value, as it is in `api/client.ts`: `loadEngine()` resolves to
 * `Engine | ApiError` and never rejects. A chunk that will not load (an old tab
 * after a deploy replaced the hashes, a dropped connection, a browser without
 * the APIs the engine is compiled against) has to arrive as a sentence on the
 * surface that asked for time, not as a blank stage and an unhandled rejection
 * in a console nobody is watching.
 */
import type { ApiError } from '../api/client'
import type { Core, IProject } from '@openvideo/core'
import type { Compositor, Studio } from '@openvideo/engine-pixi'

/**
 * The pinned `@openvideo/core` version, as a string the page can write into
 * what it saves.
 *
 * A saved arrangement is OpenVideo's IProject verbatim, and that shape belongs
 * to a version. Tagging it is what lets a later build know it is reading a
 * project written by an older engine rather than guessing. It is a literal and
 * not read from package.json at build time because the page should not ship its
 * manifest; `tools/smoke_pins.py` holds the two equal instead, so a bump that
 * forgets this line fails there rather than mislabelling every save after it.
 */
export const OPENVIDEO_PIN = '1.4.0'

/** Microseconds from seconds. OpenVideo's timing is µs everywhere except a
 * fade's duration (ms) and a frame grab (ms); naming the unit at the call site
 * is what keeps a 1e3 error from reading as a clip that is merely short. */
export function us(seconds: number): number {
  return Math.round(seconds * 1_000_000)
}

/** Seconds from microseconds. */
export function sec(micro: number): number {
  return micro / 1_000_000
}

/**
 * An absolute same-origin URL for a path the page already has.
 *
 * The engine was written for Electron: any src that starts with `/` is
 * rewritten to `media-file:///api/file/…`, a scheme a browser tab cannot load,
 * and the clip then fails to decode with nothing to say it was the URL. Every
 * `/api/file/...` path goes through here before it reaches a clip.
 */
export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href
}

/** The size of the frame being arranged — the project's, not the element's. */
export interface StageSize {
  width: number
  height: number
}

/** What `loadEngine()` hands back once both packages are in. */
export interface Engine {
  /**
   * A fresh Core — its own store, its own undo history.
   *
   * Never the package's `core` export. That one is a module-level singleton
   * built at import time, so two stages (or one stage remounted) would share a
   * project and an undo stack; and `studio.destroy()` calls
   * `core.removeAllListeners()` on the Core it was given, so tearing one stage
   * down would silently unsubscribe everything else listening to a shared one.
   */
  createCore(initial?: Partial<IProject>): Core
  /**
   * A Studio drawing `core` onto `canvas`, ready to render.
   *
   * `canvas` must already be in the document with a parent: the engine sizes
   * its renderer to `canvas.parentElement` and falls back to `window` when
   * there is none, which draws a stage the size of the whole viewport behind
   * whatever the page laid out. That is a caller bug rather than a state, so it
   * throws `StageDetachedError`; a renderer that cannot start (no WebGL, a lost
   * context) is a state, and comes back as an ApiError.
   *
   * `interactivity: false` because canvas drags move the engine's sprites
   * without writing back to the Core — the arrangement on screen and the one
   * that is saved and exported would drift apart. The page drives the Core and
   * the Studio follows it.
   */
  mountStudio(canvas: HTMLCanvasElement, core: Core, size: StageSize): Promise<Studio | ApiError>
  /** The exporter. A class rather than a factory because its static
   * `isSupported()` is what decides whether Export is offered at all. */
  Compositor: typeof Compositor
}

/** Raised when a Studio is asked to draw on a canvas that is not yet in the
 * layout. See `Engine.mountStudio`. */
export class StageDetachedError extends Error {
  override name = 'StageDetachedError'
  constructor() {
    super('mountStudio: the canvas has no parentElement — mount it into the page '
      + 'before binding a Studio, or the engine sizes itself to the window.')
  }
}

// One load per page. Two surfaces asking in the same tick should share the
// download, not race two copies of the same module graph.
let pending: Promise<Engine | ApiError> | null = null

/**
 * Load the engine, once. Resolves to an `Engine` or an `ApiError` naming what
 * failed; never rejects.
 */
export function loadEngine(): Promise<Engine | ApiError> {
  if (!pending) {
    pending = load().then((r) => {
      // A failure is not cached: the next ask is the retry, which is what a
      // person on a flaky connection does without being told to.
      if ('error' in r) pending = null
      return r
    })
  }
  return pending
}

async function load(): Promise<Engine | ApiError> {
  let coreMod: typeof import('@openvideo/core')
  let pixiMod: typeof import('@openvideo/engine-pixi')
  try {
    ;[coreMod, pixiMod] = await Promise.all([
      import('@openvideo/core'),
      import('@openvideo/engine-pixi'),
    ])
  } catch (e) {
    // Two causes a person can act on, and they differ: a dropped connection is
    // fixed by asking again, a deploy that replaced the hashed chunk names
    // under an open tab only by a reload. `detail` carries which.
    return {
      error: `The video editor (OpenVideo ${OPENVIDEO_PIN}) could not be loaded. `
        + 'Try again; if the app was just updated, reload the page.',
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    }
  }

  // Set once, before any Core exists. Without a provider the Core cannot read a
  // clip's real size or length, so it silently falls back to 600x400 and five
  // seconds for every clip — a 14-second take arrives cut to five with nothing
  // saying so. The provider is global to the package, hence once, here.
  coreMod.CoreConfig.setMetadataProvider(new coreMod.BrowserMetadataProvider())

  const { Core } = coreMod
  const { Studio } = pixiMod

  return {
    createCore: (initial) => new Core(initial),
    mountStudio: async (canvas, core, size) => {
      if (!canvas.parentElement) throw new StageDetachedError()
      const studio = new Studio({
        width: size.width,
        height: size.height,
        canvas,
        core,
        interactivity: false,
      })
      try {
        await studio.ready
      } catch (e) {
        studio.destroy()
        return {
          error: 'The preview could not start its renderer — this browser would not give '
            + 'the editor a WebGL context to draw with.',
          detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        }
      }
      return studio
    },
    Compositor: pixiMod.Compositor,
  }
}

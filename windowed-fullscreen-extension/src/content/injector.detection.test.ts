import { describe, expect, it } from "vitest";

import { createButtonInjector } from "./injector.js";
import { BUTTON_MARKER_ATTR } from "../core/controller.js";
import type {
  MutationObserverFactory,
  MutationObserverLike,
} from "../core/controller.js";
import { createLogger, LOG_CODES, type Logger } from "../shared/logger.js";
import type { SiteAdapter } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Deterministic test seams
//
// These unit tests exercise the bounded detection / re-render loops in
// injector.ts (task 7.2) for the failure paths called out by Requirements 7.1,
// 7.2 and 7.5. The loops are driven entirely through injectable seams:
//   - a queue-based fake setTimeout/clearTimeout with a `drain()` helper, and
//   - a controllable fake MutationObserver whose callback we can fire on demand.
// No real timers or real observers are used, so the loops run synchronously and
// deterministically.
// ---------------------------------------------------------------------------

interface FakeTimers {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /**
   * Run all queued timer callbacks (including those scheduled by callbacks that
   * run during draining) until the queue is empty. A safety cap guards against
   * an accidental infinite reschedule.
   */
  drain: () => void;
  /** Number of timer callbacks still pending. */
  pending: () => number;
}

/** Build a queue-based fake timer pair with a drain helper. */
function makeFakeTimers(maxTicks = 1000): FakeTimers {
  interface Timer {
    id: number;
    handler: () => void;
  }
  let nextId = 1;
  let queue: Timer[] = [];

  return {
    setTimeout: (handler: () => void): unknown => {
      const id = nextId++;
      queue.push({ id, handler });
      return id;
    },
    clearTimeout: (id: unknown): void => {
      queue = queue.filter((t) => t.id !== id);
    },
    drain: (): void => {
      let ticks = 0;
      while (queue.length > 0) {
        if (++ticks > maxTicks) {
          throw new Error("Fake timer drain exceeded the safety cap");
        }
        const next = queue.shift() as Timer;
        next.handler();
      }
    },
    pending: (): number => queue.length,
  };
}

interface FakeObserver {
  factory: MutationObserverFactory;
  /** Invoke the most recently created observer's callback. */
  fire: () => void;
}

/** Build a controllable MutationObserver factory whose callback we can fire. */
function makeFakeObserver(): FakeObserver {
  let callback: MutationCallback | null = null;
  const factory: MutationObserverFactory = (
    cb: MutationCallback,
  ): MutationObserverLike => {
    callback = cb;
    return {
      observe: (): void => {},
      disconnect: (): void => {},
    };
  };
  return {
    factory,
    fire: (): void => {
      callback?.([], {} as unknown as MutationObserver);
    },
  };
}

function makeLogger(): Logger {
  return createLogger("content", { mirrorToConsole: false });
}

function codesOf(logger: Logger): string[] {
  return logger.getEntries().map((e) => e.code);
}

// ---------------------------------------------------------------------------
// Detection-timeout skip (Requirements 7.1, 7.2)
// ---------------------------------------------------------------------------

describe("ButtonInjector — bounded detection failure paths", () => {
  // Requirement 7.1: the active Site_Adapter cannot locate the video player.
  it("skips rendering, leaves the page unchanged, and logs player-not-found when the player never appears (Req 7.1)", () => {
    document.body.innerHTML = "<div id='page'>untouched</div>";
    const htmlBefore = document.body.innerHTML;

    const timers = makeFakeTimers();
    const observer = makeFakeObserver();
    const logger = makeLogger();

    // The adapter can resolve nothing: no player, no controls, no native control.
    const adapter: SiteAdapter = {
      siteId: "no-player",
      matches: () => true,
      findControlsContainer: () => null,
      findNativeFullscreenButton: () => null,
      findPlayer: () => null,
      getSiteChromeSelectors: () => [],
      onVideoChange: () => () => {},
    };

    const inj = createButtonInjector({
      adapter,
      document,
      logger,
      createObserver: observer.factory,
      scheduleEnsure: (run) => run(),
      isActive: () => false,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      detectionIntervalMs: 1000,
      maxDetectionAttempts: 3,
    });

    inj.start(); // first detection attempt runs synchronously
    timers.drain(); // run the remaining bounded attempts to exhaustion

    // Detection stopped at the bound, nothing left scheduled.
    expect(inj.detectionAttempts).toBe(3);
    expect(timers.pending()).toBe(0);

    // The page is unchanged: no button inserted anywhere in the document.
    expect(document.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length).toBe(0);
    expect(inj.button).toBeNull();
    expect(document.body.innerHTML).toBe(htmlBefore);

    // Exactly one diagnostic, and it is player-not-found (Req 7.1).
    expect(codesOf(logger)).toEqual([LOG_CODES.PLAYER_NOT_FOUND]);

    inj.stop();
  });

  // Requirement 7.2: the player exists but the native control cannot be found.
  it("skips rendering, leaves the page unchanged, and logs native-control-not-found when the native control never appears (Req 7.2)", () => {
    document.body.innerHTML = "";
    const player = document.createElement("div");
    player.className = "player";
    document.body.appendChild(player);
    const htmlBefore = document.body.innerHTML;

    const timers = makeFakeTimers();
    const observer = makeFakeObserver();
    const logger = makeLogger();

    // The player resolves, but the controls container / native control do not.
    const adapter: SiteAdapter = {
      siteId: "no-native",
      matches: () => true,
      findControlsContainer: () => null,
      findNativeFullscreenButton: () => null,
      findPlayer: () => player,
      getSiteChromeSelectors: () => [],
      onVideoChange: () => () => {},
    };

    const inj = createButtonInjector({
      adapter,
      document,
      logger,
      createObserver: observer.factory,
      scheduleEnsure: (run) => run(),
      isActive: () => false,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      detectionIntervalMs: 1000,
      maxDetectionAttempts: 3,
    });

    inj.start();
    timers.drain();

    expect(inj.detectionAttempts).toBe(3);
    expect(timers.pending()).toBe(0);

    // Page unchanged, no button injected.
    expect(document.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length).toBe(0);
    expect(inj.button).toBeNull();
    expect(document.body.innerHTML).toBe(htmlBefore);

    // Exactly one diagnostic, and it is native-control-not-found (Req 7.2).
    expect(codesOf(logger)).toEqual([LOG_CODES.NATIVE_CONTROL_NOT_FOUND]);

    inj.stop();
  });
});

// ---------------------------------------------------------------------------
// Re-render abandonment after the reappearance window (Requirement 7.5)
// ---------------------------------------------------------------------------

describe("ButtonInjector — re-render abandonment", () => {
  // Requirement 7.5: the page removes the button while inactive and the
  // controls never reappear within the re-render window, so the loop abandons.
  it("abandons re-rendering and logs re-render-abandoned after controls stay absent for >= reRenderTimeoutMs (Req 7.5)", () => {
    document.body.innerHTML = "";
    const player = document.createElement("div");
    player.className = "player";
    const container = document.createElement("div");
    container.className = "controls";
    const native = document.createElement("button");
    native.className = "native-fullscreen";
    native.setAttribute("aria-label", "Full screen");
    container.appendChild(native);
    player.appendChild(container);
    document.body.appendChild(player);

    // Controls are present initially, then removed to simulate a page re-render.
    let controlsPresent = true;
    const adapter: SiteAdapter = {
      siteId: "vanishing-controls",
      matches: () => true,
      findControlsContainer: () => (controlsPresent ? container : null),
      findNativeFullscreenButton: () => (controlsPresent ? native : null),
      findPlayer: () => player,
      getSiteChromeSelectors: () => [],
      onVideoChange: () => () => {},
    };

    const timers = makeFakeTimers();
    const observer = makeFakeObserver();
    const logger = makeLogger();

    const reRenderIntervalMs = 2000;
    const reRenderTimeoutMs = 30_000;

    const inj = createButtonInjector({
      adapter,
      document,
      logger,
      createObserver: observer.factory,
      scheduleEnsure: (run) => run(),
      isActive: () => false, // mode stays INACTIVE throughout (Req 7.4/7.5)
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      reRenderIntervalMs,
      reRenderTimeoutMs,
    });

    // Initial detection succeeds: a button is injected next to the native one.
    inj.start();
    const injected = inj.button;
    expect(injected).not.toBeNull();
    expect(container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length).toBe(1);

    // The page removes the owned button AND the controls disappear.
    (injected as Element).remove();
    controlsPresent = false;

    // The subtree mutation fires: the injector sees its button was removed while
    // inactive and hands off to the bounded re-render loop.
    observer.fire();

    // Pre-condition: not yet abandoned, a re-render tick is scheduled.
    expect(inj.reRenderAbandoned).toBe(false);

    // Drive the loop: controls never reappear, so it ticks until the window
    // elapses and abandons.
    timers.drain();

    // The loop abandoned and recorded the diagnostic (Req 7.5).
    expect(inj.reRenderAbandoned).toBe(true);
    expect(codesOf(logger)).toContain(LOG_CODES.RE_RENDER_ABANDONED);

    // No button was re-rendered while the controls were absent.
    expect(container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length).toBe(0);

    // The abandonment entry recorded the elapsed window it waited (>= timeout).
    const abandoned = logger
      .getEntries()
      .find((e) => e.code === LOG_CODES.RE_RENDER_ABANDONED);
    expect(abandoned).toBeDefined();
    expect(abandoned?.context.elapsedMs as number).toBeGreaterThanOrEqual(
      reRenderTimeoutMs,
    );

    inj.stop();
  });
});

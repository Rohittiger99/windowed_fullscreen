import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createButtonInjector } from "./injector.js";
import { BUTTON_MARKER_ATTR } from "../core/controller.js";
import type {
  MutationObserverFactory,
  MutationObserverLike,
} from "../core/controller.js";
import { createLogger } from "../shared/logger.js";
import type { SiteAdapter } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Deterministic test seams (shared with injector.detection.test.ts)
//
// Property 4 exercises the two bounded loops in injector.ts through injectable
// seams so they run synchronously and deterministically:
//   - a queue-based fake setTimeout/clearTimeout with a `drain()` helper whose
//     safety cap guards against an accidental infinite reschedule, and
//   - a controllable fake MutationObserver whose callback we can `fire()`.
// No real timers or real observers are used.
// ---------------------------------------------------------------------------

interface FakeTimers {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /**
   * Run all queued timer callbacks (including those scheduled while draining)
   * until the queue is empty. The safety cap proves the loop terminates on its
   * own rather than rescheduling forever.
   */
  drain: () => void;
  /** Number of timer callbacks still pending. */
  pending: () => number;
}

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

function makeLogger() {
  return createLogger("content", { mirrorToConsole: false });
}

/** Adapter that can never resolve a render target (player/controls absent). */
function makeNoTargetAdapter(): SiteAdapter {
  return {
    siteId: "no-target",
    matches: () => true,
    findControlsContainer: () => null,
    findNativeFullscreenButton: () => null,
    findPlayer: () => null,
    getSiteChromeSelectors: () => [],
    onVideoChange: () => () => {},
  };
}

/**
 * Build a player + controls container holding `siblingCount` arbitrary sibling
 * controls and a native fullscreen button, and return an adapter that always
 * resolves them. Used for the re-render-bound scenario where the controls are
 * always available, so each removal can be re-rendered (until the bound).
 */
function makeRenderablePage(siblingCount: number): {
  adapter: SiteAdapter;
  container: HTMLElement;
} {
  document.body.innerHTML = "";

  const player = document.createElement("div");
  player.className = "player";
  const container = document.createElement("div");
  container.className = "controls";
  for (let i = 0; i < siblingCount; i++) {
    const sibling = document.createElement("button");
    sibling.className = "other-control";
    sibling.setAttribute("aria-label", `control-${i}`);
    container.appendChild(sibling);
  }
  const native = document.createElement("button");
  native.className = "native-fullscreen";
  native.setAttribute("aria-label", "Full screen");
  container.appendChild(native);
  player.appendChild(container);
  document.body.appendChild(player);

  const adapter: SiteAdapter = {
    siteId: "renderable",
    matches: () => true,
    findControlsContainer: () => container,
    findNativeFullscreenButton: () => native,
    findPlayer: () => player,
    getSiteChromeSelectors: () => [],
    onVideoChange: () => () => {},
  };
  return { adapter, container };
}

describe("ButtonInjector — Property 4", () => {
  // Feature: windowed-fullscreen-extension, Property 4: Detection and re-render attempts are bounded — For any run in which the required elements never become available, the number of initial detection attempts never exceeds 10, and for any run in which the button is repeatedly removed while the mode is inactive, the number of re-render attempts never exceeds 5; once a bound is reached, the corresponding loop stops.
  // Validates: Requirements 1.6, 7.4

  it("bounds initial detection attempts and stops the loop when the target never appears", () => {
    fc.assert(
      fc.property(
        // A generated detection bound, always within the documented ceiling of 10.
        fc.integer({ min: 1, max: 10 }),
        // The retry interval (≤2s) does not change the bound — vary it anyway.
        fc.integer({ min: 100, max: 2000 }),
        (maxDetectionAttempts, detectionIntervalMs) => {
          document.body.innerHTML = "<div id='page'>untouched</div>";
          const htmlBefore = document.body.innerHTML;

          const timers = makeFakeTimers();
          const observer = makeFakeObserver();

          const inj = createButtonInjector({
            adapter: makeNoTargetAdapter(),
            document,
            logger: makeLogger(),
            createObserver: observer.factory,
            scheduleEnsure: (run) => run(),
            isActive: () => false,
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
            detectionIntervalMs,
            maxDetectionAttempts,
          });

          inj.start(); // first attempt runs synchronously
          timers.drain(); // run the remaining bounded attempts to exhaustion

          // The number of detection attempts never exceeds the bound (≤ 10).
          expect(inj.detectionAttempts).toBeLessThanOrEqual(maxDetectionAttempts);
          expect(inj.detectionAttempts).toBeLessThanOrEqual(10);
          // The target never appears, so the loop runs exactly to the bound.
          expect(inj.detectionAttempts).toBe(maxDetectionAttempts);
          // Once the bound is reached the loop stopped: nothing remains pending,
          // and draining again schedules no further work.
          expect(timers.pending()).toBe(0);
          timers.drain();
          expect(inj.detectionAttempts).toBe(maxDetectionAttempts);
          expect(timers.pending()).toBe(0);
          // The page was left unchanged and no button was injected.
          expect(
            document.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length,
          ).toBe(0);
          expect(inj.button).toBeNull();
          expect(document.body.innerHTML).toBe(htmlBefore);

          inj.stop();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("bounds re-render attempts and stops re-rendering once the bound is reached", () => {
    fc.assert(
      fc.property(
        // More removal cycles than the re-render bound (default 5).
        fc.integer({ min: 6, max: 15 }),
        // Arbitrary number of sibling controls alongside the native button.
        fc.integer({ min: 0, max: 5 }),
        (removalCycles, siblingCount) => {
          const maxReRenderAttempts = 5; // documented default bound (Req 7.4)
          const { adapter, container } = makeRenderablePage(siblingCount);

          const timers = makeFakeTimers();
          const observer = makeFakeObserver();

          const inj = createButtonInjector({
            adapter,
            document,
            logger: makeLogger(),
            createObserver: observer.factory,
            scheduleEnsure: (run) => run(),
            isActive: () => false, // mode stays INACTIVE throughout (Req 7.4)
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
            reRenderIntervalMs: 2000,
            maxReRenderAttempts,
            reRenderTimeoutMs: 30_000,
          });

          // Initial detection succeeds: a button is injected next to the native.
          inj.start();
          expect(inj.button).not.toBeNull();
          expect(
            container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length,
          ).toBe(1);

          // Repeatedly remove the owned button while inactive and let the
          // observer drive the bounded re-render loop. The controls are always
          // present, so each cycle within the bound re-renders synchronously.
          for (let cycle = 0; cycle < removalCycles; cycle++) {
            const owned = inj.button;
            if (owned) {
              owned.remove();
            }
            observer.fire();
            timers.drain();
          }

          // The number of re-render attempts never exceeds the bound (5).
          expect(inj.reRenderAttempts).toBeLessThanOrEqual(maxReRenderAttempts);
          // With more removals than the bound, the loop ran exactly to the bound.
          expect(inj.reRenderAttempts).toBe(maxReRenderAttempts);
          // Once the bound was reached the loop stopped: the final removal (well
          // beyond the bound) was NOT re-rendered, leaving the container empty.
          expect(
            container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length,
          ).toBe(0);
          // The loop stopped on its own — nothing remains scheduled.
          expect(timers.pending()).toBe(0);
          // Controls were always present, so re-render was never abandoned.
          expect(inj.reRenderAbandoned).toBe(false);

          // One more removal + fire confirms the loop no longer re-renders or
          // schedules once the bound has been reached.
          const owned = inj.button;
          if (owned) {
            owned.remove();
          }
          observer.fire();
          timers.drain();
          expect(inj.reRenderAttempts).toBe(maxReRenderAttempts);
          expect(
            container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`).length,
          ).toBe(0);
          expect(timers.pending()).toBe(0);

          inj.stop();
        },
      ),
      { numRuns: 100 },
    );
  });
});

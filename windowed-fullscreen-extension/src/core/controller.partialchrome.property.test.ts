import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createController } from "./controller.js";
import type { MutationObserverLike } from "./controller.js";
import { createLogger, LOG_CODES } from "../shared/logger.js";
import type { SiteDescriptor } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Test doubles / generators
// ---------------------------------------------------------------------------

/**
 * A no-op MutationObserver stand-in so the controller's player-loss watcher
 * stays inert during the property (we only exercise entry here). Matches the
 * injection pattern used in controller.test.ts.
 */
function noopObserverFactory(): MutationObserverLike {
  return {
    observe: () => {},
    disconnect: () => {},
  };
}

// A mix of "present" chrome elements (created in the DOM, passed in
// siteChromeElements) and "absent" selectors (strings placed in
// missingChromeSelectors). At least one of each is guaranteed so every run is a
// genuine partial-chrome scenario.
const partialChromeArb = fc.record({
  presentCount: fc.integer({ min: 1, max: 6 }),
  // Distinct, non-empty selector strings for the absent set. Distinctness keeps
  // the per-selector log assertion unambiguous.
  missingSelectors: fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
      minLength: 1,
      maxLength: 6,
    }),
});

describe("WindowedFullscreenController — Property 8", () => {
  // Feature: windowed-fullscreen-extension, Property 8: Partial chrome — hide located, log absent, still enter — For any chrome selector set in which some selectors resolve to elements and some resolve to nothing, entering Windowed_Fullscreen_Mode hides exactly the located elements, records a diagnostic log entry for each absent selector, and still completes entry.
  // Validates: Requirements 7.3
  it("hides located chrome, logs each absent selector, and still enters", () => {
    fc.assert(
      fc.property(partialChromeArb, ({ presentCount, missingSelectors }) => {
        // Fresh document state and a fresh logger for each run.
        document.documentElement.className = "";
        document.body.innerHTML = "";
        const logger = createLogger("content", { mirrorToConsole: false });

        // Player + native control (required for a complete descriptor).
        const player = document.createElement("video");
        document.body.appendChild(player);
        const nativeButton = document.createElement("button");
        document.body.appendChild(nativeButton);

        // Present chrome elements: created in jsdom and resolved.
        const presentChrome: HTMLElement[] = [];
        for (let i = 0; i < presentCount; i++) {
          const el = document.createElement("div");
          document.body.appendChild(el);
          presentChrome.push(el);
        }

        const descriptor: SiteDescriptor = {
          player,
          nativeFullscreenButton: nativeButton,
          controlsContainer: nativeButton,
          siteChromeElements: presentChrome,
          missingChromeSelectors: missingSelectors,
        };

        const controller = createController({
          document,
          logger,
          createObserver: noopObserverFactory,
        });

        const result = controller.enter(descriptor);

        // Entry still completes successfully despite absent selectors.
        expect(result).toEqual({ ok: true });
        expect(controller.isActive).toBe(true);

        // Every located element is hidden.
        for (const el of presentChrome) {
          expect(el.style.display).toBe("none");
          expect(el.style.visibility).toBe("hidden");
        }

        // Exactly one absent-chrome log entry per missing selector, matching.
        const absent = logger
          .getEntries()
          .filter((e) => e.code === LOG_CODES.ABSENT_CHROME);
        expect(absent).toHaveLength(missingSelectors.length);
        expect(absent.map((e) => e.context.selector)).toEqual(missingSelectors);
      }),
      { numRuns: 100 },
    );
  });
});

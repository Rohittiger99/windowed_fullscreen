import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import { WINDOWED_CLASS, createController } from "./controller.js";
import type { MutationObserverLike } from "./controller.js";
import { createLogger } from "../shared/logger.js";
import type { SiteDescriptor } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A no-op {@link MutationObserverLike} factory. Property 7 only concerns the
 * refusal path (no mutation, no watcher start), but injecting a deterministic
 * fake keeps the controller from touching the ambient async MutationObserver.
 */
const noopObserverFactory = (): MutationObserverLike => ({
  observe: () => {},
  disconnect: () => {},
});

// ---------------------------------------------------------------------------
// Page builder
// ---------------------------------------------------------------------------

/**
 * Build a small, varied page in the ambient jsdom document. The structure is
 * randomised (chrome count, optional inline player style, an optional
 * pre-existing windowed class) so the byte-identical assertion is exercised
 * against many starting DOM states. Returns the references a complete
 * descriptor would carry.
 */
function buildPage(spec: {
  chromeCount: number;
  playerInlineStyle: string;
  preWindowedClass: boolean;
}): {
  player: HTMLElement;
  nativeButton: HTMLElement;
  controls: HTMLElement;
  chrome: HTMLElement[];
} {
  document.documentElement.className = spec.preWindowedClass ? WINDOWED_CLASS : "";
  document.body.innerHTML = "";

  const player = document.createElement("video");
  if (spec.playerInlineStyle) {
    player.setAttribute("style", spec.playerInlineStyle);
  }
  document.body.appendChild(player);

  const controls = document.createElement("div");
  const nativeButton = document.createElement("button");
  controls.appendChild(nativeButton);
  document.body.appendChild(controls);

  const chrome: HTMLElement[] = [];
  for (let i = 0; i < spec.chromeCount; i++) {
    const el = document.createElement("div");
    el.dataset.chrome = String(i);
    el.textContent = `chrome-${i}`;
    document.body.appendChild(el);
    chrome.push(el);
  }

  return { player, nativeButton, controls, chrome };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** The ways a descriptor can be made incomplete (Requirement 6.2). */
type Defect =
  | "drop-player"
  | "drop-native-button"
  | "chrome-not-array"
  | "missing-not-array";

const pageSpecArb = fc.record({
  chromeCount: fc.integer({ min: 0, max: 4 }),
  playerInlineStyle: fc.constantFrom("", "width: 640px;", "position: relative;"),
  preWindowedClass: fc.boolean(),
});

// A non-empty subset of defects so at least one required field is broken, while
// also covering combinations of multiple simultaneous defects.
const defectsArb: fc.Arbitrary<Defect[]> = fc
  .uniqueArray(
    fc.constantFrom<Defect>(
      "drop-player",
      "drop-native-button",
      "chrome-not-array",
      "missing-not-array",
    ),
    { minLength: 1, maxLength: 4 },
  );

// Non-array junk values used to violate the array-typed fields.
const nonArrayArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant("not-an-array"),
  fc.integer(),
  fc.constant({}),
);

const scenarioArb = fc.record({
  page: pageSpecArb,
  defects: defectsArb,
  badChrome: nonArrayArb,
  badMissing: nonArrayArb,
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

describe("WindowedFullscreenController — Property 7", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  // Feature: windowed-fullscreen-extension, Property 7: Incomplete descriptor refuses entry and preserves state — For any SiteDescriptor missing the player reference, the native control reference, or the chrome selectors, the Generic_Core does not enter Windowed_Fullscreen_Mode and the DOM is identical to its state immediately before the entry attempt.
  // Validates: Requirements 6.2
  it("refuses entry for any incomplete descriptor and leaves the DOM byte-identical", () => {
    fc.assert(
      fc.property(scenarioArb, ({ page, defects, badChrome, badMissing }) => {
        const refs = buildPage(page);
        const logger = createLogger("content", { mirrorToConsole: false });
        const controller = createController({
          document,
          logger,
          createObserver: noopObserverFactory,
        });

        // Start from a well-formed descriptor, then inject the chosen defect(s)
        // so at least one required field is missing/invalid (Requirement 6.2).
        const descriptor: SiteDescriptor = {
          player: refs.player,
          nativeFullscreenButton: refs.nativeButton,
          controlsContainer: refs.controls,
          siteChromeElements: refs.chrome,
          missingChromeSelectors: [],
        };
        for (const defect of defects) {
          switch (defect) {
            case "drop-player":
              (descriptor as { player: unknown }).player = undefined;
              break;
            case "drop-native-button":
              (descriptor as { nativeFullscreenButton: unknown }).nativeFullscreenButton =
                undefined;
              break;
            case "chrome-not-array":
              (descriptor as { siteChromeElements: unknown }).siteChromeElements =
                badChrome;
              break;
            case "missing-not-array":
              (descriptor as { missingChromeSelectors: unknown }).missingChromeSelectors =
                badMissing;
              break;
          }
        }

        // Snapshot the DOM state immediately before the entry attempt.
        const htmlBefore = document.documentElement.outerHTML;
        const hadWindowedClass =
          document.documentElement.classList.contains(WINDOWED_CLASS);

        const result = controller.enter(descriptor);

        // The core refuses entry with the documented reason.
        expect(result).toEqual({ ok: false, reason: "incomplete-descriptor" });
        // The mode never becomes active.
        expect(controller.isActive).toBe(false);
        // The DOM is byte-identical to its pre-attempt state.
        expect(document.documentElement.outerHTML).toBe(htmlBefore);
        // The windowed class state is unchanged.
        expect(document.documentElement.classList.contains(WINDOWED_CLASS)).toBe(
          hadWindowedClass,
        );
      }),
      { numRuns: 200 },
    );
  });
});

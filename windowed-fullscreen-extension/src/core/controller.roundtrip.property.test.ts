import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  BUTTON_ACTIVE_CLASS,
  BUTTON_MARKER_ATTR,
  WINDOWED_CLASS,
  createController,
} from "./controller.js";
import type { MutationObserverLike } from "./controller.js";
import { createLogger } from "../shared/logger.js";
import type { SiteDescriptor } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Fullscreen API spies (Requirement 2.4: the API is NEVER invoked)
// ---------------------------------------------------------------------------

/**
 * The mode must be achieved purely via inline-style/class manipulation. We spy
 * on every entry point the browser exposes for fullscreen — element-level
 * `requestFullscreen`, document-level `exitFullscreen`, and the
 * `fullscreenEnabled` capability getter — so the round-trip can assert none of
 * them is ever touched across enter/exit.
 */
const requestFullscreenSpy = vi.fn();
const exitFullscreenSpy = vi.fn();
const fullscreenEnabledGetter = vi.fn(() => true);

beforeAll(() => {
  (Element.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen =
    requestFullscreenSpy;
  (document as unknown as { exitFullscreen: unknown }).exitFullscreen =
    exitFullscreenSpy;
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    get: fullscreenEnabledGetter,
  });
});

afterAll(() => {
  delete (Element.prototype as unknown as { requestFullscreen?: unknown })
    .requestFullscreen;
  delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
  // Drop the spy getter so it does not leak into other suites.
  delete (document as unknown as { fullscreenEnabled?: unknown }).fullscreenEnabled;
});

// ---------------------------------------------------------------------------
// Injectable no-op observer
// ---------------------------------------------------------------------------

/**
 * A no-op {@link MutationObserverLike} so the controller's player-loss watcher
 * is inert during this test — we drive exits explicitly via toggle/Escape and
 * never remove the player, so the watcher must do nothing.
 */
const noopObserverFactory = (): MutationObserverLike => ({
  observe: () => {},
  disconnect: () => {},
});

// ---------------------------------------------------------------------------
// Inline-style generators
// ---------------------------------------------------------------------------

/**
 * Realistic value pools per CSS property. Using valid values keeps jsdom's
 * style serialization deterministic so the captured pre-entry `cssText` can be
 * compared for exact equality after exit. The pools intentionally include the
 * very properties the controller mutates (position/width/height/z-index/margin
 * on the player; display/visibility on chrome) so restoration of overwritten
 * values is exercised, not just untouched ones.
 */
const PROP_VALUES: Record<string, readonly string[]> = {
  position: ["static", "relative", "absolute"],
  width: ["100px", "50%", "640px", "auto", "320px"],
  height: ["100px", "75%", "360px", "auto"],
  display: ["block", "flex", "inline-block", "grid"],
  visibility: ["visible", "hidden"],
  margin: ["0px", "10px", "auto", "5px 10px"],
  "z-index": ["1", "10", "100", "auto"],
  top: ["0px", "5px", "10px"],
  left: ["0px", "5px", "20px"],
};

const ALL_PROPS = Object.keys(PROP_VALUES);

/**
 * Generate an arbitrary inline style as an ordered list of [prop, value] pairs:
 * a random subset of properties, each paired with a random valid value. May be
 * empty (no inline style at all).
 */
const styleArb: fc.Arbitrary<Array<[string, string]>> = fc
  .subarray(ALL_PROPS)
  .chain((props) => {
    if (props.length === 0) {
      return fc.constant<Array<[string, string]>>([]);
    }
    return fc
      .tuple(...props.map((p) => fc.constantFrom(...PROP_VALUES[p])))
      .map((vals) =>
        props.map((p, i) => [p, vals[i] as string] as [string, string]),
      );
  });

function toStyleString(pairs: Array<[string, string]>): string {
  return pairs.map(([p, v]) => `${p}: ${v};`).join(" ");
}

const scenarioArb = fc.record({
  playerStyle: styleArb,
  chromeStyles: fc.array(styleArb, { maxLength: 5 }),
  // Per run, exit either by re-activating (toggle) or by pressing Escape.
  exitMode: fc.constantFrom("toggle" as const, "escape" as const),
});

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

describe("WindowedFullscreenController — Property 3", () => {
  // Feature: windowed-fullscreen-extension, Property 3: Toggle/restore round-trip preserves layout and never goes fullscreen — For any DOM containing a player and Site_Chrome elements with arbitrary initial inline styles, capturing the DOM's inline-style state, then entering Windowed_Fullscreen_Mode, then exiting (whether the exit is triggered by re-activating the button or by pressing Escape) restores every affected element's inline styles to exactly the captured pre-entry state; the controller's active flag and the button's engaged/inactive visual state agree at every step; and across the entire sequence the browser Fullscreen API is never called.
  // Validates: Requirements 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10
  it("round-trips inline styles exactly, keeps button state in sync, and never calls the Fullscreen API", () => {
    fc.assert(
      fc.property(scenarioArb, ({ playerStyle, chromeStyles, exitMode }) => {
        // Fresh DOM per run.
        document.documentElement.className = "";
        document.body.innerHTML = "";

        const player = document.createElement("video");
        if (playerStyle.length > 0) {
          player.setAttribute("style", toStyleString(playerStyle));
        }
        document.body.appendChild(player);

        const controls = document.createElement("div");
        const nativeButton = document.createElement("button");
        controls.appendChild(nativeButton);
        document.body.appendChild(controls);

        const chrome: HTMLElement[] = chromeStyles.map((s) => {
          const el = document.createElement("div");
          if (s.length > 0) {
            el.setAttribute("style", toStyleString(s));
          }
          document.body.appendChild(el);
          return el;
        });

        const button = document.createElement("button");
        button.setAttribute(BUTTON_MARKER_ATTR, "");
        document.body.appendChild(button);

        // Capture the exact pre-entry inline state via serialized cssText, which
        // jsdom normalizes consistently so equality is well-defined (Req 2.8).
        const playerBefore = player.style.cssText;
        const chromeBefore = chrome.map((el) => el.style.cssText);

        const logger = createLogger("content", { mirrorToConsole: false });
        const controller = createController({
          document,
          logger,
          button,
          createObserver: noopObserverFactory,
        });
        // Initialize the button so its visual state reflects isActive from the start.
        controller.setButton(button);

        // The button's engaged/inactive visual state must agree with isActive (Req 2.10).
        const assertButtonAgrees = (): void => {
          const expected = controller.isActive;
          expect(button.getAttribute("aria-pressed")).toBe(
            expected ? "true" : "false",
          );
          expect(button.classList.contains(BUTTON_ACTIVE_CLASS)).toBe(expected);
        };

        // Reset Fullscreen spies for this run so the assertion is per-iteration.
        requestFullscreenSpy.mockClear();
        exitFullscreenSpy.mockClear();
        fullscreenEnabledGetter.mockClear();

        // Step 0 — inactive before entry; button agrees.
        expect(controller.isActive).toBe(false);
        assertButtonAgrees();

        const descriptor: SiteDescriptor = {
          player,
          nativeFullscreenButton: nativeButton,
          controlsContainer: controls,
          siteChromeElements: chrome,
          missingChromeSelectors: [],
        };

        // Step 1 — enter (Req 2.1).
        const result = controller.enter(descriptor);
        expect(result).toEqual({ ok: true });
        expect(controller.isActive).toBe(true);
        assertButtonAgrees();

        // Step 2 — exit, either by re-activating (toggle) or pressing Escape (Req 2.5, 2.7).
        if (exitMode === "toggle") {
          controller.toggle(() => descriptor);
        } else {
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape" }),
          );
        }
        expect(controller.isActive).toBe(false);
        assertButtonAgrees();

        // Step 3 — every affected element restored to exactly its pre-entry inline state (Req 2.6).
        expect(player.style.cssText).toBe(playerBefore);
        chrome.forEach((el, i) => {
          expect(el.style.cssText).toBe(chromeBefore[i]);
        });
        expect(
          document.documentElement.classList.contains(WINDOWED_CLASS),
        ).toBe(false);

        // Across the whole sequence the Fullscreen API was never called (Req 2.4).
        expect(requestFullscreenSpy).not.toHaveBeenCalled();
        expect(exitFullscreenSpy).not.toHaveBeenCalled();
        expect(fullscreenEnabledGetter).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });
});

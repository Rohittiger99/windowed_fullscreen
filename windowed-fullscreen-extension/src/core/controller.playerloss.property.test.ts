import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { WINDOWED_CLASS, createController } from "./controller.js";
import type { MutationObserverLike } from "./controller.js";
import { createLogger, LOG_CODES } from "../shared/logger.js";
import type { SiteDescriptor } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Controllable fake observer (factory + synchronous trigger)
// ---------------------------------------------------------------------------

/**
 * A controllable stand-in for MutationObserver. Its {@link trigger} invokes the
 * registered callback synchronously, letting the property drive the
 * player-loss watcher deterministically instead of awaiting the real (async)
 * observer (Requirement 7.6).
 */
function makeFakeObserver(): {
  factory: (cb: MutationCallback) => MutationObserverLike;
  trigger: () => void;
} {
  let callback: MutationCallback | null = null;
  const factory = (cb: MutationCallback): MutationObserverLike => {
    callback = cb;
    return {
      observe: () => {},
      disconnect: () => {},
    };
  };
  return {
    factory,
    trigger: () => callback?.([], {} as unknown as MutationObserver),
  };
}

// ---------------------------------------------------------------------------
// Inline-style generators
// ---------------------------------------------------------------------------

/**
 * Realistic value pools per CSS property. Valid values keep jsdom's style
 * serialization deterministic so a captured pre-entry `cssText` can be compared
 * for exact equality after restoration. Pools include the very properties the
 * controller mutates on chrome (display/visibility) so restoration of
 * overwritten values is exercised, not only untouched ones.
 */
const PROP_VALUES: Record<string, readonly string[]> = {
  position: ["static", "relative", "absolute"],
  width: ["100px", "50%", "640px", "auto"],
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
 * a random subset of properties paired with random valid values. May be empty.
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
  chromeStyles: fc.array(styleArb, { maxLength: 6 }),
});

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

describe("WindowedFullscreenController — Property 9", () => {
  // Feature: windowed-fullscreen-extension, Property 9: Player loss while active exits and restores — For any active Windowed_Fullscreen_Mode with arbitrary Site_Chrome, removing the player element from the DOM causes the Generic_Core to exit, restore every previously hidden Site_Chrome element to its captured pre-entry state, and record a diagnostic log entry indicating the player was lost.
  // Validates: Requirements 7.6
  it("exits, restores every chrome element to its pre-entry state, and logs player-lost exactly once", () => {
    fc.assert(
      fc.property(scenarioArb, ({ playerStyle, chromeStyles }) => {
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

        // Capture each chrome element's exact pre-entry inline state.
        const chromeBefore = chrome.map((el) => el.style.cssText);

        // Fresh logger and controllable observer per run.
        const logger = createLogger("content", { mirrorToConsole: false });
        const observer = makeFakeObserver();
        const controller = createController({
          document,
          logger,
          createObserver: observer.factory,
        });

        const descriptor: SiteDescriptor = {
          player,
          nativeFullscreenButton: nativeButton,
          controlsContainer: controls,
          siteChromeElements: chrome,
          missingChromeSelectors: [],
        };

        // Enter and confirm the mode is active.
        const result = controller.enter(descriptor);
        expect(result).toEqual({ ok: true });
        expect(controller.isActive).toBe(true);

        // Remove the player from the DOM, then drive the watcher synchronously.
        player.remove();
        observer.trigger();

        // The core exited.
        expect(controller.isActive).toBe(false);

        // Every chrome element restored to exactly its captured pre-entry state.
        chrome.forEach((el, i) => {
          expect(el.style.cssText).toBe(chromeBefore[i]);
        });
        expect(
          document.documentElement.classList.contains(WINDOWED_CLASS),
        ).toBe(false);

        // Exactly one player-lost diagnostic recorded.
        const lost = logger
          .getEntries()
          .filter((e) => e.code === LOG_CODES.PLAYER_LOST);
        expect(lost).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });
});

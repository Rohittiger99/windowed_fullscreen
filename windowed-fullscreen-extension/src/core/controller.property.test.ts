import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { WINDOWED_CLASS, createController } from "./controller.js";
import type { MutationObserverLike } from "./controller.js";
import { createLogger } from "../shared/logger.js";
import type { SiteDescriptor } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * A no-op {@link MutationObserverLike} factory. Property 2 only inspects the
 * synchronous post-conditions of `enter`, so the player-loss watcher is stubbed
 * out to avoid real (async) MutationObserver noise.
 */
const noopObserverFactory = (): MutationObserverLike => ({
  observe: () => {},
  disconnect: () => {},
});

/**
 * Build a complete page (player + native control + an arbitrary number of
 * Site_Chrome elements) in the ambient jsdom document, resetting any prior
 * state so each property run starts from a clean document.
 */
function buildPage(chromeCount: number): {
  player: HTMLElement;
  nativeButton: HTMLElement;
  controls: HTMLElement;
  chrome: HTMLElement[];
} {
  document.documentElement.className = "";
  document.body.innerHTML = "";

  const player = document.createElement("video");
  document.body.appendChild(player);

  const controls = document.createElement("div");
  const nativeButton = document.createElement("button");
  controls.appendChild(nativeButton);
  document.body.appendChild(controls);

  const chrome: HTMLElement[] = [];
  for (let i = 0; i < chromeCount; i++) {
    const el = document.createElement("div");
    el.dataset.chrome = String(i);
    document.body.appendChild(el);
    chrome.push(el);
  }

  return { player, nativeButton, controls, chrome };
}

function makeDescriptor(page: ReturnType<typeof buildPage>): SiteDescriptor {
  return {
    player: page.player,
    nativeFullscreenButton: page.nativeButton,
    controlsContainer: page.controls,
    siteChromeElements: page.chrome,
    missingChromeSelectors: [],
  };
}

describe("WindowedFullscreenController — Property 2", () => {
  // Feature: windowed-fullscreen-extension, Property 2: Entry post-conditions hold — For any complete SiteDescriptor (player present, native control present, and a chrome selector set that may be empty), after the Generic_Core enters Windowed_Fullscreen_Mode the player is sized to fill the viewport (full width and full height), every located Site_Chrome element is hidden, and entry completes successfully even when the chrome set is empty.
  // Validates: Requirements 2.2, 2.3, 2.9
  it("fills the viewport, hides every located chrome element, and succeeds even with an empty chrome set", () => {
    fc.assert(
      fc.property(
        // An arbitrary number of chrome elements, including 0 (Req 2.9).
        fc.integer({ min: 0, max: 12 }),
        (chromeCount) => {
          const page = buildPage(chromeCount);
          const logger = createLogger("content", { mirrorToConsole: false });
          const controller = createController({
            document,
            logger,
            createObserver: noopObserverFactory,
          });

          const result = controller.enter(makeDescriptor(page));

          // Entry completes successfully, even when the chrome set is empty.
          expect(result).toEqual({ ok: true });
          expect(controller.isActive).toBe(true);

          // Player fills the viewport: full width and full height (Req 2.2).
          expect(page.player.style.width).toBe("100vw");
          expect(page.player.style.height).toBe("100vh");
          expect(page.player.style.position).toBe("fixed");
          expect(
            document.documentElement.classList.contains(WINDOWED_CLASS),
          ).toBe(true);

          // Every located Site_Chrome element is hidden (Req 2.3).
          for (const el of page.chrome) {
            expect(el.style.display).toBe("none");
            expect(el.style.visibility).toBe("hidden");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

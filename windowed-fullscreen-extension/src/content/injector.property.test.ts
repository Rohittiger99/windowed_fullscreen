import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createButtonInjector } from "./injector.js";
import { BUTTON_MARKER_ATTR } from "../core/controller.js";
import type { MutationObserverLike } from "../core/controller.js";
import { createLogger } from "../shared/logger.js";
import type { SiteAdapter } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Compute an element's effective accessible name the same way the injector does
 * (aria-label, then title, then trimmed text). Used to assert the injected
 * control's name is non-empty and distinct from the native control's (Req 1.3).
 */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) {
    return label.trim();
  }
  const title = el.getAttribute("title");
  if (title && title.trim()) {
    return title.trim();
  }
  return (el.textContent ?? "").trim();
}

/**
 * A controllable {@link MutationObserverLike} factory. Property 1 only inspects
 * the synchronous post-conditions of `ensureButton`, so the subtree observer is
 * a no-op fake that never fires.
 */
const fakeObserverFactory = (): MutationObserverLike => ({
  observe: () => {},
  disconnect: () => {},
});

interface BuiltPage {
  container: HTMLElement;
  native: HTMLElement;
  /** The native control's index among the container's element children. */
  nativeIndex: number;
}

/**
 * Build a controls container holding `siblingCount` arbitrary sibling controls
 * with the native fullscreen button inserted at `nativeIndex`, in the ambient
 * jsdom document. The document is reset so each run starts clean.
 */
function buildPage(
  siblingCount: number,
  nativeIndex: number,
  nativeLabel: string,
): BuiltPage {
  document.body.innerHTML = "";

  const player = document.createElement("div");
  player.className = "player";
  const container = document.createElement("div");
  container.className = "controls";
  player.appendChild(container);
  document.body.appendChild(player);

  // Sibling controls (not the native button, not marked).
  for (let i = 0; i < siblingCount; i++) {
    const sibling = document.createElement("button");
    sibling.className = "other-control";
    sibling.setAttribute("aria-label", `control-${i}`);
    container.appendChild(sibling);
  }

  // The native fullscreen control, placed at the requested index.
  const native = document.createElement("button");
  native.className = "native-fullscreen";
  native.setAttribute("data-native", "true");
  if (nativeLabel.length > 0) {
    native.setAttribute("aria-label", nativeLabel);
  }
  const children = Array.from(container.children);
  if (nativeIndex >= children.length) {
    container.appendChild(native);
  } else {
    container.insertBefore(native, children[nativeIndex]);
  }

  const finalIndex = Array.from(container.children).indexOf(native);
  return { container, native, nativeIndex: finalIndex };
}

function makeAdapter(page: BuiltPage): {
  adapter: SiteAdapter;
  triggerVideoChange: () => void;
} {
  let videoChangeCb: (() => void) | null = null;
  const adapter: SiteAdapter = {
    siteId: "fake",
    matches: () => true,
    findControlsContainer: () => page.container,
    findNativeFullscreenButton: () => page.native,
    findPlayer: () => page.container.parentElement,
    getSiteChromeSelectors: () => [],
    onVideoChange: (_doc, cb) => {
      videoChangeCb = cb;
      return () => {
        videoChangeCb = null;
      };
    },
  };
  return {
    adapter,
    triggerVideoChange: () => videoChangeCb?.(),
  };
}

describe("ButtonInjector — Property 1", () => {
  // Feature: windowed-fullscreen-extension, Property 1: Injection is idempotent and correctly placed — For any controls container holding a native fullscreen button (with any number of other sibling controls), running ensureButton one or more times — including across a simulated SPA video-change event — results in exactly one Windowed_Fullscreen_Button that is the immediate next sibling of the native button, carries an accessible name that is non-empty and distinct from the native button's accessible name, and leaves the native button's attributes and position unchanged.
  // Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
  it("ensures exactly one correctly placed, distinctly named button across repeated calls and SPA video changes, leaving the native control untouched", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }), // number of other sibling controls
        fc.nat(), // native button's index among siblings (taken modulo)
        fc.oneof(
          fc.string(),
          // Stress the distinct-name fallback paths (Req 1.3).
          fc.constant("Windowed fullscreen"),
          fc.constant("Windowed fullscreen (extension)"),
          fc.constant(""),
          fc.constant("Full screen"),
        ),
        fc.integer({ min: 1, max: 5 }), // repeated ensureButton invocations
        (siblingCount, nativeIndexSeed, nativeLabel, repeatCount) => {
          const nativeIndex = nativeIndexSeed % (siblingCount + 1);
          const page = buildPage(siblingCount, nativeIndex, nativeLabel);

          // Snapshot the native control's pre-injection state (Req 1.2).
          const nativeOuterHtmlBefore = page.native.outerHTML;
          const nativeIndexBefore = page.nativeIndex;
          const nativeName = accessibleName(page.native);

          const { adapter, triggerVideoChange } = makeAdapter(page);
          const inj = createButtonInjector({
            adapter,
            document,
            logger: createLogger("content", { mirrorToConsole: false }),
            createObserver: fakeObserverFactory,
            scheduleEnsure: (run) => run(),
            // Keep the bounded loops inert: the target exists, so detection
            // succeeds on the first synchronous attempt and schedules nothing.
            setTimeout: () => 0,
            clearTimeout: () => {},
          });

          // start() performs an initial injection and subscribes to the SPA
          // video-change hook (Req 1.5).
          inj.start();

          // Repeated ensureButton invocations (>= 1) must be idempotent (Req 1.4).
          for (let i = 0; i < repeatCount; i++) {
            inj.ensureButton();
          }

          // Simulated SPA video-change event re-verifies the button (Req 1.5).
          triggerVideoChange();

          // --- Assertions -----------------------------------------------------

          // Exactly one Windowed_Fullscreen_Button in the container (Req 1.1/1.4).
          const marked = page.container.querySelectorAll(
            `[${BUTTON_MARKER_ATTR}]`,
          );
          expect(marked.length).toBe(1);
          const button = marked[0];

          // It is the immediate next sibling of the native control (Req 1.1).
          expect(page.native.nextSibling).toBe(button);
          expect(page.native.nextElementSibling).toBe(button);

          // Its accessible name is non-empty and distinct from the native's
          // accessible name (Req 1.3).
          const buttonName = accessibleName(button);
          expect(buttonName.length).toBeGreaterThan(0);
          expect(buttonName).not.toBe(nativeName);

          // The native control's attributes and position are unchanged (Req 1.2).
          expect(page.native.outerHTML).toBe(nativeOuterHtmlBefore);
          expect(Array.from(page.container.children).indexOf(page.native)).toBe(
            nativeIndexBefore,
          );

          inj.stop();
        },
      ),
      { numRuns: 100 },
    );
  });
});

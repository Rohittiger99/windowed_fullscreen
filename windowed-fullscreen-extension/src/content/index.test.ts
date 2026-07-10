import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapContentScript,
  type ContentMessageListener,
} from "./index.js";
import { defaultRegistry } from "../adapters/index.js";
import { createPreferenceStore } from "../preferences/store.js";
import type { StorageArea, StorageBackend } from "../preferences/store.js";
import { siteKey } from "../preferences/store.js";
import { BUTTON_MARKER_ATTR } from "../core/controller.js";
import type {
  MutationObserverFactory,
  MutationObserverLike,
} from "../core/controller.js";
import { createLogger, type Logger } from "../shared/logger.js";
import type { SitePrefs } from "../shared/types.js";

/**
 * Integration tests for the content-script bootstrap (task 12.2).
 *
 * These wire the real building blocks together — the default Adapter Registry
 * (YouTube adapter), the Button Injector, the Generic_Core controller, and the
 * Preference Store — against a YouTube-like jsdom fixture, and exercise the
 * end-to-end behaviors:
 *   - adapter activation on load (Req 6.3),
 *   - end-to-end enter/exit driven by the injected button (Req 2),
 *   - preferences loaded on session start (Req 4.3) and auto-apply when the
 *     per-site preference is enabled, but not when disabled/absent (Req 4.5).
 *
 * Determinism: the MutationObserver factory is a controllable no-op and the
 * bounded-loop timers are inert fakes, so nothing fires asynchronously except
 * the (awaited) async preference read.
 *
 * Requirements: 4.3, 4.5, 6.3
 */

// ---------------------------------------------------------------------------
// Deterministic seams
// ---------------------------------------------------------------------------

/** A no-op MutationObserver factory: observers never fire on their own. */
const noopObserver: MutationObserverFactory = (): MutationObserverLike => ({
  observe: (): void => {},
  disconnect: (): void => {},
});

/** Inert timers: the bounded loops never need to tick (target present at once). */
const inertSetTimeout = (): unknown => 0;
const inertClearTimeout = (): void => {};

/** Flush queued microtasks so the async per-site preference read resolves. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/**
 * Build an in-memory `chrome.storage`-shaped backend seeded with `seed`. Both
 * sync and local point at the same map; `set` merges like the real area.
 */
function makeMemoryBackend(seed: Record<string, unknown> = {}): StorageBackend {
  const data: Record<string, unknown> = { ...seed };
  const area: StorageArea = {
    get: (key: string) =>
      Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
  return { sync: area, local: area };
}

function makeLogger(): Logger {
  return createLogger("content", { mirrorToConsole: false });
}

const WATCH_URL = "https://www.youtube.com/watch?v=abc";

/**
 * Install a YouTube-like watch page into the ambient jsdom document:
 *   #page-manager > #movie_player.html5-video-player
 *                     > .ytp-right-controls > .ytp-fullscreen-button
 * plus the Site_Chrome elements the YouTube adapter hides.
 * Returns the key elements for assertions.
 */
function installYouTubeFixture(): {
  player: HTMLElement;
  controls: HTMLElement;
  native: HTMLElement;
  masthead: HTMLElement;
  secondary: HTMLElement;
  comments: HTMLElement;
} {
  document.documentElement.className = "";
  document.body.innerHTML = `
    <div id="masthead-container"></div>
    <div id="masthead"></div>
    <div id="page-manager">
      <div id="movie_player" class="html5-video-player" video-id="abc">
        <div class="ytp-right-controls">
          <button class="ytp-fullscreen-button" aria-label="Full screen"></button>
        </div>
      </div>
      <div id="secondary"></div>
      <div id="comments"></div>
    </div>
  `;

  return {
    player: document.querySelector("#movie_player") as HTMLElement,
    controls: document.querySelector(".ytp-right-controls") as HTMLElement,
    native: document.querySelector(".ytp-fullscreen-button") as HTMLElement,
    masthead: document.querySelector("#masthead-container") as HTMLElement,
    secondary: document.querySelector("#secondary") as HTMLElement,
    comments: document.querySelector("#comments") as HTMLElement,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("content-script bootstrap — integration (task 12.2)", () => {
  // Clean ambient document state between tests.
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.className = "";
  });

  // Req 6.3: a matching Site_Adapter is activated on load; no match => no wiring.
  it("activates the YouTube adapter on a watch URL and injects the button, but does nothing on an unsupported URL (Req 6.3, 6.6)", () => {
    installYouTubeFixture();

    const supported = bootstrapContentScript({
      document,
      url: WATCH_URL,
      registry: defaultRegistry,
      store: createPreferenceStore({ backend: makeMemoryBackend() }),
      logger: makeLogger(),
      createObserver: noopObserver,
      setTimeout: inertSetTimeout,
      clearTimeout: inertClearTimeout,
      addMessageListener: () => {},
    });

    expect(supported).not.toBeNull();
    expect(supported?.adapter.siteId).toBe("youtube");

    // The button is injected immediately adjacent to the native control (Req 1.1).
    const button = document.querySelector(`[${BUTTON_MARKER_ATTR}]`);
    expect(button).not.toBeNull();
    const native = document.querySelector(".ytp-fullscreen-button");
    expect(native?.nextElementSibling).toBe(button);

    supported?.stop();

    // An unsupported site resolves no adapter: bootstrap returns null and the
    // page stays untouched (no button rendered) — Req 6.6.
    const unsupported = bootstrapContentScript({
      document,
      url: "https://example.com/",
      registry: defaultRegistry,
      store: createPreferenceStore({ backend: makeMemoryBackend() }),
      logger: makeLogger(),
      createObserver: noopObserver,
      setTimeout: inertSetTimeout,
      clearTimeout: inertClearTimeout,
      addMessageListener: () => {},
    });

    expect(unsupported).toBeNull();
  });

  // Req 2: end-to-end enter/exit via the injected button and the TOGGLE message.
  it("enters Windowed_Fullscreen_Mode (player expanded, chrome hidden) and exits back (restored) when toggled", () => {
    const { player, native, masthead, secondary, comments } =
      installYouTubeFixture();

    let messageListener: ContentMessageListener | null = null;
    const boot = bootstrapContentScript({
      document,
      url: WATCH_URL,
      registry: defaultRegistry,
      store: createPreferenceStore({ backend: makeMemoryBackend() }),
      logger: makeLogger(),
      createObserver: noopObserver,
      setTimeout: inertSetTimeout,
      clearTimeout: inertClearTimeout,
      addMessageListener: (l) => {
        messageListener = l;
      },
    });

    expect(boot).not.toBeNull();
    // The cross-surface message listener is registered (Req 3.1 wiring).
    expect(messageListener).not.toBeNull();

    const button = document.querySelector(
      `[${BUTTON_MARKER_ATTR}]`,
    ) as HTMLElement;
    expect(button).not.toBeNull();
    expect(boot?.controller.isActive).toBe(false);

    // Enter: simulate a click on the injected Windowed_Fullscreen_Button.
    button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));

    expect(boot?.controller.isActive).toBe(true);
    // Player expanded to fill the viewport (Req 2.2).
    expect(player.style.getPropertyValue("width")).toBe("100vw");
    expect(player.style.getPropertyValue("height")).toBe("100vh");
    expect(player.style.getPropertyValue("position")).toBe("fixed");
    // Site_Chrome hidden (Req 2.3).
    expect(masthead.style.getPropertyValue("display")).toBe("none");
    expect(secondary.style.getPropertyValue("display")).toBe("none");
    expect(comments.style.getPropertyValue("display")).toBe("none");
    // The native control is left untouched (Req 1.2).
    expect(native.getAttribute("aria-label")).toBe("Full screen");

    // Exit: a second activation toggles back, restoring the pre-entry layout.
    button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));

    expect(boot?.controller.isActive).toBe(false);
    expect(player.style.getPropertyValue("width")).toBe("");
    expect(player.style.getPropertyValue("height")).toBe("");
    expect(masthead.style.getPropertyValue("display")).toBe("");
    expect(secondary.style.getPropertyValue("display")).toBe("");
    expect(comments.style.getPropertyValue("display")).toBe("");

    boot?.stop();
  });

  // Req 4.3 + 4.5: preferences load on session start and auto-apply enters when
  // enabled for the site once the player/button are available.
  it("auto-applies (enters automatically) when the per-site autoApply preference is enabled (Req 4.3, 4.5)", async () => {
    const { player } = installYouTubeFixture();

    const seededPrefs: SitePrefs = { siteId: "youtube", autoApply: true };
    const store = createPreferenceStore({
      backend: makeMemoryBackend({ [siteKey("youtube")]: seededPrefs }),
    });

    const boot = bootstrapContentScript({
      document,
      url: WATCH_URL,
      registry: defaultRegistry,
      store,
      logger: makeLogger(),
      createObserver: noopObserver,
      setTimeout: inertSetTimeout,
      clearTimeout: inertClearTimeout,
      addMessageListener: () => {},
    });

    // The async per-site read has not resolved yet: no auto-entry on the same tick.
    expect(boot?.controller.isActive).toBe(false);

    // Let the preference read resolve; auto-apply then enters (Req 4.5).
    await flushMicrotasks();

    expect(boot?.controller.isActive).toBe(true);
    expect(player.style.getPropertyValue("width")).toBe("100vw");

    boot?.stop();
  });

  // Req 4.5: with auto-apply disabled (and when absent → default false), the
  // content script does NOT auto-enter.
  it("does NOT auto-apply when the per-site preference is disabled or absent (Req 4.5, 4.7)", async () => {
    // Case A: explicitly disabled.
    installYouTubeFixture();
    const disabledPrefs: SitePrefs = { siteId: "youtube", autoApply: false };
    const bootDisabled = bootstrapContentScript({
      document,
      url: WATCH_URL,
      registry: defaultRegistry,
      store: createPreferenceStore({
        backend: makeMemoryBackend({ [siteKey("youtube")]: disabledPrefs }),
      }),
      logger: makeLogger(),
      createObserver: noopObserver,
      setTimeout: inertSetTimeout,
      clearTimeout: inertClearTimeout,
      addMessageListener: () => {},
    });

    await flushMicrotasks();
    expect(bootDisabled?.controller.isActive).toBe(false);
    bootDisabled?.stop();

    // Case B: absent preference → documented default (autoApply false) applies.
    installYouTubeFixture();
    const bootAbsent = bootstrapContentScript({
      document,
      url: WATCH_URL,
      registry: defaultRegistry,
      store: createPreferenceStore({ backend: makeMemoryBackend() }),
      logger: makeLogger(),
      createObserver: noopObserver,
      setTimeout: inertSetTimeout,
      clearTimeout: inertClearTimeout,
      addMessageListener: () => {},
    });

    await flushMicrotasks();
    expect(bootAbsent?.controller.isActive).toBe(false);
    bootAbsent?.stop();
  });
});

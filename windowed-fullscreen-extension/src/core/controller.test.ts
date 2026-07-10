import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUTTON_ACTIVE_CLASS,
  BUTTON_MARKER_ATTR,
  WINDOWED_CLASS,
  createController,
} from "./controller.js";
import type { MutationObserverLike } from "./controller.js";
import { createLogger, LOG_CODES } from "../shared/logger.js";
import type { SiteDescriptor } from "../shared/types.js";

/**
 * Build a minimal page in the ambient jsdom document and return references the
 * tests use to construct descriptors. Each call resets the document body.
 */
function setupPage(options: {
  chromeCount?: number;
  playerInlineStyle?: string;
} = {}): {
  player: HTMLElement;
  nativeButton: HTMLElement;
  controls: HTMLElement;
  chrome: HTMLElement[];
} {
  const { chromeCount = 2, playerInlineStyle = "" } = options;
  document.documentElement.className = "";
  document.body.innerHTML = "";

  const player = document.createElement("video");
  if (playerInlineStyle) {
    player.setAttribute("style", playerInlineStyle);
  }
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

function makeDescriptor(
  page: ReturnType<typeof setupPage>,
  overrides: Partial<SiteDescriptor> = {},
): SiteDescriptor {
  return {
    player: page.player,
    nativeFullscreenButton: page.nativeButton,
    controlsContainer: page.controls,
    siteChromeElements: page.chrome,
    missingChromeSelectors: [],
    ...overrides,
  };
}

describe("WindowedFullscreenController enter", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("expands the player to fill the viewport and hides chrome (Req 2.2, 2.3)", () => {
    const page = setupPage({ chromeCount: 3 });
    const controller = createController({ document });

    const result = controller.enter(makeDescriptor(page));

    expect(result).toEqual({ ok: true });
    expect(controller.isActive).toBe(true);
    expect(page.player.style.width).toBe("100vw");
    expect(page.player.style.height).toBe("100vh");
    expect(page.player.style.position).toBe("fixed");
    expect(document.documentElement.classList.contains(WINDOWED_CLASS)).toBe(true);
    for (const el of page.chrome) {
      expect(el.style.display).toBe("none");
    }
  });

  it("enters with an empty chrome set without hiding anything (Req 2.9)", () => {
    const page = setupPage({ chromeCount: 0 });
    const controller = createController({ document });

    const result = controller.enter(makeDescriptor(page));

    expect(result).toEqual({ ok: true });
    expect(controller.isActive).toBe(true);
    expect(page.player.style.width).toBe("100vw");
  });

  it("never calls the Fullscreen API (Req 2.4)", () => {
    const page = setupPage();
    const spy = vi.fn();
    (page.player as unknown as { requestFullscreen: () => void }).requestFullscreen =
      spy;
    const controller = createController({ document });

    controller.enter(makeDescriptor(page));

    expect(spy).not.toHaveBeenCalled();
  });

  it("logs each absent chrome selector but still enters (Req 7.3)", () => {
    const page = setupPage({ chromeCount: 1 });
    const logger = createLogger("content", { mirrorToConsole: false });
    const controller = createController({ document, logger });

    const result = controller.enter(
      makeDescriptor(page, {
        missingChromeSelectors: ["#gone", ".missing"],
      }),
    );

    expect(result).toEqual({ ok: true });
    const absent = logger
      .getEntries()
      .filter((e) => e.code === LOG_CODES.ABSENT_CHROME);
    expect(absent).toHaveLength(2);
    expect(absent.map((e) => e.context.selector)).toEqual(["#gone", ".missing"]);
  });

  it("refuses an incomplete descriptor and preserves page state (Req 6.2)", () => {
    const page = setupPage();
    const controller = createController({ document });
    const before = document.body.innerHTML;
    const hadClass = document.documentElement.classList.contains(WINDOWED_CLASS);

    const result = controller.enter(
      makeDescriptor(page, { player: undefined as unknown as Element }),
    );

    expect(result).toEqual({ ok: false, reason: "incomplete-descriptor" });
    expect(controller.isActive).toBe(false);
    expect(document.body.innerHTML).toBe(before);
    expect(document.documentElement.classList.contains(WINDOWED_CLASS)).toBe(
      hadClass,
    );
  });

  it("refuses re-entry while already active (already-active)", () => {
    const page = setupPage();
    const controller = createController({ document });
    controller.enter(makeDescriptor(page));

    const result = controller.enter(makeDescriptor(page));

    expect(result).toEqual({ ok: false, reason: "already-active" });
  });
});

describe("WindowedFullscreenController exit / toggle", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("restores player and chrome inline styles exactly on exit (Req 2.6)", () => {
    const page = setupPage({ chromeCount: 2, playerInlineStyle: "width: 640px;" });
    // chrome[0] starts with an explicit inline display; chrome[1] has none.
    page.chrome[0].setAttribute("style", "display: flex;");
    const controller = createController({ document });

    controller.enter(makeDescriptor(page));
    controller.exit();

    expect(controller.isActive).toBe(false);
    // Player: only the pre-entry inline width remains; mutated props are cleared.
    expect(page.player.style.width).toBe("640px");
    expect(page.player.style.position).toBe("");
    expect(page.player.style.height).toBe("");
    expect(page.player.style.zIndex).toBe("");
    // chrome[0]: pre-entry display is restored, injected visibility cleared.
    expect(page.chrome[0].style.display).toBe("flex");
    expect(page.chrome[0].style.visibility).toBe("");
    // chrome[1]: had no inline style; both mutated props are cleared.
    expect(page.chrome[1].style.display).toBe("");
    expect(page.chrome[1].style.visibility).toBe("");
    expect(document.documentElement.classList.contains(WINDOWED_CLASS)).toBe(false);
  });

  it("exit is a no-op when inactive", () => {
    const page = setupPage();
    const controller = createController({ document });
    expect(() => controller.exit()).not.toThrow();
    expect(controller.isActive).toBe(false);
    expect(page.player.getAttribute("style")).toBeNull();
  });

  it("exits on Escape keydown while active (Req 2.7)", () => {
    const page = setupPage();
    const controller = createController({ document });
    controller.enter(makeDescriptor(page));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(controller.isActive).toBe(false);
    expect(page.player.style.width).toBe("");
  });

  it("toggle enters then exits using the resolver", () => {
    const page = setupPage();
    const controller = createController({ document });
    const resolve = () => makeDescriptor(page);

    controller.toggle(resolve);
    expect(controller.isActive).toBe(true);

    controller.toggle(resolve);
    expect(controller.isActive).toBe(false);
  });

  it("toggle does nothing when the resolver returns null", () => {
    const controller = createController({ document });
    controller.toggle(() => null);
    expect(controller.isActive).toBe(false);
  });
});

describe("WindowedFullscreenController button state (Req 2.10)", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("drives aria-pressed and is-active on enter/exit", () => {
    const page = setupPage();
    const button = document.createElement("button");
    button.setAttribute(BUTTON_MARKER_ATTR, "");
    document.body.appendChild(button);
    const controller = createController({ document, button });

    controller.enter(makeDescriptor(page));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains(BUTTON_ACTIVE_CLASS)).toBe(true);

    controller.exit();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains(BUTTON_ACTIVE_CLASS)).toBe(false);
  });

  it("setButton reflects current state immediately", () => {
    const page = setupPage();
    const controller = createController({ document });
    controller.enter(makeDescriptor(page));

    const button = document.createElement("button");
    controller.setButton(button);

    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains(BUTTON_ACTIVE_CLASS)).toBe(true);
  });
});

/**
 * A controllable stand-in for MutationObserver so tests can drive mutation
 * callbacks synchronously instead of awaiting the real (async) observer.
 */
function makeFakeObserver(): {
  factory: (cb: MutationCallback) => MutationObserverLike;
  trigger: () => void;
  observeCount: () => number;
  disconnectCount: () => number;
} {
  let callback: MutationCallback | null = null;
  let observed = 0;
  let disconnected = 0;
  const factory = (cb: MutationCallback): MutationObserverLike => {
    callback = cb;
    return {
      observe: () => {
        observed += 1;
      },
      disconnect: () => {
        disconnected += 1;
      },
    };
  };
  return {
    factory,
    trigger: () => callback?.([], {} as unknown as MutationObserver),
    observeCount: () => observed,
    disconnectCount: () => disconnected,
  };
}

describe("WindowedFullscreenController player-loss watcher (Req 7.6)", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = "";
  });

  it("exits, restores chrome from the snapshot, and logs when the player is removed", () => {
    const page = setupPage({ chromeCount: 2 });
    page.chrome[0].setAttribute("style", "display: flex;");
    const observer = makeFakeObserver();
    const logger = createLogger("content", { mirrorToConsole: false });
    const controller = createController({
      document,
      logger,
      createObserver: observer.factory,
    });

    controller.enter(makeDescriptor(page));
    expect(controller.isActive).toBe(true);
    expect(observer.observeCount()).toBe(1);

    // Remove the player from the DOM, then drive the observer callback.
    page.player.remove();
    observer.trigger();

    expect(controller.isActive).toBe(false);
    // Chrome restored from the snapshot.
    expect(page.chrome[0].style.display).toBe("flex");
    expect(page.chrome[0].style.visibility).toBe("");
    expect(page.chrome[1].style.display).toBe("");
    expect(document.documentElement.classList.contains(WINDOWED_CLASS)).toBe(false);
    // Player-loss logged exactly once.
    const lost = logger
      .getEntries()
      .filter((e) => e.code === LOG_CODES.PLAYER_LOST);
    expect(lost).toHaveLength(1);
    // Watcher torn down.
    expect(observer.disconnectCount()).toBe(1);
  });

  it("ignores mutations while the player remains connected", () => {
    const page = setupPage();
    const observer = makeFakeObserver();
    const logger = createLogger("content", { mirrorToConsole: false });
    const controller = createController({
      document,
      logger,
      createObserver: observer.factory,
    });

    controller.enter(makeDescriptor(page));
    // Unrelated subtree mutation: player still attached.
    observer.trigger();

    expect(controller.isActive).toBe(true);
    expect(
      logger.getEntries().filter((e) => e.code === LOG_CODES.PLAYER_LOST),
    ).toHaveLength(0);
  });

  it("does not exit twice if the observer fires again after teardown", () => {
    const page = setupPage();
    const observer = makeFakeObserver();
    const logger = createLogger("content", { mirrorToConsole: false });
    const controller = createController({
      document,
      logger,
      createObserver: observer.factory,
    });

    controller.enter(makeDescriptor(page));
    page.player.remove();
    observer.trigger();
    // A stale callback firing after exit must be a no-op.
    observer.trigger();

    expect(controller.isActive).toBe(false);
    expect(
      logger.getEntries().filter((e) => e.code === LOG_CODES.PLAYER_LOST),
    ).toHaveLength(1);
  });

  it("tears down the watcher on a normal exit", () => {
    const page = setupPage();
    const observer = makeFakeObserver();
    const controller = createController({
      document,
      createObserver: observer.factory,
    });

    controller.enter(makeDescriptor(page));
    controller.exit();

    expect(observer.disconnectCount()).toBe(1);
    // After teardown, a stray callback does nothing.
    observer.trigger();
    expect(controller.isActive).toBe(false);
  });
});

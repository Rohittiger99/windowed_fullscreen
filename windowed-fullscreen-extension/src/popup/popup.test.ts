import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveStatus,
  describeSite,
  renderPopup,
  toggleEnabled,
  toggleLabel,
  type PopupStatus,
} from "./popup.js";
import { buildDefaultRegistry } from "../adapters/index.js";
import type { ExtResponse } from "../shared/types.js";

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const UNSUPPORTED_URL = "https://example.com/some/page";

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// deriveStatus
// ---------------------------------------------------------------------------

describe("deriveStatus", () => {
  const registry = buildDefaultRegistry();
  const YOUTUBE_HOME_URL = "https://www.youtube.com/";

  it("reports adapter active and mode active on a supported site that is in mode", () => {
    const response: ExtResponse = { ok: true, active: true };
    const status = deriveStatus(YOUTUBE_WATCH_URL, response, registry);
    expect(status).toEqual({
      siteSupported: true,
      adapterActive: true,
      siteId: "youtube",
      modeActive: true,
      reachable: true,
    });
  });

  it("reports adapter active but mode inactive when the content script says inactive", () => {
    const response: ExtResponse = { ok: true, active: false };
    const status = deriveStatus(YOUTUBE_WATCH_URL, response, registry);
    expect(status).toMatchObject({ adapterActive: true, modeActive: false, reachable: true });
  });

  it("reports a supported site but no active page on the YouTube home page", () => {
    // Home page: the host is supported, but there is no watch page / video yet.
    const status = deriveStatus(YOUTUBE_HOME_URL, { ok: true, active: false }, registry);
    expect(status.siteSupported).toBe(true);
    expect(status.adapterActive).toBe(false);
    expect(status.siteId).toBe("youtube");
  });

  it("reports no adapter on an unsupported site", () => {
    const status = deriveStatus(UNSUPPORTED_URL, { ok: false, error: "x" }, registry);
    expect(status).toEqual({
      siteSupported: false,
      adapterActive: false,
      siteId: null,
      modeActive: false,
      reachable: false,
    });
  });

  it("treats a missing response as unreachable with the mode inactive", () => {
    const status = deriveStatus(YOUTUBE_WATCH_URL, undefined, registry);
    expect(status).toMatchObject({ adapterActive: true, reachable: false, modeActive: false });
  });

  it("treats a not-ok response as unreachable", () => {
    const status = deriveStatus(YOUTUBE_WATCH_URL, { ok: false, error: "unreachable" }, registry);
    expect(status).toMatchObject({ reachable: false, modeActive: false });
  });

  it("handles a missing URL", () => {
    const status = deriveStatus(undefined, undefined, registry);
    expect(status.siteSupported).toBe(false);
    expect(status.adapterActive).toBe(false);
    expect(status.siteId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describe / toggle helpers
// ---------------------------------------------------------------------------

describe("describeSite / toggle helpers", () => {
  const supported = (over: Partial<PopupStatus> = {}): PopupStatus => ({
    siteSupported: true,
    adapterActive: true,
    siteId: "youtube",
    modeActive: false,
    reachable: true,
    ...over,
  });

  it("describes a supported site", () => {
    expect(describeSite(supported())).toBe("Yes (youtube)");
  });

  it("describes an unsupported site as not available", () => {
    const status: PopupStatus = {
      siteSupported: false,
      adapterActive: false,
      siteId: null,
      modeActive: false,
      reachable: false,
    };
    expect(describeSite(status)).toBe("No");
    expect(toggleEnabled(status)).toBe(false);
    expect(toggleLabel(status)).toBe("Not available on this site");
  });

  it("prompts to open a video on a supported site with no active page", () => {
    // YouTube home: supported host, but no watch page yet.
    const status = supported({ adapterActive: false, reachable: true });
    expect(describeSite(status)).toBe("Yes (youtube)");
    expect(toggleEnabled(status)).toBe(false);
    expect(toggleLabel(status)).toBe("Open a video to use it");
  });

  it("labels the toggle to enter when inactive and exit when active", () => {
    expect(toggleLabel(supported({ modeActive: false }))).toBe("Enter windowed fullscreen");
    expect(toggleLabel(supported({ modeActive: true }))).toBe("Exit windowed fullscreen");
  });

  it("enables the toggle only on an active, reachable page", () => {
    expect(toggleEnabled(supported())).toBe(true);
    expect(toggleEnabled(supported({ reachable: false }))).toBe(false);
  });

  it("explains an unreachable active page instead of toggling", () => {
    const status = supported({ reachable: false });
    expect(toggleLabel(status)).toBe("Reload the page to control it here");
  });
});

// ---------------------------------------------------------------------------
// renderPopup
// ---------------------------------------------------------------------------

describe("renderPopup", () => {
  function makeRoot(): HTMLElement {
    const root = document.createElement("main");
    document.body.appendChild(root);
    return root;
  }

  const supportedActive: PopupStatus = {
    siteSupported: true,
    adapterActive: true,
    siteId: "youtube",
    modeActive: true,
    reachable: true,
  };

  it("renders the title, supported-site line, and an enabled toggle", () => {
    const root = makeRoot();
    renderPopup(document, root, supportedActive, { toggle: vi.fn() });

    expect(root.querySelector(".wfs-popup__title")?.textContent).toBe("Windowed Fullscreen");
    expect(root.querySelector("#wfs-status-site")?.textContent).toBe("Yes (youtube)");

    const toggle = root.querySelector<HTMLButtonElement>("#wfs-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(false);
    // Active site => the button offers to exit and carries the active class.
    expect(toggle?.textContent).toBe("Exit windowed fullscreen");
    expect(toggle?.classList.contains("is-active")).toBe(true);
  });

  it("invokes the toggle action on click", () => {
    const root = makeRoot();
    const toggle = vi.fn();
    renderPopup(document, root, supportedActive, { toggle });

    root.querySelector<HTMLButtonElement>("#wfs-toggle")?.click();
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("disables the toggle and does not fire on an unsupported site", () => {
    const root = makeRoot();
    const toggle = vi.fn();
    const status: PopupStatus = {
      siteSupported: false,
      adapterActive: false,
      siteId: null,
      modeActive: false,
      reachable: false,
    };
    renderPopup(document, root, status, { toggle });

    const button = root.querySelector<HTMLButtonElement>("#wfs-toggle");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Not available on this site");
    button?.click();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("replaces prior content on re-render", () => {
    const root = makeRoot();
    root.innerHTML = "<p>stale</p>";
    renderPopup(document, root, supportedActive, { toggle: vi.fn() });
    expect(root.textContent).not.toContain("stale");
  });

  it("reflects the off state for an unsupported site", () => {
    const root = makeRoot();
    const status: PopupStatus = {
      siteSupported: false,
      adapterActive: false,
      siteId: null,
      modeActive: false,
      reachable: false,
    };
    renderPopup(document, root, status, { toggle: vi.fn() });

    expect(root.querySelector("#wfs-status-site")?.textContent).toBe("No");
    expect(root.querySelector("#wfs-status-site")?.classList.contains("is-off")).toBe(true);
  });
});

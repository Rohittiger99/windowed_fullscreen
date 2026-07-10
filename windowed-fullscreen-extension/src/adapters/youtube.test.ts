import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { youtubeAdapter } from "./youtube.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a YouTube-like watch-page DOM: the player root (`#movie_player`), the
 * right-controls cluster holding the native fullscreen button, and a sampling
 * of Site_Chrome elements the adapter centralizes. Returns nothing; callers
 * read elements back through the adapter under test.
 */
function buildYouTubeFixture(): void {
  document.body.innerHTML = `
    <div id="page-manager">
      <div id="masthead-container">
        <div id="masthead"></div>
      </div>
      <div id="secondary"></div>
      <div id="comments"></div>
      <div id="movie_player" class="html5-video-player" video-id="abc123">
        <div class="ytp-chrome-bottom">
          <div class="ytp-left-controls"></div>
          <div class="ytp-right-controls">
            <button class="ytp-fullscreen-button" aria-label="Full screen"></button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Keep the global document clean so URL-matching tests are not influenced by a
// lingering `#movie_player` from a previous fixture.
beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// matches(url)
// ---------------------------------------------------------------------------

describe("youtubeAdapter.matches", () => {
  // Validates: Requirements 6.5
  it("matches a YouTube watch URL", () => {
    expect(youtubeAdapter.matches("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
  });

  it("matches watch URLs on alternate YouTube hosts", () => {
    expect(youtubeAdapter.matches("https://youtube.com/watch?v=abc")).toBe(true);
    expect(youtubeAdapter.matches("https://m.youtube.com/watch?v=abc")).toBe(true);
  });

  it("does not match a non-watch YouTube URL when no active player is present", () => {
    // Empty DOM (no #movie_player), so the active-player fallback stays false.
    expect(youtubeAdapter.matches("https://www.youtube.com/")).toBe(false);
    expect(youtubeAdapter.matches("https://www.youtube.com/feed/subscriptions")).toBe(false);
  });

  it("matches a non-watch YouTube URL when an active #movie_player is present", () => {
    // Covers SPA navigation: the path is not /watch but the player exists.
    buildYouTubeFixture();
    expect(youtubeAdapter.matches("https://www.youtube.com/")).toBe(true);
  });

  it("does not match non-YouTube hosts even with a /watch path", () => {
    expect(youtubeAdapter.matches("https://www.example.com/watch?v=abc")).toBe(false);
    expect(youtubeAdapter.matches("https://vimeo.com/watch")).toBe(false);
  });

  it("does not match a non-YouTube host even when an active player is present", () => {
    buildYouTubeFixture();
    expect(youtubeAdapter.matches("https://www.example.com/")).toBe(false);
  });

  it("returns false for an unparseable URL", () => {
    expect(youtubeAdapter.matches("not a url")).toBe(false);
    expect(youtubeAdapter.matches("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Selector resolution against a YouTube-like fixture
// ---------------------------------------------------------------------------

describe("youtubeAdapter selector resolution", () => {
  beforeEach(() => {
    buildYouTubeFixture();
  });

  // Validates: Requirements 6.5
  it("finds the controls container (.ytp-right-controls)", () => {
    const container = youtubeAdapter.findControlsContainer(document);
    expect(container).not.toBeNull();
    expect(container?.classList.contains("ytp-right-controls")).toBe(true);
  });

  it("finds the native fullscreen button (.ytp-fullscreen-button)", () => {
    const button = youtubeAdapter.findNativeFullscreenButton(document);
    expect(button).not.toBeNull();
    expect(button?.classList.contains("ytp-fullscreen-button")).toBe(true);
  });

  it("resolves the native fullscreen button inside the controls container", () => {
    const container = youtubeAdapter.findControlsContainer(document);
    const button = youtubeAdapter.findNativeFullscreenButton(document);
    expect(container?.contains(button as Node)).toBe(true);
  });

  it("finds the player via the #movie_player id", () => {
    const player = youtubeAdapter.findPlayer(document);
    expect(player).not.toBeNull();
    expect(player?.id).toBe("movie_player");
  });

  it("falls back to .html5-video-player when #movie_player is absent", () => {
    document.body.innerHTML = `<div class="html5-video-player"></div>`;
    const player = youtubeAdapter.findPlayer(document);
    expect(player).not.toBeNull();
    expect(player?.classList.contains("html5-video-player")).toBe(true);
  });

  it("returns null for player/controls/native button when none are present", () => {
    document.body.innerHTML = "";
    expect(youtubeAdapter.findPlayer(document)).toBeNull();
    expect(youtubeAdapter.findControlsContainer(document)).toBeNull();
    expect(youtubeAdapter.findNativeFullscreenButton(document)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSiteChromeSelectors — centralized list
// ---------------------------------------------------------------------------

describe("youtubeAdapter.getSiteChromeSelectors", () => {
  // Validates: Requirements 6.5
  it("returns the centralized Site_Chrome selector list", () => {
    expect(youtubeAdapter.getSiteChromeSelectors()).toEqual([
      "#masthead-container",
      "#masthead",
      "#secondary",
      "#comments",
    ]);
  });

  it("returns selectors that resolve against a YouTube-like fixture", () => {
    buildYouTubeFixture();
    const selectors = youtubeAdapter.getSiteChromeSelectors();
    // Every listed chrome selector should match an element in the fixture.
    for (const selector of selectors) {
      expect(document.querySelector(selector)).not.toBeNull();
    }
  });

  it("returns a fresh copy so callers cannot mutate the centralized list", () => {
    const first = youtubeAdapter.getSiteChromeSelectors();
    first.push("#injected-bogus-selector");
    const second = youtubeAdapter.getSiteChromeSelectors();
    expect(second).not.toContain("#injected-bogus-selector");
  });
});

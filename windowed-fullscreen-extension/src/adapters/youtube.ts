/**
 * YouTube Site_Adapter.
 *
 * The single v1 Site_Adapter (Requirement 6.5). It is the one place that knows
 * YouTube-specific DOM selectors and SPA behaviors, so that a YouTube layout
 * change is a one-file fix and the Generic_Core stays site-independent
 * (Requirements 6.1, 6.5). The Generic_Core consumes only what the
 * {@link SiteAdapter} contract exposes.
 */

import type { SiteAdapter } from "../shared/types";

// ---------------------------------------------------------------------------
// Centralized YouTube selectors
// ---------------------------------------------------------------------------

/**
 * All YouTube-specific selectors live here. Nothing outside this module should
 * hard-code a YouTube selector (Requirement 6.1).
 */
const YT_SELECTORS = {
  /** The player root expanded by the Generic_Core. */
  player: "#movie_player",
  /** Fallback player root when the id form is not present. */
  playerFallback: ".html5-video-player",
  /** The cluster holding the native fullscreen button. */
  controlsContainer: ".ytp-right-controls",
  /** YouTube's own (native) fullscreen control. */
  nativeFullscreenButton: ".ytp-fullscreen-button",
  /**
   * Site_Chrome elements hidden on entry. Both masthead forms are listed so an
   * absent one is simply tolerated by the core (Requirement 7.3). The document
   * scrollbar is handled separately via a body/documentElement class, so it is
   * intentionally not a selector here.
   *
   * IMPORTANT: only elements OUTSIDE the player subtree may be listed. The
   * player (`#movie_player`) lives inside `#page-manager`, so hiding
   * `#page-manager` with `display:none` would hide the player/video too (an
   * ancestor set to `display:none` removes its whole subtree from rendering,
   * even a `position:fixed` descendant) — which caused a black screen.
   */
  siteChrome: ["#masthead-container", "#masthead", "#secondary", "#comments"],
} as const;

/** Hosts considered YouTube for the purpose of adapter matching. */
const YT_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

/**
 * YouTube-specific active-mode CSS, supplied to the content script via
 * {@link youtubeAdapter.getActiveModeCss}. Scoped under `html.wfs-windowed`
 * (toggled by the Generic_Core) so it only takes effect while the mode is
 * active. `!important` beats YouTube's own inline JS-driven sizing.
 */
const YT_ACTIVE_MODE_CSS = `
/* The player fills the whole viewport and sits above all page chrome. */
html.wfs-windowed #movie_player,
html.wfs-windowed .html5-video-player {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  margin: 0 !important;
  z-index: 2147483647 !important;
  background: #000 !important;
}

/* Force YouTube's video container + <video> to fill the player, overriding the
   inline px sizing YouTube applies via its own JS. */
html.wfs-windowed .html5-video-container {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  left: 0 !important;
  top: 0 !important;
}

html.wfs-windowed video.html5-main-video,
html.wfs-windowed video.video-stream {
  width: 100% !important;
  height: 100% !important;
  left: 0 !important;
  top: 0 !important;
  /* Letterbox instead of stretch, preserving aspect ratio. */
  object-fit: contain !important;
}

/* YouTube sets an inline px 'width' (and 'left') on the bottom control bar
   based on the ORIGINAL watch-page player size (~half the screen). When we
   enlarge #movie_player to the full viewport YouTube does not recompute that
   width, so the scrubber, buttons and the settings/chapters menus anchored to
   it stay stuck spanning only the left half. Override the inline sizing so the
   control bar (and everything anchored to it) stretches across the full player.
   The 12px insets match YouTube's own gutter. */
html.wfs-windowed .ytp-chrome-bottom {
  width: auto !important;
  left: 12px !important;
  right: 12px !important;
}

/* Hide YouTube's in-player title / top-chrome overlay (video title, channel,
   share/watch-later buttons and the top gradient). The bottom control bar
   (play/seek/volume/settings) is kept usable. */
html.wfs-windowed .ytp-chrome-top,
html.wfs-windowed .ytp-gradient-top,
html.wfs-windowed .ytp-title,
html.wfs-windowed .ytp-show-cards-title,
html.wfs-windowed .ytp-ce-element {
  display: none !important;
}

/* Safety net: hide the watch-page title/metadata block, the secondary column,
   comments and masthead so nothing shows even if the player is not covering
   them. These are siblings of the player (never its ancestors), so hiding them
   cannot hide the video itself. */
html.wfs-windowed ytd-watch-metadata,
html.wfs-windowed #above-the-fold,
html.wfs-windowed #secondary,
html.wfs-windowed #secondary-inner,
html.wfs-windowed #comments,
html.wfs-windowed #masthead-container,
html.wfs-windowed #masthead {
  display: none !important;
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the active video id from the `#movie_player` element. YouTube exposes it
 * via the player API (`getVideoData().video_id`) and, on the flexy container,
 * via a `video-id` attribute. We read defensively and fall back to `null` when
 * neither is available so SPA detection degrades gracefully.
 */
function readVideoId(doc: Document): string | null {
  const player = doc.querySelector(YT_SELECTORS.player);
  if (!player) {
    return null;
  }

  // The `video-id` attribute is the most stable, side-effect-free signal.
  const attr = player.getAttribute("video-id");
  if (attr) {
    return attr;
  }

  // Fall back to the player API when present (runtime-only; typed loosely).
  const api = player as unknown as { getVideoData?: () => { video_id?: string } };
  if (typeof api.getVideoData === "function") {
    try {
      const id = api.getVideoData()?.video_id;
      return id ?? null;
    } catch {
      // Player not ready / API threw — treat as unknown.
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * The YouTube {@link SiteAdapter}. A single shared instance is exported so the
 * registry registers one canonical adapter (Requirement 6.5).
 */
export const youtubeAdapter: SiteAdapter = {
  siteId: "youtube",

  /**
   * Matches when the host is a YouTube host and the page is in a watch context:
   * either the URL path is `/watch`, or an active `#movie_player` is present in
   * the current document (covers SPA navigations that do not change the path in
   * a way we can detect from the URL alone).
   */
  matches(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (!YT_HOSTS.has(parsed.hostname)) {
      return false;
    }

    if (parsed.pathname === "/watch" || parsed.pathname.startsWith("/watch")) {
      return true;
    }

    // Watch context can also be inferred from an active player when the DOM is
    // available (e.g. SPA navigation). Guard for non-DOM contexts.
    if (typeof document !== "undefined") {
      return document.querySelector(YT_SELECTORS.player) !== null;
    }

    return false;
  },

  /**
   * Host-level match: true for any YouTube host, regardless of whether the
   * current page is a watch page. Lets the Popup report YouTube as a supported
   * site on the home page / search results (where there is no video yet) instead
   * of misleadingly saying "not supported".
   */
  matchesSite(url: string): boolean {
    try {
      return YT_HOSTS.has(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  findControlsContainer(doc: Document): Element | null {
    return doc.querySelector(YT_SELECTORS.controlsContainer);
  },

  findNativeFullscreenButton(doc: Document): Element | null {
    return doc.querySelector(YT_SELECTORS.nativeFullscreenButton);
  },

  findPlayer(doc: Document): Element | null {
    return doc.querySelector(YT_SELECTORS.player) ?? doc.querySelector(YT_SELECTORS.playerFallback);
  },

  getSiteChromeSelectors(): string[] {
    // Return a fresh copy so callers cannot mutate the centralized list.
    return [...YT_SELECTORS.siteChrome];
  },

  /**
   * YouTube enlarges its control bar (progress bar, buttons, time, fonts) only
   * when the player carries `ytp-big-mode` — a class it normally toggles in
   * native fullscreen. Since we never call the Fullscreen API, we add it
   * ourselves while windowed so the controls are full-size rather than tiny.
   */
  getActivePlayerClasses(): string[] {
    return ["ytp-big-mode"];
  },

  /**
   * YouTube-specific active-mode CSS. This is the ONE place YouTube CSS
   * selectors live (Requirement 6.1); the generic stylesheet in
   * `windowed-styles.ts` contains no site selectors. All rules are scoped under
   * `html.wfs-windowed` so they only apply while the mode is active, and use
   * `!important` to beat the inline px sizing YouTube applies via its own JS.
   */
  getActiveModeCss(): string {
    return YT_ACTIVE_MODE_CSS;
  },

  /**
   * Detect SPA video changes so the Content_Script can re-verify the button
   * (Requirement 1.5). Two signals are combined:
   *   1. YouTube's `yt-navigate-finish` event (fires after SPA navigations).
   *   2. A change of the `#movie_player` video id, observed via a
   *      MutationObserver on the player element's attributes.
   * Returns a disposer that removes the listener and disconnects the observer.
   */
  onVideoChange(doc: Document, cb: () => void): () => void {
    let lastVideoId = readVideoId(doc);

    const fireIfChanged = (): void => {
      const current = readVideoId(doc);
      if (current !== lastVideoId) {
        lastVideoId = current;
        cb();
      }
    };

    // 1. SPA navigation event. yt-navigate-finish fires on the document.
    const onNavigate = (): void => {
      // The new player/video id may settle slightly after the event; re-read
      // and notify unconditionally so the injector re-verifies (Req 1.5).
      lastVideoId = readVideoId(doc);
      cb();
    };
    doc.addEventListener("yt-navigate-finish", onNavigate);

    // 2. Observe the player element's attributes for video-id changes. The
    // player element may not exist yet, so observe the document subtree for
    // attribute changes and re-check the id; this also catches the player being
    // (re)attached during navigation.
    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        fireIfChanged();
      });
      const root = doc.documentElement ?? doc;
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ["video-id"],
      });
    }

    return () => {
      doc.removeEventListener("yt-navigate-finish", onNavigate);
      observer?.disconnect();
    };
  },
};

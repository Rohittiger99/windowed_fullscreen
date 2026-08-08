/**
 * Windowed Fullscreen — complete extension source.
 *
 * Every surface of the extension lives in this one file. `scripts/build.mjs`
 * bundles it four times, once per Manifest V3 surface, synthesizing a one-line
 * entry point for each and letting esbuild tree-shake away the code that
 * surface does not use:
 *
 *   content script    -> startContentScript()
 *   service worker    -> startServiceWorker()
 *   options page      -> startOptionsPage()
 *   toolbar popup     -> startPopup()
 *
 * There are no top-level side effects, which is what makes that tree-shaking
 * safe: the popup bundle contains no content-script code, and vice versa.
 *
 * ARCHITECTURE
 * The one rule worth preserving: site-specific DOM knowledge lives ONLY in a
 * site adapter (§3). The controller (§6) and injector (§7) drive the mode using
 * nothing but a `SiteDescriptor`, so supporting another video site means adding
 * one adapter to `ADAPTERS` — no changes anywhere else.
 *
 * The mode never calls the browser Fullscreen API. It expands the player with
 * CSS instead, which is the whole point: the window stays an ordinary maximized
 * window, so the tab strip and taskbar remain visible.
 *
 * SECTIONS
 *   §1  Types
 *   §2  Diagnostics
 *   §3  Site adapters (YouTube)
 *   §4  Adapter registry
 *   §5  Preferences
 *   §6  Active-mode stylesheet
 *   §7  Controller (generic core)
 *   §8  Button injector
 *   §9  Content script
 *   §10 Service worker
 *   §11 Settings UI (shared by options page and popup)
 *   §12 Popup
 *
 * Copyright (c) 2026 Rohit Tiger. All rights reserved.
 */

// ===========================================================================
// §1  Types
// ===========================================================================

/**
 * How the expanded player relates to the rest of the page.
 *
 * - `cover` — the player is fixed to the viewport and the page cannot scroll.
 *   Nothing but the video is reachable, which is the point.
 * - `scrollable` — the player is a viewport-sized block at the top of the normal
 *   document flow. It fills the screen on arrival, but scrolling continues past
 *   it to the title, description, and comments, and scrolling back up returns to
 *   the video. The browser Fullscreen API is not involved in either mode.
 */
export type WindowedMode = "cover" | "scrollable";

/**
 * The only contract between the generic core and a site. The core uses nothing
 * beyond what this interface exposes.
 */
export interface SiteAdapter {
  /** Stable id, also used as the per-site preference key. */
  readonly siteId: string;
  /** Human-readable name shown in the settings UI. */
  readonly label: string;

  /** Can the mode activate on this exact URL (e.g. a YouTube watch page)? */
  matches(url: string): boolean;
  /**
   * Does this URL belong to a site we support at all, even if the current page
   * has no video yet? Broader than {@link matches}; lets the popup distinguish
   * "open a video" from "not supported here".
   */
  matchesSite(url: string): boolean;

  /** Locate the player root to expand. Null until it exists. */
  findPlayer(doc: Document): Element | null;
  /** Locate the control cluster holding the native fullscreen button. */
  findControlsContainer(doc: Document): Element | null;
  /** Locate the site's own fullscreen button; we inject ours next to it. */
  findNativeFullscreenButton(doc: Document): Element | null;

  /**
   * Selectors for page chrome hidden on entry, for the mode being entered.
   * Absent ones are tolerated. Scrollable mode deliberately hides less, since
   * the page's own content below the player is the reason to use it.
   */
  getSiteChromeSelectors(mode: WindowedMode): string[];
  /** Classes added to the player while active, removed on exit. */
  getActivePlayerClasses(): string[];
  /** Site CSS, scoped under `html.wfs-windowed`, injected once. */
  getActiveModeCss(): string;
  /** Watch for in-page video changes. Returns a disposer. */
  onVideoChange(doc: Document, onChange: () => void): () => void;
}

/** What an adapter resolves to at one moment in time. */
export interface SiteDescriptor {
  player: Element;
  nativeFullscreenButton: Element;
  /** Chrome elements that resolved; may be empty. */
  siteChromeElements: Element[];
  /** Selectors that matched nothing, recorded for diagnostics. */
  missingChromeSelectors: string[];
  /** Classes to add to the player while active. */
  activePlayerClasses: string[];
}

/**
 * Restore record captured before any mutation, so exit reproduces the exact
 * pre-entry inline state — including properties that were not set at all.
 */
interface LayoutSnapshot {
  playerStyle: Record<string, string | null>;
  chrome: Array<{ element: Element; style: Record<string, string | null> }>;
  documentElementHadWindowedClass: boolean;
  documentElementHadScrollableClass: boolean;
  /**
   * Scroll offset at the moment of entry. Both modes disturb it — cover mode
   * locks scrolling, scrollable mode jumps to the top so the player is fully
   * visible — so exit puts the reader back where they were.
   */
  scrollX: number;
  scrollY: number;
}

/** Per-site preferences. */
export interface SitePrefs {
  autoApply: boolean;
  /** Use {@link WindowedMode} `scrollable` instead of `cover`. */
  scrollable: boolean;
}

/** Documented defaults applied when nothing is stored. */
export const DEFAULT_SITE_PREFS: SitePrefs = { autoApply: false, scrollable: false };

/** The mode a site's preferences select. */
export function modeFor(prefs: SitePrefs): WindowedMode {
  return prefs.scrollable ? "scrollable" : "cover";
}

/** Messages exchanged between the surfaces. */
export type ExtMessage = { type: "TOGGLE" } | { type: "GET_STATUS" };

/** Reply to an {@link ExtMessage}. */
export type ExtResponse = { ok: true; active: boolean } | { ok: false; error: string };

// ===========================================================================
// §2  Diagnostics
// ===========================================================================

/**
 * Stable diagnostic codes. They surface in the extension console only — nothing
 * is collected, buffered, or transmitted.
 */
const DIAGNOSTIC = {
  playerNotFound: "player-not-found",
  nativeControlNotFound: "native-control-not-found",
  absentChrome: "absent-chrome",
  reRenderAbandoned: "re-render-abandoned",
  playerLost: "player-lost",
  toggleUnreachable: "toggle-unreachable",
} as const;

type DiagnosticCode = (typeof DIAGNOSTIC)[keyof typeof DIAGNOSTIC];

/** Write one structured diagnostic line to the extension console. */
function warn(code: DiagnosticCode, message: string, context: Record<string, unknown> = {}): void {
  console.warn(`[wfs:${code}]`, message, context);
}

// ===========================================================================
// §3  Site adapters (YouTube)
// ===========================================================================

/**
 * Every YouTube selector in the extension. Nothing outside this section may
 * hard-code one.
 */
const YT = {
  /** Player root the core expands. */
  player: "#movie_player",
  /** Fallback when the id form is absent. */
  playerFallback: ".html5-video-player",
  /** Cluster holding the native fullscreen button. */
  controls: ".ytp-right-controls",
  /** YouTube's own fullscreen control. */
  nativeFullscreen: ".ytp-fullscreen-button",
  /**
   * Page chrome hidden in every mode. Both masthead forms are listed so a
   * missing one is simply tolerated. The masthead is fixed to the top of the
   * viewport, and the related-videos rail steals width the player wants, so
   * neither belongs on screen in either mode.
   *
   * Only elements OUTSIDE the player subtree may appear here. `#movie_player`
   * lives inside `#page-manager`, so hiding an ancestor like that with
   * `display:none` would take the video with it — a `position:fixed` descendant
   * is not spared. That mistake produced a black screen.
   */
  chromeAlways: ["#secondary"],
  /**
   * Additionally hidden in cover mode only. In scrollable mode these ARE the
   * content the user scrolled down for, so they stay.
   */
  chromeCoverOnly: ["#comments"],
} as const;

/** Hosts treated as YouTube. */
const YT_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

/**
 * YouTube's active-mode CSS. Scoped under `html.wfs-windowed` (a class the
 * controller toggles) so it only applies while the mode is on. `!important` is
 * required throughout: YouTube sizes the player and control bar with inline
 * styles from its own JS, and those beat ordinary rules.
 */
const YT_ACTIVE_MODE_CSS = `
/* --- Cover mode: the player is pinned to the viewport, above all chrome. --- */
html.wfs-windowed:not(.wfs-scrollable) #movie_player,
html.wfs-windowed:not(.wfs-scrollable) .html5-video-player {
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

/* Override the inline px sizing YouTube applies to the video container. */
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
  /* Letterbox rather than stretch. */
  object-fit: contain !important;
}

/* YouTube gives the bottom control bar an inline px width derived from the
   ORIGINAL watch-page player size (roughly half the screen), and never
   recomputes it when the player grows. Left alone, the scrubber and the menus
   anchored to it stay stuck across the left half. The 12px insets match
   YouTube's own gutter. */
html.wfs-windowed .ytp-chrome-bottom {
  width: auto !important;
  left: 12px !important;
  right: 12px !important;
}

/* Hide the in-player top overlay (title, channel, share, cards, gradient).
   The bottom control bar stays fully usable. */
html.wfs-windowed .ytp-chrome-top,
html.wfs-windowed .ytp-gradient-top,
html.wfs-windowed .ytp-title,
html.wfs-windowed .ytp-show-cards-title,
html.wfs-windowed .ytp-ce-element {
  display: none !important;
}

/* Chrome hidden in BOTH modes. The related-videos rail competes for width, so
   it goes in either mode. */
html.wfs-windowed #secondary,
html.wfs-windowed #secondary-inner {
  display: none !important;
}

/* -------------------------------------------------------------------------
   Hover-to-reveal masthead.

   Instead of removing the masthead entirely, we slide it off-screen and bring
   it back when the cursor moves to the top edge. This keeps every stock
   YouTube feature (hamburger menu, search, playlists, notifications) fully
   functional without leaving windowed mode.

   The technique: translate the masthead up by its own height, make it
   transparent, and reverse both on :hover. A transparent trigger zone (the
   ::before of the container) extends the hover target down a few px so the
   transition begins the moment the cursor touches the top edge.
   ------------------------------------------------------------------------- */
html.wfs-windowed #masthead-container {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  /* Sit above the player, which has z-index 2147483647 in cover mode. */
  z-index: 2147483648 !important;
  transform: translateY(-100%) !important;
  opacity: 0 !important;
  pointer-events: none !important;
  /* Fast reveal (80ms in), slower hide (200ms out) so it doesn't vanish
     while you're moving the cursor toward a link in the bar. */
  transition: transform 0.08s ease-out, opacity 0.08s ease-out !important;
}

/* Invisible trigger zone: extends the hover target below the translated-away
   masthead. 80px — well into the video area — so the cursor doesn't need to
   reach the very top edge to activate. pointer-events is auto so it detects
   the hover, but once the masthead is revealed the zone becomes pass-through
   so it doesn't block clicks on content beneath (like the sidebar's Home and
   Shorts links). */
html.wfs-windowed #masthead-container::before {
  content: "" !important;
  position: absolute !important;
  top: 100% !important;
  left: 0 !important;
  right: 0 !important;
  height: 80px !important;
  pointer-events: auto !important;
}

/* Once revealed, the trigger zone's job is done — stop intercepting clicks. */
html.wfs-windowed #masthead-container:hover::before,
html.wfs-windowed #masthead-container:focus-within::before {
  pointer-events: none !important;
}

html.wfs-windowed #masthead-container:hover,
html.wfs-windowed #masthead-container:focus-within {
  transform: translateY(0) !important;
  opacity: 1 !important;
  pointer-events: auto !important;
  /* Slightly slower on hide so the bar doesn't snap away mid-click. */
  transition: transform 0.08s ease-out, opacity 0.08s ease-out !important;
}

/* The masthead itself must be visible and clickable once the container reveals. */
html.wfs-windowed #masthead {
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* A subtle dark scrim behind the masthead so it reads over bright video. */
html.wfs-windowed #masthead-container:hover #masthead,
html.wfs-windowed #masthead-container:focus-within #masthead {
  background: rgba(15, 15, 15, 0.92) !important;
}

@media (prefers-reduced-motion: reduce) {
  html.wfs-windowed #masthead-container {
    transition: none !important;
  }
}

/* Cover mode also hides the page's own content: nothing below the player is
   reachable while the player owns the viewport, so leaving it rendered only
   risks it showing through. Scrollable mode keeps all of it — that is the
   entire feature. */
html.wfs-windowed:not(.wfs-scrollable) ytd-watch-metadata,
html.wfs-windowed:not(.wfs-scrollable) #above-the-fold,
html.wfs-windowed:not(.wfs-scrollable) #comments {
  display: none !important;
}

/* -------------------------------------------------------------------------
   Scrollable mode.

   The player becomes an ordinary block at the top of the document flow, sized
   to the viewport, so the page scrolls past it to the title, description, and
   comments exactly as it normally would.

   Getting there means undoing YouTube's player sizing, which is a chain of
   nested containers: #player-container-inner carries the aspect-ratio padding,
   #player-container-outer carries a max-width derived from CSS variables
   ytd-watch-flexy sets inline, and #player-container is absolutely positioned
   inside them. Every link has to be flattened to a plain full-width block, or
   the innermost one cannot grow.

   Widths are percentages rather than 100vw on purpose: this mode keeps a
   vertical scrollbar, and 100vw includes the scrollbar's width, which would
   push a horizontal scrollbar onto the page.
   ------------------------------------------------------------------------- */
html.wfs-windowed.wfs-scrollable #movie_player,
html.wfs-windowed.wfs-scrollable .html5-video-player {
  position: relative !important;
  top: auto !important;
  left: auto !important;
  right: auto !important;
  bottom: auto !important;
  width: 100% !important;
  max-width: 100% !important;
  height: 100vh !important;
  max-height: 100vh !important;
  margin: 0 !important;
  background: #000 !important;
}

/* Flatten the container chain between #primary-inner and the player. */
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #player,
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #player-container-outer,
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #player-container-inner,
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #player-container,
html.wfs-windowed.wfs-scrollable ytd-watch-flexy ytd-player,
html.wfs-windowed.wfs-scrollable ytd-watch-flexy ytd-player > #container {
  position: static !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  height: 100vh !important;
  min-height: 0 !important;
  max-height: 100vh !important;
  padding: 0 !important;
  margin: 0 !important;
}

/* #columns is a flex row of #primary and #secondary. With the related rail
   hidden, make it a plain block so #primary takes the full width. */
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #columns,
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #primary,
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #primary-inner {
  display: block !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
}

/* Theater mode parks the player in a height-capped full-bleed host. Release the
   cap so the same 100vh sizing applies whichever layout the user was in. */
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #full-bleed-container {
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  padding: 0 !important;
}

/* The page reserves a strip for the fixed masthead. With the masthead hidden,
   that strip would sit above the video as a gap. */
html.wfs-windowed.wfs-scrollable #page-manager {
  margin-top: 0 !important;
}

/* The content below the player spans the full window, matching the player above
   it. Only a gutter is added back, since #primary's padding was zeroed above. */
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #below {
  width: auto !important;
  max-width: none !important;
  margin: 20px 0 64px !important;
  padding: 0 24px !important;
}

/* #below's own children carry YouTube's column width, sized for the narrow
   watch-page layout. Without releasing them the section stretches but the
   metadata and comments inside stay in a centred column. */
html.wfs-windowed.wfs-scrollable ytd-watch-flexy #below > *,
html.wfs-windowed.wfs-scrollable ytd-watch-metadata,
html.wfs-windowed.wfs-scrollable #above-the-fold,
html.wfs-windowed.wfs-scrollable #bottom-row,
html.wfs-windowed.wfs-scrollable #description,
html.wfs-windowed.wfs-scrollable #comments,
html.wfs-windowed.wfs-scrollable #comments > #sections,
html.wfs-windowed.wfs-scrollable ytd-comments,
html.wfs-windowed.wfs-scrollable ytd-item-section-renderer#sections {
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}
`;

/**
 * Read the id of the playing video, used to detect in-app video changes.
 * YouTube exposes it as a `video-id` attribute and via the player API; read
 * both defensively and fall back to null so detection degrades gracefully.
 */
function readYouTubeVideoId(doc: Document): string | null {
  const player = doc.querySelector(YT.player);
  if (!player) return null;

  const attr = player.getAttribute("video-id");
  if (attr) return attr;

  const api = player as unknown as { getVideoData?: () => { video_id?: string } };
  if (typeof api.getVideoData === "function") {
    try {
      return api.getVideoData()?.video_id ?? null;
    } catch {
      // Player not ready yet.
      return null;
    }
  }
  return null;
}

/** The YouTube adapter — the only place YouTube DOM knowledge lives. */
const youtubeAdapter: SiteAdapter = {
  siteId: "youtube",
  label: "YouTube",

  matches(url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!YT_HOSTS.has(parsed.hostname)) return false;
    // Only match explicit watch pages. YouTube keeps `#movie_player` in the DOM
    // on non-watch pages (for the mini-player), so a DOM-presence fallback would
    // keep the session alive on the home page after SPA navigation — causing the
    // hover-reveal masthead CSS to persist where it should not.
    return parsed.pathname.startsWith("/watch");
  },

  matchesSite(url) {
    try {
      return YT_HOSTS.has(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  findPlayer(doc) {
    return doc.querySelector(YT.player) ?? doc.querySelector(YT.playerFallback);
  },

  findControlsContainer(doc) {
    return doc.querySelector(YT.controls);
  },

  findNativeFullscreenButton(doc) {
    return doc.querySelector(YT.nativeFullscreen);
  },

  getSiteChromeSelectors(mode) {
    // Fresh copy so callers cannot mutate the shared lists.
    return mode === "scrollable"
      ? [...YT.chromeAlways]
      : [...YT.chromeAlways, ...YT.chromeCoverOnly];
  },

  /**
   * YouTube only enlarges its control bar (scrubber, buttons, time, fonts) when
   * the player carries `ytp-big-mode`, which it normally toggles in native
   * fullscreen. Since we never enter real fullscreen, we add it ourselves —
   * otherwise the controls stay tiny on a viewport-sized player.
   */
  getActivePlayerClasses() {
    return ["ytp-big-mode"];
  },

  getActiveModeCss() {
    return YT_ACTIVE_MODE_CSS;
  },

  /**
   * Detect in-app video changes so the injector can re-verify the button.
   * Combines YouTube's `yt-navigate-finish` event with a `video-id` attribute
   * observer, since either can fire first.
   */
  onVideoChange(doc, onChange) {
    let lastVideoId = readYouTubeVideoId(doc);

    const onNavigate = (): void => {
      // The new id may settle after the event; re-read and notify regardless.
      lastVideoId = readYouTubeVideoId(doc);
      onChange();
    };
    doc.addEventListener("yt-navigate-finish", onNavigate);

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        const current = readYouTubeVideoId(doc);
        if (current !== lastVideoId) {
          lastVideoId = current;
          onChange();
        }
      });
      // The player may not exist yet, so watch the document for the attribute.
      // This also catches the player being re-attached during navigation.
      observer.observe(doc.documentElement ?? doc, {
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

// ===========================================================================
// §4  Adapter registry
// ===========================================================================

/**
 * Registered adapters, in resolution order. Adding a site means adding an
 * adapter here and nothing else.
 */
const ADAPTERS: readonly SiteAdapter[] = [youtubeAdapter];

/** The first adapter that can activate on `url`, or null. */
export function resolveAdapter(url: string | undefined): SiteAdapter | null {
  if (!url) return null;
  return ADAPTERS.find((adapter) => adapter.matches(url)) ?? null;
}

/** The first adapter that handles `url`'s site at all, or null. */
export function resolveSiteAdapter(url: string | undefined): SiteAdapter | null {
  if (!url) return null;
  return ADAPTERS.find((adapter) => adapter.matchesSite(url)) ?? null;
}

/** Every supported site, for the settings UI. */
export function supportedSites(): ReadonlyArray<{ siteId: string; label: string }> {
  return ADAPTERS.map(({ siteId, label }) => ({ siteId, label }));
}

// ===========================================================================
// §5  Preferences
// ===========================================================================

/**
 * Preferences live in `chrome.storage.local` only. `chrome.storage.sync` is
 * deliberately unused: it would replicate settings across the user's devices
 * through their browser account, and the published privacy policy promises
 * nothing leaves the device.
 */
function storageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

/** Namespaced key, so writing one site never disturbs another. */
function siteKey(siteId: string): string {
  return `site:${siteId}`;
}

/**
 * Read a site's preferences, falling back to documented defaults when nothing
 * is stored, storage is unavailable, or the stored value is unreadable.
 *
 * @returns the effective preferences, plus whether defaults were used because
 *   of a failure (as opposed to a first run, which is not an error).
 */
export async function getSitePrefs(
  siteId: string,
): Promise<{ prefs: SitePrefs; loadFailed: boolean }> {
  const area = storageArea();
  if (!area) return { prefs: { ...DEFAULT_SITE_PREFS }, loadFailed: true };

  const key = siteKey(siteId);
  try {
    const stored = (await area.get(key))?.[key];
    if (stored === undefined) {
      // First run: defaults, not a failure.
      return { prefs: { ...DEFAULT_SITE_PREFS }, loadFailed: false };
    }
    const normalized = normalizeSitePrefs(stored);
    if (!normalized) return { prefs: { ...DEFAULT_SITE_PREFS }, loadFailed: true };
    return { prefs: normalized, loadFailed: false };
  } catch {
    return { prefs: { ...DEFAULT_SITE_PREFS }, loadFailed: true };
  }
}

/**
 * Coerce a stored value into usable preferences, or null when it is too damaged
 * to trust.
 *
 * Each field is checked on its own so a value written by an older version — one
 * that knew nothing about `scrollable` — reads back as valid with that field at
 * its default, rather than being discarded as corrupt.
 */
function normalizeSitePrefs(stored: unknown): SitePrefs | null {
  if (typeof stored !== "object" || stored === null) return null;
  const raw = stored as Record<string, unknown>;
  // autoApply has existed since the first release; its absence means this is not
  // a preferences object at all.
  if (typeof raw.autoApply !== "boolean") return null;
  return {
    autoApply: raw.autoApply,
    scrollable: typeof raw.scrollable === "boolean" ? raw.scrollable : DEFAULT_SITE_PREFS.scrollable,
  };
}

/**
 * Persist part of a site's preferences, leaving the fields not named alone. On
 * failure nothing is written, so the previously stored value survives intact.
 *
 * The read-then-merge matters: the settings UI has one control per field, and a
 * whole-object write from either would silently reset the other.
 */
export async function setSitePrefs(
  siteId: string,
  patch: Partial<SitePrefs>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const area = storageArea();
  if (!area) return { ok: false, error: "storage unavailable" };
  try {
    const { prefs } = await getSitePrefs(siteId);
    await area.set({ [siteKey(siteId)]: { ...prefs, ...patch } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Call `onChange` whenever a site's preferences are written from another surface
 * (the popup or the options page), so a live page can follow along instead of
 * waiting for a reload. Returns a disposer.
 */
function watchSitePrefs(siteId: string, onChange: (prefs: SitePrefs) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return () => {};
  const key = siteKey(siteId);
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !(key in changes)) return;
    const normalized = normalizeSitePrefs(changes[key]?.newValue);
    if (normalized) onChange(normalized);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Best-effort human-readable form of an unknown thrown value. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// ===========================================================================
// §6  Active-mode stylesheet
// ===========================================================================

/** Id of the injected `<style>` element, used to keep injection idempotent. */
const STYLE_ELEMENT_ID = "wfs-windowed-styles";

/** Class the controller toggles on `<html>` while the mode is active. */
const WINDOWED_CLASS = "wfs-windowed";

/**
 * Added alongside {@link WINDOWED_CLASS} while the active mode is `scrollable`.
 * Every rule that differs between the two modes keys off its presence, so a
 * stylesheet is injected once and never rewritten.
 */
const SCROLLABLE_CLASS = "wfs-scrollable";

/** Attribute marking our injected button. */
const BUTTON_MARKER_ATTR = "data-wfs-button";

/** Class on the button reflecting the engaged state. */
const BUTTON_ACTIVE_CLASS = "is-active";

/**
 * Site-independent CSS. Deliberately references only our own classes; every
 * site selector arrives from the adapter's `getActiveModeCss()`.
 *
 * The button affordances are NOT scoped under `.wfs-windowed`: the button sits
 * in the control bar whether the mode is on or off, so it always needs a focus
 * ring and hover feedback.
 */
const BASE_CSS = `
.wfs-button:hover {
  opacity: 1 !important;
}

/* :focus-visible so the ring shows for keyboard users but not on mouse click.
   The negative offset keeps it inside the control bar. */
.wfs-button:focus-visible {
  outline: 2px solid #3ea6ff !important;
  outline-offset: -2px !important;
  opacity: 1 !important;
}

/* Engaged state: the visual equivalent of aria-pressed="true". */
.wfs-button.is-active {
  opacity: 1 !important;
  box-shadow: inset 0 -3px 0 0 #3ea6ff !important;
}

/* Cover mode locks the page: the player owns the viewport, so a scrollbar would
   only scroll hidden chrome. Scrollable mode must keep scrolling, and only
   suppresses sideways overflow in case a site element still overhangs. */
html.wfs-windowed:not(.wfs-scrollable),
html.wfs-windowed:not(.wfs-scrollable) body {
  overflow: hidden !important;
}

html.wfs-windowed.wfs-scrollable,
html.wfs-windowed.wfs-scrollable body {
  overflow-x: hidden !important;
}
`;

/**
 * Inject the base CSS plus the adapter's site CSS, exactly once.
 *
 * Uses `textContent` rather than `innerHTML` so pages enforcing Trusted Types
 * (YouTube does) cannot block it.
 */
function injectStyles(doc: Document, siteCss: string): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = siteCss ? `${BASE_CSS}\n${siteCss}` : BASE_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

// ===========================================================================
// §7  Controller (generic core)
// ===========================================================================

/** Highest practical stacking value, so the player sits above page chrome. */
const MAX_Z_INDEX = "2147483647";

/**
 * Delays (ms) at which a synthetic `resize` is dispatched after the player size
 * changes.
 *
 * Sites size their control bar from the player width in JS and only recompute
 * on a window resize. Without this nudge YouTube's scrubber can stay stuck at
 * the pre-toggle width while the rest of the bar fills out — the source of the
 * intermittent "sometimes half, sometimes full" scrubber. The player resizes
 * synchronously, so `0` covers the common case; the later ticks cover the
 * site's own debounced layout settling.
 */
const REFLOW_NUDGE_DELAYS_MS = [0, 60, 250, 600] as const;

/**
 * Inline player properties the controller mutates. Kebab-case so
 * `getPropertyValue` and `setProperty` agree.
 */
const PLAYER_STYLE_PROPS = [
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "width",
  "height",
  "z-index",
  "margin",
] as const;

/**
 * The player style applied on entry, per mode. Both maps set the same
 * properties — the ones {@link PLAYER_STYLE_PROPS} captures — so restoring is
 * identical whichever mode was used.
 */
const PLAYER_ACTIVE_STYLE: Record<WindowedMode, Record<string, string>> = {
  /** Pinned to the viewport, above everything. */
  cover: {
    position: "fixed",
    top: "0",
    right: "0",
    bottom: "0",
    left: "0",
    inset: "0",
    width: "100vw",
    height: "100vh",
    "z-index": MAX_Z_INDEX,
    margin: "0",
  },
  /**
   * A viewport-tall block in normal flow. Nothing is lifted out of the document,
   * so the player reserves its own space and the page scrolls past it. Width is
   * a percentage, not `100vw`, because this mode keeps a vertical scrollbar and
   * `100vw` counts the scrollbar's width.
   */
  scrollable: {
    position: "relative",
    top: "auto",
    right: "auto",
    bottom: "auto",
    left: "auto",
    inset: "auto",
    width: "100%",
    height: "100vh",
    "z-index": "auto",
    margin: "0",
  },
};

/** Inline properties mutated on each chrome element when hiding it. */
const CHROME_STYLE_PROPS = ["display", "visibility"] as const;

/**
 * Capture the inline values of `props`, distinguishing "not set" (null) from any
 * set value so restoration is exact.
 */
function captureStyle(el: Element, props: readonly string[]): Record<string, string | null> {
  const captured: Record<string, string | null> = {};
  for (const prop of props) {
    const value = (el as HTMLElement).style.getPropertyValue(prop);
    captured[prop] = value === "" ? null : value;
  }
  return captured;
}

/** Restore inline style from a captured map, removing properties that were unset. */
function restoreStyle(el: Element, captured: Record<string, string | null>): void {
  const style = (el as HTMLElement).style;
  for (const [prop, value] of Object.entries(captured)) {
    if (value === null) style.removeProperty(prop);
    else style.setProperty(prop, value);
  }
}

/** Whether `el` is still attached to a rendered document. */
function isConnected(el: Element): boolean {
  if (typeof el.isConnected === "boolean") return el.isConnected;
  return el.ownerDocument?.contains(el) ?? false;
}

/**
 * The generic core. Holds no site knowledge: every DOM reference arrives in a
 * {@link SiteDescriptor}, and the browser Fullscreen API is never touched.
 *
 * `enter` captures a restore record before mutating anything, so the page can
 * always be put back exactly as it was. Entry is refused, leaving the page
 * untouched, when the descriptor is incomplete or the mode is already active.
 */
export class WindowedFullscreenController {
  private readonly doc: Document;
  /**
   * Read at entry, not construction, so a preference changed mid-session takes
   * effect on the next entry without rebuilding anything.
   */
  private readonly getMode: () => WindowedMode;

  private active = false;
  private activeMode: WindowedMode = "cover";
  private descriptor: SiteDescriptor | null = null;
  private snapshot: LayoutSnapshot | null = null;
  private button: Element | null = null;

  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private playerWatcher: MutationObserver | null = null;
  /** Only the classes we actually added, so exit removes exactly those. */
  private addedPlayerClasses: string[] = [];
  private reflowTimers: number[] = [];

  constructor(doc: Document, getMode: () => WindowedMode = () => "cover") {
    this.doc = doc;
    this.getMode = getMode;
  }

  /** Whether the mode is currently active. */
  get isActive(): boolean {
    return this.active;
  }

  /** The mode the current session entered with. Meaningless while inactive. */
  get mode(): WindowedMode {
    return this.activeMode;
  }

  /**
   * Associate the button whose engaged state the controller drives. The button
   * is injected after construction and re-created across page re-renders, so
   * this can be called repeatedly.
   */
  setButton(button: Element | null): void {
    this.button = button;
    this.applyButtonState(this.active);
  }

  /** Enter the mode. Returns false when it refused, having changed nothing. */
  enter(descriptor: SiteDescriptor): boolean {
    if (this.active) return false;
    if (!descriptor.player || !descriptor.nativeFullscreenButton) return false;

    const docEl = this.doc.documentElement;
    const view = this.doc.defaultView;
    const mode = this.getMode();

    // 1. Capture the restore record BEFORE touching anything.
    this.snapshot = {
      playerStyle: captureStyle(descriptor.player, PLAYER_STYLE_PROPS),
      chrome: descriptor.siteChromeElements.map((element) => ({
        element,
        style: captureStyle(element, CHROME_STYLE_PROPS),
      })),
      documentElementHadWindowedClass: docEl.classList.contains(WINDOWED_CLASS),
      documentElementHadScrollableClass: docEl.classList.contains(SCROLLABLE_CLASS),
      scrollX: view?.scrollX ?? 0,
      scrollY: view?.scrollY ?? 0,
    };

    // 2. Record selectors that matched nothing, then carry on regardless.
    for (const selector of descriptor.missingChromeSelectors) {
      warn(DIAGNOSTIC.absentChrome, "Site chrome selector matched no element on entry", { selector });
    }

    // 3. Activate the stylesheet, selecting the mode's half of it.
    docEl.classList.add(WINDOWED_CLASS);
    if (mode === "scrollable") docEl.classList.add(SCROLLABLE_CLASS);

    // 4. Expand the player. CSS only — never the Fullscreen API.
    const playerStyle = (descriptor.player as HTMLElement).style;
    for (const [prop, value] of Object.entries(PLAYER_ACTIVE_STYLE[mode])) {
      playerStyle.setProperty(prop, value);
    }

    // 5. Hide the resolved chrome elements.
    for (const element of descriptor.siteChromeElements) {
      const style = (element as HTMLElement).style;
      style.setProperty("display", "none");
      style.setProperty("visibility", "hidden");
    }

    // 6. Opt into the site's own large-player styling, tracking what we added.
    this.addedPlayerClasses = [];
    for (const cls of descriptor.activePlayerClasses) {
      if (cls && !descriptor.player.classList.contains(cls)) {
        descriptor.player.classList.add(cls);
        this.addedPlayerClasses.push(cls);
      }
    }

    this.descriptor = descriptor;
    this.activeMode = mode;
    this.active = true;
    this.applyButtonState(true);
    this.registerEscape();
    this.startPlayerWatcher(descriptor.player);

    // 7. In scrollable mode the player only fills the screen when the page is at
    //    the top, so start there however far down the reader had scrolled. Exit
    //    puts them back.
    if (mode === "scrollable") view?.scrollTo(0, 0);

    // 8. Prompt the site to recompute its control-bar geometry.
    this.scheduleReflowNudge();
    return true;
  }

  /** Exit the mode, restoring the captured pre-entry state. No-op when inactive. */
  exit(): void {
    if (!this.active) return;

    const { snapshot, descriptor } = this;
    if (snapshot && descriptor) {
      for (const cls of this.addedPlayerClasses) {
        descriptor.player.classList.remove(cls);
      }
      restoreStyle(descriptor.player, snapshot.playerStyle);
      for (const entry of snapshot.chrome) {
        restoreStyle(entry.element, entry.style);
      }
      // Leave either class alone if it somehow pre-dated entry.
      if (!snapshot.documentElementHadWindowedClass) {
        this.doc.documentElement.classList.remove(WINDOWED_CLASS);
      }
      if (!snapshot.documentElementHadScrollableClass) {
        this.doc.documentElement.classList.remove(SCROLLABLE_CLASS);
      }
      // Restore the reading position. Deferred to the next frame because the
      // layout the offset refers to only exists once the styles above have been
      // reverted and the page has re-flowed.
      const view = this.doc.defaultView;
      if (view) {
        const { scrollX, scrollY } = snapshot;
        view.requestAnimationFrame(() => view.scrollTo(scrollX, scrollY));
      }
    }

    this.unregisterEscape();
    this.stopPlayerWatcher();

    this.active = false;
    this.descriptor = null;
    this.snapshot = null;
    this.addedPlayerClasses = [];
    this.applyButtonState(false);

    // Mirror the entry nudge for the restored, smaller player.
    this.scheduleReflowNudge();
  }

  /**
   * Flip the mode. A `null` resolution — no player yet — leaves the page alone.
   */
  toggle(resolve: () => SiteDescriptor | null): void {
    if (this.active) {
      this.exit();
      return;
    }
    const descriptor = resolve();
    if (descriptor) this.enter(descriptor);
  }

  /** Reflect the mode on the associated button. */
  private applyButtonState(engaged: boolean): void {
    if (!this.button) return;
    this.button.setAttribute("aria-pressed", engaged ? "true" : "false");
    this.button.classList.toggle(BUTTON_ACTIVE_CLASS, engaged);
  }

  /** Exit on Escape. Capturing, so the site cannot swallow the key first. */
  private registerEscape(): void {
    if (this.escapeHandler) return;
    this.escapeHandler = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && this.active) this.exit();
    };
    this.doc.addEventListener("keydown", this.escapeHandler as EventListener, true);
  }

  private unregisterEscape(): void {
    if (!this.escapeHandler) return;
    this.doc.removeEventListener("keydown", this.escapeHandler as EventListener, true);
    this.escapeHandler = null;
  }

  /**
   * Exit if the page tears the player out of the DOM (an in-app navigation can
   * do this), so we never leave the page in a mutated state with no player.
   *
   * Observes the player's PARENT for child removal rather than the whole
   * document subtree: watching `documentElement` with `subtree: true` fires on
   * every DOM change the site makes during playback, which is a real source of
   * jank on YouTube. Detaching the player means removing it from its parent, so
   * a `childList` observer there catches it cheaply.
   */
  private startPlayerWatcher(player: Element): void {
    if (this.playerWatcher || typeof MutationObserver === "undefined") return;
    const root = player.parentNode ?? (player.ownerDocument ?? this.doc).documentElement;
    if (!root) return;

    this.playerWatcher = new MutationObserver(() => {
      if (this.active && !isConnected(player)) {
        warn(DIAGNOSTIC.playerLost, "Active player element was removed from the DOM");
        // exit() clears the active flag, so this cannot double-fire.
        this.exit();
      }
    });
    this.playerWatcher.observe(root, { childList: true });
  }

  private stopPlayerWatcher(): void {
    this.playerWatcher?.disconnect();
    this.playerWatcher = null;
  }

  /**
   * Dispatch a short series of synthetic `resize` events so the site recomputes
   * any layout it derives from the player size in JS. Entirely best-effort: a
   * missing view or a failed dispatch must never affect the mode state.
   */
  private scheduleReflowNudge(): void {
    const view = this.doc.defaultView;
    if (!view) return;

    for (const id of this.reflowTimers) view.clearTimeout(id);
    this.reflowTimers = [];

    const fire = (): void => {
      try {
        view.dispatchEvent(new view.Event("resize"));
      } catch {
        // Layout hint only; never throw out of enter/exit.
      }
    };

    for (const delay of REFLOW_NUDGE_DELAYS_MS) {
      if (delay === 0) fire();
      else this.reflowTimers.push(view.setTimeout(fire, delay));
    }
  }
}

// ===========================================================================
// §8  Button injector
// ===========================================================================

/** Accessible name for the injected button. */
const BUTTON_LABEL = "Windowed fullscreen";

/** Used only if the native control somehow already carries {@link BUTTON_LABEL}. */
const BUTTON_LABEL_FALLBACK = "Windowed fullscreen (extension)";

/** Debounce applied to mutation-driven re-verification. */
const DEBOUNCE_MS = 100;

/** Initial detection: 10 attempts at 1s keeps the whole window inside 10s. */
const DETECTION_INTERVAL_MS = 1_000;
const MAX_DETECTION_ATTEMPTS = 10;

/** Re-render after the page removes our button: within 2s, at most 5 times. */
const RE_RENDER_INTERVAL_MS = 2_000;
const MAX_RE_RENDER_ATTEMPTS = 5;

/** Give up once the controls have stayed absent this long. */
const RE_RENDER_TIMEOUT_MS = 30_000;

/** Outcome of one {@link ButtonInjector.ensureButton} call. */
type EnsureResult = "injected" | "present" | "no-target";

/** Attributes an element uses to advertise its accessible name. */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const title = el.getAttribute("title")?.trim();
  if (title) return title;
  return (el.textContent ?? "").trim();
}

/**
 * Keeps exactly one windowed-fullscreen button next to the site's native
 * fullscreen control, and keeps it there as the site re-renders.
 *
 * Two bounded loops guard against the site never cooperating, so neither can
 * spin forever:
 *
 *  - **Initial detection.** Retries `ensureButton` up to
 *    {@link MAX_DETECTION_ATTEMPTS} times. If the player or native control never
 *    appear, it logs which one was missing and stops, leaving the page untouched.
 *  - **Re-render after removal.** If the site deletes our button while the mode
 *    is inactive, re-inject within {@link RE_RENDER_INTERVAL_MS} of the controls
 *    reappearing, at most {@link MAX_RE_RENDER_ATTEMPTS} times, abandoning after
 *    {@link RE_RENDER_TIMEOUT_MS} of absent controls.
 */
export class ButtonInjector {
  private readonly adapter: SiteAdapter;
  private readonly doc: Document;
  private readonly onToggle: () => void;
  private readonly onButtonChange: (button: Element | null) => void;
  private readonly isModeActive: () => boolean;

  /** The button we own, or null when none is injected. */
  private current: Element | null = null;
  /** Buttons already click-wired, so we never double-wire an adopted element. */
  private readonly wired = new WeakSet<Element>();
  private readonly clickHandler: (e: Event) => void;

  private observer: MutationObserver | null = null;
  private disposeVideoChange: (() => void) | null = null;
  private started = false;

  private debounceTimer: number | null = null;

  private detectionTimer: number | null = null;
  private detectionAttempts = 0;
  private detectionDone = false;

  private reRenderTimer: number | null = null;
  private reRenderAttempts = 0;
  private reRenderElapsedMs = 0;
  private reRenderRunning = false;
  private reRenderAbandoned = false;

  constructor(options: {
    adapter: SiteAdapter;
    document: Document;
    /** Invoked when the button is clicked. */
    onToggle: () => void;
    /** Invoked whenever the owned button element changes, so state can follow it. */
    onButtonChange: (button: Element | null) => void;
    /** The re-render loop only runs while the mode is inactive. */
    isModeActive: () => boolean;
  }) {
    this.adapter = options.adapter;
    this.doc = options.document;
    this.onToggle = options.onToggle;
    this.onButtonChange = options.onButtonChange;
    this.isModeActive = options.isModeActive;
    this.clickHandler = (e: Event): void => {
      e.preventDefault();
      this.onToggle();
    };
  }

  /** Start watching and attempt the first injection. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.detectionAttempts = 0;
    this.detectionDone = false;
    this.reRenderAttempts = 0;
    this.reRenderElapsedMs = 0;
    this.reRenderRunning = false;
    this.reRenderAbandoned = false;

    // Watch first, so controls appearing mid-detection are noticed.
    this.startObserver();
    this.disposeVideoChange = this.adapter.onVideoChange(this.doc, () => this.scheduleEnsure());

    // The first attempt runs synchronously so callers get an immediate result.
    this.runDetection();
  }

  /** Stop watching, dispose hooks, and remove our button. */
  stop(): void {
    this.started = false;
    this.detectionDone = true;
    this.reRenderRunning = false;

    this.clearTimer("debounceTimer");
    this.clearTimer("detectionTimer");
    this.clearTimer("reRenderTimer");

    this.observer?.disconnect();
    this.observer = null;
    this.disposeVideoChange?.();
    this.disposeVideoChange = null;

    if (this.current) {
      this.current.removeEventListener("click", this.clickHandler);
      this.current.remove();
      this.current = null;
      this.onButtonChange(null);
    }
  }

  /**
   * Idempotently guarantee exactly one correctly placed, correctly labelled
   * button. Safe to call any number of times. The native control is read but
   * never modified.
   */
  ensureButton(): EnsureResult {
    const container = this.adapter.findControlsContainer(this.doc);
    const native = this.adapter.findNativeFullscreenButton(this.doc);
    // No render target yet: leave the page exactly as it is.
    if (!container || !native) return "no-target";

    // De-duplicate, preferring the instance we already own.
    const marked = Array.from(container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`));
    let kept: Element | null = null;
    if (marked.length > 0) {
      kept = (this.current && marked.includes(this.current) && this.current) || marked[0];
      for (const el of marked) {
        if (el !== kept) el.remove();
      }
    }

    const created = kept === null;
    const button = kept ?? this.createButton(native);

    // Re-position if the site moved it away from the native control.
    if (native.nextSibling !== button) native.after(button);

    if (!this.wired.has(button)) {
      button.addEventListener("click", this.clickHandler);
      this.wired.add(button);
    }

    if (this.current !== button) {
      this.current = button;
      this.onButtonChange(button);
    }

    return created ? "injected" : "present";
  }

  /**
   * Build the button. The inline styles are generic — no site CSS — and are what
   * make it actually visible inside a typical video control bar; without them it
   * has no size and no glyph.
   */
  private createButton(native: Element): Element {
    const btn = this.doc.createElement("button");
    btn.setAttribute(BUTTON_MARKER_ATTR, "");
    btn.setAttribute("type", "button");
    btn.className = "wfs-button";

    // Keep our accessible name distinct from the native control's.
    const label =
      accessibleName(native).toLowerCase() === BUTTON_LABEL.toLowerCase()
        ? BUTTON_LABEL_FALLBACK
        : BUTTON_LABEL;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.setAttribute("aria-pressed", "false");

    btn.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "height:100%",
      "width:48px",
      "padding:0",
      "margin:0",
      "background:transparent",
      "border:0",
      "cursor:pointer",
      "opacity:0.9",
      "vertical-align:top",
      "box-sizing:border-box",
    ].join(";");

    btn.appendChild(this.buildIcon());
    return btn;
  }

  /**
   * The glyph: a framed rectangle suggesting a video filling a window. Built
   * with DOM calls rather than `innerHTML` so Trusted Types pages cannot block
   * it.
   */
  private buildIcon(): Element {
    const ns = "http://www.w3.org/2000/svg";
    const svg = this.doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 36 36");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const frame = this.doc.createElementNS(ns, "rect");
    for (const [name, value] of Object.entries({
      x: "7",
      y: "9",
      width: "22",
      height: "18",
      rx: "1.5",
      fill: "none",
      stroke: "#ffffff",
      "stroke-width": "2",
    })) {
      frame.setAttribute(name, value);
    }
    svg.appendChild(frame);

    const fill = this.doc.createElementNS(ns, "rect");
    for (const [name, value] of Object.entries({
      x: "10",
      y: "12.5",
      width: "16",
      height: "11",
      rx: "1",
      fill: "#ffffff",
    })) {
      fill.setAttribute(name, value);
    }
    svg.appendChild(fill);

    return svg;
  }

  /**
   * Watch the player subtree for mutations. Prefers the player root, then the
   * controls container, then the document element, so controls mounting and
   * unmounting are both caught.
   */
  private startObserver(): void {
    if (this.observer || typeof MutationObserver === "undefined") return;
    const root =
      this.adapter.findPlayer(this.doc) ??
      this.adapter.findControlsContainer(this.doc) ??
      this.doc.documentElement;
    if (!root) return;

    this.observer = new MutationObserver(() => {
      // The site removed our button while the mode is off: hand off to the
      // bounded re-render loop rather than re-injecting immediately.
      if (this.current && !isConnected(this.current) && !this.isModeActive()) {
        this.startReRenderLoop();
        return;
      }
      this.scheduleEnsure();
    });
    this.observer.observe(root, { childList: true, subtree: true });
  }

  /** Debounced `ensureButton`, so a burst of mutations costs one pass. */
  private scheduleEnsure(): void {
    this.clearTimer("debounceTimer");
    this.debounceTimer = this.setTimer(() => {
      this.debounceTimer = null;
      this.ensureButton();
    }, DEBOUNCE_MS);
  }

  /** One attempt of the bounded initial-detection loop. */
  private runDetection(): void {
    if (this.detectionDone || !this.started) return;

    this.detectionAttempts += 1;
    if (this.ensureButton() !== "no-target") {
      this.detectionDone = true;
      return;
    }

    if (this.detectionAttempts >= MAX_DETECTION_ATTEMPTS) {
      this.detectionDone = true;
      // Say which piece was missing — it is the difference between "not a video
      // page" and "the site changed its control bar markup".
      const context = { siteId: this.adapter.siteId, attempts: this.detectionAttempts };
      if (!this.adapter.findPlayer(this.doc)) {
        warn(DIAGNOSTIC.playerNotFound, "Video player not found; leaving the page unchanged.", context);
      } else {
        warn(
          DIAGNOSTIC.nativeControlNotFound,
          "Native fullscreen control not found; leaving the page unchanged.",
          context,
        );
      }
      return;
    }

    this.detectionTimer = this.setTimer(() => {
      this.detectionTimer = null;
      this.runDetection();
    }, DETECTION_INTERVAL_MS);
  }

  /** Start the re-render loop, resetting the abandon deadline for this removal. */
  private startReRenderLoop(): void {
    if (this.reRenderRunning || this.reRenderAbandoned || this.reRenderAttempts >= MAX_RE_RENDER_ATTEMPTS) {
      return;
    }
    this.reRenderRunning = true;
    this.reRenderElapsedMs = 0;
    this.reRenderTick();
  }

  private reRenderTick(): void {
    // Stopped, or the mode came on: the loop only applies while inactive.
    if (!this.started || this.isModeActive()) {
      this.stopReRenderLoop();
      return;
    }
    // Something else already restored it.
    if (this.current && isConnected(this.current)) {
      this.stopReRenderLoop();
      return;
    }

    const hasTarget =
      this.adapter.findControlsContainer(this.doc) && this.adapter.findNativeFullscreenButton(this.doc);

    if (hasTarget) {
      if (this.ensureButton() !== "no-target") this.reRenderAttempts += 1;
      // The observer restarts this loop if the site removes the button again,
      // up to the attempt bound.
      this.stopReRenderLoop();
      return;
    }

    this.reRenderElapsedMs += RE_RENDER_INTERVAL_MS;
    if (this.reRenderElapsedMs >= RE_RENDER_TIMEOUT_MS) {
      this.reRenderAbandoned = true;
      this.stopReRenderLoop();
      warn(DIAGNOSTIC.reRenderAbandoned, "Player controls did not reappear; abandoning re-render.", {
        siteId: this.adapter.siteId,
        attempts: this.reRenderAttempts,
        elapsedMs: this.reRenderElapsedMs,
      });
      return;
    }

    this.reRenderTimer = this.setTimer(() => {
      this.reRenderTimer = null;
      this.reRenderTick();
    }, RE_RENDER_INTERVAL_MS);
  }

  private stopReRenderLoop(): void {
    this.reRenderRunning = false;
    this.clearTimer("reRenderTimer");
  }

  /** Timers come from the document's own view, so they die with the page. */
  private setTimer(handler: () => void, ms: number): number {
    return (this.doc.defaultView ?? globalThis).setTimeout(handler, ms) as unknown as number;
  }

  private clearTimer(field: "debounceTimer" | "detectionTimer" | "reRenderTimer"): void {
    const id = this[field];
    if (id === null) return;
    (this.doc.defaultView ?? globalThis).clearTimeout(id);
    this[field] = null;
  }
}

// ===========================================================================
// §9  Content script
// ===========================================================================

/**
 * Build a descriptor from the adapter, or null when the page is not ready.
 *
 * Selectors that match nothing are collected rather than treated as failures:
 * a site legitimately does not render every chrome element on every page.
 */
function resolveDescriptor(
  adapter: SiteAdapter,
  doc: Document,
  mode: WindowedMode,
): SiteDescriptor | null {
  const player = adapter.findPlayer(doc);
  const nativeFullscreenButton = adapter.findNativeFullscreenButton(doc);
  // The controls container is not part of the descriptor, but its absence means
  // the control bar has not rendered yet, so the page is not ready.
  if (!player || !nativeFullscreenButton || !adapter.findControlsContainer(doc)) return null;

  const siteChromeElements: Element[] = [];
  const missingChromeSelectors: string[] = [];
  for (const selector of adapter.getSiteChromeSelectors(mode)) {
    const matched = Array.from(doc.querySelectorAll(selector));
    if (matched.length === 0) missingChromeSelectors.push(selector);
    else siteChromeElements.push(...matched);
  }

  return {
    player,
    nativeFullscreenButton,
    siteChromeElements,
    missingChromeSelectors,
    activePlayerClasses: adapter.getActivePlayerClasses(),
  };
}

/** A live content-script session for one supported site. */
interface Session {
  readonly siteId: string;
  handleMessage(message: ExtMessage): ExtResponse | null;
  stop(): void;
}

/**
 * Wire up one supported page: inject the stylesheet, start the injector, and
 * apply the per-site auto-apply preference.
 *
 * Escape handling belongs to the controller, registered on entry, so it is
 * deliberately not wired here — doing both would register it twice.
 */
function startSession(adapter: SiteAdapter, doc: Document): Session {
  injectStyles(doc, adapter.getActiveModeCss());

  let prefs: SitePrefs = { ...DEFAULT_SITE_PREFS };

  const controller = new WindowedFullscreenController(doc, () => modeFor(prefs));
  const resolve = (): SiteDescriptor | null => resolveDescriptor(adapter, doc, modeFor(prefs));

  // Auto-apply enters the mode once, as soon as both the preference has resolved
  // and the player exists. Which happens first is unpredictable, so this is
  // idempotent and driven from both sides.
  let autoApplyEnabled = false;
  let prefResolved = false;
  let autoApplied = false;

  const maybeAutoApply = (): void => {
    if (!prefResolved || !autoApplyEnabled || autoApplied || controller.isActive) return;
    const descriptor = resolve();
    // Not ready yet; the next button change re-triggers this.
    if (!descriptor) return;
    autoApplied = true;
    controller.enter(descriptor);
  };

  /**
   * Switch modes without leaving the mode. Exit restores the page, so a fresh
   * descriptor has to be resolved afterwards — the chrome it hides differs
   * between the two modes.
   */
  const reapplyMode = (): void => {
    if (!controller.isActive || controller.mode === modeFor(prefs)) return;
    controller.exit();
    const descriptor = resolve();
    if (descriptor) controller.enter(descriptor);
  };

  // Toggling the mode in the popup while a video is open should change what is on
  // screen, not what happens next time.
  const disposePrefWatch = watchSitePrefs(adapter.siteId, (next) => {
    prefs = next;
    autoApplyEnabled = next.autoApply;
    reapplyMode();
  });

  const injector = new ButtonInjector({
    adapter,
    document: doc,
    onToggle: () => controller.toggle(resolve),
    onButtonChange: (button) => {
      controller.setButton(button);
      // The button appearing is a good proxy for the player having loaded.
      maybeAutoApply();
    },
    isModeActive: () => controller.isActive,
  });
  injector.start();

  void getSitePrefs(adapter.siteId).then(({ prefs: stored }) => {
    prefs = stored;
    autoApplyEnabled = stored.autoApply;
    prefResolved = true;
    maybeAutoApply();
  });

  return {
    siteId: adapter.siteId,
    handleMessage(message) {
      switch (message?.type) {
        case "TOGGLE":
          controller.toggle(resolve);
          return { ok: true, active: controller.isActive };
        case "GET_STATUS":
          return { ok: true, active: controller.isActive };
        default:
          return null;
      }
    },
    stop() {
      disposePrefWatch();
      injector.stop();
      if (controller.isActive) controller.exit();
      // Belt-and-suspenders: ensure no active-mode class lingers on <html> after
      // teardown, even if exit() was not called (e.g. the session is torn down
      // while the mode was off). Without this, a leftover class from a prior
      // session could cause the hover-reveal masthead CSS to fire on pages that
      // are not in windowed mode (e.g. the YouTube home page after SPA nav).
      doc.documentElement.classList.remove(WINDOWED_CLASS, SCROLLABLE_CLASS);
    },
  };
}

/**
 * Content-script entry point.
 *
 * The complication this solves: YouTube is a single-page app, so navigating
 * from the home page to a video never reloads the document. The content script
 * runs once, on whatever URL it first loaded. If that URL had no player, a naive
 * implementation would wire nothing and the user would have to reload the page
 * to get the button.
 *
 * So instead of bootstrapping once, this keeps a session in sync with the
 * current URL — creating one on arriving at a supported page, tearing it down on
 * leaving. One persistent message listener routes to whatever session is
 * current, so re-bootstrapping never stacks duplicate listeners.
 *
 * Navigation is detected by polling `location.href` alongside `popstate` and
 * `hashchange`. Content scripts run in an isolated world, so the page's own
 * `history.pushState` calls cannot be intercepted from here; a once-a-second
 * string comparison is cheap, reliable, and works on any site.
 */
export function startContentScript(): void {
  let session: Session | null = null;

  // Registered once for the lifetime of the script. When no session is active
  // (say, the YouTube home page) it still answers, so the popup renders a
  // correct "open a video" state instead of waiting for a reply that never comes.
  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: ExtResponse) => void) => {
      const handled = session?.handleMessage(message as ExtMessage);
      if (handled) {
        sendResponse(handled);
        return;
      }
      const type = (message as ExtMessage)?.type;
      if (type === "TOGGLE" || type === "GET_STATUS") {
        sendResponse({ ok: true, active: false });
      }
    },
  );

  const sync = (): void => {
    const adapter = resolveAdapter(location.href);
    if (adapter) {
      // Already running for this site; its own video-change hook covers
      // video-to-video moves, so leave the live session in place.
      if (session?.siteId === adapter.siteId) return;
      session?.stop();
      session = startSession(adapter, document);
    } else if (session) {
      // Left the supported page, e.g. watch -> home.
      session.stop();
      session = null;
    }
  };

  sync();

  let lastHref = location.href;
  const onMaybeNavigated = (): void => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    sync();
  };
  window.addEventListener("popstate", onMaybeNavigated);
  window.addEventListener("hashchange", onMaybeNavigated);
  setInterval(onMaybeNavigated, 1_000);

  // YouTube fires `yt-navigate-finish` after every SPA navigation completes.
  // The href poll catches most transitions, but YouTube can fire this event
  // before the URL visibly changes in `location.href` (the history entry is
  // committed inside the event). More critically, `resolveAdapter` falls back
  // to the player element's presence, so during the brief overlap where the URL
  // changed but the old player is still in the DOM, sync() would not tear down
  // the session. Listening here guarantees teardown happens the instant YouTube
  // considers the navigation done — so the masthead returns to normal on pages
  // that are not watch pages.
  document.addEventListener("yt-navigate-finish", () => {
    lastHref = location.href;
    sync();
  });
}

// ===========================================================================
// §10  Service worker
// ===========================================================================

/** The manifest command that toggles the mode. */
const TOGGLE_COMMAND = "toggle-windowed-fullscreen";

/**
 * How long to wait for the content script to acknowledge. Past this it is
 * treated as unreachable and the toolbar shows a failure badge.
 */
const SEND_TIMEOUT_MS = 500;

/** The active tab, or undefined when there is none. */
async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

/** Send a message to a tab, rejecting if it does not answer within budget. */
function sendToTab(tabId: number, message: ExtMessage): Promise<ExtResponse | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sendMessage timed out after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS);
    (chrome.tabs.sendMessage(tabId, message) as Promise<ExtResponse | undefined>).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Show or clear a failure badge on the toolbar icon. Best-effort throughout. */
async function setFailureBadge(failed: boolean, detail?: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.action) return;
  try {
    if (failed) {
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
      await chrome.action.setTitle({
        title: `Windowed Fullscreen: could not toggle${detail ? ` (${detail})` : ""}`,
      });
    } else {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: "Windowed Fullscreen" });
    }
  } catch {
    // Purely an affordance; never throw out of the command handler.
  }
}

/**
 * Relay the keyboard command to the active tab's content script, gated on the
 * tab being a supported site. When the content script is unreachable the mode is
 * left alone and the failure surfaces on the toolbar icon.
 */
async function handleToggleCommand(command: string): Promise<void> {
  if (command !== TOGGLE_COMMAND) return;

  const tab = await queryActiveTab();
  if (!tab?.id || !tab.url) return;
  if (!resolveAdapter(tab.url)) return;

  try {
    const response = await sendToTab(tab.id, { type: "TOGGLE" });
    if (response?.ok) {
      await setFailureBadge(false);
      return;
    }
    const error = response && !response.ok ? response.error : "no response from content script";
    warn(DIAGNOSTIC.toggleUnreachable, "Toggle command could not reach the content script", {
      error,
      url: tab.url,
    });
    await setFailureBadge(true, error);
  } catch (err) {
    const error = describeError(err);
    warn(DIAGNOSTIC.toggleUnreachable, "Toggle command could not reach the content script", {
      error,
      url: tab.url,
    });
    await setFailureBadge(true, error);
  }
}

/**
 * Service-worker entry point. The worker is event-driven and may be terminated
 * and restarted at any time, so it holds no state — everything durable lives in
 * `chrome.storage`.
 */
export function startServiceWorker(): void {
  chrome.commands?.onCommand.addListener((command) => {
    void handleToggleCommand(command);
  });
}

// ===========================================================================
// §11  Settings UI (shared by options page and popup)
// ===========================================================================

/** Where the browser lets the user rebind the keyboard shortcut. */
const SHORTCUTS_URL = "chrome://extensions/shortcuts";

/** External donation page. */
const DONATION_URL = "https://ko-fi.com/rohittiger";

/** Hosted privacy policy, linked for trust. */
const PRIVACY_POLICY_URL = "https://rohittiger.vercel.app/product/windowedfullscreen/privacy";

/**
 * The per-site boolean preferences, in the order they appear. Every entry is one
 * checkbox in both the options page and the popup; adding a preference here is
 * all it takes to surface it in both.
 */
const SITE_TOGGLES: ReadonlyArray<{
  field: keyof SitePrefs;
  /** Marker attribute, so the control is findable without relying on order. */
  marker: string;
  /** Visible text beside the checkbox. */
  text: (siteLabel: string) => string;
  /** Accessible name, which must stand alone out of context. */
  aria: (siteLabel: string) => string;
  /** Optional explanation rendered beneath. */
  hint?: string;
}> = [
  {
    field: "autoApply",
    marker: "data-wfs-autoapply",
    text: (siteLabel) => `Automatically enter windowed fullscreen on ${siteLabel}`,
    aria: (siteLabel) => `Auto-apply windowed fullscreen on ${siteLabel}`,
  },
  {
    field: "scrollable",
    marker: "data-wfs-scrollable",
    text: () => "Scrollable mode",
    aria: (siteLabel) => `Scrollable windowed fullscreen on ${siteLabel}`,
    hint:
      "The video still fills the screen when you enter, but the page keeps scrolling — " +
      "scroll down for the description and comments, scroll back up for the video. " +
      "Leave this off to lock the page to the video alone.",
  },
];

/**
 * Render the settings controls into `root`: one auto-apply checkbox per
 * supported site, the shortcut link, the donation link, and a privacy-policy
 * footer link.
 *
 * The same function backs both the standalone options page and the popup, which
 * is why the heading is optional — the popup already has a title of its own.
 *
 * Each checkbox loads its effective value (stored, else the documented default).
 * On a failed write the control reverts to the last persisted value and an error
 * is shown, so the UI never claims a setting was saved when it was not.
 */
function renderSettings(doc: Document, root: Element, options: { showHeading: boolean }): void {
  root.replaceChildren();

  /** The last value known to be persisted, keyed `siteId:field`. */
  const persisted = new Map<string, boolean>();

  if (options.showHeading) {
    const heading = doc.createElement("h1");
    heading.textContent = "Windowed Fullscreen — Options";
    root.appendChild(heading);
  }

  const status = doc.createElement("div");
  status.setAttribute("data-wfs-status", "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const error = doc.createElement("div");
  error.setAttribute("data-wfs-error", "");
  error.setAttribute("role", "alert");
  error.setAttribute("aria-live", "assertive");

  const showSaved = (message: string): void => {
    status.textContent = message;
    error.textContent = "";
  };
  const showError = (message: string): void => {
    error.textContent = message;
    // A fresh error supersedes a stale confirmation.
    status.textContent = "";
  };

  /**
   * Open a URL in a new focused tab. Used for both the shortcuts page and the
   * donation page because anchor navigation to `chrome://` URLs is blocked, and
   * because it lets us report a failure instead of doing nothing visible.
   */
  const openInTab = async (url: string, description: string): Promise<void> => {
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      if (!tab) showError(`Could not open the ${description}. Please try again later.`);
    } catch {
      showError(`Could not open the ${description}. Please try again later.`);
    }
  };

  /** A `<section>` with an uppercase-styled `<h2>`, the shared shape here. */
  const addSection = (marker: string, title: string): HTMLElement => {
    const section = doc.createElement("section");
    section.setAttribute(marker, "");
    const heading = doc.createElement("h2");
    heading.textContent = title;
    section.appendChild(heading);
    root.appendChild(section);
    return section;
  };

  // --- Keyboard shortcut ---------------------------------------------------
  const shortcutSection = addSection("data-wfs-shortcut-section", "Keyboard shortcut");
  const shortcutLink = doc.createElement("a");
  shortcutLink.href = SHORTCUTS_URL;
  shortcutLink.textContent = "Configure the keyboard shortcut";
  shortcutLink.addEventListener("click", (event) => {
    event.preventDefault();
    void openInTab(SHORTCUTS_URL, "keyboard shortcuts page");
  });
  shortcutSection.appendChild(shortcutLink);

  const shortcutHelp = doc.createElement("p");
  shortcutHelp.textContent =
    "Opens the browser's shortcuts page. A valid combination uses at least one modifier key (Ctrl, Alt, Shift, or Command) plus exactly one other key.";
  shortcutSection.appendChild(shortcutHelp);

  // --- Donation -----------------------------------------------------------
  const donationSection = addSection("data-wfs-donation-section", "Support this extension");
  const donationLink = doc.createElement("a");
  donationLink.href = DONATION_URL;
  donationLink.rel = "noopener noreferrer";
  donationLink.textContent = "Support this extension (donate)";
  donationLink.addEventListener("click", (event) => {
    event.preventDefault();
    void openInTab(DONATION_URL, "donation page");
  });
  donationSection.appendChild(donationLink);

  // --- Per-site toggles ---------------------------------------------------
  for (const { siteId, label } of supportedSites()) {
    const section = addSection("data-wfs-site-section", label);
    section.setAttribute("data-site-id", siteId);

    for (const toggle of SITE_TOGGLES) {
      const text = toggle.text(label);
      const stateKey = `${siteId}:${toggle.field}`;

      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute(toggle.marker, "");
      checkbox.setAttribute("data-site-id", siteId);
      checkbox.setAttribute("aria-label", toggle.aria(label));

      checkbox.addEventListener("change", () => {
        void (async () => {
          const next = checkbox.checked;
          // Only this field is written, so the site's other settings survive.
          const patch: Partial<SitePrefs> = { [toggle.field]: next };
          const result = await setSitePrefs(siteId, patch);
          if (!result.ok) {
            // Nothing was written, so put the control back where it was.
            checkbox.checked = persisted.get(stateKey) ?? DEFAULT_SITE_PREFS[toggle.field];
            showError(`Could not save "${text}" for "${label}": not saved (${result.error}).`);
            return;
          }
          persisted.set(stateKey, next);
          showSaved(`Saved "${text}" for "${label}".`);
        })();
      });

      const wrapper = doc.createElement("label");
      wrapper.appendChild(checkbox);
      wrapper.appendChild(doc.createTextNode(` ${text}`));
      section.appendChild(wrapper);

      if (toggle.hint) {
        const hint = doc.createElement("p");
        hint.textContent = toggle.hint;
        section.appendChild(hint);
      }

      void getSitePrefs(siteId).then(({ prefs, loadFailed }) => {
        const value = prefs[toggle.field];
        persisted.set(stateKey, value);
        checkbox.checked = value;
        if (loadFailed) showError("Could not load preferences; showing defaults.");
      });
    }
  }

  root.appendChild(status);
  root.appendChild(error);

  // Unobtrusive footer link. Inline styles keep it subtle and right-aligned in
  // both the options page and the narrower popup, without extra CSS in either.
  const footer = doc.createElement("div");
  footer.style.cssText = "text-align:right;margin-top:12px;font-size:12px;";
  const privacyLink = doc.createElement("a");
  privacyLink.href = PRIVACY_POLICY_URL;
  privacyLink.target = "_blank";
  privacyLink.rel = "noopener noreferrer";
  privacyLink.textContent = "Privacy policy";
  footer.appendChild(privacyLink);
  root.appendChild(footer);
}

/** Options-page entry point. */
export function startOptionsPage(): void {
  const root = document.getElementById("app");
  if (root) renderSettings(document, root, { showHeading: true });
}

// ===========================================================================
// §12  Popup
// ===========================================================================

/** How long the popup waits for the content script before showing a fallback. */
const POPUP_STATUS_TIMEOUT_MS = 800;

/** What the popup knows about the current tab. */
interface PopupStatus {
  /** Is this a site we support at all, even if this page has no video? */
  siteSupported: boolean;
  /** Can the mode activate on this exact page right now? */
  pageSupported: boolean;
  siteId: string | null;
  /** Is the mode currently on? */
  modeActive: boolean;
  /** Did the content script answer? False when it is not injected. */
  reachable: boolean;
}

/** Derive the popup's view of the world from the tab URL and status reply. */
function derivePopupStatus(url: string | undefined, response: ExtResponse | undefined): PopupStatus {
  const siteAdapter = resolveSiteAdapter(url);
  const pageAdapter = resolveAdapter(url);
  // A missing or failed reply means the content script is not there; report the
  // mode as off rather than guessing.
  const answered = response !== undefined && response.ok;
  return {
    siteSupported: siteAdapter !== null,
    pageSupported: pageAdapter !== null,
    siteId: pageAdapter?.siteId ?? siteAdapter?.siteId ?? null,
    modeActive: answered ? response.active : false,
    reachable: answered,
  };
}

/**
 * The toggle button's label doubles as the status readout: it names the action
 * when it can act, and explains the obstacle when it cannot. Note the split
 * between an unsupported site and a supported site whose page has no video —
 * those need different advice.
 */
function toggleLabel(status: PopupStatus): string {
  if (!status.siteSupported) return "Not available on this site";
  if (!status.pageSupported) return "Open a video to use it";
  if (!status.reachable) return "Reload the page to control it here";
  return status.modeActive ? "Exit windowed fullscreen" : "Enter windowed fullscreen";
}

/** Render the popup's status block and toggle, replacing any prior content. */
function renderPopup(doc: Document, root: HTMLElement, status: PopupStatus, onToggle: () => void): void {
  root.replaceChildren();

  const heading = doc.createElement("h1");
  heading.className = "wfs-popup__title";
  heading.textContent = "Windowed Fullscreen";
  root.appendChild(heading);

  const list = doc.createElement("dl");
  list.className = "wfs-popup__status";
  const term = doc.createElement("dt");
  term.textContent = "Supported site";
  const detail = doc.createElement("dd");
  detail.textContent = status.siteSupported ? `Yes (${status.siteId})` : "No";
  detail.classList.add(status.siteSupported ? "is-on" : "is-off");
  list.append(term, detail);
  root.appendChild(list);

  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "wfs-popup__toggle";
  toggle.textContent = toggleLabel(status);
  const enabled = status.pageSupported && status.reachable;
  toggle.disabled = !enabled;
  toggle.classList.toggle(BUTTON_ACTIVE_CLASS, status.modeActive);
  if (enabled) toggle.addEventListener("click", onToggle);
  root.appendChild(toggle);
}

/**
 * Message the content script directly rather than hopping through the service
 * worker, and race a short timeout so the popup never hangs on a tab that has no
 * content script.
 */
async function askContentScript(
  tabId: number | undefined,
  message: ExtMessage,
): Promise<ExtResponse | undefined> {
  if (tabId == null) return undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message) as Promise<ExtResponse | undefined>,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), POPUP_STATUS_TIMEOUT_MS)),
    ]);
  } catch {
    return undefined;
  }
}

/**
 * Popup entry point. Paints immediately with what it knows, then repaints as the
 * tab lookup and the status round-trip resolve, so the popup is never blank and
 * never blocked on a stalled reply.
 */
export function startPopup(): void {
  const root = document.getElementById("app");
  if (!root) return;

  let tabId: number | undefined;
  let url: string | undefined;
  let response: ExtResponse | undefined;

  const paint = (): void => {
    renderPopup(document, root, derivePopupStatus(url, response), () => {
      void (async () => {
        const toggled = await askContentScript(tabId, { type: "TOGGLE" });
        if (toggled) {
          response = toggled;
          paint();
        }
      })();
    });
  };

  paint();

  // The settings controls load their own values, so render them once up front.
  const settings = document.getElementById("settings");
  if (settings) renderSettings(document, settings, { showHeading: false });

  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab?.id;
    url = tab?.url;
    paint();

    response = await askContentScript(tabId, { type: "GET_STATUS" });
    paint();
  })();
}

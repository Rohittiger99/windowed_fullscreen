/**
 * Windowed Fullscreen — complete extension source.
 *
 * Every surface of the extension lives in this one file. `scripts/build.mjs`
 * bundles it once per Manifest V3 surface, synthesizing a one-line entry point
 * for each and letting esbuild tree-shake away the code that surface does not
 * use:
 *
 *   content script    -> startContentScript()
 *   service worker    -> startServiceWorker()
 *   options page      -> startOptionsPage()
 *   toolbar popup     -> startPopup()
 *   welcome page      -> startWelcomePage()
 *
 * There are no top-level side effects, which is what makes that tree-shaking
 * safe: the popup bundle contains no content-script code, and vice versa.
 *
 * ARCHITECTURE
 * The one rule worth preserving: site-specific DOM knowledge lives ONLY in a
 * site adapter (§3). The controller (§7) and injector (§8) drive the mode using
 * nothing but a `SiteDescriptor`, so supporting another video site means adding
 * one adapter to `ADAPTERS` — no changes anywhere else.
 *
 * The mode never calls the browser Fullscreen API. It expands the player with
 * CSS instead, which is the whole point: the window stays an ordinary maximized
 * window, so the tab strip and taskbar remain visible.
 *
 * INVARIANTS
 * These are load-bearing. Each one is here because breaking it produced a real
 * bug; `AGENTS.md` records the symptom alongside each.
 *
 *  1. No top-level side effects. The five `start*` entry points listed above are
 *     the only way anything runs, which is what makes per-surface tree-shaking
 *     safe.
 *  2. Site selectors and site CSS live only in §3. Nothing in §5–§12 may name a
 *     YouTube element.
 *  3. `enter()` captures a restore record BEFORE its first mutation, and
 *     `exit()` reproduces the pre-entry state exactly, including properties
 *     that were never set.
 *  4. Windowed mode and browser fullscreen are alternatives, never layers.
 *     Exactly one is active at a time; the handoff lives in §9. Leaving
 *     fullscreen retraces the way in: `selectExitDestination` puts the page back
 *     in whatever state it was in when fullscreen began, so the mode and the
 *     panel come back if they were up, and the plain player stays plain.
 *  5. Every retry loop and every contest with the site is bounded, and gives up
 *     with a diagnostic rather than spinning.
 *  6. Nothing leaves the device. No network calls, no `chrome.storage.sync`,
 *     no analytics.
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
 *   §13 Welcome page (post-install)
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
  /**
   * Locate the block holding everything the page shows below the video —
   * channel row, subscribe, like, description, comments — so it can be docked
   * beside the player instead. Null when the site has no such block, or it has
   * not rendered yet, which simply leaves the side panel unavailable.
   */
  findSideContent(doc: Document): Element | null;
  /** Locate the control cluster holding the native fullscreen button. */
  findControlsContainer(doc: Document): Element | null;
  /** Locate the site's own fullscreen button; we inject ours next to it. */
  findNativeFullscreenButton(doc: Document): Element | null;
  /**
   * Controls in the site's own player bar whose result renders outside the player,
   * so they are inert while the mode is on and the mode must stand down before the
   * site handles the click.
   *
   * Returns the elements currently in the document, in no particular order, for
   * the caller to test with `contains` — the same shape as
   * {@link findNativeFullscreenButton}'s hit test, so a click landing on a text
   * node or an SVG path inside one still matches. Resolved per click rather than
   * snapshotted, because the site rebuilds its control bar.
   *
   * Optional: a site with no such control omits it and pays for nothing. An empty
   * array and an absent method mean the same thing.
   */
  findPageDependentControls?(doc: Document): Element[];

  /**
   * Selectors for page chrome hidden on entry, for the mode being entered.
   * Absent ones are tolerated. Scrollable mode deliberately hides less, since
   * the page's own content below the player is the reason to use it.
   */
  getSiteChromeSelectors(mode: WindowedMode): string[];
  /** Classes added to the player while active, removed on exit. */
  getActivePlayerClasses(): string[];
  /**
   * Whether the site strips those classes off the player again, so the core
   * should watch and re-apply them. Sites that leave them alone say false and
   * pay for no observer.
   */
  keepsActivePlayerClasses(): boolean;
  /** Site CSS, scoped under `html.wfs-windowed`, injected once. */
  getActiveModeCss(): string;
  /** Watch for in-page video changes. Returns a disposer. */
  onVideoChange(doc: Document, onChange: () => void): () => void;
  /**
   * Optional site-specific signal that an in-app navigation has finished, so the
   * content script can re-check the URL immediately instead of waiting for its
   * poll. Purely an accelerator: the poll is the guarantee, this is the latency
   * fix, and an adapter that has no such event simply omits it.
   *
   * Distinct from {@link onVideoChange}, which fires for a video swap inside a
   * page the mode still belongs on. This one fires for arriving *and* leaving,
   * including the leave that has to tear the session down.
   *
   * Registered for the lifetime of the content script, not per session, because
   * the interesting case is a page where no session exists yet. Returns a
   * disposer.
   */
  onNavigationHint?(doc: Document, onHint: () => void): () => void;
}

/** What an adapter resolves to at one moment in time. */
export interface SiteDescriptor {
  player: Element;
  nativeFullscreenButton: Element;
  /**
   * Whether the site currently has a below-video block for the side panel to
   * dock. False only disables the panel; the mode itself does not depend on it.
   *
   * A predicate, not an element, and the one field here that is deliberately not
   * a snapshot. The block mounts LATER than the player does — several seconds
   * later on YouTube — so a value captured at entry says "nothing to dock" for
   * the rest of the session on any page where the mode went on early. Auto-apply
   * on a reload is exactly that page, and it left the comment button injected but
   * permanently inert. Resolved on demand instead, so the answer is whatever is
   * true at the moment the reader presses the button.
   */
  hasSideContent: () => boolean;
  /** Chrome elements that resolved; may be empty. */
  siteChromeElements: Element[];
  /** Selectors that matched nothing, recorded for diagnostics. */
  missingChromeSelectors: string[];
  /** Classes to add to the player while active. */
  activePlayerClasses: string[];
  /** Whether those classes need re-applying when the site strips them. */
  keepPlayerClasses: boolean;
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

/**
 * What the extension recorded about an exit from browser fullscreen that it
 * asked for itself.
 *
 * Recorded, not inferred. Attributing an exit after the fact — from the event
 * target, the key that was pressed, or how long ago the last click was — is
 * guesswork, and it got the common cases wrong: YouTube's own button and a
 * double-click on the video both arrive as a bare `fullscreenchange` with no
 * usable target. So the only exit we can claim is one we requested, and we say
 * so before requesting it.
 */
export type ExitIntent = "extension-windowed-button" | "extension-panel-button";

/**
 * The classified cause of a fullscreen exit. `site-or-user` is the default and
 * covers everything the extension did not ask for: YouTube's button, a
 * double-click, the `f` key, `Escape`, and the browser's own chrome. It is not a
 * fallback destination — an exit classified this way goes back to whatever was on
 * screen when fullscreen began, which is usually windowed mode.
 */
export type ExitTrigger = ExitIntent | "site-or-user";

/**
 * What the page shows once fullscreen has ended. `normal-player` means the plain
 * page, reached when the mode was not up when fullscreen began.
 */
export type ExitDestination = "normal-player" | "windowed" | "windowed-with-panel";

/**
 * Persisted rating record. One storage key, written whole — never read, merged,
 * and written back, so a rejected write leaves the previous record intact and
 * there is no half-updated state to reason about.
 */
export interface RatingState {
  /** 0 means not chosen. */
  stars: number;
  promptsShown: number;
  /**
   * When the prompt was shown, in ms since epoch; 0 means never.
   *
   * Recorded, not acted on — the same treatment as {@link FirstRunState.welcomeSeen}
   * and for the same reason. It decided the 7-day and 30-day gaps between the
   * second and third asks; there is only one ask now, so nothing reads it. Kept
   * because `promptsShown` and `resolved` can say *that* the question was put but
   * not *when*, and one integer is a cheap way to keep an answerable question
   * answerable.
   */
  lastPromptAt: number;
  resolved: boolean;
}

/** Persisted pin-prompt record. `shown` is what bounds the asking. */
export interface PinPromptState {
  shown: number;
  dismissed: boolean;
}

/**
 * Persisted first-run record. `opened` is the guard the service worker sets
 * before it attempts to open the welcome page; `welcomeSeen` is set by the
 * welcome page once it has rendered.
 *
 * `welcomeSeen` is recorded, not acted on. The page is only ever reached from
 * the install event, so nothing reads the flag to decide whether to show it — it
 * distinguishes an install that saw the welcome from one whose tab never opened,
 * which `opened` alone cannot answer.
 */
export interface FirstRunState {
  opened: boolean;
  welcomeSeen: boolean;
}

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
  playerClassContested: "player-class-contested",
  toggleUnreachable: "toggle-unreachable",
  /** The bounded resume after a fullscreen handoff hit its attempt cap. */
  resumeAbandoned: "resume-abandoned",
  /** The debounced geometry repair hit its attempt cap. Emitted once, on the
   * transition to the cap, not on every subsequent request. */
  geometryRepairAbandoned: "geometry-repair-abandoned",
  /** `exitFullscreen()` threw or rejected after an exit intent was recorded. */
  exitFullscreenRefused: "exit-fullscreen-refused",
  /** Teardown found a snapshotted element the page had detached. One line per
   * `exit()` call carrying the skipped count, not one line per element. */
  restoreSkipped: "restore-skipped",
  /** Opening the welcome page on a fresh install failed. No retry follows: a
   * retry would fire whenever the worker next woke, so the reader would get a
   * welcome tab out of nowhere hours after installing. */
  firstRunOpenFailed: "first-run-open-failed",
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
   * Controls inside YouTube's own player bar whose result renders OUTSIDE the
   * player, so they do nothing at all while the mode is on.
   *
   * The chapter title — "About Amit ›" at the left of the control bar, tooltip
   * "View chapter". Clicking it opens YouTube's Chapters engagement panel, and
   * YouTube mounts that panel in `#secondary`, which is the first entry in
   * {@link chromeAlways} and therefore `display: none` in BOTH modes. So the
   * click was never being swallowed: it landed, YouTube opened the panel, and the
   * panel rendered inside a hidden container behind a player pinned at the top of
   * the stacking order. Nothing appeared and the button looked dead.
   *
   * Hiding `#secondary` is not negotiable — it holds the related-videos rail,
   * which steals the width the player wants — so the fix is the other direction:
   * §9 stands the mode down before YouTube handles the click, and the panel opens
   * on the ordinary page exactly as it would have. See `onPointerCapture`.
   *
   * Both the container and the button inside it are listed so a YouTube markup
   * change that moves the click target between them still matches. Matching is by
   * `contains`, so listing an ancestor covers its descendants.
   *
   * Every entry MUST live inside the player subtree. An entry outside it would
   * match on clicks the mode has nothing to do with and drop the reader out of
   * windowed mode for no reason.
   */
  pageDependentControls: [".ytp-chapter-container", ".ytp-chapter-title"],
  /**
   * The below-video block the side panel docks: title, channel row with
   * subscribe and likes, description, and comments all live inside `#below`.
   *
   * Deliberately has no fallback. The panel is laid out by the CSS below, which
   * names this same element; a JS fallback the stylesheet did not know about
   * would find a panel host it could not style. If YouTube ever renames it, the
   * panel button simply stops appearing, which is a clean way to fail.
   */
  sideContent: "ytd-watch-flexy #below",
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
/* -------------------------------------------------------------------------
   Theme and stacking tokens.

   THEME. Every surface this stylesheet paints used to read YouTube's own
   \`--yt-spec-base-background\` with a dark fallback. That token is not set on
   <html>, so the fallback was ALWAYS what rendered — invisible in dark mode,
   and catastrophic in light mode: the side panel painted #0f0f0f behind
   YouTube's light-theme text, which is also #0f0f0f. Black on black, which is
   why the panel looked like a solid black column. The theme is read from the
   \`dark\` attribute YouTube sets on <html> instead, and both colours are stated
   outright rather than inherited from a token we cannot see.

   STACKING. z-index is a 32-bit signed integer, so 2147483648 is out of range
   and Chrome clamps it to 2147483647. The masthead used that value to sit
   "above" the player; it tied with it instead, and lost on document order —
   #masthead-container precedes #page-manager — so the revealed bar painted
   BEHIND a full-viewport player and could be neither seen nor clicked. Leave
   headroom below the maximum and order the layers explicitly.

   Raising the player above the page also buries everything the page opens OVER
   itself. YouTube's overlay hosts sit in the low thousands — popups at 2202, the
   guide drawer at 2030 — and hang off ytd-app rather than off the element that
   triggered them, so they do not inherit the masthead's layer. Left alone, the
   notifications and account menus opened underneath the side panel. Every such
   host is lifted to --wfs-z-overlay at the end of this stylesheet.
   ------------------------------------------------------------------------- */
html.wfs-windowed {
  /* Light theme (YouTube's default when <html> carries no \`dark\`). */
  --wfs-surface: #ffffff;
  --wfs-edge: rgba(0, 0, 0, 0.14);
  --wfs-scrim: rgba(255, 255, 255, 0.94);

  --wfs-z-player: 2147483630;
  --wfs-z-panel: 2147483634;
  --wfs-z-chrome: 2147483638;
  /* Above the masthead, because that is where YouTube puts its own popups
     relative to it, and because a menu anchored to a masthead button opens
     downward across both the video and the panel. */
  --wfs-z-overlay: 2147483642;
}

html[dark].wfs-windowed {
  --wfs-surface: #0f0f0f;
  --wfs-edge: rgba(255, 255, 255, 0.12);
  --wfs-scrim: rgba(15, 15, 15, 0.92);
}

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
  z-index: var(--wfs-z-player) !important;
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

/* Give the chapter row a pixel of slack, or a third of a pixel wraps it.

   The chapters are a row of LEFT-FLOATED segments. YouTube gives each an
   integer px width in JS, and they sum with their 4px gaps to the bar width it
   last measured — a width it ROUNDS. The rule above sizes the bar from its
   insets instead, so the bar is whatever the player's own width leaves, and
   that is routinely fractional: 26vw of panel off a 1536px viewport leaves a
   1136.65px player and a 1112.65px bar, which YouTube lays out for 1113px. Any
   scaled display produces a fractional viewport and does the same with no panel
   involved.

   A float row that exceeds its container by a third of a pixel does not
   overflow it — it WRAPS. The last chapter drops onto a second row 6px lower,
   which is inside the controls, and paints there as a stray red line under the
   scrubber. Measured slack is routinely under a pixel (0.40, 0.70, 0.74 at
   three window sizes), so whether it wraps comes down to which way YouTube's
   rounding went, which is why it looks intermittent.

   One pixel is enough because the deficit is a rounding remainder, always less
   than one. The segments keep their own widths and stay left-aligned, so the
   extra pixel is empty space past the last one and nothing visible moves.

   \`overflow: hidden\` on the row was the other candidate and is worse: it hides
   the wrapped segment instead of keeping it on the row, so the last chapter
   silently loses its fill. Rounding the bar down with CSS \`round()\` would be
   the direct fix, but it needs Chrome 125 and the manifest supports 116. */
html.wfs-windowed .ytp-chapters-container {
  width: calc(100% + 1px) !important;
}

/* Hide the in-player top overlay (title, channel, share, cards, gradient).
   The bottom control bar stays fully usable.

   .ytp-overlay-top-right is NOT inside .ytp-chrome-top — YouTube parents it to
   .ytp-overlays-container — so hiding the title bar left it behind. It holds
   Copy link and Show cards, and while the player's controls are showing it
   stretches 74px across the whole top of the video: exactly the strip the
   masthead reveals into, and above it in the player's own stacking context.
   Moving the cursor to the top edge is what un-autohides the controls, so this
   overlay appeared precisely when it would swallow the hover and the click that
   followed — the "top bar does nothing" symptom. Both of its buttons exist
   elsewhere (Copy link in the side panel's share row, cards via .ytp-ce-element,
   which is already hidden). */
html.wfs-windowed .ytp-chrome-top,
html.wfs-windowed .ytp-overlay-top-right,
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
   transparent, and reverse both when the controller reports the pointer near
   the top edge by adding .wfs-reveal-chrome to the html element.

   That proximity is tracked in JS rather than with a CSS hover zone on purpose.
   A transparent trigger element covering the top strip has to accept pointer
   events to detect the hover, and anything that accepts pointer events also
   swallows clicks meant for what is underneath — which on a watch page is the
   top of YouTube's guide drawer, i.e. Home and Shorts. There is no CSS state
   that both senses the cursor and lets clicks through.
   ------------------------------------------------------------------------- */
html.wfs-windowed #masthead-container {
  /* The hidden/revealed state lives in these three custom properties, not in a
     second rule that re-declares the same properties.

     It used to: a base rule set transform/opacity/pointer-events !important and
     a more specific rule set them again !important. On paper the specific one
     wins; in practice that only held intermittently, and when it lost the bar
     stayed parked off-screen with pointer-events already switched on — the
     "hover the top edge and nothing happens, then it sticks" symptom. Swapping a
     custom property leaves exactly ONE transform declaration on the element, so
     there is no contest to lose. It also lets the reduced-motion override below
     take effect: re-declaring \`transition\` in the reveal rule silently beat it
     on class count. */
  --wfs-chrome-shift: -100%;
  --wfs-chrome-opacity: 0;
  --wfs-chrome-events: none;
  --wfs-chrome-scrim: transparent;

  /* Leaving. Slower than arriving, because a bar that snaps away reads as a
     glitch while one that eases away reads as intent — and 140ms of delay means
     drifting a few pixels past the band does not yank it off the screen. The
     curve is a symmetric ease-in-out: it starts moving gently instead of
     departing at full speed. */
  --wfs-chrome-duration: 320ms;
  --wfs-chrome-delay: 140ms;
  --wfs-chrome-ease: cubic-bezier(0.33, 0, 0.67, 1);

  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  z-index: var(--wfs-z-chrome) !important;
  transform: translateY(var(--wfs-chrome-shift)) !important;
  opacity: var(--wfs-chrome-opacity) !important;
  pointer-events: var(--wfs-chrome-events) !important;
  /* Both animated properties are compositor-friendly, and the element already
     carries a transform in every state, so promoting it costs nothing new — it
     is already a stacking context and a containing block for fixed descendants.
     Worth it here because the bar animates over playing video. */
  will-change: transform, opacity !important;
  /* Declared exactly once, with the timing arriving through the custom
     properties above. Re-declaring it in the revealed rule would give the
     cascade a second transition to arbitrate, and that is how the
     prefers-reduced-motion override below got silently outranked before. */
  transition:
    transform var(--wfs-chrome-duration) var(--wfs-chrome-ease) var(--wfs-chrome-delay),
    opacity var(--wfs-chrome-duration) var(--wfs-chrome-ease) var(--wfs-chrome-delay) !important;
}

/* Revealed. .wfs-reveal-chrome is the controller's pointer-proximity signal;
   :hover keeps the bar out while the cursor is on it even if a pointermove is
   missed (an iframe under the cursor, say), and :focus-within covers tabbing in
   from the keyboard. Nothing here overlays the page, so the guide drawer's
   links stay clickable at every point in the transition.

   Arriving is quicker than leaving and starts immediately: the cursor is already
   travelling toward the bar, so any delay reads as lag. A decelerating curve
   lands it rather than stopping it dead. Browsers take transition timing from
   the state being transitioned TO, which is what makes one declaration above
   produce two different feels. */
html.wfs-windowed.wfs-reveal-chrome #masthead-container,
html.wfs-windowed #masthead-container:hover,
html.wfs-windowed #masthead-container:focus-within {
  --wfs-chrome-shift: 0%;
  --wfs-chrome-opacity: 1;
  --wfs-chrome-events: auto;
  --wfs-chrome-scrim: var(--wfs-scrim);

  --wfs-chrome-duration: 240ms;
  --wfs-chrome-delay: 0ms;
  --wfs-chrome-ease: cubic-bezier(0.16, 1, 0.3, 1);
}

/* The masthead itself must be visible and clickable once the container reveals. */
html.wfs-windowed #masthead {
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* A scrim behind the masthead so it reads over bright video. It has to follow
   the site's theme, not the video: a dark scrim under light-theme YouTube puts
   near-black search text and icons on a near-black bar.

   Driven by the same --wfs-chrome-scrim-alpha the reveal rule switches, rather
   than by a second copy of that three-selector list, so the scrim fades in step
   with the bar instead of appearing fully formed the instant the class lands. */
html.wfs-windowed #masthead-container #masthead {
  background: var(--wfs-chrome-scrim) !important;
  transition: background-color var(--wfs-chrome-duration) var(--wfs-chrome-ease) var(--wfs-chrome-delay) !important;
}

/* Reduced motion: drop the travel, keep the cross-fade. Removing the animation
   outright is the obvious reading of the preference and it is the wrong one here
   — the bar then pops in and out, which is the exact jarring transition the
   preference exists to avoid. Fading in place is the accepted substitute: no
   movement, still a transition. Setting the shift to 0% in BOTH states is what
   removes the travel, and this rule wins because it repeats the base selector
   later in the sheet. */
@media (prefers-reduced-motion: reduce) {
  html.wfs-windowed #masthead-container {
    --wfs-chrome-shift: 0%;
    transition: opacity var(--wfs-chrome-duration) var(--wfs-chrome-ease) var(--wfs-chrome-delay) !important;
  }
}

/* Cover mode also hides the page's own content: nothing below the player is
   reachable while the player owns the viewport, so leaving it rendered only
   risks it showing through. Scrollable mode keeps all of it — that is the
   entire feature. The side panel is the third case: it puts this same content
   beside the video, so when it is open cover mode must stop hiding it. */
html.wfs-windowed:not(.wfs-scrollable):not(.wfs-side-panel) ytd-watch-metadata,
html.wfs-windowed:not(.wfs-scrollable):not(.wfs-side-panel) #above-the-fold,
html.wfs-windowed:not(.wfs-scrollable):not(.wfs-side-panel) #comments {
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
   metadata and comments inside stay in a centred column.

   The side panel needs the same release for the opposite reason: that column is
   far wider than the panel, so left alone the text would overflow it. One list
   serves both via :is(), whose specificity is that of a single class either
   way. */
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) ytd-watch-flexy #below > *,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) ytd-watch-metadata,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) #above-the-fold,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) #bottom-row,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) #description,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) #comments,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) #comments > #sections,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) ytd-comments,
html.wfs-windowed:is(.wfs-scrollable, .wfs-side-panel) ytd-item-section-renderer#sections {
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}

/* -------------------------------------------------------------------------
   Side panel.

   The comment button docks everything that normally sits below the video —
   channel row, subscribe, like, description, comments — into a column beside
   the player, in both modes. Beside, never above: the panel takes width away
   from the video rather than overlaying it, so nothing covers the picture.

   The panel IS the page's own #below element, positioned rather than moved.
   Re-parenting it into the player would be the other way to do this, and it is
   the reason live-stream chat is out of scope for now: #chat lives in a
   different container (#secondary). Leaving #below where YouTube put it means
   Polymer keeps owning it — the like button, subscribe, comment sorting, and
   lazy comment continuations all keep working, and exit needs to undo nothing
   but a class.

   position: fixed rather than a flex column next to the player, because in
   cover mode the player is itself fixed to the viewport, and because
   #primary-inner has other children (merch shelves, donation shelves) that
   would join a flex row uninvited.
   ------------------------------------------------------------------------- */
html.wfs-windowed.wfs-side-panel {
  /* Wide enough for a comment thread, capped so the video keeps the stage. This
     is a border-box width: the panel's own padding comes out of it, which is
     what keeps it flush with the space the player gives back. */
  --wfs-panel-width: clamp(320px, 26vw, 440px);
  --wfs-panel-pad: 16px;
}

/* Browser fullscreen belongs to YouTube: it sets display:none on #columns, the
   two-column container the panel lives inside, so the panel cannot render there
   at all — and YouTube ships its own fullscreen comments drawer anyway.

   The mode stands down completely when fullscreen begins, which is a JS job
   (§9) since it has inline styles to restore. This rule covers the few frames
   before that runs: the site measures its fullscreen layout during exactly that
   window, and a player still holding a panel-sized gap is how it ends up
   picking its smallest control bar. Reserving no width keeps that measurement
   honest. Matches whether the site fullscreens the document element (YouTube
   does today) or an element inside it. */
html.wfs-windowed.wfs-side-panel:is(:fullscreen, :has(:fullscreen)) {
  --wfs-panel-width: 0px;
  /* Padding too, or a zero-width panel is still a padding-wide strip. */
  --wfs-panel-pad: 0px;
}

/* Cover mode: the player is already fixed, so the panel's width is given back on
   the right edge and the two insets size it.

   Deliberately NOT width: calc(100vw - var(--wfs-panel-width)). 100vw includes
   the vertical scrollbar; the panel is positioned against the viewport's inner
   edge, which excludes it. Whenever the page had a scrollbar the two disagreed
   by exactly its width, and the panel sat on top of the right end of the control
   bar. Sizing from left/right instead means both boxes are measured against the
   same edge, so they cannot drift apart. */
html.wfs-windowed.wfs-side-panel:not(.wfs-scrollable) #movie_player,
html.wfs-windowed.wfs-side-panel:not(.wfs-scrollable) .html5-video-player {
  left: 0 !important;
  right: var(--wfs-panel-width) !important;
  width: auto !important;
  max-width: none !important;
}

/* Scrollable mode: the player is a block in normal flow, so it is narrowed
   instead. Percentages, not vw — this mode keeps a vertical scrollbar. */
html.wfs-windowed.wfs-side-panel.wfs-scrollable #movie_player,
html.wfs-windowed.wfs-side-panel.wfs-scrollable .html5-video-player {
  width: calc(100% - var(--wfs-panel-width)) !important;
  max-width: calc(100% - var(--wfs-panel-width)) !important;
}

/* The dock itself. Both modes get identical geometry; the selector is written
   twice so it outranks the scrollable-mode rules for #below regardless of the
   order they appear in. */
html.wfs-windowed.wfs-side-panel:not(.wfs-scrollable) ytd-watch-flexy #below,
html.wfs-windowed.wfs-side-panel.wfs-scrollable ytd-watch-flexy #below {
  display: block !important;
  /* #below is content-box on YouTube, so without this the padding is ADDED to
     the width and the panel ends up 32px wider than the strip the player gave
     back — overhanging the video and swallowing the right end of the control
     bar, which is where the fullscreen and extension buttons live. */
  box-sizing: border-box !important;
  position: fixed !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  left: auto !important;
  width: var(--wfs-panel-width) !important;
  min-width: 0 !important;
  max-width: var(--wfs-panel-width) !important;
  height: auto !important;
  margin: 0 !important;
  padding: var(--wfs-panel-pad) var(--wfs-panel-pad) 96px !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
  /* Keep a flick at the end of the comment list from scrolling the page. */
  overscroll-behavior: contain !important;
  /* Above the player, below the masthead — see the stacking note at the top. */
  z-index: var(--wfs-z-panel) !important;
  /* Opaque, or the video shows through the comments. Theme-derived: see the
     theme note at the top of this stylesheet for why this is not read from
     YouTube's own token. */
  background: var(--wfs-surface) !important;
  box-shadow: -1px 0 0 0 var(--wfs-edge) !important;
}

/* Cover mode hides #comments with an inline style, and the metadata block is
   hidden by the rule above; both have to come back for the panel. */
html.wfs-windowed.wfs-side-panel ytd-watch-metadata,
html.wfs-windowed.wfs-side-panel #above-the-fold,
html.wfs-windowed.wfs-side-panel #comments {
  display: block !important;
  visibility: visible !important;
}

/* A fixed element anchors to the nearest ancestor with a transform, filter, or
   paint containment rather than to the viewport. YouTube sets none of these
   today, but the panel silently landing in the wrong place is a bad failure, so
   the chain between <html> and #below is neutralised. */
html.wfs-windowed.wfs-side-panel ytd-app,
html.wfs-windowed.wfs-side-panel #content,
html.wfs-windowed.wfs-side-panel #page-manager,
html.wfs-windowed.wfs-side-panel ytd-watch-flexy,
html.wfs-windowed.wfs-side-panel ytd-watch-flexy #columns,
html.wfs-windowed.wfs-side-panel ytd-watch-flexy #primary,
html.wfs-windowed.wfs-side-panel ytd-watch-flexy #primary-inner {
  transform: none !important;
  filter: none !important;
  perspective: none !important;
  contain: none !important;
  content-visibility: visible !important;
}

/* The comment box's own sticky header would otherwise stick to the viewport
   top, behind the masthead, instead of to the panel. */
html.wfs-windowed.wfs-side-panel #comments #header {
  position: static !important;
}

/* The masthead reveals over the top of the panel on hover, the same way it
   reveals over the top of the video. Nudging the panel's padding to compensate
   would shift the text mid-read, so it does not: the bar is transient, and the
   panel scrolls under it. */

/* -------------------------------------------------------------------------
   Page-level overlay hosts.

   Anything YouTube opens over its own page — the notifications and account
   menus, a comment's overflow menu, the share dialog, a "Saved to Watch later"
   toast — is not rendered inside the thing that triggered it. It is appended to
   a host hanging off ytd-app, at a z-index in the low thousands, which is far
   below the layer the expanded player occupies. So the menus opened *underneath*
   the video and the side panel: visible as a sliver past the panel's left edge
   and otherwise unusable.

   Raising the host rather than the popup is deliberate. These hosts hold every
   popup YouTube has, including ones that do not exist yet, and giving the host a
   z-index makes it a stacking context so the popups keep their existing order
   relative to each other. A z-index alone does not create a containing block, so
   the position:fixed popups inside still anchor to the viewport.

   Search suggestions are absent from this list on purpose: they render inside
   yt-searchbox, which is inside #masthead-container, so they already ride the
   masthead's layer.
   ------------------------------------------------------------------------- */
html.wfs-windowed ytd-popup-container,
html.wfs-windowed snackbar-container {
  z-index: var(--wfs-z-overlay) !important;
}

/* The guide drawer, and ONLY while it is open. It is position:fixed across the
   whole viewport even when closed, so raising it unconditionally would park an
   invisible full-window element above the video and swallow every click on it —
   the same mistake the masthead hover zone made. The [opened] attribute is
   YouTube's own signal, so the drawer drops back to its normal layer the moment
   it starts closing. */
html.wfs-windowed tp-yt-app-drawer#guide[opened] {
  z-index: var(--wfs-z-overlay) !important;
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

  findSideContent(doc) {
    return doc.querySelector(YT.sideContent);
  },

  findControlsContainer(doc) {
    return doc.querySelector(YT.controls);
  },

  findNativeFullscreenButton(doc) {
    return doc.querySelector(YT.nativeFullscreen);
  },

  findPageDependentControls(doc) {
    // Flattened across the selector list, duplicates and all: the caller only asks
    // whether any of them contains the click target, so a container and the button
    // inside it both matching costs one extra `contains` and removes the need to
    // reason about which selector YouTube's markup puts the target under today.
    const found: Element[] = [];
    for (const selector of YT.pageDependentControls) {
      found.push(...Array.from(doc.querySelectorAll(selector)));
    }
    return found;
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

  /**
   * YouTube removes `ytp-big-mode` again whenever it recomputes its own player
   * layout — reliably on entering or leaving native fullscreen, and whenever it
   * decides the player is not fullscreen-sized (which, once the side panel has
   * narrowed it, it is not). Losing the class shrinks the control bar from 72px
   * to 59px, the buttons from 48px to 40px, and the timestamp from 16px to 14px
   * mid-session, so the core re-applies it.
   */
  keepsActivePlayerClasses() {
    return true;
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

  /**
   * YouTube fires `yt-navigate-finish` when an SPA navigation completes.
   *
   * Worth listening to on top of the content script's href poll for two reasons.
   * The event can land before the change is visible in `location.href`, because
   * the history entry is committed inside the event. And the poll only runs once
   * a second, so on a watch -> home move the masthead would stay hidden for up to
   * that long — the class teardown is what returns it, and the teardown cannot
   * happen until something notices the URL changed.
   *
   * This lived in §9 until it was moved here. It was the one place outside this
   * section that named a YouTube-specific event, which is exactly the leak the
   * adapter boundary exists to prevent.
   */
  onNavigationHint(doc, onHint) {
    doc.addEventListener("yt-navigate-finish", onHint);
    return () => doc.removeEventListener("yt-navigate-finish", onHint);
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

/**
 * Subscribe to every registered adapter's navigation hint at once, so the content
 * script can react to an in-app navigation without naming a single site event.
 *
 * Registered for the whole content-script lifetime rather than per session: the
 * case that matters most is a page with no session on it yet, where there is no
 * adapter to ask. Adapters without a hint contribute nothing. Returns one
 * disposer for the lot.
 */
export function observeNavigationHints(doc: Document, onHint: () => void): () => void {
  const disposers = ADAPTERS.map((adapter) => adapter.onNavigationHint?.(doc, onHint)).filter(
    (dispose): dispose is () => void => typeof dispose === "function",
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
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

// --- Rating, usage, first-run, and pin-prompt records ----------------------
//
// Five more top-level keys in the same local area, deliberately beside
// `site:<siteId>` rather than inside it. A preferences record written by the
// shipped version has to keep reading back unchanged, and `normalizeSitePrefs`
// treats a record it does not recognise as damaged — so hiding a rating field in
// there would turn every upgraded install into a reported load failure.

/** Star choice, how often we have asked, when, and whether it is settled. */
export const RATING_KEY = "rating";

/** Count of windowed-mode sessions long enough to count as real use. */
export const USAGE_KEY = "usage";

/** Wall-clock install time. Written once, never rewritten. */
export const INSTALL_KEY = "installedAt";

/** First-run guard, plus whether the welcome page has been seen. */
export const FIRST_RUN_KEY = "firstRun";

/** Pin-prompt showings and dismissal. */
export const PIN_PROMPT_KEY = "pinPrompt";

/**
 * A windowed-mode session has to last this long to count as one use.
 *
 * 60 s, because the counter exists to answer "has this person actually watched
 * something in the mode?" before the extension asks for a rating. A mis-click
 * that is undone immediately, or a toggle while hunting for the right control,
 * takes a couple of seconds; a minute of continuous viewing is a deliberate use.
 */
export const MIN_SESSION_FOR_USAGE_MS = 60_000;

/**
 * The usage count saturates here rather than growing without bound.
 *
 * 1,000,000 is far past every gate that reads it (the rating scheduler needs
 * 1), so the cap costs nothing in behaviour and keeps the stored number a small
 * integer no matter how long the extension stays installed.
 */
export const USAGE_COUNTER_MAX = 1_000_000;

/**
 * Lifetime cap on rating prompts. **One.** Asked once, then never again, whatever
 * the answer was and whether or not there was one.
 *
 * It was three, spread over a 7-day and a 30-day interval. That schedule only made
 * sense while the prompt had no answer to give: it said "Enjoying it?" and offered
 * "Maybe later" and "Don't ask again", so it had to come back, because it had never
 * actually asked anything. Now it offers both real answers on the one showing —
 * rate it, or say what is wrong — so there is nothing left to come back for. A
 * second ask after a real answer is just nagging.
 *
 * "Once" means once ANSWERED, not once rendered. `renderRatingPrompt` used to set
 * `resolved` on MOUNT, which spent the single lifetime ask on a popup the reader
 * opened to flip a checkbox: the prompt was gone on the next opening and the
 * question had never been put to anybody. It now records only when one of its three
 * controls is used, so the ask survives closing the popup and keeps its place until
 * there is an answer to store. Every stored count is still clamped to this bound, so
 * lowering it further needs no migration.
 *
 * Declared here rather than beside the other rating constants in §11 because the
 * coercion below is what enforces the range, and a bound that lives away from
 * its check drifts.
 */
export const MAX_RATING_PROMPTS = 1;

/**
 * Lifetime cap on pin-prompt showings. Two: one for the opening that follows the
 * install, one for a later opening in case the first arrived at a bad moment.
 * Declared here for the same reason as {@link MAX_RATING_PROMPTS}.
 */
export const MAX_PIN_PROMPTS = 2;

/**
 * How many stars the rating control offers, and therefore the largest value the
 * stored `stars` field may hold.
 *
 * Declared beside the coercion that clamps to it, for the same reason as
 * {@link MAX_RATING_PROMPTS}. It reads as an obvious five everywhere it is used,
 * which is exactly why it was previously written as a bare `5` in four places and
 * a bare `4` in a fifth (the zero-based index of the last star) — one of which
 * would have been missed by anyone changing the scale.
 */
export const MAX_STARS = 5;

/** Documented defaults for a rating record with nothing stored. */
export const DEFAULT_RATING_STATE: RatingState = {
  stars: 0,
  promptsShown: 0,
  lastPromptAt: 0,
  resolved: false,
};

/** Documented defaults for a first-run record with nothing stored. */
export const DEFAULT_FIRST_RUN_STATE: FirstRunState = { opened: false, welcomeSeen: false };

/** Documented defaults for a pin-prompt record with nothing stored. */
export const DEFAULT_PIN_PROMPT_STATE: PinPromptState = { shown: 0, dismissed: false };

/** True for a whole number in `[0, max]`, which is the shape every count uses. */
function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * Coerce a stored rating record, field by field.
 *
 * Always returns a record, unlike `normalizeSitePrefs`, which returns null for a
 * damaged value so the caller can report a load failure. There is no equivalent
 * "this cannot be a rating at all" signal here: an absent record is the ordinary
 * first-run case, and the defaults are exactly what a first run should see.
 */
export function normalizeRatingState(stored: unknown): RatingState {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_RATING_STATE };
  }
  const raw = stored as Record<string, unknown>;
  return {
    stars: isCount(raw.stars, MAX_STARS) ? raw.stars : DEFAULT_RATING_STATE.stars,
    promptsShown: isCount(raw.promptsShown, MAX_RATING_PROMPTS)
      ? raw.promptsShown
      : DEFAULT_RATING_STATE.promptsShown,
    lastPromptAt: isCount(raw.lastPromptAt, Number.MAX_SAFE_INTEGER)
      ? raw.lastPromptAt
      : DEFAULT_RATING_STATE.lastPromptAt,
    resolved: typeof raw.resolved === "boolean" ? raw.resolved : DEFAULT_RATING_STATE.resolved,
  };
}

/** Coerce a stored usage count. Anything unreadable reads as no use yet. */
export function normalizeUsageCounter(stored: unknown): number {
  return isCount(stored, USAGE_COUNTER_MAX) ? stored : 0;
}

/**
 * Coerce a stored install time, returning null for anything unreadable.
 *
 * Null, never 0. Zero is a valid instant (1970), and the rating scheduler
 * measures "long enough since install" against this value — so an unreadable
 * time coerced to 0 would read as installed half a century ago and make the
 * extension instantly eligible to ask for a rating.
 */
export function normalizeInstallTimestamp(stored: unknown): number | null {
  return isCount(stored, Number.MAX_SAFE_INTEGER) ? stored : null;
}

/** Coerce a stored first-run record, field by field. */
export function normalizeFirstRunState(stored: unknown): FirstRunState {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_FIRST_RUN_STATE };
  }
  const raw = stored as Record<string, unknown>;
  return {
    opened: typeof raw.opened === "boolean" ? raw.opened : DEFAULT_FIRST_RUN_STATE.opened,
    welcomeSeen:
      typeof raw.welcomeSeen === "boolean" ? raw.welcomeSeen : DEFAULT_FIRST_RUN_STATE.welcomeSeen,
  };
}

/** Coerce a stored pin-prompt record, field by field. */
export function normalizePinPromptState(stored: unknown): PinPromptState {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_PIN_PROMPT_STATE };
  }
  const raw = stored as Record<string, unknown>;
  return {
    shown: isCount(raw.shown, MAX_PIN_PROMPTS) ? raw.shown : DEFAULT_PIN_PROMPT_STATE.shown,
    dismissed:
      typeof raw.dismissed === "boolean" ? raw.dismissed : DEFAULT_PIN_PROMPT_STATE.dismissed,
  };
}

/** Read one top-level key, or undefined when storage is missing or throws. */
async function readKey(key: string): Promise<unknown> {
  const area = storageArea();
  if (!area) return undefined;
  try {
    return (await area.get(key))?.[key];
  } catch {
    return undefined;
  }
}

/** Write one top-level key whole, reporting a rejection rather than throwing. */
async function writeKey(
  key: string,
  value: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const area = storageArea();
  if (!area) return { ok: false, error: "storage unavailable" };
  try {
    await area.set({ [key]: value });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Read the rating record.
 *
 * @returns the effective record, plus whether storage failed to answer. The flag
 *   drives the error region in the settings UI: a store that answers nothing has
 *   to render unfilled stars *and* say the choice cannot be saved, which is a
 *   different message from a first run that legitimately has no stars yet.
 */
export async function getRatingState(): Promise<{ state: RatingState; loadFailed: boolean }> {
  const area = storageArea();
  if (!area) return { state: { ...DEFAULT_RATING_STATE }, loadFailed: true };
  try {
    const stored = (await area.get(RATING_KEY))?.[RATING_KEY];
    // Nothing stored is a first run, not a failure.
    if (stored === undefined) return { state: { ...DEFAULT_RATING_STATE }, loadFailed: false };
    return { state: normalizeRatingState(stored), loadFailed: false };
  } catch {
    return { state: { ...DEFAULT_RATING_STATE }, loadFailed: true };
  }
}

/**
 * Persist the whole rating record in one write.
 *
 * The deliberate opposite of `setSitePrefs`, which reads and merges. Both
 * surfaces can be open at once, and every write here comes from one control that
 * knows the complete record it wants stored; merging would let the later write
 * inherit a field from the earlier one and produce a record that neither surface
 * ever asked for. Whole-record writes make the later write simply win.
 */
export async function setRatingState(
  next: RatingState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return writeKey(RATING_KEY, { ...next });
}

/**
 * Call `onChange` whenever the rating record is written from another surface, so
 * the popup and the options page stay in step without a reload. Returns a
 * disposer, matching `watchSitePrefs`.
 */
export function watchRatingState(onChange: (state: RatingState) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return () => {};
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !(RATING_KEY in changes)) return;
    onChange(normalizeRatingState(changes[RATING_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Read the usage count. An unavailable or unreadable store reads as 0, with no
 * failure flag: the only consumer is the rating scheduler, whose floor is 1, so
 * a failed read already lands on "not eligible" — the safe answer.
 */
export async function getUsageCounter(): Promise<number> {
  return normalizeUsageCounter(await readKey(USAGE_KEY));
}

/** A session counts as one use only once it has run for long enough (R9.1, R9.18). */
export function countsAsUsage(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= MIN_SESSION_FOR_USAGE_MS;
}

/**
 * One more use, saturating at {@link USAGE_COUNTER_MAX}.
 *
 * An unreadable current value counts as 0, and one already above the cap is
 * pulled down to it rather than back to 0: losing a count is better than losing
 * the whole history to a single damaged read.
 */
export function nextUsageCount(current: number): number {
  const base = Number.isFinite(current)
    ? Math.min(Math.max(Math.floor(current), 0), USAGE_COUNTER_MAX)
    : 0;
  return Math.min(base + 1, USAGE_COUNTER_MAX);
}

/**
 * Count a finished windowed-mode session, if it lasted long enough.
 *
 * Fire and forget: this runs on the teardown path inside the page, where a
 * rejected write must be a dropped count and never a thrown error.
 *
 * @returns whether the count was incremented and stored.
 */
export async function recordQualifyingUsage(durationMs: number): Promise<boolean> {
  if (!countsAsUsage(durationMs)) return false;
  const next = nextUsageCount(await getUsageCounter());
  return (await writeKey(USAGE_KEY, next)).ok;
}

/** Read the install time, or null when it was never recorded or is unreadable. */
export async function getInstallTimestamp(): Promise<number | null> {
  return normalizeInstallTimestamp(await readKey(INSTALL_KEY));
}

/**
 * Record the install time, but only if it is not already recorded.
 *
 * The guard is the point: `onInstalled` fires for updates too, and a worker can
 * start at any time, so an unconditional write would keep moving the install
 * time forward and the rating gates would never mature.
 *
 * @returns whether a value was written.
 */
export async function setInstallTimestampOnce(now: number): Promise<boolean> {
  if ((await getInstallTimestamp()) !== null) return false;
  if (!Number.isFinite(now) || now < 0) return false;
  return (await writeKey(INSTALL_KEY, Math.floor(now))).ok;
}

/** Read the first-run record, plus whether storage failed to answer. */
export async function getFirstRunState(): Promise<{
  state: FirstRunState;
  loadFailed: boolean;
}> {
  const area = storageArea();
  if (!area) return { state: { ...DEFAULT_FIRST_RUN_STATE }, loadFailed: true };
  try {
    const stored = (await area.get(FIRST_RUN_KEY))?.[FIRST_RUN_KEY];
    if (stored === undefined) return { state: { ...DEFAULT_FIRST_RUN_STATE }, loadFailed: false };
    return { state: normalizeFirstRunState(stored), loadFailed: false };
  } catch {
    return { state: { ...DEFAULT_FIRST_RUN_STATE }, loadFailed: true };
  }
}

/** Persist the whole first-run record in one write, like {@link setRatingState}. */
export async function setFirstRunState(
  next: FirstRunState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return writeKey(FIRST_RUN_KEY, { ...next });
}

/** Read the pin-prompt record, plus whether storage failed to answer. */
export async function getPinPromptState(): Promise<{
  state: PinPromptState;
  loadFailed: boolean;
}> {
  const area = storageArea();
  if (!area) return { state: { ...DEFAULT_PIN_PROMPT_STATE }, loadFailed: true };
  try {
    const stored = (await area.get(PIN_PROMPT_KEY))?.[PIN_PROMPT_KEY];
    if (stored === undefined) return { state: { ...DEFAULT_PIN_PROMPT_STATE }, loadFailed: false };
    return { state: normalizePinPromptState(stored), loadFailed: false };
  } catch {
    return { state: { ...DEFAULT_PIN_PROMPT_STATE }, loadFailed: true };
  }
}

/**
 * Persist the whole pin-prompt record in one write.
 *
 * A rejection has to be reported rather than swallowed: the stored showing count
 * is the only thing bounding how often the prompt appears, so quietly losing a
 * write is how a two-showing cap becomes unbounded.
 */
export async function setPinPromptState(
  next: PinPromptState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return writeKey(PIN_PROMPT_KEY, { ...next });
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

/**
 * Added to `<html>` while the pointer sits near the top edge of the viewport, so
 * an adapter can reveal the site's top chrome (on YouTube, the masthead) without
 * the extension knowing what that chrome is.
 *
 * Tracked in JS because the CSS alternative — a transparent hover zone laid over
 * the top strip — must accept pointer events to sense the cursor, and therefore
 * eats clicks aimed at whatever is beneath it.
 */
const REVEAL_CLASS = "wfs-reveal-chrome";

/**
 * Reveal below this many CSS px from the top, hide past
 * {@link REVEAL_HIDE_ZONE_PX}. The gap is hysteresis: a single threshold makes
 * the bar flutter when the cursor rests on the boundary. The hide band is deep
 * enough to clear a revealed masthead, so travelling from the top edge into the
 * page never re-triggers.
 */
const REVEAL_ZONE_PX = 80;
const REVEAL_HIDE_ZONE_PX = 120;

/**
 * Added to `<html>` while the side panel is docked, so the adapter's stylesheet
 * narrows the player and positions the site's below-video content beside it.
 *
 * Only ever set while the mode is active: the panel layout is expressed entirely
 * in rules nested under {@link WINDOWED_CLASS}.
 */
const PANEL_CLASS = "wfs-side-panel";

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

/**
 * Stacking value for the expanded player: high enough to clear any page chrome,
 * with headroom left above it for the layers an adapter puts on top (on YouTube,
 * the side panel and the revealed masthead).
 *
 * Deliberately not 2147483647. z-index is a 32-bit signed integer, so nothing
 * can sit above the maximum: a rule asking for 2147483648 is clamped back to the
 * same value and then loses on document order. Matches `--wfs-z-player` in the
 * YouTube stylesheet (§3), which applies to the same element — and sits below
 * the layers that stylesheet reserves for the panel, the site's top chrome, and
 * the site's own popups.
 */
const PLAYER_Z_INDEX = "2147483630";

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
 *
 * The 1200ms tail is for the side panel: docking it mounts the comment list,
 * which the site hydrates well after the width change, and it relayouts the
 * player again when it does.
 */
const REFLOW_NUDGE_DELAYS_MS = [0, 60, 250, 600, 1200] as const;

/**
 * How many times one session will re-apply a player class the site removed.
 * Generous enough for the handful of removals a real session produces (each
 * fullscreen transition costs one), small enough that a site determined to strip
 * them cannot be fought indefinitely.
 */
const MAX_CLASS_REASSERTIONS = 50;

/**
 * How long the player's class attribute must be quiet before the mode asks the
 * site to re-measure.
 *
 * The debounce is not politeness, it is what stops a runaway. The site strips
 * these classes in bursts while it relayouts, and the nudge that repairs the
 * geometry is itself a resize the site answers by relayouting again — which can
 * strip the class again. Nudging per strip turned one disagreement into a contest
 * that burned {@link MAX_CLASS_REASSERTIONS} in a few seconds and then gave up,
 * leaving the small control bar. Waiting for quiet collapses a burst into one
 * repair.
 */
const GEOMETRY_REPAIR_DEBOUNCE_MS = 400;

/**
 * How many re-measures one session will ask for after a class contest. Each is a
 * real fix for a real stale layout, but since a nudge can provoke the next strip
 * this is bounded like every other loop here. Four covers the handful of
 * transitions a session actually produces.
 */
const MAX_GEOMETRY_REPAIRS = 4;

/**
 * Inline player properties the controller mutates. Kebab-case so
 * `getPropertyValue` and `setProperty` agree.
 */
const PLAYER_STYLE_PROPS = [
  "position",
  // `inset` comes BEFORE its four longhands, and the order is load-bearing.
  // `restoreStyle` walks this list in order, and removing the `inset` shorthand
  // also removes `top`/`right`/`bottom`/`left`. With `inset` last, restoring a
  // player that had inline longhands but no inline `inset` put the longhands
  // back and then immediately removed them again. Shorthand first, longhands
  // second — the same order a stylesheet would need.
  "inset",
  "top",
  "right",
  "bottom",
  "left",
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
    "z-index": PLAYER_Z_INDEX,
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
  private panelButton: Element | null = null;
  /**
   * Whether the side panel is docked. Session state, not a preference: entering
   * the mode always starts with the video alone, and exiting closes the panel.
   */
  private panelOpen = false;

  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private pointerHandler: ((e: PointerEvent) => void) | null = null;
  private pointerOutHandler: ((e: PointerEvent) => void) | null = null;
  /** Mirrors {@link REVEAL_CLASS}, so a move only touches the DOM on a change. */
  private revealing = false;
  private playerWatcher: MutationObserver | null = null;
  private playerClassWatcher: MutationObserver | null = null;
  /** Bounds the re-apply loop if the site insists on removing the classes. */
  private classReassertions = 0;
  /** Debounced re-measure after a class contest, and its bound. */
  private geometryRepairTimer: number | null = null;
  private geometryRepairs = 0;
  /** Whether this session has already reported hitting the repair cap. */
  private geometryRepairAbandonReported = false;
  /** Only the classes we actually added, so exit removes exactly those. */
  private addedPlayerClasses: string[] = [];
  private reflowTimers: number[] = [];
  /**
   * Notified once each time the mode really leaves, whatever caused it.
   *
   * Deliberately says nothing more than "the mode ended". The controller holds no
   * site knowledge and it holds no product knowledge either: it does not know
   * whether anyone is counting, what they are counting for, or where the answer
   * goes. Keeping the signal that dumb is what lets a caller add bookkeeping
   * without a second writer appearing beside `exit()`.
   *
   * NOT a gesture listener. Nothing is subscribed to and no click, key, or site
   * class is inspected — the controller reports its own state change. So
   * Requirement 2.10, which bans listeners whose purpose is identifying the cause
   * of a fullscreen exit, is untouched by this.
   */
  private modeEndListener: (() => void) | null = null;

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

  /** Same contract as {@link setButton}, for the side-panel toggle. */
  setPanelButton(button: Element | null): void {
    this.panelButton = button;
    this.applyPanelButtonState(this.panelOpen);
  }

  /**
   * Register the one listener told that the mode ended. See
   * {@link modeEndListener} for what the signal deliberately does not carry.
   *
   * A single slot rather than a subscriber list: there is exactly one owner of
   * this event per session, and a second subscriber would mean two answers to
   * "did this visit end?" with nothing deciding between them. Pass `null` to
   * detach.
   */
  setModeEndListener(listener: (() => void) | null): void {
    this.modeEndListener = listener;
  }

  /** Whether the side panel is currently docked. */
  get isPanelOpen(): boolean {
    return this.active && this.panelOpen;
  }

  /**
   * Dock or undock the side panel. Refused — silently, changing nothing — while
   * the mode is off or when the site had no below-video content to dock, since
   * every panel rule is nested under the active-mode class.
   */
  setPanelOpen(open: boolean): boolean {
    if (!this.active) return false;
    // Asked, not remembered: see `hasSideContent` for why a snapshot is wrong.
    if (open && !this.descriptor?.hasSideContent()) return false;

    if (open === this.panelOpen) return true;

    this.panelOpen = open;
    this.doc.documentElement.classList.toggle(PANEL_CLASS, open);
    this.applyPanelButtonState(open);
    // A deliberate width change earns a fresh repair budget: this is the moment
    // the site is most likely to disagree about the player's size, and the reader
    // is looking straight at the control bar when it does. A fresh budget means a
    // fresh right to report exhausting it.
    this.geometryRepairs = 0;
    this.geometryRepairAbandonReported = false;
    // The player just changed width, and YouTube derives its control-bar
    // geometry from that in JS — the same reason entry and exit nudge it.
    this.scheduleReflowNudge();
    return true;
  }

  /** Flip the side panel. */
  togglePanel(): boolean {
    return this.setPanelOpen(!this.panelOpen);
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
    this.startRevealTracking();
    this.startPlayerWatcher(descriptor.player);
    if (descriptor.keepPlayerClasses && this.addedPlayerClasses.length > 0) {
      this.startPlayerClassWatcher(descriptor.player);
    }

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

    // Stop watching before restoring: the class watcher's whole job is to undo
    // removals of the classes the next few lines deliberately remove.
    this.stopPlayerWatcher();

    const { snapshot, descriptor } = this;
    if (snapshot && descriptor) {
      // A single-page site can detach the player or a chrome element while the
      // mode is on. Writing to a detached element is harmless but pointless, and
      // an element the page has thrown away needs no restoring: skip it, keep
      // restoring everything else, and report the count once at the end rather
      // than one line per element, so a wholesale re-render cannot flood the
      // console.
      let skipped = 0;
      if (isConnected(descriptor.player)) {
        for (const cls of this.addedPlayerClasses) {
          descriptor.player.classList.remove(cls);
        }
        restoreStyle(descriptor.player, snapshot.playerStyle);
      } else {
        skipped += 1;
      }
      for (const entry of snapshot.chrome) {
        if (isConnected(entry.element)) restoreStyle(entry.element, entry.style);
        else skipped += 1;
      }
      if (skipped > 0) {
        warn(DIAGNOSTIC.restoreSkipped, "Snapshotted element was gone at exit; skipped it.", {
          skipped,
        });
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
    this.stopRevealTracking();

    // The panel's layout is nested under the active-mode class, so it cannot
    // outlive the session; undock it rather than leaving a stale class behind.
    this.panelOpen = false;
    this.doc.documentElement.classList.remove(PANEL_CLASS);
    this.applyPanelButtonState(false);

    this.active = false;
    this.descriptor = null;
    this.snapshot = null;
    this.addedPlayerClasses = [];
    this.applyButtonState(false);

    // Mirror the entry nudge for the restored, smaller player.
    this.scheduleReflowNudge();

    // Last, and only after a real leave. The `if (!this.active) return` at the
    // top of this method is what makes that true: an `exit()` against an already
    // inactive controller falls out before here and notifies nothing, so a
    // duplicated teardown cannot be reported — and therefore cannot be counted —
    // twice (R4.8).
    //
    // Ordered after every restore above so the listener sees a page already put
    // back and a session already marked inactive. It restores nothing itself:
    // `exit()` remains the single owner of class, inline-property, and
    // scroll-offset teardown (R4.2).
    this.notifyModeEnd();
  }

  /**
   * Tell the listener the mode ended.
   *
   * Wrapped because a throwing listener must not escape `exit()`. Teardown runs
   * from an `Escape` keydown, from a MutationObserver callback, and from the
   * fullscreen handoff, so a throw here would surface inside the site's own
   * handling of an event it owns. Same reasoning as {@link scheduleReflowNudge}:
   * this is a report, and a report must never break the restore that earned it.
   */
  private notifyModeEnd(): void {
    if (!this.modeEndListener) return;
    try {
      this.modeEndListener();
    } catch {
      // Swallowed on purpose; never throw out of enter/exit.
    }
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

  /** Reflect the panel state on the panel button. */
  private applyPanelButtonState(engaged: boolean): void {
    if (!this.panelButton) return;
    this.panelButton.setAttribute("aria-pressed", engaged ? "true" : "false");
    this.panelButton.classList.toggle(BUTTON_ACTIVE_CLASS, engaged);
  }

  /** Exit on Escape. Capturing, so the site cannot swallow the key first. */
  private registerEscape(): void {
    if (this.escapeHandler) return;
    this.escapeHandler = (e: KeyboardEvent): void => {
      // `e.repeat` is ignored so a held key produces exactly one dismissal: the
      // browser's auto-repeat would otherwise fire the panel branch and then the
      // mode branch in quick succession, cascading through both layers from a
      // single press the reader never released.
      if (e.key !== "Escape" || e.repeat || !this.active) return;
      // Dismiss one layer at a time: the panel first, the mode second. Escaping
      // straight out of both would take the video with the comments the reader
      // was only trying to close.
      if (this.panelOpen) this.setPanelOpen(false);
      else this.exit();
    };
    this.doc.addEventListener("keydown", this.escapeHandler as EventListener, true);
  }

  private unregisterEscape(): void {
    if (!this.escapeHandler) return;
    this.doc.removeEventListener("keydown", this.escapeHandler as EventListener, true);
    this.escapeHandler = null;
  }

  /**
   * Toggle {@link REVEAL_CLASS} from the pointer's distance to the top edge, so
   * the adapter's stylesheet can slide the site's top chrome into view.
   *
   * Listeners are passive and non-capturing, and the handler does no layout
   * reads — it compares `clientY` against two constants and writes a class only
   * when the state actually flips — so this costs nothing the page can feel.
   */
  private startRevealTracking(): void {
    if (this.pointerHandler) return;

    this.pointerHandler = (e: PointerEvent): void => {
      if (!this.active) return;
      // Ignore touch: there is no hover to sense, and a tap near the top edge
      // would otherwise leave the bar stuck open.
      if (e.pointerType === "touch") return;
      const y = e.clientY;
      this.setRevealing(this.revealing ? y <= REVEAL_HIDE_ZONE_PX : y <= REVEAL_ZONE_PX);
    };
    // The pointer leaving the document (into browser chrome, another window)
    // produces no further moves, so hide explicitly rather than staying open.
    this.pointerOutHandler = (e: PointerEvent): void => {
      if (e.relatedTarget === null) this.setRevealing(false);
    };

    this.doc.addEventListener("pointermove", this.pointerHandler as EventListener, {
      passive: true,
    });
    this.doc.addEventListener("pointerout", this.pointerOutHandler as EventListener, {
      passive: true,
    });
  }

  private stopRevealTracking(): void {
    if (this.pointerHandler) {
      this.doc.removeEventListener("pointermove", this.pointerHandler as EventListener);
      this.pointerHandler = null;
    }
    if (this.pointerOutHandler) {
      this.doc.removeEventListener("pointerout", this.pointerOutHandler as EventListener);
      this.pointerOutHandler = null;
    }
    this.setRevealing(false);
  }

  private setRevealing(revealing: boolean): void {
    if (revealing === this.revealing) return;
    this.revealing = revealing;
    this.doc.documentElement.classList.toggle(REVEAL_CLASS, revealing);
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

  /**
   * Re-apply the classes we added whenever the site strips them off the player.
   *
   * The site owns that attribute too, so this is a contest rather than a fix:
   * bounded at {@link MAX_CLASS_REASSERTIONS} re-applications per session, after
   * which the mode gives up and says so, rather than trading class writes with
   * the page forever.
   *
   * Re-adding cannot recurse: the observer fires again on our own write, sees
   * nothing missing, and does nothing.
   *
   * Why the write is immediate and why a debounced reflow nudge follows it is in
   * {@link reassertPlayerClasses} and {@link scheduleGeometryRepair}. Both were
   * learned from the same bug and pull in opposite directions, so read them
   * together before changing either.
   */
  private startPlayerClassWatcher(player: Element): void {
    if (this.playerClassWatcher || typeof MutationObserver === "undefined") return;

    this.classReassertions = 0;
    this.geometryRepairs = 0;
    this.geometryRepairAbandonReported = false;
    this.playerClassWatcher = new MutationObserver(() => {
      if (!this.active) return;
      const missing = this.addedPlayerClasses.filter((cls) => !player.classList.contains(cls));
      if (missing.length === 0) return;

      if (this.classReassertions >= MAX_CLASS_REASSERTIONS) {
        this.playerClassWatcher?.disconnect();
        this.playerClassWatcher = null;
        warn(DIAGNOSTIC.playerClassContested, "Site keeps removing our player classes; giving up.", {
          classes: missing,
          reassertions: this.classReassertions,
        });
        return;
      }

      this.classReassertions += 1;
      this.reassertPlayerClasses(player, missing);
    });
    this.playerClassWatcher.observe(player, { attributes: true, attributeFilter: ["class"] });
  }

  /**
   * Put the tracked classes back once the site's current task has finished, then
   * make it re-measure. See {@link startPlayerClassWatcher} for why the delay and
   * the nudge are both load-bearing.
   */
  private reassertPlayerClasses(player: Element, missing: string[]): void {
    // Synchronously, inside the observer callback, and that is the point.
    //
    // Deferring this by even one animation frame was tried and it broke the
    // common case. The site strips the class at the START of its relayout and
    // measures afterwards, so writing back immediately means it measures a player
    // that already has the class and its own geometry comes out right. Wait a
    // frame and it is guaranteed to measure without the class, so the geometry is
    // guaranteed stale and the repair below has to carry every occurrence rather
    // than the rare one. In windowed mode with no panel that turned a correct
    // control bar into a broken one.
    player.classList.add(...missing);

    // The safety net for when the write above loses the race anyway — the site
    // had already measured before we ran. Debounced and bounded, because the
    // nudge is itself a resize the site may answer with another strip.
    this.scheduleGeometryRepair();
  }

  /**
   * Ask the site to re-measure once its class writes have gone quiet.
   *
   * This is the half that actually repairs the layout. The site sizes the parts
   * of its control bar that cannot be expressed in CSS — the width of each
   * chapter segment, the scrubber's offset — in JS pixels, from the bar width it
   * last measured, and only recomputes on a resize. Take the classes away and put
   * them back without one, and the bar renders at a size those pixels do not
   * describe: on a chaptered video the segments stop tiling the bar and the
   * scrubber sits off the true playhead.
   */
  private scheduleGeometryRepair(): void {
    const view = this.doc.defaultView;
    if (!view) return;

    if (this.geometryRepairTimer !== null) {
      view.clearTimeout(this.geometryRepairTimer);
      this.geometryRepairTimer = null;
    }
    if (this.geometryRepairs >= MAX_GEOMETRY_REPAIRS) {
      // Every other bounded loop in this file reports when it gives up; this one
      // used to return silently, which meant a player whose geometry never
      // settled looked identical in the console to one that settled on the first
      // nudge.
      //
      // Once per session, tracked by its own flag rather than by pushing the
      // counter past its cap: the site can contest the geometry many times after
      // the cap is reached, and one line per contest is the console flood the
      // other diagnostics are careful to avoid.
      if (!this.geometryRepairAbandonReported) {
        this.geometryRepairAbandonReported = true;
        warn(DIAGNOSTIC.geometryRepairAbandoned, "Player geometry never settled; stopped nudging.", {
          attempts: MAX_GEOMETRY_REPAIRS,
        });
      }
      return;
    }

    this.geometryRepairTimer = view.setTimeout(() => {
      this.geometryRepairTimer = null;
      if (!this.active) return;
      this.geometryRepairs += 1;
      this.scheduleReflowNudge();
    }, GEOMETRY_REPAIR_DEBOUNCE_MS) as unknown as number;
  }

  private stopPlayerWatcher(): void {
    this.playerWatcher?.disconnect();
    this.playerWatcher = null;
    this.playerClassWatcher?.disconnect();
    this.playerClassWatcher = null;
    // A pending repair would otherwise nudge a player the mode no longer owns.
    if (this.geometryRepairTimer !== null) {
      this.doc.defaultView?.clearTimeout(this.geometryRepairTimer);
      this.geometryRepairTimer = null;
    }
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

  /**
   * Final teardown for a controller that will never be used again.
   *
   * `exit()` alone is not enough. It ends the mode and then schedules a fresh
   * reflow nudge for the restored player, and those timers were previously only
   * cleared by the *next* `scheduleReflowNudge()` call — which never comes when
   * the session is being thrown away. On an SPA navigation that left up to
   * {@link REFLOW_NUDGE_DELAYS_MS} of synthetic `resize` events firing at a page
   * this extension no longer had anything to do with.
   *
   * Call this last, after `exit()`, so the nudge `exit()` schedules is the thing
   * being cancelled. Safe to call on an inactive controller and safe to call
   * twice.
   */
  dispose(): void {
    const view = this.doc.defaultView;
    for (const id of this.reflowTimers) view?.clearTimeout(id);
    this.reflowTimers = [];
    // Belt and braces: `exit()` already routes through `stopPlayerWatcher`, but
    // dispose must leave nothing pending even if it is called on a controller
    // that never entered.
    this.stopPlayerWatcher();
  }
}

// ===========================================================================
// §8  Button injector
// ===========================================================================

/** Accessible name for the injected button. */
const BUTTON_LABEL = "Windowed fullscreen";

/** Used only if the native control somehow already carries {@link BUTTON_LABEL}. */
const BUTTON_LABEL_FALLBACK = "Windowed fullscreen (extension)";

/** Accessible name for the side-panel toggle. */
const PANEL_BUTTON_LABEL = "Comments and video info";

/**
 * The controls we inject, in on-screen order starting immediately to the right
 * of the site's own fullscreen button. The value doubles as the marker
 * attribute's value, which is how a re-render is de-duplicated per control.
 */
const BUTTON_ROLES = ["mode", "panel"] as const;

type ButtonRole = (typeof BUTTON_ROLES)[number];

/** Everything the injector needs to render and wire one control. */
interface ButtonSpec {
  readonly role: ButtonRole;
  /** Accessible name and tooltip. */
  readonly label: string;
  /** Used instead of `label` if the native control already carries that name. */
  readonly fallbackLabel?: string;
  /** Build the glyph. Called once per injected element. */
  buildIcon(doc: Document): Element;
  /** Invoked on click. */
  onActivate(): void;
  /**
   * Whether the control applies to this page at all. A control that reports
   * false is not injected, and is removed if it was — the side-panel toggle uses
   * this so it never appears on a page with nothing to dock.
   */
  isAvailable?(): boolean;
}

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

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * An empty 36×36 icon canvas, matching the coordinate system video control bars
 * conventionally use. Built with DOM calls rather than `innerHTML` so pages
 * enforcing Trusted Types (YouTube does) cannot block it.
 */
function createIconSvg(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}

/** Append one SVG shape with the given attributes. */
function appendShape(
  doc: Document,
  svg: Element,
  tag: string,
  attrs: Record<string, string>,
): void {
  const shape = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
  svg.appendChild(shape);
}

/** A framed rectangle suggesting a video filling a window. */
function buildModeIcon(doc: Document): Element {
  const svg = createIconSvg(doc);
  appendShape(doc, svg, "rect", {
    x: "7",
    y: "9",
    width: "22",
    height: "18",
    rx: "1.5",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "2",
  });
  appendShape(doc, svg, "rect", {
    x: "10",
    y: "12.5",
    width: "16",
    height: "11",
    rx: "1",
    fill: "#ffffff",
  });
  return svg;
}

/** A speech bubble with two lines of text: comments and video info. */
function buildPanelIcon(doc: Document): Element {
  const svg = createIconSvg(doc);
  appendShape(doc, svg, "rect", {
    x: "7",
    y: "8",
    width: "22",
    height: "16",
    rx: "3",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "2",
  });
  // The tail, drawn from the bubble's lower edge down and back up.
  appendShape(doc, svg, "path", {
    d: "M13 23v6l6-6",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "2",
    "stroke-linejoin": "round",
  });
  appendShape(doc, svg, "rect", {
    x: "11",
    y: "12.5",
    width: "14",
    height: "2",
    rx: "1",
    fill: "#ffffff",
  });
  appendShape(doc, svg, "rect", {
    x: "11",
    y: "17",
    width: "9",
    height: "2",
    rx: "1",
    fill: "#ffffff",
  });
  return svg;
}

/**
 * The direct child of `container` that contains `el`, or `el` itself when it is
 * already a direct child (or not inside `container` at all).
 *
 * Used to place our controls AFTER the cluster the site's own control sits in,
 * rather than inside it. YouTube groups its right-hand buttons in
 * `.ytp-right-controls-right`, a flex box sized to exactly three 48px slots.
 * Injecting into that cluster does not widen it — it makes YouTube drop one of
 * its own controls (the cast button was the casualty) and squeeze the rest.
 * Anchoring outside the cluster lets the container grow instead, which is what
 * it is already styled to do.
 */
function outermostChildOf(container: Element, el: Element): Element {
  let current: Element = el;
  while (current.parentElement && current.parentElement !== container) {
    current = current.parentElement;
  }
  return current.parentElement === container ? current : el;
}

/** Attributes an element uses to advertise its accessible name. */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const title = el.getAttribute("title")?.trim();
  if (title) return title;
  return (el.textContent ?? "").trim();
}

/**
 * Keeps exactly one of each injected control next to the site's native
 * fullscreen control, and keeps them there as the site re-renders.
 *
 * Two bounded loops guard against the site never cooperating, so neither can
 * spin forever:
 *
 *  - **Initial detection.** Retries `ensureButtons` up to
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
  private readonly specs: readonly ButtonSpec[];
  private readonly onButtonChange: (role: ButtonRole, button: Element | null) => void;
  private readonly isModeActive: () => boolean;

  /** The buttons we own, keyed by role. A role is absent while not injected. */
  private readonly buttons = new Map<ButtonRole, Element>();
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
    /** The controls to keep injected, in on-screen order. */
    buttons: readonly ButtonSpec[];
    /** Invoked whenever an owned button element changes, so state can follow it. */
    onButtonChange: (role: ButtonRole, button: Element | null) => void;
    /** The re-render loop only runs while the mode is inactive. */
    isModeActive: () => boolean;
  }) {
    this.adapter = options.adapter;
    this.doc = options.document;
    this.specs = options.buttons;
    this.onButtonChange = options.onButtonChange;
    this.isModeActive = options.isModeActive;
    // One delegated handler for every control: the element carries its own role,
    // so the click routes without a closure per button.
    this.clickHandler = (e: Event): void => {
      e.preventDefault();
      const role = (e.currentTarget as Element).getAttribute(BUTTON_MARKER_ATTR);
      this.specs.find((spec) => spec.role === role)?.onActivate();
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

  /** Stop watching, dispose hooks, and remove our buttons. */
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

    for (const [role, button] of this.buttons) {
      button.removeEventListener("click", this.clickHandler);
      button.remove();
      this.onButtonChange(role, null);
    }
    this.buttons.clear();
  }

  /**
   * Idempotently guarantee exactly one correctly placed, correctly labelled
   * element per control. Safe to call any number of times. The native control is
   * read but never modified.
   */
  ensureButtons(): EnsureResult {
    const container = this.adapter.findControlsContainer(this.doc);
    const native = this.adapter.findNativeFullscreenButton(this.doc);
    // No render target yet: leave the page exactly as it is.
    if (!container || !native) return "no-target";

    // Sweep markers we do not recognise — a control left behind by an earlier
    // version of the extension, which used a different marker value.
    for (const el of Array.from(container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`))) {
      const role = el.getAttribute(BUTTON_MARKER_ATTR) as ButtonRole | null;
      if (!role || !BUTTON_ROLES.includes(role)) el.remove();
    }

    let created = false;
    // Each control is placed after the previous one, so `specs` order is
    // on-screen order, beginning just past the site's own fullscreen control —
    // past the cluster that holds it, not inside it. See `outermostChildOf`.
    let anchor: Element = outermostChildOf(container, native);

    for (const spec of this.specs) {
      const marked = Array.from(
        container.querySelectorAll(`[${BUTTON_MARKER_ATTR}="${spec.role}"]`),
      );
      const owned = this.buttons.get(spec.role) ?? null;

      // Not applicable to this page: withdraw the control if it is present.
      if (spec.isAvailable && !spec.isAvailable()) {
        for (const el of marked) el.remove();
        if (owned) {
          this.buttons.delete(spec.role);
          this.onButtonChange(spec.role, null);
        }
        continue;
      }

      // De-duplicate, preferring the instance we already own.
      let kept: Element | null = null;
      if (marked.length > 0) {
        kept = (owned && marked.includes(owned) && owned) || marked[0];
        for (const el of marked) {
          if (el !== kept) el.remove();
        }
      }

      const button = kept ?? this.createButton(spec, native);
      if (kept === null) created = true;

      // Re-position if the site moved it away from where we put it.
      if (anchor.nextSibling !== button) anchor.after(button);

      if (!this.wired.has(button)) {
        button.addEventListener("click", this.clickHandler);
        this.wired.add(button);
      }

      if (owned !== button) {
        this.buttons.set(spec.role, button);
        this.onButtonChange(spec.role, button);
      }

      anchor = button;
    }

    return created ? "injected" : "present";
  }

  /**
   * True when a control that applies to this page has still not been injected.
   *
   * Availability can resolve later than the control bar does — the side-panel
   * toggle waits on the page's below-video block, which mounts on its own
   * schedule. Without this the detection loop would stop as soon as the FIRST
   * control landed, and the panel toggle would only ever appear if some later
   * mutation happened to trigger a re-check. On a paused player, that could be
   * never.
   */
  private hasPendingButton(): boolean {
    for (const spec of this.specs) {
      if (spec.isAvailable && !spec.isAvailable()) continue;
      if (!this.buttons.has(spec.role)) return true;
    }
    return false;
  }

  /** True when a control we own has been torn out of the DOM. */
  private hasDetachedButton(): boolean {
    for (const button of this.buttons.values()) {
      if (!isConnected(button)) return true;
    }
    return false;
  }

  /**
   * Build the button. The inline styles are generic — no site CSS — and are what
   * make it actually visible inside a typical video control bar; without them it
   * has no size and no glyph.
   */
  private createButton(spec: ButtonSpec, native: Element): Element {
    const btn = this.doc.createElement("button");
    btn.setAttribute(BUTTON_MARKER_ATTR, spec.role);
    btn.setAttribute("type", "button");
    btn.className = "wfs-button";

    // Keep our accessible name distinct from the native control's.
    const label =
      spec.fallbackLabel && accessibleName(native).toLowerCase() === spec.label.toLowerCase()
        ? spec.fallbackLabel
        : spec.label;
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

    btn.appendChild(spec.buildIcon(this.doc));
    return btn;
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
      if (this.hasDetachedButton() && !this.isModeActive()) {
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
      this.ensureButtons();
    }, DEBOUNCE_MS);
  }

  /** One attempt of the bounded initial-detection loop. */
  private runDetection(): void {
    if (this.detectionDone || !this.started) return;

    this.detectionAttempts += 1;
    // Keep going while a control that applies here is still missing, not merely
    // until the first one lands.
    if (this.ensureButtons() !== "no-target" && !this.hasPendingButton()) {
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
      } else if (!this.adapter.findNativeFullscreenButton(this.doc)) {
        warn(
          DIAGNOSTIC.nativeControlNotFound,
          "Native fullscreen control not found; leaving the page unchanged.",
          context,
        );
      }
      // Otherwise the bar was found and at least one control is placed; a spec
      // whose availability never resolved is not an error, and the mutation
      // observer still picks it up if the page mounts it later.
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
    // Something else already restored them.
    if (this.buttons.size > 0 && !this.hasDetachedButton()) {
      this.stopReRenderLoop();
      return;
    }

    const hasTarget =
      this.adapter.findControlsContainer(this.doc) && this.adapter.findNativeFullscreenButton(this.doc);

    if (hasTarget) {
      if (this.ensureButtons() !== "no-target") this.reRenderAttempts += 1;
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
    // Deliberately lazy: the below-video block mounts long after the player, so
    // resolving it here would freeze "no panel available" into a session that
    // entered early. A page with nothing to dock is still perfectly usable, it
    // just has no side panel.
    hasSideContent: () => adapter.findSideContent(doc) !== null,
    siteChromeElements,
    missingChromeSelectors,
    activePlayerClasses: adapter.getActivePlayerClasses(),
    keepPlayerClasses: adapter.keepsActivePlayerClasses(),
  };
}

/**
 * How long to keep trying to re-enter the mode after browser fullscreen ends.
 * Six attempts at 250ms covers the site rebuilding its player without leaving a
 * pending timer around long enough to matter.
 */
const RESUME_RETRY_MS = 250;
const MAX_RESUME_ATTEMPTS = 6;

/**
 * How long a pre-emptive stand-down waits for fullscreen to actually arrive
 * before putting the mode back. Covers a click or keypress that turned out not
 * to request fullscreen at all, so a misread never leaves the reader stranded on
 * a plain page.
 */
const FULLSCREEN_GRACE_MS = 900;

/**
 * How long auto-apply is held off after the mode stood down for a player-bar
 * control that needs the ordinary page.
 *
 * 900ms, the same span as {@link FULLSCREEN_GRACE_MS} and for the same underlying
 * reason — it covers the site rebuilding its control bar, which remounts our
 * button and re-triggers auto-apply. Declared separately rather than reusing that
 * constant because the two guard unrelated events, and a future change to the
 * fullscreen grace period must not silently change how long a chapter panel stays
 * on screen.
 */
const PAGE_HANDOFF_GRACE_MS = 900;

/**
 * Where the page lands once browser fullscreen ends.
 *
 * A lookup, not an inference. Pure and total: three triggers by the two pending
 * flags is twelve cases, and every one returns exactly one destination without
 * reading the document, the clock, or any state beyond these three arguments.
 *
 * **Leaving fullscreen retraces the way in.** `pendingResume` records whether
 * windowed mode was up when fullscreen began and `pendingPanel` records whether
 * the panel was docked, so an exit gives that state back: enter fullscreen from
 * windowed mode and you return to windowed mode, enter it from the plain player
 * and you return to the plain player. It holds for every way out, including the
 * ones the extension did not ask for — YouTube's own button, a double-click,
 * `f`, `Escape`.
 *
 * This is the behaviour of 1.2.0, restored. The version in between made every
 * exit the extension had not requested land on the plain player, on the argument
 * that people leave fullscreen expecting the ordinary page. That reasoning was
 * wrong about what the gesture means: fullscreen was entered from somewhere, and
 * leaving it means going back to that somewhere, one step at a time. Dropping the
 * reader onto a plain page instead threw away a mode they had switched on
 * themselves and never asked to leave, and it made `Escape` from fullscreen
 * silently destroy two layers instead of one.
 *
 * `site-or-user` therefore reads the flags rather than declining them, and each
 * of our own buttons keeps its own answer:
 *
 * - `extension-windowed-button` asks for windowed mode, so it says so outright
 *   rather than relying on a flag; the panel it carries is whatever was up.
 * - `extension-panel-button` docks unconditionally, because the press IS the
 *   request for the panel, whether or not it was open before fullscreen.
 *
 * The trigger still comes from an intent the extension writes immediately before
 * calling `exitFullscreen()`. An earlier design tried to name the cause of an exit
 * by correlating capture-phase clicks, double-clicks and keypresses with the
 * `fullscreenchange` that followed; it depended on YouTube's markup to recognise
 * its own fullscreen button and guessed wrong often enough to matter. Do not
 * reintroduce gesture listeners here — the intent slot cannot miss, and anything
 * it does not claim is `site-or-user`, which now needs no attribution at all
 * because the flags already say where to go.
 */
export function selectExitDestination(
  trigger: ExitTrigger,
  pendingResume: boolean,
  pendingPanel: boolean,
): ExitDestination {
  switch (trigger) {
    case "extension-windowed-button":
      return "windowed";
    case "extension-panel-button":
      return "windowed-with-panel";
    case "site-or-user":
      // Nothing to come back to: the mode was not up when fullscreen began, so
      // the plain player IS the state being retraced to.
      if (!pendingResume) return "normal-player";
      // `windowed` rather than `windowed-with-panel` even when the panel was
      // open: the caller passes `pendingPanel` on to the resume, so `windowed`
      // already restores it. Returning the forcing destination here would make
      // the two members mean the same thing and lose the distinction the panel
      // button relies on.
      void pendingPanel;
      return "windowed";
    default: {
      // Unreachable while `ExitTrigger` has three members; the annotation makes
      // adding a fourth a compile error rather than a silent fall-through.
      const exhaustive: never = trigger;
      return exhaustive;
    }
  }
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

  /**
   * Auto-apply's suppression latch. Set on the two paths that deliberately put the
   * reader on the plain player — a fullscreen exit landing there, and a player-bar
   * control that needs the ordinary page (`exitForPageDependentControl`) — and
   * cleared by exactly the four events that mean the reader wants the mode again:
   * our injected button, the popup's toggle, the keyboard command, and a change of
   * the watched video.
   *
   * Without it, auto-apply would undo the exit the reader just asked for: they
   * leave fullscreen expecting the ordinary page, and a preference set once,
   * days ago, would drag them straight back into windowed mode. The `autoApplied`
   * latch alone does not cover this — it is cleared on every video change, and
   * leaving fullscreen is not a video change.
   */
  let autoApplySuppressed = false;

  /**
   * Wall-clock deadline, in ms since the epoch, before which auto-apply must not
   * enter the mode. Set by both plain-player paths: `FULLSCREEN_GRACE_MS` past the
   * `fullscreenchange` that ended fullscreen on a plain-player destination, and
   * `PAGE_HANDOFF_GRACE_MS` past a stand-down for a page-dependent control.
   *
   * Belt and braces beside the latch, and deliberately not cleared by any of the
   * four events: both of those paths make the site rebuild its player, which can
   * remount our button and re-trigger auto-apply within a few frames of the exit.
   * A clock check is the only thing that stops that particular race, because they
   * are the paths where nothing the reader did has changed.
   */
  let normalPlayerUntilMs = 0;

  /**
   * When the running windowed-mode session began, in ms since the epoch, or 0
   * when no session is running.
   *
   * Session-local and never persisted: the only thing that reaches storage is
   * the resulting count, written by `recordQualifyingUsage` in §5. Neither the
   * timestamp nor the count is ever put into the page's document, a URL, or a
   * message, which is what Requirement 11.9 asks for.
   */
  let enteredAtMs = 0;

  /** Start the session clock. The one place it is set. */
  const noteSessionStart = (): void => {
    enteredAtMs = Date.now();
  };

  /**
   * Enter the mode and start the clock on success.
   *
   * Every entry in this session goes through here rather than calling
   * `controller.enter()` directly, so a refused entry — an incomplete descriptor,
   * or the mode already being active — cannot start a session that never began.
   */
  const enterMode = (descriptor: SiteDescriptor): boolean => {
    if (!controller.enter(descriptor)) return false;
    noteSessionStart();
    return true;
  };

  /**
   * Close the running session and count it if it lasted long enough.
   *
   * Idempotent through the clock alone, which is cleared before anything awaits:
   * a duplicated teardown — a stand-down followed by a navigation, say — finds no
   * session and counts nothing, so one visit can never be counted twice
   * (R9.1, R9.18).
   *
   * Fire and forget, and deliberately never awaited. This runs on teardown paths
   * inside the page, where the alternative is an unhandled rejection thrown from
   * inside the site's own event handler, or a teardown that pauses on storage. A
   * rejected write is a dropped count and nothing more: the count lives only in
   * the store, so there is nothing in the page to undo and nothing to retry
   * (R9.10, R11.9).
   */
  const noteSessionEnd = (): void => {
    if (enteredAtMs === 0) return;
    const durationMs = Date.now() - enteredAtMs;
    enteredAtMs = 0;
    void recordQualifyingUsage(durationMs).catch(() => {
      // Swallowed on purpose; see above.
    });
  };

  /**
   * The single subscriber to the controller's "the mode ended" report, which is
   * the only way every leave gets counted.
   *
   * Wiring it here rather than calling `noteSessionEnd()` beside each
   * `controller.exit()` is the fix for a real gap: the controller owns exits this
   * session never sees. `Escape` is handled inside the controller and calls
   * `exit()` directly, and so does the watcher that fires when the site tears the
   * player out of the DOM. Both left the mode without counting the visit, so a
   * reader who watched an hour in windowed mode and pressed `Escape` registered no
   * use at all — exactly what R9.1 asks for and did not get.
   *
   * Subscribing also makes an explicit call beside any `exit()` redundant, and the
   * ones that existed have been removed: two callers for one leave would count the
   * same visit twice on whichever path still had both.
   */
  controller.setModeEndListener(noteSessionEnd);

  const maybeAutoApply = (): void => {
    if (!prefResolved || !autoApplyEnabled || autoApplied || controller.isActive) return;
    // The reader has just left fullscreen for the plain player. Both refusals
    // hold until one of the four events in the latch's comment above.
    if (autoApplySuppressed || Date.now() < normalPlayerUntilMs) return;
    // Never arrive on top of browser fullscreen; see the fullscreen handoff below.
    if (doc.fullscreenElement) return;
    const descriptor = resolve();
    // Not ready yet; the next button change re-triggers this.
    if (!descriptor) return;
    autoApplied = true;
    enterMode(descriptor);
  };

  /**
   * Switch modes without leaving the mode. Exit restores the page, so a fresh
   * descriptor has to be resolved afterwards — the chrome it hides differs
   * between the two modes.
   */
  const reapplyMode = (): void => {
    if (!controller.isActive || controller.mode === modeFor(prefs)) return;
    // Exit closes the panel, so carry the reader's choice across the swap.
    const panelWasOpen = controller.isPanelOpen;
    // One visit counts once (R9.1). Swapping cover for scrollable is not a new
    // session — the reader never left the mode — so the clock is carried across
    // the exit/enter pair rather than restarted, which would otherwise let a
    // preference changed mid-visit quietly reset a session about to qualify.
    //
    // Lifting the clock out BEFORE the exit is what survives the controller's
    // mode-end report, which now fires in the middle of this swap. `noteSessionEnd`
    // is idempotent through the clock alone, so an absent clock makes that report
    // count nothing — the same rule that already stops a duplicated teardown
    // counting twice, reused rather than a second flag invented for the swap.
    const startedAt = enteredAtMs;
    enteredAtMs = 0;
    controller.exit();
    const descriptor = resolve();
    if (descriptor && enterMode(descriptor)) {
      enteredAtMs = startedAt;
      if (panelWasOpen) controller.setPanelOpen(true);
      return;
    }
    // The swap could not re-enter, so the visit really did end at the exit above.
    // Put the clock back and close it by hand: the controller has already reported
    // this leave, and it did so while the clock was lifted, so this is the one
    // count for the visit and it measures from the original entry.
    enteredAtMs = startedAt;
    noteSessionEnd();
  };

  // -------------------------------------------------------------------------
  // Browser fullscreen handoff.
  //
  // Windowed mode and browser fullscreen are ALTERNATIVES, never layers. Both
  // want to own the player's box: the mode pins it with fixed positioning, a
  // maximum z-index, a locked page scroll, and hidden site chrome, while
  // fullscreen expects the site's own layout to be intact so it can measure and
  // rebuild it. Left both on, they fight — the site ends up measuring a player
  // it does not control, picks its smallest control bar, and the result is the
  // mangled player that made this necessary.
  //
  // So exactly one is ever active. Entering fullscreen stands the mode fully
  // down through the ordinary exit path, which restores the page byte for byte,
  // and the two pending flags below remember what was on screen at that moment.
  // Leaving fullscreen retraces those steps rather than skipping them:
  //
  //   fullscreen button, in windowed mode -> plain YouTube fullscreen
  //   any exit, entered from windowed     -> back to windowed mode, panel and all
  //   any exit, entered from plain player -> the plain player
  //   windowed button, in fullscreen      -> leaves fullscreen, goes windowed
  //   comment button, in fullscreen       -> leaves fullscreen, docks the panel
  //
  // Going back the way you came is what the gesture means: fullscreen was entered
  // from somewhere, and leaving it undoes that one step. It does not undo the mode
  // the reader switched on before it, which they never asked to leave. So `Escape`
  // from fullscreen costs three presses to reach a bare page — out of fullscreen,
  // out of the panel, out of the mode — and each one gives back exactly one layer.
  // -------------------------------------------------------------------------
  let resumeAfterFullscreen = false;
  let resumePanelAfterFullscreen = false;
  let graceTimer: number | null = null;
  let resumeTimer: number | null = null;

  /**
   * Generation counter for the bounded resume. Every `clearResume()` bumps it,
   * and every resume callback carries the value it was scheduled under, so a
   * callback belonging to a superseded handoff returns instead of entering.
   *
   * The timer id alone is not enough. A callback whose timer has already fired
   * but which has not run yet is not reliably cancellable, and that is precisely
   * the callback that must not land: a stand-down for a page-dependent control,
   * or a second fullscreen beginning 10ms after a retry was scheduled, would
   * otherwise be followed by an `enter()` on top of the state that replaced it.
   */
  let resumeToken = 0;

  /**
   * The one exit-intent slot. Either nothing, or the single button this
   * extension last asked an exit on behalf of.
   *
   * One slot on purpose: a second set replaces the value rather than queueing
   * behind it, so two presses in a row cannot leave a stale intent to be read by
   * an exit the reader asked for themselves later. It is written in exactly one
   * place — `requestExitFullscreen` — and read in exactly one place, the leaving
   * edge of `onFullscreenChange`, which clears it whether it was used or not.
   *
   * This is the whole of the destination decision. There is deliberately no
   * gesture listener, no site class name, and no time window: `fullscreenchange`
   * carries no cause and we do not need one, because the only cause that changes
   * the answer is the one we make ourselves and can record before making it.
   */
  let exitIntent: ExitIntent | null = null;

  const timers = (): { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } =>
    (doc.defaultView ?? globalThis) as unknown as {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };

  const clearGrace = (): void => {
    if (graceTimer === null) return;
    timers().clearTimeout(graceTimer);
    graceTimer = null;
  };

  /**
   * Cancel a resume retry that has been scheduled but not run.
   *
   * Deliberately does NOT touch the two pending flags: the leaving edge reads
   * them to decide the destination, so clearing them here would throw away what
   * to restore. The flags are cleared by whoever applies the destination.
   */
  const clearResume = (): void => {
    // Bumped unconditionally, before the id is even looked at: cancelling the
    // timer only stops a retry that has not fired, and the token is what stops
    // one that has. Bumping it when nothing is pending costs nothing and keeps
    // this the single place a resume is invalidated.
    resumeToken += 1;
    if (resumeTimer === null) return;
    timers().clearTimeout(resumeTimer);
    resumeTimer = null;
  };

  /**
   * Stand the mode down for a fullscreen request that has NOT been made yet.
   *
   * Timing is the whole point. Reacting to `fullscreenchange` is too late: by
   * then the browser is already fullscreen and the site has begun measuring its
   * new layout — against a player still pinned by this extension. It caches that
   * bogus size and renders its smallest control bar, which is the broken player.
   * Running first, in the capture phase of the click or keypress that triggers
   * the request, means the site only ever measures its own untouched layout.
   *
   * The grace timer is the safety net: if fullscreen never materialises, the mode
   * comes straight back.
   */
  const standDownForFullscreen = (): void => {
    if (!controller.isActive) return;
    resumeAfterFullscreen = true;
    resumePanelAfterFullscreen = controller.isPanelOpen;
    // The mode really is down for the whole of fullscreen, so the session ends
    // here and the resume below starts a fresh one (R9.1). The count comes from
    // the controller's own mode-end report, not from a call beside this one.
    controller.exit();

    clearGrace();
    graceTimer = timers().setTimeout(() => {
      graceTimer = null;
      if (doc.fullscreenElement || !resumeAfterFullscreen) return;
      const panel = resumePanelAfterFullscreen;
      resumeAfterFullscreen = false;
      resumePanelAfterFullscreen = false;
      resumeWindowed(panel, 0, resumeToken);
    }, FULLSCREEN_GRACE_MS) as unknown as number;
  };

  /**
   * Leave the mode for a player-bar control that only works on the ordinary page.
   *
   * A real exit, not a stand-down: nothing is coming back on its own. The reader
   * asked to see something the mode cannot show them, so they get the ordinary
   * page and windowed mode stays one press of our own button away.
   *
   * The mode is torn down SYNCHRONOUSLY, from the capture phase, before the site's
   * own handler runs. That ordering is the fix. The site's handler opens its panel
   * into page chrome that this extension hides, so it has to find that chrome
   * already restored — restoring it afterwards would mean the panel had already
   * laid itself out inside a `display: none` container, and asking the site to
   * re-open it is not something we can do without naming its internals.
   *
   * Auto-apply is latched off for the same reason a plain-player fullscreen exit
   * latches it off: the site rebuilds its control bar after a click like this,
   * which remounts our button and re-triggers auto-apply within a few frames. That
   * would drag the reader back into windowed mode and hide the panel they just
   * opened, one frame after opening it.
   */
  const exitForPageDependentControl = (): void => {
    if (!controller.isActive) return;
    // Nothing may bring the mode back by itself. A stand-down scheduled by an
    // earlier gesture is cancelled outright, or its grace timer would re-enter on
    // top of the panel the site is about to open.
    clearGrace();
    clearResume();
    resumeAfterFullscreen = false;
    resumePanelAfterFullscreen = false;
    exitIntent = null;

    autoApplySuppressed = true;
    normalPlayerUntilMs = Date.now() + PAGE_HANDOFF_GRACE_MS;

    // The visit ends here and is counted by the controller's own mode-end report,
    // not by a call beside this one — the same rule as every other exit path.
    controller.exit();
  };

  /**
   * Every way the site can be asked for fullscreen from the page: its own
   * fullscreen button, a double-click on the player, and the `f` shortcut. Plus
   * the player-bar controls that need the mode out of the way entirely.
   *
   * Capturing, so we run before the site's handler on the same event.
   * `fullscreenchange` still backs the fullscreen half up for any path not listed
   * here.
   */
  const onPointerCapture = (e: Event): void => {
    if (!controller.isActive || doc.fullscreenElement) return;
    const target = e.target as Node | null;
    if (!target) return;
    const button = adapter.findNativeFullscreenButton(doc);
    if (button?.contains(target)) {
      standDownForFullscreen();
      return;
    }

    // Before the double-click branch below, which would otherwise treat a
    // double-click on one of these controls as a fullscreen request: they sit
    // inside the player, so the player-contains test cannot tell them apart.
    //
    // In practice the first click of that double has already left the mode, so the
    // guard at the top of this handler returns before the second arrives. Checked
    // here anyway rather than relying on that, because it depends on the site
    // dispatching `click` before `dblclick`, which is the browser's behaviour and
    // not ours to lean on.
    const pageDependent = adapter.findPageDependentControls?.(doc) ?? [];
    if (pageDependent.some((control) => control.contains(target))) {
      exitForPageDependentControl();
      return;
    }

    if (e.type === "dblclick" && adapter.findPlayer(doc)?.contains(target)) {
      standDownForFullscreen();
    }
  };

  const onKeyCapture = (e: KeyboardEvent): void => {
    if (!controller.isActive || doc.fullscreenElement) return;
    if (e.key !== "f" && e.key !== "F") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Not a shortcut while the reader is typing — in the search box, or in the
    // comment box the side panel put on screen.
    const focused = doc.activeElement as HTMLElement | null;
    if (
      focused &&
      (focused.tagName === "INPUT" ||
        focused.tagName === "TEXTAREA" ||
        focused.isContentEditable ||
        focused.getAttribute("contenteditable") === "true")
    ) {
      return;
    }
    standDownForFullscreen();
  };

  doc.addEventListener("click", onPointerCapture, true);
  doc.addEventListener("dblclick", onPointerCapture, true);
  doc.addEventListener("keydown", onKeyCapture as EventListener, true);

  /**
   * Ask the browser to leave fullscreen on behalf of one of our own buttons.
   *
   * The intent is recorded BEFORE the request is issued, and that ordering is
   * the entire mechanism: `fullscreenchange` may arrive synchronously from inside
   * `exitFullscreen()`, so an intent written afterwards would be read as absent.
   * The pending flags would still bring the mode back, but the press would be
   * treated as an ordinary retraced exit — the panel button in particular would
   * land in windowed mode with the panel closed, having been pressed to open it.
   */
  const requestExitFullscreen = (intent: ExitIntent): void => {
    resumeAfterFullscreen = true;
    resumePanelAfterFullscreen = resumePanelAfterFullscreen || intent === "extension-panel-button";
    // Before the call. Never after it.
    exitIntent = intent;

    /**
     * Refused, so no `fullscreenchange` is coming and nothing was changed. Drop
     * every trace of the attempt: an intent left behind would be consumed by the
     * next exit, which may well be one the reader asked for themselves, and a
     * pending resume left behind would bring the mode back on top of it.
     */
    const refused = (error: unknown): void => {
      exitIntent = null;
      clearResume();
      resumeAfterFullscreen = false;
      resumePanelAfterFullscreen = false;
      warn(DIAGNOSTIC.exitFullscreenRefused, "The browser refused to leave fullscreen.", {
        intent,
        error: describeError(error),
      });
    };

    if (typeof doc.exitFullscreen !== "function") {
      // No API to ask with, so no `fullscreenchange` will ever arrive. Treated as
      // a refusal rather than left pending, which would strand the intent.
      refused(new Error("exitFullscreen is unavailable"));
      return;
    }
    try {
      const pending = doc.exitFullscreen();
      // Older engines return undefined rather than a promise.
      if (pending) void pending.catch(refused);
    } catch (err) {
      refused(err);
    }
  };

  /**
   * Put the page where the selected destination says it belongs.
   *
   * Both pending flags are cleared first, on every branch: they described the
   * fullscreen session that has just ended, the destination has already been
   * chosen from them, and `panel` carries forward the only part still needed. A
   * flag left set would be read by the next handoff as a resume it never asked
   * for.
   *
   * Neither branch writes a class, an inline property, a scroll offset, or a
   * button attribute of its own. That is deliberate, and it is the whole of
   * Requirement 4.2:
   *
   * - `normal-player` has nothing to do. It is only reached when the mode was not
   *   up when fullscreen began, so there is nothing to restore: the page was the
   *   plain player and both injected buttons already report `aria-pressed="false"`
   *   with the active class removed — including buttons the injector re-created
   *   during fullscreen, which reach the controller through `onButtonChange` and
   *   are given the current inactive state on arrival. Hand-rolling any of that
   *   here would put a second writer beside `exit()` that could disagree with it
   *   (R1.3, R1.4, R1.6, R1.7, R1.8).
   * - the two windowed destinations hand the whole job to `controller.enter()`,
   *   which sets `aria-pressed="true"` and the active class on the mode button,
   *   and to `setPanelOpen()`, which does the same for the panel button from the
   *   panel's real state (R3.9). If entry never happens the buttons keep the
   *   inactive state `exit()` left, which is the truth: the page is the plain
   *   player.
   */
  const applyExitDestination = (destination: ExitDestination, pendingPanel: boolean): void => {
    resumeAfterFullscreen = false;
    resumePanelAfterFullscreen = false;

    if (destination === "normal-player") {
      // The mode was not up before fullscreen, and it must not appear now just
      // because leaving fullscreen makes the site rebuild its player and remount
      // our button. Auto-apply is latched off until the reader asks for the mode
      // themselves, and held off by the clock for the few frames of that rebuild —
      // entering here would put them somewhere they have not been all video.
      autoApplySuppressed = true;
      normalPlayerUntilMs = Date.now() + FULLSCREEN_GRACE_MS;
      return;
    }

    // `windowed-with-panel` docks unconditionally; `windowed` restores whatever
    // the panel flag recorded from before fullscreen.
    //
    // The distinction is load-bearing. `windowed` is where every retraced exit
    // lands, including one taken with the panel closed, so it has to be able to
    // arrive with the panel closed. `windowed-with-panel` is the panel button
    // asking for the panel outright — the press IS the request, so it must not be
    // filtered through a flag that describes what was on screen before. Collapsing
    // the two would break one case or the other. The token is captured now so a
    // later `clearResume()` invalidates this whole resume, retries included.
    const panel = destination === "windowed-with-panel" ? true : pendingPanel;
    resumeWindowed(panel, 0, resumeToken);
  };

  const onFullscreenChange = (): void => {
    clearGrace();

    if (doc.fullscreenElement) {
      // Usually already handled by the pre-emptive stand-down above; this is the
      // backstop for a request that came from somewhere else entirely.
      if (!controller.isActive) return;
      resumeAfterFullscreen = true;
      resumePanelAfterFullscreen = controller.isPanelOpen;
      // Same stand-down, reached from the backstop rather than the gesture, and
      // counted the same way: by the controller reporting the leave.
      controller.exit();
      return;
    }

    // Leaving edge. Cancel anything already scheduled first, so a retry queued by
    // an earlier handoff cannot land after this one has chosen its destination.
    clearResume();

    const trigger: ExitTrigger = exitIntent ?? "site-or-user";
    // Cleared unconditionally — used or not, empty or not. No intent may survive
    // one fullscreenchange reporting the end of fullscreen, or an exit the reader
    // makes for themselves later would be attributed to our button.
    exitIntent = null;

    const destination = selectExitDestination(
      trigger,
      resumeAfterFullscreen,
      resumePanelAfterFullscreen,
    );
    applyExitDestination(destination, resumePanelAfterFullscreen);
  };

  /**
   * Come back after fullscreen, retrying briefly. Leaving fullscreen makes the
   * site rebuild its player, so the first resolve can land in the gap where the
   * control bar has not remounted — and silently dropping the reader back to a
   * plain page is the one outcome this whole handoff exists to avoid.
   */
  function resumeWindowed(panel: boolean, attempt: number, token: number): void {
    // Superseded. `clearResume()` has run since this attempt was scheduled, so
    // whatever decided this resume has been replaced by a later one.
    if (token !== resumeToken) return;
    // Never arrive on top of browser fullscreen. The two are alternatives, never
    // layers, so this guard is what keeps `document.fullscreenElement` from being
    // non-null while `wfs-windowed` is on the document element — the mode simply
    // is not entered while fullscreen is up, and the `fullscreenchange` for its
    // end starts the handoff again.
    if (doc.fullscreenElement || controller.isActive) return;
    const descriptor = resolve();
    if (descriptor) {
      // `setPanelOpen` refuses, changing nothing, when the site has nothing to
      // dock. That is the wanted behaviour rather than a failure: entry has
      // already succeeded, so the reader lands in windowed mode with the panel
      // closed and `wfs-side-panel` absent, instead of being refused the mode
      // over a block that has not mounted.
      if (enterMode(descriptor) && panel) controller.setPanelOpen(true);
      return;
    }
    if (attempt >= MAX_RESUME_ATTEMPTS) {
      // Give up loudly. Six attempts is roughly 1500ms; if the player still has
      // not resolved, the page is not going to produce one and retrying forever
      // would be an unbounded loop fighting the site.
      //
      // Nothing needs undoing: `enter()` was never reached, so no class and no
      // inline property of ours exists, and the callback that runs this cleared
      // its own timer id before calling, so no timer is left pending. The page is
      // the plain player, restored byte for byte by the `exit()` that stood the
      // mode down, and one press of our own button away from windowed mode.
      warn(DIAGNOSTIC.resumeAbandoned, "Gave up resuming windowed mode after fullscreen.", {
        attempts: attempt,
        panel,
      });
      return;
    }
    // The id is stored so `clearResume()` can cancel a retry that a destination
    // decision has since made wrong; the token rides along so a retry that fired
    // before the cancellation still declines to act.
    resumeTimer = timers().setTimeout(() => {
      resumeTimer = null;
      resumeWindowed(panel, attempt + 1, token);
    }, RESUME_RETRY_MS) as unknown as number;
  }
  doc.addEventListener("fullscreenchange", onFullscreenChange);

  /**
   * The windowed-fullscreen button, the popup, and the keyboard shortcut.
   *
   * The injected control is a real `<button>` wired to `click`, so `Enter` and
   * `Space` arrive here as the browser's own synthetic click. No key handler is
   * needed and none is added: a keydown listener here would be a second path to
   * keep in step, and adding one for exit attribution is exactly what this design
   * replaced.
   */
  const toggleMode = (): void => {
    // Three of the four events that release auto-apply's suppression latch arrive
    // here: the injected button, the popup's toggle, and the keyboard command
    // (both of the latter reach the session as a TOGGLE message). Cleared before
    // the fullscreen branch rather than after it, because pressing our own button
    // inside fullscreen is that same first event — it asks for windowed mode back,
    // which is precisely the signal the latch is waiting for.
    //
    // `normalPlayerUntilMs` is deliberately left alone: it guards only the
    // auto-apply path, and an explicit toggle does not go through it.
    autoApplySuppressed = false;

    if (doc.fullscreenElement) {
      requestExitFullscreen("extension-windowed-button");
      return;
    }
    // The controller still owns the flip; the clock follows whichever way it
    // went. Reading the transition rather than branching here keeps the "no
    // player yet, so change nothing" case in one place — `toggle` leaves the page
    // alone on a null resolution, and no session starts or ends.
    //
    // Only the start is handled here. A flip that left the mode has already been
    // reported by the controller, so ending it a second time from this side would
    // be the one place a single press could count one visit twice.
    const wasActive = controller.isActive;
    controller.toggle(resolve);
    if (controller.isActive === wasActive) return;
    if (controller.isActive) noteSessionStart();
  };

  /**
   * The comment button. Docking the panel only means anything inside the mode,
   * so pressing it from a plain watch page enters the mode and docks in one go —
   * otherwise the first press would appear to do nothing.
   */
  const togglePanel = (): void => {
    if (doc.fullscreenElement) {
      requestExitFullscreen("extension-panel-button");
      return;
    }
    if (controller.isActive) {
      controller.togglePanel();
      return;
    }
    const descriptor = resolve();
    if (descriptor && enterMode(descriptor)) controller.setPanelOpen(true);
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
    buttons: [
      {
        role: "mode",
        label: BUTTON_LABEL,
        fallbackLabel: BUTTON_LABEL_FALLBACK,
        buildIcon: buildModeIcon,
        onActivate: toggleMode,
      },
      {
        role: "panel",
        label: PANEL_BUTTON_LABEL,
        buildIcon: buildPanelIcon,
        onActivate: togglePanel,
        // Nothing to dock means nothing to offer.
        isAvailable: () => adapter.findSideContent(doc) !== null,
      },
    ],
    onButtonChange: (role, button) => {
      if (role === "panel") {
        controller.setPanelButton(button);
        return;
      }
      controller.setButton(button);
      // The button appearing is a good proxy for the player having loaded.
      maybeAutoApply();
    },
    isModeActive: () => controller.isActive,
  });
  injector.start();

  /**
   * The fourth event that releases the suppression latch: the reader has moved to
   * a different video.
   *
   * A session survives video-to-video navigation — the URL still resolves to the
   * same adapter, so `startContentScript` leaves it in place — which is exactly
   * why this subscription is needed. The `autoApplied` latch is cleared alongside
   * the suppression one so the new video gets its own single auto-apply, and
   * `maybeAutoApply()` is re-run because the button may not be re-created on an
   * in-page navigation, so `onButtonChange` cannot be relied on to re-trigger it.
   *
   * The injector keeps its own subscription for re-injecting controls; this one is
   * about the preference, and merging the two would tie the two concerns together
   * for no gain. The site knowledge stays in the adapter either way.
   */
  const disposeVideoChange = adapter.onVideoChange(doc, () => {
    autoApplySuppressed = false;
    autoApplied = false;
    maybeAutoApply();
  });

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
          toggleMode();
          return { ok: true, active: controller.isActive };
        case "GET_STATUS":
          return { ok: true, active: controller.isActive };
        default:
          return null;
      }
    },
    stop() {
      disposePrefWatch();
      disposeVideoChange();
      doc.removeEventListener("fullscreenchange", onFullscreenChange);
      doc.removeEventListener("click", onPointerCapture, true);
      doc.removeEventListener("dblclick", onPointerCapture, true);
      doc.removeEventListener("keydown", onKeyCapture as EventListener, true);
      clearGrace();
      clearResume();
      resumeAfterFullscreen = false;
      resumePanelAfterFullscreen = false;
      // A navigation is not an exit we asked for; leave nothing a later
      // fullscreenchange could read.
      exitIntent = null;
      injector.stop();
      if (controller.isActive) {
        // Navigating away ends the visit as surely as pressing the button does,
        // so it is counted the same way (R9.1) — by the controller's mode-end
        // report, which fires from inside this `exit()` once the page is restored.
        controller.exit();
      } else {
        // The mode was already down, so its own leave has already been reported
        // and the clock is already 0. Zeroed anyway rather than trusted: the one
        // thing that must never happen is a stale clock being measured to this
        // navigation, which would count a mode the reader dismissed seconds after
        // entering as a full session and is exactly what R9.18 forbids.
        enteredAtMs = 0;
      }
      // Nothing further should reach the counter from a session being torn down.
      controller.setModeEndListener(null);
      // Belt-and-suspenders: ensure no active-mode class lingers on <html> after
      // teardown, even if exit() was not called (e.g. the session is torn down
      // while the mode was off). Without this, a leftover class from a prior
      // session could cause the hover-reveal masthead CSS to fire on pages that
      // are not in windowed mode (e.g. the YouTube home page after SPA nav).
      doc.documentElement.classList.remove(
        WINDOWED_CLASS,
        SCROLLABLE_CLASS,
        PANEL_CLASS,
        REVEAL_CLASS,
      );
      // Last, and deliberately after the `exit()` above: `exit()` schedules a
      // reflow nudge for the restored player, and on a torn-down session there is
      // no later `enter()`/`exit()` to clear it. Without this, an SPA navigation
      // left synthetic `resize` events firing at a page this session no longer
      // owned.
      controller.dispose();
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

  // Sites that can tell us an in-app navigation finished do so here, which turns
  // a teardown that used to wait up to a poll interval into an immediate one.
  // That latency was visible: on a watch -> home move it is the class teardown
  // that gives the masthead back, so until it ran the home page kept a hidden
  // masthead that only reappeared on hover.
  //
  // Which event that is belongs to the adapter (§3), not here. This used to call
  // `document.addEventListener("yt-navigate-finish", …)` directly — the one place
  // outside §3 that named a site-specific event.
  //
  // Deliberately NOT `onMaybeNavigated`: that returns early when `location.href`
  // still reads as unchanged, and a site can fire this hint at exactly that
  // moment, because the history entry is committed inside the event. A hint is
  // already evidence that something moved, so it re-syncs unconditionally and
  // lets `sync()` decide there is nothing to do. `sync()` is idempotent, so the
  // cost of a spurious hint is one `resolveAdapter` call.
  observeNavigationHints(document, () => {
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
 * Where the install event sends the reader. Its own page, not the options page.
 *
 * The welcome used to be a card at the top of the options page, which meant a
 * fresh install opened onto every preference the extension has — auto-apply,
 * scrollable mode, the shortcut row, the donation link, a rating footer — to say
 * two things: thank you, and pin it. The settings were answering questions
 * nobody had asked yet. They are still one click away in the toolbar menu, and
 * this page is now only the greeting.
 */
const WELCOME_PAGE_PATH = "welcome/index.html";

/**
 * Pure. Whether an `onInstalled` event should open the welcome page.
 *
 * Only the `install` reason qualifies, and only while the First_Run_Guard is
 * unset. An extension update, a browser update and a shared-module update all
 * arrive through the same listener, and opening a tab on any of them would
 * thank someone for installing something they installed months ago (R15.2).
 * The guard covers the other half: a worker torn down mid-install and restarted
 * must not open a second tab (R15.4).
 */
export function shouldOpenFirstRun(
  reason: string | undefined,
  guardAlreadySet: boolean,
): boolean {
  return reason === "install" && !guardAlreadySet;
}

/**
 * First run: record the install time, then show the welcome page exactly once.
 *
 * The guard is written *before* the open is attempted, not after. A worker can be
 * killed at any point, and the ordering is what makes the open at-most-once: a
 * restart in the middle of this function finds the guard set and opens nothing.
 *
 * A failed open is one diagnostic line and nothing else — no retry, and the guard
 * stays set. A retry would have to run on some later worker start, which is a
 * tab appearing out of nowhere hours after installing (R15.5).
 */
async function handleInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
  // The install time gates the rating prompt; `setInstallTimestampOnce` is the
  // one that refuses to move an existing value forward.
  if (details.reason !== "install") return;
  await setInstallTimestampOnce(Date.now());

  const { state } = await getFirstRunState();
  if (!shouldOpenFirstRun(details.reason, state.opened)) return;
  await setFirstRunState({ ...state, opened: true });

  try {
    // `chrome.tabs.create` rather than `openOptionsPage`, because the welcome is
    // its own page now. Creating a tab needs no `tabs` permission — only reading
    // a tab's URL or title does — so the permission set is unchanged.
    await chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE_PATH), active: true });
  } catch (err) {
    warn(DIAGNOSTIC.firstRunOpenFailed, "Could not open the welcome page on first run.", {
      error: describeError(err),
    });
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

  // Registered here rather than at the top level: the build bundles this file
  // once per surface and tree-shakes from the entry point, so a top-level
  // listener would land in the content script's bundle too.
  chrome.runtime?.onInstalled?.addListener((details) => {
    void handleInstalled(details);
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
 * Where an unhappy rating goes instead of the public store page.
 *
 * The support page, not a `mailto:` link: a mail client carries the user's own
 * address into a conversation they did not ask to start, and half the installs
 * have no mail client configured at all. One named constant, written out in
 * full, because the rating router must never assemble a URL from parts — a
 * concatenated URL is how a star count ends up in a query string.
 */
export const SUPPORT_URL = "https://rohittiger.vercel.app/support";

/**
 * The store's review tab for this extension.
 *
 * Written out in full for the same reason as {@link SUPPORT_URL}: defined once,
 * never built by concatenation, and never carrying a rating value. The store
 * takes no rating parameter, so there is nothing to append even if we wanted to.
 *
 * No query string at all. It used to carry `?hl=en-US&utm_source=ext_sidebar`,
 * both copied in from a store URL and neither of which belonged: `hl` forces
 * English on a reader whose browser is not English, and `ext_sidebar` attributes
 * the visit to a surface this extension does not have.
 */
export const REVIEW_URL =
  "https://chromewebstore.google.com/detail/windowed-fullscreen-for-y/apjbicaacpojdlppeodnbdmkajhmclok/reviews";

/**
 * How long after install the rating prompt stays quiet.
 *
 * 2 minutes. Short enough that someone who installed the extension to watch one
 * video is still around when the ask arrives, long enough that the ask never
 * lands on the options page the install itself opened.
 */
export const MIN_TIME_SINCE_INSTALL_MS = 120_000;

/**
 * Qualifying windowed-mode sessions needed before any rating prompt.
 *
 * One. The point of the gate is that the ask follows a real experience rather
 * than a bare install; a single session of at least
 * {@link MIN_SESSION_FOR_USAGE_MS} is that experience. Asking for more would
 * silence the prompt for the casual user whose opinion is worth just as much.
 */
export const MIN_ENTRIES_BEFORE_PROMPT = 1;

/**
 * How long a review-page open may take before it counts as failed.
 *
 * 2 s. `chrome.tabs.create` normally resolves in a few milliseconds, so this is
 * far past the honest case; the timeout exists because a refused or silently
 * dropped open resolves never rather than rejecting, and the user needs to be
 * told the link did nothing instead of watching a dead control.
 */
export const REVIEW_OPEN_TIMEOUT_MS = 2_000;

// There are no re-ask intervals, because there is no second ask.
//
// There were two: 7 days before a second prompt, 30 before a third. They went
// when the prompt became one-time. An interval only means anything if a decline
// leaves the question open, and it no longer does — the prompt now offers a real
// answer either way, and one answer is the whole conversation. A schedule for
// asking again is just a nicer word for nagging someone who already replied.
//
// The lifetime caps that belong with this group — `MAX_RATING_PROMPTS` (1) and
// `MAX_PIN_PROMPTS` (2) — are declared in §5 beside the storage coercions that
// clamp the stored counts to them, because a bound kept away from its check
// drifts. Reference them from here rather than restating either value.

/**
 * The banned technical terms the help copy may not contain, matched
 * case-insensitively.
 *
 * Here for the test, not for the runtime: nothing reads this list at run time.
 * It exists so that "plain English" is an assertion rather than an intention —
 * every one of these words appeared in an earlier draft of the copy, and each
 * one describes the implementation instead of what the user sees.
 */
export const JARGON_LIST: readonly string[] = [
  "masthead",
  "DOM",
  "CSS",
  "viewport",
  "z-index",
  "pointer events",
  "API",
  "selector",
  "stylesheet",
  "content script",
];

/**
 * Every user-facing help string, defined exactly once.
 *
 * One constant rather than strings sitting in the two HTML shells, because the
 * popup and the options page render the same words and drifted apart the moment
 * they each owned a copy. The shells provide empty containers only; §11 fills
 * them.
 *
 * The copy is written to a fixed budget, which `tests/help-copy.test.ts` walks
 * exhaustively: every string non-empty and trimmed, no term from
 * {@link JARGON_LIST}, no sentence over 20 whitespace-separated words, no string
 * over 140 characters, and no site named anywhere (invariant 2 — the site label
 * arrives as an argument). Adding a string here means keeping it inside that
 * budget.
 *
 * The budget used to be described here as also requiring "exactly two Escape
 * cases and 3 to 6 hover bullets". Both were left over from a draft that had a
 * multi-bullet feature tour, and neither was ever checked, because the test the
 * comment named did not exist.
 */
export const HELP_COPY = {
  heading: "Tips",

  /**
   * One tip. Not a feature tour.
   *
   * This started as five bullets narrating the whole mode, then two. Both were
   * wrong for the same reason: everything else the extension does is visible the
   * moment it is on. The video gets bigger — you can see that. The buttons are in
   * the player bar — you can see those. Writing them down does not teach anybody
   * anything, it just makes a wall of text that gets skipped, and it pushed the
   * one genuinely hidden thing out of sight.
   *
   * The hidden thing is that the search bar is still reachable, because the top
   * bar slides away and nothing on screen says it will come back.
   */
  tips: [
    "Hover your mouse at the top of the video to reach the search bar without leaving windowed mode.",
  ],

  shortcut: {
    /**
     * The lead-in only. The combination itself is rendered as a separate `<kbd>`
     * chip beside it rather than concatenated into this string, because the keys
     * are the one part of the row worth looking at: "Shortcut: Alt+R" set in one
     * uniform weight makes the reader parse a sentence to find two keys. Printing
     * them as a key cap is the same convention every other keyboard hint uses.
     *
     * There is no colon: the chip is the separator.
     */
    prefix: "Shortcut",
    none: "No shortcut set",
    /** The visible label on the control that opens the browser's own page. */
    link: "Change",
  },

  /**
   * The post-install page: thanks, one loud ask, and how to use the thing.
   *
   * Three regions and no fourth. Every settings control that used to sit under
   * this greeting has gone back to the options page, where someone who wants to
   * change a setting will go looking for it. A first run is not the moment to
   * present preferences for a feature the reader has not seen work yet.
   *
   * `pinHow` is the one instruction, and it is one line. Anyone who has installed
   * an extension has pinned one; the three-step list this replaced took longer to
   * read than the toolbar takes to look at.
   *
   * The hints are the four things that are NOT self-evident once the mode is on:
   * where the button is, that a key works, what the second button does, and how
   * to get out. `hitAt` takes the site label from the adapter registry so no site
   * is named here — §3 owns that (invariant 2).
   */
  welcome: {
    title: "Thanks for installing Windowed Fullscreen",
    lead: "Your video fills the whole window, and your tabs, clock and taskbar stay right where they are.",

    /** The ask. Rendered as the loudest thing on the page. */
    pinCallout: "Pin it to your toolbar",
    pinHow: "Click the extensions icon in the toolbar, then the pin beside Windowed Fullscreen.",
    /** Replaces the ask when the browser reports the action is already pinned. */
    pinDone: "It is pinned — you are all set.",

    hintsHeading: "How to use it",
    hintAt: (siteLabel: string): string =>
      `Open a video on ${siteLabel} and click the new button beside the fullscreen one.`,
    hintKeyPrefix: "Or press",
    hintKeyNone: "Or use the toolbar button to switch it on and off.",
    // "A second button", not "the button next to it": the keyboard hint sits
    // between this line and the one that introduced the first button, so a
    // back-reference here pointed at the wrong sentence.
    hintComments: "A second button docks the comments beside the video instead of below it.",
    hintEscape: "Press Escape to come back out.",
  },

  pinPrompt: {
    title: "Pin Windowed Fullscreen to keep the button one click away.",
    dismiss: "No thanks",
  },

  /**
   * The footer says nothing. Five stars on one side, the privacy link on the
   * other, and no prose at all.
   *
   * An earlier draft explained itself three times over — that the choice is kept
   * on the device, that these stars are not the store's, and why a low rating
   * did not open the store. All three were answers to questions nobody asks a
   * row of stars, and together they were longer than everything else on the
   * surface. A star row does not need an introduction.
   *
   * `groupLabel` is not rendered as text; it is the accessible name of the radio
   * group, which a control group still needs even when nothing is shown.
   */
  rating: {
    /** Sits immediately before the stars, so the row reads "Rate us ★★★★★". */
    label: "Rate us",

    /**
     * Names the group AND says what selecting a star does, because it opens a tab.
     *
     * The store's policies ask that an extension hold no surprises, and a control
     * labelled only "Rate us" that navigates on click is a small one. Stating the
     * destination is also the honest framing of what the row is: the stars record a
     * number locally and then hand the reader to the public listing. Nothing is
     * unlocked or rewarded for going, and every star leads to the same page, so
     * this is disclosure rather than an incentive or a filter.
     *
     * Not merged into the per-star names: those are pinned at "N stars out of 5"
     * so five controls announce as five distinct values, and repeating the
     * destination on each would read it out five times.
     */
    groupLabel: "Rate this extension out of five stars — opens the Chrome Web Store review page",

    /**
     * The same disclosure for a pointer, as the group's `title`. A tooltip on the
     * group covers all five controls: a browser looking for one walks up from the
     * button it is over, and the buttons carry none of their own.
     */
    opensStore: "Opens the Chrome Web Store review page",
    /**
     * The one-time prompt. Asks a real question and offers both real answers.
     *
     * It used to say "Enjoying it?" over "Maybe later" and "Don't ask again",
     * which answered nothing: a reader who WAS enjoying it had no way to say so,
     * and one who was not had nowhere to report the problem. The only two things
     * the prompt could do were postpone itself and delete itself, so it existed
     * to manage its own lifecycle. Hence three asks over 37 days — it had to come
     * back, because it had never asked anything.
     *
     * Both destinations are offered together, on the one showing, to every
     * reader. That is deliberate and it is not negotiable — see the note above
     * `ratingPromptDue` on review gating. Asking first and then deciding which
     * link the answer has earned is the thing that gets an extension removed from
     * the store.
     */
    prompt: "Enjoying it? Rate it, or tell me what is not working.",
    /** Opens the store's review page. Same destination as the star row. */
    promptRate: "Rate it",
    /** Opens the support page. Offered to everyone, never as a consolation. */
    promptFeedback: "Something is wrong",
    /** Closes the prompt. It is already resolved by the time this is pressed. */
    promptDismiss: "No thanks",
    /** The support page, always visible — never gated behind a low score. */
    feedbackLink: "Feedback",
    privacyLink: "Privacy",
  },
} as const;

/**
 * Apply the one transform the printed combination is allowed: `Alt` reads
 * `Option` on a Mac keyboard.
 *
 * Everything else about the browser's string is left alone, including the order
 * of the keys. That order is not a guess we could improve on — it is by
 * definition the order the browser's own shortcuts page lists, which is the page
 * the help text sends the user to (R13.4). Re-sorting it would make the two
 * disagree.
 *
 * Word-bounded so a key whose name merely contains the letters — there is none
 * today, but the browser owns this vocabulary, not us — is left untouched.
 */
export function formatCombo(combo: string, mac: boolean): string {
  return mac ? combo.replace(/\bAlt\b/g, "Option") : combo;
}

/** Whether the browser reports a Mac, which decides `Alt` versus `Option`. */
async function isMacPlatform(): Promise<boolean> {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return info.os === "mac";
  } catch {
    // A platform we could not read is not a reason to withhold the combination;
    // the un-transformed string is still the browser's own.
    return false;
  }
}

/**
 * The combination currently registered for the toggle command, or `null` when
 * there is none to print.
 *
 * `null` deliberately covers two cases that need the same words: the user has
 * cleared the binding, and the browser refused to tell us. A browser with the
 * commands surface restricted would otherwise put an error in the error region
 * on every single popup open, which says nothing the user can act on beyond what
 * `HELP_COPY.shortcut.none` already says.
 */
async function readToggleCombo(): Promise<string | null> {
  try {
    const commands = (await chrome.commands?.getAll()) ?? [];
    const raw = commands.find((command) => command.name === TOGGLE_COMMAND)?.shortcut ?? "";
    if (raw === "") return null;
    return formatCombo(raw, await isMacPlatform());
  } catch {
    return null;
  }
}

/**
 * Read the Pin_State from the browser — whether the extension's toolbar action
 * is currently pinned.
 *
 * Returns `true` (pinned), `false` (not pinned), or `null` (the read failed or
 * did not complete). No stored copy: the browser is the single source of truth,
 * read each time the value is needed (R11.10). Needs no additional permission
 * because `chrome.action.getUserSettings()` requires none (R16.15).
 */
export async function readPinState(): Promise<boolean | null> {
  try {
    const settings = await chrome.action.getUserSettings();
    return settings.isOnToolbar ?? null;
  } catch {
    return null;
  }
}

// ─── Pure decision functions ─────────────────────────────────────────────────
// No clock read, no storage read, no write, no throw. The order of the gates in
// ratingPromptDue mirrors the requirement-clause order so a failing test names
// the clause it contradicts.

// There is deliberately no star-to-destination router here any more.
//
// There was one: 4–5 stars opened the store's review page, 1–3 opened the support
// page instead. That is review gating, and the Chrome Web Store's Spam and Abuse
// policy forbids manipulating a listing's placement, naming the inflation of
// product ratings by illegitimate means. Routing only satisfied users to the page
// where a public rating can be left is exactly that: the visible score stops
// being what users think and becomes what the filter allowed through, and the
// penalty is removal from the store rather than a warning.
//
// Every star now opens the same page, and the support page is a permanent link in
// the footer that everyone can see. Nothing is lost — a reader with a problem
// takes the link that solves their problem — and the filter that created the
// exposure is gone.
//
// THE SAME RULE APPLIES TO THE PROMPT, and it is the more tempting place to break
// it. The natural design for "Enjoying it?" is Yes and No, where Yes reveals the
// review link and No reveals the support link. That is the identical offence in a
// friendlier costume: the review page is withheld from readers whose answer was
// wrong, so the public score stops being what users think of the extension and
// becomes what the question let through. It does not matter that the intent is to
// be helpful, and it does not matter that the unhappy reader is offered something
// good instead.
//
// `renderRatingPrompt` therefore shows both destinations at once, to everyone, on
// one showing. That is not a compromise forced by the policy — it is a better
// prompt. It asks a real question, it accepts both real answers in one press
// instead of two, and nobody has to declare a verdict on the extension before they
// are allowed to report a bug.
//
// If a future change reintroduces a sentiment step, the gate it creates has to be
// found and removed again. `settings-dom.test.ts` asserts the prompt has exactly
// three controls — two links and one dismiss — so a yes/no step fails a test
// rather than shipping.

/**
 * Pure. Four inputs, no clock, no storage, no throw. Gates in requirement-clause
 * order so a failing test names the clause:
 *
 * 1. resolved → false  (R9.7)
 * 2. installedAt absent / non-finite / negative → false  (R9.4)
 * 3. elapsed < MIN_TIME_SINCE_INSTALL_MS (negative elapsed → 0) → false  (R9.3, R9.5)
 * 4. usage < MIN_ENTRIES_BEFORE_PROMPT → false  (R9.6)
 * 5. promptsShown >= MAX_RATING_PROMPTS → false  (R9.8)
 * 6. otherwise → true  (R9.16)
 *
 * There was a sixth gate holding the second and third asks behind a 7-day and a
 * 30-day interval. `MAX_RATING_PROMPTS` is 1 now, so gate 5 catches everything
 * that gate would have, and an unreachable gate is worse than no gate: it reads
 * like a rule that is still doing something.
 *
 * Non-finite usage and promptsShown are coerced to 0 inside the function (R9.17).
 * installedAt is deliberately NOT coerced to 0, because 0 would make an install
 * from 1970 instantly eligible — that asymmetry is R9.4.
 */
export function ratingPromptDue(
  state: RatingState,
  usage: number,
  installedAt: number | null | undefined,
  now: number,
): boolean {
  // Gate 1: resolved → false (R9.7)
  if (state.resolved) return false;

  // Gate 2: installedAt absent, non-finite, or negative → false (R9.4)
  if (installedAt == null || !Number.isFinite(installedAt) || installedAt < 0) return false;

  // Coerce non-finite values to 0 (R9.17)
  const safeUsage = Number.isFinite(usage) ? usage : 0;
  const safePromptsShown = Number.isFinite(state.promptsShown) ? state.promptsShown : 0;

  // Gate 3: elapsed < MIN_TIME_SINCE_INSTALL_MS, treating negative elapsed as 0 (R9.3, R9.5)
  const elapsed = Math.max(0, now - installedAt);
  if (elapsed < MIN_TIME_SINCE_INSTALL_MS) return false;

  // Gate 4: usage < MIN_ENTRIES_BEFORE_PROMPT (R9.6)
  if (safeUsage < MIN_ENTRIES_BEFORE_PROMPT) return false;

  // Gate 5: promptsShown >= MAX_RATING_PROMPTS (R9.8). With the cap at 1 this is
  // also the "already asked" gate, and it holds even if the `resolved` write that
  // accompanies the showing was the half that failed.
  if (safePromptsShown >= MAX_RATING_PROMPTS) return false;

  // Gate 6: all gates passed (R9.16)
  return true;
}

/**
 * Pure. Whether a pin prompt is due in this popup opening.
 *
 * `pinned === null` means the read failed or did not complete → false, so a
 * broken read never burns one of the two showings and never produces an unwanted
 * ask (R16.4). `pinned === true` → false (R16.2). Then: dismissed → false,
 * shown >= MAX_PIN_PROMPTS → false (R16.8), shown === 1 with usage < 1 → false
 * (R16.7, the second ask needs a qualifying session), otherwise true (R16.5,
 * R16.6).
 */
export function pinPromptDue(
  pinned: boolean | null,
  state: PinPromptState,
  usage: number,
): boolean {
  // Read failed → no prompt (R16.4)
  if (pinned === null) return false;

  // Already pinned → no prompt (R16.2)
  if (pinned === true) return false;

  // Dismissed → no prompt
  if (state.dismissed) return false;

  // Cap reached → no prompt (R16.8)
  if (state.shown >= MAX_PIN_PROMPTS) return false;

  // Second showing requires at least one qualifying usage (R16.6, R16.7)
  if (state.shown >= 1 && usage < 1) return false;

  // All gates passed (R16.5, R16.6)
  return true;
}

/**
 * Pure. Which prompt wins when both could be due. The Pin_Prompt always takes
 * precedence (R9.19, R16.12), and "none" is a real answer.
 */
export function promptPrecedence(
  pinDue: boolean,
  ratingDue: boolean,
): "pin" | "rating" | "none" {
  if (pinDue) return "pin";
  if (ratingDue) return "rating";
  return "none";
}

/**
 * Render the help section into `root`, replacing whatever was there.
 *
 * A native `<details>` / `<summary>` pair rather than a button carrying
 * `aria-expanded`: the browser already gives a `<details>` an expand control that
 * is reachable by keyboard and exposes its own expanded state, where a
 * hand-rolled disclosure has to keep the attribute, the focus order, and the
 * visibility in step by hand. Nothing about the open state is stored, so the
 * popup opens collapsed every time (R14.6) and the options page opens expanded.
 *
 * `combo` is `null` for both "no combination is assigned" and "the browser would
 * not say", because those two need the same sentence; the shortcuts link stays
 * rendered either way (R13.5).
 *
 * Two independent sections, in this order: the tip, then the shortcut. Each is
 * its own `<section>` so both shells' existing divider rule separates them.
 *
 * The order and the separation both matter, and both are corrections. An earlier
 * version put the shortcut first and the tips in a `<details>` directly beneath
 * it, with no divider — which read as though the tips belonged *to* the shortcut,
 * as a sub-item of it. They are unrelated. A tip about the search bar is not part
 * of configuring a key.
 *
 * There is no explanation of why the shortcut is changed on the browser's page.
 * The reader does not care whose page it is; they want the keys changed, and the
 * control does that. Explaining the division of responsibility between an
 * extension and its browser is our problem, not theirs.
 *
 * `openShortcuts` is a parameter because the control cannot be an ordinary link:
 * navigation to a `chrome://` URL from a page is blocked, so it has to go through
 * the tabs API. The callback `renderSettings` passes already reports a failed
 * open into `[data-wfs-error]`.
 */
function renderHelpSection(
  doc: Document,
  root: Element,
  opts: { combo: string | null; openShortcuts: () => void },
): void {
  root.replaceChildren();

  // --- Tips, collapsed ------------------------------------------------------
  // A `<details>` collapsed on both surfaces. The row costs one line at rest and
  // the reader opens it when they want it, which is the point: the tip answers a
  // question ("where did the search bar go?") that only some readers will ever
  // ask, and a permanently open paragraph spends space on all of them to serve
  // those few.
  //
  // `<summary>` rather than a button with `aria-expanded`, because the browser
  // gives a native disclosure its keyboard behaviour and its expanded state for
  // free, and nothing about the open state is persisted.
  const tips = doc.createElement("section");
  tips.setAttribute("data-wfs-tips", "");

  const details = doc.createElement("details");
  details.className = "wfs-tips";
  details.setAttribute("data-wfs-help", "");

  const summary = doc.createElement("summary");
  summary.textContent = HELP_COPY.heading;
  details.appendChild(summary);

  for (const line of HELP_COPY.tips) {
    const item = doc.createElement("p");
    item.setAttribute("data-wfs-tip", "");
    item.textContent = line;
    details.appendChild(item);
  }

  tips.appendChild(details);
  root.appendChild(tips);

  // --- Shortcut, its own section -------------------------------------------
  const shortcutSection = doc.createElement("section");
  shortcutSection.setAttribute("data-wfs-shortcut-section", "");

  const shortcutRow = doc.createElement("div");
  shortcutRow.className = "wfs-shortcut";
  shortcutRow.setAttribute("data-wfs-shortcut-row", "");

  const shortcut = doc.createElement("span");
  shortcut.setAttribute("data-wfs-help-shortcut", "");
  if (opts.combo === null) {
    // Nothing to highlight, so no chip: a key cap around "No shortcut set" would
    // advertise a binding that does not exist.
    shortcut.textContent = HELP_COPY.shortcut.none;
  } else {
    shortcut.appendChild(doc.createTextNode(HELP_COPY.shortcut.prefix));

    // A real `<kbd>`, not a styled span. The element carries the meaning "these
    // are keys to press", which is exactly what the row is saying, and it is
    // what a screen reader and a future stylesheet both key off.
    //
    // The combination is inserted as text, printed exactly as the browser
    // reports it (via `formatCombo`), so the chip can never advertise keys the
    // browser does not honour.
    const keys = doc.createElement("kbd");
    keys.setAttribute("data-wfs-help-combo", "");
    keys.textContent = opts.combo;
    shortcut.appendChild(keys);
  }
  shortcutRow.appendChild(shortcut);

  const change = doc.createElement("button");
  change.type = "button";
  change.setAttribute("data-wfs-shortcut-link", "");
  change.textContent = HELP_COPY.shortcut.link;
  // A button rather than an anchor: there is no navigable href here. Chrome
  // blocks page navigation to `chrome://` URLs, and it exposes no API for an
  // extension to set its own shortcut, so opening the browser's own page in a
  // tab is the only action available.
  change.addEventListener("click", () => {
    opts.openShortcuts();
  });
  shortcutRow.appendChild(change);

  shortcutSection.appendChild(shortcutRow);
  root.appendChild(shortcutSection);
}

/**
 * Render the Rating_Footer into `host`, replacing its children.
 *
 * Two things on one row, and nothing else: five stars on the leading edge, the
 * privacy link on the trailing edge. No heading, no explanation, no second link.
 *
 * This replaced a version that stacked a heading, a star row, two paragraphs of
 * reassurance, a conditional third paragraph, and two links with no separator
 * between them — which is how "Write a review on the storeRead the privacy
 * policy" ended up rendering as one run-on link. The whole block was taller than
 * the settings it sat under. A row of stars is self-explanatory; anything
 * written beside it is noise.
 *
 * Selecting a star records it and then opens the store's review page — the same
 * page for every score. Routing 4–5 to the store and 1–3 to a support form is
 * review gating, so the support page is a permanent link in this row instead,
 * open to everyone whatever they scored.
 *
 * Because the click navigates, the group says so: `groupLabel` names the
 * destination for a screen reader and the same sentence is the group's `title`
 * for a pointer. The store asks that an extension hold no surprises, and an
 * unannounced tab is one.
 *
 * Five `role="radio"` buttons in one named `role="radiogroup"` with roving
 * tabindex, `aria-checked`, and per-star accessible names of the form
 * "3 stars out of 5". Native `<input type="radio">` was rejected because it
 * wraps on arrow keys (violating R6.3 — stop at 1 and 5) and selects on arrow
 * movement (violating R7.1 — would open a store tab from arrowing past 4). So
 * arrows move focus only, and Space/Enter/click selects.
 *
 * Re-renders when `watchRatingState` fires so the other surface's write is
 * reflected without a reload (R8.3).
 */
function renderRatingFooter(
  doc: Document,
  host: Element,
  ctx: {
    showError: (msg: string) => void;
    openInTab: (url: string, description: string) => Promise<void>;
  },
): void {
  /**
   * The stars value the store last confirmed it holds. Used to restore the
   * visual state on a rejected write (R8.8). Starts at 0 and is updated on
   * every successful read and write.
   */
  let confirmedStars = 0;

  /**
   * Render the footer from a known state, replacing the host's children.
   *
   * This is the RENDER path. It never routes (R7.9): a value read from storage
   * or arriving via `watchRatingState` calls only `paint`, never `activateStar`.
   */
  const paint = (state: RatingState, loadFailed: boolean): void => {
    host.replaceChildren();

    const wrapper = doc.createElement("div");
    wrapper.className = "wfs-footer";
    wrapper.setAttribute("data-wfs-footer", "");

    // --- "Rate us" + stars, together on the leading edge ---
    const lead = doc.createElement("div");
    lead.className = "wfs-footer__lead";

    const rateLabel = doc.createElement("span");
    rateLabel.className = "wfs-footer__label";
    rateLabel.setAttribute("data-wfs-rate-label", "");
    rateLabel.textContent = HELP_COPY.rating.label;
    lead.appendChild(rateLabel);

    // The group carries its accessible name as an attribute as well as showing
    // the visible label: the visible "Rate us" is not enough on its own, because
    // a screen reader reaching the group out of reading order needs the full
    // "out of five stars" phrasing to know what the five controls are.
    const group = doc.createElement("div");
    group.className = "wfs-stars";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", HELP_COPY.rating.groupLabel);
    // Stated rather than left to the default: the row is laid out horizontally, so
    // Left/Right are the primary axis. The keydown handler below accepts the
    // vertical pair as well, but a reader who checks the orientation should be
    // told the truth about how it looks.
    group.setAttribute("aria-orientation", "horizontal");
    // Same disclosure for a pointer. `aria-label` wins over `title` for the
    // accessible name, so this adds a tooltip without changing what is announced.
    group.setAttribute("title", HELP_COPY.rating.opensStore);

    const starBtns: HTMLButtonElement[] = [];

    /** Which star currently holds focus (0-indexed, so 0 = star 1). */
    let focusIdx = state.stars > 0 ? state.stars - 1 : 0;

    for (let i = 1; i <= MAX_STARS; i++) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "wfs-star";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-label", `${i} ${i === 1 ? "star" : "stars"} out of ${MAX_STARS}`);
      btn.textContent = "★";

      // Filled state: exactly `state.stars` controls are filled.
      if (i <= state.stars) btn.classList.add("is-filled");

      // Checked state: exactly one when stars > 0, none when 0.
      btn.setAttribute("aria-checked", state.stars === i ? "true" : "false");

      // Roving tabindex: 0 on the checked star (or star 1 when 0 stars).
      const isRovingFocus = state.stars > 0 ? state.stars === i : i === 1;
      btn.setAttribute("tabindex", isRovingFocus ? "0" : "-1");

      // Activation handler: click, Space, and Enter all land here via the
      // button's native behaviour. This is the ONLY place that routes (R7.9).
      btn.addEventListener("click", () => {
        void activateStar(i);
      });

      starBtns.push(btn);
      group.appendChild(btn);
    }

    /** Move roving focus to the star at `idx` (0-based). */
    const moveFocus = (idx: number): void => {
      starBtns[focusIdx].setAttribute("tabindex", "-1");
      focusIdx = idx;
      starBtns[focusIdx].setAttribute("tabindex", "0");
      starBtns[focusIdx].focus();
    };

    // Keyboard handling on the group: arrows move focus only, stop at 1 and 5.
    //
    // Both axes are accepted because the group is declared horizontal but a
    // reader cannot see that, and the vertical pair is mapped the way the ARIA
    // Authoring Practices specify for a vertical radiogroup: Down advances, Up
    // goes back. It used to be inverted — Up advanced — which meant arrowing
    // "up" walked toward five stars and arrowing "down" walked toward one.
    group.addEventListener("keydown", (e: KeyboardEvent) => {
      const lastIdx = MAX_STARS - 1;
      let next = focusIdx;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        next = Math.min(focusIdx + 1, lastIdx); // stop at the last star
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        next = Math.max(focusIdx - 1, 0); // stop at star 1 (index 0)
      } else {
        return; // Let other keys (Space, Enter) bubble to the button's click.
      }
      e.preventDefault();
      if (next !== focusIdx) moveFocus(next);
    });

    lead.appendChild(group);
    wrapper.appendChild(lead);

    // --- Links (trailing edge) ---
    // Ordinary anchors, because unlike the shortcuts page these are real https
    // URLs the browser can navigate to.
    const links = doc.createElement("div");
    links.className = "wfs-footer__links";

    /**
     * The support page, permanently visible to everyone.
     *
     * This is what replaces the old star-gated route to it. Shown unconditionally
     * and never chosen on the reader's behalf: whoever has a problem takes it,
     * whatever they scored the extension, and nobody's access to the public review
     * page depends on their opinion first.
     */
    const feedbackLink = doc.createElement("a");
    feedbackLink.href = SUPPORT_URL;
    feedbackLink.target = "_blank";
    feedbackLink.rel = "noopener noreferrer";
    feedbackLink.textContent = HELP_COPY.rating.feedbackLink;
    feedbackLink.setAttribute("data-wfs-support-link", "");
    links.appendChild(feedbackLink);

    const privacyLink = doc.createElement("a");
    privacyLink.href = PRIVACY_POLICY_URL;
    privacyLink.target = "_blank";
    privacyLink.rel = "noopener noreferrer";
    privacyLink.textContent = HELP_COPY.rating.privacyLink;
    privacyLink.setAttribute("data-wfs-privacy-link", "");
    links.appendChild(privacyLink);

    wrapper.appendChild(links);

    // If the store could not be reached, all five are operable at 0 (R8.7).
    if (loadFailed) {
      ctx.showError("Could not load the star rating; showing defaults.");
    }

    host.appendChild(wrapper);
  };

  /**
   * ACTIVATION HANDLER. This is the one path that routes (R7.9).
   *
   * Order (R7.8): write the whole RatingState with the new stars and
   * resolved: true → re-render from the stored value → then route.
   * Persist before any navigation.
   *
   * A rejected write restores the previously stored stars, reports into the
   * error region, and routes nowhere (R8.8).
   */
  const activateStar = async (selected: number): Promise<void> => {
    // Snapshot the stars confirmed in storage before this attempt.
    const previousStars = confirmedStars;

    // Build the full record to persist. Reading the current record first to
    // preserve promptsShown and lastPromptAt, then overwriting stars and resolved.
    const { state: current, loadFailed } = await getRatingState();
    if (loadFailed) {
      // An unavailable store renders 0 stars, all operable, with error (R8.7).
      paint({ ...current, stars: 0 }, true);
      return;
    }

    const next: RatingState = {
      ...current,
      stars: selected,
      resolved: true,
    };

    // 1. Persist.
    const result = await setRatingState(next);
    if (!result.ok) {
      // Rejected write: restore the previously stored stars, report, route
      // nowhere (R8.8).
      confirmedStars = previousStars;
      paint({ ...current, stars: previousStars }, false);
      ctx.showError("Your rating was not saved. Please try again later.");
      return;
    }

    // The write succeeded — update our confirmed baseline.
    confirmedStars = selected;

    // 2. Re-render from the stored value (not from the selection directly).
    paint(next, false);

    // 3. Open the store's review page — the same page for every star, because
    // choosing the destination from the score is review gating. See the note above
    // the decision functions. `selected` is used to record the rating and for
    // nothing else; it never reaches a URL (R11.4, R11.5).
    //
    // `openInTab` races a timeout, so a refused or silently dropped open reports
    // into the error region. The stored rating is untouched either way: the write
    // above already succeeded, and a failed tab open is not a reason to forget the
    // rating (R7.6).
    void ctx.openInTab(REVIEW_URL, "store review page");
  };

  // Initial render from storage.
  void getRatingState().then(({ state, loadFailed }) => {
    confirmedStars = state.stars;
    paint(state, loadFailed);
  });

  // Re-render when the other surface writes (R8.3, R10.5).
  // This is the render path — it must never route (R7.9).
  watchRatingState((state) => {
    confirmedStars = state.stars;
    paint(state, false);
  });
}

/**
 * Render the one-time Rating_Prompt into `host`. Called ONLY when the rating
 * scheduler has already decided a prompt is due — this function never queries the
 * scheduler itself.
 *
 * ## Shape
 *
 * One question and both answers, together:
 *
 *     Enjoying it? Rate it, or tell me what is not working.
 *     [ Rate it ]  [ Something is wrong ]  [ No thanks ]
 *
 * Both destinations are visible to every reader on the one showing. **This must
 * not become a two-step that asks first and then decides which link the answer
 * has earned.** That shape — happy readers to the store, unhappy readers to a
 * private support form — is review gating, and the note above `ratingPromptDue`
 * records why it was taken out of this extension once already: the Chrome Web
 * Store's Spam and Abuse policy forbids inflating a listing's rating by
 * illegitimate means, the penalty is removal rather than a warning, and filtering
 * who is allowed to reach the review page is exactly that. Offering both to
 * everybody costs nothing and is not a policy risk.
 *
 * ## Once ANSWERED, not once rendered
 *
 * `resolved` is written when one of the three controls is used, not when the prompt
 * mounts. Mount-time was the original design, on the grounds that it made "once"
 * true even for the reader who closes the popup without touching anything and that
 * the links then needed no write of their own. Both were true, and it was still the
 * wrong trade: the single lifetime ask was spent on a popup opened to flip a
 * checkbox, so the row vanished on the next opening and the question had never been
 * put to anyone. The prompt now keeps its place across openings until it has an
 * answer to store. `promptsShown` goes into the same record as a second,
 * independent guard: if only one of the two survives, gate 5 of `ratingPromptDue`
 * still catches the repeat.
 *
 * That moves the write into a context that is about to be destroyed — the popup
 * closes the moment a link opens its tab — so the write must be one storage call
 * dispatched from inside the click handler, never a read followed by a write. The
 * record is therefore loaded once on mount and held; the handler merges into that
 * copy. A click before the load lands (or after it failed) falls back to the
 * read-then-write path, which may be lost, and losing it costs one extra showing.
 *
 * A failed write is not reported to the reader. There is nothing for them to do
 * about it and nothing broken from where they are standing; the only consequence
 * is that the prompt appears once more.
 *
 * ## Hosting
 *
 * `host` MUST NOT be the rating footer's own host. The footer repaints by replacing
 * all of its children whenever the Rating_State changes, and this function changes
 * the Rating_State, so a shared host means the prompt is destroyed by its own write.
 * That used to fire on mount, which made it a prompt nobody ever saw; it now fires
 * on the answer, which would make it a row that disappears mid-press. Neither is
 * acceptable, and the separation is still the fix: `renderSettings` provides
 * `[data-wfs-prompt-host]` for exactly this reason.
 *
 * Ordinary anchors, opened by the browser. No `chrome.tabs`, so no permission and
 * no failure path — and middle-click and "open in new tab" work, which they do not
 * on a button. No `chrome.notifications` or any notification API: the prompt
 * renders in the extension's own DOM only (R9.10).
 */
export function renderRatingPrompt(
  doc: Document,
  host: Element,
  // `showError` is accepted but deliberately unused: it keeps the signature the
  // same as `renderPinPrompt`'s so the popup can treat the two identically, and
  // leaves the hook in place for a future action that can actually fail.
  _ctx: {
    showError: (msg: string) => void;
  },
): void {
  const prompt = doc.createElement("div");
  prompt.className = "wfs-prompt";
  prompt.setAttribute("data-wfs-prompt", "");
  // Named by its own question rather than announced as an alert. The prompt is
  // useful, not urgent, and it must not interrupt whatever a screen reader is
  // already reading out on a surface the reader opened for another reason.
  prompt.setAttribute("role", "group");

  const msg = doc.createElement("p");
  msg.id = "wfs-rating-prompt-message";
  msg.textContent = HELP_COPY.rating.prompt;
  prompt.appendChild(msg);
  prompt.setAttribute("aria-labelledby", msg.id);

  const actions = doc.createElement("div");
  actions.className = "wfs-prompt__actions";

  // The record as it stood when the prompt mounted, so the answer is one storage
  // call rather than a read the closing popup can lose. `null` until the load
  // lands, and left `null` if it failed — `resolve` treats both the same.
  let loaded: RatingState | null = null;
  void (async () => {
    const { state, loadFailed } = await getRatingState();
    if (!loadFailed) loaded = state;
  })();

  // Guards a double answer: middle-clicking a link records and leaves the popup
  // open, so the same control can be pressed again, and a second write would
  // re-clamp values that are already at their bound for no reason.
  let answered = false;

  /**
   * Record the answer. One whole-record write, both guards at once, from inside the
   * event handler so the message is dispatched before the popup goes away.
   */
  const resolve = (): void => {
    if (answered) return;
    answered = true;

    const merge = (state: RatingState): RatingState => ({
      ...state,
      promptsShown: Math.min(state.promptsShown + 1, MAX_RATING_PROMPTS),
      lastPromptAt: Date.now(),
      resolved: true,
    });

    if (loaded) {
      void setRatingState(merge(loaded));
      return;
    }

    // The mount-time load has not landed or could not be read. Best effort: read
    // now and merge. If this is a link press the popup may die first and the write
    // is lost, which costs one more showing — the same failure a rejected write
    // has always had. Nothing to merge into is still not a reason to overwrite a
    // record we could not read.
    void (async () => {
      const { state, loadFailed } = await getRatingState();
      if (loadFailed) return;
      await setRatingState(merge(state));
    })();
  };

  /** One action: a real link, styled like the buttons beside it. */
  const addLink = (url: string, text: string, marker: string): void => {
    const link = doc.createElement("a");
    link.className = "wfs-prompt__action";
    link.setAttribute("href", url);
    link.setAttribute("target", "_blank");
    // `noopener` is the one that matters — it denies the opened page a handle back
    // to this one. `noreferrer` follows because there is no reason to tell either
    // destination which extension surface the reader came from.
    link.setAttribute("rel", "noopener noreferrer");
    link.setAttribute(marker, "");
    link.textContent = text;
    // Taking a destination is an answer, so it is what records one. `auxclick` as
    // well as `click` because a middle-click opens the tab without firing `click`,
    // and a reader who opened the review page in a background tab has answered
    // just as clearly as one who left for it. Middle button only: `auxclick` also
    // fires for the right button, and opening a context menu is not an answer.
    link.addEventListener("click", () => resolve());
    link.addEventListener("auxclick", (event) => {
      if ((event as MouseEvent).button === 1) resolve();
    });
    actions.appendChild(link);
  };

  // Rate it. The same destination the star row opens, and the same destination
  // the other link's reader could take if they wanted to.
  addLink(REVIEW_URL, HELP_COPY.rating.promptRate, "data-wfs-prompt-rate");
  // Something is wrong. Not a consolation prize for a low opinion — it is offered
  // on equal footing, to everyone, on the same showing.
  addLink(SUPPORT_URL, HELP_COPY.rating.promptFeedback, "data-wfs-prompt-feedback");

  // No thanks. The third real answer, not a way of postponing: it records like the
  // other two and clears the row from the surface in front of the reader. The
  // removal is unconditional — a rejected write is not the reader's problem, and
  // leaving the row up after they declined it would be the worse failure.
  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = HELP_COPY.rating.promptDismiss;
  dismiss.setAttribute("data-wfs-prompt-dismiss", "");
  dismiss.addEventListener("click", () => {
    resolve();
    prompt.remove();
  });
  actions.appendChild(dismiss);

  prompt.appendChild(actions);

  // In the DOM before anything is recorded, so a rejected write cannot cost the
  // reader the prompt (R9.11).
  host.appendChild(prompt);
}

/**
 * Render the Pin_Prompt into the popup's `#pin-prompt` container.
 *
 * Shows the shared pin steps and pinning reason from {@link HELP_COPY}, plus
 * exactly one keyboard-reachable dismiss control.
 *
 * This function does NOT decide whether to show — that is `pinPromptDue`'s job
 * in the popup's prompt-decision logic (task 11.4). This function only renders
 * and counts the showing.
 *
 * Counting a showing happens AFTER the element is in the DOM (R16.9): one
 * `setPinPromptState` call increments `shown` capped at `MAX_PIN_PROMPTS`.
 *
 * When the Pin_State reads pinned: the caller records the state as dismissed
 * before calling this function, and this function is not called at all. But if
 * the caller discovers pinned after deciding to render, it records
 * `{ ...state, dismissed: true }` so no future prompt is shown.
 *
 * Dismiss control behaviour:
 * - Removes the prompt on the same render pass (no reload) (R16.10)
 * - Persists `{ ...state, dismissed: true }` (R16.10)
 * - Changes no other stored value (R16.11)
 * - On a rejected write: leaves the prompt visible and reports into the error
 *   region — this differs from the First_Run_Section (which removes on failure)
 *   because here the user has not dismissed it and may still act
 *
 * Never rendered on the options page. No notification API (R9.10).
 */
export function renderPinPrompt(
  doc: Document,
  root: Element,
  ctx: { showError: (msg: string) => void },
): void {
  root.replaceChildren();

  const prompt = doc.createElement("div");
  prompt.className = "wfs-prompt";
  prompt.setAttribute("data-wfs-pin-prompt", "");

  // One line, matching the welcome on the options page. A three-step numbered
  // list inside a 320 px popup was most of the popup, to say something the
  // reader's own toolbar shows them faster.
  const heading = doc.createElement("p");
  heading.className = "wfs-prompt__title";
  heading.setAttribute("data-wfs-pin-reason", "");
  heading.textContent = HELP_COPY.pinPrompt.title;
  prompt.appendChild(heading);

  // Dismiss control — exactly one, keyboard-reachable (native button), carrying
  // a visible text label (R16.10).
  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = HELP_COPY.pinPrompt.dismiss;
  dismiss.setAttribute("data-wfs-pin-dismiss", "");
  dismiss.addEventListener("click", () => {
    void (async () => {
      const { state, loadFailed } = await getPinPromptState();
      if (loadFailed) {
        // Cannot read the current record — leave the prompt visible and report.
        ctx.showError("Could not save the pin prompt dismissal. Please try again.");
        return;
      }
      const next: PinPromptState = { ...state, dismissed: true };
      const result = await setPinPromptState(next);
      if (!result.ok) {
        // Rejected write: leave the prompt visible and report into the error
        // region. This differs from the First_Run_Section: here the user has not
        // dismissed it successfully, so re-showing is correct.
        ctx.showError("Could not save the pin prompt dismissal. Please try again.");
        return;
      }
      // Write succeeded — remove the prompt on the same pass (R16.10).
      root.replaceChildren();
    })();
  });
  prompt.appendChild(dismiss);

  // Append to the DOM first, then count the showing (R16.9).
  root.appendChild(prompt);

  // Record the showing: increment `shown` capped at MAX_PIN_PROMPTS.
  // Fire-and-forget: a failed write leaves the prompt visible (it already is)
  // and reports into the error region so the user knows something went wrong.
  void (async () => {
    const { state, loadFailed } = await getPinPromptState();
    if (loadFailed) {
      ctx.showError("Could not record the pin prompt showing.");
      return;
    }
    const next: PinPromptState = {
      ...state,
      shown: Math.min(state.shown + 1, MAX_PIN_PROMPTS),
    };
    const result = await setPinPromptState(next);
    if (!result.ok) {
      ctx.showError("Could not record the pin prompt showing.");
    }
  })();
}

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
  /**
   * Accessible name, for a control whose visible text does not stand alone out of
   * context. Omit it when the visible text already does, and the `<label>` supplies
   * the name.
   *
   * Whatever this returns MUST contain the visible text verbatim. WCAG 2.5.3
   * (Label in Name) requires the accessible name to include the visible label, so
   * that someone saying "scrollable mode" to a voice-control tool actually hits
   * this control. Both entries here previously replaced the visible text with a
   * paraphrase instead of extending it: "Scrollable mode" announced as "Scrollable
   * windowed fullscreen on YouTube", which shares no full phrase with what is on
   * screen.
   */
  aria?: (siteLabel: string) => string;
  /** Optional explanation rendered beneath. */
  hint?: string;
}> = [
  {
    field: "autoApply",
    marker: "data-wfs-autoapply",
    // Already names the action and the site, so the visible label is the
    // accessible name. No `aria` override.
    text: (siteLabel) => `Automatically enter windowed fullscreen on ${siteLabel}`,
  },
  {
    field: "scrollable",
    marker: "data-wfs-scrollable",
    text: () => "Scrollable mode",
    // Extends the visible "Scrollable mode" rather than replacing it, so the
    // announced name still opens with the words on screen.
    aria: (siteLabel) => `Scrollable mode — windowed fullscreen on ${siteLabel}`,
    hint:
      "The video still fills the screen when you enter, but the page keeps scrolling — " +
      "scroll down for the description and comments, scroll back up for the video. " +
      "Leave this off to lock the page to the video alone.",
  },
];

/**
 * Render the settings controls into `root`: the help section, one auto-apply
 * checkbox per supported site, the donation link, and a privacy-policy footer
 * link.
 *
 * The same function backs both the standalone options page and the popup, which
 * is why the heading is optional — the popup already has a title of its own. That
 * is the ONLY difference between the two: they get the same controls in the same
 * order, and the help section is collapsed on both.
 *
 * There used to be a `surface: "options" | "popup"` option here, described as
 * controlling whether the help section started collapsed. Nothing read it — both
 * surfaces collapse — so it was removed rather than left as a parameter that
 * looked like it did something.
 *
 * Each checkbox loads its effective value (stored, else the documented default).
 * On a failed write the control reverts to the last persisted value and an error
 * is shown, so the UI never claims a setting was saved when it was not.
 */
export function renderSettings(
  doc: Document,
  root: Element,
  options: { showHeading: boolean },
): void {
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
   * Open a URL in a new focused tab. Used for the shortcuts page, the
   * donation page, and the rating footer's review link — anchor navigation
   * to `chrome://` URLs is blocked, and this lets us report a failure instead
   * of doing nothing visible.
   *
   * A REVIEW_OPEN_TIMEOUT_MS race ensures a stalled or silent open reports
   * into the error region rather than leaving the user watching a dead control
   * (R7.6). Applies to all opens: the timeout cost is negligible for pages
   * that respond normally, and a consistent deadline is simpler to reason about
   * than a per-call flag.
   */
  const openInTab = async (url: string, description: string): Promise<void> => {
    try {
      const tabPromise = chrome.tabs.create({ url, active: true });
      const result: "ok" | "no-tab" | "timeout" = await Promise.race([
        tabPromise.then((tab): "ok" | "no-tab" => (tab ? "ok" : "no-tab")),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), REVIEW_OPEN_TIMEOUT_MS),
        ),
      ]);
      if (result !== "ok") {
        showError(`Could not open the ${description}. Please try again later.`);
      }
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

  // --- Help, which now owns the keyboard shortcut ---------------------------
  // The standalone "Keyboard shortcut" section this replaces stated the rebind
  // rule in its own words. Two statements of one fact drift, and R14.1 gives
  // `HELP_COPY` the only copy of it, so the link moved in here beside the
  // sentence that refers to it.
  //
  // Filled once the combination is known rather than painted with
  // `HELP_COPY.shortcut.none` and corrected a moment later: a flash of "no
  // shortcut set" on a browser that does have one is worse than the rows arriving
  // a turn late. A plain `<div>` host, because `renderHelpSection` emits its own
  // two `<section>` elements and a section wrapping sections would draw a divider
  // around the pair as though they were one thing.
  const helpHost = doc.createElement("div");
  helpHost.setAttribute("data-wfs-help-section", "");
  root.appendChild(helpHost);
  void readToggleCombo()
    .then((combo) => {
      try {
        renderHelpSection(doc, helpHost, {
          combo,
          openShortcuts: () => {
            void openInTab(SHORTCUTS_URL, "keyboard shortcuts page");
          },
        });
      } catch {
        showError("Help section failed to render.");
      }
    })
    .catch(() => {
      showError("Help section failed to render.");
    });

  // --- Donation -----------------------------------------------------------
  const donationSection = addSection("data-wfs-donation-section", "Buy me a coffee");
  const donationLink = doc.createElement("a");
  donationLink.href = DONATION_URL;
  donationLink.rel = "noopener noreferrer";
  donationLink.textContent = "\u2615 Enjoying this? Help keep it alive";
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
      // Only when the visible text needs extending. Left off, the wrapping
      // `<label>` names the control, which is both correct and what WCAG 2.5.3
      // wants — see the note on `aria` in SITE_TOGGLES.
      const ariaName = toggle.aria?.(label);
      if (ariaName) checkbox.setAttribute("aria-label", ariaName);

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
        // Pointed at by the checkbox rather than left as a loose sibling. The
        // paragraph explains what the setting does, and a screen-reader user who
        // tabs straight to the control never reaches a sibling paragraph in
        // reading order, so without the association the explanation was invisible
        // to exactly the reader most likely to need it.
        //
        // The id has to be unique across the page: both surfaces render one
        // section per site, so it is scoped by site and field.
        const hintId = `wfs-hint-${siteId}-${String(toggle.field)}`;
        hint.id = hintId;
        hint.textContent = toggle.hint;
        checkbox.setAttribute("aria-describedby", hintId);
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

  // --- Rating prompt host --------------------------------------------------
  // The prompt gets its own node, deliberately NOT the footer's.
  //
  // It used to mount straight into `[data-wfs-footer-host]`, which was a bug:
  // `renderRatingFooter`'s `paint` opens with `host.replaceChildren()`, and
  // `renderRatingPrompt` counts its own showing by writing the Rating_State.
  // `chrome.storage.onChanged` fires in the writing context too, so that write
  // reached `watchRatingState` in this very page, repainted the footer, and
  // wiped the prompt that had just been appended — while still burning one of
  // the three lifetime asks. Two hosts means the footer owns its subtree
  // completely and can repaint as often as it likes without touching the prompt.
  const promptHost = doc.createElement("section");
  promptHost.setAttribute("data-wfs-prompt-host", "");
  root.appendChild(promptHost);

  // --- Rating footer (last region, R6.1) ----------------------------------
  // The standalone privacy link that lived here is now inside the footer, so
  // exactly one remains (R6.4). `[data-wfs-status]` and `[data-wfs-error]` sit
  // immediately above it.
  const footerHost = doc.createElement("section");
  footerHost.setAttribute("data-wfs-footer-host", "");
  root.appendChild(footerHost);
  try {
    renderRatingFooter(doc, footerHost, { showError, openInTab });
  } catch {
    showError("Rating footer failed to render.");
  }
}

/**
 * Options-page entry point.
 *
 * Settings only. The first-run greeting that used to render above these controls
 * is its own page now (§13), so nothing here is conditional on how the reader
 * arrived.
 */
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

  // --- Prompt decision (R9.19, R16.1, R16.2, R16.4, R16.5–R16.8, R16.12) ---
  // Async step after the initial paint: read the Pin_State, compute both
  // decisions, ask promptPrecedence, render at most one prompt, then record
  // that showing. A failed or stalled read never blocks the popup — the
  // paint-early-repaint-later structure stays intact.
  const pinPromptRoot = document.getElementById("pin-prompt");
  void (async () => {
    try {
      const pinned = await readPinState();

      // Read the supporting state needed for both decisions.
      const { state: pinState, loadFailed: pinLoadFailed } = await getPinPromptState();
      const ratingState = await getRatingState();
      const usage = await getUsageCounter();
      const installedAt = await getInstallTimestamp();
      const now = Date.now();

      // When Pin_State reads pinned: record dismissed so no future prompt shows
      // (design: "record { ...state, dismissed: true } on the PinPromptState").
      if (pinned === true && !pinLoadFailed) {
        const next: PinPromptState = { ...pinState, dismissed: true };
        await setPinPromptState(next);
      }

      // Compute the two prompt decisions.
      // pinPromptDue returns false when pinned === null (failed read, R16.4) or
      // pinned === true (already pinned, R16.2).
      const pinDue = pinPromptDue(pinned, pinState, usage);
      const ratingDue = ratingPromptDue(ratingState.state, usage, installedAt, now);

      // Ask which prompt wins — at most one per opening (R9.19, R16.12).
      const winner = promptPrecedence(pinDue, ratingDue);

      // The error region lives inside #settings; grab it for reporting.
      const errorEl = settings?.querySelector("[data-wfs-error]");
      const showError = (msg: string): void => {
        if (errorEl) errorEl.textContent = msg;
      };

      if (winner === "pin" && pinPromptRoot) {
        try {
          renderPinPrompt(document, pinPromptRoot, { showError });
        } catch {
          showError("Pin prompt failed to render.");
        }
      } else if (winner === "rating") {
        // The Rating_Prompt mounts in its own host directly above the footer —
        // NOT in `[data-wfs-footer-host]`. The footer repaints itself on every
        // Rating_State change, including the one this prompt writes to record
        // the reader's answer, so sharing a host destroyed the prompt.
        const promptHost = settings?.querySelector("[data-wfs-prompt-host]");
        if (promptHost) {
          try {
            renderRatingPrompt(document, promptHost, { showError });
          } catch {
            showError("Rating prompt failed to render.");
          }
        }
      }
      // winner === "none" → render neither prompt.
    } catch {
      // Top-level catch: a catastrophic failure in the prompt decision renders
      // no prompt and leaves all state unchanged — the popup stays functional.
    }
  })();

  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab?.id;
    url = tab?.url;
    paint();

    response = await askContentScript(tabId, { type: "GET_STATUS" });
    paint();
  })();
}

// ===========================================================================
// §13  Welcome page (post-install)
// ===========================================================================
//
// The tab the install event opens, and the only surface with no controls on it.
// Three regions: thanks, the pin ask, and four usage hints. No preferences, no
// donation link, no rating row — the reader has been using this extension for
// zero seconds, so there is nothing yet to configure or rate.
//
// It is a separate page rather than a mode of the options page because the two
// have opposite jobs. Settings are a reference you visit on purpose; a welcome is
// read once and never again. Sharing one page meant the greeting had to be
// dismissible, had to persist that dismissal, and still put every checkbox in
// front of a first-time reader.

/**
 * Render the welcome page into `root`.
 *
 * `pinned` is the browser's own answer from {@link readPinState}: `true` swaps
 * the ask for one line of acknowledgement, and `false` or `null` shows the ask.
 * A failed read shows it, which is the right way to fail — a redundant nudge to
 * someone who already pinned costs a glance, where hiding it from someone who
 * has not costs them the feature's fastest entry point.
 *
 * `combo` is the live shortcut, `null` when there is none or the browser would
 * not say; the keyboard hint changes wording rather than disappearing, so the
 * hint list is the same length either way.
 */
export function renderWelcome(
  doc: Document,
  root: Element,
  opts: { pinned: boolean | null; combo: string | null; siteLabel: string },
): void {
  root.replaceChildren();

  const title = doc.createElement("h1");
  title.setAttribute("data-wfs-welcome-title", "");
  title.textContent = HELP_COPY.welcome.title;
  root.appendChild(title);

  const lead = doc.createElement("p");
  lead.className = "wfs-welcome__lead";
  lead.textContent = HELP_COPY.welcome.lead;
  root.appendChild(lead);

  // --- The ask -------------------------------------------------------------
  // One block, styled as the loudest thing on the page, because it is the only
  // thing on the page being asked of the reader.
  const pin = doc.createElement("section");
  pin.className = "wfs-welcome__pin";
  pin.setAttribute("data-wfs-welcome-pin", "");

  if (opts.pinned === true) {
    const done = doc.createElement("p");
    done.className = "wfs-welcome__pin-done";
    done.textContent = HELP_COPY.welcome.pinDone;
    pin.appendChild(done);
  } else {
    // A `<strong>` inside the heading rather than a heading styled bold: the
    // emphasis is the point of the sentence, not a decoration on it, so it is
    // carried by an element a screen reader also announces.
    const callout = doc.createElement("h2");
    callout.className = "wfs-welcome__pin-callout";
    const strong = doc.createElement("strong");
    strong.textContent = HELP_COPY.welcome.pinCallout;
    callout.appendChild(strong);
    pin.appendChild(callout);

    const how = doc.createElement("p");
    how.className = "wfs-welcome__pin-how";
    how.setAttribute("data-wfs-pin-reason", "");
    how.textContent = HELP_COPY.welcome.pinHow;
    pin.appendChild(how);
  }
  root.appendChild(pin);

  // --- Hints ---------------------------------------------------------------
  const hints = doc.createElement("section");
  hints.className = "wfs-welcome__hints";
  hints.setAttribute("data-wfs-welcome-hints", "");

  const hintsHeading = doc.createElement("h2");
  hintsHeading.textContent = HELP_COPY.welcome.hintsHeading;
  hints.appendChild(hintsHeading);

  const list = doc.createElement("ul");

  /** One hint. Text nodes and elements, so the keyboard hint can carry a `<kbd>`. */
  const addHint = (...parts: Array<string | Node>): void => {
    const item = doc.createElement("li");
    item.setAttribute("data-wfs-hint", "");
    for (const part of parts) {
      item.appendChild(typeof part === "string" ? doc.createTextNode(part) : part);
    }
    list.appendChild(item);
  };

  // The site label comes from the adapter registry, so §13 names no site.
  addHint(HELP_COPY.welcome.hintAt(opts.siteLabel));

  if (opts.combo === null) {
    addHint(HELP_COPY.welcome.hintKeyNone);
  } else {
    // A real `<kbd>`, printed exactly as the browser reports it, so the page can
    // never advertise keys the browser does not honour.
    const keys = doc.createElement("kbd");
    keys.setAttribute("data-wfs-help-combo", "");
    keys.textContent = opts.combo;
    addHint(`${HELP_COPY.welcome.hintKeyPrefix} `, keys, ".");
  }

  addHint(HELP_COPY.welcome.hintComments);
  addHint(HELP_COPY.welcome.hintEscape);

  hints.appendChild(list);
  root.appendChild(hints);
}

/**
 * Welcome-page entry point.
 *
 * Paints once, after both reads resolve. Unlike the popup there is nothing to be
 * responsive about — the tab has just opened on top of whatever the reader was
 * doing, and repainting the pin ask a moment after it appeared would be the most
 * distracting thing on an otherwise still page. Both reads are local and fast;
 * either failing still paints, because {@link renderWelcome} treats `null` as
 * "show the ask" and "no shortcut".
 */
export function startWelcomePage(): void {
  // `#welcome`, not `#app`: the product mark is painted by the shell so the tab is
  // never briefly blank, and `renderWelcome` replaces its root's children.
  const root = document.getElementById("welcome");
  if (!root) return;

  // The first supported site's label, which is what the hint names. There is one
  // today; if a second is ever added, the greeting keeps naming the first rather
  // than listing them, because a welcome is not a compatibility table.
  const siteLabel = supportedSites()[0]?.label ?? "a supported video site";

  void (async () => {
    const [pinned, combo] = await Promise.all([readPinState(), readToggleCombo()]);
    try {
      renderWelcome(document, root, { pinned, combo, siteLabel });
    } catch {
      // Nothing to report into: this page has no error region, on purpose. A
      // greeting that cannot render is a broken build, which the console shows.
    }

    // Record that the welcome was seen, changing no other stored value. Nothing
    // gates on it today — see `FirstRunState` — so a failed write is silent
    // rather than putting an error on a page whose whole job is to say thanks.
    const { state, loadFailed } = await getFirstRunState();
    if (!loadFailed && !state.welcomeSeen) {
      await setFirstRunState({ ...state, welcomeSeen: true });
    }
  })();
}

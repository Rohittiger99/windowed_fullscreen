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
 *   toolbar popup     -> startPopup()
 *   welcome page      -> startWelcomePage()
 *
 * Four surfaces, not five. There was an options page until 2.0.0; `manifest.json`
 * now points `options_ui` at `popup/index.html`, so both the toolbar button and the
 * browser's own Options item land on the popup.
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
 *  1. No top-level side effects. The four `start*` entry points listed above are
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
 *  6. One thing leaves the device: the licence key, and only for a reader who has
 *     entered one. No `chrome.storage.sync`, no analytics, and no network request
 *     at all without a key. See §14 — and note that the same promise is published
 *     in `README.md`, `store-assets/LISTING.md`, the store listing, the store's
 *     data disclosure, and the privacy policy, so widening it means changing all
 *     of them in the same commit.
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
 *   §11 Settings UI (the popup's preferences tree)
 *   §12 Popup
 *   §13 Welcome page (post-install)
 *   §14 Entitlement (Pro tier)
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

  /**
   * Locate the media element being watched, for frame capture. Null while it has
   * not mounted, which simply leaves the capture control unavailable.
   *
   * Optional: a site the extension cannot capture from omits it, and the capture
   * control is never injected there.
   */
  findVideo?(doc: Document): HTMLVideoElement | null;

  /**
   * Which channel, author, or uploader this page belongs to, for the per-channel
   * auto-apply rules. Null when the page has not rendered it yet.
   *
   * The `id` must be something the site will still report identically next month —
   * a handle or an account id, never a display name and never a URL. A rule keyed
   * on anything renameable stops applying with nothing said about it.
   *
   * Optional: a site with no notion of a channel omits it, and the rules list is
   * simply not offered for that site.
   */
  readChannel?(doc: Document): ChannelRef | null;

  /**
   * A filename stem for a captured frame — no extension, no path, no spaces.
   * Null falls back to a generic timestamped name.
   *
   * Site knowledge, hence here: it is the site's own id for the thing being
   * watched that makes a saved frame findable again.
   */
  readCaptureName?(doc: Document): string | null;

  /**
   * The CSS declaring the reader's chosen dock widths, or `""` when both are at
   * their defaults.
   *
   * The core owns the `<style>` element and when to rewrite it; the adapter owns
   * what goes in it, because the custom properties being overridden are declared
   * by this adapter's own selectors. Returning CSS rather than accepting a width
   * is what keeps invariant 2 intact: the generic resize code never learns that a
   * dock is `#below` or `#chat`.
   *
   * An adapter whose docks are not resizable omits this, and the resize grips are
   * never mounted.
   */
  getDockWidthCss?(widths: DockWidths): string;

  /**
   * The width one dock is occupying right now, in CSS px, or null when that dock
   * is not on screen.
   *
   * A drag has to start from what the reader can see, and until they have chosen a
   * width there is nothing stored to start from — the sheet's own responsive
   * default is a `clamp()`, and a custom property holding one reads back as the
   * literal `clamp(...)` text rather than a number, so it cannot be measured from
   * the outside. Measuring the docked element is the only honest answer, and which
   * element that is belongs here.
   */
  measureDockWidth?(doc: Document, dock: DockId): number | null;

  /**
   * The docks this site actually has, outboard to inboard. Omitted, or empty, means
   * no dock is resizable here.
   *
   * §9 used to iterate a hard-coded `["panel", "chat"]` when mounting the grips,
   * which meant the generic resize code knew how many docks a site has and which —
   * site knowledge, in the one section that must never hold any. Asking the adapter
   * is what lets a dock be added in §3 alone.
   */
  supportedDocks?: readonly DockId[];

  /**
   * Whether one of the site's own docks is taking width right now.
   *
   * Only asked about docks whose open-or-shut state belongs to the site — live chat
   * is the site's element, driven by its own `collapsed` attribute with no state of
   * ours. The comment panel is not asked about here, because that one is our own
   * mode state and the core already knows it.
   */
  isDockActive?(doc: Document, dock: DockId): boolean;

  /**
   * The width this adapter's own stylesheet would give a dock at this viewport
   * width — the free default, in CSS px.
   *
   * It is the FLOOR a drag may shrink to. A paid width control that can make the
   * dock narrower than the free default sells the reader a way to make the product
   * worse, so the narrow half of the range is not on offer: the drag opens the dock
   * up from the default and stops there on the way back.
   *
   * Site knowledge, hence here: the number is whatever the `clamp()` in this
   * adapter's stylesheet works out to, and a custom property holding a `clamp()`
   * reads back as the literal text rather than a number, so it cannot be measured
   * from the outside. An adapter without resizable docks omits this and the core
   * falls back to {@link MIN_DOCK_WIDTH_PX}.
   */
  getDefaultDockWidth?(viewportPx: number): number;

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
  /**
   * Optional signal that the SITE changed how much room it is giving the player —
   * a panel of its own docking or undocking beside the video, in a way the mode's
   * CSS answers with a different player width.
   *
   * On YouTube this is live chat. That dock is driven entirely off the site's own
   * collapsed state (§3), which is what makes it free of JS — and also means
   * nothing in the extension is called when the reader closes it. The player
   * widens from CSS alone, and the site, which sizes its scrubber in JS pixels
   * from the width it last measured, never re-measures: the bar keeps a
   * chat-width scrubber on a full-width player. Toggling our own comment panel
   * appeared to fix it, because that path already nudges — which is how the bug
   * was found.
   *
   * The core is not told what moved. It answers with exactly the re-measure it
   * already runs for its own width changes, so there is no second repair path to
   * keep in step. Returns a disposer. An adapter whose site has no dock of its
   * own omits this and pays for nothing.
   */
  onSiteDockChange?(doc: Document, onChange: () => void): () => void;
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

/**
 * Which dock a width, a grip, or a rule is about.
 *
 * Declared here rather than beside the grip code that used to own it, because
 * three things ahead of that code now speak in terms of it: the adapter interface
 * above, {@link SitePrefs} below, and the stylesheet tokens in §3. A union rather
 * than a string is what makes `tsc` the checklist when a dock is added — every
 * exhaustive `Record<DockId, …>` in the file becomes an error until the new dock
 * is handled, which is how the transcript dock was added without hunting for call
 * sites by hand.
 */
export type DockId = "panel" | "chat" | "transcript";

/**
 * Every dock, ordered **outboard to inboard** — the order they sit in from the
 * window's edge towards the video.
 *
 * The order is load-bearing, not cosmetic. Each dock's inboard offset is the sum
 * of the widths of the docks outboard of it, so a width has to be resolved after
 * everything outside it and before everything inside it. Iterating this array is
 * what guarantees that; see `applyDockWidths` in §9.
 */
export const DOCK_IDS: readonly DockId[] = ["chat", "panel", "transcript"];

/**
 * A width in CSS px for every dock, 0 meaning "let the stylesheet's own
 * responsive `clamp()` decide".
 *
 * Exhaustive over {@link DockId} rather than a partial record, so no consumer has
 * to decide what a missing dock means. 0 already says it.
 */
export type DockWidths = Readonly<Record<DockId, number>>;

/** Every dock at its stylesheet default. */
export const DEFAULT_DOCK_WIDTHS: DockWidths = { panel: 0, chat: 0, transcript: 0 };

/**
 * One per-channel rule: the channel, and the layout the mode should come up in
 * for it. Pro.
 *
 * This began as a bare `string` — a list of channels to switch the mode on for.
 * The identifier is still the only required part, and a rule that carries nothing
 * else behaves exactly as the old list did, which is what let the stored shape
 * change without a migration step. Everything else is the layout that channel
 * wants, so a lecture channel can open scrollable with the comments docked while a
 * livestream channel opens covered with chat wide.
 */
export interface ChannelRule {
  /**
   * The channel's identifier as the adapter reports it — a handle, never a URL and
   * never a display name, so a rename does not quietly break the rule.
   */
  id: string;
  /**
   * Which mode to enter for this channel, or null to follow the site's own
   * `scrollable` preference.
   *
   * Null rather than a copy of the site value, so changing the site preference
   * still moves every rule that never asked for something different.
   */
  scrollable: boolean | null;
  /** Dock the comment panel as the mode comes up for this channel. */
  panel: boolean;
  /** Widths for this channel, each 0 to fall back to the site's own width. */
  dockWidths: DockWidths;
}

/** Per-site preferences. */
export interface SitePrefs {
  autoApply: boolean;
  /** Use {@link WindowedMode} `scrollable` instead of `cover`. */
  scrollable: boolean;
  /**
   * The reader's chosen width per dock in CSS px, 0 for the stylesheet's own
   * responsive default. Pro; a free install never writes anything but 0.
   *
   * 0 rather than `null` for "unset", so the field passes the same whole-number
   * check every other stored count uses and the coercion needs no special case.
   * The distinction matters: a stored 0 means "let the sheet's `clamp()` decide",
   * which follows the window, where a stored number is a fixed px width that does
   * not.
   *
   * One record rather than a field per dock, so adding a dock does not add a
   * preference field, a normalizer call, and a patch shape to keep in step.
   */
  dockWidths: DockWidths;
  /**
   * Channels the mode enters on automatically, whatever {@link autoApply} says,
   * and the layout it comes up in for each. Pro.
   *
   * Capped at {@link MAX_CHANNEL_RULES} on write, because this is the one stored
   * field a reader can grow without bound.
   */
  channels: readonly ChannelRule[];
  /**
   * Put a captured frame on the clipboard instead of downloading it. Only reached
   * by a Pro install, since capture itself is Pro.
   */
  captureToClipboard: boolean;
  /**
   * Custom background colour for the letterbox bars around the video. Empty string
   * for default black. Pro.
   */
  letterboxColor: string;
  /**
   * Dynamically sample video edge colours to softly illuminate the letterbox bars. Pro.
   */
  ambientGlow: boolean;
  /**
   * Custom template for naming saved frame screenshots. Empty string for default. Pro.
   */
  captureFilenameTemplate: string;
  /**
   * Burn the video playback timestamp into the corner of captured frames. Pro.
   */
  captureBurnTimestamp: boolean;
  /**
   * Automatically hide the mouse cursor after a period of inactivity. Free.
   */
  cursorAutoHide: boolean;
}

/** Documented defaults applied when nothing is stored. */
export const DEFAULT_SITE_PREFS: SitePrefs = {
  autoApply: false,
  scrollable: false,
  dockWidths: DEFAULT_DOCK_WIDTHS,
  channels: [],
  captureToClipboard: false,
  letterboxColor: "",
  ambientGlow: false,
  captureFilenameTemplate: "",
  captureBurnTimestamp: false,
  cursorAutoHide: true,
};

/** The mode a site's preferences select. */
export function modeFor(prefs: SitePrefs): WindowedMode {
  return prefs.scrollable ? "scrollable" : "cover";
}

/**
 * Which channel the page is showing, as the adapter reports it.
 *
 * `id` is what gets stored and compared — a stable handle, never a URL. `label` is
 * for the settings UI to print, and is deliberately not what a rule matches on: a
 * channel can rename itself and a rule that followed the display name would
 * silently stop applying.
 */
export interface ChannelRef {
  readonly id: string;
  readonly label: string;
}

// There is no page-to-worker message type, and the worker has no `onMessage`
// listener. Messages travel one way only: a surface sends an {@link ExtMessage} to
// a tab's content script, and the content script answers.
//
// There used to be an `OPEN_PAGE` request the other way. The in-page Pro prompt's
// `Already bought Pro?` button asked the worker to open the settings page on its
// licence field, because a content script cannot open an extension URL itself.
// The prompt now takes the key inline instead — see `showProPrompt` in §13, which
// carries its own field, its own `activateLicence` call and its own refusal
// messages — so there was nothing left to ask for. Removing the listener also
// removed the worker's ability to open a tab on behalf of a page, which is worth
// keeping removed: an enumerated intent was safe, but the next person to add a
// destination to it is one refactor away from a worker that opens whatever a page
// hands it.

/** Messages exchanged between the surfaces. */
export type ExtMessage =
  | { type: "TOGGLE" }
  | { type: "GET_STATUS" }
  | { type: "TOGGLE_PANEL" }
  | { type: "CAPTURE" }
  | { type: "COPY_LINK" }
  | { type: "COPY_TRANSCRIPT" };

/**
 * Reply to an {@link ExtMessage}.
 *
 * `channel` rides along on the success case rather than getting a message of its
 * own: the popup already asks for the status on every opening, and a second round
 * trip to learn the channel would double the window in which the popup is
 * waiting on a page that may not answer at all.
 */
export type ExtResponse =
  | { ok: true; active: boolean; channel?: ChannelRef | null }
  | { ok: false; error: string };

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
  /** A per-channel auto-apply rule gave up waiting for the page to name the
   * channel. Only reached with rules stored and an entitlement to use them, so it
   * always means a rule that could not be evaluated, never an absent feature. */
  channelRuleAbandoned: "channel-rule-abandoned",
  /** `exitFullscreen()` threw or rejected after an exit intent was recorded. */
  exitFullscreenRefused: "exit-fullscreen-refused",
  /** Teardown found a snapshotted element the page had detached. One line per
   * `exit()` call carrying the skipped count, not one line per element. */
  restoreSkipped: "restore-skipped",
  /** Opening the welcome page on a fresh install failed. No retry follows: a
   * retry would fire whenever the worker next woke, so the reader would get a
   * welcome tab out of nowhere hours after installing. */
  firstRunOpenFailed: "first-run-open-failed",
  /** A licence check did not confirm the key — either a definite refusal at
   * activation, or a scheduled revalidation that could not be completed, in which
   * case entitlement is left as it was (§14 rule 2). Carries the provider's status
   * and the host it was asked, because on screen every refusal is one sentence and
   * a test-mode build is indistinguishable from an exhausted activation limit. */
  proValidationFailed: "pro-validation-failed",
  /** Frame capture threw. One line per attempt; capture has no retry loop,
   * because a frame the reader wanted is a frame they can ask for again. */
  captureFailed: "capture-failed",
  /** The captured frame came back blank, which is what protected playback
   * produces. Nothing is saved rather than saving a black rectangle. */
  captureBlank: "capture-blank",
  /** A transcript press reserved the dock column and the site never opened the
   * panel, so the column was taken back. Bounded like every other contest with the
   * site: the alternative is an empty column left on screen for the session. */
  transcriptOpenAbandoned: "transcript-open-abandoned",
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
   * The playing media element, for frame capture. Both class forms are listed for
   * the same reason the player has a fallback: YouTube has shipped each of them.
   *
   * Resolved inside the player rather than document-wide, because a watch page
   * carries other `<video>` elements — the hover previews in the suggestions rail
   * are real video elements, and capturing one of those instead of the thing being
   * watched would be a baffling bug to be handed.
   */
  video: "video.html5-main-video, video.video-stream",
  /**
   * The channel link in the owner row, whose href carries the channel's stable
   * identifier: `/@handle` on a modern page, `/channel/UC…` on an older one.
   *
   * The href is read rather than the visible name: a channel can rename itself,
   * and a stored rule that matched the display name would stop applying with
   * nothing said about it.
   */
  channelLink: "ytd-video-owner-renderer a[href], #owner a[href], #upload-info a[href]",
  /** The channel's display name, for the settings list to print. */
  channelName: "ytd-channel-name #text, ytd-video-owner-renderer #channel-name #text",
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
   * Player-bar controls that need windowed mode out of the way entirely.
   * Chapters and transcripts are now docked directly in the sidebar dock,
   * so they no longer exit windowed mode.
   */
  pageDependentControls: [],
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
   * Live chat on a stream. Absent entirely on an ordinary video, which is the
   * signal "this page has no chat" rather than a failure.
   *
   * Named here as well as in the stylesheet because the dock being CSS-only is
   * what hid the bug it is read for: see `onSiteDockChange` below.
   */
  liveChat: "#chat",
  /**
   * The attribute YouTube puts on {@link liveChat} while the reader has chat shut.
   * Its ABSENCE is what `:has(#chat:not([collapsed]))` keys the whole dock off, so
   * this is the site's own state and not ours.
   *
   * Not unique to chat: YouTube uses the same attribute name on its description
   * and comment expanders, so anything watching for it has to confirm what
   * actually changed. `onSiteDockChange` does.
   */
  chatCollapsedAttr: "collapsed",
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
  /**
   * The transcript engagement panel. YouTube shows it inside `#secondary` (an
   * ancestor this mode hides), so docking it requires the same un-hiding treatment
   * as live chat: `#secondary` is revealed as a bare host and the transcript panel
   * is fixed into its own column.
   *
   * `target-id` is the attribute YouTube uses to identify each engagement panel;
   * `engagement-panel-searchable-transcript` is the value for the transcript. The
   * panel is ABSENT on pages that have no transcript (music, some shorts), so
   * nothing matches and this section costs nothing.
   *
   * The `[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]` guard is what
   * distinguishes "the transcript exists" from "the reader opened it". Without it,
   * the dock would appear the moment the page has a transcript button, before
   * anyone pressed it.
   */
  /*
   * Five branches, not eleven. There were six exact `[target-id="…"]` values in front
   * of these, and every one of them was already matched by a substring branch that is
   * still here:
   *
   *   engagement-panel-searchable-transcript             -> *="transcript"
   *   engagement-panel-transcript                        -> *="transcript"
   *   PAmodern_transcript_view                           -> *="transcript"
   *   engagement-panel-structured-description            -> *="structured-description"
   *   engagement-panel-macro-markers-description-chapters-> *="macro-markers"
   *   engagement-panel-macro-markers-auto-chapters       -> *="macro-markers"
   *
   * So removing them cannot change what matches. It is worth doing because this string
   * is interpolated into roughly forty rules of `YT_ACTIVE_MODE_CSS`, several of them
   * inside a `:has()`, and a substring attribute match is one of the few selector
   * forms Chrome cannot answer from an index. Do not "restore" the explicit values for
   * documentation: a redundant branch here is paid on every style recalculation. If a
   * NEW panel id is needed, check first whether an existing substring already covers
   * it, and add a substring rather than an exact value if it does not.
   */
  transcriptPanel:
    'ytd-engagement-panel-section-list-renderer:is([target-id*="transcript"], [target-id*="structured-description"], [target-id*="macro-markers"], [target-id*="chapters"], [is-sync-scroll-panel])',
  /** Matches any open/expanded transcript or structured description engagement panel. */
  transcriptActivePanel:
    'ytd-engagement-panel-section-list-renderer:is([target-id*="transcript"], [target-id*="structured-description"], [target-id*="macro-markers"], [target-id*="chapters"], [is-sync-scroll-panel])[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
  /** The attribute YouTube sets when the panel is expanded/visible. */
  transcriptVisibilityAttr: "visibility",
  /** The value that means the panel is open. */
  transcriptExpandedValue: "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED",
} as const;

/** Hosts treated as YouTube. */
const YT_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

/**
 * "The transcript column is claimed": either the site has the panel expanded, or a
 * press is in flight and the column has been reserved ahead of it.
 *
 * Every transcript rule that is about the COLUMN — the width token, the narrowing of
 * `#primary`, un-hiding the host — is written against this rather than against the
 * expanded panel alone. That is what makes the dock arrive in the same frame as the
 * press instead of one or more frames later. See `TRANSCRIPT_PENDING_CLASS` (§6) for
 * why the panel needed this and live chat did not.
 *
 * Rules that are about the PANEL ITSELF deliberately still key off
 * {@link YT.transcriptActivePanel}: while a press is in flight there is no expanded
 * panel to style, and forcing `display` onto every engagement panel that merely
 * exists would reveal the ones the site is keeping hidden.
 *
 * Specificity is unchanged by the `:is()`. `:is()` takes the highest specificity of
 * its arguments, and `:has(…[visibility="…"])` already outweighs a bare class, so
 * every rule written against this still loses to the fullscreen stand-down rules and
 * still beats the `clamp()` defaults — the balance `getDockWidthCss` depends on.
 *
 * The class name is written out here rather than interpolated from
 * {@link TRANSCRIPT_PENDING_CLASS}, which is declared in §6, below this. A `const`
 * is not hoisted, so reading it from a template literal evaluated at module load
 * would throw. §3 already spells `wfs-windowed` and `wfs-scrollable` the same way.
 */
const YT_TRANSCRIPT_DOCKED = `html.wfs-windowed:is(.wfs-transcript-pending, :has(${YT.transcriptActivePanel}))`;

/* The three numbers in `clamp(320px, 26vw, 440px)`, the default width of BOTH docks
   in the stylesheet below. Named here because `getDefaultDockWidth` has to work the
   same expression out in JS to give a drag its floor, and two copies of a magic
   number in one file is how they drift apart. */

/** The `320px` lower bound: the narrowest either dock is ever drawn. */
const DOCK_DEFAULT_FLOOR_PX = 320;

/** The `26vw` middle term: the share of the window a dock takes by default. */
const DOCK_DEFAULT_VIEWPORT_SHARE = 0.26;

/** The `440px` upper bound, so a wide monitor does not hand the dock the stage. */
const DOCK_DEFAULT_CEILING_PX = 440;

/**
 * What each of this site's docks is called in the stylesheet, and how to find it.
 *
 * The one table every generic dock path reads through, so the width code, the
 * measuring code, and the grips never name a YouTube element between them. Adding a
 * dock is an entry here plus its rules in {@link YT_ACTIVE_MODE_CSS}, and nothing
 * outside §3 changes.
 *
 * Partial over {@link DockId} on purpose: the union names every dock the extension
 * knows how to draw, and a given site need not have all of them.
 */
const YT_DOCKS: Partial<
  Readonly<
    Record<
      DockId,
      {
        /** The custom property the stylesheet sizes this dock with. */
        widthVar: string;
        /**
         * The selector a chosen width is written against. Deliberately one class
         * short of the fullscreen rules that collapse this dock to `0px`, so those
         * still win — see `getDockWidthCss`.
         */
        widthSelector: string;
        /** The docked element itself, for measuring what is on screen. */
        element: string;
        /**
         * Matches only while the site is showing this dock. Absent for a dock whose
         * open-or-shut state is ours rather than the site's, which is the comment
         * panel: the core knows that one from the class it sets itself.
         */
        activeQuery?: string;
      }
    >
  >
> = {
  chat: {
    widthVar: "--wfs-chat-width",
    widthSelector: "html.wfs-windowed:has(#chat:not([collapsed]))",
    element: YT.liveChat,
    activeQuery: "#chat:not([collapsed])",
  },
  panel: {
    widthVar: "--wfs-panel-width",
    widthSelector: "html.wfs-windowed.wfs-side-panel",
    element: YT.sideContent,
  },
  transcript: {
    widthVar: "--wfs-transcript-width",
    // The reserved column has to be the reader's chosen width from the first frame.
    // Written against the expanded panel alone, a stored width only landed once the
    // site had finished opening, so the column visibly jumped from the `clamp()`
    // default to the chosen number.
    widthSelector: YT_TRANSCRIPT_DOCKED,
    element: YT.transcriptPanel,
    activeQuery: YT.transcriptActivePanel,
  },
};

/**
 * This site's docks, outboard to inboard — chat holds the window edge and the
 * comment panel sits inside it.
 *
 * Derived from {@link DOCK_IDS} rather than written out again, so the two orders
 * cannot disagree about which dock is outside which.
 */
const YT_DOCK_ORDER: readonly DockId[] = DOCK_IDS.filter((dock) => dock in YT_DOCKS);

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
  scroll-behavior: auto !important;
  overscroll-behavior: none !important;

  /* Light theme (YouTube's default when <html> carries no \`dark\`). */
  --wfs-surface: #ffffff;
  --wfs-edge: rgba(0, 0, 0, 0.14);
  --wfs-scrim: rgba(255, 255, 255, 0.94);

  /* Per-dock width variables. Each defaults to 0px and is set to its responsive
     clamp() only by the rule that fires when that dock is up. The total is one
     sum, so adding a dock is one variable — no combinatorial explosion.

     The order they appear in is irrelevant to the arithmetic; what matters is
     that the per-dock activation rules only set their OWN variable and never
     touch the sum, so a dock going up cannot knock another dock's width out. */
  --wfs-chat-width: 0px;
  --wfs-panel-width: 0px;
  --wfs-transcript-width: 0px;

  /* Custom or ambient letterbox bar background colour. Defaults to black. */
  --wfs-letterbox-color: #000;

  /* How much of the window's right edge is currently given to docks — the
     comment panel, the live-chat panel, the transcript dock, or any combination.
     Zero when nothing is docked, which is what makes it safe for the masthead
     below to read unconditionally. Every rule that narrows something to clear a
     dock reads this one property, so the docks cannot disagree about where their
     shared edge is.

     Computed from the per-dock variables rather than set per combination, which
     is the whole point of the Phase 2 refactor: two docks needed three rules,
     three would need seven, and that table rots. */
  --wfs-docked-width: calc(
    var(--wfs-chat-width) + var(--wfs-panel-width) + var(--wfs-transcript-width)
  );

  /* How far in from the window's right edge the comment panel sits. Zero on its
     own; the sum of the docks outboard of it when others are up. Both the panel
     and its close button read this, so the button cannot drift off the panel's
     corner. Declared here so a panel that is the only dock on screen reads 0px
     without needing a rule to set it. */
  --wfs-panel-right: 0px;

  --wfs-z-player: 2147483630;
  --wfs-z-panel: 2147483634;
  /* The panel's own close button, which has to clear the panel's scrolling
     content without reaching the masthead's layer. A token rather than
     \`--wfs-z-panel + 1\` written inline, for the reason in the stacking note
     above: a layer is a rank, and ranks belong in one list. */
  --wfs-z-panel-control: 2147483635;
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
html.wfs-windowed:not(.wfs-scrollable),
html.wfs-windowed:not(.wfs-scrollable) body {
  overflow: hidden !important;
  height: 100vh !important;
  max-height: 100vh !important;
}

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
  background: var(--wfs-letterbox-color) !important;
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
  position: relative !important;
  z-index: 1 !important;
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
html.wfs-windowed .ytp-ce-element,
html.wfs-windowed .ytp-endscreen {
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
  /* The bar ends where a dock begins, and spans the window when nothing is
     docked (--wfs-docked-width is 0px then, so this is the plain right: 0 it
     used to be).

     It used to span the window unconditionally and reveal ACROSS the docked
     panel, which was defended as harmless because the bar is transient and the
     panel scrolls under it. That stopped being true the moment either panel grew
     a close button in its top-right corner: the bar reveals into exactly that
     strip, so moving the cursor up to press the X summoned the bar on top of it
     and the panel could not be closed at all.

     Raising the panels above the bar is the obvious alternative and the wrong
     one — see the note on --wfs-z-chrome in the stacking comment above: the
     masthead's own account, notifications and Create buttons live at the
     right-hand end of the bar, which is exactly where the docks are, so
     inverting the order simply moves the unreachable controls. Ending the bar
     early removes the overlap instead, and costs nothing: it keeps every one of
     its controls and just lays them out across the width the video has. */
  right: var(--wfs-docked-width) !important;
  width: auto !important;
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

/* The bar's inner layout is sized by the site to its host's width. Releasing any
   explicit width lets the right-hand cluster reflow to the inset edge above
   instead of staying out past it, under the dock. */
html.wfs-windowed #masthead-container #masthead {
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
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
html.wfs-windowed:not(.wfs-scrollable):not(.wfs-side-panel) ytd-watch-flexy #below,
html.wfs-windowed:not(.wfs-scrollable):not(.wfs-side-panel) #below,
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
  background: var(--wfs-letterbox-color) !important;
}

/* Flatten the container chain between #primary-inner and the player.
   In the non-side-panel case, #columns is a flex row and #primary is narrower
   than the viewport because #secondary takes space. The player must still span
   the full viewport, so #player (outermost wrapper inside #primary-inner) gets
   a width that overflows into #secondary's territory. overflow:visible on
   #primary-inner lets it paint there; the visual result is a full-width player
   followed by two narrower columns.
   --wfs-secondary-width is defined alongside the flex layout below. */
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy #player {
  position: static !important;
  /* Span the full #columns width: #primary's own width plus #secondary's. */
  width: calc(100% + var(--wfs-secondary-width)) !important;
  min-width: 0 !important;
  max-width: none !important;
  height: 100vh !important;
  min-height: 0 !important;
  max-height: 100vh !important;
  padding: 0 !important;
  margin: 0 !important;
}

html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy #player-container-outer,
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy #player-container-inner,
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy #player-container,
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy ytd-player,
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy ytd-player > #container {
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

/* Side-panel case: #columns is block, #primary is full-width, no breakout
   needed. The original full-width flattening applies. */
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy #player,
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy #player-container-outer,
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy #player-container-inner,
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy #player-container,
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy ytd-player,
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy ytd-player > #container {
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

/* #columns is YouTube's flex row of #primary and #secondary. In scrollable mode
   without the side panel, keep it as a flex row so the related-videos rail sits
   beside the comments — the same two-column layout YouTube uses natively. The
   player still spans full width because the container chain above is given a
   width that breaks it out of #primary's narrowed box.

   With the side panel open, #secondary stays hidden (the panel replaces it) and
   #columns reverts to a block so #primary takes the full width. */
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy #columns {
  /* The secondary rail width. YouTube uses 402px on wide viewports. Clamped so
     it does not eat too much on small windows or expand past usefulness. */
  --wfs-secondary-width: clamp(300px, 26vw, 402px);
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
}

html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy #primary {
  flex: 1 1 0% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
  /* The player inside overflows into #secondary's horizontal territory; let it
     paint there. */
  overflow: visible !important;
}

html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) ytd-watch-flexy #primary-inner {
  display: block !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
  /* The player container chain overflows #primary into #secondary's space. Let
     it paint there rather than clipping. This is only the player row; #below
     stays within #primary's bounds. */
  overflow: visible !important;
}

/* Un-hide the suggestions rail in scrollable mode without the side panel. It
   carries the "All / From the series" chip bar and related-video cards. The
   blanket hide in the rule above (html.wfs-windowed #secondary) must be
   overridden with a more specific selector — the extra :not() wins by class
   count. */
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) #secondary,
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) #secondary-inner {
  display: block !important;
  visibility: visible !important;
}

html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) #secondary {
  flex: 0 0 var(--wfs-secondary-width) !important;
  width: var(--wfs-secondary-width) !important;
  min-width: 0 !important;
  max-width: var(--wfs-secondary-width) !important;
  /* Push below the player. The player overflows #primary into #secondary's
     horizontal space for its full 100vh height, so the rail must not start
     until after that. The extra 20px matches #below's top margin so both
     columns start at the same baseline. */
  margin-top: calc(100vh + 20px) !important;
  margin-bottom: 64px !important;
  /* Left gutter only. A right gutter here reads as a dead vertical strip the
     full height of the rail, between the last card and the page's scrollbar —
     which is exactly what a 24px value looked like, and what the rail's own
     scrollbar used to sit in. YouTube runs its cards to the edge; so do we.
     The 8px pairs with #below's 24px right padding for a 32px column gap. */
  padding: 0 0 0 8px !important;
  /* Plain flow, exactly as YouTube ships it. An earlier revision made this
     sticky with a 100vh max-height and overflow-y: auto, which gave the rail
     its OWN scrollbar — two scrollbars on the page, the rail scrolling out of
     step with the comments beside it, and the page's own scrollbar no longer
     reaching the end of the suggestions. YouTube's rail is ordinary flow
     content and the page's single scrollbar moves the whole column; anything
     that nests a scroll container here reintroduces that. */
  position: static !important;
  align-self: flex-start !important;
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
}

html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) #secondary-inner {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  /* Same reason as #secondary above: no nested scroll container, or the page
     grows a second scrollbar. */
  position: static !important;
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
}

/* The rail's contents carry YouTube's own rail width, which is sized for the
   stock watch page rather than for whatever width this mode gives it. Left
   alone the cards keep that width and leave a blank strip beside them, which is
   the same failure the right padding above caused. Same treatment as the
   #below > * release further up. */
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) #secondary-inner > *,
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) #secondary ytd-watch-next-secondary-results-renderer,
html.wfs-windowed.wfs-scrollable:not(.wfs-side-panel) #secondary #related {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}

/* When the side panel is docked, #secondary stays hidden and the layout is a
   plain block column so #primary keeps the full width for the panel geometry. */
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy #columns,
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy #primary,
html.wfs-windowed.wfs-scrollable.wfs-side-panel ytd-watch-flexy #primary-inner {
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
   Re-parenting it into the player would be the other way to do this, and not
   re-parenting is what let live chat be added without touching this code at all:
   #chat lives in a different container (#secondary), so it gets its own dock
   further down rather than sharing this one. Leaving #below where YouTube put it means
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
     what keeps it flush with the space the player gives back.

     --wfs-docked-width is not set here. It is a composed sum of the per-dock
     variables (see the root rule), so setting --wfs-panel-width is all that is
     needed — the total updates automatically. */
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
  right: var(--wfs-panel-right) !important;
  bottom: 0 !important;
  left: auto !important;
  width: var(--wfs-panel-width) !important;
  min-width: 0 !important;
  max-width: var(--wfs-panel-width) !important;
  height: auto !important;
  margin: 0 !important;
  /* Top padding clears the close button, which is pinned to this corner. */
  padding: 52px var(--wfs-panel-pad) 96px !important;
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

/* The panel's close button, matching the one the site puts on its own chat panel.
   The panel had no affordance of its own: closing it meant knowing that the
   comment button in the player bar toggles, or that Escape gives back one layer.
   Both are true and neither is visible.

   It is NOT injected into #below. That subtree belongs to the site's own renderer,
   which rebuilds it on a video change and on lazy comment loads, and anything of
   ours inside it would be discarded at some point we do not control. It hangs off
   <body> instead and is positioned onto the panel's corner, so the panel stays
   the site's element and this stays ours.

   Hidden by default, so the element can exist for the whole session and the
   docked/undocked question stays a pure CSS one — the same reasoning as every
   other panel rule being nested under a class. */
.wfs-panel-close {
  display: none;
}

html.wfs-windowed.wfs-side-panel .wfs-panel-close {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  box-sizing: border-box !important;
  position: fixed !important;
  top: 10px !important;
  /* Sits inside the panel's own right edge, wherever that edge currently is. */
  right: calc(var(--wfs-panel-right) + 10px) !important;
  width: 32px !important;
  height: 32px !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  border-radius: 50% !important;
  background: transparent !important;
  color: inherit !important;
  cursor: pointer !important;
  /* Clears the panel's scrolling content without reaching the masthead's rank. */
  z-index: var(--wfs-z-panel-control) !important;
  opacity: 0.85 !important;
  transition: background-color 120ms ease, opacity 120ms ease !important;
}

html.wfs-windowed.wfs-side-panel .wfs-panel-close:hover {
  background: var(--wfs-edge) !important;
  opacity: 1 !important;
}

/* The site's own focus ring does not apply to an element outside its tree, and a
   control reachable by keyboard has to show where the focus is. */
html.wfs-windowed.wfs-side-panel .wfs-panel-close:focus-visible {
  outline: 2px solid currentColor !important;
  outline-offset: 2px !important;
  opacity: 1 !important;
}

/* The glyph inherits the theme's text colour rather than being painted white, so
   it stays legible on the light theme's panel. */
html.wfs-windowed.wfs-side-panel .wfs-panel-close svg {
  width: 24px !important;
  height: 24px !important;
  display: block !important;
  stroke: currentColor !important;
}

html.wfs-windowed.wfs-side-panel .wfs-panel-close {
  color: #0f0f0f !important;
}

html[dark].wfs-windowed.wfs-side-panel .wfs-panel-close {
  color: #f1f1f1 !important;
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

/* The masthead stops at the panel's outer edge rather than revealing across it.
   See the inset note in the #masthead-container rule for why that changed, and why
   raising the panel above the bar instead would be worse. */

/* -------------------------------------------------------------------------
   Live chat dock.

   A livestream's chat gets the same treatment the comment panel gets: a column
   beside the player, taking width from the video rather than covering it. On a
   livestream the chat IS the reason to keep the page open, so leaving it in the
   rail below a viewport-tall player means scrolling away from the stream to read
   it.

   Driven entirely off YouTube's own state, with no class of ours and no JS.
   #chat carries a \`collapsed\` attribute while the reader has the panel shut, so
   \`:has(#chat:not([collapsed]))\` is exactly "the site is showing chat". The
   consequences are worth spelling out:

   - Pressing YouTube's own "Open panel" / chat toggle is all it takes. We do not
     add a control, and we do not need one.
   - Collapsing chat unwinds the dock on its own. There is no state to keep and
     nothing for exit() to restore — every rule here is nested under
     .wfs-windowed, so leaving the mode drops the whole lot.
   - On a video with no chat, #chat is absent, nothing matches, and this section
     costs nothing.

   \`:has()\` is Chrome 105; the manifest floor is 116, so it is safe to depend on.

   Chat and the comment panel COEXIST, chat on the outside. An earlier revision
   stood chat down whenever the panel was docked, on the argument that two docks
   on one strip leave neither usable. That was wrong in the one case that matters:
   the site's own "Open panel" chat button is reachable from inside the docked
   panel, so pressing it expanded a chat that then had nowhere to render and
   simply never appeared. Refusing to show what the reader just asked for is worse
   than a narrow video, and the reader can always close one of the two.
   ------------------------------------------------------------------------- */
html.wfs-windowed:has(#chat:not([collapsed])) {
  /* The same width as the comment panel, so the two docks are interchangeable
     and the video's width does not jump between them.

     --wfs-docked-width is not set here. It is a composed sum of the per-dock
     variables (see the root rule), so setting --wfs-chat-width is all that is
     needed — the total updates automatically. The both-docked rule that used
     to set --wfs-docked-width to the sum of chat + panel is gone: the root
     calc() handles every combination without a combinatorial table. */
  --wfs-chat-width: clamp(320px, 26vw, 440px);
}

/* Browser fullscreen belongs to YouTube, including its own chat drawer. The mode
   stands down in JS (§9); this covers the few frames before that runs, for the
   same reason the comment panel does it — a player still holding a chat-sized
   gap is how the site ends up measuring itself into its smallest control bar. */
html.wfs-windowed:has(#chat:not([collapsed])):is(:fullscreen, :has(:fullscreen)) {
  --wfs-chat-width: 0px;
}

/* Cover mode: the player is already fixed, so the two insets size it. Sized from
   left/right rather than calc(100vw - width) for the scrollbar reason recorded
   against the comment panel. */
html.wfs-windowed:not(.wfs-scrollable):has(#chat:not([collapsed])) #movie_player,
html.wfs-windowed:not(.wfs-scrollable):has(#chat:not([collapsed])) .html5-video-player {
  left: 0 !important;
  right: var(--wfs-docked-width) !important;
  width: auto !important;
  max-width: none !important;
}

/* Scrollable mode: the two-column layout below the player folds back to one, and
   the whole left column is inset by the chat's width. Narrowing #primary rather
   than the player means the player, the metadata and the comments are all
   measured off the same edge and cannot drift apart — and it undoes the
   #player breakout further up in one place, since #primary is full-width again
   as far as its own children are concerned. */
html.wfs-windowed.wfs-scrollable:has(#chat:not([collapsed])) ytd-watch-flexy #columns {
  display: block !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
}

html.wfs-windowed.wfs-scrollable:has(#chat:not([collapsed])) ytd-watch-flexy #primary {
  display: block !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 var(--wfs-docked-width) 0 0 !important;
  overflow: visible !important;
}

html.wfs-windowed.wfs-scrollable:has(#chat:not([collapsed])) ytd-watch-flexy #primary-inner,
html.wfs-windowed.wfs-scrollable:has(#chat:not([collapsed])) ytd-watch-flexy #player {
  display: block !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
}

/* #primary's margin above is the ONLY thing narrowing the video in this mode, so
   the player must fill it. Without this the comment panel's own
   calc(100% - --wfs-panel-width) applies on top of a column that has already
   given that width up, and the video ends up a panel-width short of its box. */
html.wfs-windowed.wfs-scrollable:has(#chat:not([collapsed])) #movie_player,
html.wfs-windowed.wfs-scrollable:has(#chat:not([collapsed])) .html5-video-player {
  width: 100% !important;
  max-width: 100% !important;
}

/* Both docked: the comment panel moves inboard to sit beside chat rather than
   under it. Chat keeps the outer edge because it is the site's own panel with
   its own close button — burying that is what made it unclosable.

   Set on <html> rather than on #below directly so the panel's close button, which
   reads the same property, travels with it. */
html.wfs-windowed.wfs-side-panel:has(#chat:not([collapsed])) {
  --wfs-panel-right: var(--wfs-chat-width);
}

/* #secondary holds the chat, so it cannot be display:none the way it is the rest
   of the time — display:none on an ancestor takes a position:fixed descendant
   with it. It is revealed as a bare host instead: every rail role stripped, and
   its only remaining in-flow content removed below, so it collapses to nothing
   and the fixed chat inside is all that paints.

   This also overrides the inline display:none/visibility:hidden the controller
   writes onto #secondary as a chrome element. A stylesheet !important outranks
   an inline declaration that has none, so the JS and the CSS do not fight. */
html.wfs-windowed:has(#chat:not([collapsed])) #secondary,
html.wfs-windowed:has(#chat:not([collapsed])) #secondary-inner,
html.wfs-windowed:has(#chat:not([collapsed])) #chat-container {
  display: block !important;
  visibility: visible !important;
  position: static !important;
  flex: none !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  height: auto !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: visible !important;
}

/* The related-videos rail, while chat is docked. It competes for the same strip,
   and in scrollable mode it is the thing that was beside the comments before
   chat took that column. Named outright rather than reached by :not(), so a
   YouTube change adds a rail we can see rather than silently hiding a chat we
   cannot. */
html.wfs-windowed:has(#chat:not([collapsed])) #related,
html.wfs-windowed:has(#chat:not([collapsed])) ytd-watch-next-secondary-results-renderer {
  display: none !important;
}

/* The dock itself. Same geometry as the comment panel, so switching between them
   moves nothing but the contents. */
html.wfs-windowed:has(#chat:not([collapsed])) #chat {
  /* A column, so the chat iframe can be told to take the remaining height
     without being given a pixel value we would have to keep in step. */
  display: flex !important;
  flex-direction: column !important;
  /* Same trap as #below: content-box plus a width renders wider than asked and
     overhangs the video, swallowing the right end of the control bar. */
  box-sizing: border-box !important;
  position: fixed !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  left: auto !important;
  width: var(--wfs-chat-width) !important;
  min-width: 0 !important;
  max-width: var(--wfs-chat-width) !important;
  /* YouTube gives #chat a pixel height from its own JS. The insets above are the
     height here, so that value has to go. */
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  overflow: hidden !important;
  /* Above the player, below the masthead — the same rank the comment panel
     holds. See the stacking note at the top of this stylesheet. */
  z-index: var(--wfs-z-panel) !important;
  background: var(--wfs-surface) !important;
  box-shadow: -1px 0 0 0 var(--wfs-edge) !important;
}

/* Chat renders inside an iframe, which carries its own inline width and height
   from the site. Both have to be released or the dock is a tall box with a
   short chat sitting at the top of it. */
html.wfs-windowed:has(#chat:not([collapsed])) #chat > iframe,
html.wfs-windowed:has(#chat:not([collapsed])) #chat #chatframe {
  flex: 1 1 auto !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  height: 100% !important;
  min-height: 0 !important;
  max-height: none !important;
  margin: 0 !important;
  border: 0 !important;
}

/* Same reason as the comment panel's equivalent rule: a fixed element anchors to
   the nearest ancestor carrying a transform, filter, or paint containment rather
   than to the viewport. The chain here is longer because #chat sits two levels
   deeper than #below. */
html.wfs-windowed:has(#chat:not([collapsed])) ytd-app,
html.wfs-windowed:has(#chat:not([collapsed])) #content,
html.wfs-windowed:has(#chat:not([collapsed])) #page-manager,
html.wfs-windowed:has(#chat:not([collapsed])) ytd-watch-flexy,
html.wfs-windowed:has(#chat:not([collapsed])) ytd-watch-flexy #columns,
html.wfs-windowed:has(#chat:not([collapsed])) ytd-watch-flexy #secondary,
html.wfs-windowed:has(#chat:not([collapsed])) ytd-watch-flexy #secondary-inner,
html.wfs-windowed:has(#chat:not([collapsed])) #chat-container {
  transform: none !important;
  filter: none !important;
  perspective: none !important;
  contain: none !important;
  content-visibility: visible !important;
}

/* -------------------------------------------------------------------------
   Drag-to-resize grips, one per dock.

   Both hang off <body> rather than being injected into the dock they move, for
   exactly the reason recorded against .wfs-panel-close: #below and #chat belong
   to the site's own renderer, which rebuilds them on a video change and on lazy
   loads, so anything of ours inside them is discarded at a moment we do not
   control. They are positioned onto the dock's inboard edge instead.

   Each grip sits ON the shared edge, half its width either side of it, so the
   pointer target is wider than the 1px seam without either dock having to give
   up layout width for it. That is why the offsets below subtract half the grip
   width rather than being flush.

   Hidden by default, and revealed only by the class its dock is up under, so
   "is there a dock to resize?" stays a pure CSS question — the same reasoning as
   every other rule in this stylesheet being nested under a class. A free install
   never mounts these elements at all, so there is no rule here for the
   un-entitled case: nothing to hide.
   ------------------------------------------------------------------------- */
.wfs-dock-grip {
  display: none;
}

html.wfs-windowed .wfs-dock-grip {
  box-sizing: border-box !important;
  position: fixed !important;
  top: 0 !important;
  bottom: 0 !important;
  width: 10px !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  background: transparent !important;
  /* The one cursor that says "this edge moves sideways". */
  cursor: col-resize !important;
  /* Above the panel it moves, below the masthead — the same rank the panel's own
     close button takes, and for the same reason: it has to clear the dock's
     scrolling content without reaching the chrome layer. */
  z-index: var(--wfs-z-panel-control) !important;
  /* No transition on the offset. The grip's position is written from JS on every
     frame of a drag, and a transition on it would make the grip lag the pointer
     it is following, which reads as the drag having missed. */
  transition: background-color 120ms ease !important;
}

/* A hairline that only appears on hover or while dragging. Visible at rest it
   would be a second border beside the panel's own box-shadow edge, doubling a
   line the design already draws. */
html.wfs-windowed .wfs-dock-grip::after {
  content: "" !important;
  position: absolute !important;
  top: 0 !important;
  bottom: 0 !important;
  left: 50% !important;
  width: 2px !important;
  transform: translateX(-50%) !important;
  background: transparent !important;
  transition: background-color 120ms ease !important;
}

html.wfs-windowed .wfs-dock-grip:hover::after,
html.wfs-windowed .wfs-dock-grip.is-dragging::after,
html.wfs-windowed .wfs-dock-grip:focus-visible::after {
  background: #3ea6ff !important;
}

/* Keyboard reachable, so the width is not mouse-only. The ring is drawn on the
   hairline rather than the 10px box, which would outline a strip of video. */
html.wfs-windowed .wfs-dock-grip:focus-visible {
  outline: none !important;
}

/* The comment panel's grip sits on that panel's inboard edge, wherever it
   currently is — which is chat's width further in when chat is docked outboard,
   because --wfs-panel-right already carries that. */
html.wfs-windowed.wfs-side-panel .wfs-dock-grip[data-wfs-dock="panel"] {
  display: block !important;
  right: calc(var(--wfs-panel-right) + var(--wfs-panel-width) - 5px) !important;
}

/* Chat's grip sits on chat's own inboard edge. Chat keeps the outer edge, so this
   is simply its width in from the window edge. */
html.wfs-windowed:has(#chat:not([collapsed])) .wfs-dock-grip[data-wfs-dock="chat"] {
  display: block !important;
  right: calc(var(--wfs-chat-width) - 5px) !important;
}

/* Browser fullscreen belongs to YouTube, and the dock widths collapse to 0 for
   it, so a grip left on screen would sit at the window's right edge over the
   site's own fullscreen controls. */
html.wfs-windowed:is(:fullscreen, :has(:fullscreen)) .wfs-dock-grip {
  display: none !important;
}

/* The masthead needs no rule of its own here. It reads --wfs-docked-width, which
   the tokens at the top of this section already cover every dock, so the bar
   stops short of whichever docks are up. */

/* -------------------------------------------------------------------------
   Transcript dock.

   YouTube’s transcript is an engagement panel that lives inside #secondary or #panels.
   The mode un-hides these host containers while the transcript panel is open,
   and fixes the panel into its own dedicated side column.

   The transcript is the INBOARD dock — it sits closest to the video, with
   chat outboard and the comment panel in between. Its right offset is the
   sum of the two outboard docks: var(--wfs-chat-width) + var(--wfs-panel-width).

   UNLIKE THE OTHER TWO DOCKS, this one is claimed before the site has agreed to it.
   Chat and the comment panel are already mounted and merely hidden, so one attribute
   flip both reveals the content and matches the dock rules. The transcript has to be
   REQUESTED, and the site mounts it in a host that — in scrollable mode — is in flow
   below the player. Keyed on the expanded panel alone, the reader saw three stages:
   the page scrolled to the mounting panel, the panel painted under the video, then it
   jumped into the column.

   So every COLUMN-level rule below is written against ${"YT_TRANSCRIPT_DOCKED"}, which
   is "expanded, or a press is in flight". The rules about the PANEL ITSELF still key
   off the expanded panel, because while a press is in flight there is no expanded
   panel and forcing display onto every engagement panel that merely exists would
   reveal the ones the site is keeping hidden. See TRANSCRIPT_PENDING_CLASS in §6.
   ------------------------------------------------------------------------- */
${YT_TRANSCRIPT_DOCKED} {
  --wfs-transcript-width: clamp(320px, 26vw, 440px);
}

/* Browser fullscreen: same treatment as chat and the comment panel. A press still
   in flight is abandoned here too, so the site never measures a player holding a
   column for a panel that is about to belong to its own fullscreen UI. */
${YT_TRANSCRIPT_DOCKED}:is(:fullscreen, :has(:fullscreen)) {
  --wfs-transcript-width: 0px;
}

/* Cover mode: the player is already fixed, so the right inset clears all docks.
   --wfs-docked-width already includes the transcript’s width via the root sum. */
${YT_TRANSCRIPT_DOCKED}:not(.wfs-scrollable) #movie_player,
${YT_TRANSCRIPT_DOCKED}:not(.wfs-scrollable) .html5-video-player {
  left: 0 !important;
  right: var(--wfs-docked-width) !important;
  width: auto !important;
  max-width: none !important;
}

/* Scrollable mode: same pattern as chat — narrow #primary by the total docked
   width so the player, metadata, and comments all share the same edge. */
${YT_TRANSCRIPT_DOCKED}.wfs-scrollable ytd-watch-flexy #columns {
  display: block !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
}

${YT_TRANSCRIPT_DOCKED}.wfs-scrollable ytd-watch-flexy #primary {
  display: block !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 var(--wfs-docked-width) 0 0 !important;
  overflow: visible !important;
}

${YT_TRANSCRIPT_DOCKED}.wfs-scrollable ytd-watch-flexy #primary-inner,
${YT_TRANSCRIPT_DOCKED}.wfs-scrollable ytd-watch-flexy #player {
  display: block !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  padding: 0 !important;
  margin: 0 !important;
}

/* Same reason as chat: the player must fill #primary’s narrowed box. */
${YT_TRANSCRIPT_DOCKED}.wfs-scrollable #movie_player,
${YT_TRANSCRIPT_DOCKED}.wfs-scrollable .html5-video-player {
  width: 100% !important;
  max-width: 100% !important;
}

/* Clear all ancestor containing blocks that would trap position: fixed */
${YT_TRANSCRIPT_DOCKED} #secondary,
${YT_TRANSCRIPT_DOCKED} #secondary-inner,
${YT_TRANSCRIPT_DOCKED} #panels,
${YT_TRANSCRIPT_DOCKED} #panels-inner,
${YT_TRANSCRIPT_DOCKED} ytd-watch-flexy #panels,
${YT_TRANSCRIPT_DOCKED} #primary,
${YT_TRANSCRIPT_DOCKED} #primary-inner,
${YT_TRANSCRIPT_DOCKED} #below {
  contain: none !important;
  transform: none !important;
  filter: none !important;
  perspective: none !important;
  will-change: auto !important;
}

/* Un-hide ALL possible parent host containers (#secondary, #panels, etc.) */
${YT_TRANSCRIPT_DOCKED} #secondary,
${YT_TRANSCRIPT_DOCKED} #secondary-inner,
${YT_TRANSCRIPT_DOCKED} #panels,
${YT_TRANSCRIPT_DOCKED} #panels-inner,
${YT_TRANSCRIPT_DOCKED} ytd-watch-flexy #panels {
  display: block !important;
  visibility: visible !important;
  position: static !important;
  flex: none !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  height: auto !important;
  max-height: none !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: visible !important;
}

/* The panel host, taken out of flow for the few frames of a press in flight.

   This is the rule that removes the reader-visible staging, and it works by denying
   the site somewhere to put the panel IN FLOW rather than by moving the panel after
   the fact. In \`scrollable\` mode #panels sits in the single-column flow under the
   player, so a panel mounting there is painted below the video and — worse — is a
   real scroll target, which is why pressing transcript used to scroll the page. Held
   at the dock's own box from the moment of the press, the panel mounts off-flow,
   there is nothing beneath the player to scroll to, and the column does not move
   when the site finally sets its attribute.

   Only while pending. Once the panel is expanded it carries the fixed box itself
   (below), and the class comes off in a microtask after that attribute lands — so
   the panel is already fixed before #panels goes back to \`static\` and nothing
   visible moves. Deliberately NOT extended to the expanded state as well: that
   would be a second element holding the same box for the whole session, for no gain.

   \`position: fixed\` here does not trap the panel's own \`position: fixed\`. Only
   transform, filter, contain and will-change create a containing block for a fixed
   descendant, and the rule above clears all four. For the same reason \`overflow\`
   here cannot clip the panel once it is fixed to the viewport.

   #panels IS WRITTEN TWICE ON PURPOSE, and removing the repeat silently disables this
   whole rule. The un-hide block directly above sets \`position: static\` on #panels and
   both rules are \`!important\`, so specificity decides and nothing else does. That block
   selects through \`:is(.wfs-transcript-pending, :has(…[visibility="…"]))\`, whose
   \`:has()\` argument alone carries a tag and two attribute selectors — it scores
   (1 id, 3 classes, 2 elements), and its \`ytd-watch-flexy #panels\` branch scores
   (1, 3, 3). Written once, this rule scores (1, 2, 1) and LOSES, so #panels would stay
   in flow and the staged open would come straight back. A second #panels takes the id
   count to 2, and ids are compared before anything else, so it wins over both branches.
   Preferred over splitting \`position\` out of the block above, which would mean a second
   copy of that five-selector list. \`tests/transcript-dock.test.ts\` computes both
   specificities and fails if this stops out-ranking them. */
html.wfs-windowed.wfs-transcript-pending #panels#panels {
  position: fixed !important;
  top: 0 !important;
  right: calc(var(--wfs-chat-width) + var(--wfs-panel-width)) !important;
  bottom: 0 !important;
  left: auto !important;
  width: var(--wfs-transcript-width) !important;
  max-width: var(--wfs-transcript-width) !important;
  height: 100vh !important;
  max-height: 100vh !important;
  overflow: hidden !important;
  z-index: var(--wfs-z-panel) !important;
  background: var(--wfs-surface) !important;
  box-shadow: -1px 0 0 0 var(--wfs-edge) !important;
}

/* Hide the suggestions rail and all other secondary children while the transcript is docked — same as chat. */
${YT_TRANSCRIPT_DOCKED} #related,
${YT_TRANSCRIPT_DOCKED} #secondary-inner > :not(#panels),
${YT_TRANSCRIPT_DOCKED} #secondary > :not(#secondary-inner),
${YT_TRANSCRIPT_DOCKED} ytd-watch-next-secondary-results-renderer {
  display: none !important;
}

/* The dock itself. Fixed to the right edge, offset by the sum of the outboard
   docks (chat + panel). */
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptActivePanel} {
  display: flex !important;
  flex-direction: column !important;
  box-sizing: border-box !important;
  position: fixed !important;
  top: 0 !important;
  right: calc(var(--wfs-chat-width) + var(--wfs-panel-width)) !important;
  bottom: 0 !important;
  left: auto !important;
  width: var(--wfs-transcript-width) !important;
  min-width: 0 !important;
  max-width: var(--wfs-transcript-width) !important;
  height: 100vh !important;
  min-height: 100vh !important;
  max-height: 100vh !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  overflow: hidden !important;
  contain: none !important;
  transform: none !important;
  filter: none !important;
  perspective: none !important;
  will-change: auto !important;
  z-index: var(--wfs-z-panel) !important;
  background: var(--wfs-surface) !important;
  box-shadow: -1px 0 0 0 var(--wfs-edge) !important;
}

/* Ensure the panel header stays pinned at the top and its close button remains clickable. */
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} #header,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-engagement-panel-title-header-renderer {
  flex: none !important;
  position: relative !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  z-index: 2 !important;
  box-sizing: border-box !important;
}

html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} #header,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-engagement-panel-title-header-renderer #header {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: space-between !important;
}

/* Tabs container (Timeline / Transcript tabs) */
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} tp-yt-paper-tabs,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} #tabs-container,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} yt-tab-group-shape,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-transcript-search-box-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} yt-search-input-view-model {
  flex: none !important;
  position: relative !important;
  width: 100% !important;
  z-index: 2 !important;
}

/* The transcript panel's inner content container — scrollable body filling remainder. */
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} #content,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} #content-section,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-structured-description-content-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-transcript-search-panel-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-section-list-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} yt-section-list-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-item-section-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} yt-item-section-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-macro-markers-list-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-transcript-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} ytd-transcript-segment-list-renderer,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} transcript-segment-list-view-model,
html.wfs-windowed:has(${YT.transcriptActivePanel}) ${YT.transcriptPanel} #segments-container {
  flex: 1 1 auto !important;
  display: block !important;
  position: relative !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
}

/* One-click copy transcript button inside the engagement panel header. */
.wfs-copy-transcript-btn {
  display: inline-flex !important;
  align-items: center !important;
  gap: 5px !important;
  padding: 4px 10px !important;
  margin-left: auto !important;
  margin-right: 8px !important;
  font-family: inherit !important;
  font-size: 12px !important;
  font-weight: 500 !important;
  color: var(--wfs-fg, #f1f1f1) !important;
  background: var(--wfs-surface-raised, rgba(255, 255, 255, 0.1)) !important;
  border: 1px solid var(--wfs-edge, rgba(255, 255, 255, 0.18)) !important;
  border-radius: 14px !important;
  cursor: pointer !important;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease !important;
  user-select: none !important;
  line-height: 1.3 !important;
  height: 28px !important;
  box-sizing: border-box !important;
  vertical-align: middle !important;
}
.wfs-copy-transcript-btn:hover {
  background: var(--wfs-surface-hover, rgba(255, 255, 255, 0.22)) !important;
  border-color: var(--wfs-edge-hover, rgba(255, 255, 255, 0.3)) !important;
}
.wfs-copy-transcript-btn:active {
  transform: scale(0.96) !important;
}
.wfs-copy-transcript-btn.wfs-copied {
  background: rgba(46, 160, 67, 0.25) !important;
  border-color: rgba(46, 160, 67, 0.5) !important;
  color: #3fb950 !important;
}
.wfs-copy-transcript-btn svg {
  width: 13px !important;
  height: 13px !important;
  flex-shrink: 0 !important;
}

/* Neutralise containing blocks in the transcript’s ancestor chain, same
   treatment as chat. */
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) ytd-app,
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) #content,
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) #page-manager,
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) ytd-watch-flexy,
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) ytd-watch-flexy #columns,
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) ytd-watch-flexy #secondary,
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) ytd-watch-flexy #secondary-inner {
  transform: none !important;
  filter: none !important;
  perspective: none !important;
  contain: none !important;
  content-visibility: visible !important;
}

/* Transcript grip sits on its inboard edge — the sum of all outboard docks
   plus the transcript’s own width, minus half the grip width. */
html.wfs-windowed:has(${YT.transcriptPanel}[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]) .wfs-dock-grip[data-wfs-dock="transcript"] {
  display: block !important;
  right: calc(var(--wfs-chat-width) + var(--wfs-panel-width) + var(--wfs-transcript-width) - 5px) !important;
}

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

/* Browser fullscreen resets the letterbox bars to black so custom or ambient
   colours never shine through native fullscreen playback. */
html.wfs-windowed:is(:fullscreen, :has(:fullscreen)) {
  --wfs-letterbox-color: #000 !important;
}

/* Cursor auto-hide in windowed fullscreen. */
html.wfs-windowed.wfs-cursor-hidden,
html.wfs-windowed.wfs-cursor-hidden * {
  cursor: none !important;
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

  findVideo(doc) {
    // Scoped to the player, not the document: the suggestions rail's hover
    // previews are real `<video>` elements, and capturing one of those instead of
    // the video being watched would look like the feature was simply broken.
    const player = doc.querySelector(YT.player) ?? doc.querySelector(YT.playerFallback);
    const video = player?.querySelector(YT.video) ?? null;
    return video instanceof HTMLVideoElement ? video : null;
  },

  readChannel(doc) {
    const link = doc.querySelector(YT.channelLink);
    const href = link?.getAttribute("href")?.trim();
    if (!href) return null;

    // The identifier is the first path segment that names a channel. `/@handle`
    // and `/channel/UC…` are both stable; `/watch` and `/results` are not
    // channels at all and are refused rather than stored as one.
    let path: string;
    try {
      // Relative hrefs are what YouTube ships; the base is only there to parse.
      path = new URL(href, "https://www.youtube.com").pathname;
    } catch {
      return null;
    }
    const handle = /^\/(@[^/]+)/.exec(path)?.[1] ?? /^\/channel\/(UC[^/]+)/.exec(path)?.[1] ?? null;
    if (!handle) return null;

    const named = doc.querySelector(YT.channelName)?.textContent?.trim();
    // The handle stands in for a name that has not rendered yet, so a rule added
    // from the popup is never stored as a nameless entry.
    return { id: handle, label: named && named.length > 0 ? named : handle };
  },

  readCaptureName(doc) {
    const id = readYouTubeVideoId(doc);
    return id ? `youtube-${id}` : null;
  },

  supportedDocks: YT_DOCK_ORDER,

  isDockActive(doc, dock) {
    const spec = YT_DOCKS[dock];
    // A dock this site does not have is never active. The comment panel is not
    // described by a query here on purpose — that one is our own mode state, and §9
    // answers it from the class it sets itself.
    if (!spec?.activeQuery) return false;
    return doc.querySelector(spec.activeQuery) !== null;
  },

  getDockWidthCss(widths) {
    // Written into a stylesheet of our own rather than inline on <html>, and that
    // is not a style preference — it is the fullscreen handoff.
    //
    // `html.wfs-windowed.wfs-side-panel:is(:fullscreen, :has(:fullscreen))` sets
    // `--wfs-panel-width: 0px` so the site measures an honest layout during the
    // few frames before the mode stands down. An inline custom property on <html>
    // outranks every stylesheet rule, `!important` or not, so writing the reader's
    // width there would beat that rule and hand YouTube a player still holding a
    // panel-sized gap — which is exactly how it ends up caching a bogus size and
    // rendering its smallest control bar.
    //
    // These selectors are one class short of the fullscreen ones, so the sheet
    // still loses to them and wins against the `clamp()` defaults it overrides —
    // which it does on source order, being appended after the main sheet.
    //
    // One rule per dock, emitted from the same table the stylesheet's own tokens
    // are named in. It used to be a hand-written `if` per dock, which is the shape
    // that does not survive a third one.
    const rules: string[] = [];
    for (const dock of DOCK_IDS) {
      const spec = YT_DOCKS[dock];
      if (!spec || widths[dock] <= 0) continue;
      rules.push(`${spec.widthSelector} { ${spec.widthVar}: ${widths[dock]}px; }`);
    }
    return rules.join("\n");
  },

  getDefaultDockWidth(viewportPx) {
    // Mirrors `clamp(320px, 26vw, 440px)`, the value BOTH docks default to in the
    // stylesheet above — `--wfs-panel-width` and `--wfs-chat-width` are declared
    // with the same expression on purpose, so the two docks are interchangeable and
    // one function covers both. Change either declaration and this must change with
    // it, in the same commit: it is the drag's floor, and a floor that drifts from
    // the sheet lets a drag land a pixel off the default and look broken.
    const px = Math.round(viewportPx * DOCK_DEFAULT_VIEWPORT_SHARE);
    return Math.min(Math.max(px, DOCK_DEFAULT_FLOOR_PX), DOCK_DEFAULT_CEILING_PX);
  },

  measureDockWidth(doc, dock) {
    const spec = YT_DOCKS[dock];
    if (!spec) return null;
    const el = doc.querySelector(spec.element);
    if (!el) return null;
    const width = el.getBoundingClientRect().width;
    // 0 means the element exists but is not laid out — chat before it expands, or
    // the panel before the mode docks it. Null, so the caller falls back rather
    // than starting a drag from a zero-width edge.
    return width > 0 ? width : null;
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

  /**
   * Live chat docking or undocking, which changes the player's width with nothing
   * in the extension being called. See {@link SiteAdapter.onSiteDockChange} for
   * what the core does about it and why it has to be told.
   *
   * Watches {@link YT.chatCollapsedAttr} across the document — the same shape
   * `onVideoChange` uses for `video-id`, and for the same reason: an
   * attribute-filtered subtree observer is cheap, and `#chat` may not exist yet, or
   * at all, so there is no element to attach to up front.
   *
   * The filter cannot be the whole test. YouTube puts `collapsed` on its
   * description and comment expanders too, and each of those would otherwise buy a
   * re-measure the layout did not need — a reader opening ten comment replies would
   * spend ten. So every mutation is answered by re-reading chat's state, and only a
   * real change is reported.
   *
   * That state is a pair, not a boolean, and both halves are load-bearing:
   *
   *  - The element is compared, so a livestream-to-livestream navigation that
   *    swaps the chat frame counts as a change even when both frames were open.
   *  - `docked` distinguishes "shut" from "not on this page", because a chat
   *    MOUNTING is not an attribute mutation and is therefore invisible here. With
   *    a plain boolean, a chat that mounted already open — which is what YouTube
   *    does on a stream — would leave the cached value `false`, and the reader's
   *    first collapse would read `false` again and report nothing. That is the exact
   *    bug this hook exists to fix, so the dedupe must not reintroduce it.
   */
  onSiteDockChange(doc, onChange) {
    if (typeof MutationObserver === "undefined") return () => {};

    /** Chat's dock state now: which frame, and whether the site is showing it. */
    const readChatState = (): { chat: Element | null; docked: boolean } => {
      const chat = doc.querySelector(YT.liveChat);
      return { chat, docked: chat !== null && !chat.hasAttribute(YT.chatCollapsedAttr) };
    };

    /**
     * Transcript's dock state: which panel is expanded, if any.
     *
     * One query, and a tag-plus-attribute one at that, because this runs on every
     * mutation the filter lets through and that is a great many. It used to fall
     * through to `doc.querySelector(YT.transcriptPanel)` whenever nothing was
     * expanded, which is nearly always — an eleven-branch `:is()` with three
     * substring attribute matches, walked across the whole document, on every
     * `collapsed` flip the site makes on a comment or description expander.
     *
     * That second query was also wrong, not merely slow. Reaching it proved no panel
     * carried the expanded value, so the `expanded` it computed was always `false` and
     * the only thing it contributed was the panel's IDENTITY. Feeding that into the
     * dedupe meant an engagement panel being created or replaced while the transcript
     * was SHUT counted as a dock change — and a dock change costs
     * `refreshGeometry()`, which dispatches a synthetic `resize` at each of
     * `REFLOW_NUDGE_DELAYS_MS`. Five whole-page relayouts, to report that a dock which
     * was not on screen had been replaced by another one that also was not.
     *
     * Reporting `null` while nothing is expanded keeps every transition that can move
     * the layout — shut to open, open to shut, and one expanded panel swapped for
     * another — and drops only the ones that cannot.
     */
    const readTranscriptState = (): { panel: Element | null; expanded: boolean } => {
      const expandedPanel = doc.querySelector(
        `ytd-engagement-panel-section-list-renderer[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]`,
      );
      return expandedPanel ? { panel: expandedPanel, expanded: true } : { panel: null, expanded: false };
    };

    let lastChat = readChatState();
    let lastTranscript = readTranscriptState();

    const observer = new MutationObserver(() => {
      let changed = false;

      const currentChat = readChatState();
      if (currentChat.chat !== lastChat.chat || currentChat.docked !== lastChat.docked) {
        lastChat = currentChat;
        changed = true;
      }

      const currentTranscript = readTranscriptState();
      if (currentTranscript.panel !== lastTranscript.panel || currentTranscript.expanded !== lastTranscript.expanded) {
        lastTranscript = currentTranscript;
        changed = true;
      }

      if (changed) onChange();
    });
    observer.observe(doc.documentElement ?? doc, {
      subtree: true,
      attributes: true,
      attributeFilter: [YT.chatCollapsedAttr, YT.transcriptVisibilityAttr],
    });

    return () => observer.disconnect();
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
export function normalizeSitePrefs(stored: unknown): SitePrefs | null {
  if (typeof stored !== "object" || stored === null) return null;
  const raw = stored as Record<string, unknown>;
  // autoApply has existed since the first release; its absence means this is not
  // a preferences object at all.
  if (typeof raw.autoApply !== "boolean") return null;
  return {
    autoApply: raw.autoApply,
    scrollable: typeof raw.scrollable === "boolean" ? raw.scrollable : DEFAULT_SITE_PREFS.scrollable,
    // Both widths keep whatever number is stored, floored so nothing draws a dock
    // narrower than the stylesheet would. There is no ceiling here on purpose: a
    // record from a wider monitor is a real choice, and the drag's own live clamp
    // brings it inside this window the moment the reader touches the grip. 0 stays 0,
    // meaning "use the stylesheet's own responsive width". The whole record goes in
    // because a pre-2.0.0 store kept the widths as two sibling fields.
    dockWidths: normalizeDockWidths(raw),
    channels: normalizeChannelRules(raw.channels),
    captureToClipboard:
      typeof raw.captureToClipboard === "boolean"
        ? raw.captureToClipboard
        : DEFAULT_SITE_PREFS.captureToClipboard,
    letterboxColor:
      typeof raw.letterboxColor === "string"
        ? raw.letterboxColor.trim()
        : DEFAULT_SITE_PREFS.letterboxColor,
    ambientGlow:
      typeof raw.ambientGlow === "boolean"
        ? raw.ambientGlow
        : DEFAULT_SITE_PREFS.ambientGlow,
    captureFilenameTemplate:
      typeof raw.captureFilenameTemplate === "string"
        ? raw.captureFilenameTemplate.trim()
        : DEFAULT_SITE_PREFS.captureFilenameTemplate,
    captureBurnTimestamp:
      typeof raw.captureBurnTimestamp === "boolean"
        ? raw.captureBurnTimestamp
        : DEFAULT_SITE_PREFS.captureBurnTimestamp,
    cursorAutoHide:
      typeof raw.cursorAutoHide === "boolean"
        ? raw.cursorAutoHide
        : DEFAULT_SITE_PREFS.cursorAutoHide,
  };
}

/**
 * The narrowest width a stored dock record may hold, in CSS px.
 *
 * 320px — the lower bound of the `clamp(320px, 26vw, 440px)` both docks default to,
 * so no stored number draws a dock narrower than the stylesheet ever would. This is
 * the storage floor only, and it is deliberately viewport-free: a *drag* cannot go
 * below the dock's default width for the window it is in, which on a wide monitor is
 * more than this. See `getDefaultDockWidth` (§3) and {@link clampDockWidth}.
 */
export const MIN_DOCK_WIDTH_PX = 320;

/**
 * The strip of window a dock may never take, in CSS px.
 *
 * 24px, and it is not there to protect the video — the reader is allowed to widen a
 * dock until the video is a sliver, because the same grip drags it straight back and
 * refusing that is what made the paid width control feel like a trial. It is there
 * so the grip stays on screen: the grip is 10px wide and centred on the dock's
 * inboard edge, so an edge flush with the window's left side would leave half of it
 * outside the viewport and the drag would be one-way.
 *
 * An earlier revision reserved 480px here instead, the width at which YouTube's
 * control bar starts dropping buttons. That reads as a bug rather than a guard: on a
 * 1366px window with both docks up it left the second dock barely a pixel of travel,
 * so the feature looked broken to the people who had paid for it. Do not reinstate
 * it — a narrow video is the reader's own choice and it is one drag from undone.
 */
export const DOCK_DRAG_RESERVE_PX = 24;

/**
 * The most per-channel rules one site may hold.
 *
 * 50. The list is the only stored field the reader can grow, and every entry is
 * read on every video load, so it is bounded rather than trimmed: silently
 * dropping the oldest rule would make a setting the reader deliberately added stop
 * working with nothing said about it. The settings UI reports the refusal instead.
 */
export const MAX_CHANNEL_RULES = 50;

/** The longest channel identifier accepted, so one rule cannot fill the record. */
export const MAX_CHANNEL_ID_LENGTH = 120;

/**
 * Coerce a stored dock width: a whole number at or above the minimum, or 0.
 *
 * There is no upper bound — whatever the reader dragged to is what they get. The
 * live viewport guard in {@link clampDockWidth} is the only ceiling, and it runs
 * on every drag frame, so storage does not need to second-guess it.
 */
export function normalizeDockWidth(stored: unknown): number {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return 0;
  const px = Math.round(stored);
  if (px <= 0) return 0;
  return Math.max(px, MIN_DOCK_WIDTH_PX);
}

/**
 * Coerce a stored width record, reading a pre-2.0.0 record as well.
 *
 * Takes the whole stored preferences object rather than just its `dockWidths`
 * field, and that is the entire migration: through 1.4.0 the widths were two
 * sibling fields called `panelWidth` and `chatWidth`, so when `dockWidths` is
 * absent those two are read instead. A reader who dragged their comment column
 * wide before this version keeps that width, and nothing has to run once and be
 * remembered as having run.
 *
 * Every dock is filled in, so no consumer has to treat a missing dock as anything.
 * A dock that has never been dragged reads back 0, which is the same as a fresh
 * install and means "use the stylesheet's own responsive width".
 */
export function normalizeDockWidths(stored: Record<string, unknown>): DockWidths {
  const raw =
    typeof stored.dockWidths === "object" && stored.dockWidths !== null
      ? (stored.dockWidths as Record<string, unknown>)
      : // Pre-2.0.0: two sibling fields, one per dock, and no transcript dock at all.
        { panel: stored.panelWidth, chat: stored.chatWidth };
  const widths: Record<DockId, number> = { ...DEFAULT_DOCK_WIDTHS };
  for (const dock of DOCK_IDS) widths[dock] = normalizeDockWidth(raw[dock]);
  return widths;
}

/**
 * Coerce a stored channel-rule list: strings only, trimmed, de-duplicated, and
 * capped.
 *
 * Total, and never null: a damaged list reads as no rules, which is the same thing
 * a free install has and cannot mislead anyone into thinking a rule is in force.
 * Non-string entries are dropped individually rather than condemning the list,
 * for the same reason every other coercion here is per-field.
 */
export function normalizeChannelRules(stored: unknown): readonly ChannelRule[] {
  if (!Array.isArray(stored)) return [];
  const out: ChannelRule[] = [];
  for (const entry of stored) {
    // A bare string is a pre-2.0.0 rule, when the list held identifiers and
    // nothing else. It upgrades to a rule that asks for no layout of its own,
    // which behaves exactly as it did before — that equivalence is what let the
    // shape change without a migration step to write, run, and remember.
    const raw: Record<string, unknown> =
      typeof entry === "string" ? { id: entry } : ((entry ?? {}) as Record<string, unknown>);
    if (typeof raw.id !== "string") continue;
    const id = raw.id.trim();
    if (id === "" || id.length > MAX_CHANNEL_ID_LENGTH) continue;
    // First rule for a channel wins. A duplicate is not an error worth reporting:
    // the settings UI refuses to add one, so a second can only come from a record
    // written by hand or by a future version.
    if (out.some((rule) => rule.id === id)) continue;
    out.push({
      id,
      // Anything that is not a boolean means "no preference of its own", which is
      // what an upgraded string rule and a damaged field both come back as.
      scrollable: typeof raw.scrollable === "boolean" ? raw.scrollable : null,
      panel: raw.panel === true,
      dockWidths: normalizeDockWidths(raw),
    });
    if (out.length >= MAX_CHANNEL_RULES) break;
  }
  return out;
}

/**
 * A rule for this channel that asks for no layout of its own.
 *
 * What the settings UI adds when the reader names a channel, and what a pre-2.0.0
 * string rule upgrades to. Both have to mean the same thing, so both come through
 * here rather than each writing the defaults out.
 */
export function newChannelRule(id: string): ChannelRule {
  return { id, scrollable: null, panel: false, dockWidths: DEFAULT_DOCK_WIDTHS };
}

/**
 * The rule for this channel, or null when there is none.
 *
 * Pure, and deliberately does not read the Pro state: the gate belongs to the one
 * caller in §9, so this stays a question about the rules alone and stays testable
 * without an entitlement record.
 */
export function findChannelRule(prefs: SitePrefs, channel: ChannelRef | null): ChannelRule | null {
  if (!channel || channel.id === "") return null;
  return prefs.channels.find((rule) => rule.id === channel.id) ?? null;
}

/**
 * Whether the page's channel has a rule asking for the mode.
 *
 * Kept alongside {@link findChannelRule} rather than replaced by it: this is the
 * question `autoApplyWanted` asks, and a boolean caller should not have to know
 * that a rule is an object now.
 */
export function channelRuleMatches(prefs: SitePrefs, channel: ChannelRef | null): boolean {
  return findChannelRule(prefs, channel) !== null;
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

// There is deliberately no settings export/import.
//
// A JSON backup of the preference record was built for 2.0.0 and taken out again
// before release. Two reasons, and the second is the one that settles it. There are
// ten fields, every one of them a checkbox or a width that takes seconds to set by
// hand, so a backup saves nobody meaningful work. And an import is an untrusted
// record arriving from a file picker: `normalizeSitePrefs` would be the only thing
// between a hand-edited JSON file and stored state, which makes a coercion bug a
// data-integrity bug rather than a display one. Neither cost buys anything a reader
// asked for.
//
// If it ever comes back, it is not the answer to "why is there no
// `chrome.storage.sync`" — that answer is that settings are not worth sending
// through a browser account, and it stands on its own.

/**
 * Call `onChange` whenever a site's preferences are written from another surface
 * (the popup), so a live page can follow along instead of waiting for a reload.
 * Returns a disposer.
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
 * Call `onChange` whenever the rating record is written from another surface, so a
 * second view of it stays in step without a reload. Returns a disposer, matching
 * `watchSitePrefs`.
 *
 * Still earns its keep with one settings surface: the popup's preferences tree and
 * its Pro view are separate trees over the same record, and the rating footer is
 * repainted from here rather than from whoever happened to write.
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

/**
 * Added to `<html>` for the few frames between pressing the transcript control and
 * the site actually expanding the panel.
 *
 * It exists because the transcript is REQUESTED rather than merely revealed, which
 * is the one thing that makes it unlike live chat. Chat is already mounted and only
 * `collapsed`, so the attribute that shows it and the attribute the dock keys off
 * are the same mutation and the dock arrives in the same frame. The transcript has
 * to be asked for, and the site mounts it in its own host — which in `scrollable`
 * mode is IN FLOW BELOW THE PLAYER, because that mode deliberately leaves the
 * suggestions rail visible. So the reader saw three stages: the page scrolled to
 * the newly mounted panel, the panel painted under the video, and only then did
 * `:has([visibility="…EXPANDED"])` start matching and move it into the column.
 *
 * This class is set SYNCHRONOUSLY, before the site is asked, so the column is
 * already reserved and the panel host is already out of flow when the panel mounts.
 * A panel that never enters flow cannot be scrolled to and cannot be painted under
 * the player, which removes all three stages rather than hiding them.
 *
 * Bounded, like every other contest with the site: `TRANSCRIPT_PENDING_TIMEOUT_MS`
 * (§9) takes it off again if the request produced nothing, so a failed press cannot
 * leave an empty column on screen.
 *
 * Dead end worth recording: the previous attempt at the scroll half of this was a
 * patch on `Element.prototype.scrollIntoView`. It cannot work. A content script runs
 * in an isolated world with its OWN `Element.prototype`, so the patch only ever saw
 * our own calls and never the site's. The four `scrollTo(0, 0)` calls that were
 * added on top of it were treating the symptom, and were themselves the visible
 * scroll the reader was complaining about.
 */
const TRANSCRIPT_PENDING_CLASS = "wfs-transcript-pending";

/**
 * Id of the second injected `<style>` element, which holds nothing but the
 * reader's chosen dock widths.
 *
 * Separate from {@link STYLE_ELEMENT_ID} so a drag rewrites two short rules
 * instead of the whole site stylesheet, and so the widths land *after* the
 * defaults they override without the main sheet having to be regenerated.
 */
const DOCK_WIDTH_STYLE_ID = "wfs-dock-widths";

/** Class on a dock's drag grip. Positioned by the adapter's stylesheet. */
const DOCK_GRIP_CLASS = "wfs-dock-grip";

/** Attribute naming which dock a grip moves. */
const DOCK_GRIP_ATTR = "data-wfs-dock";

/** Class on a grip while it is being dragged, so the hairline stays visible. */
const DOCK_GRIP_DRAGGING_CLASS = "is-dragging";

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

/* While a dock is being dragged, nothing on the page may select text or start a
   drag of its own. Applied to <html> for the duration of the pointer capture and
   removed when it ends, rather than being fought per-element: a drag that crosses
   the comment panel would otherwise select every comment it passes over.

   Deliberately NOT scoped under .wfs-windowed. The class is only ever set during
   a drag, which only happens inside the mode, and scoping it would make it one
   more thing that has to be true at the same time for a drag to behave. */
html.wfs-dock-resizing,
html.wfs-dock-resizing body {
  user-select: none !important;
  -webkit-user-select: none !important;
}

/* The cursor has to survive leaving the 10px grip. A drag routinely travels a
   couple of hundred pixels, and without this the pointer reverts to whatever is
   under it mid-drag — an I-beam over the comments — which reads as the drag
   having been dropped. */
html.wfs-dock-resizing * {
  cursor: col-resize !important;
}

/* -------------------------------------------------------------------------
   The Pro prompt.

   Shown in the page, over the video, when a control the reader pressed is part
   of the paid tier. It exists because exactly one Pro feature is visible to
   someone who never opens the settings — the capture button in the player bar —
   and a locked door that says so converts, where a hidden one does not exist.

   Our own classes only, so it is site-independent: it is appended to <body> and
   positioned against the viewport, and no rule here is nested under
   .wfs-windowed because the capture button is in the player bar whether the mode
   is on or off.
   ------------------------------------------------------------------------- */
.wfs-pro-prompt {
  position: fixed !important;
  inset: 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  /* Above everything the adapter's stylesheet declares. The scale in §3 tops out
     at --wfs-z-overlay, and this is one above it: a prompt the reader cannot see
     is worse than a prompt over a menu. */
  z-index: 2147483643 !important;
  background: rgba(0, 0, 0, 0.78) !important;
  backdrop-filter: blur(10px) !important;
  -webkit-backdrop-filter: blur(10px) !important;
  /* The system stack, so the card matches the browser rather than the page. */
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
  padding: 16px !important;
}

.wfs-pro-prompt__card {
  box-sizing: border-box !important;
  width: min(480px, calc(100vw - 32px)) !important;
  padding: 24px 24px 20px !important;
  border-radius: 18px !important;
  background: #111116 !important;
  color: #f4f4f5 !important;
  border: 1px solid rgba(255, 255, 255, 0.14) !important;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08) !important;
  text-align: left !important;
  position: relative !important;
  overflow: hidden !important;
}

.wfs-pro-prompt__card::before {
  content: "" !important;
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  height: 3px !important;
  background: linear-gradient(90deg, #6366f1, #a855f7, #ec4899) !important;
}

.wfs-pro-prompt__close {
  position: absolute !important;
  top: 14px !important;
  right: 14px !important;
  width: 28px !important;
  height: 28px !important;
  border-radius: 50% !important;
  background: rgba(255, 255, 255, 0.08) !important;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  color: #a1a1aa !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  cursor: pointer !important;
  font-size: 13px !important;
  line-height: 1 !important;
  padding: 0 !important;
  transition: all 120ms ease !important;
}

.wfs-pro-prompt__close:hover {
  background: rgba(255, 255, 255, 0.18) !important;
  color: #ffffff !important;
  border-color: rgba(255, 255, 255, 0.25) !important;
}

.wfs-pro-prompt__badge {
  display: inline-flex !important;
  align-items: center !important;
  gap: 5px !important;
  font-size: 11px !important;
  font-weight: 700 !important;
  letter-spacing: 0.06em !important;
  text-transform: uppercase !important;
  color: #c084fc !important;
  background: rgba(168, 85, 247, 0.12) !important;
  border: 1px solid rgba(168, 85, 247, 0.25) !important;
  padding: 3px 8px !important;
  border-radius: 9999px !important;
  margin-bottom: 10px !important;
}

.wfs-pro-prompt__title {
  margin: 0 0 6px !important;
  font-size: 18px !important;
  font-weight: 700 !important;
  line-height: 1.3 !important;
  color: #ffffff !important;
  padding-right: 28px !important;
}

.wfs-pro-prompt__body {
  margin: 0 0 14px !important;
  font-size: 13px !important;
  line-height: 1.45 !important;
  color: #94a3b8 !important;
}

.wfs-pro-prompt__grid {
  display: grid !important;
  grid-template-columns: repeat(2, 1fr) !important;
  gap: 8px !important;
  margin: 0 0 14px !important;
  padding: 10px !important;
  background: rgba(255, 255, 255, 0.03) !important;
  border: 1px solid rgba(255, 255, 255, 0.08) !important;
  border-radius: 12px !important;
}

.wfs-pro-prompt__grid-item {
  display: flex !important;
  align-items: flex-start !important;
  gap: 6px !important;
  font-size: 11.5px !important;
  color: #e4e4e7 !important;
  line-height: 1.35 !important;
}

.wfs-pro-prompt__grid-item span.icon {
  font-size: 13px !important;
  flex-shrink: 0 !important;
  margin-top: 1px !important;
}

.wfs-pro-prompt__grid-item strong {
  color: #ffffff !important;
  font-weight: 600 !important;
}

.wfs-pro-prompt__trust {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-wrap: wrap !important;
  gap: 12px !important;
  font-size: 11px !important;
  color: #a1a1aa !important;
  margin-bottom: 14px !important;
}

.wfs-pro-prompt__actions {
  display: flex !important;
  flex-direction: column !important;
  gap: 8px !important;
}

.wfs-pro-prompt__action {
  box-sizing: border-box !important;
  padding: 9px 16px !important;
  border: 1px solid rgba(255, 255, 255, 0.16) !important;
  border-radius: 9px !important;
  background: rgba(255, 255, 255, 0.06) !important;
  color: #f4f4f5 !important;
  font: inherit !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  cursor: pointer !important;
  text-decoration: none !important;
  text-align: center !important;
  transition: all 120ms ease !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
}

.wfs-pro-prompt__action:hover {
  background: rgba(255, 255, 255, 0.12) !important;
  border-color: rgba(255, 255, 255, 0.28) !important;
  color: #ffffff !important;
}

.wfs-pro-prompt__action.is-primary {
  width: 100% !important;
  padding: 11px 18px !important;
  font-size: 14px !important;
  border: none !important;
  background: linear-gradient(135deg, #6366f1, #8b5cf6) !important;
  color: #ffffff !important;
  font-weight: 700 !important;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4) !important;
}

.wfs-pro-prompt__action.is-primary:hover {
  background: linear-gradient(135deg, #4f46e5, #7c3aed) !important;
  box-shadow: 0 6px 20px rgba(99, 102, 241, 0.55) !important;
  transform: translateY(-1px) !important;
}

.wfs-pro-prompt__action:focus-visible {
  outline: 2px solid #818cf8 !important;
  outline-offset: 2px !important;
}

.wfs-pro-prompt__link-more {
  display: block !important;
  text-align: center !important;
  font-size: 11.5px !important;
  color: #a5b4fc !important;
  text-decoration: none !important;
  padding: 3px 0 !important;
  transition: color 120ms ease !important;
}

.wfs-pro-prompt__link-more:hover {
  color: #c7d2fe !important;
  text-decoration: underline !important;
}

.wfs-pro-prompt__foot-row {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  margin-top: 4px !important;
  padding-top: 8px !important;
  border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
}

.wfs-pro-prompt__foot-btn {
  background: none !important;
  border: none !important;
  color: #71717a !important;
  font-size: 11px !important;
  cursor: pointer !important;
  padding: 4px 6px !important;
  text-decoration: none !important;
  transition: color 120ms ease !important;
}

.wfs-pro-prompt__foot-btn:hover {
  color: #d4d4d8 !important;
}

/* A brief message over the video: "Frame saved", or why it was not.

   Not a dialog, because none of it needs an answer, and not written into the
   settings error region either — the reader is looking at a video, not at a
   settings page, and a message they will never see is the same as no message.

   Non-interactive on purpose, and that is the hover-zone mistake avoided rather
   than a detail: it appears over the control bar, and anything there that accepts
   pointer events swallows a click meant for the button underneath it. */
.wfs-toast {
  position: fixed !important;
  left: 50% !important;
  bottom: 88px !important;
  transform: translateX(-50%) !important;
  z-index: 2147483643 !important;
  max-width: min(420px, calc(100vw - 32px)) !important;
  padding: 10px 16px !important;
  border-radius: 8px !important;
  background: rgba(0, 0, 0, 0.85) !important;
  color: #ffffff !important;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
  font-size: 14px !important;
  line-height: 1.4 !important;
  text-align: center !important;
  pointer-events: none !important;
}

/* Ambient glow canvas sitting directly behind the video in windowed fullscreen */
.wfs-ambient-glow-canvas {
  position: absolute !important;
  inset: -12% !important;
  width: 124% !important;
  height: 124% !important;
  object-fit: fill !important;
  pointer-events: none !important;
  z-index: 0 !important;
  filter: blur(64px) saturate(115%) !important;
  opacity: 1 !important;
  transition: opacity 0.25s ease !important;
  will-change: filter !important;
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

/** Class on `<html>` for the duration of a dock drag. */
const DOCK_RESIZING_CLASS = "wfs-dock-resizing";

/**
 * Class on `<html>` while the idle cursor is hidden.
 *
 * Named here beside the other classes the TypeScript applies, rather than written
 * as a bare string at each of its three call sites. The rule is not style for its own
 * sake: a class the JS adds and a selector the stylesheet matches are one fact in two
 * files, and a typo in a `classList.remove` call is a cursor that never comes back.
 */
const CURSOR_HIDDEN_CLASS = "wfs-cursor-hidden";

/**
 * A fallback dock width for the case where nothing is stored and the dock cannot
 * be measured — the middle of the range the stylesheets' own `clamp()` covers.
 *
 * Only reachable when a drag starts before the dock has laid out, which the grips'
 * own visibility rules make unlikely; it exists so that case produces a usable
 * width rather than a drag anchored on zero.
 */
const DOCK_WIDTH_FALLBACK_PX = 380;

/**
 * Write the reader's chosen dock widths into their own `<style>` element,
 * creating it on first use and appending it after the main sheet.
 *
 * Appended after, and that is the whole reason this is a second element: the
 * widths override `clamp()` defaults declared with the same selectors, so they win
 * on source order — while still losing to the more specific fullscreen rules that
 * collapse a dock to zero. Regenerating the main sheet on every frame of a drag
 * would re-parse the whole site stylesheet instead of two rules.
 *
 * An empty string empties the element rather than removing it: a drag back to the
 * default has to stop overriding, and keeping the node means the next write does
 * not have to re-establish document order.
 */
function writeDockWidthCss(doc: Document, css: string): void {
  let style = doc.getElementById(DOCK_WIDTH_STYLE_ID);
  // Nothing chosen and nothing to clear: no element is created. The common case is
  // a reader who has never dragged anything, and an empty `<style>` sitting in
  // their head would be one more thing for someone reading the page — or a script
  // reaching for this id — to have to explain.
  if (!style && css === "") return;
  if (!style) {
    style = doc.createElement("style");
    style.id = DOCK_WIDTH_STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

/** Drop the dock-width sheet, used on teardown so a navigation leaves nothing. */
function removeDockWidthCss(doc: Document): void {
  doc.getElementById(DOCK_WIDTH_STYLE_ID)?.remove();
}

export const LETTERBOX_STYLE_ID = "wfs-letterbox-style";

/**
 * Write a custom or ambient letterbox bar colour into its own `<style>` element.
 */
export function writeLetterboxCss(doc: Document, color: string): void {
  let style = doc.getElementById(LETTERBOX_STYLE_ID);
  if (!style && (color === "" || color === "#000000" || color === "#000")) return;
  if (!style) {
    style = doc.createElement("style");
    style.id = LETTERBOX_STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  const css = `html.wfs-windowed { --wfs-letterbox-color: ${color} !important; }\nhtml.wfs-windowed #movie_player, html.wfs-windowed .html5-video-player, html.wfs-windowed #player-theater-container, html.wfs-windowed #player-container, html.wfs-windowed ytd-player { background: var(--wfs-letterbox-color) !important; }`;
  if (style.textContent !== css) style.textContent = css;
}

/** Drop the letterbox style sheet on exit or teardown. */
export function removeLetterboxCss(doc: Document): void {
  doc.getElementById(LETTERBOX_STYLE_ID)?.remove();
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
    // The player just changed width, and the site derives its control-bar geometry
    // from that in JS — the same reason entry and exit nudge it.
    this.refreshGeometry();
    return true;
  }

  /** Flip the side panel. */
  togglePanel(): boolean {
    return this.setPanelOpen(!this.panelOpen);
  }

  /**
   * Re-measure after the player's width changed, whoever changed it.
   *
   * Public because the controller is not the only thing that moves that edge. Every
   * rule narrowing the video reads one custom property, so a dock belonging to the
   * SITE — live chat on YouTube — re-lays the player out from CSS alone with nothing
   * here being called. The site sizes the parts of its control bar it cannot express
   * in CSS from the width it last measured and only recomputes on a resize, so
   * without this the bar keeps the geometry it had before the dock moved: a scrubber
   * a dock's width short of the bar it sits in, on an otherwise full-width player.
   *
   * {@link setPanelOpen} calls through here rather than repeating it, so one width
   * change gets one answer regardless of which side caused it. `SiteAdapter`'s
   * `onSiteDockChange` is what supplies the other side.
   *
   * Ignored while the mode is off: there is no geometry of ours to repair, and a
   * nudge at a page this session does not own is what {@link dispose} exists to
   * prevent.
   */
  refreshGeometry(): void {
    if (!this.active) return;
    // A deliberate width change earns a fresh repair budget: this is the moment
    // the site is most likely to disagree about the player's size, and the reader
    // is looking straight at the control bar when it does. A fresh budget means a
    // fresh right to report exhausting it.
    this.geometryRepairs = 0;
    this.geometryRepairAbandonReported = false;
    this.scheduleReflowNudge();
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
 * Accessible name for the close button on the docked panel itself. Names the
 * action and the thing, because the panel toggle in the player bar already
 * carries the panel's name and a bare "Close" beside it would be ambiguous to
 * anyone reading the two out of context.
 */
const PANEL_CLOSE_LABEL = "Close comments";

/** Class on the panel's close button. Styled by the adapter's stylesheet. */
const PANEL_CLOSE_CLASS = "wfs-panel-close";

/** Accessible name for the frame-capture control. */
const CAPTURE_BUTTON_LABEL = "Save this frame";

/** Accessible name for copying link at current timestamp. */
const COPY_LINK_BUTTON_LABEL = "Copy link at current time";

/** Accessible name for the transcript panel toggle. */
const TRANSCRIPT_BUTTON_LABEL = "Transcript";

/** Accessible name for a dock's drag grip, with the dock named. */
const DOCK_GRIP_LABELS = {
  panel: "Drag to resize the comments column",
  chat: "Drag to resize the chat column",
  transcript: "Drag to resize the transcript column",
} as const satisfies Record<DockId, string>;

/**
 * The controls we inject, in on-screen order starting immediately to the right
 * of the site's own fullscreen button. The value doubles as the marker
 * attribute's value, which is how a re-render is de-duplicated per control.
 */
const BUTTON_ROLES = ["capture", "copylink", "transcript", "mode", "panel"] as const;

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
 * A camera for frame capture: a body, a lens, and the raised strip above it.
 *
 * Not a download arrow, and not a pair of scissors. The arrow describes what
 * happens to the file rather than what the button does, and it is also the glyph
 * the reader has already learned means "download this video" from every other
 * extension in this space — a button that promised a video and saved a PNG would
 * be a genuine surprise. A camera names the action.
 */
function buildCaptureIcon(doc: Document): Element {
  const svg = createIconSvg(doc);
  // The raised strip over the lens, drawn first so the body sits on top of it.
  appendShape(doc, svg, "path", {
    d: "M14 9h8v3h-8z",
    fill: "#ffffff",
  });
  appendShape(doc, svg, "rect", {
    x: "7",
    y: "12",
    width: "22",
    height: "15",
    rx: "2.5",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "2",
  });
  appendShape(doc, svg, "circle", {
    cx: "18",
    cy: "19.5",
    r: "4",
    fill: "#ffffff",
  });
  return svg;
}

/** A link chain with small clock timestamp indicator. */
function buildCopyLinkIcon(doc: Document): Element {
  const svg = createIconSvg(doc);
  appendShape(doc, svg, "path", {
    d: "M14 14l-2.5 2.5a3.5 3.5 0 0 0 5 5l2.5-2.5m-1-5l2.5-2.5a3.5 3.5 0 0 0-5-5l-2.5 2.5m-1 7l6-6",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "2",
    "stroke-linecap": "round",
  });
  appendShape(doc, svg, "circle", {
    cx: "25",
    cy: "24",
    r: "4.5",
    fill: "#111111",
    stroke: "#ffffff",
    "stroke-width": "1.5",
  });
  appendShape(doc, svg, "path", {
    d: "M25 21.5v2.5h2",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "1.2",
    "stroke-linecap": "round",
  });
  return svg;
}

/** A document with timestamp dots and text lines representing a transcript. */
function buildTranscriptIcon(doc: Document): Element {
  const svg = createIconSvg(doc);
  appendShape(doc, svg, "rect", {
    x: "8",
    y: "7",
    width: "20",
    height: "22",
    rx: "2.5",
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "2",
  });
  appendShape(doc, svg, "circle", {
    cx: "12",
    cy: "13",
    r: "1.2",
    fill: "#ffffff",
  });
  appendShape(doc, svg, "rect", {
    x: "15.5",
    y: "12",
    width: "9",
    height: "2",
    rx: "1",
    fill: "#ffffff",
  });
  appendShape(doc, svg, "circle", {
    cx: "12",
    cy: "18",
    r: "1.2",
    fill: "#ffffff",
  });
  appendShape(doc, svg, "rect", {
    x: "15.5",
    y: "17",
    width: "9",
    height: "2",
    rx: "1",
    fill: "#ffffff",
  });
  appendShape(doc, svg, "circle", {
    cx: "12",
    cy: "23",
    r: "1.2",
    fill: "#ffffff",
  });
  appendShape(doc, svg, "rect", {
    x: "15.5",
    y: "22",
    width: "6",
    height: "2",
    rx: "1",
    fill: "#ffffff",
  });
  return svg;
}

/**
 * A plain X for the panel's close button.
 *
 * Stroked with `currentColor` rather than the flat white the player-bar icons
 * use: those sit on video, this sits on the panel, which is white on the light
 * theme. The stylesheet sets the colour from the theme.
 */
function buildCloseIcon(doc: Document): Element {
  const svg = createIconSvg(doc);
  appendShape(doc, svg, "path", {
    d: "M11 11l14 14M25 11L11 25",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
  });
  return svg;
}

/**
 * Build the panel's close button. Hangs off `<body>` rather than being injected
 * into the panel, because the panel is the site's own element and its renderer
 * rebuilds that subtree — see the stylesheet's note on `.wfs-panel-close`.
 *
 * Created once per session and left in place; the stylesheet decides whether it
 * shows, from the same class that docks the panel.
 */
function buildPanelCloseButton(doc: Document, onActivate: () => void): HTMLElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = PANEL_CLOSE_CLASS;
  button.setAttribute("aria-label", PANEL_CLOSE_LABEL);
  button.title = PANEL_CLOSE_LABEL;
  button.appendChild(buildCloseIcon(doc));
  button.addEventListener("click", (event) => {
    // The button is outside the site's tree, so nothing of the site's is
    // listening — but the page has document-level handlers, and a click that
    // reaches them from a control the site does not know about is a good way to
    // trip something unrelated.
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  return button;
}

// `DockId` used to be declared here, beside the grip that moves a dock. It now
// lives in §1: the adapter interface, `SitePrefs`, and the stylesheet tokens all
// speak in terms of it, and all three come before this section.

/** How far one arrow-key press moves a dock's edge, in CSS px. */
const DOCK_KEY_STEP_PX = 16;

/** The same with `Shift` held, for crossing the range without holding a key. */
const DOCK_KEY_STEP_LARGE_PX = 64;

/**
 * Clamp a proposed dock width to the range a drag is allowed to reach.
 *
 * Pure, so the guard is testable without a window.
 *
 * `floorPx` is the dock's default width for this window — what the stylesheet would
 * give it — and the drag stops there on the way in. Shrinking below the free default
 * is not something the paid control offers: it can only open the dock up.
 *
 * Outwards, the dock may take the whole window bar {@link DOCK_DRAG_RESERVE_PX} and
 * whatever the other dock is holding. The video is allowed to end up a sliver. That
 * is the point: the reader who wants to read chat at full width drags there, and
 * drags back when they want to watch. `otherDockPx` is the width the *other* dock is
 * taking right now, so two docks share one budget instead of each one measuring the
 * window as if it were alone.
 *
 * On a window too narrow for the floor and the reserve together, the floor wins: a
 * dock the reader can see and drag is a better answer than a correct arithmetic
 * result nobody can grab.
 */
export function clampDockWidth(options: {
  proposedPx: number;
  otherDockPx: number;
  viewportPx: number;
  floorPx: number;
}): number {
  const { proposedPx, otherDockPx, viewportPx } = options;
  // Never below the storage floor, whatever the caller asked for: a floor under
  // 320px would let a drag write a width no stylesheet would ever draw.
  const floorPx = Math.max(Math.round(options.floorPx), MIN_DOCK_WIDTH_PX);
  const ceiling = viewportPx - otherDockPx - DOCK_DRAG_RESERVE_PX;
  if (ceiling < floorPx) return floorPx;
  return Math.round(Math.min(Math.max(proposedPx, floorPx), ceiling));
}

/**
 * Build one dock's drag grip.
 *
 * Hangs off `<body>` and is positioned onto the dock's inboard edge by the
 * adapter's stylesheet, for the reason recorded against `.wfs-panel-close`: the
 * dock is the site's own element and its renderer rebuilds that subtree.
 *
 * A `<div>` with an explicit role rather than a `<button>`: a button's job is to
 * be pressed, and every browser and assistive technology treats it that way — the
 * separator role is what says "this thing has a position you can change", which is
 * also what makes the arrow-key handling below expected behaviour rather than a
 * surprise.
 *
 * Pointer capture is what makes the drag survive leaving the 10px target. Without
 * it a fast drag loses the pointer the moment it outruns the grip, and the reader
 * is left holding a mouse button that no longer does anything.
 */
function buildDockGrip(
  doc: Document,
  dock: DockId,
  handlers: {
    /** The dock's current width in px, for a drag or a key press to start from. */
    readWidth: () => number;
    /** The other dock's current width, so the two share one width budget. */
    readOtherWidth: () => number;
    /** The narrowest this dock may be dragged: its default width for this window. */
    readFloor: () => number;
    /** Called with every new width while the drag is live. Must be cheap. */
    onPreview: (px: number) => void;
    /** Called once when the drag ends, with the width to persist. */
    onCommit: (px: number) => void;
  },
): HTMLElement {
  const grip = doc.createElement("div");
  grip.className = DOCK_GRIP_CLASS;
  grip.setAttribute(DOCK_GRIP_ATTR, dock);
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", DOCK_GRIP_LABELS[dock]);
  // Reachable by keyboard, so the width is not a mouse-only setting.
  grip.tabIndex = 0;

  const view = doc.defaultView ?? window;

  /** Where the pointer went down, and how wide the dock was at that moment. */
  let startX = 0;
  let startWidth = 0;
  let pointerId: number | null = null;

  /**
   * The width the last frame was asked to paint, and the frame it is waiting on.
   *
   * Coalesced to one write per frame. A pointermove can fire several times per
   * frame on a high-rate mouse, and each write here re-parses a small stylesheet
   * and invalidates the player's layout — so an uncoalesced drag does that work
   * two or three times for one painted frame.
   */
  let pendingPx: number | null = null;
  let frame: number | null = null;

  const flush = (): void => {
    frame = null;
    if (pendingPx === null) return;
    const px = pendingPx;
    pendingPx = null;
    handlers.onPreview(px);
  };

  const schedule = (px: number): void => {
    pendingPx = px;
    if (frame !== null) return;
    frame = view.requestAnimationFrame(flush);
  };

  /** The width a pointer at `clientX` is asking for, already clamped. */
  const widthFor = (clientX: number): number =>
    clampDockWidth({
      // Both docks take width from the RIGHT edge, so dragging the grip left —
      // a decreasing clientX — makes the dock wider. Hence the subtraction.
      proposedPx: startWidth - (clientX - startX),
      otherDockPx: handlers.readOtherWidth(),
      viewportPx: view.innerWidth,
      floorPx: handlers.readFloor(),
    });

  const endDrag = (clientX: number | null): void => {
    if (pointerId === null) return;
    if (frame !== null) {
      view.cancelAnimationFrame(frame);
      frame = null;
    }
    pendingPx = null;

    const finalPx = clientX === null ? handlers.readWidth() : widthFor(clientX);
    try {
      grip.releasePointerCapture(pointerId);
    } catch {
      // Already released, which is the ordinary case on `pointerup`.
    }
    pointerId = null;
    grip.classList.remove(DOCK_GRIP_DRAGGING_CLASS);
    doc.documentElement.classList.remove(DOCK_RESIZING_CLASS);
    handlers.onCommit(finalPx);
  };

  grip.addEventListener("pointerdown", (event) => {
    const pointer = event as PointerEvent;
    // Primary button only. A right-click on the grip belongs to the page's own
    // context menu, and a middle-click is a scroll gesture.
    if (pointer.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    startX = pointer.clientX;
    startWidth = handlers.readWidth();
    pointerId = pointer.pointerId;
    try {
      grip.setPointerCapture(pointerId);
    } catch {
      // Capture refused: the drag still works while the pointer stays over the
      // grip, which is worse but not broken, so it is not worth refusing over.
    }
    grip.classList.add(DOCK_GRIP_DRAGGING_CLASS);
    doc.documentElement.classList.add(DOCK_RESIZING_CLASS);
  });

  grip.addEventListener("pointermove", (event) => {
    if (pointerId === null) return;
    schedule(widthFor((event as PointerEvent).clientX));
  });

  grip.addEventListener("pointerup", (event) => {
    endDrag((event as PointerEvent).clientX);
  });

  // `pointercancel` is the browser taking the pointer away — a touch turning into
  // a page scroll, a stylus leaving range. The width stays wherever the last
  // preview put it rather than snapping back: the reader saw that width, and
  // reverting it would look like the drag had been undone for no reason.
  grip.addEventListener("pointercancel", () => {
    endDrag(null);
  });

  grip.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (key.key !== "ArrowLeft" && key.key !== "ArrowRight") return;
    key.preventDefault();
    // Left widens, for the same reason the drag maths subtracts: the dock's edge
    // is what moves, and moving it left gives the dock more room.
    const step = key.shiftKey ? DOCK_KEY_STEP_LARGE_PX : DOCK_KEY_STEP_PX;
    const delta = key.key === "ArrowLeft" ? step : -step;
    const next = clampDockWidth({
      proposedPx: handlers.readWidth() + delta,
      otherDockPx: handlers.readOtherWidth(),
      viewportPx: view.innerWidth,
      floorPx: handlers.readFloor(),
    });
    // One press is one width, so it previews and commits together: there is no
    // drag in progress to coalesce, and a keyboard user who nudges once and walks
    // away must not lose the change to a commit that never came.
    handlers.onPreview(next);
    handlers.onCommit(next);
  });

  return grip;
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
  /** The controls container the observer is currently registered against. */
  private observedContainer: Element | null = null;
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

    // Watch first when there is already a bar to watch. When there is not, the
    // detection loop below covers the wait and calls back through `ensureButtons`.
    this.syncObserver(this.adapter.findControlsContainer(this.doc));
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
    this.observedContainer = null;
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

    // The one place that knows the current bar, so it is the place that re-points the
    // observer. Cheap and idempotent: a bar that has not changed costs one identity
    // comparison. This is what lets `syncObserver` refuse to watch anything until a
    // bar exists, instead of falling back to the document.
    this.syncObserver(container);

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
   * Watch for our controls being removed, or the control bar being re-rendered.
   *
   * SCOPE IS THE WHOLE POINT OF THIS FUNCTION, so it is worth being explicit about
   * what it does not watch. It used to observe the player root with
   * `{ childList: true, subtree: true }`, falling back to `documentElement`. That is
   * the single most expensive thing the extension did, and it did it for the entire
   * life of every watch page whether or not the mode was ever switched on. The player
   * subtree is the busiest part of YouTube: caption cues mount and unmount as the
   * video speaks, the progress bar rebuilds its segments, chapter markers and
   * storyboard previews come and go. Every one of those allocated a MutationRecord
   * and queued a microtask for us, to answer a question about four buttons that had
   * not moved. §7's `startPlayerWatcher` carries a comment saying document-wide
   * subtree observation is "a real source of jank on YouTube" and carefully avoids
   * it; this was the same mistake one element lower down.
   *
   * There was a second, quieter bug in the same place. The callback funnels into
   * `scheduleEnsure`, which clears and re-arms a {@link DEBOUNCE_MS} timer. Under a
   * mutation stream that never pauses for 100 ms — which is what playback with
   * captions on looks like — the timer was reset forever and `ensureButtons` never
   * ran at all. Narrowing the scope fixes the correctness bug and the cost together,
   * which is the usual shape of this kind of thing.
   *
   * What is actually needed is narrow. Our controls are direct children of the
   * controls container, so `childList` on the container sees them being removed. The
   * site can also replace the container wholesale, so its parent gets the same
   * treatment. Neither node churns during playback. No `subtree` anywhere.
   *
   * The initial mount needs no observer: {@link runDetection} already polls
   * {@link MAX_DETECTION_ATTEMPTS} times at {@link DETECTION_INTERVAL_MS}, which is
   * what covers the window before a bar exists. So this returns quietly when there is
   * nothing to watch yet, and `ensureButtons` calls it back with the container the
   * moment there is one.
   *
   * Idempotent, and re-targets: passing a different container disconnects the old
   * registration first, so a re-rendered bar does not leave us watching a detached
   * node while its replacement drops our buttons unseen.
   */
  private syncObserver(container: Element | null): void {
    if (typeof MutationObserver === "undefined") return;
    if (!container) return;
    if (this.observedContainer === container && isConnected(container)) return;

    this.observer?.disconnect();
    this.observedContainer = container;
    this.observer = new MutationObserver(() => {
      // The site removed our button while the mode is off: hand off to the
      // bounded re-render loop rather than re-injecting immediately.
      if (this.hasDetachedButton() && !this.isModeActive()) {
        this.startReRenderLoop();
        return;
      }
      this.scheduleEnsure();
    });
    this.observer.observe(container, { childList: true });
    const parent = container.parentElement;
    if (parent) this.observer.observe(parent, { childList: true });
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

// --- Frame capture ---------------------------------------------------------

/** What one capture attempt produced. */
export type CaptureResult =
  | { outcome: "ok"; blob: Blob }
  /** The frame drew, but every sampled pixel was pure black. */
  | { outcome: "blank" }
  | { outcome: "no-video" }
  | { outcome: "failed"; error: string };

/**
 * How many points across the frame are sampled to decide whether it is blank.
 *
 * A 3×3 grid, inset from the edges. Nine single-pixel reads rather than one read
 * of the whole frame: `getImageData` over a 4K canvas copies 33 million bytes to
 * answer a question nine pixels can answer, and this runs on a click.
 */
const CAPTURE_SAMPLE_GRID = 3;

/**
 * Capture the current frame.
 *
 * The blank check is the interesting part, and it is deliberately not a claim
 * about why. Protected playback — a rental, a film — produces one of two things in
 * Chrome: a canvas that throws on read because the draw tainted it, or a frame of
 * pure black. Both arrive here as `blank`, and the message the reader gets names
 * the likely cause without asserting it, because a video that has genuinely faded
 * to black is indistinguishable from a protected one at this level and telling
 * someone their unprotected video is protected is worse than being vague.
 *
 * No retry, and no loop. A frame the reader wanted is a frame they can ask for
 * again, and the alternative is a bounded loop that saves a *different* frame from
 * the one they were looking at.
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  options?: { burnTimestamp?: boolean },
): Promise<CaptureResult> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  // Metadata has not arrived, so there is no frame yet — distinct from a failure,
  // because waiting a second and pressing again works.
  if (!width || !height) return { outcome: "no-video" };

  const doc = video.ownerDocument;
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return { outcome: "failed", error: "no drawing context" };

  try {
    ctx.drawImage(video, 0, 0, width, height);
  } catch (err) {
    // Some builds refuse the draw outright for protected media rather than
    // tainting the canvas. Reported as blank, not as a failure: the reader's
    // situation and the message they need are identical either way.
    warn(DIAGNOSTIC.captureBlank, "The frame could not be drawn.", {
      error: describeError(err),
    });
    return { outcome: "blank" };
  }

  // Reading the canvas is what a tainted one refuses, so this doubles as the
  // protected-media check and the blank check.
  try {
    let lit = false;
    for (let row = 1; row <= CAPTURE_SAMPLE_GRID && !lit; row += 1) {
      for (let col = 1; col <= CAPTURE_SAMPLE_GRID && !lit; col += 1) {
        const x = Math.floor((width * col) / (CAPTURE_SAMPLE_GRID + 1));
        const y = Math.floor((height * row) / (CAPTURE_SAMPLE_GRID + 1));
        const [r = 0, g = 0, b = 0] = ctx.getImageData(x, y, 1, 1).data;
        if (r !== 0 || g !== 0 || b !== 0) lit = true;
      }
    }
    if (!lit) return { outcome: "blank" };
  } catch {
    return { outcome: "blank" };
  }

  // Burn video playback timestamp into the bottom-right corner when requested.
  if (options?.burnTimestamp && Number.isFinite(video.currentTime) && video.currentTime >= 0) {
    const totalSec = Math.floor(video.currentTime);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    const timeText = hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;

    const fontSize = Math.max(16, Math.round(height * 0.035));
    ctx.font = `600 ${fontSize}px sans-serif`;
    const textMetrics = ctx.measureText(timeText);
    const paddingX = Math.round(fontSize * 0.5);
    const paddingY = Math.round(fontSize * 0.3);
    const boxWidth = textMetrics.width + paddingX * 2;
    const boxHeight = fontSize + paddingY * 2;
    const margin = Math.round(height * 0.03);

    const x = width - boxWidth - margin;
    const y = height - boxHeight - margin;

    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, boxWidth, boxHeight, 6);
    } else {
      ctx.rect(x, y, boxWidth, boxHeight);
    }
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    ctx.fillText(timeText, x + paddingX, y + paddingY);
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    // PNG, not JPEG: this is a still of someone's video, and a lossy re-encode of
    // an already-lossy stream is visible on flat colour and text.
    canvas.toBlob((result) => resolve(result), "image/png");
  });
  if (!blob) return { outcome: "failed", error: "encoding produced nothing" };
  return { outcome: "ok", blob };
}

/**
 * Save a blob to the reader's downloads using a temporary `<a download>`.
 *
 * Deliberately not `chrome.downloads`. That API needs the `downloads` permission,
 * which shows up on the install screen as "Manage your downloads" and would be a
 * new permission warning on an update — a heavy price for a filename we can get
 * from an anchor. The object URL is revoked immediately after the click, which is
 * safe because the browser has already taken its own reference by then.
 */
function downloadBlob(doc: Document, blob: Blob, filename: string): void {
  const view = doc.defaultView ?? window;
  const url = view.URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  // Not appended to the document. A detached anchor's click still downloads, and
  // appending would put an element of ours into the site's tree for a frame.
  link.click();
  view.URL.revokeObjectURL(url);
}

/**
 * Put an image on the clipboard. Returns whether it worked.
 *
 * Only ever called from inside a click handler: the Clipboard API requires a user
 * gesture and a focused document, and both are true of a button press and neither
 * is true of anything else this extension does.
 */
async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    // Refused, unfocused, or unsupported. The caller falls back to a download,
    // which is the outcome the reader wanted either way.
    return false;
  }
}

/** Format seconds (e.g. 125) into a human readable timestamp (e.g. 02:05 or 01:02:05). */
export function formatPlaybackTimestamp(seconds: number): string {
  const s = Math.floor(Math.max(seconds, 0));
  const m = Math.floor(s / 60);
  const remS = s % 60;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(remM)}:${pad(remS)}`;
  return `${pad(remM)}:${pad(remS)}`;
}

/**
 * Copy the current page URL with the playback timestamp (e.g. `&t=120s`) to the clipboard.
 */
export async function copyLinkAtCurrentTime(
  doc: Document,
  video: HTMLVideoElement | null,
): Promise<boolean> {
  try {
    const href =
      doc.defaultView?.location?.href ??
      (typeof window !== "undefined" ? window.location?.href : "");
    if (!href) return false;
    const url = new URL(href);
    if (video && Number.isFinite(video.currentTime) && video.currentTime > 0) {
      url.searchParams.set("t", `${Math.floor(video.currentTime)}s`);
    }
    const text = url.toString();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback to execCommand below.
    }
    if (doc.createElement && doc.body) {
      const textarea = doc.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      doc.body.appendChild(textarea);
      textarea.select();
      const ok = doc.execCommand?.("copy") ?? false;
      textarea.remove();
      if (ok) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Extract all transcript segments with their timestamps from the current document.
 * Formats segments cleanly into "[timestamp] [text]" lines.
 * Returns null if no transcript or timeline segments are present in the document.
 */
export function extractTranscriptText(doc: Document): string | null {
  const lines: string[] = [];

  // Strategy 1: Direct segment elements anywhere in the document (modern Lit view models and legacy renderers)
  const segments = doc.querySelectorAll?.(
    "transcript-segment-view-model, ytd-transcript-segment-renderer, ytd-transcript-search-panel-renderer ytd-transcript-segment-renderer, .ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer, [class*='transcript-segment']",
  );

  if (segments && segments.length > 0) {
    for (const segment of Array.from(segments)) {
      const timeEl = segment.querySelector?.(
        ".segment-timestamp, [class*='timestamp'], [class*='time'], div.segment-timestamp, span.segment-timestamp, #time, #segment-timestamp, [class*='Timestamp']",
      );
      const textEl = segment.querySelector?.(
        ".segment-text, [class*='text'], yt-formatted-string.segment-text, .yt-core-attributed-string, yt-formatted-string, #text, [class*='Text']",
      );

      let timeStr = (timeEl?.textContent ?? "").trim();
      let textStr = (textEl?.textContent ?? "").trim();

      if (!timeStr) {
        const full = (segment.textContent ?? "").trim();
        const m = full.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*([\s\S]*)$/);
        if (m) {
          timeStr = m[1].trim();
          textStr = m[2].trim();
        }
      } else if (!textStr) {
        textStr = (segment.textContent ?? "").replace(timeStr, "").trim();
      }

      // Strip redundant second counter if rendered (e.g. "0:000 seconds")
      textStr = textStr.replace(/^\d+\s*seconds?\s*/i, "");
      textStr = textStr.replace(/\s+/g, " ").trim();
      if (timeStr && textStr) {
        lines.push(`${timeStr} ${textStr}`);
      } else if (textStr) {
        lines.push(textStr);
      }
    }
    if (lines.length > 0) return lines.join("\n");
  }

  // Strategy 2: Chapter / Macro-markers items (timeline-chapter-view-model, ytd-macro-markers-list-item-renderer)
  const chapterItems = doc.querySelectorAll?.(
    "timeline-chapter-view-model, macro-markers-panel-item-view-model, timeline-item-view-model, ytd-macro-markers-list-item-renderer, ytd-macro-markers-panel-renderer ytd-macro-markers-list-item-renderer, [class*='macro-markers-list-item']",
  );
  if (chapterItems && chapterItems.length > 0) {
    for (const item of Array.from(chapterItems)) {
      const timeEl = item.querySelector?.("#time, .time, [class*='time'], div#time, [class*='Timestamp']");
      const textEl = item.querySelector?.("#details #title, #title, .title, [class*='title'], [class*='Title']");
      const timeStr = (timeEl?.textContent ?? "").trim();
      let textStr = (textEl?.textContent ?? "").trim();
      if (!textStr) {
        textStr = (item.textContent ?? "").replace(timeStr, "").trim();
      }
      textStr = textStr.replace(/\s+/g, " ");
      if (timeStr && textStr) {
        lines.push(`${timeStr} ${textStr}`);
      } else if (textStr) {
        lines.push(textStr);
      }
    }
    if (lines.length > 0) return lines.join("\n");
  }

  // Strategy 3: Check ALL engagement panels in the document
  const allPanels = doc.querySelectorAll?.("ytd-engagement-panel-section-list-renderer");
  if (allPanels && allPanels.length > 0) {
    for (const panel of Array.from(allPanels)) {
      const rows = panel.querySelectorAll?.(
        "#content [role='button'], #content [class*='segment'], #content [class*='renderer'], #content [class*='item'], #content > div > div > *",
      );
      if (rows && rows.length > 0) {
        const panelLines: string[] = [];
        for (const row of Array.from(rows)) {
          const text = (row.textContent ?? "").trim();
          const m = text.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+([\s\S]+)$/);
          if (m) {
            const time = m[1].trim();
            const cleanText = m[2].trim().replace(/\s+/g, " ");
            panelLines.push(`${time} ${cleanText}`);
          }
        }
        if (panelLines.length > 0) return panelLines.join("\n");
      }

      // Strategy 4: Raw text parsing inside panel #content
      const contentEl = panel.querySelector?.("#content");
      if (contentEl) {
        const rawText = contentEl.textContent ?? "";
        const regex = /(\d{1,2}:\d{2}(?::\d{2})?)\s*([^\n\d]+(?:(?!\d{1,2}:\d{2})[^\n])*)/g;
        let match: RegExpExecArray | null;
        const panelLines: string[] = [];
        while ((match = regex.exec(rawText)) !== null) {
          const time = match[1].trim();
          const cleanText = match[2].trim().replace(/\s+/g, " ");
          if (cleanText && cleanText !== "Timeline" && cleanText !== "Transcript" && cleanText !== "Search transcript") {
            panelLines.push(`${time} ${cleanText}`);
          }
        }
        if (panelLines.length > 0) return panelLines.join("\n");
      }
    }
  }

  return null;
}

/**
 * Copy the video transcript with timestamps to the clipboard.
 */
export async function copyTranscriptWithTimestamps(
  doc: Document,
  say?: (msg: string) => void,
): Promise<boolean> {
  try {
    const text = extractTranscriptText(doc);
    if (!text) {
      say?.("No transcript found to copy.");
      return false;
    }

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        say?.("Transcript copied with timestamps.");
        return true;
      }
    } catch {
      // Fallback to execCommand below.
    }

    if (doc.createElement && doc.body) {
      const textarea = doc.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      doc.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = doc.execCommand?.("copy") ?? false;
      textarea.remove();
      if (ok) {
        say?.("Transcript copied with timestamps.");
        return true;
      }
    }
    say?.("Could not copy transcript.");
    return false;
  } catch {
    say?.("Could not copy transcript.");
    return false;
  }
}

/**
 * Build the filename for a captured frame: the site's own name for what is
 * playing, then the wall-clock time, then `.png`.
 *
 * Supports custom templates like `{title}-{date}-{time}.png`.
 */
export function captureFilename(
  stem: string | null,
  now: Date,
  template?: string,
  extra?: { videoTitle?: string; channelName?: string; playbackTimestamp?: string },
): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = String(now.getFullYear());
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());

  const dateStr = `${year}-${month}-${day}`;
  const timeStr = `${hours}${minutes}${seconds}`;
  const stamp = `${dateStr}-${timeStr}`;

  // Anything a filesystem might object to becomes a dash, and a run of them
  // collapses, so a site that hands back a title rather than an id still produces
  // a sane name.
  const safe = (stem ?? "frame").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const cleanStem = safe === "" ? "frame" : safe;

  const rawTitle = extra?.videoTitle
    ? extra.videoTitle.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    : cleanStem;
  const cleanTitle = rawTitle === "" ? cleanStem : rawTitle;

  const rawChannel = extra?.channelName
    ? extra.channelName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  const cleanChannel = rawChannel.replace(/^-+|-+$/g, "");

  const cleanTimestamp = extra?.playbackTimestamp
    ? extra.playbackTimestamp.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    : stamp;

  if (template && template.trim().length > 0) {
    let result = template
      .replace(/\{title\}/gi, cleanTitle)
      .replace(/\{channel\}/gi, cleanChannel)
      .replace(/\{timestamp\}/gi, cleanTimestamp)
      .replace(/\{stem\}/gi, cleanStem)
      .replace(/\{date\}/gi, dateStr)
      .replace(/\{time\}/gi, timeStr)
      .replace(/\{site\}/gi, "windowed-fullscreen");
    result = result.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (result.length > 0) {
      return result.endsWith(".png") ? result : `${result}.png`;
    }
  }

  return `windowed-fullscreen-${cleanStem}-${stamp}.png`;
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
 * How long a per-channel auto-apply rule waits for the page to say which channel
 * it is showing.
 *
 * 32 attempts at 250ms, so eight seconds.
 *
 * This exists because a per-channel rule was a race the page always won. The
 * channel is named by the owner row, which lives inside the below-video block —
 * and that block mounts SEVERAL SECONDS after the player, which is already written
 * down on `hasSideContent` in §1 because it caused a different bug there. Every
 * moment auto-apply is otherwise triggered lands before then: preferences
 * resolving, the entitlement record arriving, our button appearing (the player, not
 * the owner row), and the video changing. So `readChannel` returned null, the rule
 * did not match, and the `autoApplied` latch meant nothing ever looked again. The
 * per-site switch never had this problem because it needs no page content to
 * decide.
 *
 * Eight seconds because "several seconds" is the observation this has to survive,
 * and a rule that fires late is still the thing the reader asked for while a rule
 * that never fires is not. Bounded, like every other loop here: at the cap it emits
 * `channel-rule-abandoned` and stops rather than watching the page forever.
 */
const CHANNEL_RULE_RETRY_MS = 250;
const MAX_CHANNEL_RULE_ATTEMPTS = 32;

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

/** Size (px) of the offscreen canvas used to sample ambient edge colours / render glow. */
const GLOW_CANVAS_WIDTH = 24;
const GLOW_CANVAS_HEIGHT = 14;

const AMBIENT_GLOW_CANVAS_ID = "wfs-ambient-glow-canvas";

/** How long before the mouse cursor hides in windowed fullscreen when idle, in ms. */
const CURSOR_AUTOHIDE_MS = 3000;

interface GlowSampler {
  start(): void;
  stop(): void;
  dispose(): void;
}

function createGlowSampler(
  doc: Document,
  getVideo: () => HTMLVideoElement | null,
  isModeActive: () => boolean,
  _onColor?: (rgbColor: string) => void,
): GlowSampler {
  let isRunning = false;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let callbackHandle: number | null = null;
  let isRvfc = false;
  let currentVideo: HTMLVideoElement | null = null;
  let listeningVideo: HTMLVideoElement | null = null;

  const cancelScheduledFrame = (): void => {
    if (callbackHandle !== null) {
      if (
        isRvfc &&
        currentVideo &&
        "cancelVideoFrameCallback" in currentVideo &&
        typeof (currentVideo as unknown as { cancelVideoFrameCallback: (id: number) => void })
          .cancelVideoFrameCallback === "function"
      ) {
        try {
          (currentVideo as unknown as { cancelVideoFrameCallback: (id: number) => void }).cancelVideoFrameCallback(
            callbackHandle,
          );
        } catch {
          // Ignored if video detached
        }
      } else {
        const win = doc.defaultView ?? globalThis;
        if (typeof win.cancelAnimationFrame === "function") {
          win.cancelAnimationFrame(callbackHandle);
        }
      }
      callbackHandle = null;
    }
  };

  const scheduleNextFrame = (): void => {
    if (!isRunning) return;
    cancelScheduledFrame();

    const video = getVideo();
    currentVideo = video;

    if (
      video &&
      "requestVideoFrameCallback" in video &&
      typeof (video as unknown as { requestVideoFrameCallback: (cb: () => void) => number })
        .requestVideoFrameCallback === "function"
    ) {
      isRvfc = true;
      try {
        callbackHandle = (video as unknown as { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(
          renderFrame,
        );
        return;
      } catch {
        // Fall back to requestAnimationFrame if RVFC throws
      }
    }

    isRvfc = false;
    const win = doc.defaultView ?? globalThis;
    if (typeof win.requestAnimationFrame === "function") {
      callbackHandle = win.requestAnimationFrame(renderFrame);
    }
  };

  const ensureCanvas = (video: HTMLVideoElement): HTMLCanvasElement | null => {
    const parent = video.parentElement ?? doc.body;
    if (canvas && canvas.isConnected && canvas.parentElement === parent) {
      return canvas;
    }

    const existing = doc.getElementById(AMBIENT_GLOW_CANVAS_ID) as HTMLCanvasElement | null;
    if (existing && existing.parentElement === parent) {
      canvas = existing;
      if (!ctx) {
        try {
          ctx = canvas.getContext("2d", { willReadFrequently: false });
        } catch {
          ctx = null;
        }
      }
      return canvas;
    }

    if (existing) {
      existing.remove();
    }

    try {
      canvas = doc.createElement("canvas");
      canvas.id = AMBIENT_GLOW_CANVAS_ID;
      canvas.className = "wfs-ambient-glow-canvas";
      canvas.width = GLOW_CANVAS_WIDTH;
      canvas.height = GLOW_CANVAS_HEIGHT;
      canvas.setAttribute("aria-hidden", "true");

      if (parent) {
        parent.insertBefore(canvas, video);
      }
      ctx = canvas.getContext("2d", { willReadFrequently: false });
      return canvas;
    } catch {
      return null;
    }
  };

  const renderFrame = (): void => {
    callbackHandle = null;
    if (!isRunning || !isModeActive()) {
      stop();
      return;
    }

    if (doc.visibilityState === "hidden" || doc.fullscreenElement !== null) {
      scheduleNextFrame();
      return;
    }

    const video = getVideo();
    if (!video || video.ended || video.readyState < 2) {
      scheduleNextFrame();
      return;
    }

    if (listeningVideo !== video) {
      attachVideoListeners(video);
    }

    const c = ensureCanvas(video);
    if (c && ctx) {
      try {
        ctx.drawImage(video, 0, 0, GLOW_CANVAS_WIDTH, GLOW_CANVAS_HEIGHT);
      } catch {
        // Cross-origin tainted canvas or detached video
      }
    }

    scheduleNextFrame();
  };

  const onVideoEvent = (): void => {
    if (isRunning && callbackHandle === null) {
      renderFrame();
    }
  };

  const attachVideoListeners = (video: HTMLVideoElement): void => {
    if (listeningVideo === video) return;
    detachVideoListeners();
    listeningVideo = video;
    video.addEventListener("play", onVideoEvent);
    video.addEventListener("playing", onVideoEvent);
    video.addEventListener("seeked", onVideoEvent);
    video.addEventListener("timeupdate", onVideoEvent);
  };

  const detachVideoListeners = (): void => {
    if (listeningVideo) {
      listeningVideo.removeEventListener("play", onVideoEvent);
      listeningVideo.removeEventListener("playing", onVideoEvent);
      listeningVideo.removeEventListener("seeked", onVideoEvent);
      listeningVideo.removeEventListener("timeupdate", onVideoEvent);
      listeningVideo = null;
    }
  };

  const start = (): void => {
    if (isRunning) return;
    isRunning = true;
    const video = getVideo();
    if (video) {
      attachVideoListeners(video);
      ensureCanvas(video);
    }
    renderFrame();
  };

  const stop = (): void => {
    isRunning = false;
    cancelScheduledFrame();
    detachVideoListeners();
    if (canvas) {
      canvas.remove();
      canvas = null;
      ctx = null;
    }
    const existing = doc.getElementById(AMBIENT_GLOW_CANVAS_ID);
    existing?.remove();
  };

  const dispose = (): void => {
    stop();
  };

  return { start, stop, dispose };
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

  /**
   * The entitlement record, held rather than read per press.
   *
   * `isPro` is a pure predicate over this for the reason its own comment gives: the
   * controls that gate decide inside a click handler, where there is nothing to
   * await into. The record is loaded once below and followed with
   * {@link watchProState}, so a key accepted in the popup — or in this page's own Pro
   * prompt — unlocks this page without a reload, the same shape as the preference
   * watch.
   */
  let pro: ProState = { ...DEFAULT_PRO_STATE };

  let activeChannelMode: WindowedMode | null = null;
  const currentMode = (): WindowedMode => activeChannelMode ?? modeFor(prefs);

  const controller = new WindowedFullscreenController(doc, currentMode);
  const resolve = (): SiteDescriptor | null => resolveDescriptor(adapter, doc, currentMode());

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

  const glowSampler = createGlowSampler(
    doc,
    () => adapter.findVideo?.(doc) ?? null,
    () => controller.isActive,
    (glowColor) => {
      writeLetterboxCss(doc, glowColor);
    },
  );

  const updateLetterboxAndGlow = (): void => {
    if (!controller.isActive) {
      glowSampler.stop();
      removeLetterboxCss(doc);
      return;
    }
    if (isPro(pro) && prefs.ambientGlow) {
      glowSampler.start();
      removeLetterboxCss(doc);
    } else {
      glowSampler.stop();
      if (isPro(pro) && prefs.letterboxColor) {
        writeLetterboxCss(doc, prefs.letterboxColor);
      } else {
        removeLetterboxCss(doc);
      }
    }
  };

  let cursorTimer: number | null = null;

  const clearCursorTimer = (): void => {
    if (cursorTimer !== null) {
      timers().clearTimeout(cursorTimer);
      cursorTimer = null;
    }
  };

  const showCursor = (): void => {
    doc.documentElement.classList.remove(CURSOR_HIDDEN_CLASS);
  };

  const hideCursor = (): void => {
    if (
      controller.isActive &&
      prefs.cursorAutoHide !== false &&
      !doc.documentElement.classList.contains(CURSOR_HIDDEN_CLASS)
    ) {
      doc.documentElement.classList.add(CURSOR_HIDDEN_CLASS);
    }
  };

  const resetCursorTimer = (): void => {
    showCursor();
    clearCursorTimer();
    if (controller.isActive && prefs.cursorAutoHide !== false) {
      cursorTimer = timers().setTimeout(hideCursor, CURSOR_AUTOHIDE_MS) as unknown as number;
    }
  };

  const onPointerActivity = (): void => {
    // The early-out is on a hot path and is the reason it is written out rather than
    // left to `resetCursorTimer`'s own guards. `pointermove` fires on the order of a
    // hundred times a second while the mouse is moving, and with the mode off there
    // is no cursor to hide. This used to run the whole reset every time — a
    // `classList.remove` on <html> and a `clearTimeout` — on every watch page for the
    // life of the session, whether or not the mode was ever switched on.
    //
    // The listener stays registered rather than being mounted and unmounted with the
    // mode: one comparison per event is cheaper than getting an add/remove lifecycle
    // wrong, and `stop()` already removes this one.
    if (!controller.isActive) return;
    resetCursorTimer();
  };

  doc.addEventListener("pointermove", onPointerActivity, { passive: true });

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
    updateLetterboxAndGlow();
    resetCursorTimer();
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
    activeChannelMode = null;
    adoptStoredWidths(prefs);
    glowSampler.stop();
    removeLetterboxCss(doc);
    showCursor();
    clearCursorTimer();
    // A press can be in flight at the moment the mode ends — pressing transcript and
    // Escape in the same breath is enough. The class is inert outside the mode, being
    // nested under `.wfs-windowed`, but its timer is not, and a reservation carried
    // into the next entry would reserve a column for a press nobody made.
    clearTranscriptPending();
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

  /**
   * Look up the matched channel rule for the current page if the reader is entitled.
   */
  const getAutoApplyRule = (): ChannelRule | null => {
    if (!isPro(pro)) return null;
    return findChannelRule(prefs, adapter.readChannel?.(doc) ?? null);
  };

  /**
   * Whether auto-apply should fire on this page, from the per-site switch or a
   * per-channel rule.
   *
   * The per-site switch has been free since 1.2.0 and stays free. Per-channel rules
   * are Pro, and the gate is here rather than at the point the rules are stored: a
   * reader whose entitlement lapses keeps their rules, so re-entering a key puts
   * them straight back to work instead of asking them to type a channel list again.
   */
  const autoApplyWanted = (): boolean => {
    if (autoApplyEnabled) return true;
    return getAutoApplyRule() !== null;
  };

  /**
   * Whether a per-channel rule could still turn out to apply here, but cannot be
   * judged yet because the page has not named its channel.
   *
   * Deliberately narrow: true only with an entitlement, with rules stored, with the
   * site offering a channel reader, and with that reader coming back empty. So a
   * reader with no rules schedules no retries at all, and neither does a site that
   * has no notion of a channel.
   *
   * The known limit: on an in-app navigation the owner row can still hold the
   * PREVIOUS video's channel for a frame or two, and a read that returns the old
   * channel counts as decided here. YouTube blanks the row during the swap far more
   * often than it leaves it stale, so in practice this waits rather than answering
   * from the last video — and the alternative, refusing a channel until it differs
   * from the one before it, would refuse two videos from the same channel forever.
   */
  const channelRuleUndecided = (): boolean => {
    if (autoApplyEnabled || !isPro(pro) || prefs.channels.length === 0) return false;
    if (!adapter.readChannel) return false;
    return adapter.readChannel(doc) === null;
  };

  /**
   * Attempts already spent waiting for the channel, the pending retry, and the
   * one-shot flag that stops the give-up line repeating. All three are reset per
   * video, so each video gets its own window.
   */
  let channelRuleAttempts = 0;
  let channelRuleGaveUp = false;
  let channelRuleTimer: number | null = null;

  const clearChannelRuleWatch = (): void => {
    if (channelRuleTimer === null) return;
    timers().clearTimeout(channelRuleTimer);
    channelRuleTimer = null;
  };

  /** Start the window over: a new video, or an entitlement that has just arrived. */
  const resetChannelRuleWatch = (): void => {
    clearChannelRuleWatch();
    channelRuleAttempts = 0;
    channelRuleGaveUp = false;
  };

  /**
   * Look again shortly, because the only thing missing is the channel.
   *
   * A no-op unless a rule is genuinely waiting on the page, so this costs nothing
   * for the reader who has no rules — which is every reader without a licence.
   */
  const scheduleChannelRuleRetry = (): void => {
    if (channelRuleTimer !== null || channelRuleGaveUp) return;
    if (!channelRuleUndecided()) return;
    if (channelRuleAttempts >= MAX_CHANNEL_RULE_ATTEMPTS) {
      // Give up loudly, once. The page has had five seconds to name its channel;
      // waiting longer would put the mode on top of a reader already watching.
      channelRuleGaveUp = true;
      warn(
        DIAGNOSTIC.channelRuleAbandoned,
        "The page never named its channel, so per-channel auto-apply did not run.",
        { siteId: adapter.siteId, attempts: channelRuleAttempts },
      );
      return;
    }
    channelRuleAttempts += 1;
    channelRuleTimer = timers().setTimeout(() => {
      channelRuleTimer = null;
      maybeAutoApply();
    }, CHANNEL_RULE_RETRY_MS) as unknown as number;
  };

  const maybeAutoApply = (): void => {
    if (!prefResolved || autoApplied || controller.isActive) return;
    if (!autoApplyWanted()) {
      // Not "no", possibly "not yet": the owner row mounts on the site's own
      // schedule, later than everything that triggers this. See
      // CHANNEL_RULE_RETRY_MS for the race this closes.
      scheduleChannelRuleRetry();
      return;
    }
    const rule = getAutoApplyRule();
    // Decided, so nothing is waiting on the page any more.
    clearChannelRuleWatch();
    // The reader has just left fullscreen for the plain player. Both refusals
    // hold until one of the four events in the latch's comment above.
    if (autoApplySuppressed || Date.now() < normalPlayerUntilMs) return;
    // Never arrive on top of browser fullscreen; see the fullscreen handoff below.
    if (doc.fullscreenElement) return;

    if (rule && rule.scrollable !== null) {
      activeChannelMode = rule.scrollable ? "scrollable" : "cover";
    } else {
      activeChannelMode = null;
    }

    const descriptor = resolve();
    // Not ready yet; the next button change re-triggers this.
    if (!descriptor) return;

    if (rule) {
      for (const dock of DOCK_IDS) {
        if (rule.dockWidths[dock] > 0) {
          liveWidths[dock] = rule.dockWidths[dock];
        }
      }
      applyDockWidths();
    }

    autoApplied = true;
    if (enterMode(descriptor)) {
      if (rule?.panel) {
        controller.setPanelOpen(true);
      }
    }
  };

  /**
   * Switch modes without leaving the mode. Exit restores the page, so a fresh
   * descriptor has to be resolved afterwards — the chrome it hides differs
   * between the two modes.
   */
  const reapplyMode = (): void => {
    if (!controller.isActive || controller.mode === currentMode()) return;
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

  /* -----------------------------------------------------------------------
     Transcript timing.

     Three numbers, all of them the site's pace rather than ours.
     ----------------------------------------------------------------------- */

  /**
   * How long to wait before asking the site a second time.
   *
   * The site's own transcript toggle can be left out of sync by a previous close:
   * its internal "panel is open" flag says open while no panel is expanded, so the
   * first press only clears the flag and the second is the one that opens anything.
   * One re-ask covers it. There is deliberately no third: past this, the press found
   * something that is not a transcript toggle, and clicking it repeatedly is how a
   * bounded retry turns into a fight with the page.
   */
  const TRANSCRIPT_RESYNC_DELAY_MS = 70;

  /**
   * When to select the Transcript tab in the panel the site just opened.
   *
   * Twice, not once. The panel mounts its header before its tab strip, so a single
   * attempt either lands too early to find the tabs or too late to hide the wrong
   * tab being selected first. The pair costs one wasted `querySelector` in the
   * common case, which is the cheaper of the two mistakes.
   */
  const TRANSCRIPT_TAB_DELAYS_MS = [200, 600] as const;

  /**
   * How long to give the description expander to mount the transcript button.
   *
   * Only reached on the layouts where none of the direct candidates exist, so the
   * description has to be opened first. One frame plus change; if the button is still
   * absent the panel's attribute is set directly rather than waiting again.
   */
  const TRANSCRIPT_DESCRIPTION_EXPAND_DELAY_MS = 100;

  /**
   * How long a press may hold the reserved column before it is given back.
   *
   * Set by the slowest thing it has to cover, which is the later
   * {@link TRANSCRIPT_TAB_DELAYS_MS} entry plus room for a slow mount. Too short and
   * a slow page hands the column back just as the panel arrives, which is the staged
   * open this whole mechanism exists to remove. Too long and a press on a video with
   * no transcript at all — music, some shorts — leaves an empty column up. Erring
   * long is the lesser fault: that column is only reachable by pressing a control on
   * a video that has nothing to show.
   */
  const TRANSCRIPT_PENDING_TIMEOUT_MS = 1_500;

  /** The expanded transcript/description panel, or null. */
  const findExpandedTranscriptPanel = (): HTMLElement | null =>
    doc.querySelector<HTMLElement>(
      `ytd-engagement-panel-section-list-renderer[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]`,
    );

  /** Timer holding the reserved column's bound. Null when no press is in flight. */
  let transcriptPendingTimer: number | null = null;

  /**
   * Give the reserved column back.
   *
   * Called when the panel actually opened, when it was closed again, and from the
   * bound below. Safe to call when nothing is pending.
   */
  const clearTranscriptPending = (): void => {
    if (transcriptPendingTimer !== null) {
      timers().clearTimeout(transcriptPendingTimer);
      transcriptPendingTimer = null;
    }
    doc.documentElement.classList.remove(TRANSCRIPT_PENDING_CLASS);
  };

  /**
   * Reserve the transcript column before the site is asked for the panel.
   *
   * Must run SYNCHRONOUSLY on the press, ahead of the site's own click handler —
   * that is the entire mechanism, and it is why the caller below listens in the
   * capture phase. See {@link TRANSCRIPT_PENDING_CLASS} (§6) for what the column
   * being reserved early buys, and for the patched-`scrollIntoView` dead end it
   * replaced.
   *
   * Does nothing when the mode is off (there is no column to reserve) or when a
   * panel is already expanded (nothing is in flight; the press is a close).
   */
  const markTranscriptPending = (): void => {
    if (!controller.isActive) return;
    if (findExpandedTranscriptPanel()) return;

    doc.documentElement.classList.add(TRANSCRIPT_PENDING_CLASS);
    if (transcriptPendingTimer !== null) timers().clearTimeout(transcriptPendingTimer);
    transcriptPendingTimer = timers().setTimeout(() => {
      transcriptPendingTimer = null;
      doc.documentElement.classList.remove(TRANSCRIPT_PENDING_CLASS);
      warn(
        DIAGNOSTIC.transcriptOpenAbandoned,
        "The transcript panel did not open; the reserved column was given back.",
        { siteId: adapter.siteId, waitedMs: TRANSCRIPT_PENDING_TIMEOUT_MS },
      );
    }, TRANSCRIPT_PENDING_TIMEOUT_MS) as unknown as number;
  };

  /**
   * Catch every route into the transcript, not just our own control.
   *
   * The reader can open it from the site's own description button or its chapter
   * readout, and those deserve the same instant dock as our button — so the column
   * is reserved here, in the CAPTURE phase, which is the last moment that is still
   * before the site's own handler. `toggleTranscript` clicks one of these same
   * elements, so its press arrives here too and there is exactly one place that
   * reserves the column.
   *
   * The second ask lives here for the same reason. It used to exist twice, once here
   * and once inside `toggleTranscript`, as two independent 70 ms re-clicks racing on
   * the same element with only one of them guarded against re-entry.
   */
  let transcriptResyncing = false;
  doc.addEventListener(
    "click",
    (e) => {
      const target = (e.target as HTMLElement | null)?.closest?.(
        ".ytp-chapter-title, .ytp-chapter-container, ytd-video-description-transcript-section-renderer button, button[aria-label*='transcript' i]",
      );
      if (!target) return;

      // Read the state BEFORE the site's handler runs, which is what the capture phase
      // is for. It decides whether this press is an open or a close, and the resync
      // below cannot work that out afterwards.
      const wasExpanded = findExpandedTranscriptPanel() !== null;

      markTranscriptPending();

      if (transcriptResyncing) return;
      // Only an OPEN earns a second ask. Closing the panel from the site's own control
      // used to re-open it: "no panel is expanded" is just as true after a successful
      // close as after a press that did not take, and the resync could not tell the two
      // apart. It re-clicked the reader's close and undid it.
      if (wasExpanded) return;
      timers().setTimeout(() => {
        if (findExpandedTranscriptPanel()) return;
        transcriptResyncing = true;
        (target as HTMLElement).click();
        transcriptResyncing = false;
      }, TRANSCRIPT_RESYNC_DELAY_MS);
    },
    true,
  );

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
    if (controller.isActive) {
      noteSessionStart();
      updateLetterboxAndGlow();
      resetCursorTimer();
    }
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
    // The stored widths are the durable copy of what a drag already applied here,
    // so this is a no-op for the tab that did the dragging and the whole point for
    // any other tab. `applyDockWidths` skips the write when the text is unchanged,
    // so the common case costs a string comparison.
    adoptStoredWidths(next);
    updateLetterboxAndGlow();
    reapplyMode();
  });

  /**
   * The close button on the docked panel. Mounted once for the session and shown
   * or hidden entirely by the stylesheet, so there is no state here to keep in
   * step with the panel's — pressing it just asks for the panel to close, and
   * `setPanelOpen` refusing (mode already off) changes nothing.
   */
  const panelCloseButton = buildPanelCloseButton(doc, () => {
    controller.setPanelOpen(false);
  });
  doc.body.appendChild(panelCloseButton);

  // -------------------------------------------------------------------------
  // Resizable docks (Pro).
  //
  // The widths themselves are one CSS custom property each, which is why this is
  // a small amount of code for a feature that moves the whole layout: §3 already
  // routes every rule that narrows something past a dock through
  // `--wfs-panel-width`, `--wfs-chat-width` and `--wfs-docked-width`, so the docks
  // cannot disagree about their shared edge and there is exactly one number to
  // write.
  //
  // Three things here are load-bearing:
  //
  //  - The width goes into a stylesheet of ours, never inline on <html>. See
  //    `getDockWidthCss` in §3: an inline custom property would outrank the
  //    fullscreen rule that collapses a dock to zero, and hand the site a player
  //    still holding a panel-sized gap to measure.
  //  - The site is asked to re-measure on drag END only. `refreshGeometry` is a
  //    synthetic resize, YouTube answers a resize with a relayout, and a relayout
  //    is when it strips `ytp-big-mode` — so nudging per pointermove turns one
  //    width change into a contest that burns the reassertion budget in seconds.
  //    The same reasoning as `GEOMETRY_REPAIR_DEBOUNCE_MS`, one level up.
  //  - The clamp reads the OTHER dock's width, so the two docks share one width
  //    budget instead of each measuring the window as if it were alone. The budget is
  //    the whole window bar a grabbable strip: a dock may take almost all of it and
  //    leave the video a sliver, because the same grip drags it straight back.
  // -------------------------------------------------------------------------

  /** Whether this site's docks can be resized at all. */
  const dockResizeSupported = typeof adapter.getDockWidthCss === "function";

  /**
   * The width in force for each dock: the reader's stored choice, or 0 meaning
   * "whatever the stylesheet's own responsive default works out to".
   *
   * Session-local and written by the drag before storage confirms, so the layout
   * follows the pointer rather than the round trip. `prefs` is the durable copy and
   * the preference watch reconciles the two.
   */
  const liveWidths: Record<DockId, number> = { ...DEFAULT_DOCK_WIDTHS };

  /**
   * The docks this site has, outboard to inboard, or none when it has no resizable
   * dock at all.
   *
   * Asked once per session. The order is what makes the running total in
   * `applyDockWidths` correct, so it is the adapter's order and never re-sorted here.
   */
  const docks: readonly DockId[] = adapter.supportedDocks ?? [];

  /**
   * The narrowest a drag may make either dock right now: the width the stylesheet
   * itself would give it at this window width.
   *
   * Read per drag frame rather than once, because it follows the window — the sheet's
   * default is a share of the viewport, so a resized window moves the floor with it.
   */
  const dockWidthFloor = (): number =>
    Math.max(
      adapter.getDefaultDockWidth?.(doc.defaultView?.innerWidth ?? 0) ?? MIN_DOCK_WIDTH_PX,
      MIN_DOCK_WIDTH_PX,
    );

  /**
   * Put the widths on screen, each brought inside what THIS window can hold.
   *
   * The clamp here is not a duplicate of the drag's. A stored width outlives the
   * window it was chosen in: drag chat to 1500px on a monitor, open the same video on
   * a 1200px laptop, and the raw number would render a dock wider than the viewport —
   * which puts its grip off the left edge, and a grip nobody can reach is a width
   * nobody can undo. So the reader's number is kept as stored, and only what is
   * PAINTED is clamped. Widen the window again and the full width comes back.
   *
   * Resolved outboard to inboard, each dock measured against the width the docks
   * outside it actually took rather than what they asked for. That running total is
   * why {@link DOCK_IDS} is ordered and why this loop must not re-sort it: chat holds
   * the window edge, so its width is settled before the panel inside it is fitted.
   */
  const applyDockWidths = (): void => {
    if (!adapter.getDockWidthCss) return;
    const viewportPx = doc.defaultView?.innerWidth ?? 0;
    const floorPx = dockWidthFloor();
    // 0 means "let the stylesheet's own responsive width decide", so it passes
    // through untouched: clamping it would turn the default into a fixed number that
    // stops following the window.
    // A viewport of 0 is a document with no window to measure, which only happens
    // during teardown. The stored number goes through unchanged rather than being
    // clamped against a window that does not exist.
    const fit = (px: number, otherDockPx: number): number =>
      px > 0 && viewportPx > 0
        ? clampDockWidth({ proposedPx: px, otherDockPx, viewportPx, floorPx })
        : Math.max(px, 0);
    const fitted: Record<DockId, number> = { ...DEFAULT_DOCK_WIDTHS };
    // What the docks already resolved are holding. Only the ones actually on screen
    // count: a width stored from a previous session must not eat into the space
    // available to a dock when the dock that owns it is shut.
    let takenPx = 0;
    for (const dock of docks) {
      fitted[dock] = fit(liveWidths[dock], takenPx);
      if (isDockVisible(dock)) takenPx += fitted[dock];
    }
    writeDockWidthCss(doc, adapter.getDockWidthCss(fitted));
  };

  /**
   * Re-fit on a window resize, so shrinking the window cannot leave a dock wider
   * than the viewport with its grip off the edge.
   *
   * Not tied to the grips: a reader whose licence has lapsed keeps the widths they
   * chose, so the fit has to keep running when there is nothing left to drag.
   * `writeDockWidthCss` skips a write when the text is unchanged, so a resize that
   * changes no width costs a string comparison.
   */
  const onViewportResize = (): void => {
    applyDockWidths();
  };
  if (dockResizeSupported) {
    doc.defaultView?.addEventListener("resize", onViewportResize, { passive: true });
  }

  /** The width a drag on this dock should start from. */
  const currentDockWidth = (dock: DockId): number => {
    const stored = liveWidths[dock];
    if (stored > 0) return stored;
    // Nothing stored, so the sheet's `clamp()` is in force and cannot be read back
    // as a number — measure what is on screen instead. See `measureDockWidth`.
    return Math.round(adapter.measureDockWidth?.(doc, dock) ?? 0) || DOCK_WIDTH_FALLBACK_PX;
  };

  /**
   * Whether a dock is currently taking viewport width.
   *
   * The comment panel is answered from our own class, because that dock's state is
   * the mode's. Every other dock is the site's own element, so the adapter is asked —
   * this used to query `#chat` right here, which put a YouTube selector in §9 and
   * meant a second site could not have had a chat dock at all.
   */
  const isDockVisible = (dock: DockId): boolean => {
    if (dock === "panel") return doc.documentElement.classList.contains(PANEL_CLASS);
    return adapter.isDockActive?.(doc, dock) ?? false;
  };

  /**
   * Take the widths from a preferences record and put them on screen.
   *
   * Only ever widens the source of truth in one direction: storage is authoritative
   * for a page that did not do the dragging, and for the page that did, the stored
   * value is what the drag just wrote, so adopting it changes nothing.
   */
  const adoptStoredWidths = (source: SitePrefs): void => {
    for (const dock of DOCK_IDS) liveWidths[dock] = source.dockWidths[dock];
    applyDockWidths();
  };

  const setDockWidth = (dock: DockId, px: number): void => {
    liveWidths[dock] = px;
    applyDockWidths();
  };

  const commitDockWidth = (dock: DockId, px: number): void => {
    setDockWidth(dock, px);
    // One re-measure for one width change, at the end, exactly as the comment
    // block above requires.
    controller.refreshGeometry();
    // The whole record is sent, not just the dock that moved. `setSitePrefs` merges
    // per field, and `dockWidths` is one field: patching it with a single dock would
    // drop the other docks' widths on every drag.
    const patch: Partial<SitePrefs> = { dockWidths: { ...liveWidths, [dock]: px } };
    void setSitePrefs(adapter.siteId, patch).then((result) => {
      if (result.ok) return;
      // The width the reader dragged to is still on screen and still correct for
      // this page; only the durable copy is missing. Said out loud rather than
      // silently reverted, because reverting would undo something they can see.
      showToast(doc, "That width could not be saved for next time.");
    });
  };

  /**
   * The grips, mounted only for an entitled reader.
   *
   * Absent rather than present-and-locked, deliberately. The capture control is the
   * one paid surface shown to everybody, because it is the only one a reader who
   * never opens the settings will meet; a grip is reachable only by someone already
   * exploring, so it has no funnel to serve — and a grip that showed a prompt when
   * dragged would be an affordance that lies about what it does.
   */
  let grips: HTMLElement[] = [];

  const mountGrips = (): void => {
    if (grips.length > 0 || !dockResizeSupported || !isPro(pro)) return;
    for (const dock of docks) {
      const grip = buildDockGrip(doc, dock, {
        readWidth: () => currentDockWidth(dock),
        readOtherWidth: () => {
          // Every dock but this one, and only while it is actually taking viewport
          // width. A stored width from a prior session must not eat into the space
          // available now if the dock that owns it is shut.
          let takenPx = 0;
          for (const other of docks) {
            if (other === dock || !isDockVisible(other)) continue;
            takenPx += currentDockWidth(other);
          }
          return takenPx;
        },
        readFloor: dockWidthFloor,
        onPreview: (px) => setDockWidth(dock, px),
        onCommit: (px) => commitDockWidth(dock, px),
      });
      doc.body.appendChild(grip);
      grips.push(grip);
    }
  };

  const unmountGrips = (): void => {
    for (const grip of grips) grip.remove();
    grips = [];
    doc.documentElement.classList.remove(DOCK_RESIZING_CLASS);
  };

  // -------------------------------------------------------------------------
  // Frame capture (Pro).
  // -------------------------------------------------------------------------

  /** Cancels the message currently on screen, so a teardown takes it with it. */
  let dismissToast: (() => void) | null = null;

  /** Closes the Pro prompt, for the same reason. */
  let dismissProPrompt: (() => void) | null = null;

  const say = (text: string): void => {
    dismissToast?.();
    dismissToast = showToast(doc, text);
  };

  /**
   * Show the paywall.
   *
   * The prompt is self-contained: checkout is an ordinary link, and a reader who
   * already owns a key activates it in the prompt itself. Neither needs the worker,
   * which is why the content script no longer sends it anything. The alternative —
   * opening the settings page on its licence field — needed a worker round trip,
   * because a content script cannot navigate to an extension URL unless that page is
   * web-accessible, and making the settings web-accessible would put them one link
   * away from every site on the internet.
   */
  const offerPro = (reason: "capture" | "other"): void => {
    dismissProPrompt?.();
    dismissProPrompt = showProPrompt(doc, { reason });
  };

  /**
   * The capture control, and the shortcut bound to it.
   *
   * Shown to everyone. A free press opens the prompt rather than doing nothing —
   * the manifest advertises the shortcut at the browser's own shortcuts page
   * whatever the entitlement, so a handler that silently declined would look like
   * a broken key rather than a paid feature.
   */
  const captureFrame = (): void => {
    if (!isPro(pro)) {
      offerPro("capture");
      return;
    }
    const video = adapter.findVideo?.(doc) ?? null;
    if (!video) {
      say(HELP_COPY.pro.captureNoVideo);
      return;
    }
    void (async () => {
      const result = await captureVideoFrame(video, {
        burnTimestamp: prefs.captureBurnTimestamp,
      });
      if (result.outcome === "no-video") {
        say(HELP_COPY.pro.captureNoVideo);
        return;
      }
      if (result.outcome === "blank") {
        say(HELP_COPY.pro.captureBlank);
        return;
      }
      if (result.outcome === "failed") {
        warn(DIAGNOSTIC.captureFailed, "Frame capture failed.", { error: result.error });
        say(HELP_COPY.pro.captureFailed);
        return;
      }

      // The clipboard is attempted first when asked for, and a refusal falls
      // through to a download rather than reporting a failure: the reader wanted
      // the frame, and the file is the same frame.
      if (prefs.captureToClipboard && (await copyBlobToClipboard(result.blob))) {
        say(HELP_COPY.pro.captureCopied);
        return;
      }
      const playbackTime =
        video && Number.isFinite(video.currentTime) && video.currentTime > 0
          ? formatPlaybackTimestamp(video.currentTime).replace(/:/g, "-")
          : undefined;
      const videoTitle =
        doc.querySelector("h1.ytd-watch-metadata yt-formatted-string, #title h1, h1.title")
          ?.textContent?.trim() ||
        doc.title.replace(/ - YouTube$/i, "").trim() ||
        undefined;
      const channelName =
        doc.querySelector(YT.channelName)?.textContent?.trim() ||
        adapter.readChannel?.(doc)?.label ||
        undefined;

      downloadBlob(
        doc,
        result.blob,
        captureFilename(
          adapter.readCaptureName?.(doc) ?? null,
          new Date(),
          prefs.captureFilenameTemplate,
          { videoTitle, channelName, playbackTimestamp: playbackTime },
        ),
      );
      say(HELP_COPY.pro.captureSaved);
    })();
  };

  const copyLink = (): void => {
    const video = adapter.findVideo?.(doc) ?? null;
    void copyLinkAtCurrentTime(doc, video).then((copied) => {
      if (copied) {
        const timeStr =
          video && Number.isFinite(video.currentTime) && video.currentTime > 0
            ? formatPlaybackTimestamp(video.currentTime)
            : null;
        say(timeStr ? `Link copied at ${timeStr}` : "Link copied to clipboard.");
      } else {
        say("Could not copy link.");
      }
    });
  };

  /** Injects a copy button into the transcript header if present and not already injected. */
  const updateTranscriptCopyButton = (): void => {
    const panels = doc.querySelectorAll(
      `ytd-engagement-panel-section-list-renderer[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"], ytd-engagement-panel-section-list-renderer:not([${YT.transcriptVisibilityAttr}="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"])`,
    );
    for (const panel of Array.from(panels)) {
      const headerRow = panel.querySelector<HTMLElement>(
        "ytd-engagement-panel-title-header-renderer #header, #header.ytd-engagement-panel-title-header-renderer",
      );
      if (!headerRow) continue;

      const existing = headerRow.querySelector(".wfs-copy-transcript-btn");
      if (existing) continue;

      const copyBtn = doc.createElement("button");
      copyBtn.className = "wfs-copy-transcript-btn";
      copyBtn.setAttribute("type", "button");
      copyBtn.setAttribute("title", "Copy transcript with timestamps");
      copyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span class="wfs-copy-label">Copy Transcript</span>
      `;

      copyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isPro(pro)) {
          offerPro("other");
          return;
        }
        void copyTranscriptWithTimestamps(doc, say).then((success) => {
          if (success) {
            const label = copyBtn.querySelector(".wfs-copy-label");
            if (label) {
              const prevText = label.textContent;
              label.textContent = "Copied! ✓";
              copyBtn.classList.add("wfs-copied");
              setTimeout(() => {
                label.textContent = prevText;
                copyBtn.classList.remove("wfs-copied");
              }, 2000);
            }
          }
        });
      });

      const visibilityBtn = headerRow.querySelector("#visibility-button, yt-icon-button#visibility-button, #information-button");
      if (visibilityBtn) {
        headerRow.insertBefore(copyBtn, visibilityBtn);
      } else {
        headerRow.appendChild(copyBtn);
      }
    }
  };

  const toggleTranscript = (): void => {
    if (!isPro(pro)) {
      offerPro("other");
      return;
    }

    const openPanels = Array.from(
      doc.querySelectorAll<HTMLElement>(
        `ytd-engagement-panel-section-list-renderer[${YT.transcriptVisibilityAttr}="${YT.transcriptExpandedValue}"]`,
      ),
    );

    if (openPanels.length > 0) {
      // A close, so nothing is in flight. Dropping the reservation here as well as
      // in the dock-change hook matters for the panel the site closes without ever
      // changing the attribute we watch.
      clearTranscriptPending();
      for (const openPanel of openPanels) {
        const closeBtn = openPanel.querySelector<HTMLButtonElement | HTMLElement>(
          'yt-icon-button#visibility-button button, #visibility-button button, button[aria-label*="Close" i], #close-button button, #visibility-button, ytd-engagement-panel-title-header-renderer button',
        );
        if (closeBtn) {
          closeBtn.click();
        }
        openPanel.setAttribute(YT.transcriptVisibilityAttr, "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      }
      return;
    }

    // Before the site is asked, never after. Most of the candidates below also trip
    // the capture-phase listener that reserves the column, but three of them —
    // the macro-markers entry point, "Key moments" and "In this video" — do not, and
    // a reader on one of those videos would otherwise get the staged open back.
    markTranscriptPending();

    const candidates = [
      'ytd-video-description-transcript-section-renderer button',
      'button[aria-label*="Show transcript" i]',
      'button[aria-label*="Transcript" i]',
      '#structured-description ytd-video-description-transcript-section-renderer button',
      'ytd-macro-markers-entry-point-renderer button',
      'button[aria-label*="Key moments" i]',
      'button[aria-label*="Chapters" i]',
      'button[aria-label*="In this video" i]',
      '.ytp-chapter-title',
      '.ytp-chapter-container',
    ];

    let clicked = false;
    for (const selector of candidates) {
      const btn = doc.querySelector<HTMLButtonElement | HTMLElement>(selector);
      if (btn) {
        btn.click();
        clicked = true;
        break;
      }
    }

    // No second ask here. The capture-phase listener above owns it, for every route
    // into the transcript rather than only this one, and it guards its own re-entry.

    if (!clicked) {
      const expandDescriptionBtn = doc.querySelector<HTMLButtonElement | HTMLElement>(
        '#description #expand, ytd-watch-metadata #description, tp-yt-paper-button#expand, ytd-text-inline-expander #expand, ytd-expandable-metadata-renderer',
      );
      expandDescriptionBtn?.click();

      // One frame's worth of grace for the expander to mount the transcript button
      // it hides. Not a poll: if the button is still not there, the panel's own
      // attribute is set directly, which is the last resort and always terminates.
      timers().setTimeout(() => {
        const transcriptBtn = doc.querySelector<HTMLButtonElement | HTMLElement>(
          'ytd-video-description-transcript-section-renderer button, button[aria-label*="Show transcript" i], button[aria-label*="Transcript" i]',
        );
        if (transcriptBtn) {
          transcriptBtn.click();
        } else {
          const panel = doc.querySelector<HTMLElement>(YT.transcriptPanel);
          if (panel) {
            panel.setAttribute(YT.transcriptVisibilityAttr, YT.transcriptExpandedValue);
          }
        }
      }, TRANSCRIPT_DESCRIPTION_EXPAND_DELAY_MS);
    }

    const switchTab = () => {
      const panel = findExpandedTranscriptPanel();
      if (panel) {
        const allTabs = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'tp-yt-paper-tab, [role="tab"], yt-tab-shape, button[role="tab"]',
          ),
        );
        const transcriptTab =
          allTabs.find((tab) =>
            /transcript/i.test(
              tab.textContent ??
                tab.getAttribute("aria-label") ??
                tab.getAttribute("tab-title") ??
                "",
            ),
          ) ?? allTabs[1];

        if (transcriptTab && transcriptTab.getAttribute("aria-selected") !== "true") {
          transcriptTab.click();
        }
      }
      updateTranscriptCopyButton();
    };

    for (const delay of TRANSCRIPT_TAB_DELAYS_MS) timers().setTimeout(switchTab, delay);
  };

  /** Tracked button elements for lock badge updates. */
  let captureButton: Element | null = null;
  let transcriptButton: Element | null = null;

  /** Class for the lock badge overlay on paid buttons. */
  const CAPTURE_LOCK_CLASS = "wfs-capture-lock";

  /** Add or remove the lock badge on paid buttons based on entitlement. */
  const updateProLockBadges = (): void => {
    const update = (btn: Element | null) => {
      if (!btn) return;
      const existing = btn.querySelector(`.${CAPTURE_LOCK_CLASS}`);
      if (isPro(pro)) {
        // Entitled: remove the badge if present.
        if (existing) existing.remove();
      } else {
        // Not entitled: add the badge if not already there.
        if (!existing) {
          const badge = doc.createElement("span");
          badge.className = CAPTURE_LOCK_CLASS;
          badge.textContent = "\uD83D\uDD12";
          badge.style.cssText = [
            "position:absolute",
            "bottom:4px",
            "right:4px",
            "font-size:9px",
            "line-height:1",
            "pointer-events:none",
          ].join(";");
          // The button needs relative positioning for the badge to anchor correctly.
          (btn as HTMLElement).style.position = "relative";
          btn.appendChild(badge);
        }
      }
    };
    update(captureButton);
    update(transcriptButton);
  };

  const injector = new ButtonInjector({
    adapter,
    document: doc,
    buttons: [
      {
        role: "capture",
        label: CAPTURE_BUTTON_LABEL,
        buildIcon: buildCaptureIcon,
        onActivate: captureFrame,
        isAvailable: () => typeof adapter.findVideo === "function",
      },
      {
        role: "copylink",
        label: COPY_LINK_BUTTON_LABEL,
        buildIcon: buildCopyLinkIcon,
        onActivate: copyLink,
        isAvailable: () => typeof adapter.findVideo === "function",
      },
      {
        role: "transcript",
        label: TRANSCRIPT_BUTTON_LABEL,
        buildIcon: buildTranscriptIcon,
        onActivate: toggleTranscript,
        isAvailable: () => typeof adapter.findVideo === "function",
      },
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
      if (role === "capture") {
        captureButton = button;
        updateProLockBadges();
        return;
      }
      if (role === "transcript") {
        transcriptButton = button;
        updateProLockBadges();
        return;
      }
      if (role === "mode") {
        controller.setButton(button);
        maybeAutoApply();
        return;
      }
    },
    isModeActive: () => controller.isActive,
  });
  injector.start();

  /**
   * Follow the entitlement record.
   *
   * Mounting and unmounting the grips from here is what makes a key entered in the
   * popup take effect on a page that is already open, and — more importantly —
   * makes a *revoked* key take the grips away without a reload. Auto-apply is
   * re-run because a per-channel rule may have just become active.
   */
  const applyProState = (next: ProState): void => {
    pro = next;
    if (isPro(pro)) mountGrips();
    else unmountGrips();
    updateProLockBadges();
    updateLetterboxAndGlow();
    // A newly accepted key gets its own window to find the channel:
    // until this moment `channelRuleUndecided` answered "no rule to wait for", so
    // no attempts have been spent and there may be nothing scheduled to spend them.
    resetChannelRuleWatch();
    maybeAutoApply();
  };

  const disposeProWatch = watchProState(applyProState);

  void getProState().then(({ state }) => {
    // A failed read yields the un-entitled default, which is the safe direction:
    // §14 rule 2 protects an entitlement already granted, and this is the read that
    // would have granted it. Nothing is written back, so a transient failure costs
    // the grips until the next read rather than the licence.
    applyProState(state);
  });

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
    activeChannelMode = null;
    adoptStoredWidths(prefs);
    updateLetterboxAndGlow();
    // A new video is a new question, so the channel window starts again rather
    // than inheriting the attempts the previous one spent.
    resetChannelRuleWatch();
    maybeAutoApply();
  });

  /**
   * A dock of the site's own opening or closing beside the player — live chat on
   * YouTube. The mode answers those in CSS with no JS at all, which is the whole
   * appeal and also why the site is never told to re-measure: see
   * `onSiteDockChange` (§1) for the stale scrubber that left behind.
   *
   * Nothing is decided here. The adapter says the player's width moved, the
   * controller runs the same re-measure it runs for its own panel, and it ignores
   * the call when the mode is off — so this stays one line and neither side learns
   * anything about the other.
   */
  const disposeSiteDockChange = adapter.onSiteDockChange?.(doc, () => {
    controller.refreshGeometry();
    updateTranscriptCopyButton();
    // The panel is open, so the column a press reserved is now occupied and the
    // reservation has done its job. This is the normal way it ends; the bound in
    // `markTranscriptPending` only covers a press that never produces a panel at all.
    //
    // Conditional on a panel actually being expanded, NOT on this hook simply firing.
    // The hook is shared with live chat, so an unconditional release meant toggling
    // chat during the frames after a transcript press cancelled that press's
    // reservation and handed it back the staged open.
    //
    // Safe to run here because this is a microtask after the attribute mutation: the
    // expanded panel already carries its own fixed box, so #panels giving its box up
    // moves nothing on screen.
    if (findExpandedTranscriptPanel()) clearTranscriptPending();
    //
    // There used to be four `scrollTo(0, 0)` calls here — immediate, next frame,
    // +60 ms and +200 ms — fighting the scroll the site performed when it mounted the
    // transcript panel in flow. They are gone, and they are what the reader was
    // seeing as "it scrolls the video first": on a page scrolled down in `scrollable`
    // mode the volley yanked the view to the top a fifth of a second after the press.
    // Reserving the column up front means the panel never enters flow, so there is
    // no scroll to undo. Do not add them back without first checking whether
    // `TRANSCRIPT_PENDING_CLASS` stopped working.
  });

  void getSitePrefs(adapter.siteId).then(({ prefs: stored }) => {
    prefs = stored;
    autoApplyEnabled = stored.autoApply;
    adoptStoredWidths(stored);
    updateLetterboxAndGlow();
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
        case "TOGGLE_PANEL":
          togglePanel();
          return { ok: true, active: controller.isActive };
        case "CAPTURE":
          // The entitlement check is inside `captureFrame`, not here and not in the
          // worker: the worker relays a command whatever the tier, because the
          // browser lists the shortcut at its own shortcuts page whatever the tier,
          // and a press that does nothing at all reads as a broken key.
          captureFrame();
          return { ok: true, active: controller.isActive };
        case "COPY_LINK": {
          const video = adapter.findVideo?.(doc) ?? null;
          void copyLinkAtCurrentTime(doc, video).then((copied) => {
            if (copied) {
              const timeStr =
                video && Number.isFinite(video.currentTime) && video.currentTime > 0
                  ? formatPlaybackTimestamp(video.currentTime)
                  : null;
              say(timeStr ? `Link copied at ${timeStr}` : "Link copied to clipboard.");
            } else {
              say("Could not copy link.");
            }
          });
          return { ok: true, active: controller.isActive };
        }
        case "COPY_TRANSCRIPT":
          if (!isPro(pro)) {
            offerPro("other");
            return { ok: false, error: "pro_required" };
          }
          void copyTranscriptWithTimestamps(doc, say);
          return { ok: true, active: controller.isActive };
        case "GET_STATUS":
          // The channel rides along so the popup can offer "always on this channel"
          // without a second round trip. Null on a page that has not rendered the
          // owner row yet, which the popup treats as "nothing to offer" rather than
          // as an error.
          return {
            ok: true,
            active: controller.isActive,
            channel: adapter.readChannel?.(doc) ?? null,
          };
        default:
          return null;
      }
    },
    stop() {
      doc.removeEventListener("pointermove", onPointerActivity);
      clearCursorTimer();
      showCursor();
      glowSampler.dispose();
      removeLetterboxCss(doc);
      clearTranscriptPending();
      disposePrefWatch();
      disposeProWatch();
      disposeVideoChange();
      disposeSiteDockChange?.();
      // Ours, positioned against the viewport, and belonging to a page this session
      // is handing back. Anything left here is the same class of leak as a pending
      // reflow nudge: invisible until an unrelated page grows an element nobody can
      // explain.
      unmountGrips();
      doc.defaultView?.removeEventListener("resize", onViewportResize);
      removeDockWidthCss(doc);
      dismissToast?.();
      dismissToast = null;
      dismissProPrompt?.();
      dismissProPrompt = null;
      doc.removeEventListener("fullscreenchange", onFullscreenChange);
      doc.removeEventListener("click", onPointerCapture, true);
      doc.removeEventListener("dblclick", onPointerCapture, true);
      doc.removeEventListener("keydown", onKeyCapture as EventListener, true);
      clearGrace();
      clearResume();
      clearChannelRuleWatch();
      resumeAfterFullscreen = false;
      resumePanelAfterFullscreen = false;
      // A navigation is not an exit we asked for; leave nothing a later
      // fullscreenchange could read.
      exitIntent = null;
      injector.stop();
      panelCloseButton.remove();
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

/**
 * The manifest commands, and the message each one relays to the page.
 *
 * A table rather than three `if` branches, because the worker's job for all three
 * is identical — find the tab, check it is a site we support, forward one message,
 * badge the failure — and the only thing that differs is which message. Adding a
 * command is one entry.
 *
 * Every command is relayed whatever the reader's tier, including the capture one.
 * Chrome reads commands from the manifest, so the capture shortcut is listed at
 * `chrome://extensions/shortcuts` for a free reader and cannot be hidden from
 * them; a worker that declined to relay it would produce a key that does nothing,
 * which reads as broken rather than as paid. The page decides, and shows the Pro
 * prompt.
 */
const COMMANDS: Readonly<Record<string, ExtMessage>> = {
  "toggle-windowed-fullscreen": { type: "TOGGLE" },
  "toggle-comment-panel": { type: "TOGGLE_PANEL" },
  "capture-frame": { type: "CAPTURE" },
};

/**
 * The one command the help copy prints a key cap for.
 *
 * Named separately from the table above because the settings surface asks the
 * browser about this one specifically, and there is no version of "the shortcut"
 * that means all three: the panel and capture bindings appear at the browser's own
 * shortcuts page, which is where the help section already sends the reader.
 */
export const TOGGLE_COMMAND_NAME = "toggle-windowed-fullscreen";

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
  const message = COMMANDS[command];
  if (!message) return;

  const tab = await queryActiveTab();
  if (!tab?.id || !tab.url) return;
  if (!resolveAdapter(tab.url)) return;

  try {
    const response = await sendToTab(tab.id, message);
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

/**
 * Revalidate the stored licence if it is due.
 *
 * Runs on worker start rather than on a timer: an MV3 worker is terminated
 * whenever the browser feels like it, so there is nothing durable to schedule
 * against, and the worker starts often enough — every command, every popup, every
 * install event — that a 14-day interval is met comfortably. {@link proCheckDue}
 * carries the retry bound, so a stretch of worker starts with no network costs one
 * request every six hours rather than one per start.
 *
 * Fails open, entirely inside {@link applyValidation}: an unreachable endpoint
 * moves the attempt time and nothing else, so an entitled reader stays entitled.
 */
async function revalidateProIfDue(now: number): Promise<void> {
  const { state, loadFailed } = await getProState();
  // An unreadable record must not be written back over: the default is
  // un-entitled, and storing it would turn a transient storage failure into a
  // revoked licence.
  if (loadFailed) return;
  if (!proCheckDue(state, now)) return;

  // The activation id goes with it, so the provider is answering about this device
  // rather than about the key in the abstract — which is what makes a deactivation
  // performed on another machine take effect here.
  const result = await validateLicenceKey(state.key, state.instanceId);
  if (result.outcome !== "active") {
    warn(DIAGNOSTIC.proValidationFailed, "The licence check did not confirm the key.", {
      outcome: result.outcome,
      reason: result.reason,
    });
  }
  await setProState(applyValidation(state, result, now));
}

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

  // There is deliberately no `onMessage` listener. Nothing sends this worker a
  // message; see the note in §1 where the request type used to be.

  // Deliberately not awaited and deliberately not gated on anything: the check
  // decides for itself whether it is due, and a worker start is the only clock an
  // event-driven worker has.
  void revalidateProIfDue(Date.now());
}

// ===========================================================================
// §11  Settings UI (the popup's preferences tree)
// ===========================================================================

/** Where the browser lets the user rebind the keyboard shortcut. */
const SHORTCUTS_URL = "chrome://extensions/shortcuts";

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
 * Where a reader buys Pro: the payment provider's checkout, directly.
 *
 * An earlier revision pointed this at a page on the product site that handed off
 * to the provider, on the reasoning that a URL baked into a shipped extension
 * outlives a provider change by however long it takes every install to update,
 * whereas a page we own can be repointed the same afternoon. That reasoning is
 * still true and is the cost accepted here: **changing provider, product, or price
 * link now needs a release.** It was traded away because the button exists to sell
 * a $10 impulse purchase, and a landing page in front of the checkout is a step
 * where readers leave. The indirection can be reinstated the moment there is a
 * page worth the hop — it is one string.
 *
 * Paired with {@link DODO_API_BASE} and it must be flipped in the same commit: a
 * test checkout link takes real money nowhere, and a live checkout link paired
 * with a test API host sells a key the extension will refuse. Both spellings of
 * that mistake are caught by the guard in `scripts/package.mjs` and by the host
 * assertion in `tests/entitlement.test.ts`, because neither is visible on the
 * developer's own machine.
 */
export const PRO_PURCHASE_URL =
  "https://test.checkout.dodopayments.com/buy/pdt_0Nf1XWPRqpjTH4YVdZiMN?quantity=1&redirect_url=https%3A%2F%2Frohittiger.vercel.app%2Fproduct%2Fwindowedfullscreen%2Fsuccess";

/**
 * Product pricing and feature showcase page on the website.
 */
export const PRO_LEARN_MORE_URL =
  "https://rohittiger.vercel.app/product/windowedfullscreen#pricing";

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
 * One constant rather than strings sitting in the HTML shells. It was written that
 * way when there were two settings surfaces and they drifted apart the moment each
 * owned a copy of the words; with one surface left the rule still holds, because the
 * popup, the in-page Pro prompt and the welcome page all print from here. The shells
 * provide empty containers only; §11 fills them.
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
   * The settings page's two panels.
   *
   * Two, and there is no appetite for a third. The split is not a filing system for
   * a growing pile of settings — it exists because one of these panels is a sales
   * pitch and the other is a preference list, and a reader arrives wanting exactly
   * one of them. Everything that is a setting goes in the first panel however long
   * that list gets.
   */
  tabs: {
    settings: "Settings",
    pro: "Get Pro",
    proEntitled: "Pro",
  },

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
   * this greeting has gone back to the popup, where someone who wants to change a
   * setting will go looking for it. A first run is not the moment to present
   * preferences for a feature the reader has not seen work yet.
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
    prompt: "Enjoying it? Rate it, or share a suggestion.",
    /** Opens the store's review page. Same destination as the star row. */
    promptRate: "Rate it",
    /** Opens the support page. Offered to everyone, never as a consolation. */
    promptFeedback: "Any suggestions?",
    /** Closes the prompt. It is already resolved by the time this is pressed. */
    promptDismiss: "Cancel",
    /** The support page, always visible — never gated behind a low score. */
    feedbackLink: "Feedback",
    privacyLink: "Privacy",
  },

  /**
   * The paid tier. Three surfaces share these words: the prompt that opens in the
   * page when a free reader presses a Pro control, the settings section where a
   * key is entered, and the capture control's own messages.
   *
   * Written to name what the reader gets, never what they are missing. "Resize the
   * columns" is a feature; "you cannot resize the columns" is a complaint about
   * the reader's wallet, and every draft that read that way got deleted.
   *
   * The price is stated here rather than fetched, because a paywall that will not
   * say the price until you click it is the thing everybody hates about paywalls.
   * It also means changing the price is a release, which is the correct amount of
   * friction for changing a price.
   */
  pro: {
    /** The name, used as a heading in the settings and in the prompt when not entitled. */
    name: "Get Pro",
    /** The badge indicator. */
    price: "Pro",

    /** The prompt's heading when the capture control is what was pressed. */
    captureTitle: "Saving screenshots is part of Pro",
    /** The prompt's heading for any other paid control. */
    genericTitle: "Supercharge with Pro Features",
    /**
     * The body, and the only place the tier is described. Kept to what is bought
     * rather than a feature matrix: the reader is standing in front of a video
     * they were watching, not shopping.
     */
    body: "Unlock all tools with a one-time lifetime license. No recurring fees.",
    /** The primary action. Names the price so the button holds no surprise. */
    buy: "Unlock Pro — $10 Lifetime",
    /** Secondary link to compare features on the website. */
    learnMore: "Compare all features on website",
    /** Trust line for purchase confidence. */
    trustLine: "7-day money-back guarantee · Instant delivery",
    /** Closes the prompt and changes nothing. */
    dismiss: "Not now",

    /** The settings section's heading. */
    sectionTitle: "Pro",

    /**
     * The paywall panel, which is the one surface with room to say what is being
     * sold. The in-page prompt gets `body` above — one sentence, because the reader
     * is standing in front of a video. This is the other case: they opened the
     * settings and clicked through to a tab called Pro, so they are shopping, and
     * the honest thing is to lay the nine items out and name the price.
     */
    pitchLead: "Get the best viewing tools. Take screenshots, resize panels, and add ambient glow.",
    features: [
      {
        name: "Instant screenshots",
        detail: "Save high-quality video frames straight to downloads or clipboard.",
      },
      {
        name: "Resizable panels",
        detail: "Drag comments, live chat, and transcripts to your ideal width.",
      },
      {
        name: "Favorite channels",
        detail: "Automatically open windowed mode on the channels you watch most.",
      },
      {
        name: "Channel memory",
        detail: "Remember your favorite viewing mode and panel widths for each channel.",
      },
      {
        name: "Transcript panel",
        detail: "Keep the searchable transcript docked right beside your video.",
      },
      {
        name: "Ambient lighting",
        detail: "Softly illuminates letterbox bars with colors matching your video.",
      },
      {
        name: "Custom bar colors",
        detail: "Pick your favorite background colors and theme gradients.",
      },
      {
        name: "Custom file names",
        detail: "Choose how your saved video screenshot files are named.",
      },
      {
        name: "Timestamp on frame",
        detail: "Stamp the exact video playback time onto your screenshots.",
      },
    ],
    /** Heads the same list once the reader owns it. */
    haveHeading: "What you unlocked",

    /**
     * The activation disclosure's label, and the line inside it.
     *
     * Collapsed, because entering a key is a once-per-device job and a text field
     * sitting open under a price is a reader being asked to buy and to prove they
     * already bought in the same breath. Someone with a key is looking for this row
     * and finds it; someone without one is not made to scroll past it.
     */
    haveKeyHeading: "Already bought Pro?",
    activateOnce: "Find your license key in your purchase confirmation email.",
    /** The same disclosure on the other side of the purchase. */
    removeHeading: "Moving to another computer?",

    /** Above the key field. */
    keyLabel: "License key",
    keyPlaceholder: "Paste your license key",
    activate: "Activate Pro",
    remove: "Remove key from this computer",
    /** Shown while a check is in flight, so the button is never silently busy. */
    checking: "Checking your key…",
    /** The three settled outcomes. */
    active: "Pro is active on this computer.",
    inactive: "Pro is not active on this computer.",
    /**
     * A refusal the reader fixes by re-reading what they pasted.
     *
     * An earlier revision named both possible causes in one sentence — "check it,
     * or it may already be in use on too many devices" — on the reasoning that only
     * the provider's own error prose tells them apart, and branching on a third
     * party's wording is how a copy edit becomes a silent unlock. The reasoning was
     * sound about the wording and wrong about the status code: 404 and 403 are
     * numbers, not prose, and they separate two problems a reader acts on
     * differently. One sentence covering both left everyone re-pasting a key that
     * was never going to be accepted, burning another activation each time.
     */
    invalid: "That key was not accepted. Please check that you pasted it correctly.",
    /**
     * The activation limit, which is not a problem with the key. Says what to do,
     * because the reader can fix this one themselves and would otherwise ask for a
     * refund of something they already own.
     */
    limit:
      "This key is already used on the maximum number of computers. Remove it on one first.",
    /**
     * A key the provider has switched off — refunded, charged back, or revoked by
     * hand. Named separately because "check what you pasted" sends someone to look
     * for a typo that is not there, and because this is the one refusal where the
     * honest next step is to get in touch rather than to try again.
     */
    revoked: "This key is no longer active. If you think this is a mistake, please contact support.",
    /**
     * The fail-open case, said plainly. The reader keeps every feature, so this is
     * information rather than a warning, and it must not read as one.
     */
    unreachable: "Could not connect to check your key. Everything stays active and will try again later.",
    malformed: "Please enter a valid license key.",
    /** Removed here, and the device freed up at the provider too. */
    removed: "The key was removed, and this device freed up for another.",
    /**
     * Removed here, but the provider could not be told. Said rather than hidden:
     * the reader is about to try the key elsewhere and needs to know it may still
     * count against them.
     */
    removedLocally: "The key was removed here, but this device may still count. Try again online.",
    /** What the check sends, stated where the key is entered. */
    privacyNote: "Your key is only checked to unlock Pro. No personal data or browsing is tracked.",

    /**
     * The teaser row's one line about Pro, and the way through to it.
     *
     * The preferences tree says one sentence rather than carrying the pitch, so a
     * reader reaching for a checkbox never scrolls past a price. The door leads to
     * the popup's Pro view, which gets the whole width for the feature list and the
     * key field — a swap rather than a new tab, so nobody loses their place.
     */
    summaryPitch: "Get Pro · Activate license key",
    summaryOpen: "See what's in Pro",
    /** Same door, for a reader who already owns it and may want to move the key. */
    summaryManage: "Manage your key",

    /** Capture's own outcomes. */
    captureSaved: "Frame saved.",
    captureCopied: "Frame copied.",
    /** Protected playback, or a genuinely black frame. Both look the same to us. */
    captureBlank: "That frame came back blank. Protected videos cannot be saved.",
    captureFailed: "Could not save that frame.",
    /** No video to capture from yet. */
    captureNoVideo: "No video to save a frame from yet.",
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
    const raw = commands.find((command) => command.name === TOGGLE_COMMAND_NAME)?.shortcut ?? "";
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
 * visibility in step by hand. Nothing about the open state is stored, so the popup
 * opens collapsed every time (R14.6) — a line at rest, in a surface whose height is
 * a budget.
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
 *     Enjoying it? Rate it, or share a suggestion.
 *     [ Rate it ]  [ Any suggestions? ]  [ Cancel ]
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
  // Any suggestions? Not a consolation prize for a low opinion — it is offered
  // on equal footing, to everyone, on the same showing.
  addLink(SUPPORT_URL, HELP_COPY.rating.promptFeedback, "data-wfs-prompt-feedback");

  // Cancel. The third real answer, not a way of postponing: it records like the
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
 * Rendered in the popup and nowhere else. No notification API (R9.10).
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
 * The preference fields that are a single boolean, which is what a checkbox can
 * represent.
 *
 * Derived from {@link SitePrefs} rather than restated, so a field added there is
 * either automatically eligible for {@link SITE_TOGGLES} or a compile error if
 * someone lists a width or a rule list as a checkbox.
 */
type BooleanPrefField = {
  [K in keyof SitePrefs]: SitePrefs[K] extends boolean ? K : never;
}[keyof SitePrefs];

type ToggleCategory = "playback" | "appearance" | "capture";

const SITE_TOGGLES: ReadonlyArray<{
  field: BooleanPrefField;
  category: ToggleCategory;
  /** Marker attribute, so the control is findable without relying on order. */
  marker: string;
  /** Visible text beside the checkbox. */
  text: (siteLabel: string) => string;
  /** Accessible name override */
  aria?: (siteLabel: string) => string;
  /** Optional explanation rendered beneath. */
  hint?: string;
  /** When true, a lock icon is shown beside the label to indicate a Pro feature. */
  proGated?: boolean;
}> = [
  {
    field: "autoApply",
    category: "playback",
    marker: "data-wfs-autoapply",
    text: (siteLabel) => `Automatically enter windowed fullscreen on ${siteLabel}`,
  },
  {
    field: "scrollable",
    category: "playback",
    marker: "data-wfs-scrollable",
    text: () => "Scrollable mode",
    aria: (siteLabel) => `Scrollable mode — windowed fullscreen on ${siteLabel}`,
  },
  {
    field: "cursorAutoHide",
    category: "playback",
    marker: "data-wfs-cursor-autohide",
    text: () => "Hide mouse cursor when idle",
    aria: (siteLabel) => `Hide mouse cursor when idle — on ${siteLabel}`,
  },
  {
    field: "ambientGlow",
    category: "appearance",
    marker: "data-wfs-ambient-glow",
    text: () => "Ambient Glow",
    aria: (siteLabel) => `Ambient Glow — on ${siteLabel}`,
    proGated: true,
  },
  {
    field: "captureToClipboard",
    category: "capture",
    marker: "data-wfs-capture-clipboard",
    text: () => "Copy saved frames instead of downloading them",
    aria: (siteLabel) => `Copy saved frames instead of downloading them — on ${siteLabel}`,
    proGated: true,
  },
  {
    field: "captureBurnTimestamp",
    category: "capture",
    marker: "data-wfs-capture-burn-timestamp",
    text: () => "Burn timestamp into saved frames",
    aria: (siteLabel) => `Burn timestamp into saved frames — on ${siteLabel}`,
    proGated: true,
  },
];

/** Curated solid color presets for custom letterbox styling matching theme. */
const LETTERBOX_SWATCHES = [
  { name: "Pink", value: "#ff6b9d", color: "#ff6b9d" },
  { name: "Purple", value: "#9b5de5", color: "#9b5de5" },
  { name: "Peach", value: "#ff9f68", color: "#ff9f68" },
  { name: "Cyan", value: "#00d2d3", color: "#00d2d3" },
  { name: "Pure Black", value: "#000000", color: "#000000" },
] as const;

/** Curated gradient / mix themes for ambient letterbox styling. */
const LETTERBOX_THEMES = [
  { name: "LAAGGUE", value: "linear-gradient(135deg, #38006b 0%, #1a0033 100%)" },
  { name: "GRASLET", value: "linear-gradient(135deg, #005f73 0%, #0a9396 100%)" },
  { name: "TWILIGHT", value: "linear-gradient(135deg, #4361ee 0%, #3a0ca3 100%)" },
  { name: "EMBER", value: "linear-gradient(135deg, #d00000 0%, #ff9e00 100%)" },
  { name: "CYBER", value: "linear-gradient(135deg, #f72585 0%, #7209b7 100%)" },
  { name: "ABYSS", value: "linear-gradient(135deg, #0a192f 0%, #020c1b 100%)" },
] as const;

/**
 * The Pro teaser row: one sentence, and the door to the pitch.
 *
 * The preferences tree gets a teaser rather than the pitch itself, so a reader
 * reaching for a checkbox never scrolls past a price. `openProPanel` swaps the popup
 * over to {@link renderProView}, which owns the whole 320 px and carries the feature
 * list, the checkout link and the licence field.
 *
 * A view swap rather than a new tab, and that is a correction rather than a
 * preference. Up to 2.0.0 this row opened the options page on its Pro panel, on the
 * reasoning that 320 px over a half-watched video is the worst surface in the
 * extension both for reading a feature list and for pasting a 36-character key. The
 * reasoning was right about the width and wrong about the fix: closing the reader's
 * popup and opening a settings tab to answer "what is Pro?" costs more than a
 * cramped column does. So the pitch moved into the popup, the options page went, and
 * the width problem is solved by giving the pitch the whole popup instead of a
 * section of it.
 *
 * Subscribes to entitlement and repaints whole, so it owns its host — the same rule
 * that gave the rating prompt a host of its own: any node a storage subscriber
 * repaints wholesale belongs to that subscriber alone.
 *
 * @returns a disposer for the subscription. Worth calling: the popup is closed
 *   mid-flight constantly, and a listener on a dead document is a leak whether or
 *   not anything notices.
 */
export function renderProSummary(
  doc: Document,
  host: Element,
  ctx: { openProPanel: () => void },
): () => void {
  const copy = HELP_COPY.pro;
  let entitled = false;

  const paint = (): void => {
    host.replaceChildren();

    // --- Teaser card: a clickable row that opens the Pro view ---------------
    const card = doc.createElement("button");
    card.type = "button";
    card.setAttribute("data-wfs-pro-teaser", "");
    if (entitled) card.classList.add("is-active");

    const badge = doc.createElement("span");
    badge.setAttribute("data-wfs-pro-teaser-badge", "");
    badge.textContent = entitled ? "\u2728" : "\u26A1";
    card.appendChild(badge);

    const text = doc.createElement("span");
    text.setAttribute("data-wfs-pro-teaser-text", "");
    text.textContent = entitled ? copy.active : copy.summaryPitch;
    card.appendChild(text);

    const arrow = doc.createElement("span");
    arrow.setAttribute("data-wfs-pro-teaser-arrow", "");
    arrow.textContent = "\u203A";
    card.appendChild(arrow);

    card.addEventListener("click", () => ctx.openProPanel());
    host.appendChild(card);
  };

  paint();

  void getProState().then(({ state }) => {
    entitled = isPro(state);
    paint();
  });

  return watchProState((state) => {
    entitled = isPro(state);
    paint();
  });
}

/**
 * The full Pro showcase view rendered inside the popup when the reader presses the
 * Pro teaser card. It replaces the popup's main content and provides a Back button
 * to return. Contains the feature grid, Buy CTA, and inline key activation.
 *
 * Called from the popup's navigation handler, not from `renderSettings`. The popup
 * owns the transition between its two views; this function owns the Pro view's
 * content.
 *
 * @returns a disposer for the entitlement subscription.
 */
export function renderProView(
  doc: Document,
  host: Element,
  ctx: { onBack: () => void },
): () => void {
  const copy = HELP_COPY.pro;

  let current: ProState = { ...DEFAULT_PRO_STATE };
  let checking = false;

  const paint = (): void => {
    host.replaceChildren();
    const entitled = isPro(current);

    // --- Back button -------------------------------------------------------
    const backBtn = doc.createElement("button");
    backBtn.type = "button";
    backBtn.setAttribute("data-wfs-pro-back-nav", "");
    backBtn.textContent = "\u2039 Back";
    backBtn.addEventListener("click", () => ctx.onBack());
    host.appendChild(backBtn);

    // --- The Pro card with gradient stripe ---------------------------------
    const card = doc.createElement("div");
    card.setAttribute("data-wfs-pro-card", "");
    if (entitled) card.classList.add("is-active");

    // Header
    const header = doc.createElement("div");
    header.setAttribute("data-wfs-pro-header", "");

    const headerBadge = doc.createElement("span");
    headerBadge.setAttribute("data-wfs-pro-badge", "");
    headerBadge.textContent = entitled ? "\u2728" : "\u26A1";
    header.appendChild(headerBadge);

    const title = doc.createElement("span");
    title.setAttribute("data-wfs-pro-title", "");
    title.textContent = entitled ? copy.active : copy.name;
    header.appendChild(title);

    if (!entitled) {
      const pricePill = doc.createElement("span");
      pricePill.setAttribute("data-wfs-pro-pill", "");
      pricePill.textContent = copy.price;
      header.appendChild(pricePill);
    }
    card.appendChild(header);

    // Pitch (not entitled)
    if (!entitled) {
      const pitch = doc.createElement("p");
      pitch.setAttribute("data-wfs-pro-pitch", "");
      pitch.textContent = copy.body;
      card.appendChild(pitch);

      // Features grid
      const grid = doc.createElement("div");
      grid.setAttribute("data-wfs-pro-features-grid", "");

      const featureItems: Array<{ icon: string; name: string; detail: string }> = [
        { icon: "\uD83D\uDCF8", name: "Instant Screenshots", detail: "Save clean frames & timestamps" },
        { icon: "\u2194\uFE0F", name: "Resizable Panels", detail: "Custom widths for comments & chat" },
        { icon: "\uD83D\uDCA1", name: "Ambient Glow", detail: "Soft light synced to video colors" },
        { icon: "\uD83D\uDCDD", name: "Transcript Dock", detail: "Pinned searchable transcript" },
        { icon: "\u2B50", name: "Channel Memory", detail: "Auto-apply preferred layout" },
        { icon: "\uD83C\uDFA8", name: "Custom Themes", detail: "Custom bar colors & gradients" },
      ];

      for (const item of featureItems) {
        const fCard = doc.createElement("div");
        fCard.setAttribute("data-wfs-pro-feature-card", "");

        const iconSpan = doc.createElement("span");
        iconSpan.setAttribute("data-wfs-pro-feature-icon", "");
        iconSpan.textContent = item.icon;

        const textWrap = doc.createElement("div");
        textWrap.setAttribute("data-wfs-pro-feature-text", "");

        const nameSpan = doc.createElement("span");
        nameSpan.setAttribute("data-wfs-pro-feature-name", "");
        nameSpan.textContent = item.name;

        const detailSpan = doc.createElement("span");
        detailSpan.setAttribute("data-wfs-pro-feature-detail", "");
        detailSpan.textContent = item.detail;

        textWrap.appendChild(nameSpan);
        textWrap.appendChild(detailSpan);

        fCard.appendChild(iconSpan);
        fCard.appendChild(textWrap);
        grid.appendChild(fCard);
      }
      card.appendChild(grid);

      // Trust line
      const trust = doc.createElement("div");
      trust.setAttribute("data-wfs-pro-trust", "");
      const trustItems = ["\uD83D\uDEE1\uFE0F 7-Day Guarantee", "\u26A1 Instant Delivery", "\uD83D\uDD12 Secure Checkout"];
      trustItems.forEach((text, idx) => {
        if (idx > 0) {
          const dot = doc.createElement("span");
          dot.textContent = "\u2022";
          dot.style.opacity = "0.5";
          trust.appendChild(dot);
        }
        const itemSpan = doc.createElement("span");
        itemSpan.textContent = text;
        trust.appendChild(itemSpan);
      });
      card.appendChild(trust);
    }

    if (entitled) {
      // Entitled: manage/remove directly inside the popup!
      const haveHeading = doc.createElement("h3");
      haveHeading.setAttribute("data-wfs-pro-have", "");
      haveHeading.textContent = copy.haveHeading;
      card.appendChild(haveHeading);

      const note = doc.createElement("p");
      note.setAttribute("data-wfs-pro-pitch", "");
      note.textContent = "All Pro features are active and unlocked on this device.";
      card.appendChild(note);

      // Key details card
      const keyBox = doc.createElement("div");
      keyBox.setAttribute("data-wfs-pro-key-box", "");
      keyBox.style.display = "flex";
      keyBox.style.flexDirection = "column";
      keyBox.style.gap = "6px";
      keyBox.style.marginTop = "8px";
      keyBox.style.padding = "8px 10px";
      keyBox.style.background = "var(--wfs-bg)";
      keyBox.style.borderRadius = "8px";
      keyBox.style.border = "1px solid var(--wfs-border)";

      const keyLabel = doc.createElement("span");
      keyLabel.style.fontSize = "11px";
      keyLabel.style.fontWeight = "600";
      keyLabel.style.color = "var(--wfs-muted)";
      keyLabel.textContent = "Active License Key";
      keyBox.appendChild(keyLabel);

      const keyRow = doc.createElement("div");
      keyRow.style.display = "flex";
      keyRow.style.alignItems = "center";
      keyRow.style.gap = "8px";
      keyRow.style.justifyContent = "space-between";

      const keyCode = doc.createElement("code");
      keyCode.style.fontFamily = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      keyCode.style.fontSize = "11.5px";
      keyCode.style.color = "var(--wfs-text)";
      keyCode.style.overflow = "hidden";
      keyCode.style.textOverflow = "ellipsis";
      keyCode.style.whiteSpace = "nowrap";
      keyCode.textContent = current.key || "Active";
      keyRow.appendChild(keyCode);

      const copyBtn = doc.createElement("button");
      copyBtn.type = "button";
      copyBtn.setAttribute("data-wfs-pro-copy-btn", "");
      copyBtn.style.padding = "3px 8px";
      copyBtn.style.fontSize = "10.5px";
      copyBtn.style.fontWeight = "600";
      copyBtn.style.background = "var(--wfs-surface)";
      copyBtn.style.color = "var(--wfs-text)";
      copyBtn.style.border = "1px solid var(--wfs-border)";
      copyBtn.style.borderRadius = "5px";
      copyBtn.style.cursor = "pointer";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => {
        if (current.key) {
          void navigator.clipboard.writeText(current.key);
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
        }
      });
      keyRow.appendChild(copyBtn);
      keyBox.appendChild(keyRow);
      card.appendChild(keyBox);

      // Remove key / Move to another computer
      const removeDetails = doc.createElement("details");
      removeDetails.setAttribute("data-wfs-pro-remove-details", "");
      removeDetails.style.marginTop = "10px";

      const removeSummary = doc.createElement("summary");
      removeSummary.style.fontSize = "11.5px";
      removeSummary.style.color = "var(--wfs-secondary)";
      removeSummary.style.cursor = "pointer";
      removeSummary.textContent = copy.removeHeading;
      removeDetails.appendChild(removeSummary);

      const removeActionWrap = doc.createElement("div");
      removeActionWrap.style.marginTop = "8px";
      removeActionWrap.style.display = "flex";
      removeActionWrap.style.flexDirection = "column";
      removeActionWrap.style.gap = "6px";

      const removeStatus = doc.createElement("p");
      removeStatus.style.fontSize = "11px";
      removeStatus.style.margin = "0";
      removeStatus.style.color = "var(--wfs-danger)";

      const removeBtn = doc.createElement("button");
      removeBtn.type = "button";
      removeBtn.setAttribute("data-wfs-pro-remove", "");
      removeBtn.style.padding = "6px 12px";
      removeBtn.style.fontSize = "11.5px";
      removeBtn.style.fontWeight = "600";
      removeBtn.style.color = "#ff5252";
      removeBtn.style.background = "rgba(255, 82, 82, 0.1)";
      removeBtn.style.border = "1px solid rgba(255, 82, 82, 0.25)";
      removeBtn.style.borderRadius = "6px";
      removeBtn.style.cursor = "pointer";
      removeBtn.textContent = copy.remove;

      removeBtn.addEventListener("click", () => {
        removeBtn.disabled = true;
        removeBtn.textContent = "Removing key…";
        void (async () => {
          try {
            await deactivateLicence(current.key, current.instanceId);
            const result = await setProState({ ...DEFAULT_PRO_STATE });
            if (!result.ok) {
              removeStatus.textContent = `Could not remove the key: ${result.error}.`;
              removeBtn.disabled = false;
              removeBtn.textContent = copy.remove;
              return;
            }
          } catch {
            removeStatus.textContent = "Error removing key. Please try again.";
            removeBtn.disabled = false;
            removeBtn.textContent = copy.remove;
          }
        })();
      });

      removeActionWrap.appendChild(removeBtn);
      removeActionWrap.appendChild(removeStatus);
      removeDetails.appendChild(removeActionWrap);
      card.appendChild(removeDetails);
    } else {
      // Not entitled: Buy CTA always visible
      const actions = doc.createElement("div");
      actions.setAttribute("data-wfs-pro-actions", "");

      const buy = doc.createElement("a");
      buy.href = PRO_PURCHASE_URL;
      buy.rel = "noopener noreferrer";
      buy.setAttribute("data-wfs-pro-buy-cta", "");
      buy.textContent = `\u26A1 ${copy.buy} \u2192`;
      buy.addEventListener("click", (event) => {
        event.preventDefault();
        void chrome.tabs.create({ url: PRO_PURCHASE_URL, active: true });
      });
      actions.appendChild(buy);

      const learnMore = doc.createElement("a");
      learnMore.href = PRO_LEARN_MORE_URL;
      learnMore.rel = "noopener noreferrer";
      learnMore.setAttribute("data-wfs-pro-learn-more", "");
      learnMore.textContent = `\uD83C\uDF10 ${copy.learnMore} \u2192`;
      learnMore.addEventListener("click", (event) => {
        event.preventDefault();
        void chrome.tabs.create({ url: PRO_LEARN_MORE_URL, active: true });
      });
      actions.appendChild(learnMore);

      card.appendChild(actions);

      // "Already have a key?" — always visible below the CTA, no toggle needed.
      const form = doc.createElement("div");
      form.setAttribute("data-wfs-pro-form", "");

      const formLabel = doc.createElement("p");
      formLabel.setAttribute("data-wfs-pro-form-label", "");
      formLabel.textContent = copy.haveKeyHeading;
      form.appendChild(formLabel);

      const formHint = doc.createElement("p");
      formHint.setAttribute("data-wfs-pro-form-hint", "");
      formHint.textContent = copy.activateOnce;
      form.appendChild(formHint);

      if (checking || current.status === "invalid" || current.status === "unreachable") {
        const status = doc.createElement("p");
        status.setAttribute("data-wfs-pro-inline-status", "");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = checking
          ? copy.checking
          : current.status === "invalid"
            ? copy.invalid
            : copy.unreachable;
        form.appendChild(status);
      }

      const input = doc.createElement("input");
      input.type = "text";
      input.setAttribute("data-wfs-pro-key", "");
      input.placeholder = copy.keyPlaceholder;
      input.maxLength = MAX_LICENCE_KEY_LENGTH;
      input.autocomplete = "off";
      input.spellcheck = false;
      form.appendChild(input);

      const activate = doc.createElement("button");
      activate.type = "button";
      activate.setAttribute("data-wfs-pro-activate-inline", "");
      activate.textContent = copy.activate;

      const submit = (): void => {
        if (checking) return;
        const key = normalizeLicenceKey(input.value);
        if (!licenceKeyLooksWellFormed(key)) {
          const existing = form.querySelector("[data-wfs-pro-inline-status]");
          if (existing) existing.textContent = copy.malformed;
          else {
            const s = doc.createElement("p");
            s.setAttribute("data-wfs-pro-inline-status", "");
            s.textContent = copy.malformed;
            form.insertBefore(s, formLabel.nextSibling);
          }
          return;
        }
        checking = true;
        paint();

        void (async () => {
          const now = Date.now();
          const { validation: result, instanceId } = await activateLicence(key);
          const next = applyValidation(
            { ...DEFAULT_PRO_STATE, key, instanceId },
            result,
            now,
          );
          checking = false;
          const written = await setProState(next);
          if (!written.ok) {
            current = { ...DEFAULT_PRO_STATE };
            paint();
          }
        })();
      };

      activate.addEventListener("click", submit);
      input.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") submit();
      });
      form.appendChild(activate);

      card.appendChild(form);
    }

    host.appendChild(card);
  };

  paint();

  void getProState().then(({ state }) => {
    current = state;
    paint();
  });

  return watchProState((state) => {
    current = state;
    checking = false;
    paint();
  });
}

/**
 * The per-channel auto-apply rules for one site.
 *
 * Rendered only for an entitled reader, and the section is empty otherwise — see
 * the note in §14 on which Pro surfaces are shown locked and which are absent. The
 * subscription is what makes the list appear the moment a key is accepted, without
 * asking the reader to reopen the settings they are already looking at.
 *
 * @returns a disposer for the entitlement subscription.
 */
export function renderChannelRules(
  doc: Document,
  host: Element,
  ctx: {
    siteId: string;
    siteLabel: string;
    showError: (message: string) => void;
    showSaved: (message: string) => void;
  },
): () => void {
  let entitled = false;
  let channels: readonly ChannelRule[] = [];

  /** Write the list whole, then repaint from what was stored. */
  const store = async (next: readonly ChannelRule[], saved: string): Promise<void> => {
    const result = await setSitePrefs(ctx.siteId, { channels: next });
    if (!result.ok) {
      ctx.showError(`Could not save the channel list: ${result.error}.`);
      return;
    }
    channels = next;
    ctx.showSaved(saved);
    paint();
  };

  function paint(): void {
    host.replaceChildren();
    if (!entitled) return;

    if (channels.length > 0) {
      const list = doc.createElement("ul");
      list.className = "wfs-channel-list";
      list.setAttribute("data-wfs-channel-list", "");
      for (const rule of channels) {
        const id = rule.id;
        const item = doc.createElement("li");
        item.className = "wfs-channel-item";
        item.setAttribute("data-wfs-channel-item", "");

        const name = doc.createElement("span");
        name.className = "wfs-channel-name";
        name.textContent = id;
        item.appendChild(name);

        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "wfs-channel-remove-btn";
        remove.setAttribute("data-wfs-channel-remove", "");
        remove.setAttribute("aria-label", `Remove ${id}`);
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          void store(
            channels.filter((entry) => entry.id !== id),
            `Removed ${id}.`,
          );
        });
        item.appendChild(remove);
        list.appendChild(item);
      }
      host.appendChild(list);
    }

    const addRow = doc.createElement("div");
    addRow.className = "wfs-channel-add-row";
    addRow.setAttribute("data-wfs-channel-field", "");

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "wfs-channel-input";
    input.setAttribute("data-wfs-channel-input", "");
    input.placeholder = "@channel";
    input.maxLength = MAX_CHANNEL_ID_LENGTH;
    input.autocomplete = "off";
    input.spellcheck = false;
    addRow.appendChild(input);

    const add = doc.createElement("button");
    add.type = "button";
    add.className = "wfs-channel-add-btn";
    add.setAttribute("data-wfs-channel-add", "");
    add.textContent = "Add";

    const submit = (): void => {
      const id = input.value.trim();
      if (id === "") return;
      if (channels.some((entry) => entry.id === id)) {
        ctx.showSaved(`${id} is already on the list.`);
        return;
      }
      if (channels.length >= MAX_CHANNEL_RULES) {
        ctx.showError(`The list is full at ${MAX_CHANNEL_RULES} channels. Remove one first.`);
        return;
      }
      input.value = "";
      void store([...channels, newChannelRule(id)], `Added ${id}.`);
    };

    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") submit();
    });
    addRow.appendChild(add);
    host.appendChild(addRow);
  }

  const load = (): void => {
    void getSitePrefs(ctx.siteId).then(({ prefs }) => {
      channels = prefs.channels;
      paint();
    });
  };

  void getProState().then(({ state }) => {
    entitled = isPro(state);
    if (entitled) load();
    else paint();
  });

  return watchProState((state) => {
    entitled = isPro(state);
    if (entitled) load();
    else paint();
  });
}

/**
 * Put a channel identifier into the rules field without submitting it.
 *
 * `startPopup` is what knows which channel the open tab is showing; the settings tree
 * does not, and should not have to ask. So the answer is pushed in from outside
 * rather than fetched from within, which also keeps §11 free of any dependency on
 * there being an open tab at all.
 *
 * Deliberately does not add the rule: the reader opened the popup to watch a video,
 * and a settings surface that writes a preference because a page was open is a
 * surface nobody can trust.
 *
 * A no-op when the field is absent (the reader is not entitled, so there is no
 * list) or already has something in it (they were typing).
 */
export function prefillChannelRule(root: ParentNode, channel: ChannelRef | null): void {
  if (!channel) return;
  const input = root.querySelector("[data-wfs-channel-input]") as HTMLInputElement | null;
  if (!input || input.value !== "") return;
  input.value = channel.id;
}

/**
 * Render the settings controls into `root`: the help section, the per-site
 * preference cards, the channel rules, a Pro teaser row, and a privacy-policy
 * footer link.
 *
 * THE POPUP IS THE ONLY SETTINGS SURFACE. There is no options page. Up to 2.0.0
 * there were two, and this function built either one from a `surface` flag: the
 * options page got a heading, a Settings/Pro tab strip and the full Pro panel, and
 * the popup got a single Pro row that opened that page. The options page was
 * removed because it earned nothing — `manifest.json` now points `options_ui` at
 * `popup/index.html`, so both entries in the browser's own menu land here — and
 * keeping it had a standing cost: one settings tree rendered into two hand-written
 * stylesheets, where a CSS fix landed in both files or it had not landed.
 *
 * Pro is a second VIEW rather than a second panel. `startPopup` swaps this tree out
 * for `renderProView` and back, so the reader gets the whole 320 px for the pitch or
 * for the preferences and never scrolls past a paywall to reach a checkbox. That was
 * the point of the tab strip, and a view swap achieves it in one surface.
 *
 * `[data-wfs-status]`, `[data-wfs-error]`, the prompt host and the footer host stay
 * direct children of `root`, in that order. Load-bearing: `startPopup` finds all
 * four by marker on the tree it was handed, and activation reports into the same
 * region a checkbox does.
 *
 * Each checkbox loads its effective value (stored, else the documented default).
 * On a failed write the control reverts to the last persisted value and an error
 * is shown, so the UI never claims a setting was saved when it was not.
 *
 * @returns a disposer for the entitlement subscriptions the Pro surfaces open.
 */
export function renderSettings(
  doc: Document,
  root: Element,
  options: {
    /**
     * Swap the popup over to the full Pro showcase view. Required: the Pro teaser
     * row has nowhere else to go now that there is no options page to open, and an
     * optional callback here would be a row that silently does nothing.
     */
    showProView: () => void;
  },
): () => void {
  root.replaceChildren();

  /** The last value known to be persisted, keyed `siteId:field`. */
  const persisted = new Map<string, boolean>();

  /** Everything the Pro surfaces subscribed to, torn down together. */
  const disposers: Array<() => void> = [];

  const status = doc.createElement("div");
  status.setAttribute("data-wfs-status", "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const error = doc.createElement("div");
  error.setAttribute("data-wfs-error", "");
  error.setAttribute("role", "alert");
  error.setAttribute("aria-live", "assertive");

  let statusTimeout: ReturnType<typeof setTimeout> | null = null;
  const showSaved = (message: string): void => {
    if (statusTimeout !== null) {
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }
    status.textContent = message;
    error.textContent = "";
    statusTimeout = setTimeout(() => {
      status.textContent = "";
      statusTimeout = null;
    }, 2200);
  };
  const showError = (message: string): void => {
    if (statusTimeout !== null) {
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }
    error.textContent = message;
    // A fresh error supersedes a stale confirmation.
    status.textContent = "";
    statusTimeout = setTimeout(() => {
      error.textContent = "";
      statusTimeout = null;
    }, 3800);
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

  /** Where the preference sections go: root in all surfaces. */
  const settingsHost: Element = root;

  /** A `<section>` with an uppercase-styled `<h2>`, the shared shape here. */
  const addSection = (marker: string, title: string): HTMLElement => {
    const section = doc.createElement("section");
    section.setAttribute(marker, "");
    const heading = doc.createElement("h2");
    heading.textContent = title;
    section.appendChild(heading);
    settingsHost.appendChild(section);
    return section;
  };

  // --- Help, which now owns the keyboard shortcut ---------------------------
  const helpHost = doc.createElement("div");
  helpHost.setAttribute("data-wfs-help-section", "");
  settingsHost.appendChild(helpHost);
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

  // --- Per-site toggles ---------------------------------------------------

  /**
   * Pro-gated checkboxes that need updating when entitlement changes. Each entry
   * holds the checkbox and its wrapper so both can be disabled/muted in one pass.
   */
  const proGatedControls: Array<{
    checkbox: HTMLInputElement;
    wrapper: HTMLLabelElement;
    lock: HTMLElement;
  }> = [];

  /**
   * Apply — or lift — the lock on Pro-gated checkboxes.
   *
   * The padlock is part of the lock, not a permanent label for the feature. It was
   * appended once while the row was built and never touched again, so an entitled
   * reader kept a padlock beside a setting they had already paid for and could
   * already change — the control was live and the icon beside it said it was not.
   * Anything this turns off it has to be able to turn back on, which is why the
   * icon is registered here with the checkbox instead of being left to the paint.
   */
  const applyProGateToToggles = (entitled: boolean): void => {
    for (const { checkbox, wrapper, lock } of proGatedControls) {
      checkbox.disabled = !entitled;
      wrapper.style.opacity = entitled ? "" : "0.5";
      wrapper.style.pointerEvents = entitled ? "" : "none";
      // `hidden` rather than a display style: no stylesheet gives the badge a
      // `display`, so the attribute takes it out of the layout and out of the
      // accessibility tree in one move.
      lock.hidden = entitled;
    }
  };

  // Initialise from storage, then watch for changes so a key entered in the Pro
  // tab or the popup takes effect immediately without a page reload.
  void getProState().then(({ state }) => applyProGateToToggles(isPro(state)));
  disposers.push(watchProState((state) => applyProGateToToggles(isPro(state))));

  for (const { siteId, label } of supportedSites()) {
    const section = addSection("data-wfs-site-section", label);
    section.setAttribute("data-site-id", siteId);

    const collageGrid = doc.createElement("div");
    collageGrid.className = "wfs-collage-grid";
    collageGrid.setAttribute("data-wfs-collage-grid", "");
    section.appendChild(collageGrid);

    // Helper to create clean cards within the collage grid
    const createCard = (
      cardKey: string,
      title: string,
      subtitle: string,
      badgeText: string,
      badgeType: "free" | "pro" | "mix",
    ): HTMLElement => {
      const card = doc.createElement("div");
      card.className = "wfs-card";
      card.setAttribute("data-wfs-card", cardKey);

      const header = doc.createElement("div");
      header.className = "wfs-card__header";

      const headerText = doc.createElement("div");
      headerText.className = "wfs-card__header-text";

      const heading = doc.createElement("h3");
      heading.className = "wfs-card__title";
      heading.textContent = title;
      headerText.appendChild(heading);

      if (subtitle) {
        const desc = doc.createElement("p");
        desc.className = "wfs-card__subtitle";
        desc.textContent = subtitle;
        headerText.appendChild(desc);
      }
      header.appendChild(headerText);

      const badge = doc.createElement("span");
      badge.className = `wfs-card__badge is-${badgeType}`;
      badge.textContent = badgeText;
      header.appendChild(badge);

      card.appendChild(header);
      collageGrid.appendChild(card);
      return card;
    };

    const playbackCard = createCard(
      "playback",
      "Viewing Modes & Playback",
      "",
      "Free",
      "free",
    );

    const appearanceCard = createCard(
      "appearance",
      "\uD83C\uDFA8 Letterbox Themes",
      "",
      "PRO \u26A1",
      "pro",
    );

    const captureCard = createCard(
      "capture",
      "Media & Frame Capture",
      "",
      "Pro \u26A1",
      "pro",
    );

    const channelsCard = createCard(
      "channels",
      "Auto-Fullscreen Channels",
      "",
      "Pro \u26A1",
      "pro",
    );

    let ambientGlowCheckboxRef: HTMLInputElement | null = null;

    // Render toggles into their designated cards
    for (const toggle of SITE_TOGGLES) {
      const text = toggle.text(label);
      const stateKey = `${siteId}:${toggle.field}`;

      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute(toggle.marker, "");
      checkbox.setAttribute("data-site-id", siteId);
      const ariaName = toggle.aria?.(label);
      if (ariaName) checkbox.setAttribute("aria-label", ariaName);

      if (toggle.field === "ambientGlow") {
        ambientGlowCheckboxRef = checkbox;
      }

      checkbox.addEventListener("change", () => {
        void (async () => {
          const next = checkbox.checked;
          if (toggle.field === "ambientGlow") {
            if (next) {
              colorInput.value = "";
              previewBox.style.background = "#000000";
              updateActiveSwatch("");
              const result = await setSitePrefs(siteId, { ambientGlow: true, letterboxColor: "" });
              if (!result.ok) {
                checkbox.checked = persisted.get(stateKey) ?? DEFAULT_SITE_PREFS[toggle.field];
                showError(`Could not save "${text}" for "${label}": not saved (${result.error}).`);
                return;
              }
              persisted.set(stateKey, true);
              showSaved(`Saved "${text}" for "${label}".`);
              return;
            } else {
              const result = await setSitePrefs(siteId, { ambientGlow: false });
              if (!result.ok) {
                checkbox.checked = persisted.get(stateKey) ?? DEFAULT_SITE_PREFS[toggle.field];
                showError(`Could not save "${text}" for "${label}": not saved (${result.error}).`);
                return;
              }
              persisted.set(stateKey, false);
              showSaved(`Saved "${text}" for "${label}".`);
              return;
            }
          }
          const patch: Partial<SitePrefs> = { [toggle.field]: next };
          const result = await setSitePrefs(siteId, patch);
          if (!result.ok) {
            checkbox.checked = persisted.get(stateKey) ?? DEFAULT_SITE_PREFS[toggle.field];
            showError(`Could not save "${text}" for "${label}": not saved (${result.error}).`);
            return;
          }
          persisted.set(stateKey, next);
          showSaved(`Saved "${text}" for "${label}".`);
        })();
      });

      const row = doc.createElement("label");
      row.className = "wfs-setting-row";

      const info = doc.createElement("div");
      info.className = "wfs-setting-info";

      const titleSpan = doc.createElement("span");
      titleSpan.className = "wfs-setting-title";
      titleSpan.textContent = text;
      info.appendChild(titleSpan);

      if (toggle.proGated) {
        const lock = doc.createElement("span");
        lock.setAttribute("data-wfs-pro-lock", "");
        lock.className = "wfs-pro-lock";
        lock.textContent = " \uD83D\uDD12";
        lock.title = "Pro feature";
        titleSpan.appendChild(lock);
        proGatedControls.push({ checkbox, wrapper: row, lock });
      }

      if (toggle.hint) {
        const hint = doc.createElement("p");
        const hintId = `wfs-hint-${siteId}-${String(toggle.field)}`;
        hint.id = hintId;
        hint.className = "wfs-setting-desc";
        hint.textContent = toggle.hint;
        checkbox.setAttribute("aria-describedby", hintId);
        info.appendChild(hint);
      }

      const switchWrapper = doc.createElement("div");
      switchWrapper.className = "wfs-switch";
      switchWrapper.appendChild(checkbox);

      const slider = doc.createElement("span");
      slider.className = "wfs-slider";
      switchWrapper.appendChild(slider);

      row.appendChild(info);
      row.appendChild(switchWrapper);

      const targetCard =
        toggle.category === "playback"
          ? playbackCard
          : toggle.category === "appearance"
            ? appearanceCard
            : captureCard;

      targetCard.appendChild(row);

      void getSitePrefs(siteId).then(({ prefs, loadFailed }) => {
        const value = prefs[toggle.field];
        persisted.set(stateKey, value);
        checkbox.checked = value;
        if (loadFailed) showError("Could not load preferences; showing defaults.");
      });
    }

    // --- Letterbox Palette & Themes in appearanceCard ---
    const letterboxSection = doc.createElement("div");
    letterboxSection.className = "wfs-letterbox-section";
    letterboxSection.setAttribute("data-wfs-letterbox-section", "");

    const customHeader = doc.createElement("div");
    customHeader.className = "wfs-swatch-group-label";
    customHeader.textContent = "CUSTOM COLORS & GRADIENTS";
    letterboxSection.appendChild(customHeader);

    // Presets Grid Container
    const presetsContainer = doc.createElement("div");
    presetsContainer.className = "wfs-presets-container";

    const allSwatchButtons: Array<{ btn: HTMLButtonElement; val: string }> = [];

    const previewBox = doc.createElement("div");
    previewBox.className = "wfs-color-preview-box";

    const updateActiveSwatch = (currentVal: string): void => {
      const norm = currentVal.trim().toLowerCase();
      previewBox.style.background = currentVal || "#000000";
      for (const { btn, val } of allSwatchButtons) {
        const isMatch = val.toLowerCase() === norm;
        btn.classList.toggle("is-selected", isMatch);
        btn.setAttribute("aria-pressed", isMatch ? "true" : "false");
      }
    };

    // Custom Color Controls Row (Bottom Bar)
    const customRow = doc.createElement("div");
    customRow.className = "wfs-color-custom-row";

    const colorInput = doc.createElement("input");
    colorInput.type = "text";
    colorInput.className = "wfs-color-hex-input";
    colorInput.setAttribute("data-wfs-letterbox-input", "");
    colorInput.placeholder = "linear-gradient(...) or #000000";
    colorInput.maxLength = 120;
    colorInput.autocomplete = "off";
    colorInput.spellcheck = false;

    const resetColorBtn = doc.createElement("button");
    resetColorBtn.type = "button";
    resetColorBtn.className = "wfs-color-reset-btn";
    resetColorBtn.textContent = "RESET TO BLACK";

    const applyChosenColor = (val: string, name?: string): void => {
      if (ambientGlowCheckboxRef) ambientGlowCheckboxRef.checked = false;
      persisted.set(`${siteId}:ambientGlow`, false);
      colorInput.value = val;
      updateActiveSwatch(val);
      void (async () => {
        const result = await setSitePrefs(siteId, {
          letterboxColor: val,
          ambientGlow: false,
        });
        if (result.ok) {
          showSaved(name ? `Saved letterbox theme: ${name}.` : "Saved letterbox theme.");
        } else {
          showError(`Could not save letterbox theme: ${result.error}.`);
        }
      })();
    };

    // Row 1: 5 solid swatches (Pink, Purple, Peach, Cyan, Black) + LAAGGUE + GRASLET
    const presetRow1 = doc.createElement("div");
    presetRow1.className = "wfs-preset-row wfs-preset-row--1";

    for (const swatch of LETTERBOX_SWATCHES) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "wfs-color-swatch";
      btn.title = swatch.name;
      btn.setAttribute("aria-label", swatch.name);
      btn.style.backgroundColor = swatch.color;
      btn.addEventListener("click", () => applyChosenColor(swatch.value, swatch.name));
      allSwatchButtons.push({ btn, val: swatch.value });
      presetRow1.appendChild(btn);
    }

    const row1Themes = LETTERBOX_THEMES.slice(0, 2);
    for (const theme of row1Themes) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "wfs-theme-swatch";
      btn.title = theme.name;
      btn.setAttribute("aria-label", theme.name);
      btn.style.background = theme.value;
      const span = doc.createElement("span");
      span.textContent = theme.name;
      btn.appendChild(span);
      btn.addEventListener("click", () => applyChosenColor(theme.value, theme.name));
      allSwatchButtons.push({ btn, val: theme.value });
      presetRow1.appendChild(btn);
    }
    presetsContainer.appendChild(presetRow1);

    // Row 2: TWILIGHT, EMBER, CYBER, ABYSS
    const presetRow2 = doc.createElement("div");
    presetRow2.className = "wfs-preset-row wfs-preset-row--2";

    const row2Themes = LETTERBOX_THEMES.slice(2);
    for (const theme of row2Themes) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "wfs-theme-swatch";
      btn.title = theme.name;
      btn.setAttribute("aria-label", theme.name);
      btn.style.background = theme.value;
      const span = doc.createElement("span");
      span.textContent = theme.name;
      btn.appendChild(span);
      btn.addEventListener("click", () => applyChosenColor(theme.value, theme.name));
      allSwatchButtons.push({ btn, val: theme.value });
      presetRow2.appendChild(btn);
    }
    presetsContainer.appendChild(presetRow2);
    letterboxSection.appendChild(presetsContainer);

    colorInput.addEventListener("change", () => {
      applyChosenColor(colorInput.value.trim());
    });

    resetColorBtn.title = "Reset letterbox color to default black";
    resetColorBtn.addEventListener("click", () => {
      if (ambientGlowCheckboxRef) ambientGlowCheckboxRef.checked = false;
      persisted.set(`${siteId}:ambientGlow`, false);
      void (async () => {
        const result = await setSitePrefs(siteId, {
          letterboxColor: "",
          ambientGlow: false,
        });
        if (!result.ok) {
          showError(`Could not reset letterbox color: ${result.error}.`);
          return;
        }
        colorInput.value = "";
        previewBox.style.background = "#000000";
        updateActiveSwatch("");
        showSaved("Reset letterbox color to black.");
      })();
    });

    customRow.appendChild(previewBox);
    customRow.appendChild(colorInput);
    customRow.appendChild(resetColorBtn);
    letterboxSection.appendChild(customRow);

    appearanceCard.appendChild(letterboxSection);

    const letterboxLock = doc.createElement("span");
    letterboxLock.setAttribute("data-wfs-pro-lock", "");
    letterboxLock.textContent = " \uD83D\uDD12";
    letterboxLock.title = "Pro feature";

    proGatedControls.push({
      checkbox: colorInput as unknown as HTMLInputElement,
      wrapper: letterboxSection as unknown as HTMLLabelElement,
      lock: letterboxLock,
    });

    // --- Capture Card: Screenshot Filename Format (Pro) ---
    const templateGroup = doc.createElement("div");
    templateGroup.className = "wfs-template-group";
    templateGroup.setAttribute("data-wfs-template-label", "");

    const templateHeader = doc.createElement("div");
    templateHeader.className = "wfs-template-header";

    const templateText = doc.createElement("span");
    templateText.className = "wfs-template-title";
    templateText.textContent = "Screenshot Filename Format";
    templateHeader.appendChild(templateText);

    const templateLock = doc.createElement("span");
    templateLock.setAttribute("data-wfs-pro-lock", "");
    templateLock.className = "wfs-pro-lock";
    templateLock.textContent = " \uD83D\uDD12";
    templateLock.title = "Pro feature";
    templateHeader.appendChild(templateLock);
    templateGroup.appendChild(templateHeader);

    const templateInput = doc.createElement("input");
    templateInput.type = "text";
    templateInput.className = "wfs-template-input";
    templateInput.setAttribute("data-wfs-template-input", "");
    templateInput.placeholder = "{title}-{timestamp}";
    templateInput.maxLength = 80;
    templateInput.autocomplete = "off";
    templateInput.spellcheck = false;

    templateInput.addEventListener("change", () => {
      void (async () => {
        const val = templateInput.value.trim();
        const result = await setSitePrefs(siteId, { captureFilenameTemplate: val });
        if (!result.ok) {
          showError(`Could not save filename format: ${result.error}.`);
          return;
        }
        showSaved("Saved filename format.");
      })();
    });
    templateGroup.appendChild(templateInput);

    const tagsRow = doc.createElement("div");
    tagsRow.className = "wfs-template-tags";
    const tagList = ["{title}", "{timestamp}", "{channel}"];
    for (const tag of tagList) {
      const badge = doc.createElement("button");
      badge.type = "button";
      badge.className = "wfs-tag-badge";
      badge.textContent = tag;
      badge.title = `Add ${tag} to filename format`;
      badge.addEventListener("click", () => {
        templateInput.value = (templateInput.value ? `${templateInput.value}-` : "") + tag;
        templateInput.dispatchEvent(new Event("change"));
      });
      tagsRow.appendChild(badge);
    }
    templateGroup.appendChild(tagsRow);
    captureCard.appendChild(templateGroup);

    proGatedControls.push({
      checkbox: templateInput as unknown as HTMLInputElement,
      wrapper: templateGroup as unknown as HTMLLabelElement,
      lock: templateLock,
    });

    void getSitePrefs(siteId).then(({ prefs }) => {
      if (prefs.ambientGlow) {
        if (ambientGlowCheckboxRef) ambientGlowCheckboxRef.checked = true;
        colorInput.value = "";
        previewBox.style.background = "#000000";
        updateActiveSwatch("");
      } else {
        if (ambientGlowCheckboxRef) ambientGlowCheckboxRef.checked = false;
        colorInput.value = prefs.letterboxColor;
        previewBox.style.background = prefs.letterboxColor || "#000000";
        updateActiveSwatch(prefs.letterboxColor);
      }
      templateInput.value = prefs.captureFilenameTemplate;
    });

    disposers.push(
      watchSitePrefs(siteId, (prefs) => {
        if (prefs.ambientGlow) {
          if (ambientGlowCheckboxRef) ambientGlowCheckboxRef.checked = true;
          colorInput.value = "";
          previewBox.style.background = "#000000";
          updateActiveSwatch("");
        } else {
          if (ambientGlowCheckboxRef) ambientGlowCheckboxRef.checked = false;
          colorInput.value = prefs.letterboxColor;
          previewBox.style.background = prefs.letterboxColor || "#000000";
          updateActiveSwatch(prefs.letterboxColor);
        }
      }),
    );

    // --- Channel Rules in channelsCard ---
    const channelHost = doc.createElement("div");
    channelHost.setAttribute("data-wfs-channel-section", "");
    channelsCard.appendChild(channelHost);
    try {
      disposers.push(
        renderChannelRules(doc, channelHost, { siteId, siteLabel: label, showError, showSaved }),
      );
    } catch {
      showError("Channel list failed to render.");
    }

  }

  // --- Pro: one row, and a door to the showcase ---------------------------
  // A teaser rather than the pitch itself, because this tree is the preferences and
  // a reader reaching for a checkbox should not have to scroll past a price. The row
  // swaps the popup over to `renderProView`, which gets the full width to sell in.
  const summaryHost = doc.createElement("section");
  summaryHost.setAttribute("data-wfs-pro-summary-section", "");
  settingsHost.appendChild(summaryHost);
  try {
    disposers.push(
      renderProSummary(doc, summaryHost, { openProPanel: options.showProView }),
    );
  } catch {
    showError("Pro row failed to render.");
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

  return () => {
    for (const dispose of disposers) dispose();
  };
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
  if (!status.siteSupported) return "Open YouTube";
  if (!status.pageSupported) return "Open a video to use it";
  if (!status.reachable) return "Reload the page to control it here";
  return status.modeActive ? "Exit windowed fullscreen" : "Enter windowed fullscreen";
}

/** Render the popup's status block and toggle, replacing any prior content. */
function renderPopup(
  doc: Document,
  root: HTMLElement,
  status: PopupStatus,
  onToggle: () => void,
): void {
  root.replaceChildren();

  // Header container: brand info, Pro badge/actions, and inline activation box
  const headerContainer = doc.createElement("div");
  headerContainer.className = "wfs-popup__header";

  const topRow = doc.createElement("div");
  topRow.className = "wfs-popup__header-top";

  const brandGroup = doc.createElement("div");
  brandGroup.className = "wfs-popup__brand";

  const titleRow = doc.createElement("div");
  titleRow.className = "wfs-popup__title-row";

  const heading = doc.createElement("h1");
  heading.className = "wfs-popup__title";
  heading.textContent = "Windowed Fullscreen";
  titleRow.appendChild(heading);

  const verBadge = doc.createElement("span");
  verBadge.className = "wfs-popup__version";
  verBadge.textContent = "v2.0";
  titleRow.appendChild(verBadge);

  brandGroup.appendChild(titleRow);

  const statusSub = doc.createElement("div");
  statusSub.className =
    "wfs-popup__status-sub " + (status.siteSupported ? "is-connected" : "is-standby");
  statusSub.innerHTML = status.siteSupported
    ? `<span class="wfs-pulse-dot"></span> YouTube Connected`
    : `<span class="wfs-idle-dot"></span> Standby`;
  brandGroup.appendChild(statusSub);

  topRow.appendChild(brandGroup);

  const badgeSlot = doc.createElement("div");
  badgeSlot.className = "wfs-popup__header-badge-slot";
  badgeSlot.setAttribute("data-wfs-pro-header-badge-slot", "");
  topRow.appendChild(badgeSlot);

  headerContainer.appendChild(topRow);

  const headerActions = doc.createElement("div");
  headerActions.className = "wfs-popup__header-actions";

  // The Pro button / activation slot
  const proSlot = doc.createElement("div");
  proSlot.setAttribute("data-wfs-pro-header-slot", "");
  headerActions.appendChild(proSlot);

  headerContainer.appendChild(headerActions);
  root.appendChild(headerContainer);

  const list = doc.createElement("dl");
  list.className = "wfs-popup__status";
  const term = doc.createElement("dt");
  term.textContent = "Supported site";
  const detail = doc.createElement("dd");
  detail.textContent = status.siteSupported ? `Yes (${status.siteId})` : "No";
  detail.classList.add(status.siteSupported ? "is-on" : "is-off");
  list.append(term, detail);
  root.appendChild(list);

  // Master Hero Toggle Button (Open YouTube if unsupported site, or toggle windowed fullscreen)
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "wfs-popup__toggle";
  toggle.textContent = toggleLabel(status);

  if (!status.siteSupported) {
    toggle.disabled = false;
    toggle.classList.add("is-open-youtube");
    toggle.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://www.youtube.com" });
    });
  } else {
    const enabled = status.pageSupported && status.reachable;
    toggle.disabled = !enabled;
    toggle.classList.toggle(BUTTON_ACTIVE_CLASS, status.modeActive);
    if (enabled) toggle.addEventListener("click", onToggle);
  }
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

  // --- Two-view navigation: main (toggle + settings) and Pro showcase ------
  const mainSections = {
    app: root,
    pinPrompt: document.getElementById("pin-prompt"),
    settings: document.getElementById("settings"),
  };
  const proViewHost = document.getElementById("pro-view");
  let proDisposer: (() => void) | null = null;

  /** Switch the popup to the Pro showcase view. */
  const showProView = (focusKeyInput = false): void => {
    if (!proViewHost) return;
    // Hide main content
    root.setAttribute("hidden", "");
    if (mainSections.pinPrompt) mainSections.pinPrompt.setAttribute("hidden", "");
    if (mainSections.settings) mainSections.settings.setAttribute("hidden", "");
    // Show Pro view
    proViewHost.removeAttribute("hidden");
    proDisposer = renderProView(document, proViewHost, {
      onBack: showMainView,
    });

    if (focusKeyInput) {
      setTimeout(() => {
        const input = proViewHost.querySelector("input[data-wfs-pro-key]") as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 50);
    }
  };

  /** Switch back to the main popup view. */
  const showMainView = (): void => {
    if (proDisposer) { proDisposer(); proDisposer = null; }
    if (proViewHost) {
      proViewHost.setAttribute("hidden", "");
      proViewHost.replaceChildren();
    }
    // Restore main content
    root.removeAttribute("hidden");
    if (mainSections.pinPrompt) mainSections.pinPrompt.removeAttribute("hidden");
    if (mainSections.settings) mainSections.settings.removeAttribute("hidden");
  };

  const paint = (): void => {
    renderPopup(
      document,
      root,
      derivePopupStatus(url, response),
      () => {
        void (async () => {
          const toggled = await askContentScript(tabId, { type: "TOGGLE" });
          if (toggled) {
            response = toggled;
            paint();
          }
        })();
      },
    );

    // Fill the Pro header slots
    const badgeSlot = root.querySelector("[data-wfs-pro-header-badge-slot]");
    const slot = root.querySelector("[data-wfs-pro-header-slot]");
    if (slot && badgeSlot) {
      const renderHeaderButtons = (entitled: boolean) => {
        badgeSlot.replaceChildren();
        slot.replaceChildren();
        if (entitled) {
          const proBadge = document.createElement("button");
          proBadge.type = "button";
          proBadge.setAttribute("data-wfs-pro-header-btn", "");
          proBadge.classList.add("is-pro");
          proBadge.textContent = "✨ Pro Active";
          proBadge.title = "Pro is active on this device";
          proBadge.addEventListener("click", () => showProView(false));
          badgeSlot.appendChild(proBadge);
        } else {
          const card = document.createElement("div");
          card.className = "wfs-popup__header-pro-card";

          const buyBtn = document.createElement("button");
          buyBtn.type = "button";
          buyBtn.setAttribute("data-wfs-pro-header-buy", "");
          buyBtn.textContent = "⚡ Get Pro";
          buyBtn.title = "View Pro features & pricing";
          buyBtn.addEventListener("click", () => showProView(false));

          const actBtn = document.createElement("button");
          actBtn.type = "button";
          actBtn.setAttribute("data-wfs-pro-header-activate", "");
          actBtn.textContent = "Already bought? Activate";
          actBtn.title = "Enter and activate your license key";
          actBtn.addEventListener("click", () => showProView(true));

          card.appendChild(buyBtn);
          card.appendChild(actBtn);
          slot.appendChild(card);
        }
      };

      void getProState().then(({ state }) => {
        renderHeaderButtons(isPro(state));
      });
      watchProState((state) => {
        renderHeaderButtons(isPro(state));
      });
    }
  };

  paint();

  // The settings controls load their own values, so render them once up front.
  //
  // The disposer is deliberately not held. A popup document is destroyed outright
  // when the popup closes, which takes its storage listeners with it; there is no
  // event that fires first and nothing to hang a call on. It is returned so a
  // future surface that does outlive its tree can unsubscribe.
  const settings = mainSections.settings;
  if (settings) renderSettings(document, settings, { showProView });

  // --- Prompt decision (R9.19, R16.1, R16.2, R16.4, R16.5–R16.8, R16.12) ---
  // Async step after the initial paint: read the Pin_State, compute both
  // decisions, ask promptPrecedence, render at most one prompt, then record
  // that showing. A failed or stalled read never blocks the popup — the
  // paint-early-repaint-later structure stays intact.
  const pinPromptRoot = mainSections.pinPrompt;
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

    // The popup is the only surface that knows which channel the open tab is
    // showing, so it hands that to the shared settings tree. Filled in, never
    // submitted: the reader opened the popup to watch something, and a settings
    // surface that saves a preference because a page happened to be open is one
    // nobody can trust. The field is absent without Pro, and `prefillChannelRule`
    // treats that as nothing to do.
    if (settings && response?.ok) prefillChannelRule(settings, response.channel ?? null);
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

// ===========================================================================
// §14  Entitlement (Pro tier)
// ===========================================================================
//
// The paid tier's stored state and its single gate. Provider-agnostic, and as of
// this section entirely offline: {@link validateLicenceKey} is a stub that never
// touches the network, so invariant 6 — nothing leaves the device — still holds
// in full. When the real validator lands it will send exactly one thing, the
// licence key the reader typed, to exactly one endpoint, and every privacy claim
// in `README.md`, `store-assets/LISTING.md`, the published listing, and
// `.kiro/steering/product.md` has to change in that same commit.
//
// WHY THIS IS ITS OWN SECTION
// The type, the record, the coercion, the gate, and the validator boundary all
// live here rather than being filed with preferences in §1 and §5. Entitlement is
// not a preference: the reader does not choose it, and it is the only stored value
// an outside authority can revoke. Keeping it beside the checkboxes invites a
// later writer to fold it into `SitePrefs`, which would hand Pro to anyone who can
// edit local storage. It is also the part of this extension most likely to be
// replaced wholesale when the payment provider changes, and a layer confined to
// one section is a layer that can be swapped in one place.
//
// GOVERNING RULES
//  1. **Nothing that was free before this section existed is gated by it.** The
//     comment panel, both modes, the live-chat dock, the suggestions rail, and
//     per-site auto-apply had all shipped publicly before the tier existed. Every
//     Pro feature is new work, which is why there is no grandfathering code here
//     and must never need to be any.
//  2. **Fail open.** A network failure, a broken endpoint, or an unreadable record
//     leaves an already-entitled reader entitled. A paying reader losing features
//     on a flaky connection is a worse outcome than a pirate getting a free
//     fortnight.
//  3. **Fail open applies to re-validation, never to activation.** An install that
//     has never had a valid answer is not Pro, whatever the network did. Rule 2
//     extends an entitlement that was granted; it never grants one.
//
// Nothing in the extension consumes this section yet. That is deliberate — the
// layer is reviewable, and discardable, on its own.

/** Where the entitlement record lives. One more top-level key in the local area. */
export const PRO_KEY = "pro";

/**
 * What the last validation attempt concluded. Recorded so the settings UI can say
 * *why* the reader is or is not Pro, which `entitled` alone cannot: an unreachable
 * endpoint and a revoked key both leave a reader without features, and only one of
 * them is worth telling them to check their connection about.
 *
 * - `none` — no key has been entered. The first-run state.
 * - `active` — the validator confirmed the key.
 * - `invalid` — the validator rejected it. A definite answer: a typo, a refund, or
 *   an activation limit reached. Not subject to rule 2.
 * - `unreachable` — no answer arrived. Rule 2 applies.
 */
export type ProStatus = "none" | "active" | "invalid" | "unreachable";

/**
 * Persisted entitlement record. One storage key, written whole — the licence field
 * in the settings tree is the only thing that writes it, and it always knows the
 * complete record it wants stored. Same treatment as {@link RatingState}, and for
 * the same reason: a rejected write leaves the previous record intact.
 *
 * The field is `entitled` rather than the brief's `pro` because a record stored
 * under the key `pro` with a field called `pro` reads as a typo at every use site.
 */
export interface ProState {
  /**
   * The key as stored — already run through {@link normalizeLicenceKey}, so what
   * is written is what will be sent, with no second normalisation step to drift.
   * Empty string means none entered.
   */
  key: string;
  /**
   * The provider's id for **this device's** activation, or `""` when the licence is
   * not bound to a device.
   *
   * This is what makes the activation limit on the product mean anything: it is
   * sent with every re-check, and handed back to the provider when the reader
   * removes the key so the slot is freed rather than burned.
   *
   * Empty is a valid state, not a broken one. A record written before activation
   * existed in this extension has no instance, and keeps working unbound — a reader
   * must not lose a licence they already entered because a later version learned to
   * count devices.
   */
  instanceId: string;
  /**
   * Whether the tier is unlocked. Set only by a validator answer, never by the UI
   * directly, and never true with an empty {@link key} — see the coercion.
   */
  entitled: boolean;
  /** The last attempt's conclusion. */
  status: ProStatus;
  /**
   * When a *definite* answer last arrived (`active` or `invalid`), in ms since
   * epoch; 0 means never, and {@link proCheckDue} reads it that way rather than as
   * the epoch. Drives the {@link PRO_REVALIDATE_INTERVAL_MS} schedule.
   */
  checkedAt: number;
  /**
   * When validation was last *attempted*, definite or not; 0 means never. Bounds
   * retries after an unreachable endpoint.
   *
   * Two timestamps rather than one, because one cannot do both jobs. Moving a
   * single field on a failed attempt would push the next revalidation another
   * fortnight out every time the network hiccupped, so a revoked key could stay
   * live indefinitely. Leaving it unmoved would make the check due on every
   * service-worker wake, which is an unbounded retry against someone else's
   * server — the network-side form of the bounded-loops invariant.
   */
  attemptedAt: number;
}

/** Documented defaults applied when nothing is stored. */
export const DEFAULT_PRO_STATE: ProState = {
  key: "",
  instanceId: "",
  entitled: false,
  status: "none",
  checkedAt: 0,
  attemptedAt: 0,
};

/**
 * Longest activation id accepted. The provider issues `lki_` followed by an
 * identifier; 128 is generous headroom and bounds what a hand-edited record can put
 * into a request body.
 */
export const MAX_INSTANCE_ID_LENGTH = 128;

/**
 * How long a confirmed licence is trusted before it is checked again.
 *
 * 14 days. The number balances two costs that pull opposite ways: a shorter
 * interval means more requests to a paid third-party API for a purchase that
 * cannot change after the fact, and a longer one means a refunded or
 * charged-back key keeps its features for longer. A fortnight is short enough
 * that a refund lands within one billing dispute window and long enough that a
 * daily user's extension talks to the network twice a month.
 */
export const PRO_REVALIDATE_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The shortest gap between attempts once one has failed to get an answer.
 *
 * 6 hours. This is the bound that keeps rule 2 from becoming a retry storm: with
 * fail-open, a reader whose check cannot complete keeps every feature, so there is
 * nothing to gain by asking again soon. Long enough that an offline laptop makes
 * at most a handful of attempts a day; short enough that a reader who was offline
 * for a fortnight is revalidated the same day they reconnect.
 */
export const PRO_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Bounds on a stored licence key, in characters.
 *
 * A Dodo Payments licence key is a 36-character UUID-shaped string. 128 is
 * generous headroom against a provider change — Gumroad is the documented
 * fallback and uses a similar length — while keeping the stored record a small
 * string no matter what is pasted into the field. The floor exists so an
 * accidental single keystroke is rejected before it reaches the validator.
 */
export const MAX_LICENCE_KEY_LENGTH = 128;
export const MIN_LICENCE_KEY_LENGTH = 8;

/**
 * Characters a licence key may contain, after {@link normalizeLicenceKey}.
 *
 * Letters, digits, hyphen, underscore: the intersection of what Dodo and Gumroad
 * issue. Case is deliberately preserved rather than folded — a provider is free to
 * treat its keys case-sensitively, and upper-casing on the reader's behalf would
 * turn a valid key into an invalid one with no way for them to see why.
 */
const LICENCE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Tidy a key the reader typed or pasted into the form that gets stored and sent.
 *
 * All whitespace is removed, not merely trimmed at the ends. A key copied out of
 * a receipt email routinely arrives wrapped across a line break or with a stray
 * space mid-string, and a key never legitimately contains one — so stripping is
 * always the reader's intent, and rejecting instead would fail them for something
 * their mail client did.
 */
export function normalizeLicenceKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, "");
}

/**
 * Whether a key is worth sending. A shape check only — it says nothing about
 * whether the key was ever bought.
 *
 * Its job is to keep the settings UI able to answer "that is not a licence key"
 * without a round trip, and to keep junk out of the request. A key that passes
 * this and is then rejected by the validator is the ordinary wrong-key case.
 */
export function licenceKeyLooksWellFormed(key: string): boolean {
  return (
    key.length >= MIN_LICENCE_KEY_LENGTH &&
    key.length <= MAX_LICENCE_KEY_LENGTH &&
    LICENCE_KEY_PATTERN.test(key)
  );
}

/**
 * Coerce a stored entitlement record, field by field.
 *
 * Always returns a record, like {@link normalizeRatingState} rather than
 * {@link getSitePrefs}: an absent record is the ordinary never-purchased case and
 * the defaults are exactly what it should see.
 *
 * One cross-field rule beyond the per-field checks: **entitlement requires a key.**
 * A record claiming `entitled` with no key to revalidate could never be re-checked,
 * so it would be a permanent unlock — which is what a hand-edited record looks
 * like. This is not a security boundary and is not pretending to be one; local
 * storage belongs to the reader and anyone willing to edit it can also set a
 * plausible key. It keeps the record self-consistent, so {@link isPro} has one
 * thing to test and the revalidation schedule always has something to work with.
 */
export function normalizeProState(stored: unknown): ProState {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_PRO_STATE };
  }
  const raw = stored as Record<string, unknown>;

  // Normalised on the way in as well as on the way out: a record written by a
  // version whose normalisation differed still reads as the key it meant.
  const key = normalizeLicenceKey(raw.key);
  const keyIsUsable = licenceKeyLooksWellFormed(key);

  const status = isProStatus(raw.status) ? raw.status : DEFAULT_PRO_STATE.status;
  const entitled = typeof raw.entitled === "boolean" ? raw.entitled : DEFAULT_PRO_STATE.entitled;

  // Bounded and stripped of anything that is not an identifier, because this value
  // goes straight into a request body. An unusable one degrades to "not bound",
  // which still validates — see `ProState.instanceId`.
  const rawInstance = typeof raw.instanceId === "string" ? raw.instanceId.trim() : "";
  const instanceId =
    rawInstance.length > 0 &&
    rawInstance.length <= MAX_INSTANCE_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(rawInstance)
      ? rawInstance
      : "";

  return {
    key: keyIsUsable ? key : "",
    // Without a key there is nothing for an activation to belong to.
    instanceId: keyIsUsable ? instanceId : "",
    entitled: keyIsUsable && entitled,
    // With no usable key there is nothing an outcome could be about, so the record
    // reads back as a first run rather than as a rejection the reader must clear.
    status: keyIsUsable ? status : DEFAULT_PRO_STATE.status,
    checkedAt: isCount(raw.checkedAt, Number.MAX_SAFE_INTEGER)
      ? raw.checkedAt
      : DEFAULT_PRO_STATE.checkedAt,
    attemptedAt: isCount(raw.attemptedAt, Number.MAX_SAFE_INTEGER)
      ? raw.attemptedAt
      : DEFAULT_PRO_STATE.attemptedAt,
  };
}

/** True for one of the four documented status strings. */
function isProStatus(value: unknown): value is ProStatus {
  return value === "none" || value === "active" || value === "invalid" || value === "unreachable";
}

/**
 * **The gate.** Every Pro feature asks this one function and nothing else.
 *
 * Pure and synchronous over a record the caller already holds, rather than an
 * `async` read of storage. Two reasons. The surfaces that gate — the injector and
 * the content script — decide inside a click handler, where there is nothing to
 * await into; and a gate that reads storage on every call would be asked once per
 * pointer event. Every surface therefore loads the record once and follows
 * {@link watchProState}, which is the same shape as `watchSitePrefs`.
 *
 * Staleness is not consulted, and that is rule 2 in one line: a record confirmed
 * a year ago and never rechecked because the reader has been offline still says
 * yes. {@link proCheckDue} is what decides when to ask again, and it is a separate
 * question from what the reader may use right now.
 */
export function isPro(state: ProState): boolean {
  return state.entitled;
}

/**
 * Whether the stored licence should be validated again now.
 *
 * Pure, so the schedule is testable without a clock or a network. Four gates:
 *
 *  1. There has to be a key. Nothing to validate otherwise, and asking about an
 *     empty string is a request that can only fail.
 *  2. If an attempt has already been made, it has to be at least
 *     {@link PRO_RETRY_INTERVAL_MS} old. This is the retry bound, and it applies to
 *     a first activation too: a key entered while offline is retried on a schedule,
 *     not on every wake.
 *  3. A key that has never had a definite answer is due — this is rule 3.
 *     Activation is not subject to the grace period that protects a confirmed
 *     licence, so a fresh key is asked about at the first opportunity.
 *  4. Otherwise the last definite answer has to be at least
 *     {@link PRO_REVALIDATE_INTERVAL_MS} old, or the clock has to have moved
 *     backwards past it. The backwards case is due rather than ignored because the
 *     alternative — trusting a future-dated `checkedAt` — is an unlock that
 *     outlasts any interval.
 *
 * Both timestamps read **0 as never, not as the epoch.** Treating a zero
 * `attemptedAt` as an attempt made in 1970 is arithmetically the same thing for
 * any plausible `now`, but it is not the same thing at the boundary: it made gate 2
 * refuse a key entered on a device whose clock had not yet been set, so activation
 * silently waited six hours for a retry of an attempt that had never happened.
 */
export function proCheckDue(state: ProState, now: number): boolean {
  if (!Number.isFinite(now) || now < 0) return false;
  if (state.key === "") return false;

  const attempted = state.attemptedAt > 0;
  // `now < attemptedAt` means the clock moved back; that falls through to due,
  // for the same reason as gate 4.
  if (attempted && now >= state.attemptedAt && now - state.attemptedAt < PRO_RETRY_INTERVAL_MS) {
    return false;
  }

  if (state.checkedAt === 0) return true;
  return now - state.checkedAt >= PRO_REVALIDATE_INTERVAL_MS || now < state.checkedAt;
}

/**
 * What a validator concluded. The shape the network validator in step 7 must also
 * return, so swapping {@link validateLicenceKey} for it changes one function body
 * and nothing that calls it.
 *
 * `reason` is for the console and the settings UI, never for a decision: branching
 * on a provider's wording is how a provider change becomes a silent unlock.
 */
export type ProValidation =
  | { outcome: "active" }
  /**
   * `status` is the provider's HTTP status, and `code` its documented business-logic
   * identifier (`LICENSE_KEY_LIMIT_REACHED`, `INACTIVE_LICENSE_KEY`, …). Both are
   * absent when the refusal was decided locally from the key's shape.
   *
   * These exist so the settings UI can tell three refusals apart that a reader acts
   * on differently: re-read what you pasted, free up a device, or this key has been
   * revoked. Note the distinction from the rule above — an enumerated code is part
   * of the provider's contract, whereas its `message` is prose that can be reworded
   * in a release note. So this branches on `code` and never on `message`, and only
   * ever to choose a sentence: entitlement is decided by the 4xx alone, before any
   * of this is read. An unrecognised code degrades to the general refusal, which is
   * why a provider adding one cannot unlock anything.
   */
  | { outcome: "invalid"; reason: string; status?: number; code?: string }
  | { outcome: "unreachable"; reason: string };

/**
 * Fold a validation result into the stored record. Pure; the caller writes it.
 *
 * This is where rules 2 and 3 actually live:
 *
 * - `active` and `invalid` are definite answers, so both move `checkedAt` and set
 *   `entitled` outright. A rejection revokes — a refunded or charged-back key has
 *   to stop working, and no amount of previous entitlement changes that.
 * - `unreachable` moves `attemptedAt` alone. `entitled` and `checkedAt` are carried
 *   through untouched, so an entitled reader stays entitled for as long as the
 *   endpoint is unreachable, and an install that has never had an answer stays
 *   un-entitled. That asymmetry is the whole of rule 3, and it is the reason this
 *   is a reducer over the previous record rather than a mapping from an outcome to
 *   a state.
 */
export function applyValidation(state: ProState, result: ProValidation, now: number): ProState {
  const at = Number.isFinite(now) && now >= 0 ? Math.floor(now) : state.attemptedAt;
  switch (result.outcome) {
    case "active":
      return { ...state, entitled: true, status: "active", checkedAt: at, attemptedAt: at };
    case "invalid":
      return { ...state, entitled: false, status: "invalid", checkedAt: at, attemptedAt: at };
    case "unreachable":
      return { ...state, status: "unreachable", attemptedAt: at };
  }
}

/**
 * The provider's documented licence-key error codes, as far as this extension reads
 * them. Listed rather than matched loosely so that adding one is a decision.
 *
 * Anything not here — including a code the provider adds later — is the general
 * refusal. That default is the safe direction: the reader is told the key was not
 * accepted, which is true of every 4xx.
 */
const PROVIDER_REFUSAL_CODES = {
  /** Activations = limit. Not a problem with the key. */
  limitReached: "LICENSE_KEY_LIMIT_REACHED",
  /** Key status is not active: refunded, charged back, or revoked by hand. */
  inactive: "INACTIVE_LICENSE_KEY",
} as const;

/**
 * Choose the sentence for a check that did not confirm the key. Pure, so the
 * mapping can be read and tested without a network or a DOM.
 *
 * Only ever chooses words. Entitlement was already decided by
 * {@link applyValidation} before this is called, which is what makes reading a
 * provider-supplied field here safe.
 */
export function refusalMessage(
  result: ProValidation,
  copy: { invalid: string; limit: string; revoked: string; unreachable: string },
): string {
  // Not a refusal at all: the endpoint could not be reached, the reader keeps
  // everything they had, and saying "not accepted" here would be a lie that costs a
  // support email.
  if (result.outcome === "unreachable") return copy.unreachable;
  if (result.outcome === "active") return copy.invalid;
  switch (result.code) {
    case PROVIDER_REFUSAL_CODES.limitReached:
      return copy.limit;
    case PROVIDER_REFUSAL_CODES.inactive:
      return copy.revoked;
    default:
      return copy.invalid;
  }
}

// --- Talking to the payment provider ---------------------------------------
//
// Dodo Payments' three licence endpoints — activate, validate, deactivate — are
// all **public**: no API key, and documented as safe to call from client software.
// Measured, not assumed: a preflight from a `chrome-extension://` origin comes back
// 200 with the origin reflected in `Access-Control-Allow-Origin`, and the POST that
// follows answers `{"valid":false}` for a bogus key. Both test and live hosts.
//
// So the extension calls them directly and there is **no server on our side at
// all**. An earlier revision of this section went through a Vercel proxy of ours,
// on the build brief's premise that the endpoints needed `Bearer <API key>` and
// that shipping one inside an extension hands it to every user. The premise was
// wrong, and once it was checked the proxy had one benefit left — being able to
// change payment provider without an extension release — which is not worth a
// service to run, deploy, and keep alive.
//
// What that costs, stated plainly so nobody rediscovers it as a surprise: these
// URLs are baked into every install ever shipped. Moving off Dodo means a release,
// and installs that never update keep calling Dodo until they do.
//
// The permission set is unchanged and this update carries no new permission
// warning, because the CORS headers above mean no `host_permissions` entry is
// needed. Adding one would disable the extension for every existing user until
// they accepted it — a heavy price, and the reason the CORS behaviour was worth
// measuring before deciding.

/**
 * The provider's API host.
 *
 * **Test mode is the correct state during development, and this is where it is
 * spelled.** Working against live keys means buying the product to test it, which
 * is a real charge with real processor fees and a refund to file afterwards. So the
 * flip to `live` is a release step, not a development one: it belongs in the same
 * commit that bumps the version and cuts the zip, together with
 * {@link PRO_PURCHASE_URL}.
 *
 * One string rather than a mode flag with a lookup table, deliberately: a table
 * would put both hosts in every bundle, and then the packaging guard that refuses
 * to ship a test build would have nothing to look for.
 *
 * **A test host must never ship.** `scripts/package.mjs` searches the emitted
 * bundle and refuses to write a release zip while either test host appears in it.
 * That guard reads what the build actually produced rather than what the source
 * says, so it cannot be stale and it cannot be talked out of — it is the only thing
 * standing between a test-mode build and the store, and it is enough on its own.
 * This is the one mistake in the licence path with no symptom on the developer's own
 * machine: a test build validates test keys perfectly and rejects every real one, so
 * the first person to find out is a reader who paid and was told their key was not
 * accepted.
 *
 * What the unit suite checks is the *other* half of that: that this constant and the
 * checkout link are in the **same** mode. A mixed pair is the quietest form of the
 * bug and nothing else catches it — a live API host with a test checkout link sends
 * the reader to a page that takes a test card, charges nothing, and issues a key the
 * live host will never recognise, with no error anywhere.
 */
const DODO_API_BASE = "https://test.dodopayments.com";

/**
 * How long to wait for the provider.
 *
 * 10 s, which is longer than it sounds and deliberately so. Nothing is blocked on
 * it: the check runs in the service worker on a schedule, or behind an `Activate`
 * button that has already said it is checking. The cost of waiting is nothing; the
 * cost of giving up early is a reader on a slow connection being told their
 * licence could not be checked.
 */
export const PRO_VERIFY_TIMEOUT_MS = 10_000;

/**
 * The name this install registers its activation under.
 *
 * A fixed string, carrying **no device fingerprint of any kind** — no user agent,
 * no screen size, no generated id, nothing derived from the machine. Two installs
 * therefore look identical in the provider's dashboard, which is the point: an
 * extension whose pitch is that it collects nothing has no business inventing a
 * per-device identifier to make a licence page tidier.
 */
const DODO_INSTANCE_NAME = "Windowed Fullscreen (browser)";

/**
 * One POST to a Dodo licence endpoint.
 *
 * Returns the parsed body on a 2xx, or a `ProValidation` describing the failure —
 * which is always either a definite refusal or `unreachable`, never a guess. The
 * split is the whole of §14 rule 2, so it lives in one place rather than being
 * re-derived at each call site:
 *
 * - **4xx is a definite refusal.** The provider read the request and said no.
 * - **Anything else is `unreachable`**: a 5xx, a timeout, no network, a refused
 *   connection, a body that will not parse. An entitled reader keeps everything
 *   through all of it.
 */
async function dodoPost(
  path: string,
  body: Record<string, string>,
): Promise<{ ok: true; payload: unknown } | { ok: false; failure: ProValidation }> {
  // `AbortController` rather than a `Promise.race`: a race leaves the request
  // running, and this may be a service worker trying to go back to sleep.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRO_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`${DODO_API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // No cookies, and nothing that wants them. Stated rather than left to the
      // default so it cannot drift with the platform's.
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });

    if (response.status >= 400 && response.status < 500) {
      // The body is read for its `code` and nothing else. A refusal is already
      // decided by the status; this only picks which sentence the reader gets, so a
      // body that is missing, truncated, or not JSON degrades to the general one
      // rather than failing the request a second time.
      let code = "";
      try {
        const body: unknown = await response.json();
        if (body !== null && typeof body === "object") {
          const raw = (body as { code?: unknown }).code;
          if (typeof raw === "string") code = raw;
        }
      } catch {
        code = "";
      }
      return {
        ok: false,
        failure: {
          outcome: "invalid",
          reason: `provider refused with ${response.status}${code === "" ? "" : ` ${code}`}`,
          status: response.status,
          ...(code === "" ? {} : { code }),
        },
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        failure: { outcome: "unreachable", reason: `provider returned ${response.status}` },
      };
    }

    // Deactivate answers 200 with no body, so a parse failure is not automatically
    // a problem — the caller decides whether it needed a payload.
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, failure: { outcome: "unreachable", reason: describeError(err) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register this device against a key, and report whether the key was accepted.
 *
 * Called once, when the reader enters a key. The instance id it returns is what
 * binds the licence to this install: every later check sends it, so the provider's
 * activation limit is what decides how many devices one purchase covers, and
 * {@link deactivateLicence} is what gives an activation back.
 *
 * **A 4xx here covers two different situations and is deliberately not told
 * apart:** the key is wrong, or the key is real and has already been activated on
 * as many devices as it allows. The provider's wording is the only thing that
 * distinguishes them, and branching on a third party's error prose is how a
 * provider's copy edit becomes a silent unlock. One message names both things for
 * the reader to check, which is honest and needs no sniffing.
 *
 * The response body carries the buyer's **name and email**. Only `id` is read out
 * of it. Nothing else is stored, logged, or passed on — see the destructuring
 * below, which is written the way it is on purpose.
 */
export async function activateLicence(
  key: string,
): Promise<{ validation: ProValidation; instanceId: string }> {
  const normalized = normalizeLicenceKey(key);
  if (!licenceKeyLooksWellFormed(normalized)) {
    return {
      validation: { outcome: "invalid", reason: "not the shape of a licence key" },
      instanceId: "",
    };
  }

  const result = await dodoPost("/licenses/activate", {
    license_key: normalized,
    name: DODO_INSTANCE_NAME,
  });
  if (!result.ok) return { validation: result.failure, instanceId: "" };

  // `id` and nothing else. The rest of this payload is the customer record — name,
  // email, phone — and it is dropped here rather than anywhere later, so there is
  // no point in the code where it exists in a variable something could persist by
  // accident.
  const id = (result.payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id === "") {
    // Accepted, but we cannot tell which activation is ours. Treated as unreachable
    // rather than active: entitling an install whose activation we cannot later
    // deactivate would leak one of the reader's device slots permanently.
    return {
      validation: { outcome: "unreachable", reason: "activation returned no instance" },
      instanceId: "",
    };
  }
  return { validation: { outcome: "active" }, instanceId: id };
}

/**
 * Re-check a key that has already been activated.
 *
 * Three outcomes and no fourth, because the caller's fail-open behaviour turns on
 * the difference between them: `active`, a definite `invalid`, or `unreachable` for
 * everything else. Which is why the success path tests `valid === true` rather than
 * a truthy `valid` — a provider that starts answering `{"valid":"yes"}` has to fall
 * out as unreachable, not as an unlock.
 *
 * `instanceId` is sent when there is one, and omitted when there is not. It is
 * omitted for a record written before activation existed in this extension; such a
 * record keeps working, unbound, rather than being invalidated for a reason the
 * reader had no part in.
 */
export async function validateLicenceKey(key: string, instanceId = ""): Promise<ProValidation> {
  const normalized = normalizeLicenceKey(key);
  if (!licenceKeyLooksWellFormed(normalized)) {
    return { outcome: "invalid", reason: "not the shape of a licence key" };
  }

  const body: Record<string, string> = { license_key: normalized };
  if (instanceId !== "") body.license_key_instance_id = instanceId;

  const result = await dodoPost("/licenses/validate", body);
  if (!result.ok) return result.failure;

  const valid = (result.payload as { valid?: unknown } | null)?.valid;
  if (valid === true) return { outcome: "active" };
  if (valid === false) return { outcome: "invalid", reason: "the key was not recognised" };
  return { outcome: "unreachable", reason: "the provider answered in an unexpected shape" };
}

/**
 * Give this device's activation back, so the reader can use it somewhere else.
 *
 * Best effort, and the caller does not wait on the answer to decide anything: the
 * `Remove key` button's job is to take the licence off this device, and it has to
 * do that whether or not the provider can be reached. A failure here costs the
 * reader one activation slot until they contact support — annoying, and much less
 * annoying than a Remove button that refuses to work while they are offline.
 *
 * @returns whether the provider confirmed it.
 */
export async function deactivateLicence(key: string, instanceId: string): Promise<boolean> {
  const normalized = normalizeLicenceKey(key);
  if (!licenceKeyLooksWellFormed(normalized) || instanceId === "") return false;
  const result = await dodoPost("/licenses/deactivate", {
    license_key: normalized,
    license_key_instance_id: instanceId,
  });
  return result.ok;
}

/**
 * Read the entitlement record.
 *
 * @returns the effective record, plus whether storage failed to answer. The flag
 *   is what lets the settings UI distinguish "no licence entered" from "your
 *   licence cannot be read", which are the same record and very different
 *   messages. It is *not* a reason to deny features — see {@link isPro}: a failed
 *   read yields the default record, which is un-entitled, and rule 2 is served by
 *   never writing that default back over a good one.
 */
export async function getProState(): Promise<{ state: ProState; loadFailed: boolean }> {
  const area = storageArea();
  if (!area) return { state: { ...DEFAULT_PRO_STATE }, loadFailed: true };
  try {
    const stored = (await area.get(PRO_KEY))?.[PRO_KEY];
    // Nothing stored is an install that has not bought anything, not a failure.
    if (stored === undefined) return { state: { ...DEFAULT_PRO_STATE }, loadFailed: false };
    return { state: normalizeProState(stored), loadFailed: false };
  } catch {
    return { state: { ...DEFAULT_PRO_STATE }, loadFailed: true };
  }
}

/**
 * Persist the whole entitlement record in one write, like {@link setRatingState}.
 *
 * Normalised on the way out as well as in, so a caller cannot store a record the
 * coercion would refuse to read back — an `entitled` record with no key, most
 * of all.
 *
 * A rejection is reported rather than swallowed: this write is the only record of
 * a purchase on the device, and a reader who entered a valid key and was told
 * nothing went wrong has to actually be Pro on the next page they open.
 */
export async function setProState(
  next: ProState,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return writeKey(PRO_KEY, normalizeProState(next));
}

/**
 * Call `onChange` whenever the entitlement record is written from another surface,
 * so a live page unlocks the moment a key is accepted in the popup instead of on the
 * next reload. Returns a disposer, matching `watchSitePrefs`.
 *
 * A key can now also be accepted in the page itself, from the Pro prompt (§13). That
 * write goes through `setProState` like any other, so every watcher — the grips, the
 * lock badges, the popup's Pro view — follows it without knowing where it came from.
 */
export function watchProState(onChange: (state: ProState) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return () => {};
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !(PRO_KEY in changes)) return;
    onChange(normalizeProState(changes[PRO_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// --- The shop window: in-page prompt and messages --------------------------
//
// Which Pro surfaces are visible to a free reader is a product decision, and it
// is not symmetrical:
//
//  - The capture control **is shown** to everybody and opens the prompt below when
//    pressed. It is the only paid feature a reader who sets the extension up once
//    and never opens the settings again will ever meet, because it sits in the
//    control bar of every video they watch. A locked door that says what is behind
//    it converts; a hidden one does not exist.
//  - The drag grips and the per-channel rules are **not** rendered at all without
//    entitlement. Both are reachable only by someone already looking around, so
//    neither has a funnel to serve, and a grip that only shows a prompt when
//    dragged would be an affordance that lies about what it does.
//
// Nothing here is scoped to the mode: the capture control sits in the player bar
// whether windowed mode is on or off, so the prompt has to work either way.

/** How long a capture message stays on screen, in ms. */
const TOAST_DURATION_MS = 2_600;

/** Class on the in-page message element. */
const TOAST_CLASS = "wfs-toast";

/** Class on the Pro prompt's backdrop. */
const PRO_PROMPT_CLASS = "wfs-pro-prompt";

/**
 * Show a brief message over the video, replacing any message already showing.
 *
 * Returns a disposer so a session teardown can take the message with it: a
 * navigation mid-message would otherwise leave an absolute-positioned line of
 * text on a page the session no longer owns — the same class of leak the geometry
 * nudge had.
 */
export function showToast(doc: Document, text: string): () => void {
  for (const stale of Array.from(doc.querySelectorAll(`.${TOAST_CLASS}`))) stale.remove();

  const toast = doc.createElement("div");
  toast.className = TOAST_CLASS;
  // Announced, because the reader is watching the video rather than the corner of
  // it. `status` and not `alert`: a saved frame is not an interruption.
  toast.setAttribute("role", "status");
  toast.textContent = text;
  doc.body.appendChild(toast);

  const view = doc.defaultView ?? window;
  const timer = view.setTimeout(() => toast.remove(), TOAST_DURATION_MS);
  return () => {
    view.clearTimeout(timer);
    toast.remove();
  };
}

/**
 * Open the Pro prompt in the page. At most one at a time.
 *
 * The card is built with DOM calls rather than markup for the same reason
 * everything else here is: YouTube enforces Trusted Types, so an `innerHTML`
 * assignment is refused outright.
 *
 * `Get Pro` is a real anchor, so middle-click and "open in new tab" work and the
 * browser handles the navigation.
 *
 * `Already bought Pro?` takes the key HERE, in the prompt, rather than sending the
 * reader to the settings page. That was the earlier design and it was worse in two
 * ways: the settings page is an extension URL, so a content script cannot navigate
 * to one and the prompt had to ask the service worker to open a tab on its behalf;
 * and it answered someone who had already paid by closing the video they were
 * watching and putting a whole settings page in front of them. Activating in place
 * costs this function a licence field and an `activateLicence` call, and it means
 * the reader is back on their video with the feature unlocked without ever leaving
 * the page. The worker's `onMessage` listener went with it — see §1.
 *
 * @returns a disposer, so a teardown closes the prompt with the session.
 */
export function showProPrompt(
  doc: Document,
  options: { reason: "capture" | "other" },
): () => void {
  for (const stale of Array.from(doc.querySelectorAll(`.${PRO_PROMPT_CLASS}`))) stale.remove();

  const copy = HELP_COPY.pro;

  const backdrop = doc.createElement("div");
  backdrop.className = PRO_PROMPT_CLASS;

  const card = doc.createElement("div");
  card.className = "wfs-pro-prompt__card";
  // A dialog, and named by its own heading. Not `alertdialog`: nothing here is an
  // error and nothing is lost by ignoring it.
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");

  /**
   * Where the Escape listener goes, and it has to be the WINDOW, not the document.
   */
  const keyHost: EventTarget = doc.defaultView ?? doc;

  const close = (): void => {
    backdrop.remove();
    keyHost.removeEventListener("keydown", onKey, true);
  };

  /** Escape closes the prompt, and nothing else. */
  function onKey(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.key !== "Escape") return;
    key.preventDefault();
    key.stopPropagation();
    close();
  }
  keyHost.addEventListener("keydown", onKey, true);

  // Close button (X)
  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "wfs-pro-prompt__close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "\u2715";
  closeBtn.addEventListener("click", () => close());
  card.appendChild(closeBtn);

  // Badge
  const badge = doc.createElement("div");
  badge.className = "wfs-pro-prompt__badge";
  badge.textContent = "\u2728 PRO UPGRADE \u00B7 LIFETIME";
  card.appendChild(badge);

  // Title
  const title = doc.createElement("h2");
  title.className = "wfs-pro-prompt__title";
  title.textContent = options.reason === "capture" ? copy.captureTitle : copy.genericTitle;
  const titleId = "wfs-pro-prompt-title";
  title.id = titleId;
  card.setAttribute("aria-labelledby", titleId);
  card.appendChild(title);

  // Body / Subtitle
  const body = doc.createElement("p");
  body.className = "wfs-pro-prompt__body";
  body.textContent = copy.body;
  card.appendChild(body);

  // 2-Column Features Grid
  const grid = doc.createElement("div");
  grid.className = "wfs-pro-prompt__grid";

  const featureItems: Array<{ icon: string; title: string; desc: string }> = [
    { icon: "\uD83D\uDCF8", title: "Instant Screenshots", desc: "Save clean frames & timestamps" },
    { icon: "\u2194\uFE0F", title: "Resizable Panels", desc: "Custom widths for comments & chat" },
    { icon: "\uD83D\uDCA1", title: "Ambient Glow", desc: "Soft light synced to video colors" },
    { icon: "\uD83D\uDCDD", title: "Transcript Dock", desc: "Pinned searchable transcript" },
    { icon: "\u2B50", title: "Channel Memory", desc: "Auto-apply preferred layout" },
    { icon: "\uD83C\uDFA8", title: "Custom Themes", desc: "Custom bar colors & gradients" },
  ];

  for (const item of featureItems) {
    const gridItem = doc.createElement("div");
    gridItem.className = "wfs-pro-prompt__grid-item";

    const iconSpan = doc.createElement("span");
    iconSpan.className = "icon";
    iconSpan.textContent = item.icon;

    const textDiv = doc.createElement("div");
    const strong = doc.createElement("strong");
    strong.textContent = item.title;
    const descSpan = doc.createElement("span");
    descSpan.style.display = "block";
    descSpan.style.color = "#94a3b8";
    descSpan.style.fontSize = "10.5px";
    descSpan.textContent = item.desc;

    textDiv.appendChild(strong);
    textDiv.appendChild(descSpan);

    gridItem.appendChild(iconSpan);
    gridItem.appendChild(textDiv);
    grid.appendChild(gridItem);
  }
  card.appendChild(grid);

  // Trust Guarantee Bar
  const trust = doc.createElement("div");
  trust.className = "wfs-pro-prompt__trust";
  const trustItems = ["\uD83D\uDEE1\uFE0F 7-Day Guarantee", "\u26A1 Instant Delivery", "\uD83D\uDD12 Secure Checkout"];
  trustItems.forEach((text, idx) => {
    if (idx > 0) {
      const dot = doc.createElement("span");
      dot.textContent = "\u2022";
      dot.style.opacity = "0.5";
      trust.appendChild(dot);
    }
    const itemSpan = doc.createElement("span");
    itemSpan.textContent = text;
    trust.appendChild(itemSpan);
  });
  card.appendChild(trust);

  // Actions Container
  const actions = doc.createElement("div");
  actions.className = "wfs-pro-prompt__actions";

  // Primary Buy CTA (Direct Checkout)
  const buy = doc.createElement("a");
  buy.className = "wfs-pro-prompt__action is-primary";
  buy.href = PRO_PURCHASE_URL;
  buy.target = "_blank";
  buy.rel = "noopener noreferrer";
  buy.textContent = `\u26A1 ${copy.buy} \u2192`;
  buy.addEventListener("click", () => close());
  actions.appendChild(buy);

  // Secondary Learn More link pointing to website
  const learnMore = doc.createElement("a");
  learnMore.className = "wfs-pro-prompt__link-more";
  learnMore.href = PRO_LEARN_MORE_URL;
  learnMore.target = "_blank";
  learnMore.rel = "noopener noreferrer";
  learnMore.textContent = `\uD83C\uDF10 ${copy.learnMore} \u2192`;
  learnMore.addEventListener("click", () => close());
  actions.appendChild(learnMore);

  // Footer row for key activation disclosure and dismiss
  const footRow = doc.createElement("div");
  footRow.className = "wfs-pro-prompt__foot-row";

  const haveKey = doc.createElement("button");
  haveKey.type = "button";
  haveKey.className = "wfs-pro-prompt__foot-btn";
  haveKey.textContent = copy.haveKeyHeading;
  haveKey.addEventListener("click", () => {
    actions.replaceChildren();

    const form = doc.createElement("div");
    form.style.display = "flex";
    form.style.flexDirection = "column";
    form.style.gap = "8px";
    form.style.width = "100%";
    form.style.marginTop = "4px";

    const formHeader = doc.createElement("p");
    formHeader.style.margin = "0 0 4px";
    formHeader.style.fontSize = "12px";
    formHeader.style.fontWeight = "600";
    formHeader.style.color = "#ffffff";
    formHeader.textContent = copy.haveKeyHeading;
    form.appendChild(formHeader);

    const input = doc.createElement("input");
    input.type = "text";
    input.placeholder = copy.keyPlaceholder;
    input.maxLength = MAX_LICENCE_KEY_LENGTH;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.width = "100%";
    input.style.boxSizing = "border-box";
    input.style.minHeight = "36px";
    input.style.padding = "6px 10px";
    input.style.borderRadius = "8px";
    input.style.border = "1px solid rgba(255, 255, 255, 0.2)";
    input.style.background = "#12111c";
    input.style.color = "#ffffff";
    input.style.fontSize = "13px";
    input.style.fontFamily = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

    const btnRow = doc.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.justifyContent = "flex-end";

    const activateBtn = doc.createElement("button");
    activateBtn.type = "button";
    activateBtn.className = "wfs-pro-prompt__action is-primary";
    activateBtn.style.padding = "8px 16px";
    activateBtn.style.fontSize = "13px";
    activateBtn.textContent = copy.activate;

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "wfs-pro-prompt__action";
    cancelBtn.style.padding = "8px 14px";
    cancelBtn.style.fontSize = "13px";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => close());

    const statusMsg = doc.createElement("p");
    statusMsg.style.fontSize = "12px";
    statusMsg.style.margin = "0";
    statusMsg.style.color = "#ff5252";

    const doActivate = (): void => {
      const key = normalizeLicenceKey(input.value);
      if (!licenceKeyLooksWellFormed(key)) {
        statusMsg.textContent = copy.malformed;
        return;
      }
      activateBtn.disabled = true;
      activateBtn.textContent = copy.checking;
      statusMsg.textContent = "";

      void (async () => {
        const now = Date.now();
        const { validation: result, instanceId } = await activateLicence(key);
        const next = applyValidation(
          { ...DEFAULT_PRO_STATE, key, instanceId },
          result,
          now,
        );
        const written = await setProState(next);
        if (!written.ok) {
          statusMsg.textContent = `Could not save key: ${written.error}`;
          activateBtn.disabled = false;
          activateBtn.textContent = copy.activate;
          return;
        }
        if (result.outcome === "active") {
          title.textContent = "\u2728 Pro Unlocked!";
          body.textContent = "All Pro features are now active on this video.";
          if (grid.parentElement) grid.remove();
          if (trust.parentElement) trust.remove();
          actions.replaceChildren();
          const doneBtn = doc.createElement("button");
          doneBtn.type = "button";
          doneBtn.className = "wfs-pro-prompt__action is-primary";
          doneBtn.textContent = "Continue Watching";
          doneBtn.addEventListener("click", () => close());
          actions.appendChild(doneBtn);
        } else {
          activateBtn.disabled = false;
          activateBtn.textContent = copy.activate;
          statusMsg.textContent = refusalMessage(result, copy);
        }
      })();
    };

    activateBtn.addEventListener("click", doActivate);
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault();
        doActivate();
      }
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(activateBtn);
    form.appendChild(input);
    form.appendChild(statusMsg);
    form.appendChild(btnRow);
    actions.appendChild(form);
    input.focus();
  });

  const dismiss = doc.createElement("button");
  dismiss.type = "button";
  dismiss.className = "wfs-pro-prompt__foot-btn";
  dismiss.textContent = copy.dismiss;
  dismiss.addEventListener("click", () => close());

  footRow.appendChild(haveKey);
  footRow.appendChild(dismiss);
  actions.appendChild(footRow);

  card.appendChild(actions);
  backdrop.appendChild(card);

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });

  doc.body.appendChild(backdrop);
  buy.focus();

  return close;
}

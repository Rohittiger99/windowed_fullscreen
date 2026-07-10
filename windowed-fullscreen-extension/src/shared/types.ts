/**
 * Shared interfaces and types for the Windowed Fullscreen Extension.
 *
 * These types form the contracts between the Generic_Core, Site_Adapters,
 * the Preference Store, and the cross-surface messaging layer. They are kept
 * site-independent so the core never depends on site-specific knowledge
 * (Requirements 6.1, 6.2).
 */

// ---------------------------------------------------------------------------
// Adapter architecture
// ---------------------------------------------------------------------------

/**
 * The single contract between the Generic_Core and any site. The core uses
 * only what this interface exposes (Requirement 6.1).
 */
export interface SiteAdapter {
  /** e.g. "youtube" — used as the per-site preference key. */
  readonly siteId: string;
  /** Does this adapter handle the current site? */
  matches(url: string): boolean;

  /**
   * Does this URL belong to a site this adapter handles, regardless of whether
   * the specific page currently has a controllable video? This is a broader,
   * host-level check than {@link SiteAdapter.matches} (which only matches pages
   * where the mode can actually activate, e.g. a YouTube `/watch` page).
   *
   * Surfaces like the Popup use it to tell "this site is supported, just open a
   * video" apart from "this site is not supported at all". Optional; when not
   * provided, callers fall back to {@link SiteAdapter.matches}.
   */
  matchesSite?(url: string): boolean;

  // Locate the controls container and the native fullscreen button.
  // Returns null when not yet present (caller retries within detection window).
  findControlsContainer(doc: Document): Element | null;
  findNativeFullscreenButton(doc: Document): Element | null;

  /** Locate the player element to expand. */
  findPlayer(doc: Document): Element | null;

  /** CSS selectors / element resolvers for Site_Chrome to hide. May be empty. */
  getSiteChromeSelectors(): string[];

  /**
   * Optional CSS classes to add to the player element while the mode is active,
   * removed on exit. Lets a site opt into its own "large player" styling (e.g.
   * YouTube's `ytp-big-mode`, which enlarges the control bar) without the core
   * knowing any site-specific class names.
   */
  getActivePlayerClasses?(): string[];

  /**
   * Optional hook to detect SPA video changes (e.g. URL/videoId change).
   * Returns a disposer. Default no-op.
   */
  onVideoChange?(doc: Document, cb: () => void): () => void;
}

/**
 * What the adapter ultimately resolves to at a given moment. If the adapter
 * cannot supply player + native control + chrome selectors, the core refuses
 * to enter the mode (Requirement 6.2).
 */
export interface SiteDescriptor {
  player: Element;
  nativeFullscreenButton: Element;
  controlsContainer: Element;
  /** Resolved from selectors; may be empty (Req 2.9). */
  siteChromeElements: Element[];
  /** Selectors that matched nothing (Req 7.3). */
  missingChromeSelectors: string[];
  /** CSS classes to add to the player while active (adapter-supplied; optional). */
  activePlayerClasses?: string[];
}

/**
 * Holds an ordered list of registered Site_Adapters. Selects the first adapter
 * whose `matches(url)` returns true (Requirement 6.4), or `null` when none
 * match (Requirement 6.6).
 */
export interface AdapterRegistry {
  register(adapter: SiteAdapter): void;
  /** Returns the first matching adapter by registration order, or null. */
  resolve(url: string): SiteAdapter | null;
  /**
   * Like {@link AdapterRegistry.resolve}, but uses each adapter's broader
   * host-level {@link SiteAdapter.matchesSite} check (falling back to
   * `matches`). Returns the first adapter that handles the URL's site even when
   * the specific page has no controllable video, or null when none do.
   */
  resolveSite(url: string): SiteAdapter | null;
}

// ---------------------------------------------------------------------------
// Generic_Core / WindowedFullscreen Controller
// ---------------------------------------------------------------------------

/**
 * Site-independent engine that drives the mode using only a `SiteDescriptor`.
 */
export interface WindowedFullscreenController {
  readonly isActive: boolean;
  /** Capture -> mutate. */
  enter(descriptor: SiteDescriptor): EnterResult;
  /** Restore from snapshot. */
  exit(): void;
  toggle(resolve: () => SiteDescriptor | null): void;
}

export type EnterResult =
  | { ok: true }
  | { ok: false; reason: "incomplete-descriptor" | "already-active" };

// ---------------------------------------------------------------------------
// Layout snapshot (restore record captured on entry)
// ---------------------------------------------------------------------------

export interface ElementStyleSnapshot {
  // The element's own inline style property values prior to mutation,
  // so restoration reproduces the exact pre-entry inline state (including "not set").
  properties: Record<string, string | null>;
}

export interface LayoutSnapshot {
  player: ElementStyleSnapshot;
  chrome: Array<{ selector: string; element: Element; style: ElementStyleSnapshot }>;
  documentElementHadWindowedClass: boolean;
  capturedAt: number;
}

// ---------------------------------------------------------------------------
// Shortcut validation model
// ---------------------------------------------------------------------------

/**
 * A combination is valid iff `modifiers.length >= 1` and `key` is exactly one
 * non-modifier key (Requirement 3.2).
 */
export interface ShortcutCombination {
  /** e.g. ["Ctrl","Shift"] — at least one. */
  modifiers: string[];
  /** Exactly one non-modifier key. */
  key: string;
}

// ---------------------------------------------------------------------------
// Preferences / data models
// ---------------------------------------------------------------------------

export interface GlobalPrefs {
  /** For migrations. */
  schemaVersion: number;
  // Reserved spare action slot is browser-managed; no value stored here.
}

/** Per Supported_Site. */
export interface SitePrefs {
  /** Matches SiteAdapter.siteId. */
  siteId: string;
  /** Req 4.5 / 5.1. */
  autoApply: boolean;
}

/** Documented defaults applied when no stored value exists (Requirement 4.7). */
export const DEFAULT_SITE_PREFS: Omit<SitePrefs, "siteId"> = {
  autoApply: false,
};

export type WriteResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Cross-surface messaging (service worker <-> content script)
// ---------------------------------------------------------------------------

export type ExtMessage =
  | { type: "TOGGLE" }
  | { type: "GET_STATUS" }
  | { type: "PREF_READ"; scope: "global" | "site"; siteId?: string }
  | { type: "PREF_WRITE"; scope: "global" | "site"; siteId?: string; value: object };

export type ExtResponse =
  | { ok: true; active?: boolean; data?: unknown }
  | { ok: false; error: string };

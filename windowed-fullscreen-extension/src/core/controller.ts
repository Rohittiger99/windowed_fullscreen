/**
 * Generic_Core / WindowedFullscreen Controller.
 *
 * Site-independent engine that drives Windowed_Fullscreen_Mode using only a
 * {@link SiteDescriptor} supplied by the active Site_Adapter (Requirement 6.1).
 * It never references site-specific selectors and never calls the browser
 * Fullscreen API (Requirement 2.4).
 *
 * Lifecycle:
 * - `enter(descriptor)` captures a {@link LayoutSnapshot} *before* any mutation
 *   so the page can always be restored exactly (Requirement 2.6/2.8), then
 *   expands the player to fill the viewport (Requirement 2.2) and hides located
 *   Site_Chrome (Requirement 2.3), tolerating/logging absent ones (Req 7.3).
 * - `exit()` restores every mutated element from the snapshot (Requirement 2.6).
 * - `toggle(resolve)` flips between the two using a freshly resolved descriptor.
 *
 * Entry is refused — leaving the page untouched — when the descriptor is
 * incomplete (Requirement 6.2) or the mode is already active.
 */

import type {
  EnterResult,
  LayoutSnapshot,
  SiteDescriptor,
  WindowedFullscreenController,
} from "../shared/types";
import { createLogger, type Logger } from "../shared/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Class applied to `documentElement` while active (hides scrollbar, stacking). */
export const WINDOWED_CLASS = "wfs-windowed";

/** Attribute marking the injected Windowed_Fullscreen_Button. */
export const BUTTON_MARKER_ATTR = "data-wfs-button";

/** Class toggled on the button to reflect the engaged state (Requirement 2.10). */
export const BUTTON_ACTIVE_CLASS = "is-active";

/** Highest practical stacking value so the expanded player sits above chrome. */
const MAX_Z_INDEX = "2147483647";

/**
 * Delays (ms) at which a synthetic `resize` is dispatched after the player size
 * changes (entry/exit). Sites like YouTube size their control bar / progress
 * scrubber in JS off the player width and only recompute on a window resize;
 * without this nudge the scrubber can stay stuck at the player's pre-toggle
 * (e.g. half) width while the rest of the controls fill the bar. The player is
 * resized synchronously (inline styles), so `0` covers the common case; the
 * later ticks cover the site's debounced/asynchronous layout settling, which is
 * the source of the intermittent "sometimes half, sometimes full" behavior.
 */
const REFLOW_NUDGE_DELAYS_MS = [0, 60, 250, 600] as const;

/**
 * The inline player style properties the controller mutates on entry. Captured
 * (in kebab-case so `getPropertyValue`/`setProperty` agree) before mutation so
 * `exit()` reproduces the exact pre-entry inline state, including "not set".
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

/** The viewport-filling player style applied on entry (Requirement 2.2). */
const PLAYER_ACTIVE_STYLE: Record<string, string> = {
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
};

/** Inline style properties mutated on each Site_Chrome element when hiding it. */
const CHROME_STYLE_PROPS = ["display", "visibility"] as const;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The minimal surface of a `MutationObserver` the player-loss watcher relies
 * on. Modeling just `observe`/`disconnect` keeps the watcher injectable so
 * tests can drive mutations deterministically without the real (async)
 * observer (Requirement 7.6).
 */
export interface MutationObserverLike {
  observe(target: Node, options?: MutationObserverInit): void;
  disconnect(): void;
}

/** Factory producing a {@link MutationObserverLike} bound to a callback. */
export type MutationObserverFactory = (
  callback: MutationCallback,
) => MutationObserverLike;

export interface WindowedFullscreenControllerOptions {
  /** Document to operate on. Defaults to the ambient `document` (injectable for tests). */
  document?: Document;
  /** Diagnostic logger. Defaults to a content-surface logger. */
  logger?: Logger;
  /** Optional button element (carrying `data-wfs-button`) whose state to drive. */
  button?: Element | null;
  /**
   * Factory for the player-loss watcher's observer. Defaults to the ambient
   * `MutationObserver`. Injectable so tests can drive mutations synchronously.
   */
  createObserver?: MutationObserverFactory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read an element's inline value for `prop`, returning `null` when the property
 * is not set inline. This lets the snapshot distinguish "not set" from any set
 * value so restoration is exact (Requirement 2.6/2.8).
 */
function readInlineProperty(el: Element, prop: string): string | null {
  const value = (el as HTMLElement).style.getPropertyValue(prop);
  return value === "" ? null : value;
}

/** Capture the inline values of `props` for `el` into an ElementStyleSnapshot. */
function captureStyle(el: Element, props: readonly string[]) {
  const properties: Record<string, string | null> = {};
  for (const prop of props) {
    properties[prop] = readInlineProperty(el, prop);
  }
  return { properties };
}

/** Restore an element's inline style from a previously captured property map. */
function restoreStyle(el: Element, properties: Record<string, string | null>): void {
  const style = (el as HTMLElement).style;
  for (const [prop, value] of Object.entries(properties)) {
    if (value === null) {
      style.removeProperty(prop);
    } else {
      style.setProperty(prop, value);
    }
  }
}

/**
 * Determine whether a descriptor supplies everything the core needs: a player
 * reference, a native control reference, and the Site_Chrome selector set
 * (resolved + missing arrays, which may both be empty). Anything missing means
 * the core refuses entry and preserves page state (Requirement 6.2).
 */
function isCompleteDescriptor(d: SiteDescriptor | null | undefined): d is SiteDescriptor {
  return (
    !!d &&
    !!d.player &&
    !!d.nativeFullscreenButton &&
    Array.isArray(d.siteChromeElements) &&
    Array.isArray(d.missingChromeSelectors)
  );
}

/**
 * Resolve the ambient `MutationObserver` constructor for `doc`, preferring the
 * document's own view (so cross-realm jsdom documents work) and falling back to
 * the global. Returns `null` when no observer is available, in which case the
 * player-loss watcher silently does nothing.
 */
function defaultObserverFactory(doc: Document): MutationObserverFactory | null {
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const Ctor =
    view?.MutationObserver ??
    (typeof MutationObserver !== "undefined" ? MutationObserver : undefined);
  if (!Ctor) {
    return null;
  }
  return (callback: MutationCallback): MutationObserverLike => new Ctor(callback);
}

/**
 * Whether `el` is still attached to a rendered document. Prefers the standard
 * `isConnected` and falls back to `ownerDocument.contains` for environments
 * where `isConnected` is unavailable.
 */
function isElementConnected(el: Element): boolean {
  if (typeof el.isConnected === "boolean") {
    return el.isConnected;
  }
  const owner = el.ownerDocument;
  return owner ? owner.contains(el) : false;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Default implementation of {@link WindowedFullscreenController}.
 *
 * Holds no site-specific knowledge: all DOM references arrive via the
 * descriptor. State (the active descriptor and snapshot) is retained while
 * active so the player-loss watcher can drive `exit()` and restore chrome from
 * the snapshot (Requirement 7.6).
 */
export class WindowedFullscreenControllerImpl
  implements WindowedFullscreenController
{
  private readonly doc: Document;
  private readonly logger: Logger;
  private button: Element | null;
  private readonly observerFactory: MutationObserverFactory | null;

  private active = false;
  /** The descriptor used for the current active session, or null when inactive. */
  private descriptor: SiteDescriptor | null = null;
  /** The restore record captured before mutation, or null when inactive. */
  private snapshot: LayoutSnapshot | null = null;
  /** Bound Escape listener while active, so it can be deregistered on exit. */
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Active player-loss watcher while active, so it can be torn down on exit. */
  private playerWatcher: MutationObserverLike | null = null;
  /** Adapter-supplied classes we added to the player on enter (to remove on exit). */
  private addedPlayerClasses: string[] = [];
  /** Pending reflow-nudge timer ids (cleared on exit / re-scheduled on toggle). */
  private reflowTimers: unknown[] = [];

  constructor(options: WindowedFullscreenControllerOptions = {}) {
    this.doc =
      options.document ??
      (typeof document !== "undefined" ? document : (undefined as unknown as Document));
    this.logger = options.logger ?? createLogger("content");
    this.button = options.button ?? null;
    this.observerFactory =
      options.createObserver ?? defaultObserverFactory(this.doc);
  }

  /** Whether Windowed_Fullscreen_Mode is currently active. */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Associate (or clear) the Windowed_Fullscreen_Button whose engaged/inactive
   * state the controller drives (Requirement 2.10). The button is typically
   * injected after construction, so it can be set later. Setting it immediately
   * reflects the current mode state.
   */
  setButton(button: Element | null): void {
    this.button = button;
    this.applyButtonState(this.active);
  }

  /**
   * Enter Windowed_Fullscreen_Mode: capture a snapshot, then expand the player
   * and hide located chrome. Refuses incomplete descriptors and re-entry,
   * leaving the page untouched in both cases.
   */
  enter(descriptor: SiteDescriptor): EnterResult {
    if (this.active) {
      return { ok: false, reason: "already-active" };
    }
    if (!isCompleteDescriptor(descriptor)) {
      // Refuse entry and preserve the pre-activation page state (Requirement 6.2).
      return { ok: false, reason: "incomplete-descriptor" };
    }

    const docEl = this.doc.documentElement;

    // 1. Capture the restore record BEFORE mutating anything (Req 2.8).
    const snapshot: LayoutSnapshot = {
      player: captureStyle(descriptor.player, PLAYER_STYLE_PROPS),
      chrome: descriptor.siteChromeElements.map((element, i) => ({
        // siteChromeElements are already resolved; a stable index keeps the
        // selector association without depending on site-specific knowledge.
        selector: `chrome[${i}]`,
        element,
        style: captureStyle(element, CHROME_STYLE_PROPS),
      })),
      documentElementHadWindowedClass: docEl.classList.contains(WINDOWED_CLASS),
      capturedAt: Date.now(),
    };

    // 2. Log every selector that resolved to nothing, then continue (Req 7.3).
    for (const selector of descriptor.missingChromeSelectors) {
      this.logger.absentChrome(
        "Site_Chrome selector resolved to no element on entry",
        { selector },
      );
    }

    // 3. Apply the windowed class to documentElement.
    docEl.classList.add(WINDOWED_CLASS);

    // 4. Expand the player to fill the viewport (Req 2.2). Never the Fullscreen API (Req 2.4).
    const playerStyle = (descriptor.player as HTMLElement).style;
    for (const [prop, value] of Object.entries(PLAYER_ACTIVE_STYLE)) {
      playerStyle.setProperty(prop, value);
    }

    // 5. Hide each resolved Site_Chrome element (Req 2.3, 2.9 when empty).
    for (const element of descriptor.siteChromeElements) {
      const style = (element as HTMLElement).style;
      style.setProperty("display", "none");
      style.setProperty("visibility", "hidden");
    }

    // 5b. Add adapter-supplied active-mode classes to the player (a site may use
    //     these to opt into its own large-player styling that enlarges the
    //     control bar). Track only the classes we actually add so exit removes
    //     exactly those without clobbering any the site set itself.
    this.addedPlayerClasses = [];
    for (const cls of descriptor.activePlayerClasses ?? []) {
      if (cls && !descriptor.player.classList.contains(cls)) {
        descriptor.player.classList.add(cls);
        this.addedPlayerClasses.push(cls);
      }
    }

    // 6. Mark active, drive the button, and register Escape handling.
    this.descriptor = descriptor;
    this.snapshot = snapshot;
    this.active = true;
    this.applyButtonState(true);
    this.registerEscape();
    this.startPlayerWatcher(descriptor.player);

    // 7. Nudge the site to recompute its control-bar / scrubber geometry now
    //    that the player fills the viewport (fixes the half-width scrubber).
    this.scheduleReflowNudge();

    return { ok: true };
  }

  /**
   * Exit Windowed_Fullscreen_Mode, restoring the player and every Site_Chrome
   * element to the captured pre-entry inline state (Requirement 2.6). Safe to
   * call when inactive (no-op).
   */
  exit(): void {
    if (!this.active) {
      return;
    }

    const snapshot = this.snapshot;
    if (snapshot && this.descriptor) {
      // Remove only the active-mode classes we added on entry (Req: restore to
      // pre-entry state without clobbering site-managed classes).
      for (const cls of this.addedPlayerClasses) {
        this.descriptor.player.classList.remove(cls);
      }

      // 1. Restore the player's inline styles exactly.
      restoreStyle(this.descriptor.player, snapshot.player.properties);

      // Restore each Site_Chrome element's visibility.
      for (const entry of snapshot.chrome) {
        restoreStyle(entry.element, entry.style.properties);
      }

      // 2. Remove the windowed class unless it pre-existed entry.
      if (!snapshot.documentElementHadWindowedClass) {
        this.doc.documentElement.classList.remove(WINDOWED_CLASS);
      }
    }

    // 2b. Deregister the Escape listener and tear down the player-loss watcher.
    this.unregisterEscape();
    this.stopPlayerWatcher();

    // 3. Mark inactive and drive the button to its inactive state.
    this.active = false;
    this.descriptor = null;
    this.snapshot = null;
    this.addedPlayerClasses = [];
    this.applyButtonState(false);

    // 4. Nudge the site to recompute its control-bar geometry for the restored
    //    (smaller) player size, mirroring the entry nudge.
    this.scheduleReflowNudge();
  }

  /**
   * Toggle the mode. When active, exit. When inactive, resolve a fresh
   * descriptor and enter; a `null` resolution (no adapter/descriptor available)
   * leaves the page unchanged.
   */
  toggle(resolve: () => SiteDescriptor | null): void {
    if (this.active) {
      this.exit();
      return;
    }
    const descriptor = resolve();
    if (descriptor === null) {
      return;
    }
    this.enter(descriptor);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Reflect mode state on the associated button (Requirement 2.10). */
  private applyButtonState(engaged: boolean): void {
    if (!this.button) {
      return;
    }
    this.button.setAttribute("aria-pressed", engaged ? "true" : "false");
    if (engaged) {
      this.button.classList.add(BUTTON_ACTIVE_CLASS);
    } else {
      this.button.classList.remove(BUTTON_ACTIVE_CLASS);
    }
  }

  /** Register a capturing keydown listener that exits on Escape (Requirement 2.7). */
  private registerEscape(): void {
    if (this.escapeHandler) {
      return;
    }
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && this.active) {
        this.exit();
      }
    };
    this.escapeHandler = handler;
    this.doc.addEventListener("keydown", handler as EventListener, true);
  }

  /** Remove the Escape listener registered on entry. */
  private unregisterEscape(): void {
    if (!this.escapeHandler) {
      return;
    }
    this.doc.removeEventListener("keydown", this.escapeHandler as EventListener, true);
    this.escapeHandler = null;
  }

  /**
   * Begin watching for removal of the active player element from the DOM
   * (Requirement 7.6). Observes the player's owning document subtree; on any
   * mutation that leaves the player disconnected, it logs the loss and exits.
   * Does nothing when no observer is available.
   */
  private startPlayerWatcher(player: Element): void {
    if (this.playerWatcher || !this.observerFactory) {
      return;
    }
    // Observe the player's parent for direct child removal rather than the whole
    // document subtree. Watching `documentElement` with `subtree: true` fires the
    // callback on every DOM change the page makes during playback (a major source
    // of jank on busy sites like YouTube). The player is detached by removing it
    // from its parent, so a `childList` observer on that parent catches the loss
    // cheaply. Falls back to the document element (still childList-only) when the
    // player has no parent yet.
    const ownerDoc = player.ownerDocument ?? this.doc;
    const root = player.parentNode ?? ownerDoc.documentElement;
    if (!root) {
      return;
    }
    const observer = this.observerFactory(() => {
      // Only react while active and once the player has actually detached, so
      // unrelated mutations are ignored.
      if (this.active && !isElementConnected(player)) {
        this.handlePlayerLost();
      }
    });
    observer.observe(root, { childList: true, subtree: false });
    this.playerWatcher = observer;
  }

  /** Disconnect and clear the player-loss watcher. Safe to call when unset. */
  private stopPlayerWatcher(): void {
    if (!this.playerWatcher) {
      return;
    }
    this.playerWatcher.disconnect();
    this.playerWatcher = null;
  }

  /**
   * Dispatch a sequence of synthetic `resize` events on the document's view so
   * the site recomputes any layout it derives from the player size in JS — most
   * notably YouTube's bottom control bar and progress scrubber, which otherwise
   * remain sized to the player's pre-toggle width (the intermittent half-width
   * scrubber). Best-effort and fully guarded: a missing view, missing timers,
   * or a dispatch error never affects the mode state. Pending ticks are tracked
   * so a subsequent toggle clears them before scheduling its own.
   */
  private scheduleReflowNudge(): void {
    const view = this.doc.defaultView as (Window & typeof globalThis) | null;
    if (!view || typeof view.dispatchEvent !== "function") {
      return;
    }
    this.clearReflowTimers();

    const fire = (): void => {
      try {
        const EventCtor = view.Event ?? (typeof Event !== "undefined" ? Event : undefined);
        if (EventCtor) {
          view.dispatchEvent(new EventCtor("resize"));
        }
      } catch {
        // Best-effort relayout hint; never throw out of enter/exit.
      }
    };

    for (const delay of REFLOW_NUDGE_DELAYS_MS) {
      if (delay === 0) {
        fire();
        continue;
      }
      if (typeof view.setTimeout === "function") {
        this.reflowTimers.push(view.setTimeout(fire, delay));
      }
    }
  }

  /** Cancel any pending reflow-nudge ticks. Safe to call when none are pending. */
  private clearReflowTimers(): void {
    const view = this.doc.defaultView as (Window & typeof globalThis) | null;
    if (view && typeof view.clearTimeout === "function") {
      for (const id of this.reflowTimers) {
        view.clearTimeout(id as number);
      }
    }
    this.reflowTimers = [];
  }

  /**
   * Handle loss of the active player: record the diagnostic (Requirement 7.6)
   * then exit, which restores chrome from the snapshot and fully tears down the
   * watcher (preventing a double-exit since `exit()` clears the active flag).
   */
  private handlePlayerLost(): void {
    this.logger.playerLost("Active player element was removed from the DOM");
    this.exit();
  }
}

/**
 * Create a {@link WindowedFullscreenController} with optional dependency
 * injection (document, logger, button) for testability in jsdom.
 */
export function createController(
  options?: WindowedFullscreenControllerOptions,
): WindowedFullscreenControllerImpl {
  return new WindowedFullscreenControllerImpl(options);
}

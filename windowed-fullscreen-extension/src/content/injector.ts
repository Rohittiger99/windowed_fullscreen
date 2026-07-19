/**
 * Button Injector + MutationObserver.
 *
 * Responsible for rendering exactly one Windowed_Fullscreen_Button adjacent to
 * the active Site_Adapter's native fullscreen control and keeping it present
 * across SPA video changes (Requirement 1). It holds no site-specific
 * knowledge: the controls container and native control are resolved through the
 * {@link SiteAdapter} contract only.
 *
 * Behavior (this module — task 7.1):
 * - `start()` performs an initial injection attempt and begins observing the
 *   player/controls subtree plus the adapter's `onVideoChange` hook.
 * - `ensureButton()` is idempotent: it inserts exactly one marked button
 *   (`data-wfs-button`) immediately after the native control (Req 1.1), gives it
 *   an accessible name distinct from the native control (Req 1.3), leaves the
 *   native control untouched (Req 1.2), and never duplicates — if a marked
 *   button already exists it keeps exactly one (Req 1.4).
 * - The button carries `aria-pressed` and supports the `is-active` class so the
 *   Generic_Core can reflect engaged/inactive state (Req 2.10); the injector
 *   sets the initial inactive state on creation and never clobbers state it does
 *   not own.
 * - Re-verification fires on the adapter's `onVideoChange` (Req 1.5) and on
 *   relevant DOM mutations (debounced).
 * - `stop()` disconnects the observer, disposes the video-change hook, and
 *   removes the injected button.
 *
 * Bounded detection / re-render loops (task 7.2 — Requirements 1.6, 7.1, 7.2,
 * 7.4, 7.5) are layered on top of those seams without changing the core
 * injection semantics of `ensureButton()`:
 * - **Initial detection** (Req 1.6/7.1/7.2): `start()` drives `ensureButton()`
 *   on a bounded retry loop — at intervals ≤2s, for at most 10 attempts. If the
 *   player/native control never appear within the ≤10s detection window the
 *   loop stops and logs `player-not-found` (7.1) or `native-control-not-found`
 *   (7.2) depending on which the adapter still cannot resolve, leaving the page
 *   unchanged.
 * - **Re-render after removal while inactive** (Req 7.4/7.5): when the observer
 *   detects the owned button was removed by the page while the mode is
 *   inactive, a bounded loop re-renders within 2s of the controls reappearing,
 *   for at most 5 attempts; if the controls do not reappear within 30s the loop
 *   abandons and logs `re-render-abandoned` (7.5).
 *
 * Both loops drive injectable timers (`setTimeout`/`clearTimeout`) and an
 * injectable `isActive` predicate, so tests can exercise them deterministically
 * with fake timers, and expose their attempt counters for observation.
 */

import type { SiteAdapter } from "../shared/types";
import { createLogger, type Logger } from "../shared/logger";
import {
  BUTTON_ACTIVE_CLASS,
  BUTTON_MARKER_ATTR,
  type MutationObserverFactory,
  type MutationObserverLike,
} from "../core/controller";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Accessible name assigned to the injected Windowed_Fullscreen_Button (Req 1.3). */
export const BUTTON_LABEL = "Windowed fullscreen";

/**
 * Fallback accessible name used in the unlikely event the native control's
 * accessible name already equals {@link BUTTON_LABEL}, so the injected control's
 * name stays distinct from the native one (Requirement 1.3).
 */
export const BUTTON_LABEL_FALLBACK = "Windowed fullscreen (extension)";

/** Generic class on the injected button (no site-specific classes are used). */
export const BUTTON_CLASS = "wfs-button";

/** Default debounce window (ms) applied to mutation-driven re-verification. */
export const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Default interval (ms) between initial detection attempts. Kept ≤2s
 * (Requirement 1.6) and small enough that {@link DEFAULT_MAX_DETECTION_ATTEMPTS}
 * attempts fit inside the ≤10s detection window (Requirements 7.1/7.2).
 */
export const DEFAULT_DETECTION_INTERVAL_MS = 1000;

/** Default maximum number of initial detection attempts (Requirement 1.6). */
export const DEFAULT_MAX_DETECTION_ATTEMPTS = 10;

/**
 * Default poll interval (ms) for the re-render-after-removal loop. Kept ≤2s so
 * the button is re-rendered within 2s of the controls reappearing (Req 7.4).
 */
export const DEFAULT_RE_RENDER_INTERVAL_MS = 2000;

/** Default maximum number of re-render attempts after removal (Requirement 7.4). */
export const DEFAULT_MAX_RE_RENDER_ATTEMPTS = 5;

/**
 * Default window (ms) the re-render loop waits for the controls to reappear
 * before abandoning and logging `re-render-abandoned` (Requirement 7.5).
 */
export const DEFAULT_RE_RENDER_TIMEOUT_MS = 30_000;

/**
 * Outcome of an {@link ButtonInjector.ensureButton} call. Exposed so the bounded
 * detection/re-render layer (task 7.2) can decide whether to keep retrying.
 *
 * - `injected`: a new button was created and inserted.
 * - `present`: a marked button already existed; it was kept (and de-duplicated /
 *   repositioned as needed).
 * - `skipped-no-target`: the controls container or native control was not found,
 *   so nothing was rendered and the page was left unchanged (Requirement 6.6).
 */
export type EnsureButtonResult = "injected" | "present" | "skipped-no-target";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The injector contract consumed by the content-script bootstrap (task 12.1). */
export interface ButtonInjector {
  /** Begin observing and attempt the initial injection. */
  start(): void;
  /** Disconnect the observer, dispose hooks, and remove the injected button. */
  stop(): void;
  /**
   * Idempotently ensure exactly one correctly placed, correctly labelled
   * Windowed_Fullscreen_Button exists. Safe to call any number of times.
   */
  ensureButton(): EnsureButtonResult;
  /** The currently injected button, or `null` when none is present. */
  readonly button: Element | null;
}

export interface ButtonInjectorOptions {
  /** The active Site_Adapter resolving the controls container + native control. */
  adapter: SiteAdapter;
  /** Document to operate on. Defaults to the ambient `document` (injectable for tests). */
  document?: Document;
  /** Diagnostic logger. Defaults to a content-surface logger. */
  logger?: Logger;
  /**
   * Invoked when the injected button is activated. The bootstrap (task 12.1)
   * wires this to the Generic_Core `toggle`.
   */
  onToggle?: () => void;
  /**
   * Invoked whenever the injected button element changes (created, adopted, or
   * removed). The bootstrap can use this to (re)associate the button with the
   * controller so state reflection stays correct across SPA re-renders.
   */
  onButtonChange?: (button: Element | null) => void;
  /**
   * Factory for the MutationObserver watching the player/controls subtree.
   * Defaults to the ambient `MutationObserver`. Injectable so tests can drive
   * mutations synchronously.
   */
  createObserver?: MutationObserverFactory;
  /**
   * Scheduler used to debounce mutation-driven re-verification. Receives the
   * `ensureButton` runner. Defaults to a `setTimeout`-based debounce. Tests may
   * pass a synchronous scheduler (`(run) => run()`) or call `ensureButton()`
   * directly. This is also a seam for task 7.2's bounded loops.
   */
  scheduleEnsure?: (run: () => void) => void;
  /** Debounce window (ms) for the default scheduler. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
  /**
   * Predicate reporting whether Windowed_Fullscreen_Mode is currently active.
   * The bounded re-render loop (Req 7.4) only runs while the mode is INACTIVE,
   * so the bootstrap (task 12.1) wires this to the controller's `isActive`.
   * Defaults to a predicate that always reports inactive.
   */
  isActive?: () => boolean;
  /**
   * Timer used to schedule the bounded detection and re-render loops. Defaults
   * to the document view's `setTimeout` (falling back to the global). Injectable
   * so tests can drive the loops deterministically with fake timers.
   */
  setTimeout?: (handler: () => void, ms: number) => unknown;
  /** Companion to {@link ButtonInjectorOptions.setTimeout} for cancelling pending ticks. */
  clearTimeout?: (id: unknown) => void;
  /** Interval (ms) between initial detection attempts. Defaults to {@link DEFAULT_DETECTION_INTERVAL_MS}. */
  detectionIntervalMs?: number;
  /** Maximum initial detection attempts. Defaults to {@link DEFAULT_MAX_DETECTION_ATTEMPTS}. */
  maxDetectionAttempts?: number;
  /** Poll interval (ms) for the re-render-after-removal loop. Defaults to {@link DEFAULT_RE_RENDER_INTERVAL_MS}. */
  reRenderIntervalMs?: number;
  /** Maximum re-render attempts after removal. Defaults to {@link DEFAULT_MAX_RE_RENDER_ATTEMPTS}. */
  maxReRenderAttempts?: number;
  /** Window (ms) to wait for controls to reappear before abandoning. Defaults to {@link DEFAULT_RE_RENDER_TIMEOUT_MS}. */
  reRenderTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute an element's effective accessible name from the attributes most
 * relevant to a control button: `aria-label`, then `title`, then trimmed text.
 * Used only to guarantee the injected name stays distinct from the native one.
 */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) {
    return label.trim();
  }
  const title = el.getAttribute("title");
  if (title && title.trim()) {
    return title.trim();
  }
  return (el.textContent ?? "").trim();
}

/**
 * Resolve the ambient `MutationObserver` constructor for `doc`, preferring the
 * document's own view (so cross-realm jsdom documents work) and falling back to
 * the global. Returns `null` when no observer is available, in which case the
 * subtree watcher silently does nothing (the `onVideoChange` hook still drives
 * re-verification).
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

// ---------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------

/**
 * Default {@link ButtonInjector} implementation. Fully injectable (document,
 * adapter, logger, observer factory, scheduler) so it is testable in jsdom.
 */
export class ButtonInjectorImpl implements ButtonInjector {
  private readonly doc: Document;
  private readonly adapter: SiteAdapter;
  /** Reserved for the bounded detection/re-render diagnostics added in task 7.2. */
  protected readonly logger: Logger;
  private readonly onToggle?: () => void;
  private readonly onButtonChange?: (button: Element | null) => void;
  private readonly observerFactory: MutationObserverFactory | null;
  private readonly schedule: (run: () => void) => void;

  /** Reports whether the mode is active; gates the bounded re-render loop. */
  private readonly isActive: () => boolean;
  /** Injectable timer functions driving the bounded loops. */
  private readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (id: unknown) => void;

  /** Bounds for the initial detection loop (Req 1.6/7.1/7.2). */
  private readonly detectionIntervalMs: number;
  private readonly maxDetectionAttempts: number;
  /** Bounds for the re-render-after-removal loop (Req 7.4/7.5). */
  private readonly reRenderIntervalMs: number;
  private readonly maxReRenderAttempts: number;
  private readonly reRenderTimeoutMs: number;

  /** The button element we currently own, or null when none is injected. */
  private current: Element | null = null;
  /** Buttons we have wired a click handler to (so we never double-wire). */
  private readonly wired = new WeakSet<Element>();
  /** Bound click handler shared across wired buttons. */
  private readonly clickHandler: (e: Event) => void;

  /** Active subtree observer while started, else null. */
  private observer: MutationObserverLike | null = null;
  /** Disposer returned by the adapter's `onVideoChange` hook, else null. */
  private videoChangeDisposer: (() => void) | null = null;
  /** Whether `start()` has run without a matching `stop()`. */
  private started = false;

  // -- Initial detection loop state (Req 1.6/7.1/7.2) ----------------------
  /** Pending detection timer id, or null when no retry is scheduled. */
  private detectionTimer: unknown = null;
  /** Number of initial detection attempts performed (never exceeds the bound). */
  private detectionAttemptCount = 0;
  /** Whether the detection loop has finished (success or bound reached). */
  private detectionDone = false;

  // -- Re-render-after-removal loop state (Req 7.4/7.5) --------------------
  /** Pending re-render timer id, or null when no tick is scheduled. */
  private reRenderTimer: unknown = null;
  /** Number of re-render attempts performed (never exceeds the bound). */
  private reRenderAttemptCount = 0;
  /** Elapsed time (ms) the current loop has waited for controls to reappear. */
  private reRenderElapsedMs = 0;
  /** Whether a re-render loop is currently polling. */
  private reRenderRunning = false;
  /** Whether re-rendering has been abandoned (controls absent for ≥30s). */
  private reRenderAbandonedFlag = false;

  constructor(options: ButtonInjectorOptions) {
    this.adapter = options.adapter;
    this.doc =
      options.document ??
      (typeof document !== "undefined" ? document : (undefined as unknown as Document));
    this.logger = options.logger ?? createLogger("content");
    this.onToggle = options.onToggle;
    this.onButtonChange = options.onButtonChange;
    this.observerFactory =
      options.createObserver ?? defaultObserverFactory(this.doc);
    this.schedule =
      options.scheduleEnsure ??
      this.makeDefaultScheduler(options.debounceMs ?? DEFAULT_DEBOUNCE_MS);

    this.isActive = options.isActive ?? ((): boolean => false);

    const timers = this.resolveTimers(options.setTimeout, options.clearTimeout);
    this.setTimeoutFn = timers.setTimeoutFn;
    this.clearTimeoutFn = timers.clearTimeoutFn;

    this.detectionIntervalMs =
      options.detectionIntervalMs ?? DEFAULT_DETECTION_INTERVAL_MS;
    this.maxDetectionAttempts =
      options.maxDetectionAttempts ?? DEFAULT_MAX_DETECTION_ATTEMPTS;
    this.reRenderIntervalMs =
      options.reRenderIntervalMs ?? DEFAULT_RE_RENDER_INTERVAL_MS;
    this.maxReRenderAttempts =
      options.maxReRenderAttempts ?? DEFAULT_MAX_RE_RENDER_ATTEMPTS;
    this.reRenderTimeoutMs =
      options.reRenderTimeoutMs ?? DEFAULT_RE_RENDER_TIMEOUT_MS;

    this.clickHandler = (e: Event): void => {
      e.preventDefault();
      this.onToggle?.();
    };
  }

  /** The currently injected button, or null when none is present. */
  get button(): Element | null {
    return this.current;
  }

  /**
   * Number of initial detection attempts performed (Req 1.6). Observable so the
   * bounded-attempts property test can assert it never exceeds the bound.
   */
  get detectionAttempts(): number {
    return this.detectionAttemptCount;
  }

  /**
   * Number of re-render attempts performed after removal (Req 7.4). Observable
   * so the bounded-attempts property test can assert it never exceeds the bound.
   */
  get reRenderAttempts(): number {
    return this.reRenderAttemptCount;
  }

  /** Whether re-rendering has been abandoned after the ≥30s window (Req 7.5). */
  get reRenderAbandoned(): boolean {
    return this.reRenderAbandonedFlag;
  }

  /** Begin observing and attempt the initial injection. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // Reset bounded-loop state so a stop()/start() cycle starts fresh.
    this.clearDetectionTimer();
    this.clearReRenderTimer();
    this.detectionAttemptCount = 0;
    this.detectionDone = false;
    this.reRenderAttemptCount = 0;
    this.reRenderElapsedMs = 0;
    this.reRenderRunning = false;
    this.reRenderAbandonedFlag = false;

    // Start watching first so controls appearing mid-detection are observed.
    this.startObserver();
    this.subscribeVideoChange();

    // Bounded initial-detection loop (Req 1.6/7.1/7.2). The first attempt runs
    // synchronously so callers (and the bootstrap) get an immediate result.
    this.runDetection();
  }

  /** Disconnect the observer, dispose hooks, and remove the injected button. */
  stop(): void {
    this.started = false;

    this.clearDetectionTimer();
    this.clearReRenderTimer();
    this.detectionDone = true;
    this.reRenderRunning = false;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.videoChangeDisposer) {
      this.videoChangeDisposer();
      this.videoChangeDisposer = null;
    }

    this.removeButton();
  }

  /**
   * Idempotently ensure exactly one correctly placed and labelled button exists.
   *
   * Steps (Requirement 1.1–1.4):
   *  1. Resolve the controls container + native control via the adapter; if
   *     either is absent, render nothing and leave the page unchanged (Req 6.6).
   *  2. De-duplicate any marked buttons in the container, keeping exactly one —
   *     preferring the instance we already own (Req 1.4).
   *  3. Create the button if none exists (Req 1.1), assign a distinct accessible
   *     name and initial inactive state (Req 1.3, 2.10), and leave the native
   *     control untouched (Req 1.2).
   *  4. Guarantee the kept button is the immediate next sibling of the native
   *     control (Req 1.1) and is click-wired exactly once.
   */
  ensureButton(): EnsureButtonResult {
    const container = this.adapter.findControlsContainer(this.doc);
    const native = this.adapter.findNativeFullscreenButton(this.doc);

    if (!container || !native) {
      // No render target yet. The page is left untouched (Requirement 6.6);
      // bounded detection/logging is task 7.2's concern.
      return "skipped-no-target";
    }

    // De-duplicate: keep exactly one marked button, preferring the one we own.
    const marked = Array.from(
      container.querySelectorAll(`[${BUTTON_MARKER_ATTR}]`),
    );
    let kept: Element | null = null;
    if (marked.length > 0) {
      kept =
        (this.current && marked.includes(this.current) && this.current) ||
        marked[0];
      for (const el of marked) {
        if (el !== kept) {
          el.remove();
        }
      }
    }

    const created = kept === null;
    const buttonEl = kept ?? this.createButton(native);

    // Ensure correct placement: immediate next sibling of the native control
    // (Requirement 1.1). Re-position if the page moved it.
    if (native.nextSibling !== buttonEl) {
      native.after(buttonEl);
    }

    // Wire the click handler exactly once per element (covers adopted clones).
    if (!this.wired.has(buttonEl)) {
      buttonEl.addEventListener("click", this.clickHandler);
      this.wired.add(buttonEl);
    }

    // Adopt as the owned button and notify listeners when the element changes.
    if (this.current !== buttonEl) {
      this.current = buttonEl;
      this.onButtonChange?.(buttonEl);
    }

    return created ? "injected" : "present";
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Create the Windowed_Fullscreen_Button with a distinct accessible name and
   * the initial inactive state. The native control is read only (to derive a
   * distinct name) and never modified (Requirement 1.2).
   */
  private createButton(native: Element): Element {
    const btn = this.doc.createElement("button");
    btn.setAttribute(BUTTON_MARKER_ATTR, "");
    btn.setAttribute("type", "button");
    btn.className = BUTTON_CLASS;

    // Distinct accessible name (Requirement 1.3): keep our label unless the
    // native control already uses it, in which case fall back to a distinct one.
    let label = BUTTON_LABEL;
    if (accessibleName(native).toLowerCase() === label.toLowerCase()) {
      label = BUTTON_LABEL_FALLBACK;
    }
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);

    // Initial inactive state (Requirement 2.10). The Generic_Core toggles
    // aria-pressed / the is-active class thereafter; the injector never clobbers
    // that state on an already-existing button.
    btn.setAttribute("aria-pressed", "false");
    btn.classList.remove(BUTTON_ACTIVE_CLASS);

    // Make the control actually visible and clickable inside a typical video
    // control bar (generic — no site-specific CSS is required). Without this the
    // button has no size or glyph and is effectively invisible next to the
    // native control.
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
   * Build the button's icon as an inline SVG using DOM APIs (not `innerHTML`),
   * so pages enforcing Trusted Types (e.g. YouTube) cannot block it. The glyph
   * is a framed rectangle suggesting the video filling a window.
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
    frame.setAttribute("x", "7");
    frame.setAttribute("y", "9");
    frame.setAttribute("width", "22");
    frame.setAttribute("height", "18");
    frame.setAttribute("rx", "1.5");
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "#ffffff");
    frame.setAttribute("stroke-width", "2");
    svg.appendChild(frame);

    const fill = this.doc.createElementNS(ns, "rect");
    fill.setAttribute("x", "10");
    fill.setAttribute("y", "12.5");
    fill.setAttribute("width", "16");
    fill.setAttribute("height", "11");
    fill.setAttribute("rx", "1");
    fill.setAttribute("fill", "#ffffff");
    svg.appendChild(fill);

    return svg;
  }

  /** Remove the owned button (if any) and notify listeners. */
  private removeButton(): void {
    if (this.current) {
      this.current.removeEventListener("click", this.clickHandler);
      this.current.remove();
      this.current = null;
      this.onButtonChange?.(null);
    }
  }

  /**
   * Observe the player/controls subtree for mutations and re-verify (debounced).
   * Prefers the player root, then the controls container, then the document
   * element, so controls mounting/unmounting is caught (Requirement 1.5/7.4).
   */
  private startObserver(): void {
    if (this.observer || !this.observerFactory) {
      return;
    }
    const root =
      this.adapter.findPlayer(this.doc) ??
      this.adapter.findControlsContainer(this.doc) ??
      this.doc.documentElement;
    if (!root) {
      return;
    }
    const observer = this.observerFactory(() => {
      this.handleSubtreeMutation();
    });
    observer.observe(root, { childList: true, subtree: true });
    this.observer = observer;
  }

  /**
   * React to a player/controls subtree mutation.
   *
   * If the owned button was removed by the page while the mode is INACTIVE,
   * this hands off to the bounded re-render loop (Requirements 7.4/7.5).
   * Otherwise it performs the ordinary debounced SPA re-verification
   * (Requirement 1.5).
   */
  private handleSubtreeMutation(): void {
    if (
      this.current &&
      !this.isConnected(this.current) &&
      !this.isActive()
    ) {
      this.startReRenderLoop();
      return;
    }
    this.schedule(() => this.ensureButton());
  }

  /**
   * Subscribe to the adapter's SPA video-change hook so the button is
   * re-verified when the player navigates to a different video without a full
   * reload (Requirement 1.5). The hook is optional; absence is tolerated.
   */
  private subscribeVideoChange(): void {
    if (this.videoChangeDisposer || typeof this.adapter.onVideoChange !== "function") {
      return;
    }
    this.videoChangeDisposer = this.adapter.onVideoChange(this.doc, () => {
      this.schedule(() => this.ensureButton());
    });
  }

  // -------------------------------------------------------------------------
  // Bounded initial-detection loop (Requirements 1.6, 7.1, 7.2)
  // -------------------------------------------------------------------------

  /**
   * Perform one detection attempt and, while the render target is still absent,
   * schedule the next attempt — bounded to {@link maxDetectionAttempts} attempts
   * at intervals of {@link detectionIntervalMs} (≤2s, ≤10s window). Once the
   * button is rendered the loop stops; once the bound is reached without a
   * target it logs the appropriate diagnostic and stops, leaving the page
   * unchanged (Req 1.6/7.1/7.2).
   */
  private runDetection(): void {
    if (this.detectionDone || !this.started) {
      return;
    }

    this.detectionAttemptCount += 1;
    const result = this.ensureButton();

    if (result !== "skipped-no-target") {
      // Target found and button rendered — detection succeeded.
      this.detectionDone = true;
      this.clearDetectionTimer();
      return;
    }

    if (this.detectionAttemptCount >= this.maxDetectionAttempts) {
      // Exhausted the detection window: log the reason and leave page unchanged.
      this.logDetectionFailure();
      this.detectionDone = true;
      this.clearDetectionTimer();
      return;
    }

    this.detectionTimer = this.setTimeoutFn(() => {
      this.detectionTimer = null;
      this.runDetection();
    }, this.detectionIntervalMs);
  }

  /**
   * Log why detection failed, distinguishing a missing player (Req 7.1) from a
   * missing native control (Req 7.2) using the adapter resolvers.
   */
  private logDetectionFailure(): void {
    const player = this.adapter.findPlayer(this.doc);
    const context = {
      siteId: this.adapter.siteId,
      attempts: this.detectionAttemptCount,
    };
    if (!player) {
      this.logger.playerNotFound(
        "Video player not found within the detection window; leaving the page unchanged.",
        context,
      );
    } else {
      this.logger.nativeControlNotFound(
        "Native fullscreen control not found within the detection window; leaving the page unchanged.",
        context,
      );
    }
  }

  private clearDetectionTimer(): void {
    if (this.detectionTimer !== null) {
      this.clearTimeoutFn(this.detectionTimer);
      this.detectionTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Bounded re-render-after-removal loop (Requirements 7.4, 7.5)
  // -------------------------------------------------------------------------

  /**
   * Begin (or no-op if already running / exhausted / abandoned) the bounded
   * loop that re-renders the button after the page removed it while the mode is
   * inactive. Resets the per-removal reappearance window so the 30s abandon
   * deadline is measured from this removal (Req 7.5).
   */
  private startReRenderLoop(): void {
    if (
      this.reRenderRunning ||
      this.reRenderAbandonedFlag ||
      this.reRenderAttemptCount >= this.maxReRenderAttempts
    ) {
      return;
    }
    this.reRenderRunning = true;
    this.reRenderElapsedMs = 0;
    this.reRenderTick();
  }

  /**
   * One tick of the re-render loop. Re-renders within {@link reRenderIntervalMs}
   * (≤2s) of the controls reappearing, bounded to {@link maxReRenderAttempts}
   * attempts (Req 7.4); abandons and logs once the controls have stayed absent
   * for {@link reRenderTimeoutMs} (Req 7.5).
   */
  private reRenderTick(): void {
    if (!this.started) {
      this.stopReRenderLoop();
      return;
    }

    // The bounded re-render only applies while the mode is inactive (Req 7.4).
    if (this.isActive()) {
      this.stopReRenderLoop();
      return;
    }

    // Already restored (e.g. by debounced re-verification) — nothing to do.
    if (this.current && this.isConnected(this.current)) {
      this.stopReRenderLoop();
      return;
    }

    const container = this.adapter.findControlsContainer(this.doc);
    const native = this.adapter.findNativeFullscreenButton(this.doc);

    if (container && native) {
      // Controls reappeared: re-render and count the attempt.
      const result = this.ensureButton();
      if (result !== "skipped-no-target") {
        this.reRenderAttemptCount += 1;
      }
      // Restored (or bound reached) — stop; the observer re-triggers this loop
      // if the page removes the button again, up to the attempt bound.
      this.stopReRenderLoop();
      return;
    }

    // Controls still absent — wait, up to the 30s abandon window (Req 7.5).
    this.reRenderElapsedMs += this.reRenderIntervalMs;
    if (this.reRenderElapsedMs >= this.reRenderTimeoutMs) {
      this.logger.reRenderAbandoned(
        "Player controls did not reappear within the re-render window; abandoning re-render.",
        {
          siteId: this.adapter.siteId,
          attempts: this.reRenderAttemptCount,
          elapsedMs: this.reRenderElapsedMs,
        },
      );
      this.reRenderAbandonedFlag = true;
      this.stopReRenderLoop();
      return;
    }

    this.reRenderTimer = this.setTimeoutFn(() => {
      this.reRenderTimer = null;
      this.reRenderTick();
    }, this.reRenderIntervalMs);
  }

  private stopReRenderLoop(): void {
    this.reRenderRunning = false;
    this.clearReRenderTimer();
  }

  private clearReRenderTimer(): void {
    if (this.reRenderTimer !== null) {
      this.clearTimeoutFn(this.reRenderTimer);
      this.reRenderTimer = null;
    }
  }

  /**
   * Whether `node` is still attached to the document. Prefers the standard
   * `isConnected` flag, falling back to document containment for environments
   * that do not expose it.
   */
  private isConnected(node: Element): boolean {
    if (typeof node.isConnected === "boolean") {
      return node.isConnected;
    }
    return this.doc?.contains(node) ?? false;
  }

  /**
   * Resolve the timer functions driving the bounded loops, preferring caller
   * overrides, then the document view's timers, then the global timers.
   */
  private resolveTimers(
    setTimeoutOverride?: (handler: () => void, ms: number) => unknown,
    clearTimeoutOverride?: (id: unknown) => void,
  ): {
    setTimeoutFn: (handler: () => void, ms: number) => unknown;
    clearTimeoutFn: (id: unknown) => void;
  } {
    const view = this.doc?.defaultView as (Window & typeof globalThis) | null;
    const setTimeoutFn: (handler: () => void, ms: number) => unknown =
      setTimeoutOverride ??
      (view?.setTimeout?.bind(view) as
        | ((h: () => void, ms: number) => unknown)
        | undefined) ??
      (globalThis.setTimeout as unknown as (h: () => void, ms: number) => unknown);
    const clearTimeoutFn: (id: unknown) => void =
      clearTimeoutOverride ??
      (view?.clearTimeout?.bind(view) as ((id: unknown) => void) | undefined) ??
      (globalThis.clearTimeout as unknown as (id: unknown) => void);
    return { setTimeoutFn, clearTimeoutFn };
  }

  /**
   * Build the default `setTimeout`-based debounce scheduler bound to the
   * document's view (falling back to the global timer functions).
   */
  private makeDefaultScheduler(delay: number): (run: () => void) => void {
    const view = this.doc?.defaultView as (Window & typeof globalThis) | null;
    const setTimeoutFn: (handler: () => void, ms: number) => unknown =
      view?.setTimeout?.bind(view) ??
      (globalThis.setTimeout as unknown as (h: () => void, ms: number) => unknown);
    const clearTimeoutFn: (id: unknown) => void =
      (view?.clearTimeout?.bind(view) as ((id: unknown) => void) | undefined) ??
      (globalThis.clearTimeout as unknown as (id: unknown) => void);

    let pending: unknown = null;
    return (run: () => void): void => {
      if (pending !== null) {
        clearTimeoutFn(pending);
      }
      pending = setTimeoutFn(() => {
        pending = null;
        run();
      }, delay);
    };
  }
}

/**
 * Create a {@link ButtonInjector} with dependency injection (document, adapter,
 * logger, observer factory, scheduler) for testability in jsdom.
 */
export function createButtonInjector(
  options: ButtonInjectorOptions,
): ButtonInjectorImpl {
  return new ButtonInjectorImpl(options);
}

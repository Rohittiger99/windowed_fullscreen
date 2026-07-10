/**
 * Content-script bootstrap (task 12.1).
 *
 * This is the per-tab entry point injected on Supported_Site URL matches. It
 * wires together the pieces built in earlier tasks into the running mode:
 *
 *  1. Resolve the active Site_Adapter for the current `location.href` from the
 *     Adapter Registry. If none matches, inject nothing and do nothing — the
 *     Windowed_Fullscreen_Button is never rendered (Requirements 6.3/6.6).
 *  2. Start the {@link createButtonInjector} for the resolved adapter so a
 *     Windowed_Fullscreen_Button is injected adjacent to the native control and
 *     kept present across SPA video changes (Requirement 1).
 *  3. Instantiate the Generic_Core {@link createController}. The injected
 *     button's click and the cross-surface `TOGGLE` message both drive
 *     `controller.toggle(resolve)`, where `resolve` builds a fresh
 *     {@link SiteDescriptor} from the adapter (Requirement 3.1).
 *  4. Associate the injected button with the controller (`setButton`) via the
 *     injector's `onButtonChange` hook so button state reflects the mode, and
 *     gate the injector's bounded re-render loop on `controller.isActive`.
 *  5. Register a `chrome.runtime` message listener handling `TOGGLE` and
 *     `GET_STATUS` (Requirement 3.1).
 *  6. Apply auto-apply: when the per-site `autoApply` preference is enabled,
 *     enter Windowed_Fullscreen_Mode as soon as the player is available
 *     (Requirement 4.5).
 *
 * Escape handling is owned by the controller (registered on `enter`), so this
 * module does not register it (no double-registration) — Requirement 2.7.
 *
 * The wiring is factored into the exported {@link bootstrapContentScript} so it
 * can be driven under jsdom by the integration tests (task 12.2). The
 * module-level auto-execution at the bottom is thin and guarded so it only runs
 * inside the real extension content-script environment.
 */

import type {
  AdapterRegistry,
  ExtMessage,
  ExtResponse,
  SiteAdapter,
  SiteDescriptor,
} from "../shared/types";
import type { MutationObserverFactory } from "../core/controller";
import { createController, type WindowedFullscreenControllerImpl } from "../core/controller";
import { createButtonInjector, type ButtonInjector } from "../content/injector";
import { defaultRegistry } from "../adapters/index";
import { createPreferenceStore, type PreferenceStore } from "../preferences/store";
import { createLogger, type Logger } from "../shared/logger";
import { injectWindowedStyles } from "./windowed-styles";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The shape of a `chrome.runtime.onMessage` listener as far as the content
 * script needs it: it receives an {@link ExtMessage}, an opaque sender, and a
 * `sendResponse` callback. Returning `true` keeps the channel open for an async
 * response; the content-script handlers respond synchronously and so return
 * `void`.
 */
export type ContentMessageListener = (
  message: ExtMessage,
  sender: unknown,
  sendResponse: (response: ExtResponse) => void,
) => boolean | void;

/** Dependencies for {@link bootstrapContentScript}, all injectable for tests. */
export interface ContentBootstrapDeps {
  /** Document to operate on. */
  document: Document;
  /** Current page URL used for adapter resolution (typically `location.href`). */
  url: string;
  /** Adapter Registry resolving the active Site_Adapter (Requirement 6.4). */
  registry: AdapterRegistry;
  /** Preference Store backing the per-site auto-apply lookup (Requirement 4.5). */
  store: PreferenceStore;
  /** Diagnostic logger. Defaults to a content-surface logger. */
  logger?: Logger;
  /**
   * MutationObserver factory shared by the injector and the controller's
   * player-loss watcher. Injectable so tests drive mutations synchronously.
   */
  createObserver?: MutationObserverFactory;
  /** Timer used by the injector's bounded loops. Defaults to the document view's. */
  setTimeout?: (handler: () => void, ms: number) => unknown;
  /** Companion to {@link ContentBootstrapDeps.setTimeout}. */
  clearTimeout?: (id: unknown) => void;
  /**
   * Register the cross-surface message listener. Defaults to
   * `chrome.runtime.onMessage.addListener`. When neither is available the
   * content script still runs (button + Escape) but cannot receive `TOGGLE`.
   */
  addMessageListener?: (listener: ContentMessageListener) => void;
}

/** Handle returned by {@link bootstrapContentScript} when an adapter matched. */
export interface ContentBootstrap {
  /** The resolved active Site_Adapter. */
  readonly adapter: SiteAdapter;
  /** The Generic_Core controller driving the mode. */
  readonly controller: WindowedFullscreenControllerImpl;
  /** The button injector keeping the Windowed_Fullscreen_Button present. */
  readonly injector: ButtonInjector;
  /** Resolve a fresh descriptor from the adapter (or `null` when unavailable). */
  readonly resolve: () => SiteDescriptor | null;
  /** Tear down the injector and controller (stops observers and the button). */
  stop(): void;
}

// ---------------------------------------------------------------------------
// SiteDescriptor resolver
// ---------------------------------------------------------------------------

/**
 * Build a {@link SiteDescriptor} from a Site_Adapter against `doc`.
 *
 * Resolves the player, native control, and controls container via the adapter,
 * and resolves each Site_Chrome selector to elements (collecting selectors that
 * matched nothing into `missingChromeSelectors` for the core to log, Req 7.3).
 *
 * Returns `null` when the adapter cannot yet supply the player, the native
 * control, or the controls container — in which case the caller (the
 * controller's `toggle`) leaves the page unchanged (Requirements 6.2/6.6).
 */
export function resolveSiteDescriptor(
  adapter: SiteAdapter,
  doc: Document,
): SiteDescriptor | null {
  const player = adapter.findPlayer(doc);
  const nativeFullscreenButton = adapter.findNativeFullscreenButton(doc);
  const controlsContainer = adapter.findControlsContainer(doc);

  // The core needs at least a player + native control; the controls container
  // is part of the descriptor contract. Any missing => refuse (return null).
  if (!player || !nativeFullscreenButton || !controlsContainer) {
    return null;
  }

  const siteChromeElements: Element[] = [];
  const missingChromeSelectors: string[] = [];
  for (const selector of adapter.getSiteChromeSelectors()) {
    const matched = Array.from(doc.querySelectorAll(selector));
    if (matched.length === 0) {
      // Tolerated + recorded so the core can log it on entry (Requirement 7.3).
      missingChromeSelectors.push(selector);
    } else {
      siteChromeElements.push(...matched);
    }
  }

  return {
    player,
    nativeFullscreenButton,
    controlsContainer,
    siteChromeElements,
    missingChromeSelectors,
    activePlayerClasses: adapter.getActivePlayerClasses?.() ?? [],
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Wire the content-script surface for the current page.
 *
 * Returns a {@link ContentBootstrap} handle when a Site_Adapter matched the
 * current URL, or `null` when none matched — in which case nothing is injected
 * and no listeners are registered (Requirements 6.3/6.6).
 */
export function bootstrapContentScript(
  deps: ContentBootstrapDeps,
): ContentBootstrap | null {
  const logger = deps.logger ?? createLogger("content");

  // 1. Resolve the active adapter; if none matches, do nothing (Req 6.6).
  const adapter = deps.registry.resolve(deps.url);
  if (!adapter) {
    return null;
  }

  // Inject the active-mode stylesheet once. It is scoped under the
  // `wfs-windowed` class (toggled by the controller) so it only takes effect
  // while the mode is active, and forces the player/video to fill the viewport.
  injectWindowedStyles(deps.document);

  // 2. Generic_Core controller. Escape handling is registered by the controller
  //    on enter(), so the bootstrap never registers it (avoids double-wiring,
  //    Requirement 2.7).
  const controller = createController({
    document: deps.document,
    logger,
    createObserver: deps.createObserver,
  });

  // The resolver the toggle/auto-apply paths share.
  const resolve = (): SiteDescriptor | null =>
    resolveSiteDescriptor(adapter, deps.document);

  // -- Auto-apply state (Requirement 4.5) ----------------------------------
  let autoApplyEnabled = false;
  let autoApplyResolved = false;
  let autoApplied = false;

  /**
   * Enter the mode once, when auto-apply is enabled and the player is available.
   * Driven both by the per-site preference resolving and by the button being
   * injected (a proxy for the player having finished loading), so entry happens
   * within ~1s of the player becoming available (Requirement 4.5).
   */
  const maybeAutoApply = (): void => {
    if (!autoApplyResolved || !autoApplyEnabled || autoApplied) {
      return;
    }
    if (controller.isActive) {
      return;
    }
    const descriptor = resolve();
    if (!descriptor) {
      // Player/controls not ready yet; a later button-change re-triggers this.
      return;
    }
    autoApplied = true;
    controller.enter(descriptor);
  };

  // 3+4. Injector. Its click drives the toggle; its button-change hook keeps the
  //      controller's button association current (state reflection) and is the
  //      auto-apply trigger; `isActive` gates its bounded re-render loop.
  const injector = createButtonInjector({
    adapter,
    document: deps.document,
    logger,
    createObserver: deps.createObserver,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    isActive: () => controller.isActive,
    onToggle: () => controller.toggle(resolve),
    onButtonChange: (button) => {
      controller.setButton(button);
      maybeAutoApply();
    },
  });

  injector.start();

  // 5. Cross-surface messaging (Requirement 3.1).
  const messageListener: ContentMessageListener = (message, _sender, sendResponse) => {
    switch (message?.type) {
      case "TOGGLE": {
        controller.toggle(resolve);
        sendResponse({ ok: true, active: controller.isActive });
        return;
      }
      case "GET_STATUS": {
        sendResponse({ ok: true, active: controller.isActive });
        return;
      }
      default:
        // Other message types are not handled by the content script.
        return;
    }
  };

  const register = deps.addMessageListener ?? defaultAddMessageListener();
  register?.(messageListener);

  // 6. Resolve the per-site auto-apply preference and attempt entry. Reading is
  //    async; `maybeAutoApply` is idempotent and also fires on button-change, so
  //    ordering between the read and the player loading does not matter.
  void deps.store
    .getSite(adapter.siteId)
    .then((prefs) => {
      autoApplyEnabled = prefs.autoApply;
      autoApplyResolved = true;
      maybeAutoApply();
    })
    .catch(() => {
      // Defaults (auto-apply off) already apply; nothing more to do.
      autoApplyResolved = true;
    });

  return {
    adapter,
    controller,
    injector,
    resolve,
    stop: () => {
      injector.stop();
      if (controller.isActive) {
        controller.exit();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ambient (real extension) wiring
// ---------------------------------------------------------------------------

/**
 * Build the `chrome.runtime.onMessage` registrar when running inside the real
 * extension, or `null` otherwise (e.g. unit tests without a `chrome` global).
 * The returned registrar adapts our synchronous {@link ContentMessageListener}
 * to the `chrome.runtime` listener signature.
 */
function defaultAddMessageListener():
  | ((listener: ContentMessageListener) => void)
  | null {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return null;
  }
  return (listener: ContentMessageListener): void => {
    chrome.runtime.onMessage.addListener(
      (message: unknown, sender: unknown, sendResponse: (response: ExtResponse) => void) =>
        listener(message as ExtMessage, sender, sendResponse),
    );
  };
}

/**
 * Whether we are running in the real content-script environment: a DOM plus the
 * `chrome.runtime` messaging surface. Guards the module-level auto-execution so
 * importing this module under test (no `chrome.runtime`) does not self-run.
 */
function isExtensionContentEnvironment(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof location !== "undefined" &&
    typeof chrome !== "undefined" &&
    !!chrome.runtime?.onMessage
  );
}

/**
 * SPA-aware content-script manager.
 *
 * Sites like YouTube navigate in-app (History API pushState) without a real
 * page load, so the content script only runs `bootstrapContentScript` once — on
 * whatever URL it first loaded on. If that first URL is not a Supported_Site
 * page (e.g. the YouTube home page, where no `#movie_player` exists yet), the
 * adapter does not match, nothing is wired, and a later in-app navigation to a
 * watch page would never inject the button or register a message listener —
 * forcing the user to reload (Requirement 6.3 across SPA navigations).
 *
 * This manager closes that gap site-independently:
 *  - It (re)bootstraps whenever the current URL resolves to an adapter and no
 *    matching bootstrap is active, and tears down when leaving a supported page.
 *  - It owns ONE persistent `chrome.runtime.onMessage` listener that routes to
 *    the active bootstrap, so re-bootstrapping never stacks duplicate listeners.
 *  - It detects in-app navigations by polling the (shared) `location.href` plus
 *    `popstate`/`hashchange`. Content scripts run in an isolated world, so the
 *    page's own `history.pushState` calls are NOT interceptable by patching
 *    `history` here; polling `location.href` reliably reflects SPA navigations
 *    on any site, which keeps this logic adapter-agnostic.
 */
function startSpaAwareContentScript(): void {
  const store = createPreferenceStore();
  let current: ContentBootstrap | null = null;
  let route: ContentMessageListener | null = null;

  // One persistent listener for the lifetime of the content script. It delegates
  // to the active bootstrap's handler, or answers status queries as inactive
  // when no adapter is active (e.g. on the YouTube home page) so the popup can
  // render a correct, non-blocking state instead of timing out.
  chrome.runtime.onMessage.addListener(
    (message: unknown, sender: unknown, sendResponse: (response: ExtResponse) => void) => {
      if (route) {
        return route(message as ExtMessage, sender, sendResponse);
      }
      const type = (message as ExtMessage)?.type;
      if (type === "GET_STATUS" || type === "TOGGLE") {
        sendResponse({ ok: true, active: false });
      }
      return;
    },
  );

  const sync = (): void => {
    const adapter = defaultRegistry.resolve(location.href);
    if (adapter) {
      // Already running for this site: its own onVideoChange hook handles
      // in-site video swaps, so leave the live bootstrap in place.
      if (current && current.adapter.siteId === adapter.siteId) {
        return;
      }
      current?.stop();
      current = bootstrapContentScript({
        document,
        url: location.href,
        registry: defaultRegistry,
        store,
        // The manager owns the single persistent chrome listener; capture this
        // bootstrap's handler rather than registering another listener.
        addMessageListener: (listener) => {
          route = listener;
        },
      });
      if (!current) {
        route = null;
      }
    } else if (current) {
      // Left the supported page (e.g. watch -> home): tear down and stop routing.
      current.stop();
      current = null;
      route = null;
    }
  };

  sync();

  let lastHref = location.href;
  const onMaybeNavigated = (): void => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sync();
    }
  };
  window.addEventListener("popstate", onMaybeNavigated);
  window.addEventListener("hashchange", onMaybeNavigated);
  // Backstop for pushState-based SPA navigations (not observable from the
  // isolated world): a cheap 1s href poll. A string compare per second is
  // negligible and only re-bootstraps when the URL actually changed.
  setInterval(onMaybeNavigated, 1000);
}

if (isExtensionContentEnvironment()) {
  startSpaAwareContentScript();
}

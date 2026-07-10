/**
 * MV3 Service_Worker entry.
 *
 * Responsibilities (Requirement 3 + UI plumbing):
 * - Listen for the `chrome.commands` toggle command and relay it to the active
 *   tab's content script as a `TOGGLE` message, gated on the tab being a
 *   Supported_Site (Requirements 3.1, 3.5).
 * - When the content script is unreachable, leave the mode unchanged and
 *   surface a failure indication on the toolbar action (Requirement 3.6).
 * - Route storage reads/writes (`PREF_READ` / `PREF_WRITE`) requested by UI
 *   surfaces through the Preference Store, and forward `GET_STATUS` / `TOGGLE`
 *   messages to the active tab's content script.
 *
 * The command-handling and message-routing logic is factored into pure-ish
 * functions that accept injected chrome APIs / registry / store, so the routing
 * can be unit-tested without a live browser (task 9.4). The bottom of the file
 * performs the actual `chrome.*` wiring using default dependencies.
 *
 * The worker is event-driven and may be terminated/restarted by the browser; it
 * holds no critical in-memory state (all durable state lives in
 * `chrome.storage`).
 */

import type { AdapterRegistry, ExtMessage, ExtResponse } from "../shared/types";
import { defaultRegistry } from "../adapters/index.js";
import { createPreferenceStore, type PreferenceStore } from "../preferences/store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The manifest command id that toggles Windowed_Fullscreen_Mode (Req 3.1). */
export const TOGGLE_COMMAND = "toggle-windowed-fullscreen";

/**
 * Budget for signalling the content script (Requirement 3.1: ≤ 500 ms). If the
 * content script does not acknowledge within this window it is treated as
 * unreachable and a failure indication is surfaced (Requirement 3.6).
 */
export const SEND_TIMEOUT_MS = 500;

// ---------------------------------------------------------------------------
// Supported-site gating
// ---------------------------------------------------------------------------

/**
 * A URL is a Supported_Site iff some registered Site_Adapter matches it
 * (Requirement 3.5 / 6.4 / 6.6). Resolution is delegated to the registry so the
 * service worker stays site-independent.
 */
export function isSupportedSite(registry: AdapterRegistry, url: string | undefined): boolean {
  if (!url) return false;
  return registry.resolve(url) !== null;
}

// ---------------------------------------------------------------------------
// Command handling (injectable dependencies for testing)
// ---------------------------------------------------------------------------

/** Distinct outcomes of handling a command, surfaced for unit testing. */
export type ToggleOutcome =
  | { outcome: "ignored-other-command" }
  | { outcome: "ignored-no-tab" }
  | { outcome: "ignored-unsupported" }
  | { outcome: "toggled"; active?: boolean }
  | { outcome: "unreachable"; error: string };

/** Injected dependencies the toggle command handler relies on. */
export interface ToggleCommandDeps {
  /** Adapter registry used to decide whether the active tab is supported. */
  registry: AdapterRegistry;
  /** Resolve the currently active tab (or undefined when none). */
  queryActiveTab: () => Promise<{ id?: number; url?: string } | undefined>;
  /** Send a message to the content script in a tab, resolving its response. */
  sendToTab: (tabId: number, message: ExtMessage) => Promise<ExtResponse | undefined>;
  /** Show/clear the failure indication on the toolbar action (Req 3.6). */
  setFailureIndication: (failed: boolean, detail?: string) => void | Promise<void>;
  /** Structured diagnostic logger. */
  log: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Handle a `chrome.commands` command. Resolves the active tab, gates on
 * Supported_Site, signals the content script to toggle, and surfaces a failure
 * indication when the content script is unreachable.
 *
 * Returns a structured outcome so the routing can be asserted in tests without
 * inspecting browser side effects.
 */
export async function handleToggleCommand(
  command: string,
  deps: ToggleCommandDeps,
): Promise<ToggleOutcome> {
  // Only the toggle command is actioned; the spare command is unassigned and
  // any other id is ignored.
  if (command !== TOGGLE_COMMAND) {
    return { outcome: "ignored-other-command" };
  }

  const tab = await deps.queryActiveTab();
  if (!tab || tab.id == null || !tab.url) {
    return { outcome: "ignored-no-tab" };
  }

  // Req 3.5: do nothing on sites that are not a Supported_Site.
  if (!isSupportedSite(deps.registry, tab.url)) {
    return { outcome: "ignored-unsupported" };
  }

  // Req 3.1: signal the content script to toggle within budget.
  try {
    const response = await deps.sendToTab(tab.id, { type: "TOGGLE" });
    if (response && response.ok) {
      await deps.setFailureIndication(false);
      return { outcome: "toggled", active: response.active };
    }
    // A non-ok / missing response means the toggle did not happen.
    const error = response && !response.ok ? response.error : "no response from content script";
    deps.log("toggle command could not reach content script", { error, url: tab.url });
    await deps.setFailureIndication(true, error);
    return { outcome: "unreachable", error };
  } catch (err) {
    // Req 3.6: content script unreachable (not injected / timed out). Leave the
    // mode unchanged and surface a failure indication.
    const error = errorMessage(err);
    deps.log("toggle command failed to reach content script", { error, url: tab.url });
    await deps.setFailureIndication(true, error);
    return { outcome: "unreachable", error };
  }
}

// ---------------------------------------------------------------------------
// Message routing (PREF_READ / PREF_WRITE / GET_STATUS / TOGGLE)
// ---------------------------------------------------------------------------

/** Injected dependencies the message router relies on. */
export interface MessageRouterDeps {
  /** Preference store backing PREF_READ / PREF_WRITE (Requirement 4). */
  store: PreferenceStore;
  /**
   * Forward a message (GET_STATUS / TOGGLE) to the active tab's content script.
   * Returns the content script's response, or undefined when unreachable.
   */
  forwardToActiveTab?: (message: ExtMessage) => Promise<ExtResponse | undefined>;
}

/**
 * Route a cross-surface message to the appropriate handler and resolve an
 * {@link ExtResponse}. Storage reads/writes go through the Preference Store;
 * status/toggle messages are forwarded to the active tab's content script.
 */
export async function routeMessage(
  message: ExtMessage,
  deps: MessageRouterDeps,
): Promise<ExtResponse> {
  switch (message.type) {
    case "PREF_READ": {
      if (message.scope === "global") {
        const data = await deps.store.getGlobal();
        return { ok: true, data };
      }
      if (!message.siteId) {
        return { ok: false, error: "PREF_READ for site scope requires siteId" };
      }
      const data = await deps.store.getSite(message.siteId);
      return { ok: true, data };
    }

    case "PREF_WRITE": {
      if (message.scope === "global") {
        const result = await deps.store.setGlobal(message.value);
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }
      if (!message.siteId) {
        return { ok: false, error: "PREF_WRITE for site scope requires siteId" };
      }
      const result = await deps.store.setSite(message.siteId, message.value);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }

    case "GET_STATUS":
    case "TOGGLE": {
      // These concern the content script's mode state; forward them on.
      if (!deps.forwardToActiveTab) {
        return { ok: false, error: "no active tab to query" };
      }
      const response = await deps.forwardToActiveTab(message);
      return response ?? { ok: false, error: "content script unreachable" };
    }

    default: {
      // Exhaustiveness guard: unknown message types are rejected.
      const unknownType = (message as { type?: string }).type ?? "unknown";
      return { ok: false, error: `unsupported message type: ${unknownType}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Default chrome-backed dependencies
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/** Resolve a promise, or reject after `ms` with a timeout error. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Query the active tab in the last-focused window using `chrome.tabs`. */
async function queryActiveTabImpl(): Promise<{ id?: number; url?: string } | undefined> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

/**
 * Send a message to a tab's content script, rejecting if it does not respond
 * within {@link SEND_TIMEOUT_MS} so unreachable content scripts surface a
 * failure indication promptly (Requirements 3.1, 3.6).
 */
function sendToTabImpl(tabId: number, message: ExtMessage): Promise<ExtResponse | undefined> {
  return withTimeout(
    chrome.tabs.sendMessage(tabId, message) as Promise<ExtResponse | undefined>,
    SEND_TIMEOUT_MS,
    "sendMessage",
  );
}

/** Send a message to the active tab's content script (used for GET_STATUS / TOGGLE). */
async function forwardToActiveTabImpl(message: ExtMessage): Promise<ExtResponse | undefined> {
  const tab = await queryActiveTabImpl();
  if (!tab || tab.id == null) return undefined;
  return sendToTabImpl(tab.id, message);
}

/**
 * Surface (or clear) a failure indication on the toolbar action: a red "!"
 * badge plus a descriptive title (Requirement 3.6).
 */
async function setFailureIndicationImpl(failed: boolean, detail?: string): Promise<void> {
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
    // Best-effort UI affordance; never throw out of the command handler.
  }
}

function logImpl(message: string, context: Record<string, unknown> = {}): void {
  console.warn("[wfs:background:shortcut]", message, context);
}

/** Build the default, chrome-backed dependencies for the toggle command. */
function defaultToggleDeps(): ToggleCommandDeps {
  return {
    registry: defaultRegistry,
    queryActiveTab: queryActiveTabImpl,
    sendToTab: sendToTabImpl,
    setFailureIndication: setFailureIndicationImpl,
    log: logImpl,
  };
}

/** Build the default, chrome-backed dependencies for the message router. */
function defaultMessageDeps(): MessageRouterDeps {
  return {
    store: createPreferenceStore(),
    forwardToActiveTab: forwardToActiveTabImpl,
  };
}

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

/**
 * Register the service worker's `chrome.*` listeners. Guarded so importing this
 * module in a non-extension context (e.g. unit tests) does not throw.
 */
export function registerServiceWorker(): void {
  if (typeof chrome === "undefined") return;

  chrome.commands?.onCommand.addListener((command) => {
    void handleToggleCommand(command, defaultToggleDeps());
  });

  chrome.runtime?.onMessage.addListener((message, _sender, sendResponse) => {
    // Always send a response so callers (e.g. the popup) never hang waiting:
    // a thrown/rejected route is reported as a failure rather than silence.
    routeMessage(message as ExtMessage, defaultMessageDeps())
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    // Returning true keeps the message channel open for the async response.
    return true;
  });
}

registerServiceWorker();

console.debug("[wfs] service worker loaded");

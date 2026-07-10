/**
 * Popup entry (task 11.1).
 *
 * Thin wiring layer. The Popup is now a single, self-contained surface: it
 * shows the current-site status AND the full settings (per-site auto-apply, the
 * keyboard-shortcut link, and the Donation_Link), so the user never has to open
 * a separate Options tab. Status is gathered via the real `chrome.*` APIs;
 * settings are rendered by the shared, tested {@link OptionsPage} into a second
 * container. All testable logic lives in `popup.ts` and `options-page.ts`.
 */

import { defaultRegistry } from "../adapters/index.js";
import { deriveStatus, renderPopup, type PopupActions } from "./popup.js";
import { OptionsPage } from "../options/options-page.js";
import { createPreferenceStore } from "../preferences/store.js";
import type { ExtMessage, ExtResponse } from "../shared/types.js";

/** Resolve the active tab (id + url) for adapter resolution and messaging. */
async function queryActiveTab(): Promise<{ id?: number; url?: string } | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0];
  } catch {
    return undefined;
  }
}

/**
 * Send a message to the content script in the active tab DIRECTLY (no
 * service-worker hop) for reliability. Races against a short timeout so the
 * popup never blocks if the tab has no content script.
 */
async function sendToTab(
  tabId: number | undefined,
  message: ExtMessage,
): Promise<ExtResponse | undefined> {
  if (tabId == null) return undefined;
  try {
    const send = chrome.tabs.sendMessage(tabId, message) as Promise<ExtResponse | undefined>;
    const timeout = new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), 800);
    });
    return await Promise.race([send, timeout]);
  } catch {
    // No content script / unreachable: treat as not reachable.
    return undefined;
  }
}

/** Discover Supported_Site ids from the shared adapter registry. */
function supportedSiteIds(): string[] {
  const ids = new Set<string>();
  const probe = defaultRegistry.resolve("https://www.youtube.com/watch?v=dummy");
  if (probe) ids.add(probe.siteId);
  return [...ids];
}

/** Render the settings controls (auto-apply, shortcut, donation) in-popup. */
async function renderSettings(container: HTMLElement): Promise<void> {
  const page = new OptionsPage({
    document,
    root: container,
    // The popup already shows its own title, so skip the big page heading.
    showHeading: false,
    siteIds: supportedSiteIds(),
    siteLabels: { youtube: "YouTube" },
    // Open the external pages in a new, focused tab while keeping the popup's
    // origin tab in place. `chrome.tabs.create` resolves with the created Tab
    // (truthy) on success and rejects on failure.
    openDonation: (url) => chrome.tabs.create({ url, active: true }),
    openShortcuts: (url) => chrome.tabs.create({ url, active: true }),
    store: createPreferenceStore({
      onLoadError: (error) => {
        page.showError(`Could not load preferences (${error.reason}); showing defaults.`);
      },
    }),
  });
  await page.render();
}

async function init(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;

  // Mutable view state; re-rendered whenever any of these resolve or change.
  let tabId: number | undefined;
  let url: string | undefined;
  let statusResponse: ExtResponse | undefined;

  const actions: PopupActions = {
    toggle: () => {
      // Fire-and-forget: send TOGGLE, then re-render from the response's fresh
      // `active` flag so the button label flips immediately.
      void (async () => {
        const response = await sendToTab(tabId, { type: "TOGGLE" });
        if (response) {
          statusResponse = response;
          paint();
        }
      })();
    },
  };

  const paint = (): void => {
    renderPopup(document, root, deriveStatus(url, statusResponse, defaultRegistry), actions);
  };

  // Paint immediately (status unknown) so the popup is never blank, even before
  // the async tab/status lookups resolve or if the status round-trip stalls.
  paint();

  // Render the settings controls once; they load their own values from storage.
  const settings = document.getElementById("settings");
  if (settings instanceof HTMLElement) {
    void renderSettings(settings);
  }

  // Resolve the current tab and re-render with the supported-site status.
  const tab = await queryActiveTab();
  tabId = tab?.id;
  url = tab?.url;
  paint();

  // Finally enrich with the live mode status once the content script answers.
  statusResponse = await sendToTab(tabId, { type: "GET_STATUS" });
  paint();
}

void init();

console.debug("[wfs] popup loaded");

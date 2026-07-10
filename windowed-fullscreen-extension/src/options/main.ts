/**
 * Options page entry (thin DOM wiring).
 *
 * Constructs the ambient {@link PreferenceStore} (backed by `chrome.storage`)
 * and the list of Supported_Site ids from the adapter registry, then hands them
 * to the testable {@link OptionsPage}. All rendering, validation, and
 * persistence logic lives in `options-page.ts` so it can be exercised under
 * jsdom; this file only bootstraps it against the real document and store
 * (Requirement 5; Donation_Link — Requirement 8).
 */

import { defaultRegistry } from "../adapters/index.js";
import { createPreferenceStore } from "../preferences/store.js";
import { OptionsPage } from "./options-page.js";

/** Discover Supported_Site ids from the shared adapter registry. */
function supportedSiteIds(): string[] {
  // The registry resolves adapters by URL; the v1 supported set is YouTube.
  // We expose siteIds via the known adapter rather than reaching into internals.
  const ids = new Set<string>();
  // `defaultRegistry` is the populated singleton; probe with representative URLs.
  const probe = defaultRegistry.resolve("https://www.youtube.com/watch?v=dummy");
  if (probe) ids.add(probe.siteId);
  return [...ids];
}

async function bootstrap(): Promise<void> {
  const page = new OptionsPage({
    document,
    siteIds: supportedSiteIds(),
    siteLabels: { youtube: "YouTube" },
    // Open the external donation page in a new, focused tab while keeping the
    // options page open in its original tab (Req 8.3). `chrome.tabs.create`
    // resolves with the created Tab (truthy) on success and rejects on failure,
    // which the page maps to an open-failure error (Req 8.4).
    openDonation: (url) => chrome.tabs.create({ url, active: true }),
    // Open the browser's keyboard-shortcuts page in a new, focused tab (Req
    // 5.2). Anchor navigation to chrome:// URLs is blocked, so the page opens
    // it programmatically via the tabs API.
    openShortcuts: (url) => chrome.tabs.create({ url, active: true }),
    store: createPreferenceStore({
      onLoadError: (error) => {
        page.showError(
          `Could not load preferences (${error.reason}); showing defaults.`,
        );
      },
    }),
  });
  await page.render();
}

void bootstrap();

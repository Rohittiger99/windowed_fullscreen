/**
 * Popup surface logic.
 *
 * The Popup is a lightweight toolbar surface that shows the current-site status
 * (is a Site_Adapter active for the current tab? is Windowed_Fullscreen_Mode
 * active?) and offers links to the Options_Page and the Donation_Link.
 *
 * Status derivation and rendering are factored into pure-ish exported functions
 * that accept injected dependencies (current-tab URL, a GET_STATUS response, the
 * adapter registry, the document, and link handlers) so they can be unit-tested
 * against a simulated DOM without a live browser. `main.ts` stays a thin wiring
 * layer that supplies the real `chrome.*` APIs.
 */

import type { AdapterRegistry, ExtResponse } from "../shared/types.js";
import { DONATION_URL } from "../shared/donation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * External donation page opened from the Popup (Requirement 8 — Donation_Link).
 * Re-exported from the shared module so the Popup and Options_Page stay in sync.
 */
export { DONATION_URL };

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

/** Derived current-site status the Popup renders. */
export interface PopupStatus {
  /**
   * Whether the current tab's site is one the extension supports at all
   * (host-level), even if this specific page has no video. Drives the
   * "Supported site" line so the YouTube home page reads as supported.
   */
  siteSupported: boolean;
  /**
   * Whether the current page is one where the mode can activate right now — a
   * registered Site_Adapter matches (e.g. a YouTube watch page with a player).
   */
  adapterActive: boolean;
  /** The matching adapter's siteId, or null when no adapter matches the site. */
  siteId: string | null;
  /** Whether Windowed_Fullscreen_Mode is currently active in the tab. */
  modeActive: boolean;
  /**
   * Whether the GET_STATUS query reached a content script. False when the tab
   * is unsupported or the content script is not injected/unreachable, in which
   * case `modeActive` is reported as inactive.
   */
  reachable: boolean;
}

/**
 * Derive the Popup status from the current tab URL, the GET_STATUS response, and
 * the adapter registry. Pure: no DOM or chrome access.
 *
 * - `adapterActive`/`siteId` come from resolving the URL against the registry
 *   (Requirements 6.4/6.6), mirroring the Supported_Site gating used elsewhere.
 * - `reachable`/`modeActive` come from the content script's GET_STATUS response;
 *   a missing or not-ok response is treated as unreachable with the mode
 *   reported inactive.
 */
export function deriveStatus(
  url: string | undefined,
  statusResponse: ExtResponse | undefined,
  registry: AdapterRegistry,
): PopupStatus {
  // Two levels: the broader host-level check ("is this a supported site?") and
  // the page-level match ("can the mode activate on this exact page?").
  const siteAdapter = url ? registry.resolveSite(url) : null;
  const pageAdapter = url ? registry.resolve(url) : null;

  let reachable = false;
  let modeActive = false;
  if (statusResponse && statusResponse.ok) {
    reachable = true;
    modeActive = statusResponse.active === true;
  }

  return {
    siteSupported: siteAdapter !== null,
    adapterActive: pageAdapter !== null,
    siteId: pageAdapter?.siteId ?? siteAdapter?.siteId ?? null,
    modeActive,
    reachable,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Action(s) the Popup invokes; injected so rendering stays chrome-free. */
export interface PopupActions {
  /** Toggle Windowed_Fullscreen_Mode in the active tab's content script. */
  toggle: () => void;
}

/** Human-readable description of the supported-site line. */
export function describeSite(status: PopupStatus): string {
  return status.siteSupported ? `Yes (${status.siteId})` : "No";
}

/**
 * Whether the toggle button can act. It needs to be on a page where the mode
 * can activate (a matching Site_Adapter) AND a reachable content script to
 * receive the TOGGLE message; otherwise toggling would be a no-op.
 */
export function toggleEnabled(status: PopupStatus): boolean {
  return status.adapterActive && status.reachable;
}

/**
 * Label for the toggle button. It reflects the current state for free (so the
 * dropped "Active/Inactive" status row is not missed) while also being the
 * primary action: enter when inactive, exit when active. When the button is
 * disabled it explains why — distinguishing an unsupported site from a
 * supported site whose current page simply has no video.
 */
export function toggleLabel(status: PopupStatus): string {
  if (!status.siteSupported) return "Not available on this site";
  if (!status.adapterActive) return "Open a video to use it";
  if (!status.reachable) return "Reload the page to control it here";
  return status.modeActive ? "Exit windowed fullscreen" : "Enter windowed fullscreen";
}

/**
 * Render the Popup status block + toggle into `root`, replacing any prior
 * content. Builds the title, the supported-site line, and the windowed-
 * fullscreen toggle button. Settings controls (per-site auto-apply, the
 * keyboard-shortcut link, and the Donation_Link) are rendered separately by the
 * embedded {@link OptionsPage}, so the Popup is a single self-contained surface.
 */
export function renderPopup(
  doc: Document,
  root: HTMLElement,
  status: PopupStatus,
  actions: PopupActions,
): void {
  root.replaceChildren();

  const heading = doc.createElement("h1");
  heading.className = "wfs-popup__title";
  heading.textContent = "Windowed Fullscreen";
  root.appendChild(heading);

  // --- Status line ----------------------------------------------------------
  const statusList = doc.createElement("dl");
  statusList.className = "wfs-popup__status";
  appendStatusRow(
    doc,
    statusList,
    "Supported site",
    describeSite(status),
    "wfs-status-site",
    status.siteSupported,
  );
  root.appendChild(statusList);

  // --- Toggle button --------------------------------------------------------
  // Replaces the old read-only "Active/Inactive" row: same information, but it
  // also *does* the thing — a mouse alternative to the keyboard shortcut that
  // works on any site with a registered adapter.
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.id = "wfs-toggle";
  toggle.className = "wfs-popup__toggle";
  toggle.textContent = toggleLabel(status);
  const enabled = toggleEnabled(status);
  toggle.disabled = !enabled;
  if (status.modeActive) {
    toggle.classList.add("is-active");
  }
  if (enabled) {
    toggle.addEventListener("click", () => actions.toggle());
  }
  root.appendChild(toggle);
}

/** Append a `<dt>/<dd>` status row carrying a state-reflecting class. */
function appendStatusRow(
  doc: Document,
  list: HTMLElement,
  label: string,
  value: string,
  valueId: string,
  on: boolean,
): void {
  const term = doc.createElement("dt");
  term.textContent = label;

  const detail = doc.createElement("dd");
  detail.id = valueId;
  detail.textContent = value;
  detail.classList.add(on ? "is-on" : "is-off");

  list.appendChild(term);
  list.appendChild(detail);
}

/**
 * Options Page — rendering, validation, and persistence (Requirement 5).
 *
 * This module holds the testable core of the Options_Page. It is deliberately
 * decoupled from the ambient browser: the {@link OptionsPage} class accepts an
 * injected {@link PreferenceStore}, a {@link Document}, and the list of
 * Supported_Site ids (the registry's adapter `siteId`s). This lets jsdom tests
 * render the page and drive changes without a real extension runtime, while the
 * DOM-wiring entry (`main.ts`) stays thin.
 *
 * Behavior implemented here:
 * - Render one control per preference: a per-Supported_Site auto-apply checkbox
 *   for every Supported_Site, plus a shortcut-configuration control linking to
 *   the browser shortcuts page (Req 5.1, 5.2).
 * - On open, fill each control from the effective value — the stored value when
 *   one exists, otherwise the documented default (Req 5.4, 5.5). The store
 *   already resolves defaults on absence/corruption.
 * - On a valid change, persist within budget and show a saved confirmation
 *   (Req 5.3).
 * - On invalid input, reject the change, retain the previously persisted value,
 *   and show an error identifying the invalid input (Req 5.6).
 * - On persistence failure, retain the previously persisted value and show a
 *   not-saved error (Req 5.7).
 */

import type { PreferenceStore } from "../preferences/store.js";
import { DONATION_URL } from "../shared/donation.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The browser page where custom keyboard shortcuts are configured (Req 5.2). */
export const SHORTCUTS_URL = "chrome://extensions/shortcuts";

/** The hosted privacy policy for this extension, surfaced in the UI for trust. */
export const PRIVACY_POLICY_URL =
  "https://rohittiger.vercel.app/product/windowedfullscreen/privacy";

/** The external Donation_Link destination shown on the Options_Page (Req 8). */
export { DONATION_URL };

/** Marker attributes used to locate rendered controls (also handy for tests). */
export const ATTR = {
  /** Per-site auto-apply checkbox; carries `data-site-id`. */
  autoApply: "data-wfs-autoapply",
  /** A per-site section wrapper; carries `data-site-id`. */
  siteSection: "data-wfs-site-section",
  /** The shortcut-configuration link. */
  shortcutLink: "data-wfs-shortcut-link",
  /** The Donation_Link (Req 8.1). */
  donationLink: "data-wfs-donation-link",
  /** The privacy-policy link. */
  privacyLink: "data-wfs-privacy-link",
  /** The saved-confirmation status region. */
  status: "data-wfs-status",
  /** The error region. */
  error: "data-wfs-error",
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Result of validating a raw control value (Req 5.6). */
export type ControlValidationResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string };

/**
 * Validate a raw auto-apply control value. Auto-apply is a boolean preference,
 * so its only valid inputs are `true` and `false` (Req 5.1). Any other value is
 * rejected with a message identifying the invalid input (Req 5.6).
 */
export function validateAutoApply(raw: unknown): ControlValidationResult {
  if (typeof raw === "boolean") {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: `auto-apply must be true or false, received ${describeValue(raw)}`,
  };
}

function describeValue(raw: unknown): string {
  if (raw === null) return "null";
  if (typeof raw === "string") return `"${raw}"`;
  if (typeof raw === "object") return Object.prototype.toString.call(raw);
  return String(raw);
}

// ---------------------------------------------------------------------------
// Change outcome (returned from applyAutoApplyChange so callers/tests can react)
// ---------------------------------------------------------------------------

export type ApplyChangeResult =
  | { ok: true; value: boolean }
  | { ok: false; reason: "invalid" | "persist-failed"; error: string };

// ---------------------------------------------------------------------------
// Donation_Link opener (injected so tests can simulate success/failure)
// ---------------------------------------------------------------------------

/**
 * Opens the external donation page (Req 8.3). Returning a falsy value (e.g.
 * `window.open` returning `null` when blocked) or throwing/rejecting signals an
 * open failure (Req 8.4). May be synchronous or asynchronous.
 *
 * Defaults are supplied by `main.ts` against the real browser (e.g.
 * `chrome.tabs.create({ url, active: true })` or `window.open(url, "_blank")`).
 */
export type DonationOpener = (url: string) => unknown;

/**
 * Opens the browser's keyboard-shortcuts page (Req 5.2). Anchor navigation to
 * `chrome://` URLs is blocked by the browser, so the shortcut control delegates
 * to this injected opener instead of relying on the link's `href`. Returning a
 * falsy value or throwing/rejecting signals an open failure. May be synchronous
 * or asynchronous.
 *
 * The real opener is wired in `main.ts` (e.g.
 * `chrome.tabs.create({ url, active: true })`).
 */
export type ShortcutOpener = (url: string) => unknown;

// ---------------------------------------------------------------------------
// Options page
// ---------------------------------------------------------------------------

export interface OptionsPageOptions {
  /** The document to render into and read controls from. */
  document: Document;
  /** The injected preference store (real or in-memory stub). */
  store: PreferenceStore;
  /** Supported_Site ids, driven by the adapter registry's `siteId`s. */
  siteIds: string[];
  /** Optional render root; defaults to `#app` then `document.body`. */
  root?: Element | null;
  /** Override the shortcuts URL (defaults to {@link SHORTCUTS_URL}). */
  shortcutsUrl?: string;
  /** Human-readable label per site id; falls back to the id. */
  siteLabels?: Record<string, string>;
  /** Override the Donation_Link URL (defaults to {@link DONATION_URL}). */
  donationUrl?: string;
  /** Override the privacy-policy URL (defaults to {@link PRIVACY_POLICY_URL}). */
  privacyUrl?: string;
  /**
   * Whether to render the top-level page heading. Defaults to `true` for the
   * standalone Options_Page. The Popup embeds these controls beneath its own
   * title, so it passes `false` to avoid a redundant heading.
   */
  showHeading?: boolean;
  /**
   * How to open the external donation page on activation (Req 8.3). Injected so
   * tests can simulate success and failure; defaults to a no-op opener that
   * reports failure (the real opener is wired in `main.ts`).
   */
  openDonation?: DonationOpener;
  /**
   * How to open the browser's keyboard-shortcuts page on activation (Req 5.2).
   * Injected because anchor navigation to `chrome://` URLs is blocked by the
   * browser. Defaults to a no-op opener that reports failure; `main.ts` wires
   * the real opener.
   */
  openShortcuts?: ShortcutOpener;
}

/**
 * Renders the Options_Page controls and owns their validation + persistence.
 *
 * Usage:
 *   const page = new OptionsPage({ document, store, siteIds });
 *   await page.render();
 *
 * Tests can call {@link applyAutoApplyChange} directly to exercise validation,
 * persistence success, persistence failure, and prior-value retention without
 * synthesizing DOM events.
 */
export class OptionsPage {
  private readonly document: Document;
  private readonly store: PreferenceStore;
  private readonly siteIds: string[];
  private readonly shortcutsUrl: string;
  private readonly siteLabels: Record<string, string>;
  private readonly explicitRoot: Element | null;
  private readonly donationUrl: string;
  private readonly privacyUrl: string;
  private readonly showHeading: boolean;
  private readonly openDonation: DonationOpener;
  private readonly openShortcuts: ShortcutOpener;

  /** The last value successfully persisted per site (the "prior value"). */
  private readonly persisted = new Map<string, boolean>();

  private root!: Element;
  private statusEl!: HTMLElement;
  private errorEl!: HTMLElement;

  constructor(options: OptionsPageOptions) {
    this.document = options.document;
    this.store = options.store;
    // Defensive copy so external mutation of the array can't change the UI.
    this.siteIds = [...options.siteIds];
    this.shortcutsUrl = options.shortcutsUrl ?? SHORTCUTS_URL;
    this.siteLabels = options.siteLabels ?? {};
    this.explicitRoot = options.root ?? null;
    this.donationUrl = options.donationUrl ?? DONATION_URL;
    this.privacyUrl = options.privacyUrl ?? PRIVACY_POLICY_URL;
    this.showHeading = options.showHeading ?? true;
    // Default opener reports failure so a misconfigured wiring surfaces an error
    // rather than silently doing nothing; `main.ts` injects the real opener.
    this.openDonation = options.openDonation ?? (() => null);
    this.openShortcuts = options.openShortcuts ?? (() => null);
  }

  /**
   * Build the DOM controls and load each control's effective value (Req 5.1,
   * 5.2, 5.4, 5.5). Safe to call once on page open.
   */
  async render(): Promise<void> {
    this.root = this.resolveRoot();
    this.buildStaticDom();
    await this.loadValues();
  }

  /**
   * Apply a change to a site's auto-apply control: validate, persist, and update
   * the UI. Centralizes Req 5.3/5.6/5.7 so both the DOM change handler and tests
   * use the same path.
   *
   * @param siteId the Supported_Site id whose control changed
   * @param raw the raw candidate value (a boolean from a checkbox; tests may
   *            pass invalid values to exercise rejection)
   */
  async applyAutoApplyChange(siteId: string, raw: unknown): Promise<ApplyChangeResult> {
    const prior = this.persisted.get(siteId) ?? false;

    const validation = validateAutoApply(raw);
    if (!validation.ok) {
      // Reject, retain the previously persisted value, identify the input (5.6).
      this.restoreControl(siteId, prior);
      this.showError(`Invalid value for "${this.labelFor(siteId)}" auto-apply: ${validation.error}.`);
      return { ok: false, reason: "invalid", error: validation.error };
    }

    const result = await this.store.setSite(siteId, { autoApply: validation.value });
    if (!result.ok) {
      // Persistence failed: retain prior value, show a not-saved error (5.7).
      this.restoreControl(siteId, prior);
      this.showError(
        `Could not save auto-apply for "${this.labelFor(siteId)}": not saved (${result.error}).`,
      );
      return { ok: false, reason: "persist-failed", error: result.error };
    }

    // Success: record the new prior value, sync the control, confirm (5.3).
    this.persisted.set(siteId, validation.value);
    this.restoreControl(siteId, validation.value);
    this.showSaved(`Saved "${this.labelFor(siteId)}" auto-apply.`);
    return { ok: true, value: validation.value };
  }

  /** The auto-apply checkbox element for a site, or null if not rendered. */
  getAutoApplyControl(siteId: string): HTMLInputElement | null {
    // Use a static selector and match the site id by exact string comparison.
    // Interpolating an arbitrary siteId into a CSS attribute selector is
    // fragile (CSS-identifier escaping vs. attribute-value quoting), so we
    // enumerate candidates and compare the stored `data-site-id` directly.
    const candidates = this.root?.querySelectorAll<HTMLInputElement>(
      `input[${ATTR.autoApply}]`,
    );
    if (!candidates) return null;
    for (const candidate of candidates) {
      if (candidate.getAttribute("data-site-id") === siteId) {
        return candidate;
      }
    }
    return null;
  }

  /** The rendered Donation_Link element, or null if not rendered. */
  getDonationLink(): HTMLAnchorElement | null {
    return this.root?.querySelector<HTMLAnchorElement>(`a[${ATTR.donationLink}]`) ?? null;
  }

  /** The rendered shortcut-configuration link element, or null if not rendered. */
  getShortcutLink(): HTMLAnchorElement | null {
    return this.root?.querySelector<HTMLAnchorElement>(`a[${ATTR.shortcutLink}]`) ?? null;
  }

  /** The rendered privacy-policy link element, or null if not rendered. */
  getPrivacyLink(): HTMLAnchorElement | null {
    return this.root?.querySelector<HTMLAnchorElement>(`a[${ATTR.privacyLink}]`) ?? null;
  }

  /**
   * Activate the shortcut-configuration control: open the browser's keyboard
   * shortcuts page via the injected opener (Req 5.2). Anchor navigation to
   * `chrome://` URLs is blocked by the browser, so this delegates to
   * {@link ShortcutOpener}. On failure — the opener throws, rejects, or returns
   * a falsy value — show an error and leave the page otherwise unchanged.
   *
   * @returns `true` when the page opened, `false` on open failure.
   */
  async activateShortcuts(): Promise<boolean> {
    try {
      const result = await this.openShortcuts(this.shortcutsUrl);
      if (!result) {
        this.showError("Could not open the keyboard shortcuts page. Please try again later.");
        return false;
      }
      return true;
    } catch {
      this.showError("Could not open the keyboard shortcuts page. Please try again later.");
      return false;
    }
  }

  /**
   * Activate the Donation_Link: open the external donation page in a new tab via
   * the injected opener (Req 8.3). On failure — the opener throws, rejects, or
   * returns a falsy value (e.g. `window.open` returning `null`) — show an error
   * indicating the donation page could not be opened and leave the page
   * otherwise unchanged (Req 8.4).
   *
   * @returns `true` when the page opened, `false` on open failure.
   */
  async activateDonation(): Promise<boolean> {
    try {
      const result = await this.openDonation(this.donationUrl);
      if (!result) {
        this.showError("Could not open the donation page. Please try again later.");
        return false;
      }
      return true;
    } catch {
      this.showError("Could not open the donation page. Please try again later.");
      return false;
    }
  }

  /** Current saved-confirmation text (empty when none). */
  get statusMessage(): string {
    return this.statusEl?.textContent ?? "";
  }

  /** Current error text (empty when none). */
  get errorMessage(): string {
    return this.errorEl?.textContent ?? "";
  }

  /** Display an error message in the error region (also used for load errors). */
  showError(message: string): void {
    this.errorEl.textContent = message;
    // A fresh error supersedes any stale saved confirmation.
    this.statusEl.textContent = "";
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolveRoot(): Element {
    if (this.explicitRoot) return this.explicitRoot;
    return this.document.getElementById("app") ?? this.document.body;
  }

  private buildStaticDom(): void {
    const doc = this.document;
    this.root.replaceChildren();

    if (this.showHeading) {
      const heading = doc.createElement("h1");
      heading.textContent = "Windowed Fullscreen — Options";
      this.root.appendChild(heading);
    }

    // Shortcut-configuration control (Req 5.2).
    const shortcutSection = doc.createElement("section");
    shortcutSection.setAttribute("data-wfs-shortcut-section", "");
    const shortcutHeading = doc.createElement("h2");
    shortcutHeading.textContent = "Keyboard shortcut";
    shortcutSection.appendChild(shortcutHeading);

    const shortcutLink = doc.createElement("a");
    shortcutLink.setAttribute(ATTR.shortcutLink, "");
    shortcutLink.href = this.shortcutsUrl;
    shortcutLink.target = "_blank";
    shortcutLink.rel = "noopener";
    shortcutLink.textContent = "Configure the keyboard shortcut";
    shortcutLink.addEventListener("click", (event) => {
      // Anchor navigation to chrome:// URLs is blocked by the browser, so the
      // injected opener performs the navigation and can report failures (Req 5.2).
      event.preventDefault();
      void this.activateShortcuts();
    });
    shortcutSection.appendChild(shortcutLink);

    const shortcutHelp = doc.createElement("p");
    shortcutHelp.textContent =
      "Opens the browser's shortcuts page. A valid combination uses at least one modifier key (Ctrl, Alt, Shift, or Command) plus exactly one other key.";
    shortcutSection.appendChild(shortcutHelp);
    this.root.appendChild(shortcutSection);

    // Donation_Link: always visible and activatable while the page is shown
    // (Req 8.1, 8.2). Activation opens the external page in a new tab (Req 8.3).
    const donationSection = doc.createElement("section");
    donationSection.setAttribute("data-wfs-donation-section", "");
    const donationHeading = doc.createElement("h2");
    donationHeading.textContent = "Support this extension";
    donationSection.appendChild(donationHeading);

    const donationLink = doc.createElement("a");
    donationLink.setAttribute(ATTR.donationLink, "");
    donationLink.href = this.donationUrl;
    donationLink.target = "_blank";
    donationLink.rel = "noopener noreferrer";
    // Visible text label identifying it as a donation link (Req 8.1).
    donationLink.textContent = "Support this extension (donate)";
    donationLink.addEventListener("click", (event) => {
      // The injected opener performs the navigation so the page controls how the
      // external donation page is opened and can report failures (Req 8.3, 8.4).
      event.preventDefault();
      void this.activateDonation();
    });
    donationSection.appendChild(donationLink);
    this.root.appendChild(donationSection);

    // One per-site section with an auto-apply checkbox (Req 5.1).
    for (const siteId of this.siteIds) {
      const section = doc.createElement("section");
      section.setAttribute(ATTR.siteSection, "");
      section.setAttribute("data-site-id", siteId);

      const siteHeading = doc.createElement("h2");
      siteHeading.textContent = this.labelFor(siteId);
      section.appendChild(siteHeading);

      const label = doc.createElement("label");
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute(ATTR.autoApply, "");
      checkbox.setAttribute("data-site-id", siteId);
      const labelText = ` Automatically enter windowed fullscreen on ${this.labelFor(siteId)}`;
      checkbox.setAttribute("aria-label", `Auto-apply windowed fullscreen on ${this.labelFor(siteId)}`);

      checkbox.addEventListener("change", () => {
        void this.applyAutoApplyChange(siteId, checkbox.checked);
      });

      label.appendChild(checkbox);
      label.appendChild(doc.createTextNode(labelText));
      section.appendChild(label);
      this.root.appendChild(section);
    }

    // Saved-confirmation region (Req 5.3) and error region (Req 5.6, 5.7).
    this.statusEl = doc.createElement("div");
    this.statusEl.setAttribute(ATTR.status, "");
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.root.appendChild(this.statusEl);

    this.errorEl = doc.createElement("div");
    this.errorEl.setAttribute(ATTR.error, "");
    this.errorEl.setAttribute("role", "alert");
    this.errorEl.setAttribute("aria-live", "assertive");
    this.root.appendChild(this.errorEl);

    // Small privacy-policy hyperlink in the bottom-right corner. Kept minimal
    // (no heading or description) — just an unobtrusive footer link. Inline
    // styles keep it right-aligned and subtle in both the Options_Page and the
    // embedded Popup without relying on external CSS.
    const footer = doc.createElement("div");
    footer.style.cssText = "text-align:right;margin-top:12px;font-size:12px;";
    const privacyLink = doc.createElement("a");
    privacyLink.setAttribute(ATTR.privacyLink, "");
    privacyLink.href = this.privacyUrl;
    privacyLink.target = "_blank";
    privacyLink.rel = "noopener noreferrer";
    privacyLink.textContent = "Privacy policy";
    footer.appendChild(privacyLink);
    this.root.appendChild(footer);
  }

  /**
   * Fill each control from its effective value: the stored value when present,
   * otherwise the documented default (Req 5.4, 5.5). `store.getSite` already
   * returns documented defaults on absence/corruption.
   */
  private async loadValues(): Promise<void> {
    for (const siteId of this.siteIds) {
      const prefs = await this.store.getSite(siteId);
      this.persisted.set(siteId, prefs.autoApply);
      this.restoreControl(siteId, prefs.autoApply);
    }
  }

  /** Set a control's checked state to the given value. */
  private restoreControl(siteId: string, value: boolean): void {
    const control = this.getAutoApplyControl(siteId);
    if (control) {
      control.checked = value;
    }
  }

  private showSaved(message: string): void {
    this.statusEl.textContent = message;
    // A successful save clears any prior error.
    this.errorEl.textContent = "";
  }

  private labelFor(siteId: string): string {
    return this.siteLabels[siteId] ?? siteId;
  }
}

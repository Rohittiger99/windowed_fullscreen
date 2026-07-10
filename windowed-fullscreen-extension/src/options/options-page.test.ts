import { describe, expect, it, vi } from "vitest";

import {
  ATTR,
  DONATION_URL,
  OptionsPage,
  SHORTCUTS_URL,
} from "./options-page.js";
import {
  createPreferenceStore,
  siteKey,
  type PreferenceStore,
  type StorageArea,
} from "../preferences/store.js";
import { DEFAULT_SITE_PREFS, type SitePrefs, type WriteResult } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory `chrome.storage` area. `get(key)` returns `{ [key]: value }`
 * when seeded and `{}` (absent) otherwise; `set` records the write. Sites left
 * unseeded resolve to documented defaults via the real Preference Store.
 */
function memoryArea(seed: Record<string, unknown> = {}): StorageArea {
  const data: Record<string, unknown> = { ...seed };
  return {
    get: (key: string) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
}

/** Build an in-memory PreferenceStore backed by `area` (sync), no local area. */
function memoryStore(area: StorageArea): PreferenceStore {
  return createPreferenceStore({ backend: { sync: area, local: null } });
}

/**
 * A stub store whose `setSite` always reports a persistence failure (Req 5.7).
 * `getSite` returns documented defaults so the page can render and load.
 */
function failingStore(error = "quota exceeded"): PreferenceStore {
  return {
    getGlobal: () => Promise.resolve({ schemaVersion: 1 }),
    setGlobal: () => Promise.resolve<WriteResult>({ ok: false, error }),
    getSite: (siteId: string) =>
      Promise.resolve<SitePrefs>({ siteId, ...DEFAULT_SITE_PREFS }),
    setSite: () => Promise.resolve<WriteResult>({ ok: false, error }),
  };
}

/** Fresh jsdom document + render root so no state leaks across tests. */
function freshRoot(): { doc: Document; root: HTMLElement } {
  const doc = document.implementation.createHTMLDocument("options");
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root };
}

const SITE = "youtube";

// ---------------------------------------------------------------------------
// Shortcut configuration control (Req 5.2)
// ---------------------------------------------------------------------------

describe("OptionsPage — shortcut configuration control (Req 5.2)", () => {
  it("renders a shortcut link pointing at the browser shortcuts page", async () => {
    const { doc, root } = freshRoot();
    const page = new OptionsPage({
      document: doc,
      store: memoryStore(memoryArea()),
      siteIds: [SITE],
      root,
    });
    await page.render();

    const link = root.querySelector<HTMLAnchorElement>(`a[${ATTR.shortcutLink}]`);
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(SHORTCUTS_URL);
    // A visible label so users can find the control.
    expect(link!.textContent?.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence success with confirmation (Req 5.3)
// ---------------------------------------------------------------------------

describe("OptionsPage — valid change persists with confirmation (Req 5.3)", () => {
  it("persists the new value and shows a saved confirmation", async () => {
    const { doc, root } = freshRoot();
    const area = memoryArea();
    const store = memoryStore(area);
    const page = new OptionsPage({ document: doc, store, siteIds: [SITE], root });
    await page.render();

    const result = await page.applyAutoApplyChange(SITE, true);

    expect(result).toEqual({ ok: true, value: true });
    // The store round-trips the persisted value.
    const reread = await store.getSite(SITE);
    expect(reread.autoApply).toBe(true);
    // A saved confirmation is shown; no error.
    expect(page.statusMessage.length).toBeGreaterThan(0);
    expect(page.statusMessage.toLowerCase()).toContain("saved");
    expect(page.errorMessage).toBe("");
    // The control reflects the saved value.
    expect(page.getAutoApplyControl(SITE)!.checked).toBe(true);
  });

  it("writes the value through to the underlying storage backend", async () => {
    const { doc, root } = freshRoot();
    const area = memoryArea();
    const setSpy = vi.spyOn(area, "set");
    const page = new OptionsPage({
      document: doc,
      store: memoryStore(area),
      siteIds: [SITE],
      root,
    });
    await page.render();

    await page.applyAutoApplyChange(SITE, true);

    expect(setSpy).toHaveBeenCalledWith({
      [siteKey(SITE)]: expect.objectContaining({ siteId: SITE, autoApply: true }),
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence failure error (Req 5.7)
// ---------------------------------------------------------------------------

describe("OptionsPage — persistence failure retains prior value and shows error (Req 5.7)", () => {
  it("returns persist-failed, retains the prior value, and surfaces a not-saved error", async () => {
    const { doc, root } = freshRoot();
    const store = failingStore("disk full");
    const page = new OptionsPage({ document: doc, store, siteIds: [SITE], root });
    await page.render();

    // Prior persisted value is the documented default (false).
    expect(page.getAutoApplyControl(SITE)!.checked).toBe(false);

    const result = await page.applyAutoApplyChange(SITE, true);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "persist-failed" });
    // Prior value retained on the control.
    expect(page.getAutoApplyControl(SITE)!.checked).toBe(false);
    // An error is shown indicating the value was not saved; no saved confirmation.
    expect(page.errorMessage.length).toBeGreaterThan(0);
    expect(page.errorMessage.toLowerCase()).toContain("not saved");
    expect(page.statusMessage).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Donation link (Req 8.1, 8.2, 8.3, 8.4)
// ---------------------------------------------------------------------------

describe("OptionsPage — donation link", () => {
  function makePage(openDonation?: (url: string) => unknown) {
    const { doc, root } = freshRoot();
    const page = new OptionsPage({
      document: doc,
      store: memoryStore(memoryArea()),
      siteIds: [SITE],
      root,
      openDonation,
    });
    return { doc, root, page };
  }

  it("renders a visible donation link with a label and the donation URL (Req 8.1, 8.2)", async () => {
    const { page } = makePage();
    await page.render();

    const link = page.getDonationLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(DONATION_URL);
    // Visible text label identifying it as a donation link (Req 8.1).
    expect(link!.textContent?.trim().length).toBeGreaterThan(0);
    // Opens in a new tab so the Options_Page stays open (Req 8.2/8.3).
    expect(link!.target).toBe("_blank");
  });

  it("opens a new tab via the injected opener and leaves the page unchanged on success (Req 8.3)", async () => {
    const openDonation = vi.fn((_url: string) => true);
    const { page } = makePage(openDonation);
    await page.render();

    const opened = await page.activateDonation();

    expect(opened).toBe(true);
    expect(openDonation).toHaveBeenCalledTimes(1);
    expect(openDonation).toHaveBeenCalledWith(DONATION_URL);
    // Page otherwise unchanged: no status or error messages.
    expect(page.statusMessage).toBe("");
    expect(page.errorMessage).toBe("");
    // The link remains present and activatable (Req 8.2).
    expect(page.getDonationLink()).not.toBeNull();
  });

  it("shows an error when the opener returns a falsy value (Req 8.4)", async () => {
    const openDonation = vi.fn((_url: string) => null);
    const { page } = makePage(openDonation);
    await page.render();

    const opened = await page.activateDonation();

    expect(opened).toBe(false);
    expect(openDonation).toHaveBeenCalledWith(DONATION_URL);
    expect(page.errorMessage.toLowerCase()).toContain("donation");
    // Page otherwise unchanged: link still present, no saved confirmation.
    expect(page.statusMessage).toBe("");
    expect(page.getDonationLink()).not.toBeNull();
  });

  it("shows an error when the opener throws (Req 8.4)", async () => {
    const openDonation = vi.fn((_url: string) => {
      throw new Error("popup blocked");
    });
    const { page } = makePage(openDonation);
    await page.render();

    const opened = await page.activateDonation();

    expect(opened).toBe(false);
    expect(page.errorMessage.toLowerCase()).toContain("donation");
    expect(page.statusMessage).toBe("");
    expect(page.getDonationLink()).not.toBeNull();
  });

  it("activates the donation opener on link click and prevents default navigation (Req 8.3)", async () => {
    const openDonation = vi.fn((_url: string) => true);
    const { page } = makePage(openDonation);
    await page.render();

    const link = page.getDonationLink()!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openDonation).toHaveBeenCalledWith(DONATION_URL);
  });
});

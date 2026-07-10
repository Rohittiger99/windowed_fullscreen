import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createPreferenceStore,
  siteKey,
  type PreferenceLoadError,
  type StorageArea,
} from "./store.js";
import { DEFAULT_SITE_PREFS } from "../shared/types.js";

// ---------------------------------------------------------------------------
// In-memory StorageArea stubs (design: chrome.storage replaced with an
// in-memory stub that can be configured to fail, supporting Properties 10–12).
// ---------------------------------------------------------------------------

/** A storage area that holds nothing: every key reads back as absent. */
function emptyArea(): StorageArea {
  return {
    get: async () => ({}),
    set: async () => {},
  };
}

/** A storage area whose reads always throw (storage unavailable). */
function unavailableArea(): StorageArea {
  return {
    get: async () => {
      throw new Error("storage unavailable");
    },
    set: async () => {
      throw new Error("storage unavailable");
    },
  };
}

/** A storage area that returns a malformed/corrupt value for the requested key. */
function corruptArea(corruptValue: unknown): StorageArea {
  return {
    get: async (key: string) => ({ [key]: corruptValue }),
    set: async () => {},
  };
}

// Arbitrary non-empty site ids.
const siteIdArb = fc.string({ minLength: 1, maxLength: 40 });

// Arbitrary values that are NOT valid SitePrefs (corrupt). Valid SitePrefs
// requires a record with a string `siteId` and a boolean `autoApply`; every
// value generated here violates that contract so the store treats it as
// corrupt and falls back to defaults.
const corruptValueArb = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.anything()),
  fc.record({ siteId: fc.integer() }),
  fc.record({ autoApply: fc.string() }),
  fc.record({ siteId: fc.string(), autoApply: fc.integer() }),
  fc.record({ unrelated: fc.anything() }),
  fc.constant({}),
);

describe("PreferenceStore — Property 11: defaults when absent or unreadable", () => {
  // Feature: windowed-fullscreen-extension, Property 11: For any site id with no stored value, reading site preferences returns the documented default values; and for any site id when the Preference_Store read fails or returns corrupt data, reading returns the documented defaults and signals a load error.
  // Validates: Requirements 4.7, 4.4
  it("returns defaults silently when absent, and defaults + load error when unavailable or corrupt", async () => {
    await fc.assert(
      fc.asyncProperty(siteIdArb, corruptValueArb, async (siteId, corruptValue) => {
        // --- Case 1: absent value -> documented defaults, no load error (Req 4.7) ---
        {
          const errors: PreferenceLoadError[] = [];
          const store = createPreferenceStore({
            backend: { sync: emptyArea(), local: emptyArea() },
            onLoadError: (e) => errors.push(e),
          });
          const prefs = await store.getSite(siteId);
          expect(prefs).toEqual({ siteId, ...DEFAULT_SITE_PREFS });
          expect(errors).toHaveLength(0);
        }

        // --- Case 2: storage unavailable -> defaults + "unavailable" load error (Req 4.4) ---
        {
          const errors: PreferenceLoadError[] = [];
          const store = createPreferenceStore({
            backend: { sync: unavailableArea(), local: unavailableArea() },
            onLoadError: (e) => errors.push(e),
          });
          const prefs = await store.getSite(siteId);
          expect(prefs).toEqual({ siteId, ...DEFAULT_SITE_PREFS });
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({
            reason: "unavailable",
            key: siteKey(siteId),
          });
        }

        // --- Case 3: corrupt data -> defaults + "corrupt" load error (Req 4.4) ---
        {
          const errors: PreferenceLoadError[] = [];
          const store = createPreferenceStore({
            backend: { sync: corruptArea(corruptValue), local: null },
            onLoadError: (e) => errors.push(e),
          });
          const prefs = await store.getSite(siteId);
          expect(prefs).toEqual({ siteId, ...DEFAULT_SITE_PREFS });
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({
            reason: "corrupt",
            key: siteKey(siteId),
          });
        }
      }),
      { numRuns: 100 },
    );
  });
});

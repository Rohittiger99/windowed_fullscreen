import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createPreferenceStore,
  siteKey,
  type StorageArea,
  type StorageBackend,
} from "./store.js";
import type { SitePrefs } from "../shared/types.js";

/**
 * A StorageArea backed by an in-memory map whose `set` always throws, used to
 * simulate a write failure while still allowing reads of the seeded prior
 * value. Reads return a snapshot of the seeded data so a failed write can be
 * verified to have left storage untouched.
 */
function failingWriteArea(seed: Record<string, unknown>): StorageArea {
  // Defensive copy so the test can assert the seed is never mutated by a write.
  const data: Record<string, unknown> = { ...seed };
  return {
    get: (key: string) =>
      Promise.resolve(
        key in data ? ({ [key]: data[key] } as Record<string, unknown>) : {},
      ),
    set: () => Promise.reject(new Error("simulated write failure")),
  };
}

describe("PreferenceStore write failure", () => {
  // Feature: windowed-fullscreen-extension, Property 12: Write failure retains the prior value
  // For any currently stored preference value and any new value, when the
  // Preference_Store write fails, the stored value remains the prior value and
  // the write reports failure.
  // **Validates: Requirements 4.2**
  it("retains the prior value and reports failure when the write fails", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A non-empty site id.
        fc.string({ minLength: 1 }),
        // The currently stored (prior) value.
        fc.boolean(),
        // The new value the caller attempts to write.
        fc.boolean(),
        async (siteId, priorAutoApply, newAutoApply) => {
          const key = siteKey(siteId);
          const prior: SitePrefs = { siteId, autoApply: priorAutoApply };

          // Seed both areas with the prior value; both fail on write so the
          // store exhausts sync then local and reports failure (Req 4.2).
          const seed = { [key]: prior };
          const backend: StorageBackend = {
            sync: failingWriteArea(seed),
            local: failingWriteArea(seed),
          };
          const store = createPreferenceStore({ backend });

          const result = await store.setSite(siteId, {
            autoApply: newAutoApply,
          });

          // The write reports failure.
          expect(result.ok).toBe(false);

          // The stored value remains the prior value (storage untouched).
          const readBack = await store.getSite(siteId);
          expect(readBack).toEqual(prior);
        },
      ),
      { numRuns: 100 },
    );
  });
});

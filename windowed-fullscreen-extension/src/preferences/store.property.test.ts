import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createPreferenceStore, type StorageArea } from "./store.js";
import { type SitePrefs } from "../shared/types.js";

// ---------------------------------------------------------------------------
// In-memory chrome.storage StorageArea stub
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory implementation of the `StorageArea` contract used by the
 * Preference Store. Mirrors the promise-based `chrome.storage` area shape:
 * `get(key)` returns `{ [key]: value }` when present (and `{}` otherwise) and
 * `set(items)` merges the items into the backing record.
 */
function createInMemoryArea(): StorageArea {
  const data: Record<string, unknown> = {};
  return {
    get: (key: string) =>
      Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
}

// A valid SitePrefs value for a given site id (siteId is forced by the store,
// so we only need to generate the remaining fields).
const sitePrefsValueArb: fc.Arbitrary<Omit<SitePrefs, "siteId">> = fc.record({
  autoApply: fc.boolean(),
});

// Two guaranteed-distinct site ids: disjoint prefixes ensure siteA !== siteB
// for any generated suffixes, so the isolation case always has distinct sites
// without discarding runs via preconditions.
const distinctSiteIdsArb: fc.Arbitrary<[string, string]> = fc
  .tuple(
    fc.string({ minLength: 0, maxLength: 24 }),
    fc.string({ minLength: 0, maxLength: 24 }),
  )
  .map(([a, b]) => [`a:${a}`, `b:${b}`] as [string, string]);

describe("PreferenceStore — Property 10", () => {
  // Feature: windowed-fullscreen-extension, Property 10: Preference write/read round-trip with per-site isolation — For any site id and any valid SitePrefs value, writing the value and then reading it back returns an equal value; and for any two distinct site ids with arbitrary values, writing one site's preferences leaves the other site's stored preferences unchanged.
  // Validates: Requirements 4.1, 4.6
  it("round-trips per-site preferences and isolates distinct sites", async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctSiteIdsArb,
        sitePrefsValueArb,
        sitePrefsValueArb,
        async ([siteA, siteB], valueA, valueB) => {
          const store = createPreferenceStore({
            backend: { sync: createInMemoryArea(), local: null },
          });

          // --- Round-trip: write site A, read it back, expect equality.
          const writeA = await store.setSite(siteA, valueA);
          expect(writeA.ok).toBe(true);

          const readA = await store.getSite(siteA);
          const expectedA: SitePrefs = { siteId: siteA, ...valueA };
          expect(readA).toEqual(expectedA);

          // --- Per-site isolation: establish site B, snapshot it, then write A.
          const writeB = await store.setSite(siteB, valueB);
          expect(writeB.ok).toBe(true);
          const siteBBefore = await store.getSite(siteB);

          const writeA2 = await store.setSite(siteA, valueA);
          expect(writeA2.ok).toBe(true);

          const siteBAfter = await store.getSite(siteB);
          expect(siteBAfter).toEqual(siteBBefore);
          // Site B retains its own value, never site A's.
          expect(siteBAfter).toEqual({ siteId: siteB, ...valueB });
        },
      ),
      { numRuns: 100 },
    );
  });
});

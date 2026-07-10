import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { OptionsPage } from "./options-page.js";
import { createPreferenceStore, siteKey, type StorageArea } from "../preferences/store.js";
import { DEFAULT_SITE_PREFS } from "../shared/types.js";

// ---------------------------------------------------------------------------
// In-memory chrome.storage StorageArea stub
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory `StorageArea` seeded with the given records. Mirrors the
 * promise-based `chrome.storage` area shape so the real Preference Store reads
 * through it: `get(key)` returns `{ [key]: value }` when the key was seeded and
 * `{}` (absent) otherwise. Sites left unseeded therefore resolve to documented
 * defaults via the store, which is exactly the "no stored value" case.
 */
function seededArea(seed: Record<string, unknown>): StorageArea {
  const data: Record<string, unknown> = { ...seed };
  return {
    get: (key: string) =>
      Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A set of Supported_Sites, each either with a stored auto-apply boolean or no
 * stored value at all (`stored === undefined`). Index-prefixing the generated
 * base guarantees the site ids are distinct without discarding runs, so each
 * control maps to exactly one site.
 */
const siteSetArb: fc.Arbitrary<Array<{ siteId: string; stored: boolean | undefined }>> = fc
  .array(
    fc.record({
      base: fc.string({ maxLength: 12 }),
      stored: fc.option(fc.boolean(), { nil: undefined }),
    }),
    { maxLength: 6 },
  )
  .map((arr) =>
    arr.map((s, i) => ({ siteId: `s${i}:${s.base}`, stored: s.stored })),
  );

describe("OptionsPage — Property 13", () => {
  // Feature: windowed-fullscreen-extension, Property 13: Options controls reflect the effective value — For any set of stored preferences (including missing entries), opening the Options_Page displays, for each control, the stored value when one exists and the documented default when none exists.
  // Validates: Requirements 5.4, 5.5
  it("loads each control's effective value (stored when present, documented default otherwise)", async () => {
    await fc.assert(
      fc.asyncProperty(siteSetArb, async (sites) => {
        // Seed the backend only for sites that have a stored value; others stay
        // absent so the store returns the documented default for them.
        const seed: Record<string, unknown> = {};
        for (const { siteId, stored } of sites) {
          if (stored !== undefined) {
            seed[siteKey(siteId)] = { siteId, autoApply: stored };
          }
        }

        const store = createPreferenceStore({
          backend: { sync: seededArea(seed), local: null },
        });

        // Fresh jsdom document + root per run so no state leaks across runs.
        const doc = document.implementation.createHTMLDocument("options");
        const root = doc.createElement("div");
        doc.body.appendChild(root);

        const page = new OptionsPage({
          document: doc,
          store,
          siteIds: sites.map((s) => s.siteId),
          root,
        });
        await page.render();

        for (const { siteId, stored } of sites) {
          const control = page.getAutoApplyControl(siteId);
          expect(control).not.toBeNull();
          const effective = stored !== undefined ? stored : DEFAULT_SITE_PREFS.autoApply;
          expect(control!.checked).toBe(effective);
        }
      }),
      { numRuns: 100 },
    );
  });
});

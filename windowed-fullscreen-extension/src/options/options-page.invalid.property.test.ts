import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { OptionsPage } from "./options-page.js";
import { createPreferenceStore, type StorageArea } from "../preferences/store.js";
import { type SitePrefs } from "../shared/types.js";

// ---------------------------------------------------------------------------
// In-memory chrome.storage StorageArea stub
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory implementation of the `StorageArea` contract used by the
 * Preference Store. `get(key)` returns `{ [key]: value }` when present (and
 * `{}` otherwise); `set(items)` merges the items into the backing record.
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

/** Build a fresh jsdom document with an `#app` render root for each run. */
function freshDocument(): Document {
  const doc = document.implementation.createHTMLDocument("options");
  const app = doc.createElement("div");
  app.id = "app";
  doc.body.appendChild(app);
  return doc;
}

const SITE_ID = "example.com";

// Any input that is NOT a valid auto-apply value. Auto-apply's only valid
// inputs are the booleans `true`/`false`, so we generate strings, numbers,
// null, undefined, objects, and arrays, and exclude booleans defensively.
const invalidRawArb: fc.Arbitrary<unknown> = fc
  .oneof(
    fc.string(),
    fc.integer(),
    fc.double(),
    fc.constant(null),
    fc.constant(undefined),
    fc.object(),
    fc.array(fc.anything()),
  )
  .filter((v) => typeof v !== "boolean");

describe("OptionsPage — Property 14", () => {
  // Feature: windowed-fullscreen-extension, Property 14: Options rejects invalid input and retains the prior value — For any control and any input outside that control's valid input values, the Options_Page rejects the change, the persisted value remains the previously persisted value, and an error indication identifying the invalid input is shown.
  // Validates: Requirements 5.6
  it("rejects invalid input, retains the prior persisted value, and shows an error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        invalidRawArb,
        async (priorValue, invalidRaw) => {
          // Exclude booleans: only non-boolean inputs are "invalid" here.
          fc.pre(typeof invalidRaw !== "boolean");

          // Fresh document and store per run.
          const doc = freshDocument();
          const backend = { sync: createInMemoryArea(), local: null };
          const store = createPreferenceStore({ backend });

          // Seed the store with a prior valid auto-apply value, then render.
          const seed = await store.setSite(SITE_ID, { autoApply: priorValue });
          expect(seed.ok).toBe(true);

          const page = new OptionsPage({
            document: doc,
            store,
            siteIds: [SITE_ID],
          });
          await page.render();

          // The control reflects the seeded prior value before the change.
          expect(page.getAutoApplyControl(SITE_ID)?.checked).toBe(priorValue);

          // Apply the invalid change.
          const result = await page.applyAutoApplyChange(SITE_ID, invalidRaw);

          // 1) The change is rejected as invalid.
          expect(result.ok).toBe(false);
          expect(result.ok === false && result.reason).toBe("invalid");

          // 2) The persisted store value remains the previously persisted value.
          const persisted = await store.getSite(SITE_ID);
          const expected: SitePrefs = { siteId: SITE_ID, autoApply: priorValue };
          expect(persisted).toEqual(expected);

          // 3) The rendered control still reflects the prior value.
          expect(page.getAutoApplyControl(SITE_ID)?.checked).toBe(priorValue);

          // 4) An error indication identifying the invalid input is shown.
          expect(page.errorMessage.length).toBeGreaterThan(0);
          expect(page.errorMessage.toLowerCase()).toContain("auto-apply");
        },
      ),
      { numRuns: 100 },
    );
  });
});

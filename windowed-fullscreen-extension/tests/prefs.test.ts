// Preference storage: defaults, forward/backward compatibility, and the
// read-then-merge that keeps one setting from clobbering another.
//
// Storage is faked by assigning a minimal `chrome` to globalThis. The source
// reads `chrome.storage.local` through `storageArea()` at call time, so swapping
// the fake per test needs no injection seam.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SITE_PREFS,
  getSitePrefs,
  setSitePrefs,
  type SitePrefs,
} from "../src/windowed-fullscreen.ts";

type Store = Record<string, unknown>;

/** Install a working fake storage area, and return its backing object. */
function fakeStorage(initial: Store = {}): Store {
  const data: Store = { ...initial };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (entries: Store) => Object.assign(data, entries),
      },
    },
  };
  return data;
}

/** Install storage that throws, standing in for a revoked or broken area. */
function brokenStorage(): void {
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async () => {
          throw new Error("storage unavailable");
        },
        set: async () => {
          throw new Error("storage unavailable");
        },
      },
    },
  };
}

function noStorage(): void {
  delete (globalThis as Record<string, unknown>).chrome;
}

test("first run yields documented defaults and is not an error", async () => {
  fakeStorage();
  const { prefs, loadFailed } = await getSitePrefs("youtube");
  assert.deepEqual(prefs, DEFAULT_SITE_PREFS);
  assert.equal(loadFailed, false, "an empty store is a first run, not a failure");
});

test("round-trips a stored value", async () => {
  fakeStorage();
  await setSitePrefs("youtube", { autoApply: true, scrollable: true });
  const { prefs, loadFailed } = await getSitePrefs("youtube");
  assert.deepEqual(prefs, { autoApply: true, scrollable: true });
  assert.equal(loadFailed, false);
});

test("a patch leaves the fields it does not name alone", async () => {
  // The settings UI has one control per field. A whole-object write from either
  // control would silently reset the other.
  fakeStorage();
  await setSitePrefs("youtube", { autoApply: true, scrollable: true });

  await setSitePrefs("youtube", { scrollable: false });
  assert.deepEqual((await getSitePrefs("youtube")).prefs, { autoApply: true, scrollable: false });

  await setSitePrefs("youtube", { autoApply: false });
  assert.deepEqual((await getSitePrefs("youtube")).prefs, { autoApply: false, scrollable: false });
});

test("sites are namespaced, so writing one never disturbs another", async () => {
  const data = fakeStorage();
  await setSitePrefs("youtube", { autoApply: true });
  await setSitePrefs("vimeo", { autoApply: false, scrollable: true });

  assert.deepEqual((await getSitePrefs("youtube")).prefs, { autoApply: true, scrollable: false });
  assert.deepEqual((await getSitePrefs("vimeo")).prefs, { autoApply: false, scrollable: true });
  assert.deepEqual(Object.keys(data).sort(), ["site:vimeo", "site:youtube"]);
});

test("a value written by an older version still reads as valid", async () => {
  // `scrollable` did not exist in the first release. Its absence must resolve to
  // the default, not condemn the whole record as corrupt.
  fakeStorage({ "site:youtube": { autoApply: true } });
  const { prefs, loadFailed } = await getSitePrefs("youtube");
  assert.deepEqual(prefs, { autoApply: true, scrollable: false });
  assert.equal(loadFailed, false);
});

test("unknown fields from a newer version are ignored, not fatal", async () => {
  fakeStorage({ "site:youtube": { autoApply: true, scrollable: true, somethingNew: 7 } });
  const { prefs, loadFailed } = await getSitePrefs("youtube");
  assert.deepEqual(prefs, { autoApply: true, scrollable: true });
  assert.equal(loadFailed, false);
});

test("a damaged value falls back to defaults and reports the failure", async () => {
  for (const stored of [null, 42, "yes", [], { scrollable: true }, { autoApply: "true" }]) {
    fakeStorage({ "site:youtube": stored });
    const { prefs, loadFailed } = await getSitePrefs("youtube");
    assert.deepEqual(prefs, DEFAULT_SITE_PREFS, JSON.stringify(stored));
    assert.equal(loadFailed, true, `${JSON.stringify(stored)} should report a load failure`);
  }
});

test("no storage area at all degrades to defaults", async () => {
  noStorage();
  const { prefs, loadFailed } = await getSitePrefs("youtube");
  assert.deepEqual(prefs, DEFAULT_SITE_PREFS);
  assert.equal(loadFailed, true);

  const result = await setSitePrefs("youtube", { autoApply: true });
  assert.deepEqual(result, { ok: false, error: "storage unavailable" });
});

test("a throwing storage area never throws out to the caller", async () => {
  brokenStorage();
  const { prefs, loadFailed } = await getSitePrefs("youtube");
  assert.deepEqual(prefs, DEFAULT_SITE_PREFS);
  assert.equal(loadFailed, true);

  const result = await setSitePrefs("youtube", { autoApply: true });
  assert.equal(result.ok, false);
});

test("defaults are returned by value, so a caller cannot poison them", async () => {
  fakeStorage();
  const first = (await getSitePrefs("youtube")).prefs as SitePrefs;
  first.autoApply = true;
  assert.equal(DEFAULT_SITE_PREFS.autoApply, false);
  assert.equal((await getSitePrefs("youtube")).prefs.autoApply, false);
});

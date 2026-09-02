// Preference storage (§5): the read path, the per-field coercion, and the promise
// that reading an old record never rewrites it.
//
// This file is cited by `rating.test.ts` and `entitlement.test.ts` as the canonical
// example of the storage fake, and it was empty — 0 bytes — while `docs/testing.md`
// listed it as covering "preference storage, coercion, and that reading an old record
// does not rewrite it". None of that was actually asserted anywhere.
//
// Storage is faked by assigning a minimal `chrome` to globalThis. The source resolves
// `chrome.storage.local` through `storageArea()` at call time, so swapping the fake per
// test needs no seam and no module mocking.
//
// THE INVARIANT THIS FILE EXISTS FOR. There is no migration step and there must never
// be one, so every read has to upgrade whatever it finds, every time. Two consequences
// are asserted below and neither is obvious from the code:
//
//   1. Reading an old record must not write a new one back. A migration-on-read that
//      persists is a migration, and it can fail halfway; an upgrade that is recomputed
//      on every read cannot.
//   2. A field an older version never heard of must read as its default rather than
//      condemning the whole record as corrupt, because the alternative is a reader
//      losing every preference they set by installing an update.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DOCK_WIDTHS,
  DEFAULT_SITE_PREFS,
  DOCK_IDS,
  getSitePrefs,
  modeFor,
  normalizeDockWidth,
  normalizeDockWidths,
  normalizeSitePrefs,
  setSitePrefs,
} from "../src/windowed-fullscreen.ts";

type Store = Record<string, unknown>;

/** Install a working fake storage area, and return its backing object plus a write log. */
function fakeStorage(initial: Store = {}): { data: Store; writes: Store[] } {
  const data: Store = { ...initial };
  const writes: Store[] = [];
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (entries: Store) => {
          writes.push(entries);
          Object.assign(data, entries);
        },
      },
    },
  };
  return { data, writes };
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

/** Remove `chrome` entirely, standing in for a context with no extension APIs. */
function noStorage(): void {
  delete (globalThis as Record<string, unknown>).chrome;
}

/** The smallest value `normalizeSitePrefs` accepts: autoApply is the presence test. */
const MINIMAL_STORED = { autoApply: true };

// --- The read path ---------------------------------------------------------

test("a first run reads the documented defaults, and that is not a failure", async () => {
  fakeStorage();

  const { prefs, loadFailed } = await getSitePrefs("youtube");

  assert.deepEqual(prefs, DEFAULT_SITE_PREFS);
  // The distinction matters to the popup, which shows an error only for a real
  // failure. Treating a first run as one would greet every new reader with a fault.
  assert.equal(loadFailed, false);
});

test("unreachable storage reads defaults AND reports the failure", async () => {
  brokenStorage();

  const { prefs, loadFailed } = await getSitePrefs("youtube");

  assert.deepEqual(prefs, DEFAULT_SITE_PREFS);
  assert.equal(loadFailed, true);
});

test("no chrome at all is a failure, not a throw", async () => {
  noStorage();

  const { prefs, loadFailed } = await getSitePrefs("youtube");

  assert.deepEqual(prefs, DEFAULT_SITE_PREFS);
  assert.equal(loadFailed, true);
});

test("each site has its own key, so writing one never disturbs another", async () => {
  const { data } = fakeStorage();

  await setSitePrefs("youtube", { autoApply: true });
  await setSitePrefs("elsewhere", { autoApply: false });

  assert.deepEqual(Object.keys(data).sort(), ["site:elsewhere", "site:youtube"]);
  assert.equal((data["site:youtube"] as Store).autoApply, true);
  assert.equal((data["site:elsewhere"] as Store).autoApply, false);
});

test("a patch merges rather than replacing, because the settings UI writes one field", async () => {
  const { data } = fakeStorage();

  await setSitePrefs("youtube", { autoApply: true, scrollable: true });
  await setSitePrefs("youtube", { cursorAutoHide: false });

  const stored = data["site:youtube"] as Store;
  // A whole-object write from the second call would have reset the first two.
  assert.equal(stored.autoApply, true);
  assert.equal(stored.scrollable, true);
  assert.equal(stored.cursorAutoHide, false);
});

// --- No migration step ----------------------------------------------------

test("reading an old record does not rewrite it", async () => {
  // A record from before `dockWidths` and the Pro fields existed.
  const legacy = { autoApply: true, scrollable: true, panelWidth: 400 };
  const { data, writes } = fakeStorage({ "site:youtube": legacy });

  const { prefs, loadFailed } = await getSitePrefs("youtube");

  // The upgrade happened...
  assert.equal(loadFailed, false);
  assert.equal(prefs.autoApply, true);
  assert.equal(prefs.scrollable, true);
  // ...in memory only. Nothing was written, and the stored record is byte-identical.
  assert.deepEqual(writes, []);
  assert.deepEqual(data["site:youtube"], legacy);
});

test("the upgrade is recomputed on every read, so it cannot fail halfway", async () => {
  const legacy = { autoApply: true, panelWidth: 360, chatWidth: 340 };
  const { data } = fakeStorage({ "site:youtube": legacy });

  const first = await getSitePrefs("youtube");
  const second = await getSitePrefs("youtube");

  assert.deepEqual(first.prefs, second.prefs);
  assert.deepEqual(data["site:youtube"], legacy);
});

test("the old sibling width fields are read when dockWidths is absent", () => {
  const widths = normalizeDockWidths({ panelWidth: 400, chatWidth: 380 });

  assert.equal(widths.panel, 400);
  assert.equal(widths.chat, 380);
  // A dock that did not exist when the record was written has no old field to fall
  // back to, so it reads as 0 — "let the stylesheet's own clamp() decide".
  assert.equal(widths.transcript, 0);
});

test("dockWidths wins over the old sibling fields when both are present", () => {
  const widths = normalizeDockWidths({
    dockWidths: { panel: 500, chat: 480, transcript: 420 },
    panelWidth: 320,
    chatWidth: 320,
  });

  assert.equal(widths.panel, 500);
  assert.equal(widths.chat, 480);
  assert.equal(widths.transcript, 420);
});

// --- Per-field coercion ---------------------------------------------------

test("autoApply is the presence test: without it there are no preferences here", () => {
  // Anything that is not an object, or is an object without the one field that has
  // existed since the first release, is not a preferences record at all.
  for (const stored of [null, undefined, 42, "prefs", true, {}, { scrollable: true }]) {
    assert.equal(normalizeSitePrefs(stored), null, JSON.stringify(stored) ?? "undefined");
  }
});

test("an array is not a preferences record", () => {
  // Arrays are objects, so this needs its own assertion rather than riding on the
  // typeof check above.
  assert.equal(normalizeSitePrefs([]), null);
  assert.equal(normalizeSitePrefs([{ autoApply: true }]), null);
});

test("a field an older version never wrote reads as its default, not as corruption", () => {
  const prefs = normalizeSitePrefs(MINIMAL_STORED);

  assert.ok(prefs, "a record carrying only autoApply is still usable");
  assert.equal(prefs.autoApply, true);
  // Every field the record did not carry falls back, and the record survives.
  assert.equal(prefs.scrollable, DEFAULT_SITE_PREFS.scrollable);
  assert.equal(prefs.cursorAutoHide, DEFAULT_SITE_PREFS.cursorAutoHide);
  assert.equal(prefs.ambientGlow, DEFAULT_SITE_PREFS.ambientGlow);
  assert.equal(prefs.captureToClipboard, DEFAULT_SITE_PREFS.captureToClipboard);
  assert.equal(prefs.letterboxColor, DEFAULT_SITE_PREFS.letterboxColor);
  assert.equal(prefs.captureFilenameTemplate, DEFAULT_SITE_PREFS.captureFilenameTemplate);
  assert.equal(prefs.captureBurnTimestamp, DEFAULT_SITE_PREFS.captureBurnTimestamp);
  assert.deepEqual(prefs.dockWidths, DEFAULT_DOCK_WIDTHS);
});

test("a field no longer on the record is ignored rather than carried through", () => {
  // 2.0.x stored a `channels` list for the per-channel rules. Those are gone, and
  // this pins the reason no migration step was needed: `normalizeSitePrefs` names
  // every field it wants, so an unrecognised one is never copied out.
  const prefs = normalizeSitePrefs({
    autoApply: true,
    channels: [{ id: "@one", scrollable: true, panel: true }],
  });

  assert.ok(prefs, "an old record is still usable");
  assert.equal(prefs.autoApply, true);
  assert.ok(!("channels" in prefs), "a removed field survived into the normalized prefs");
});

test("one damaged field does not take the rest of the record with it", () => {
  const prefs = normalizeSitePrefs({
    autoApply: true,
    scrollable: "yes",
    letterboxColor: 17,
    dockWidths: "not-an-object",
    cursorAutoHide: null,
  });

  assert.ok(prefs, "the record is still usable");
  assert.equal(prefs.autoApply, true);
  assert.equal(prefs.scrollable, DEFAULT_SITE_PREFS.scrollable);
  assert.equal(prefs.letterboxColor, DEFAULT_SITE_PREFS.letterboxColor);
  assert.deepEqual(prefs.dockWidths, DEFAULT_DOCK_WIDTHS);
  assert.equal(prefs.cursorAutoHide, DEFAULT_SITE_PREFS.cursorAutoHide);
});

test("cursorAutoHide defaults ON, so its absence must not read as off", () => {
  // The one boolean whose default is true. A coercion written as `=== true` would
  // turn every pre-existing record into "auto-hide disabled" on upgrade.
  const prefs = normalizeSitePrefs(MINIMAL_STORED);
  assert.ok(prefs);
  assert.equal(prefs.cursorAutoHide, true);
  assert.equal(DEFAULT_SITE_PREFS.cursorAutoHide, true);
});

test("an unusable stored width reads as 0, which means the stylesheet decides", () => {
  for (const stored of [null, undefined, "400", NaN, Infinity, -Infinity, -50]) {
    assert.equal(normalizeDockWidth(stored), 0, String(stored));
  }
});

test("a fractional width is rounded, because a drag reports subpixels", () => {
  assert.equal(normalizeDockWidth(400.4), 400);
  assert.equal(normalizeDockWidth(400.6), 401);
});

// --- The mode selector ---------------------------------------------------

test("modeFor is the only place the boolean becomes a mode name", () => {
  assert.equal(modeFor({ ...DEFAULT_SITE_PREFS, scrollable: false }), "cover");
  assert.equal(modeFor({ ...DEFAULT_SITE_PREFS, scrollable: true }), "scrollable");
});

// --- The dock table ------------------------------------------------------

test("DEFAULT_DOCK_WIDTHS covers every dock, so no dock can be forgotten", () => {
  // `DockId` is a union precisely so a new dock breaks the exhaustive records. This
  // asserts the runtime half of that, which the type system cannot: a dock added to
  // DOCK_IDS but missed in the defaults would read back undefined.
  for (const dock of DOCK_IDS) {
    assert.equal(typeof DEFAULT_DOCK_WIDTHS[dock], "number", dock);
    assert.equal(DEFAULT_DOCK_WIDTHS[dock], 0, dock);
  }
  assert.equal(Object.keys(DEFAULT_DOCK_WIDTHS).length, DOCK_IDS.length);
});

test("DOCK_IDS is ordered outboard to inboard, which is load-bearing", () => {
  // Each dock's inboard offset is the sum of the widths outboard of it, so the order
  // is what guarantees a width is resolved after everything outside it. Written out
  // here because `applyDockWidths` iterates this array and nothing else states it.
  assert.deepEqual(DOCK_IDS, ["chat", "panel", "transcript"]);
});

// Preference storage: defaults, forward/backward compatibility, and the
// read-then-merge that keeps one setting from clobbering another.
//
// Storage is faked by assigning a minimal `chrome` to globalThis. The source
// reads `chrome.storage.local` through `storageArea()` at call time, so swapping
// the fake per test needs no injection seam.
import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import {
  DEFAULT_FIRST_RUN_STATE,
  DEFAULT_PIN_PROMPT_STATE,
  DEFAULT_RATING_STATE,
  DEFAULT_SITE_PREFS,
  FIRST_RUN_KEY,
  getSitePrefs,
  INSTALL_KEY,
  MAX_PIN_PROMPTS,
  MAX_RATING_PROMPTS,
  MIN_SESSION_FOR_USAGE_MS,
  normalizeFirstRunState,
  normalizeInstallTimestamp,
  normalizePinPromptState,
  normalizeRatingState,
  normalizeUsageCounter,
  PIN_PROMPT_KEY,
  RATING_KEY,
  recordQualifyingUsage,
  setFirstRunState,
  setInstallTimestampOnce,
  setPinPromptState,
  setRatingState,
  setSitePrefs,
  USAGE_COUNTER_MAX,
  USAGE_KEY,
  type FirstRunState,
  type PinPromptState,
  type RatingState,
  type SitePrefs,
} from "../src/windowed-fullscreen.ts";
import { bool, exhaustive, forAll, int, record, type Gen } from "./support/pbt.ts";

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

// --- Property tests --------------------------------------------------------

/**
 * A far-future epoch, roughly the year 2100. Wide enough that `lastPromptAt` and
 * the install time are sampled rather than enumerated, and still comfortably
 * inside `Number.MAX_SAFE_INTEGER`, which is the bound the coercions check.
 */
const FAR_FUTURE_MS = 4_102_444_800_000;

/** Every well-formed rating record: the domain the coercion must not touch. */
const validRatingState: Gen<RatingState> = record({
  stars: int(0, 5),
  promptsShown: int(0, MAX_RATING_PROMPTS),
  lastPromptAt: int(0, FAR_FUTURE_MS),
  resolved: bool(),
});

/** Every well-formed pin-prompt record. Small enough to be exhaustible alone. */
const validPinPromptState: Gen<PinPromptState> = record({
  shown: int(0, MAX_PIN_PROMPTS),
  dismissed: bool(),
});

// Feature: fullscreen-exit-and-rating-footer, Property 10: Coercion round-trips every valid record
//
// Each coercion is the identity on its own valid domain, so a record this
// version writes reads back as the same record rather than being silently
// reset to a default. The hostile-input half of the same story is Property 11.
//
// **Validates: Requirements 8.1, 8.4**
forAll(
  "Property 10: coercion round-trips every valid record",
  [validRatingState, int(0, USAGE_COUNTER_MAX), int(0, FAR_FUTURE_MS), validPinPromptState],
  (rating, usage, installedAt, pinPrompt) => {
    assert.deepEqual(normalizeRatingState(rating), rating);
    assert.equal(normalizeUsageCounter(usage), usage);
    assert.equal(normalizeInstallTimestamp(installedAt), installedAt);
    assert.deepEqual(normalizePinPromptState(pinPrompt), pinPrompt);
  },
);

// Feature: fullscreen-exit-and-rating-footer, Property 11: Coercion is total on damaged input, and an unreadable install time is absent, not zero
//
// The hostile half of Property 10. Property 10 is a round trip over well-formed
// records; there is no round trip here, because the input is a record with an
// arbitrary subset of its fields removed, retyped, or pushed out of range, and
// nothing that comes back can be compared with what went in. Kept as a second
// property rather than a widening of the first for exactly that reason.
//
// **Validates: Requirements 8.4, 8.5, 9.4, 9.17**

/** Every well-formed first-run record. Two booleans, so wholly exhaustible. */
const validFirstRunState: Gen<FirstRunState> = record({
  opened: bool(),
  welcomeSeen: bool(),
});

/**
 * The damage set: one value for each way a stored field goes wrong in the wild.
 * `undefined` stands for a field an older version never wrote (applied as a
 * delete, not as a present-but-undefined field); `null`, `"3"`, `true`, `{}` and
 * `[]` are the wrong type; `NaN` and `Infinity` are non-finite numbers, which
 * survive a JSON round trip through storage as `null`; `-1` is below range and
 * `0.5` is not a whole number.
 */
const DAMAGE: readonly unknown[] = [undefined, null, NaN, Infinity, -1, 0.5, "3", true, {}, []];

/** No damage applied to this field. Outside `DAMAGE`, so it reads as a sentinel. */
const INTACT = -1;

/** The documented type and range of one stored field. */
type FieldKind = { readonly kind: "count"; readonly max: number } | { readonly kind: "boolean" };

/**
 * Whether a value is inside a field's documented domain.
 *
 * Deliberately an independent re-statement of the table in the design rather
 * than a call into the source's own `isCount`: a test that asks the code under
 * test what "valid" means cannot catch the code widening it.
 */
function inDomain(kind: FieldKind, value: unknown): boolean {
  if (kind.kind === "boolean") return typeof value === "boolean";
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= kind.max;
}

/**
 * One damage index per field, drawn independently: `INTACT` leaves the field
 * alone, anything else replaces it with `DAMAGE[index]`. A plan of all-`INTACT`
 * is Property 10's case and must still hold here.
 */
function damagePlan(fieldCount: number): Gen<number[]> {
  const index = int(INTACT, DAMAGE.length - 1);
  return {
    sample: (rng) => Array.from({ length: fieldCount }, () => index.sample(rng)),
    // Length is fixed, so the shrinker's array halvings never reach the predicate.
    valid: (v) =>
      Array.isArray(v) &&
      v.length === fieldCount &&
      v.every((entry) => index.valid?.(entry) !== false),
  };
}

/**
 * Assert the three halves of the record claim for one damaged record: the
 * coercion returns a value rather than raising, every field it returns is inside
 * its documented domain, and the substitution is confined to the damaged fields.
 *
 * The record parameters are `object` and cast inside because the source's record
 * types are interfaces, which TypeScript does not give an implicit index
 * signature; the alternative is a cast at each of the three call sites.
 */
function checkDamagedRecord(
  normalize: (stored: unknown) => object,
  fields: Readonly<Record<string, FieldKind>>,
  valid: object,
  defaults: object,
  plan: readonly number[],
): void {
  const source = valid as Record<string, unknown>;
  const fallback = defaults as Record<string, unknown>;
  const keys = Object.keys(fields);

  const damaged: Record<string, unknown> = { ...source };
  for (let i = 0; i < keys.length; i++) {
    const index = plan[i] ?? INTACT;
    if (index === INTACT) continue;
    const key = keys[i] as string;
    const value = DAMAGE[index];
    // An absent field and a field written as undefined are the same input to a
    // per-field coercion; the delete covers the one an older version produces.
    if (value === undefined) delete damaged[key];
    else damaged[key] = value;
  }

  const out = normalize(damaged) as Record<string, unknown>;
  assert.deepEqual([...Object.keys(out)].sort(), [...keys].sort(), "no field invented or dropped");

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    const kind = fields[key] as FieldKind;
    const index = plan[i] ?? INTACT;
    const damage = DAMAGE[index];

    assert.equal(inDomain(kind, out[key]), true, `${key} left its documented domain`);

    // A damage value that happens to be inside the field's domain is not damage:
    // `true` is a perfectly good boolean, so it must be kept rather than reset.
    const expected =
      index === INTACT ? source[key] : inDomain(kind, damage) ? damage : fallback[key];
    const how = index === INTACT ? "intact" : `damaged with ${inspect(damage)}`;
    assert.equal(out[key], expected, `${key} ${how}`);
  }
}

/** The fields of each record, exactly as the design's coercion table states them. */
const RATING_FIELDS: Readonly<Record<string, FieldKind>> = {
  stars: { kind: "count", max: 5 },
  promptsShown: { kind: "count", max: MAX_RATING_PROMPTS },
  lastPromptAt: { kind: "count", max: Number.MAX_SAFE_INTEGER },
  resolved: { kind: "boolean" },
};

const PIN_PROMPT_FIELDS: Readonly<Record<string, FieldKind>> = {
  shown: { kind: "count", max: MAX_PIN_PROMPTS },
  dismissed: { kind: "boolean" },
};

const FIRST_RUN_FIELDS: Readonly<Record<string, FieldKind>> = {
  opened: { kind: "boolean" },
  welcomeSeen: { kind: "boolean" },
};

forAll(
  "Property 11: record coercion substitutes the default in exactly the damaged fields",
  [
    validRatingState,
    damagePlan(Object.keys(RATING_FIELDS).length),
    validPinPromptState,
    damagePlan(Object.keys(PIN_PROMPT_FIELDS).length),
    validFirstRunState,
    damagePlan(Object.keys(FIRST_RUN_FIELDS).length),
  ],
  (rating, ratingPlan, pinPrompt, pinPromptPlan, firstRun, firstRunPlan) => {
    checkDamagedRecord(
      normalizeRatingState,
      RATING_FIELDS,
      rating,
      DEFAULT_RATING_STATE,
      ratingPlan,
    );
    checkDamagedRecord(
      normalizePinPromptState,
      PIN_PROMPT_FIELDS,
      pinPrompt,
      DEFAULT_PIN_PROMPT_STATE,
      pinPromptPlan,
    );
    checkDamagedRecord(
      normalizeFirstRunState,
      FIRST_RUN_FIELDS,
      firstRun,
      DEFAULT_FIRST_RUN_STATE,
      firstRunPlan,
    );
  },
  // Three independent plans of 11 choices per field, so more than the default
  // 100 draws before the interesting combinations show up.
  { cases: 400 },
);

forAll(
  "Property 11: the scalar coercions are total, and an unreadable install time is null, not 0",
  [exhaustive(DAMAGE)],
  (damage) => {
    const usage = normalizeUsageCounter(damage);
    assert.equal(inDomain({ kind: "count", max: USAGE_COUNTER_MAX }, usage), true);
    assert.equal(usage, 0, `usage from ${inspect(damage)}`);

    const installedAt = normalizeInstallTimestamp(damage);
    // The asymmetry that matters: 0 is a valid instant (1970), so an unreadable
    // install time coerced to 0 would read as installed half a century ago and
    // make a fresh install instantly eligible for a rating prompt.
    assert.equal(installedAt, null, `install time from ${inspect(damage)} must be absent`);
    assert.notEqual(installedAt, 0, "an unreadable install time is absent, not zero");
    assert.equal(typeof installedAt === "number", false, "no number stands in for absent");
  },
);

forAll(
  "Property 11: a non-object value coerces to the documented defaults",
  [exhaustive(DAMAGE)],
  (stored) => {
    // R8.5: unlike `normalizeSitePrefs`, which reports a load failure, these
    // return the all-defaults record — which is exactly what a first run sees.
    assert.deepEqual(normalizeRatingState(stored), DEFAULT_RATING_STATE);
    assert.deepEqual(normalizePinPromptState(stored), DEFAULT_PIN_PROMPT_STATE);
    assert.deepEqual(normalizeFirstRunState(stored), DEFAULT_FIRST_RUN_STATE);
    assert.equal(normalizeUsageCounter(stored), 0);
    assert.equal(normalizeInstallTimestamp(stored), null);
  },
);

test("a coerced record is a fresh object, so the defaults cannot be poisoned", () => {
  const first = normalizeRatingState("not a record") as RatingState;
  first.stars = 5;
  assert.equal(DEFAULT_RATING_STATE.stars, 0);
  assert.equal(normalizeRatingState("not a record").stars, 0);
});

// Feature: fullscreen-exit-and-rating-footer, Property 12: Per-site preferences read back unchanged, and the later whole-record write wins
//
// Two claims about record boundaries, kept in one property because they are the
// same worry from both sides: the five new keys must not bleed into the record
// the shipped version already writes (R8.6), and a whole-record write must not
// inherit a field from the write before it (R8.9).
//
// The R8.9 half needs a detector, not just an assertion. `setRatingState` is
// handed a complete record, so `{ ...stored, ...next }` and `{ ...next }` agree
// on every well-formed input — a merge would pass a naive "later write wins"
// check. Two things make the difference observable: the store is seeded with a
// record carrying a field this version does not know (what a newer version, or
// the other surface mid-upgrade, would leave behind), which a merge preserves
// and a whole-record write erases; and the fake storage records its reads, so a
// read-then-merge is caught at the point it reads.
//
// **Validates: Requirements 8.6, 8.9**

const SITE_ID = "youtube";
const SITE_KEY = `site:${SITE_ID}`;

/** Every well-formed per-site record: the domain `normalizeSitePrefs` must not touch. */
const validSitePrefs: Gen<SitePrefs> = record({
  autoApply: bool(),
  scrollable: bool(),
});

/** The two field names a per-site record is allowed to hold, and nothing else. */
const SITE_PREFS_FIELDS: readonly string[] = ["autoApply", "scrollable"];

/**
 * Every name belonging to one of the five new records — the top-level keys and
 * the field names inside them. None may appear inside a `site:<siteId>` record.
 */
const FOREIGN_NAMES: readonly string[] = [
  RATING_KEY,
  USAGE_KEY,
  INSTALL_KEY,
  FIRST_RUN_KEY,
  PIN_PROMPT_KEY,
  ...Object.keys(RATING_FIELDS),
  ...Object.keys(PIN_PROMPT_FIELDS),
  ...Object.keys(FIRST_RUN_FIELDS),
];

/** A field name no version of this extension writes. Stands in for a stale one. */
const STALE_FIELD = "wfsFieldFromAnotherWrite";

/** Fake storage that also records every key read, so a read-then-merge is visible. */
function recordingStorage(initial: Store = {}): { data: Store; reads: string[] } {
  const data: Store = { ...initial };
  const reads: string[] = [];
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => {
          reads.push(key);
          return key in data ? { [key]: data[key] } : {};
        },
        set: async (entries: Store) => {
          Object.assign(data, entries);
        },
      },
    },
  };
  return { data, reads };
}

/** Assert a per-site record holds the two documented fields and nothing borrowed. */
function assertNoForeignFields(record_: unknown, when: string): void {
  assert.equal(typeof record_ === "object" && record_ !== null, true, `${when}: no record stored`);
  const stored = record_ as Record<string, unknown>;
  for (const name of FOREIGN_NAMES) {
    assert.equal(name in stored, false, `${when}: ${name} leaked into ${SITE_KEY}`);
  }
}

forAll(
  "Property 12: per-site preferences read back unchanged, and the later whole-record write wins",
  [validSitePrefs, bool(), validRatingState, validRatingState, validFirstRunState, validPinPromptState],
  async (prefs, olderVersion, first, second, firstRun, pinPrompt) => {
    // --- R8.6: the new keys leave the per-site record alone -----------------

    // Either shape the shipped version has written: the current two-field record,
    // or the first release's single field, which must still read as valid.
    const stored = olderVersion ? { autoApply: prefs.autoApply } : { ...prefs };
    const expected: SitePrefs = olderVersion
      ? { autoApply: prefs.autoApply, scrollable: DEFAULT_SITE_PREFS.scrollable }
      : { ...prefs };

    const data = fakeStorage({ [SITE_KEY]: stored });

    // Write all five new records through their own accessors, which is the only
    // way any of them is ever written.
    await setRatingState(first);
    await recordQualifyingUsage(MIN_SESSION_FOR_USAGE_MS);
    await setInstallTimestampOnce(1);
    await setFirstRunState(firstRun);
    await setPinPromptState(pinPrompt);

    const readBack = await getSitePrefs(SITE_ID);
    assert.deepEqual(readBack.prefs, expected, "a shipped-shape record read back changed");
    assert.equal(readBack.loadFailed, false, "a record the shipped version wrote is not a failure");

    assert.deepEqual(
      Object.keys(data[SITE_KEY] as object).sort(),
      Object.keys(stored).sort(),
      "the new records rewrote the per-site record",
    );
    assertNoForeignFields(data[SITE_KEY], "after writing the new records");

    // The per-site write is the read-and-merge path, so it is the one that could
    // drag a foreign field in. It must still produce exactly the two fields.
    const patched = await setSitePrefs(SITE_ID, { scrollable: expected.scrollable });
    assert.equal(patched.ok, true);
    assert.deepEqual(
      Object.keys(data[SITE_KEY] as object).sort(),
      [...SITE_PREFS_FIELDS].sort(),
      "the merge invented or dropped a per-site field",
    );
    assert.deepEqual(data[SITE_KEY], expected);
    assertNoForeignFields(data[SITE_KEY], "after a per-site patch");

    // --- R8.9: the later rating write replaces the whole record -------------

    for (const [earlier, later] of [
      [first, second],
      [second, first],
    ] as const) {
      // Seeded with a field this version does not know, so a merge is detectable:
      // it would carry `STALE_FIELD` through both writes.
      const { data: store, reads } = recordingStorage({
        [RATING_KEY]: { ...earlier, [STALE_FIELD]: "from an earlier write" },
      });

      assert.equal(reads.length, 0, "seeding the store must not read it");

      await setRatingState(earlier);
      await setRatingState(later);

      // deepEqual is key-set sensitive, so this is both halves of the claim: the
      // stored record is one of the two inputs, and it is not a hybrid.
      assert.deepEqual(store[RATING_KEY], later, "the later whole-record write did not win");
      assert.deepEqual(reads, [], "setRatingState read the store, so it can merge");
    }
  },
);

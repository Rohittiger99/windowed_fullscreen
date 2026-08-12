// Usage counting and the rating decisions that read it.
//
// This file owns the properties for the rating side of the feature: the usage
// counter first (Property 8), and later the scheduler, the prompt cap, the
// terminal Resolved state, and the routing (Properties 6, 7, 9, 14). Keep each
// property in its own section below, tagged the same way, so the file stays
// navigable as it grows.
//
// Storage is faked by assigning a minimal `chrome` to globalThis, matching
// `tests/prefs.test.ts`: the source reads `chrome.storage.local` through
// `storageArea()` at call time, so swapping the fake per case needs no seam.
import test from "node:test";
import assert from "node:assert/strict";

import {
  countsAsUsage,
  MIN_SESSION_FOR_USAGE_MS,
  nextUsageCount,
  recordQualifyingUsage,
  USAGE_COUNTER_MAX,
  USAGE_KEY,
} from "../src/windowed-fullscreen.ts";
import { arrayOf, exhaustive, forAll, type Gen } from "./support/pbt.ts";

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
          writes.push({ ...entries });
          Object.assign(data, entries);
        },
      },
    },
  };
  return { data, writes };
}

// --- Property 8 ------------------------------------------------------------
//
// Feature: fullscreen-exit-and-rating-footer, Property 8: Usage counts exactly the qualifying sessions, and saturates
//
// Three claims, all about the same counter, so they stay in one property:
// `countsAsUsage` accepts a duration if and only if it is finite and at or above
// 60,000 ms (R9.1, R9.18); the counter advances by exactly 1 for an accepted
// session and not at all for a shorter one (R9.1, R9.18); and `nextUsageCount`
// never returns a value above the cap or below the value it was given (R9.1).
//
// Run in two parts. The first is exhaustive over the boundary values, because
// 59,999 / 60,000 / 60,001 and cap-1 / cap are the cases that decide whether the
// comparison is the right one, and a uniform draw over a day of milliseconds
// would never land on them. The second runs whole sequences, sampled, and checks
// the same claims end to end through `recordQualifyingUsage` and storage.
//
// **Validates: Requirements 9.1, 9.18**

/**
 * The threshold restated, not imported.
 *
 * A test that asks the source what its own threshold is cannot catch the source
 * changing it. The imported constant is checked against this literal separately,
 * so a deliberate change fails in one obvious place rather than silently
 * re-baselining every case below.
 */
const THRESHOLD_MS = 60_000;

/** A day in milliseconds — the upper end of a plausible viewing session. */
const ONE_DAY_MS = 86_400_000;

/**
 * Every duration worth deciding on, enumerated rather than drawn: the boundary
 * triple, zero, a long-but-real session, and the values a broken clock or a
 * missing start time produces. `-0` is in the list because it is `>= 0` yet
 * prints as a negative, which is exactly the sort of value a comparison written
 * the other way round would mishandle.
 */
const BOUNDARY_DURATIONS: readonly number[] = [
  0,
  -0,
  1,
  THRESHOLD_MS - 1,
  THRESHOLD_MS,
  THRESHOLD_MS + 1,
  ONE_DAY_MS,
  -1,
  -THRESHOLD_MS,
  0.5,
  THRESHOLD_MS - 0.5,
  NaN,
  Infinity,
  -Infinity,
];

/**
 * Every starting counter worth deciding on: empty, mid-range, one below the cap,
 * and the cap itself. The last two are the saturation cases, so they are
 * enumerated rather than sampled for the same reason as the durations.
 */
const START_COUNTERS: readonly number[] = [0, 1, 500_000, USAGE_COUNTER_MAX - 1, USAGE_COUNTER_MAX];

/**
 * Whether a duration qualifies, restated independently of the source.
 *
 * "Finite" excludes NaN and both infinities; an infinite session is a broken
 * measurement, not a very long watch.
 */
function qualifies(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= THRESHOLD_MS;
}

/** A duration generator that mixes the boundary values with a wide uniform draw. */
const durationGen: Gen<number> = {
  sample: (rng) => {
    // Two draws in three come from the boundary list. A sequence of eight is then
    // overwhelmingly likely to contain both an accepted and a rejected session,
    // which is what makes the "advances by exactly 1, and not at all" half of the
    // claim bite on the same case.
    if (rng() < 2 / 3) {
      return BOUNDARY_DURATIONS[Math.floor(rng() * BOUNDARY_DURATIONS.length)] as number;
    }
    return Math.floor(rng() * (ONE_DAY_MS + 1));
  },
  valid: (v) => typeof v === "number",
};

test("the session threshold and the counter cap are the documented values", () => {
  // The one place the imported constants are compared with their literals, so
  // the properties below can restate them without going quietly out of step.
  assert.equal(MIN_SESSION_FOR_USAGE_MS, THRESHOLD_MS);
  assert.equal(USAGE_COUNTER_MAX, 1_000_000);
});

forAll(
  "Property 8: one session counts exactly when it is long enough, and the counter saturates",
  [exhaustive(BOUNDARY_DURATIONS), exhaustive(START_COUNTERS)],
  (durationMs, start) => {
    const accepted = countsAsUsage(durationMs);
    assert.equal(accepted, qualifies(durationMs), `countsAsUsage(${durationMs})`);

    const next = nextUsageCount(start);

    // The cap is a ceiling on the stored value, not just on the increment.
    assert.equal(next <= USAGE_COUNTER_MAX, true, `${next} rose above the cap from ${start}`);
    // Monotone: a count is never given back smaller than it came in, so a
    // qualifying session can never cost the user recorded history.
    assert.equal(next >= start, true, `${next} fell below ${start}`);
    assert.equal(Number.isInteger(next), true, `${next} is not a whole count`);

    // Exactly 1 while there is room, and held at the cap once reached.
    assert.equal(next, Math.min(start + 1, USAGE_COUNTER_MAX), `nextUsageCount(${start})`);

    // The counter that results from this session: advanced for an accepted one,
    // untouched for a shorter one.
    const after = accepted ? next : start;
    assert.equal(after, accepted ? Math.min(start + 1, USAGE_COUNTER_MAX) : start);
  },
);

forAll(
  "Property 8: a sequence of sessions advances the stored count once per qualifying session",
  [arrayOf(durationGen, 8), exhaustive(START_COUNTERS)],
  async (durations, start) => {
    const { data, writes } = fakeStorage({ [USAGE_KEY]: start });

    let accepted = 0;
    for (const durationMs of durations) {
      const recorded = await recordQualifyingUsage(durationMs);
      assert.equal(recorded, qualifies(durationMs), `recordQualifyingUsage(${durationMs})`);
      if (recorded) accepted++;

      // Checked after every session, not just at the end: a write on a
      // non-qualifying session would otherwise hide behind a later accepted one.
      assert.equal(writes.length, accepted, `a non-qualifying session wrote (${durationMs})`);
    }

    // Saturating addition is monotone, so iterating the clamp and clamping the
    // total agree — which lets the expectation be stated without replaying the
    // loop the code under test just ran.
    assert.equal(data[USAGE_KEY], Math.min(start + accepted, USAGE_COUNTER_MAX));

    // Every write is one whole key, and none of them exceeds the cap.
    for (const entry of writes) {
      assert.deepEqual(Object.keys(entry), [USAGE_KEY], "a usage write touched another key");
      const value = entry[USAGE_KEY] as number;
      assert.equal(Number.isInteger(value) && value >= 0 && value <= USAGE_COUNTER_MAX, true);
    }
  },
  // Sequences of up to eight sessions across five starting counters; more than
  // the default 100 draws before the saturating starts meet a long sequence.
  { cases: 300 },
);

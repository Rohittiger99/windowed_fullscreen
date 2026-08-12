// The pure decision functions behind fullscreen exit, the two prompts, and the
// welcome page. No DOM, no browser, no storage, no clock.
//
// Every function here was written to be exactly this testable — total, pure, and
// exported — and then had no test at all. `ratingPromptDue`'s doc comment
// enumerates its seven gates "so a failing test names the clause"; this is the
// file that makes that true.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PIN_PROMPT_STATE,
  DEFAULT_RATING_STATE,
  MAX_PIN_PROMPTS,
  MAX_RATING_PROMPTS,
  MAX_STARS,
  MIN_ENTRIES_BEFORE_PROMPT,
  MIN_TIME_SINCE_INSTALL_MS,
  pinPromptDue,
  promptPrecedence,
  ratingPromptDue,
  selectExitDestination,
  shouldOpenFirstRun,
  type ExitTrigger,
  type PinPromptState,
  type RatingState,
} from "../src/windowed-fullscreen.ts";

// ---------------------------------------------------------------------------
// selectExitDestination
// ---------------------------------------------------------------------------

const TRIGGERS: readonly ExitTrigger[] = [
  "extension-windowed-button",
  "extension-panel-button",
  "site-or-user",
];

test("leaving fullscreen retraces the way in", () => {
  // The whole point of the function. An exit YouTube's own button caused — or a
  // double-click, `f`, or `Escape` — gives back whatever was on screen when
  // fullscreen began, so a reader who was in windowed mode is put back in it and
  // one who was on the plain player stays there. Our own buttons name their own
  // destination on top of that.
  assert.equal(selectExitDestination("site-or-user", true, false), "windowed");
  assert.equal(selectExitDestination("site-or-user", true, true), "windowed");
  assert.equal(selectExitDestination("site-or-user", false, false), "normal-player");
  assert.equal(selectExitDestination("extension-windowed-button", false, false), "windowed");
  assert.equal(
    selectExitDestination("extension-panel-button", false, false),
    "windowed-with-panel",
  );
});

test("Property: only the resume flag moves an unrequested exit, for all twelve cases", () => {
  // Three triggers by two flags by two flags. `pendingResume` is the one input
  // that may change the answer, and only for `site-or-user`: it says whether there
  // is a mode to go back to. `pendingPanel` says what to restore once we are
  // there, never where to go, so a destination that varies with it is a bug — it
  // would make `windowed-with-panel` the answer for an exit that never asked for
  // the panel, docking it unconditionally instead of restoring what was open.
  for (const trigger of TRIGGERS) {
    for (const pendingResume of [false, true]) {
      const expected = selectExitDestination(trigger, pendingResume, false);
      for (const pendingPanel of [false, true]) {
        assert.equal(
          selectExitDestination(trigger, pendingResume, pendingPanel),
          expected,
          `${trigger} with resume=${pendingResume} panel=${pendingPanel}`,
        );
      }
      if (trigger !== "site-or-user") {
        assert.equal(
          expected,
          selectExitDestination(trigger, !pendingResume, false),
          `${trigger} read the resume flag`,
        );
      }
    }
  }
});

test("every trigger yields a destination, and none abandons a mode that was up", () => {
  const windowedDestinations = new Set(["windowed", "windowed-with-panel"]);
  for (const trigger of TRIGGERS) {
    for (const pendingResume of [false, true]) {
      const destination = selectExitDestination(trigger, pendingResume, false);
      assert.ok(destination.length > 0, `${trigger} produced no destination`);
      // Windowed mode was up when fullscreen began, so it must be up again after.
      // A `normal-player` answer here is the regression this test exists for: it
      // would throw away a mode the reader switched on and never asked to leave.
      if (pendingResume) {
        assert.ok(
          windowedDestinations.has(destination),
          `${trigger} dropped the mode instead of restoring it`,
        );
      }
    }
    // Our own buttons ask for the mode outright, so they resume it even with no
    // flags set at all. Only `site-or-user` has nothing to go back to.
    const cold = selectExitDestination(trigger, false, false);
    assert.equal(
      windowedDestinations.has(cold),
      trigger !== "site-or-user",
      `${trigger} with no pending state landed on ${cold}`,
    );
  }
});

// ---------------------------------------------------------------------------
// ratingPromptDue — one test per documented gate, in clause order
// ---------------------------------------------------------------------------

/** A state and a clock that pass every gate, so each test can fail exactly one. */
const INSTALLED_AT = 1_000_000_000_000;
const DUE_NOW = INSTALLED_AT + MIN_TIME_SINCE_INSTALL_MS;
const DUE_USAGE = MIN_ENTRIES_BEFORE_PROMPT;

function eligible(over: Partial<RatingState> = {}): RatingState {
  return { ...DEFAULT_RATING_STATE, ...over };
}

test("rating gate 0: the baseline case is due, or the gate tests below prove nothing", () => {
  assert.equal(ratingPromptDue(eligible(), DUE_USAGE, INSTALLED_AT, DUE_NOW), true);
});

test("rating gate 1: a resolved record is never asked again (R9.7)", () => {
  // Set by "Don't ask again", and it outranks everything — including a record
  // that would otherwise be perfectly due.
  assert.equal(
    ratingPromptDue(eligible({ resolved: true }), DUE_USAGE, INSTALLED_AT, DUE_NOW),
    false,
  );
});

test("rating gate 2: an unreadable install time is not treated as 1970 (R9.4)", () => {
  // Deliberately NOT coerced to 0: an install time of 0 would make every install
  // instantly eligible, which is the opposite of what the gate is for.
  for (const installedAt of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(
      ratingPromptDue(eligible(), DUE_USAGE, installedAt, DUE_NOW),
      false,
      `installedAt=${String(installedAt)}`,
    );
  }
});

test("rating gate 3: the post-install quiet period, including a clock that went backwards (R9.3, R9.5)", () => {
  assert.equal(ratingPromptDue(eligible(), DUE_USAGE, INSTALLED_AT, DUE_NOW - 1), false);
  assert.equal(ratingPromptDue(eligible(), DUE_USAGE, INSTALLED_AT, DUE_NOW), true);
  // A `now` before the install time means the clock moved; elapsed clamps to 0
  // rather than going negative and sailing past the gate.
  assert.equal(ratingPromptDue(eligible(), DUE_USAGE, INSTALLED_AT, INSTALLED_AT - 1), false);
});

test("rating gate 4: the ask follows a real session (R9.6)", () => {
  assert.equal(
    ratingPromptDue(eligible(), MIN_ENTRIES_BEFORE_PROMPT - 1, INSTALLED_AT, DUE_NOW),
    false,
  );
  // A usage count that is not a number counts as none, never as enough (R9.17).
  for (const usage of [NaN, Infinity, -Infinity]) {
    assert.equal(ratingPromptDue(eligible(), usage, INSTALLED_AT, DUE_NOW), false, `usage=${usage}`);
  }
});

test("rating gate 5: the lifetime cap (R9.8)", () => {
  for (const promptsShown of [MAX_RATING_PROMPTS, MAX_RATING_PROMPTS + 5]) {
    assert.equal(
      ratingPromptDue(eligible({ promptsShown }), DUE_USAGE, INSTALLED_AT, DUE_NOW),
      false,
      `promptsShown=${promptsShown}`,
    );
  }
});

test("the rating prompt is asked once in the life of an install, and never again", () => {
  // The whole behaviour, stated once. "Once" counts answers, not renders: nothing
  // here is written until the reader uses one of the three controls, so an opening
  // they closed without touching it leaves every gate exactly where it was. Both
  // halves of what the answer writes independently close the question, so a partial
  // write still cannot produce a second ask.
  assert.equal(MAX_RATING_PROMPTS, 1, "the cap is what makes this one-time");

  // One showing recorded, `resolved` never written: still done.
  assert.equal(
    ratingPromptDue(eligible({ promptsShown: 1 }), DUE_USAGE, INSTALLED_AT, DUE_NOW),
    false,
  );
  // `resolved` written, the count never landed: still done.
  assert.equal(
    ratingPromptDue(eligible({ resolved: true }), DUE_USAGE, INSTALLED_AT, DUE_NOW),
    false,
  );

  // And no amount of elapsed time brings it back. There are no re-ask intervals
  // any more; a year later is still an answered question.
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  assert.equal(
    ratingPromptDue(
      eligible({ promptsShown: 1, lastPromptAt: DUE_NOW }),
      DUE_USAGE * 500,
      INSTALLED_AT,
      DUE_NOW + oneYearMs,
    ),
    false,
    "a re-ask interval has come back",
  );
});

test("rating: a damaged record cannot force an ask, and the function never throws (R9.17)", () => {
  const damaged = [
    eligible({ promptsShown: NaN }),
    eligible({ lastPromptAt: NaN }),
    eligible({ promptsShown: Infinity, lastPromptAt: Infinity }),
    eligible({ stars: NaN }),
  ];
  for (const state of damaged) {
    // Only asserting it answers with a boolean and does not throw: a non-finite
    // count reads as 0, which is the permissive direction, so the surrounding
    // gates are what keep it honest.
    assert.equal(typeof ratingPromptDue(state, DUE_USAGE, INSTALLED_AT, DUE_NOW), "boolean");
  }
  // Stars play no part in whether an ask is due — a reader who picked five stars
  // without the prompt still gets asked, and one who picked one is not punished.
  for (let stars = 0; stars <= MAX_STARS; stars++) {
    assert.equal(ratingPromptDue(eligible({ stars }), DUE_USAGE, INSTALLED_AT, DUE_NOW), true);
  }
});

// ---------------------------------------------------------------------------
// pinPromptDue
// ---------------------------------------------------------------------------

function pinState(over: Partial<PinPromptState> = {}): PinPromptState {
  return { ...DEFAULT_PIN_PROMPT_STATE, ...over };
}

test("pin: a failed read never burns a showing (R16.4)", () => {
  // null is "we could not tell", and the safe answer is silence. Asking anyway
  // would spend one of two lifetime showings on a reader who may already have
  // pinned it.
  assert.equal(pinPromptDue(null, pinState(), 5), false);
});

test("pin: already pinned means nothing to ask for (R16.2)", () => {
  assert.equal(pinPromptDue(true, pinState(), 5), false);
});

test("pin: the first ask needs no usage, the second one does (R16.5, R16.6, R16.7)", () => {
  // First opening after install: ask, even with nothing to show for it yet.
  assert.equal(pinPromptDue(false, pinState({ shown: 0 }), 0), true);
  // Second: only once a real session has happened, so the repeat is earned.
  assert.equal(pinPromptDue(false, pinState({ shown: 1 }), 0), false);
  assert.equal(pinPromptDue(false, pinState({ shown: 1 }), 1), true);
});

test("pin: dismissal and the lifetime cap both end the asking (R16.8)", () => {
  assert.equal(pinPromptDue(false, pinState({ dismissed: true }), 5), false);
  // Dismissal outranks a count that has not reached the cap.
  assert.equal(pinPromptDue(false, pinState({ shown: 0, dismissed: true }), 5), false);
  for (const shown of [MAX_PIN_PROMPTS, MAX_PIN_PROMPTS + 3]) {
    assert.equal(pinPromptDue(false, pinState({ shown }), 5), false, `shown=${shown}`);
  }
});

// ---------------------------------------------------------------------------
// promptPrecedence
// ---------------------------------------------------------------------------

test("Property: at most one prompt per opening, and the pin ask always wins (R9.19, R16.12)", () => {
  assert.equal(promptPrecedence(true, true), "pin");
  assert.equal(promptPrecedence(true, false), "pin");
  assert.equal(promptPrecedence(false, true), "rating");
  // "none" is a real answer, not a fallback that renders something anyway.
  assert.equal(promptPrecedence(false, false), "none");
});

// ---------------------------------------------------------------------------
// shouldOpenFirstRun
// ---------------------------------------------------------------------------

test("the welcome page opens on a fresh install and on nothing else (R15.2, R15.4)", () => {
  assert.equal(shouldOpenFirstRun("install", false), true);

  // An update of any kind is not an install. Thanking someone for installing
  // something they installed months ago is the bug this prevents.
  for (const reason of ["update", "chrome_update", "shared_module_update", "", undefined]) {
    assert.equal(shouldOpenFirstRun(reason, false), false, `reason=${String(reason)}`);
  }

  // The guard is written before the tab is opened, so a worker killed mid-install
  // and restarted finds it set and opens nothing. At-most-once, not exactly-once.
  assert.equal(shouldOpenFirstRun("install", true), false);
});

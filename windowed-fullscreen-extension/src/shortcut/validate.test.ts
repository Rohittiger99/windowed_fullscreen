import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { isValidShortcutCombination } from "./validate";
import type { ShortcutCombination } from "../shared/types";

// Feature: windowed-fullscreen-extension, Property 5: Shortcut combination validity
// For any candidate key combination, the validator accepts it if and only if it
// contains at least one modifier key and exactly one non-modifier key; all other
// combinations are rejected.
//
// Validates: Requirements 3.2

// ---------------------------------------------------------------------------
// Independent oracle
//
// We reimplement the "is this a modifier?" notion here, independently of the
// implementation under test, so the property asserts agreement between two
// independent definitions of validity rather than tautologically calling the
// code it is testing.
// ---------------------------------------------------------------------------

const ORACLE_MODIFIERS: ReadonlySet<string> = new Set([
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
  "meta",
  "command",
  "cmd",
  "win",
  "windows",
  "super",
]);

function oracleIsModifier(key: string): boolean {
  return ORACLE_MODIFIERS.has(key.trim().toLowerCase());
}

/**
 * Expected validity computed independently of the implementation: a combination
 * is valid iff it has at least one modifier, every listed modifier really is a
 * modifier, and `key` is a single non-empty key that is not itself a modifier.
 */
function expectedValid(c: ShortcutCombination): boolean {
  if (c.modifiers.length < 1) {
    return false;
  }
  if (!c.modifiers.every(oracleIsModifier)) {
    return false;
  }
  if (c.key.trim().length === 0) {
    return false;
  }
  if (oracleIsModifier(c.key)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Generators: candidate combinations drawn from pools of modifier names and
// non-modifier keys, deliberately including the edge cases called out by the
// spec (zero modifiers, multiple modifiers, empty key, a modifier used as the
// key, and non-modifiers appearing in the modifier list).
// ---------------------------------------------------------------------------

// Real modifier names with varied casing / aliases / surrounding whitespace.
const modifierNames = fc.constantFrom(
  "Ctrl",
  "ctrl",
  "Control",
  "Alt",
  "Option",
  "Shift",
  "shift",
  "Meta",
  "Command",
  "Cmd",
  "Win",
  "Windows",
  "Super",
  "  Ctrl  ",
);

// Non-modifier keys, including edge cases: empty string and whitespace-only.
const nonModifierKeys = fc.constantFrom(
  "A",
  "z",
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "F1",
  "1",
  "9",
  "/",
  "[",
  "ArrowUp",
  "  x  ",
  "",
  "   ",
);

// `modifiers` is drawn from a pool that mixes real modifiers AND non-modifiers,
// so the "every listed modifier is a real modifier" rule is exercised. Length
// 0..3 covers zero, single, and multiple modifiers.
const modifiersArb = fc.array(fc.oneof(modifierNames, nonModifierKeys), {
  minLength: 0,
  maxLength: 3,
});

// `key` is drawn from non-modifier keys AND modifier names (a modifier used as
// the key is an explicit edge case the validator must reject).
const keyArb = fc.oneof(nonModifierKeys, modifierNames);

const combinationArb: fc.Arbitrary<ShortcutCombination> = fc.record({
  modifiers: modifiersArb,
  key: keyArb,
});

describe("isValidShortcutCombination — Property 5: shortcut combination validity", () => {
  it("accepts iff at least one modifier and exactly one non-modifier key", () => {
    fc.assert(
      fc.property(combinationArb, (combination) => {
        expect(isValidShortcutCombination(combination)).toBe(
          expectedValid(combination),
        );
      }),
      { numRuns: 100 },
    );
  });
});

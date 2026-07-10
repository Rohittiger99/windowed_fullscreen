/**
 * Shortcut combination validation (Requirement 3.2).
 *
 * A `ShortcutCombination` is valid if and only if it contains at least one
 * modifier key and exactly one non-modifier key. This module defines a clear,
 * self-contained notion of which keys are modifiers versus non-modifiers and
 * exposes a pure validator over that notion.
 */

import type { ShortcutCombination } from "../shared/types";

/**
 * The canonical set of modifier key names. Comparison is case-insensitive and
 * tolerant of common aliases (e.g. "Control"/"Ctrl", "Meta"/"Command"/"Cmd",
 * "Option" for Alt on macOS, "Win"/"Super" for the Windows/Super key).
 */
const MODIFIER_ALIASES: ReadonlySet<string> = new Set([
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

/** Normalize a key name for comparison (trim + lowercase). */
function normalize(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Returns true if `key` names a modifier key (Ctrl, Alt, Shift, Meta/Command,
 * and their common aliases). The comparison is case-insensitive and ignores
 * surrounding whitespace.
 */
export function isModifierKey(key: string): boolean {
  if (typeof key !== "string") {
    return false;
  }
  const normalized = normalize(key);
  if (normalized.length === 0) {
    return false;
  }
  return MODIFIER_ALIASES.has(normalized);
}

/**
 * Validate a `ShortcutCombination`.
 *
 * The combination is valid iff:
 *  - it has at least one modifier key (`modifiers.length >= 1`), and
 *  - every entry in `modifiers` is in fact a modifier key, and
 *  - `key` is exactly one non-modifier key — a single, non-empty key name that
 *    is not itself a modifier.
 *
 * All other combinations are rejected.
 *
 * _Requirements: 3.2_
 */
export function isValidShortcutCombination(
  combination: ShortcutCombination | null | undefined
): boolean {
  if (combination == null) {
    return false;
  }

  const { modifiers, key } = combination;

  // Must have at least one modifier, and every listed modifier must be a real
  // modifier key.
  if (!Array.isArray(modifiers) || modifiers.length < 1) {
    return false;
  }
  if (!modifiers.every((m) => typeof m === "string" && isModifierKey(m))) {
    return false;
  }

  // `key` must be exactly one non-modifier key: a single, non-empty key name
  // that is not itself a modifier.
  if (typeof key !== "string") {
    return false;
  }
  const normalizedKey = normalize(key);
  if (normalizedKey.length === 0) {
    return false;
  }
  if (isModifierKey(key)) {
    return false;
  }

  return true;
}

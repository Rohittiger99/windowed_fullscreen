// The user-facing copy budget. No DOM, no browser, no storage.
//
// `HELP_COPY`'s own doc comment named this file long before it existed, so the
// budget it describes was never enforced and `JARGON_LIST` had no consumer at
// all. Everything here is a property over the whole structure rather than a list
// of expected strings: a test that repeats the copy has to be edited every time
// a word changes and catches nothing, where these fail only when a new string
// breaks a rule that was written down for a reason.
import test from "node:test";
import assert from "node:assert/strict";

import { HELP_COPY, JARGON_LIST, formatCombo } from "../src/windowed-fullscreen.ts";

/** The longest a single string may be. Past this it stops being read. */
const MAX_STRING_CHARS = 140;

/** The longest a single sentence may be, in whitespace-separated words. */
const MAX_SENTENCE_WORDS = 20;

/** Sample site label, standing in for whatever the adapter registry supplies. */
const SAMPLE_SITE = "ExampleTube";

/**
 * Every string in `HELP_COPY`, paired with its dotted path so a failure names the
 * exact key rather than just the offending words.
 *
 * Functions are called with a sample argument rather than skipped: `hintAt` is
 * copy too, and it is the one entry that interpolates, which makes it the one
 * most able to blow the length budget.
 */
function collectStrings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") {
    const produced = (value as (arg: string) => unknown)(SAMPLE_SITE);
    return collectStrings(produced, `${path}(${SAMPLE_SITE})`);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectStrings(item, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      collectStrings(item, path === "" ? key : `${path}.${key}`),
    );
  }
  return [];
}

const ALL_COPY = collectStrings(HELP_COPY, "");

test("the copy walk actually reaches the copy", () => {
  // Guards the guard: a refactor that reshapes HELP_COPY must not silently reduce
  // this file to asserting nothing.
  assert.ok(ALL_COPY.length >= 20, `only found ${ALL_COPY.length} strings`);
  const paths = ALL_COPY.map(([path]) => path);
  for (const expected of ["tips[0]", "welcome.title", "rating.label", "shortcut.prefix"]) {
    assert.ok(paths.includes(expected), `walk missed ${expected}`);
  }
});

test("every string is present, trimmed, and single-spaced", () => {
  for (const [path, text] of ALL_COPY) {
    assert.notEqual(text, "", `${path} is empty`);
    assert.equal(text, text.trim(), `${path} has surrounding whitespace`);
    assert.ok(!/\s{2,}/.test(text), `${path} has a double space`);
  }
});

test("no jargon reaches the user", () => {
  for (const [path, text] of ALL_COPY) {
    for (const term of JARGON_LIST) {
      // Word-bounded so "APIs" is caught but "capital" is not. Case-insensitive
      // because "DOM" and "dom" are the same mistake.
      const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      assert.ok(!pattern.test(text), `${path} says "${term}": ${JSON.stringify(text)}`);
    }
  }
});

test("no string outruns its budget", () => {
  for (const [path, text] of ALL_COPY) {
    assert.ok(
      text.length <= MAX_STRING_CHARS,
      `${path} is ${text.length} chars (max ${MAX_STRING_CHARS})`,
    );
  }
});

test("no sentence outruns its budget", () => {
  for (const [path, text] of ALL_COPY) {
    // Split on sentence-ending punctuation followed by a space or end of string,
    // so the em dash and the apostrophe in "Don't" are left alone.
    const sentences = text
      .split(/(?<=[.!?])(?:\s+|$)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).length;
      assert.ok(
        words <= MAX_SENTENCE_WORDS,
        `${path} has a ${words}-word sentence (max ${MAX_SENTENCE_WORDS}): ${JSON.stringify(sentence)}`,
      );
    }
  }
});

test("no site is named in the copy (invariant 2)", () => {
  // Site knowledge belongs to §3. The one place a site appears in the help text is
  // `hintAt`, which takes the label as an argument — which is why the walk above
  // calls it with a made-up site rather than the real one.
  for (const [path, text] of ALL_COPY) {
    if (path.startsWith("welcome.hintAt")) continue;
    assert.ok(!/youtube/i.test(text), `${path} names a site: ${JSON.stringify(text)}`);
  }
});

test("the keyboard hint prints the browser's own combination, with one exception", () => {
  // The order of the keys is the browser's, not ours: the help text sends the
  // reader to the browser's shortcuts page, so re-ordering would make the two
  // disagree. `Alt` -> `Option` is the only permitted transform.
  assert.equal(formatCombo("Alt+Shift+F", false), "Alt+Shift+F");
  assert.equal(formatCombo("Alt+Shift+F", true), "Option+Shift+F");
  assert.equal(formatCombo("Ctrl+Shift+Y", true), "Ctrl+Shift+Y");
  assert.equal(formatCombo("", true), "");
  // Word-bounded, so a key whose name merely contains the letters is untouched.
  assert.equal(formatCombo("Salt+A", true), "Salt+A");
});

test("the shortcut row keeps its separator out of the words", () => {
  // The combination renders as its own `<kbd>` chip, so the prefix must not carry
  // a colon or the row reads "Shortcut: Alt+R" twice over.
  assert.ok(!HELP_COPY.shortcut.prefix.includes(":"));
  assert.ok(!HELP_COPY.shortcut.prefix.endsWith(" "));
});

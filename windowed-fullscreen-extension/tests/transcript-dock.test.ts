// The transcript dock's stylesheet contract (§3).
//
// This layer cannot see layout — only a real YouTube page can, and `verify:live` is
// what looks. What it CAN pin is the structure the fix depends on, and every
// assertion here corresponds to a way the fix silently stops working.
//
// The bug this file guards against: pressing the transcript control in `scrollable`
// mode used to play out in three visible stages — the page scrolled, the panel
// painted below the video, then it jumped into the side column. The cause was that
// every dock rule keyed off the site's own `visibility="…EXPANDED"` attribute, which
// the site does not set until it has already mounted the panel in flow. The fix keys
// the COLUMN rules on "expanded, or a press is in flight" so the column exists in the
// same frame as the press, while leaving the PANEL rules on the expanded panel alone.
//
// Getting that split wrong in either direction is a real regression:
//   - column rules that forget the pending state bring the staged open back;
//   - panel rules that gain it force `display` onto engagement panels the site is
//     deliberately keeping hidden, which shows the reader an empty or wrong panel.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAdapter } from "../src/windowed-fullscreen.ts";

const adapter = resolveAdapter("https://www.youtube.com/watch?v=abc123");
const css = adapter?.getActiveModeCss() ?? "";

/** The attribute value the site sets only once it has expanded a panel. */
const EXPANDED = '[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]';

/** The class our JS sets synchronously on the press, before the site is asked. */
const PENDING = ".wfs-transcript-pending";

/** The engagement panel tag every transcript rule is written against. */
const PANEL_TAG = "ytd-engagement-panel-section-list-renderer";

/**
 * Every `selector { body }` pair in the sheet.
 *
 * Comments are stripped first so a brace inside prose cannot split a rule, and
 * at-rule preludes are skipped — the sheet has exactly one `@media` and no nesting,
 * so flattening is safe and the inner rules are still seen.
 */
function declarationBlocks(text: string): Array<{ selector: string; body: string }> {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ selector: string; body: string }> = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim();
    if (!selector || selector.startsWith("@")) continue;
    out.push({ selector, body: match[2] ?? "" });
  }
  return out;
}

/**
 * Split a selector list on its top-level commas only.
 *
 * A plain `split(",")` is wrong here and quietly so: the transcript selector carries
 * an `:is(a, b, c, d, e)` and a `:has(…)` around it, so naive splitting produces
 * fragments that are not selectors at all.
 */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

const blocks = declarationBlocks(css);

/** Blocks whose selector mentions the engagement panel or its host column. */
const transcriptBlocks = blocks.filter(
  ({ selector }) =>
    selector.includes(PANEL_TAG) || selector.includes(PENDING) || /#panels\b/.test(selector),
);

test("the adapter yields a stylesheet at all, or every test below is vacuous", () => {
  assert.ok(adapter, "the watch URL must resolve to the YouTube adapter");
  assert.ok(css.length > 0, "getActiveModeCss returned nothing");
  assert.ok(transcriptBlocks.length > 0, "no transcript rules found; the filter is wrong");
});

// --- The selector reduction is equivalent, not merely shorter ---------------

test("every removed exact target-id is still covered by a retained substring", () => {
  // The transcript selector used to list six exact `target-id` values in front of the
  // substring branches. They were removed because each is already matched by a
  // substring that remains — this asserts that argument mechanically rather than
  // trusting the comment that records it. A future panel id added as an exact value
  // will fail here unless it is genuinely uncovered.
  const removed = [
    "engagement-panel-searchable-transcript",
    "engagement-panel-structured-description",
    "engagement-panel-macro-markers-description-chapters",
    "engagement-panel-macro-markers-auto-chapters",
    "PAmodern_transcript_view",
    "engagement-panel-transcript",
  ];
  const retained = ["transcript", "structured-description", "macro-markers", "chapters"];

  for (const value of removed) {
    const covered = retained.some((fragment) => value.includes(fragment));
    assert.ok(covered, `${value} is no longer matched by any retained substring branch`);
  }
});

test("the redundant exact target-id branches are gone from the sheet", () => {
  // Not cosmetic: this string is interpolated into dozens of rules, several inside a
  // `:has()`, and a substring attribute match is one of the few selector forms Chrome
  // cannot answer from an index.
  for (const value of [
    "engagement-panel-searchable-transcript",
    "engagement-panel-macro-markers-auto-chapters",
    "PAmodern_transcript_view",
  ]) {
    assert.ok(!css.includes(`target-id="${value}"`), `${value} is back in the stylesheet`);
  }
});

test("the retained substring branches are all present", () => {
  for (const fragment of ["transcript", "structured-description", "macro-markers", "chapters"]) {
    assert.ok(
      css.includes(`[target-id*="${fragment}"]`),
      `the [target-id*="${fragment}"] branch is missing`,
    );
  }
  assert.ok(css.includes("[is-sync-scroll-panel]"), "the sync-scroll branch is missing");
});

// --- The pending / expanded split -----------------------------------------

test("the transcript width token is claimed by a press in flight, not just by an expanded panel", () => {
  const widthRules = blocks.filter(
    ({ body }) => /--wfs-transcript-width:\s*clamp\(/.test(body),
  );
  assert.ok(widthRules.length > 0, "no rule sets the default transcript width");
  for (const { selector } of widthRules) {
    assert.ok(
      selector.includes(PENDING),
      `the reserved column needs the pending state: ${selector}`,
    );
  }
});

test("the column reservation is dropped in browser fullscreen, like the other docks", () => {
  // Windowed mode and browser fullscreen are alternatives, never layers (invariant 4).
  // A press still in flight must not leave the site measuring a player that is holding
  // a column for a panel about to belong to fullscreen's own UI.
  const zeroing = blocks.filter(({ body }) => /--wfs-transcript-width:\s*0px/.test(body));
  assert.ok(zeroing.length > 0, "nothing zeroes the transcript width in fullscreen");
  assert.ok(
    zeroing.some(({ selector }) => selector.includes(PENDING) && selector.includes(":fullscreen")),
    "the fullscreen stand-down does not cover a press in flight",
  );
});

/**
 * CSS specificity as the (id, class, element) triple, for the selector forms this sheet
 * actually uses.
 *
 * Written out because the pending host rule and the un-hide rule both set `position` on
 * `#panels`, both are `!important`, and **specificity is the only thing that decides
 * between them**. A rule that loses does not warn: it simply never applies, and the bug
 * comes back looking like the fix was never made.
 *
 * `:is()` and `:has()` take the highest specificity of their arguments, and `:not()` the
 * same, which is what makes the un-hide selector score as high as it does.
 */
function specificity(selector: string): [number, number, number] {
  let ids = 0;
  let classes = 0;
  let elements = 0;
  let rest = selector;

  // Functional pseudo-classes first: recurse into the argument and take the max.
  const functional = /:(?:is|has|not|matches|any)\(/;
  while (functional.test(rest)) {
    const open = rest.search(functional);
    const parenStart = rest.indexOf("(", open);
    let depth = 0;
    let parenEnd = parenStart;
    for (let i = parenStart; i < rest.length; i += 1) {
      if (rest[i] === "(") depth += 1;
      else if (rest[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          parenEnd = i;
          break;
        }
      }
    }
    const inner = rest.slice(parenStart + 1, parenEnd);
    let best: [number, number, number] = [0, 0, 0];
    for (const arg of splitSelectorList(inner)) {
      const score = specificity(arg);
      if (
        score[0] > best[0] ||
        (score[0] === best[0] && score[1] > best[1]) ||
        (score[0] === best[0] && score[1] === best[1] && score[2] > best[2])
      ) {
        best = score;
      }
    }
    ids += best[0];
    classes += best[1];
    elements += best[2];
    rest = rest.slice(0, open) + " " + rest.slice(parenEnd + 1);
  }

  ids += (rest.match(/#[\w-]+/g) ?? []).length;
  // Classes, attribute selectors and plain pseudo-classes all score in the same column.
  classes += (rest.match(/\.[\w-]+/g) ?? []).length;
  classes += (rest.match(/\[[^\]]*\]/g) ?? []).length;
  classes += (rest.match(/:[\w-]+/g) ?? []).length;
  // Element/type selectors: bare identifiers not preceded by . # : [ or -
  elements += (rest.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []).length;

  return [ids, classes, elements];
}

/** True when `a` beats `b` in the cascade. */
function outranks(a: string, b: string): boolean {
  const [ai, ac, ae] = specificity(a);
  const [bi, bc, be] = specificity(b);
  if (ai !== bi) return ai > bi;
  if (ac !== bc) return ac > bc;
  return ae > be;
}

test("the specificity helper agrees with the spec on the cases that matter here", () => {
  // Guarding the guard. A helper that scored everything 0 would make the test below
  // pass while proving nothing.
  assert.deepEqual(specificity("html.wfs-windowed #panels"), [1, 1, 1]);
  assert.deepEqual(specificity("#panels#panels"), [2, 0, 0]);
  assert.ok(outranks("#a#a", "html.x.y.z #a"), "ids are compared before classes");
  assert.ok(outranks("html.x.y #a", "html.x #a"), "more classes wins at equal ids");

  // The trap, stated as an assertion so the test below is demonstrably not vacuous.
  // Writing the pending host rule with ONE #panels makes it lose to the un-hide rule,
  // and because both are !important the only symptom is the bug quietly returning.
  const unhideBranch =
    'html.wfs-windowed:is(.wfs-transcript-pending, :has(ytd-engagement-panel-section-list-renderer:is([target-id*="transcript"])[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"])) #panels';
  assert.equal(
    outranks("html.wfs-windowed.wfs-transcript-pending #panels", unhideBranch),
    false,
    "a single #panels must lose — this is why the id is repeated",
  );
  assert.equal(
    outranks("html.wfs-windowed.wfs-transcript-pending #panels#panels", unhideBranch),
    true,
    "the repeated id must win",
  );
});

test("the pending host rule out-ranks every other rule setting position on #panels", () => {
  // The failure this prevents is silent. Both rules are !important, so if the pending
  // rule stops out-specifying the un-hide rule, #panels keeps `position: static`, the
  // panel mounts in flow, and the three-stage open returns with no error anywhere.
  const pending = transcriptBlocks.filter(
    ({ selector, body }) =>
      selector.includes(PENDING) && /#panels/.test(selector) && /position:\s*fixed/.test(body),
  );
  assert.equal(pending.length, 1, "expected exactly one pending host rule");
  const pendingSelector = pending[0]?.selector ?? "";

  const competitors = blocks.filter(
    ({ selector, body }) =>
      /#panels\b/.test(selector) && /position:\s*/.test(body) && selector !== pendingSelector,
  );
  assert.ok(competitors.length > 0, "expected the un-hide rule to be found as a competitor");

  for (const { selector } of competitors) {
    for (const branch of splitSelectorList(selector)) {
      if (!/#panels\b/.test(branch)) continue;
      assert.ok(
        outranks(pendingSelector, branch),
        `the pending host rule (${specificity(pendingSelector).join(",")}) does not beat ` +
          `${branch} (${specificity(branch).join(",")})`,
      );
    }
  }
});

test("a press in flight takes the panel host out of flow", () => {
  // This is the rule that actually removes the staged open: with #panels held at the
  // dock's box from the moment of the press, the panel the site mounts is never laid
  // out below the player and is never a scroll target.
  const hostRules = transcriptBlocks.filter(
    ({ selector, body }) =>
      selector.includes(PENDING) &&
      /#panels\b/.test(selector) &&
      /position:\s*fixed/.test(body),
  );
  assert.equal(hostRules.length, 1, "expected exactly one pending host rule");
  const [rule] = hostRules;
  assert.ok(rule);
  // It must reserve the same box the expanded panel later occupies, or the column
  // would visibly move when the site catches up.
  assert.match(rule.body, /width:\s*var\(--wfs-transcript-width\)/);
  assert.match(rule.body, /right:\s*calc\(var\(--wfs-chat-width\) \+ var\(--wfs-panel-width\)\)/);
});

test("no rule reveals a panel the site is keeping hidden", () => {
  // The panel rules must stay keyed on the expanded panel. A `display` override that
  // fires on the pending class alone would apply to EVERY engagement panel that merely
  // exists, including the ones the site has hidden.
  const revealing = transcriptBlocks.filter(
    ({ selector, body }) =>
      selector.includes(PANEL_TAG) &&
      /display:\s*(flex|block)/.test(body) &&
      !selector.includes(EXPANDED),
  );
  assert.deepEqual(
    revealing.map(({ selector }) => selector),
    [],
    "these rules would show a hidden engagement panel",
  );
});

test("the docked panel box itself is still gated on the site having expanded it", () => {
  const fixedPanel = transcriptBlocks.filter(
    ({ selector, body }) =>
      selector.includes(PANEL_TAG) &&
      /position:\s*fixed/.test(body) &&
      /z-index:\s*var\(--wfs-z-panel\)/.test(body),
  );
  assert.ok(fixedPanel.length > 0, "no rule fixes the expanded panel into the dock");
  for (const { selector } of fixedPanel) {
    assert.ok(selector.includes(EXPANDED), `the panel box must require EXPANDED: ${selector}`);
  }
});

// --- Nothing escapes the mode --------------------------------------------

test("every transcript rule is nested under the active-mode class", () => {
  // What makes exit() free: leaving the mode drops the whole section, so there is no
  // transcript state for the restore path to unwind. A rule that forgot the class
  // would keep re-laying-out YouTube for a reader who had switched the mode off.
  for (const { selector } of transcriptBlocks) {
    for (const one of splitSelectorList(selector)) {
      assert.ok(
        one.startsWith("html.wfs-windowed"),
        `transcript rule escapes the mode: ${one}`,
      );
    }
  }
});

test("the pending class is never used without the active-mode class", () => {
  // Reserving a column outside the mode would narrow a page that has no dock.
  for (const { selector } of blocks) {
    if (!selector.includes(PENDING)) continue;
    for (const one of splitSelectorList(selector)) {
      if (!one.includes(PENDING)) continue;
      assert.ok(one.startsWith("html.wfs-windowed"), `pending escapes the mode: ${one}`);
    }
  }
});

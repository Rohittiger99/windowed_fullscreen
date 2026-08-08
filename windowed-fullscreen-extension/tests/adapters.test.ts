// URL matching and the adapter registry. No DOM, no browser.
//
// This is the layer that decides whether the extension touches a page at all, so
// a mistake here is either "does nothing on a video" or "mangles the home page".
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SITE_PREFS,
  modeFor,
  resolveAdapter,
  resolveSiteAdapter,
  supportedSites,
} from "../src/windowed-fullscreen.ts";

test("matches watch pages on every YouTube host", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc123",
    "https://youtube.com/watch?v=abc123",
    "https://m.youtube.com/watch?v=abc123",
    "https://www.youtube.com/watch?v=abc123&t=42s",
  ]) {
    assert.equal(resolveAdapter(url)?.siteId, "youtube", url);
  }
});

test("does NOT activate off the watch page", () => {
  // YouTube keeps #movie_player in the DOM on non-watch pages for the
  // mini-player, so a DOM-presence check would keep the session alive after an
  // SPA navigation and leak the active-mode CSS onto the home page.
  for (const url of [
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/@someChannel",
    "https://www.youtube.com/shorts/abc123",
    "https://www.youtube.com/results?search_query=test",
  ]) {
    assert.equal(resolveAdapter(url), null, url);
  }
});

test("ignores lookalike hosts", () => {
  for (const url of [
    "https://youtube.com.evil.test/watch?v=abc",
    "https://notyoutube.com/watch?v=abc",
    "https://www.youtube.evil.test/watch?v=abc",
  ]) {
    assert.equal(resolveAdapter(url), null, url);
    assert.equal(resolveSiteAdapter(url), null, url);
  }
});

test("survives input that is not a URL", () => {
  for (const url of ["", "not a url", "javascript:alert(1)", "about:blank"]) {
    assert.equal(resolveAdapter(url), null, JSON.stringify(url));
  }
  assert.equal(resolveAdapter(undefined), null);
  assert.equal(resolveSiteAdapter(undefined), null);
});

test("recognises the site even where the mode cannot activate", () => {
  // What lets the popup say "open a video" instead of "not supported here".
  const url = "https://www.youtube.com/feed/subscriptions";
  assert.equal(resolveAdapter(url), null);
  assert.equal(resolveSiteAdapter(url)?.siteId, "youtube");
});

test("every registered adapter is complete and uniquely identified", () => {
  const sites = supportedSites();
  assert.ok(sites.length > 0);
  assert.equal(new Set(sites.map((s) => s.siteId)).size, sites.length, "duplicate siteId");
  for (const { siteId, label } of sites) {
    assert.ok(siteId.length > 0 && label.length > 0);
  }
});

test("the mode a preference selects", () => {
  assert.equal(modeFor({ autoApply: false, scrollable: false }), "cover");
  assert.equal(modeFor({ autoApply: false, scrollable: true }), "scrollable");
  // Documented default: the safe, least surprising one.
  assert.equal(modeFor(DEFAULT_SITE_PREFS), "cover");
  assert.deepEqual(DEFAULT_SITE_PREFS, { autoApply: false, scrollable: false });
});

test("chrome selectors differ per mode, and callers cannot mutate the shared list", () => {
  const adapter = resolveAdapter("https://www.youtube.com/watch?v=abc")!;

  const cover = adapter.getSiteChromeSelectors("cover");
  const scrollable = adapter.getSiteChromeSelectors("scrollable");
  // Scrollable mode keeps the page content below the player — that is the point
  // of the mode — so it must hide strictly less.
  assert.ok(scrollable.length < cover.length);
  assert.ok(cover.every((s) => s.length > 0));

  cover.push("#injected-by-caller");
  assert.ok(!adapter.getSiteChromeSelectors("cover").includes("#injected-by-caller"));
});

test("hidden chrome never includes an ancestor of the player", () => {
  // display:none on an ancestor takes the video with it, even though the player
  // is position:fixed. That produced a black screen once already.
  const adapter = resolveAdapter("https://www.youtube.com/watch?v=abc")!;
  const forbidden = ["#page-manager", "ytd-app", "#content", "#columns", "#primary", "#primary-inner"];
  for (const mode of ["cover", "scrollable"] as const) {
    for (const selector of adapter.getSiteChromeSelectors(mode)) {
      assert.ok(!forbidden.includes(selector), `${selector} is an ancestor of the player`);
    }
  }
});


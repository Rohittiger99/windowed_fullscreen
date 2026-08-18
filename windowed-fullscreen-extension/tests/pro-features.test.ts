// The pure decisions behind the three Pro features: how wide a dock may be, which
// channels the mode switches itself on for, and what a saved frame is called.
//
// None of these needs a browser, which is the point of them being pure. What they
// cannot see is layout — whether the panel's left edge actually lands on the
// player's right edge is `npm run verify:live`, and resizing is exactly what that
// script guards.
import test from "node:test";
import assert from "node:assert/strict";

import {
  captureFilename,
  channelRuleMatches,
  clampDockWidth,
  DEFAULT_DOCK_WIDTHS,
  DEFAULT_SITE_PREFS,
  findChannelRule,
  newChannelRule,
  DOCK_DRAG_RESERVE_PX,
  MAX_CHANNEL_ID_LENGTH,
  MAX_CHANNEL_RULES,
  MIN_DOCK_WIDTH_PX,
  normalizeChannelRules,
  normalizeDockWidth,
  normalizeSitePrefs,
  importSettings,
  copyLinkAtCurrentTime,
  extractTranscriptText,
  copyTranscriptWithTimestamps,
  formatPlaybackTimestamp,
  resolveAdapter,
  type SitePrefs,
} from "../src/windowed-fullscreen.ts";

/** A wide window, where the dock's own bounds are what bind rather than the video. */
const WIDE = 2560;

/**
 * The floor a drag is given at these viewport widths: the dock's default width.
 *
 * Stated as a plain number rather than read from the adapter, so a change to the
 * stylesheet's `clamp()` has to be made deliberately in both places.
 */
const FLOOR = 440;

// --- Dock widths -----------------------------------------------------------

test("a stored width below the floor is pulled up, and any positive width above is kept", () => {
  // No upper cap: whatever the reader dragged to is stored and returned.
  assert.equal(normalizeDockWidth(1400), 1400);
  assert.equal(normalizeDockWidth(MIN_DOCK_WIDTH_PX - 100), MIN_DOCK_WIDTH_PX);
  assert.equal(normalizeDockWidth(420), 420);
  assert.equal(normalizeDockWidth(420.6), 421, "a fractional width is rounded, not floored");
});

test("0 means the stylesheet's own responsive width, and survives as 0", () => {
  // The distinction is load-bearing: 0 follows the window, a number does not.
  assert.equal(normalizeDockWidth(0), 0);
  assert.equal(normalizeDockWidth(-5), 0, "a negative width is nothing chosen, not a floor");
  for (const junk of [undefined, null, NaN, Infinity, "420", {}, []]) {
    assert.equal(normalizeDockWidth(junk), 0, String(junk));
  }
});

test("a drag cannot shrink a dock below the default width it started at", () => {
  // The paid control only opens a dock up. Selling a way to make the dock narrower
  // than the free default would be selling a way to make the product worse.
  const base = { otherDockPx: 0, viewportPx: WIDE, floorPx: FLOOR };
  assert.equal(clampDockWidth({ ...base, proposedPx: 600 }), 600);
  assert.equal(clampDockWidth({ ...base, proposedPx: FLOOR - 1 }), FLOOR);
  assert.equal(clampDockWidth({ ...base, proposedPx: 10 }), FLOOR);
});

test("a floor below the storage minimum is refused, so no drag writes an undrawable width", () => {
  const width = clampDockWidth({
    proposedPx: 0,
    otherDockPx: 0,
    viewportPx: WIDE,
    floorPx: 100,
  });
  assert.equal(width, MIN_DOCK_WIDTH_PX);
});

test("a dock may take the window bar a grabbable strip, video included", () => {
  // The whole complaint the reserve replaced: the drag used to stop with a third of
  // the window still given to the video, which reads as a broken paid feature. It
  // now stops only where the grip would leave the screen.
  const viewportPx = 1200;
  const widest = clampDockWidth({
    proposedPx: 99_999,
    otherDockPx: 0,
    viewportPx,
    floorPx: FLOOR,
  });
  assert.equal(widest, viewportPx - DOCK_DRAG_RESERVE_PX);
});

test("the two docks share one budget, so the second one still has somewhere to go", () => {
  // The live-chat case that looked like chat not resizing at all: with the comment
  // panel docked as well, a 480px reservation for the video left chat almost no
  // travel on a laptop screen. Chat now gets everything the panel is not using.
  const viewportPx = 1400;
  const other = 500;
  const widest = clampDockWidth({
    proposedPx: 99_999,
    otherDockPx: other,
    viewportPx,
    floorPx: FLOOR,
  });
  assert.equal(widest, viewportPx - other - DOCK_DRAG_RESERVE_PX);
  assert.ok(widest > FLOOR, "the second dock had no room to grow");
});

test("a window too narrow for the dock at all returns the floor, not zero", () => {
  // 700px with a 400px chat docked has no room for the panel's default as well. The
  // floor is the least wrong answer: a dock the reader can see and drag back,
  // where 0 would read as the dock having vanished.
  const width = clampDockWidth({
    proposedPx: 400,
    otherDockPx: 400,
    viewportPx: 700,
    floorPx: FLOOR,
  });
  assert.equal(width, FLOOR);
});

test("a clamped width is always a whole number a stylesheet can use", () => {
  for (const proposedPx of [500.4, 500.5, 812.999]) {
    const width = clampDockWidth({
      proposedPx,
      otherDockPx: 0,
      viewportPx: WIDE,
      floorPx: FLOOR,
    });
    assert.equal(Number.isInteger(width), true, String(proposedPx));
  }
});

test("a clamped width always reads back unchanged through storage", () => {
  // The bounds are stated in two places — the drag clamps, the coercion clamps —
  // and if they ever disagree a width the reader dragged to would be silently moved
  // on the next page load.
  for (const proposedPx of [-100, 0, 1, MIN_DOCK_WIDTH_PX, 500, 1200, 99_999]) {
    const dragged = clampDockWidth({
      proposedPx,
      otherDockPx: 0,
      viewportPx: WIDE,
      floorPx: FLOOR,
    });
    assert.equal(normalizeDockWidth(dragged), dragged, `${proposedPx} -> ${dragged}`);
  }
});

test("the drag floor is the width the stylesheet would have drawn", () => {
  // The floor is site knowledge, so it comes from the adapter. If this drifts from
  // `clamp(320px, 26vw, 440px)` in the stylesheet, a drag lands a pixel off the
  // default and the dock looks like it jumped for no reason.
  const adapter = resolveAdapter("https://www.youtube.com/watch?v=abc");
  assert.ok(adapter, "the YouTube adapter should resolve");
  const defaultWidth = adapter.getDefaultDockWidth;
  assert.ok(defaultWidth, "the YouTube adapter should report a default dock width");
  assert.equal(defaultWidth(2560), 440, "capped, so a wide monitor keeps the stage");
  assert.equal(defaultWidth(1000), MIN_DOCK_WIDTH_PX, "floored, so a small window stays usable");
  assert.equal(defaultWidth(1600), 416, "26vw in between");
});

// --- Channel rules ---------------------------------------------------------

test("the rule list is coerced entry by entry, not condemned whole", () => {
  assert.deepEqual(normalizeChannelRules(["@one", 7, "", "  @two  ", null, "@one"]), [
    newChannelRule("@one"),
    newChannelRule("@two"),
  ]);
});

test("a rule written before 2.0.0 reads back asking for no layout of its own", () => {
  // The list held bare identifiers through 1.4.0. A string has to upgrade to a rule
  // that behaves exactly as it did, or updating the extension silently changes what
  // every existing rule does.
  assert.deepEqual(normalizeChannelRules(["@one"]), [newChannelRule("@one")]);
  assert.deepEqual(newChannelRule("@one"), {
    id: "@one",
    scrollable: null,
    panel: false,
    dockWidths: DEFAULT_DOCK_WIDTHS,
  });
});

test("a rule carries its own layout, and a damaged field falls back rather than voiding it", () => {
  assert.deepEqual(
    normalizeChannelRules([
      { id: "@one", scrollable: true, panel: true, dockWidths: { panel: 520, chat: 0 } },
      { id: "@two", scrollable: "yes", panel: "yes", dockWidths: 7 },
    ]),
    [
      {
        id: "@one",
        scrollable: true,
        panel: true,
        dockWidths: { panel: 520, chat: 0, transcript: 0 },
      },
      // Not a boolean means "no preference of its own", which is null for the mode
      // and false for the panel. The rule itself survives.
      { id: "@two", scrollable: null, panel: false, dockWidths: DEFAULT_DOCK_WIDTHS },
    ],
  );
});

test("the rule list is capped, and a non-list reads as no rules", () => {
  const tooMany = Array.from({ length: MAX_CHANNEL_RULES + 20 }, (_, i) => `@channel${i}`);
  assert.equal(normalizeChannelRules(tooMany).length, MAX_CHANNEL_RULES);

  for (const junk of [undefined, null, "@one", 42, {}]) {
    assert.deepEqual(normalizeChannelRules(junk), [], String(junk));
  }
});

test("an overlong identifier is dropped rather than truncated", () => {
  // Truncating would store a rule that matches a different channel, or none, and
  // look like it was saved.
  const long = `@${"a".repeat(MAX_CHANNEL_ID_LENGTH)}`;
  assert.deepEqual(normalizeChannelRules([long, "@fine"]), [newChannelRule("@fine")]);
});

test("a rule matches its channel and nothing else", () => {
  const prefs: SitePrefs = {
    ...DEFAULT_SITE_PREFS,
    channels: [newChannelRule("@one"), newChannelRule("@two")],
  };
  assert.equal(channelRuleMatches(prefs, { id: "@one", label: "One" }), true);
  assert.equal(channelRuleMatches(prefs, { id: "@three", label: "Three" }), false);
  // A renamed channel still matches: the rule is keyed on the identifier, never on
  // the display name, which is the whole reason `ChannelRef` carries both.
  assert.equal(channelRuleMatches(prefs, { id: "@one", label: "Something Else Now" }), true);
});

test("no channel and no rules both mean no", () => {
  const prefs: SitePrefs = { ...DEFAULT_SITE_PREFS, channels: [newChannelRule("@one")] };
  assert.equal(channelRuleMatches(prefs, null), false);
  assert.equal(channelRuleMatches(prefs, { id: "", label: "" }), false);
  assert.equal(channelRuleMatches(DEFAULT_SITE_PREFS, { id: "@one", label: "One" }), false);
});

test("findChannelRule returns the matched rule with its layout profile", () => {
  const ruleScrollable = {
    id: "@scrollableChannel",
    scrollable: true,
    panel: true,
    dockWidths: { panel: 450, chat: 0, transcript: 0 },
  };
  const ruleCover = {
    id: "@coverChannel",
    scrollable: false,
    panel: false,
    dockWidths: DEFAULT_DOCK_WIDTHS,
  };
  const ruleDefault = {
    id: "@defaultChannel",
    scrollable: null,
    panel: true,
    dockWidths: DEFAULT_DOCK_WIDTHS,
  };
  const prefs: SitePrefs = {
    ...DEFAULT_SITE_PREFS,
    channels: [ruleScrollable, ruleCover, ruleDefault],
  };

  assert.deepEqual(
    findChannelRule(prefs, { id: "@scrollableChannel", label: "Scrollable" }),
    ruleScrollable,
  );
  assert.deepEqual(
    findChannelRule(prefs, { id: "@coverChannel", label: "Cover" }),
    ruleCover,
  );
  assert.deepEqual(
    findChannelRule(prefs, { id: "@defaultChannel", label: "Default" }),
    ruleDefault,
  );
  assert.equal(findChannelRule(prefs, { id: "@other", label: "Other" }), null);
  assert.equal(findChannelRule(prefs, null), null);
});

// --- The adapter's channel reading ----------------------------------------

test("the adapter reads a channel identifier, never a display name or a URL", () => {
  // Site knowledge, so this asks the adapter rather than restating a selector. The
  // shape of what it returns is the contract the rules depend on: an id stable
  // across a rename, and a label that is only ever printed.
  const adapter = resolveAdapter("https://www.youtube.com/watch?v=abc")!;
  assert.equal(typeof adapter.readChannel, "function", "the adapter cannot report a channel");
  assert.equal(typeof adapter.findVideo, "function", "the adapter cannot be captured from");
  assert.equal(typeof adapter.getDockWidthCss, "function", "the adapter's docks cannot be resized");
  assert.equal(typeof adapter.measureDockWidth, "function", "the adapter's docks cannot be measured");
});

test("the dock width CSS overrides the defaults and omits an unset dock", () => {
  const adapter = resolveAdapter("https://www.youtube.com/watch?v=abc")!;
  const css = adapter.getDockWidthCss!({ panel: 420, chat: 0, transcript: 0 });

  assert.match(css, /--wfs-panel-width:\s*420px/);
  assert.ok(!/--wfs-chat-width/.test(css), "an unset dock still emitted a rule");
  assert.ok(!/--wfs-transcript-width/.test(css), "an unset transcript dock still emitted a rule");

  const transcriptCss = adapter.getDockWidthCss!({ panel: 0, chat: 0, transcript: 480 });
  assert.match(transcriptCss, /--wfs-transcript-width:\s*480px/);
  assert.ok(!/--wfs-panel-width/.test(transcriptCss));
  assert.ok(!/--wfs-chat-width/.test(transcriptCss));

  // Not inline on <html>, and the selectors have to stay one class short of the
  // fullscreen ones or the fullscreen handoff breaks — see `getDockWidthCss`.
  assert.ok(!/:fullscreen/.test(css), "the width overrode the fullscreen collapse");
  assert.ok(!/!important/.test(css), "an !important here would outrank the fullscreen rule");

  assert.equal(adapter.getDockWidthCss!(DEFAULT_DOCK_WIDTHS), "");
});

// --- Capture filenames ----------------------------------------------------

test("a captured frame is named for what was playing and when", () => {
  const at = new Date(2026, 7, 13, 9, 5, 3);
  assert.equal(captureFilename("youtube-dQw4w9WgXcQ", at), "windowed-fullscreen-youtube-dQw4w9WgXcQ-2026-08-13-090503.png");
});

test("a filename carries nothing a filesystem objects to", () => {
  const at = new Date(2026, 0, 1, 0, 0, 0);
  const name = captureFilename('a/b\\c:d*e?f"g<h>i|j k', at);
  // Colons in particular: a Windows filename cannot hold one, and an ISO timestamp
  // is full of them, which is why the stamp is assembled by hand.
  assert.ok(!/[/\\:*?"<>|\s]/.test(name), name);
  assert.match(name, /\.png$/);
});

test("a site with no name for what is playing still produces a usable filename", () => {
  const at = new Date(2026, 0, 1, 0, 0, 0);
  assert.equal(captureFilename(null, at), "windowed-fullscreen-frame-2026-01-01-000000.png");
  // A stem that survives sanitising as nothing at all must not leave a double dash
  // where the name should be.
  assert.equal(captureFilename("///", at), "windowed-fullscreen-frame-2026-01-01-000000.png");
});

test("captureFilename respects custom templates", () => {
  const at = new Date(2026, 7, 13, 9, 5, 3);
  assert.equal(
    captureFilename("video123", at, "{title}_{date}"),
    "video123_2026-08-13.png",
  );
  assert.equal(
    captureFilename("video123", at, "custom-{stem}-{time}"),
    "custom-video123-090503.png",
  );
  assert.equal(
    captureFilename("video123", at, "{site}-{timestamp}"),
    "windowed-fullscreen-2026-08-13-090503.png",
  );
  assert.equal(
    captureFilename("youtube-123", at, "{title}-{timestamp}", {
      videoTitle: "Amazing Tutorial",
      playbackTimestamp: "12-34",
    }),
    "Amazing-Tutorial-12-34.png",
  );
  assert.equal(
    captureFilename("youtube-123", at, "{channel}-{title}-{timestamp}", {
      videoTitle: "My Video",
      channelName: "@TechChannel",
      playbackTimestamp: "01-15-30",
    }),
    "TechChannel-My-Video-01-15-30.png",
  );
});

test("normalizeSitePrefs coerces 2.0.0 preferences safely", () => {
  const valid = {
    autoApply: true,
    scrollable: true,
    dockWidths: { panel: 400, chat: 350, transcript: 320 },
    channels: [{ id: "@channel", scrollable: false, panel: true, dockWidths: DEFAULT_DOCK_WIDTHS }],
    captureToClipboard: true,
    letterboxColor: "#123456",
    ambientGlow: true,
    captureFilenameTemplate: "{title}-{date}",
    captureBurnTimestamp: true,
    cursorAutoHide: false,
  };
  assert.deepEqual(normalizeSitePrefs(valid), valid);

  // Missing new fields default safely
  const older = {
    autoApply: true,
    scrollable: false,
  };
  const normalized = normalizeSitePrefs(older)!;
  assert.equal(normalized.autoApply, true);
  assert.equal(normalized.letterboxColor, "");
  assert.equal(normalized.ambientGlow, false);
  assert.equal(normalized.captureFilenameTemplate, "");
  assert.equal(normalized.captureBurnTimestamp, false);
  assert.equal(normalized.cursorAutoHide, true);
});

test("importSettings validates json format", async () => {
  const badJson = await importSettings("youtube", "{ invalid json }");
  assert.equal(badJson.ok, false);

  const nonPrefJson = await importSettings("youtube", JSON.stringify({ other: "data" }));
  assert.equal(nonPrefJson.ok, false);
});

test("copyLinkAtCurrentTime handles missing video gracefully", async () => {
  const doc = {
    location: { href: "https://www.youtube.com/watch?v=abc" },
    defaultView: null,
  } as unknown as Document;
  const copied = await copyLinkAtCurrentTime(doc, null);
  assert.equal(copied, false);
});

test("formatPlaybackTimestamp formats seconds into MM:SS and HH:MM:SS", () => {
  assert.equal(formatPlaybackTimestamp(0), "00:00");
  assert.equal(formatPlaybackTimestamp(9), "00:09");
  assert.equal(formatPlaybackTimestamp(75), "01:15");
  assert.equal(formatPlaybackTimestamp(3665), "1:01:05");
  assert.equal(formatPlaybackTimestamp(7325.8), "2:02:05");
});

test("extractTranscriptText extracts segments with timestamps formatted", () => {
  const segment1 = {
    querySelector: (sel: string) => {
      if (sel.includes("timestamp")) return { textContent: "0:06" };
      if (sel.includes("text")) return { textContent: "Yes, Will the video be uploaded on time?" };
      return null;
    },
    textContent: "0:06 Yes, Will the video be uploaded on time?",
  };
  const segment2 = {
    querySelector: (sel: string) => {
      if (sel.includes("timestamp")) return { textContent: "0:13" };
      if (sel.includes("text")) return { textContent: "Perfect Look, it all started from here." };
      return null;
    },
    textContent: "0:13 Perfect Look, it all started from here.",
  };

  const doc = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("transcript-segment")) return [segment1, segment2];
      return [];
    },
  } as unknown as Document;

  const result = extractTranscriptText(doc);
  assert.equal(
    result,
    "0:06 Yes, Will the video be uploaded on time?\n0:13 Perfect Look, it all started from here.",
  );
});

test("extractTranscriptText extracts chapter markers if no transcript segments", () => {
  const chapter1 = {
    querySelector: (sel: string) => {
      if (sel.includes("time")) return { textContent: "0:00" };
      if (sel.includes("title")) return { textContent: "Intro" };
      return null;
    },
    textContent: "0:00 Intro",
  };
  const chapter2 = {
    querySelector: (sel: string) => {
      if (sel.includes("time")) return { textContent: "2:30" };
      if (sel.includes("title")) return { textContent: "Main Content" };
      return null;
    },
    textContent: "2:30 Main Content",
  };

  const doc = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("macro-markers")) return [chapter1, chapter2];
      return [];
    },
  } as unknown as Document;

  const result = extractTranscriptText(doc);
  assert.equal(result, "0:00 Intro\n2:30 Main Content");
});

test("extractTranscriptText extracts lines from open engagement panel content text", () => {
  const panel = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("role='button'")) {
        return [
          { textContent: "0:06 Yes, Will the video be uploaded on time? And the thumbnail?" },
          { textContent: "0:13 Perfect Look, it all started from here." },
        ];
      }
      return [];
    },
    querySelector: () => null,
  };

  const doc = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("ytd-engagement-panel-section-list-renderer")) {
        return [panel];
      }
      return [];
    },
    querySelector: () => null,
  } as unknown as Document;

  const result = extractTranscriptText(doc);
  assert.equal(
    result,
    "0:06 Yes, Will the video be uploaded on time? And the thumbnail?\n0:13 Perfect Look, it all started from here.",
  );
});

test("extractTranscriptText extracts Hindi and multilingual transcripts correctly", () => {
  const segment1 = {
    querySelector: (sel: string) => {
      if (sel.includes("timestamp")) return { textContent: "0:00" };
      if (sel.includes("text")) return { textContent: "तो गाइस आज मैं बन चुका हूं लाइब्रेरियन" };
      return null;
    },
    textContent: "0:00 तो गाइस आज मैं बन चुका हूं लाइब्रेरियन",
  };
  const segment2 = {
    querySelector: (sel: string) => {
      if (sel.includes("timestamp")) return { textContent: "0:10" };
      if (sel.includes("text")) return { textContent: "जो भी नया है प्लीज सब्सक्राइब टू द चैनल" };
      return null;
    },
    textContent: "0:10 जो भी नया है प्लीज सब्सक्राइब टू द चैनल",
  };

  const doc = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("transcript-segment")) return [segment1, segment2];
      return [];
    },
    querySelector: () => null,
  } as unknown as Document;

  const result = extractTranscriptText(doc);
  assert.equal(
    result,
    "0:00 तो गाइस आज मैं बन चुका हूं लाइब्रेरियन\n0:10 जो भी नया है प्लीज सब्सक्राइब टू द चैनल",
  );
});

test("extractTranscriptText returns null when no transcript elements present", () => {
  const doc = {
    querySelectorAll: () => [],
    querySelector: () => null,
  } as unknown as Document;

  assert.equal(extractTranscriptText(doc), null);
});

test("copyTranscriptWithTimestamps handles missing transcript gracefully", async () => {
  const doc = {
    querySelectorAll: () => [],
    querySelector: () => null,
  } as unknown as Document;

  let message = "";
  const copied = await copyTranscriptWithTimestamps(doc, (msg) => {
    message = msg;
  });
  assert.equal(copied, false);
  assert.equal(message, "No transcript found to copy.");
});


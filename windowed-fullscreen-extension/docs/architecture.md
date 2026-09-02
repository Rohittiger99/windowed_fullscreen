# Architecture

How the extension is put together, and where a given change belongs.

Read `../AGENTS.md` first for the invariants. This file assumes them.

## One source file, four bundles

All extension code is in `src/windowed-fullscreen.ts`. `scripts/build.mjs` bundles it
once per Manifest V3 surface, synthesising a one-line entry for each, and esbuild
tree-shakes away everything that surface cannot reach.

| Surface | Entry point | Output |
| --- | --- | --- |
| Content script | `startContentScript()` | `content/index.js` (iife) |
| Service worker | `startServiceWorker()` | `background/service-worker.js` (esm) |
| Toolbar popup | `startPopup()` | `popup/main.js` (esm) |
| Welcome page | `startWelcomePage()` | `welcome/main.js` (esm) |

Four surfaces. There was a fifth, an options page with a `startOptionsPage()` entry,
until 2.0.0. It was removed: `manifest.json` now points `options_ui.page` at
`popup/index.html`, so the toolbar button and the browser's own Options item both land
on the popup. The reason it went is in `settings-and-prompts.md` — briefly, one settings
tree rendered into two hand-written stylesheets, and a CSS fix landed in both files or
it had not landed.

**This is why invariant 1 exists.** A top-level side effect would land in every
bundle. The popup would start shipping content-script logic, and the tree-shaking that
justifies the single-file design would stop paying for itself.

### Release builds are minified

`minify` and `keepNames` are on for every build except `--watch`, the same split
`sourcemap` already used. This is a runtime cost, not a download one: the content script
is injected into **every** youtube.com page and Chrome parses the whole bundle before any
of it runs. Unminified that was 244 kB of a deliberately comment-heavy source file —
150 kB minified. The comments are load-bearing for whoever edits this and dead weight for
the browser reading past them on every page load.

`keepNames` preserves `Function.prototype.name` and class names, which is cheaper than
proving nothing in 13,000 lines reads a name at runtime.

Watch builds stay unminified so DevTools keeps readable identifiers.

### Known debt: §9 names YouTube elements, which invariant 2 forbids

Invariant 2 says the content script works from a `SiteDescriptor` and never names a site
element. **It currently does, in 19 places**, all of them in the transcript and capture code
added for 2.0.0 — the candidate list `toggleTranscript` clicks through, the engagement-panel
tag, the panel header and its close button, the description expander, the tab strip, the
transcript segment and chapter-marker selectors, and the title element the capture filename
reads.

This is the debt the invariant exists to prevent, so it is worth being blunt about the cost:
a YouTube redesign of the engagement panel is currently a §3 **and** §9 change, and a second
video site cannot be added additively the way the invariant promises, because §9 would drive
it with YouTube's selectors.

The fix is mechanical rather than clever — the selectors move onto `SiteAdapter` as named
members (a transcript-open candidate list, a panel-header locator, a segment locator) and §9
reads them off the adapter. It is deliberately **not** bundled with an unrelated change: it
touches every transcript call site at once, and a diff that both moves 19 selectors and
changes behaviour is a diff nobody can review. Do it on its own, with `verify:live` before and
after.

### Known: the adapter does not tree-shake out of the popup or the worker

`ADAPTERS` (§4) is reachable from all four surfaces — the popup calls `supportedSites()`,
the worker calls `resolveAdapter()` — and `youtubeAdapter` is one object literal carrying
`getActiveModeCss()`. So esbuild keeps the whole adapter, `YT_ACTIVE_MODE_CSS` included,
in the popup and worker bundles. Verified by searching the emitted files for
`ytd-watch-flexy`, which is present in all three.

It costs nothing on a YouTube page — the content script is the one bundle that legitimately
needs it — so it is a size and parse cost on the popup and the worker only, and neither is
on a hot path. **It is recorded here rather than fixed** because the fix is structural: the
site-independent surfaces would need a metadata record (`siteId`, `label`, `matches`)
separate from the full adapter that owns the selectors and the stylesheet. That is a real
change to §3/§4's shape and it should be a deliberate decision, not a side effect of a
performance pass. Do not "fix" it by making `getActiveModeCss` lazy: the string is still
referenced from the retained object, so nothing is dropped.

## The section index

Navigate the source by section marker — `§3`, `§7` — never by line number. The file is
around 13,000 lines and any line number written into a document is stale within a
week.

| § | Contents |
| --- | --- |
| §1 | Types |
| §2 | Diagnostics |
| §3 | Site adapters (YouTube) |
| §4 | Adapter registry |
| §5 | Preferences |
| §6 | Active-mode stylesheet |
| §7 | Controller (generic core) |
| §8 | Button injector |
| §9 | Content script |
| §10 | Service worker |
| §11 | Settings UI (the popup's preferences tree) |
| §12 | Popup |
| §13 | Welcome page (post-install) |
| §14 | Entitlement (Pro tier) |

The same index is in the source file's header comment. If you add or rename a section,
change it in three places in the same commit: the header, the section marker itself,
and this table.

## The adapter boundary

**Site knowledge lives only in §3.** Every YouTube selector belongs to the `YT` object
or to `YT_ACTIVE_MODE_CSS`. The controller (§7), the injector (§8) and the content
script (§9) drive the mode from a `SiteDescriptor` and must never name a site element.

Two things this buys, and both have been collected on:

- A YouTube redesign has one blast radius.
- A second video site is an additive change: one `SiteAdapter`, registered in
  `ADAPTERS`, and nothing else.

Two leaks were found and fixed during 2.0.0 — §9 hardcoding `["panel", "chat"]` when
mounting drag grips, and `isDockVisible` querying `#chat` directly. Both go through the
adapter now. Do not reintroduce either.

## Docks

Three dock columns, all on the right.

`DOCK_IDS` is `["chat", "panel", "transcript"]`, ordered **outboard to inboard** — the
order they sit in from the window's edge towards the video. The order is load-bearing,
not cosmetic: each dock's inboard offset is the sum of the widths of the docks outboard
of it, so a width has to be resolved after everything outside it and before everything
inside it. Iterating `DOCK_IDS` is what guarantees that. See `applyDockWidths` in §9.

| Dock | What it holds |
| --- | --- |
| `chat` | Live chat. Docks off the site's own state, no control of ours |
| `panel` | Everything below the video: channel, subscribe, likes, description, comments |
| `transcript` | The interactive transcript |

`DockId` is a union rather than a string so `tsc` becomes the checklist when a dock is
added: every exhaustive `Record<DockId, …>` in the file becomes an error until the new
dock is handled. That is how the transcript dock was added without hunting for call
sites by hand. `YT_DOCKS` in §3 is the per-dock selector table and the one place a dock
is added; `YT_DOCK_ORDER` filters `DOCK_IDS` down to the docks the site actually has.

**Left-side docks were considered and dropped** — not worth the work. Do not build a
`--wfs-docked-left`, a side preference, or a mirrored rule set.

## The width token model

`YT_ACTIVE_MODE_CSS` used to hand-write `--wfs-docked-width` once per combination of
docks. Two docks needed three rules; three docks would have needed seven, and that
table would have rotted.

It is now one sum. Every dock width variable defaults to `0px`, each is set to its
`clamp()` only by the rule that fires when that dock is up, and the total is derived:

```css
html.wfs-windowed {
  --wfs-chat-width: 0px;
  --wfs-panel-width: 0px;
  --wfs-transcript-width: 0px;
  --wfs-docked-width: calc(
    var(--wfs-chat-width) + var(--wfs-panel-width) + var(--wfs-transcript-width)
  );
}
```

One rule covers every combination. Each dock's inboard offset is the sum of the docks
outboard of it. The comment panel's is a token, `--wfs-panel-right: var(--wfs-chat-width)`,
because the panel's close button reads the same number and has to travel with it. The
transcript writes the sum inline —
`right: calc(var(--wfs-chat-width) + var(--wfs-panel-width))` — because nothing else needs
to read it. **There is no `--wfs-transcript-right`;** this file claimed there was for a
release. If you add one, add it because a second element needs the number, not for symmetry.

`--wfs-docked-width` is the one property every narrowing rule reads, so nothing can
disagree about where the video's right edge is.

## Preferences

Per-site, in `chrome.storage.local` under `site:<siteId>`. Nine fields on `SitePrefs`.

**There is no migration step, and there must never be one.** `normalizeDockWidths`
falls back to the old sibling `panelWidth`/`chatWidth` fields when `dockWidths` is
absent. The upgrade happens on every read. Nothing runs once and is remembered as having
run, so nothing can fail halfway. `tests/prefs.test.ts` pins this, including that reading
an old record does not rewrite it.

**Removing a field needs no migration either**, for the same reason. `normalizeSitePrefs`
is a whitelist constructor: it names each field it wants, so a field that is no longer
named is never copied out of the stored record, and `setSitePrefs` merges over the
normalized prefs — so the record is rewritten without it the first time the reader touches
any preference for that site. A 2.0.x record's `channels` array is inert this way.

There is deliberately **no settings export/import**. It was built for 2.0.0 and taken
out before release; the reasoning is in the comment where it used to live, in §5.

## How to make common changes

**Add a video site.** Write a `SiteAdapter` in §3, add it to `ADAPTERS` in §4. Touch
nothing else. The interface is the entire contract; `keepsActivePlayerClasses`
returning false costs you nothing if the site leaves your classes alone.

**Add a control to the player bar.** Add a `ButtonSpec` to the `buttons` array in
`startSession` (§9) and a role to `BUTTON_ROLES` (§8). The injector handles
de-duplication, placement, re-injection after re-render, and removal. Give it an
`isAvailable` if it does not apply to every page. There are five roles today:
`capture`, `copylink`, `transcript`, `mode`, `panel`.

**Add a preference.** Extend `SitePrefs` and `DEFAULT_SITE_PREFS` (§5), then handle it
in `normalizeSitePrefs` — check the new field independently, so values written by an
older version still read as valid instead of being discarded as corrupt. `setSitePrefs`
takes a patch and merges, because the settings UI has one control per field and a
whole-object write would reset the others. A boolean field is automatically eligible
for `SITE_TOGGLES`, which renders one checkbox per entry.

**Add a dock.** Add the id to `DockId`, then let `tsc` find the call sites. Add its
entry to `YT_DOCKS` in §3 and its rules to `YT_ACTIVE_MODE_CSS`. If the width token
model above is intact, nothing outside §3 needs to change.

First decide which kind of dock it is, because it changes the work. A dock the site has
already **mounted and merely hidden** — live chat — needs nothing but an `activeQuery` and
CSS keyed on the site's own attribute; the dock then arrives in the same frame as the
reader's press. A dock the site has to be **asked for** — the transcript — cannot key off
that attribute alone, because the site sets it only after mounting the panel in flow, and
the reader sees the panel appear in the wrong place first. That one needs the column
reserved synchronously on the press, the way `TRANSCRIPT_PENDING_CLASS` does it. Read the
request-vs-reveal trap in `youtube-layout.md` before writing the second kind.

**Gate something behind Pro.** Ask `isPro(pro)` at the one place that decides. Never
store a second copy of the answer. See `pro-and-licensing.md`.

**Change the active-mode layout.** It is all in `YT_ACTIVE_MODE_CSS` (§3), scoped under
`html.wfs-windowed`. Read `youtube-layout.md` first — that file exists because this is
where the bugs live.

**Add a diagnostic.** A stable code in the `DIAGNOSTIC` map (§2), written to the console
and nowhere else. Every retry loop that can give up needs one.

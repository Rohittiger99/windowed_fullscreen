# Working in this repo

Read this before changing anything. It exists so you do not have to infer the
design from the code, and so you do not re-introduce a bug that has already been
fixed once.

`README.md` is for users of the extension. This file is for whoever edits it.

## What it is

A Manifest V3 Chromium extension. It adds a **windowed-fullscreen** mode to
YouTube: the player fills the browser window — the whole screen when the window
is maximized — without ever calling the browser Fullscreen API, so the tab strip,
clock, and taskbar stay visible.

A second control docks everything below the video (channel, subscribe, likes,
description, comments) into a column beside the player.

## Where everything is

```
CHANGELOG.md                 What changed per version. Update it as you go
src/windowed-fullscreen.ts   ALL extension code, one sectioned file
manifest.json                Extension identity. THE version source of truth
public/                      Shipped static assets (icons, page HTML shells)
scripts/build.mjs            Bundles the source once per MV3 surface
scripts/package.mjs          Zips the build for the Web Store
scripts/verify-live.mjs      Layout regression check against real YouTube
tests/                       Unit tests (node:test, no dependencies)
extension/                   BUILD OUTPUT. Never edit; never commit
release/                     The upload zip only
store-assets/                Not shipped: listing copy, screenshots, tiles
```

All the code is in one file on purpose. `scripts/build.mjs` bundles it once per
surface, synthesising a one-line entry for each, and esbuild tree-shakes away
what that surface cannot reach:

| Surface | Entry point |
| --- | --- |
| Content script | `startContentScript()` |
| Service worker | `startServiceWorker()` |
| Options page | `startOptionsPage()` |
| Toolbar popup | `startPopup()` |
| Welcome page | `startWelcomePage()` |

The welcome page is the tab the install event opens. It thanks the reader, asks
them to pin the extension, and lists four usage hints — no settings. It used to
be a dismissible card at the top of the options page, which meant a fresh
install landed on every preference the extension has in order to say two
sentences.

Navigate it by section marker — `§3`, `§7` — not by line number. The section
index is in the file header.

## Commands

```bash
npm install
npm run typecheck     # tsc --noEmit. The primary gate
npm test              # unit tests, no browser needed
npm run build         # emits extension/
npm run verify:live   # layout check against a real watch page (see below)
npm run package       # build + release/windowed-fullscreen-v<version>.zip
                      # refuses if that zip exists — bump the version, or --force
```

Load the unpacked build at `chrome://extensions` → Developer mode → Load
unpacked → select `extension/`.

Before you hand work back: `npm run typecheck && npm test && npm run build`.

## The invariants

Every one of these was learned from a bug. Breaking one is a regression even if
nothing appears to fail.

**1. No top-level side effects.** The `start*` functions are the only way
anything runs. Add a side effect and every surface's bundle inflates with code it
cannot use — the popup would start shipping content-script logic.

**2. Site knowledge lives only in §3.** Every YouTube selector belongs to the
`YT` object or `YT_ACTIVE_MODE_CSS`. The controller, injector, and content script
work from a `SiteDescriptor` and must never name a site element. This is what
keeps a YouTube redesign to one blast radius, and what makes a second site an
additive change.

**3. `enter()` snapshots before mutating; `exit()` restores exactly.** The
snapshot records properties that were *unset* so they can be removed again rather
than left at a computed value. If you add a mutation to `enter()`, add its
capture to `LayoutSnapshot` in the same commit.

**4. Windowed mode and browser fullscreen are alternatives, never layers.**
Both want to own the player's box. With both applied, YouTube measures a player
it does not control, caches a bogus size, and renders its smallest control bar —
a squashed scrubber with the buttons crammed into a corner. §9 stands the mode
fully down for fullscreen. Where it lands afterwards is invariant 7.

**5. Bounded loops only.** Detection, re-render, class re-assertion, and resume
each have an attempt cap and emit a `DIAGNOSTIC` when they give up. Never add an
unbounded retry or an observer that can fight the page forever.

**6. Nothing leaves the device.** No network requests, no `chrome.storage.sync`
(deliberately — sync would replicate settings through the user's browser
account), no analytics. The privacy policy promises this.

**7. Leaving fullscreen retraces the way in.** `selectExitDestination` is a pure
lookup, and for every exit the extension did not request it answers from the two
pending flags the stand-down recorded: **the page comes back to the state
fullscreen was entered from.** Entered from windowed mode with the panel docked,
that is what you get back — including on YouTube's own button, a double-click,
`f`, `Escape`, and the browser's own chrome. Entered from the plain player, the
plain player is what you get back. Our own two buttons name their destination on
top of that: the windowed button asks for the mode, and the comment button docks
the panel whether or not it was open before.

The consequence to keep in mind: `Escape` out of fullscreen gives back **one**
layer, not all of them. Three presses take a docked windowed session to a bare
page — out of fullscreen, out of the panel, out of the mode.

Two halves of the intent mechanism are load-bearing:

- **The intent is written *before* `exitFullscreen()` is called.**
  `fullscreenchange` can arrive synchronously from inside that call, so an intent
  written afterwards reads as absent. The pending flags still bring the mode back,
  but the press is then treated as an ordinary retraced exit — the comment button
  in particular lands with the panel closed, having been pressed to open it.
- **The intent is cleared unconditionally on the leaving edge**, used or not. An
  intent that survives one `fullscreenchange` gets consumed by the next exit,
  which may well be one the reader made for themselves.

An unreleased revision of this made every exit the extension had not requested
land on the plain player, on the argument that people leave fullscreen expecting
the ordinary page. It was reverted: fullscreen is entered *from* somewhere, and
leaving it undoes that one step, not the mode the reader switched on before it and
never asked to leave. Do not reintroduce it. `tests/prompts.test.ts` pins the
lookup and `verify:live` pins all four exit triggers plus the resume.

## Traps that have already bitten

Do not undo these without reading why they are there.

**A player-bar control whose result renders outside the player is dead in the
mode, silently.** YouTube's chapter title ("View chapter") opens the Chapters
engagement panel, and YouTube mounts that panel in `#secondary` — the first entry
in `chromeAlways`, so `display: none` in both modes. The click landed, the panel
opened, and it rendered inside a hidden container behind a player pinned at the top
of the stacking order. Nothing appeared, no error, no diagnostic: the control just
looked broken.

Hiding `#secondary` is not negotiable, so the fix runs the other way. `YT.pageDependentControls`
lists these controls and `onPointerCapture` (§9) tears the mode down
**synchronously, in the capture phase, before the site's handler runs** — via
`exitForPageDependentControl`, which is a real exit, not a stand-down. The ordering
is the whole fix: the site's handler has to find the chrome already restored,
because restoring it afterwards would mean the panel had already laid itself out
inside a `display: none` container, and re-opening it is not something we can do
without naming the site's internals.

That exit also latches auto-apply off for `PAGE_HANDOFF_GRACE_MS`. Without it, the
control bar YouTube rebuilds after the click remounts our button, auto-apply
re-fires, and the reader is back in windowed mode with the panel hidden again one
frame after opening it.

**When adding to `YT.pageDependentControls`, the selector must resolve inside the
player subtree.** An entry outside it matches clicks the mode has nothing to do
with and drops the reader out of the mode for no reason. `adapters.test.ts` asserts
this.

**The rating prompt must never ask for sentiment before deciding which link to
show.** "Enjoying it?" with Yes revealing the review page and No revealing the
support page is **review gating** — the review path is withheld from readers whose
answer was wrong, so the public score becomes what the question let through rather
than what users think. The Chrome Web Store's Spam and Abuse policy forbids
inflating a listing's rating by illegitimate means and the penalty is removal, not
a warning. This has already been taken out of this extension once, as a 4–5 stars
→ store / 1–3 stars → support router; see the long note above `ratingPromptDue`.

Both destinations are shown together, to everyone, on one showing. It is also
simply a better prompt: one press instead of two, and nobody has to pass a
loyalty check before they are allowed to report a bug. `settings-dom.test.ts`
asserts the prompt has exactly three controls — two links and one dismiss — so
adding a yes/no step fails a test.

**The rating prompt asks once, and "once" counts ANSWERS, not renders.** `resolved`
is written when one of the three controls is used. It used to be written on mount,
on the grounds that it made "once" true for the reader who closes the popup without
touching anything and that neither link then needed a write of its own. Both were
true and it was still wrong: the single lifetime ask was spent on a popup opened to
flip a checkbox, so the row was gone at the next opening having asked nobody
anything. Do not move it back. `promptsShown` is written in the same record as an
independent second guard: if only one of the two survives, gate 5 of
`ratingPromptDue` still catches the repeat.

Writing on the answer means writing from a context that is about to be destroyed —
the popup closes as soon as a link opens its tab. So the record is loaded once on
mount and held, and the handler dispatches **one** `set` call merged into that copy.
A read-then-write inside the handler is a bug: the read's round trip is what the
closing popup loses. `auxclick` is handled beside `click` because a middle-click
opens the destination without firing `click`.

**The rating prompt must not share a host with the rating footer.** The footer
repaints by calling `host.replaceChildren()` on every Rating_State change, and the
prompt writes the Rating_State to record the answer. `chrome.storage.onChanged`
fires in the writing context too, so mounting the prompt in
`[data-wfs-footer-host]` destroyed it — on mount back when the write was on mount,
spending a lifetime ask on something nobody saw, and now mid-press instead.
`renderSettings`
provides a separate `[data-wfs-prompt-host]` directly above the footer, and
`settings-dom.test.ts` asserts the two are different nodes. The general rule: any
node a `watchRatingState` subscriber repaints wholesale belongs to that subscriber
alone.

**§11 renders one tree into two hand-written stylesheets, so a CSS fix lands
twice or it has not landed.** `public/options/index.html` and
`public/popup/index.html` each carry their own copy of the shared region styles,
and nothing checks that they agree — the unit tests see structure, not layout.
Both files scope link styling by id (`#app a`, `#settings a`) with
`margin: -4px -8px` so prose links sit flush in a paragraph, which a bare
`.wfs-prompt__action` class cannot outrank. On a row of adjacent controls those
insets cancel the gap and then pull each control 8 px under the one before it.
`margin: 0` on the id-scoped override is the fix and is not optional; the options
page carried it and the popup did not, which shipped a rating prompt whose
"Rate it" sat half-hidden behind "Something is wrong". When you touch a shared
region, open both files.

**`box-sizing` on the panel.** `#below` is `content-box` on YouTube, so a
`width` plus padding renders wider than asked. The panel overhung the video and
swallowed the right end of the control bar — including the fullscreen button.
The dock rule sets `box-sizing: border-box`.

**`100vw` versus a scrollbar.** `100vw` includes the vertical scrollbar; a fixed
element at `right: 0` sits against the viewport's inner edge, which excludes it.
Sizing the player with `calc(100vw - panel)` while positioning the panel at
`right: 0` made them disagree by exactly the scrollbar width on any page that had
one. Cover mode now sizes the player from its `left`/`right` insets instead. Do
not reintroduce `vw` into that calculation.

**Hover zones eat clicks.** The masthead reveal used to be a transparent
pseudo-element stretched across the top of the page. Anything that accepts
pointer events to sense the cursor also swallows clicks meant for what is
underneath — in that case the top of YouTube's guide drawer, so Home and Shorts
became unclickable. Cursor proximity is tracked in JS (`REVEAL_CLASS`) precisely
because no CSS state both senses the cursor and lets clicks through.

**Fullscreen must be pre-empted, not reacted to.** `fullscreenchange` fires
*after* the browser is already fullscreen, which is after YouTube has started
measuring. Standing down there is too late and produces the broken control bar.
§9 stands down in the capture phase of the click, double-click, or `f` keypress
that triggers the request, with `fullscreenchange` as a backstop and a grace
timer to recover if fullscreen never arrives.

**Never inject into the site's button cluster.** YouTube groups its right-hand
controls in `.ytp-right-controls-right`, a flex box sized to an exact number of
48px slots. Putting a button in there does not widen it — YouTube drops one of
its own controls to make room (the cast button was the casualty) and squeezes the
spacing of the rest. The injector anchors after the cluster instead, as a direct
child of the controls container, which is styled `flex: 0 1 auto` and grows.
`outermostChildOf` is what finds that anchor. `npm run verify:live` asserts both
halves of this.

**Controls can become available later than the control bar.** YouTube mounts
`ytd-watch-flexy #below` several seconds *after* the player exists, so the
side-panel toggle is not injectable on the first pass. The detection loop keeps
running while any applicable control is still missing, rather than stopping at
the first success — otherwise the toggle only appeared if some later mutation
happened to trigger a re-check, which on a paused player could be never. Any new
`ButtonSpec` with an `isAvailable` inherits this for free.

**A `SiteDescriptor` field about something that mounts late must be a predicate,
not a snapshot.** `hasSideContent` is a function for exactly this reason. It used
to be the element itself, resolved once in `resolveDescriptor`, and with
auto-apply on it was resolved before `#below` existed — so `setPanelOpen` refused
for the rest of the session and the comment button sat there injected and inert.
Only auto-apply on a reload hit it, because pressing the button by hand happens
long after the block has mounted. Everything else in the descriptor is a genuine
snapshot; if you add a field, decide which kind it is and say so in the comment.
`tests/panel.test.ts` guards this one by mounting the block *after* entry.

**Do not hide an ancestor of the player.** `#movie_player` lives inside
`#page-manager`. `display: none` on an ancestor takes the video with it — a
`position: fixed` descendant is not spared. That produced a black screen. Only
elements outside the player subtree may go in `chromeAlways` / `chromeCoverOnly`.

**`z-index: 2147483647` is a ceiling, not a rank.** z-index is a 32-bit signed
integer, so a rule asking for 2147483648 is clamped back onto the maximum. The
masthead did exactly that to sit "above" the player, tied with it instead, and
lost on document order — `#masthead-container` precedes `#page-manager` — so the
revealed bar painted *behind* a full-viewport player and could be neither seen
nor clicked. §3 now declares an explicit scale (`--wfs-z-player` <
`--wfs-z-panel` < `--wfs-z-chrome` < `--wfs-z-overlay`), all below the maximum,
and `PLAYER_Z_INDEX` in §7 matches the first of them because it lands on the same
element. Adding a layer means adding a token, not reaching for the ceiling.

**Raising the player buries everything the site opens over itself.** YouTube
appends its menus, dialogs and toasts to hosts hanging off `ytd-app` —
`ytd-popup-container`, `snackbar-container`, `tp-yt-app-drawer#guide` — at
z-indexes in the low thousands, not to the button that opened them. So they do
not inherit the masthead's layer, and the notifications and account menus opened
*underneath* the side panel: a sliver visible past its left edge and otherwise
unusable. All three hosts are lifted to `--wfs-z-overlay` at the end of §3. Lift
the host, not the popup: the host holds every popup the site has, including ones
that do not exist yet, and a z-index on it makes a stacking context so the popups
keep their order relative to each other. A z-index alone creates no containing
block, so the `position: fixed` popups inside still anchor to the viewport.
Search suggestions are deliberately absent from that list — they render inside
`yt-searchbox`, so they already ride the masthead.

**The guide drawer may only be lifted while `[opened]`.** It is `position: fixed`
across the whole viewport even when closed, so an unconditional lift parks an
invisible full-window element above the video and eats every click on it — the
same mistake as the masthead hover zone. `verify:live` asserts a closed drawer is
still below the player.

**Read the theme, don't inherit a token you cannot see.**
`--yt-spec-base-background` is not set on `<html>`, so `var(..., #0f0f0f)` on
the panel always resolved to the dark fallback. In dark mode that looked
correct; in the light theme it painted a black column behind YouTube's own
`#0f0f0f` text. Every colour the stylesheet paints now comes from
`--wfs-surface` / `--wfs-edge` / `--wfs-scrim`, defined twice: once for
`html.wfs-windowed` and once for `html[dark].wfs-windowed`, which is the
attribute YouTube itself themes from. `npm run verify:live` flips that attribute
and asserts the panel stays opaque and legible either way.

**Reduced motion means fade, not pop.** `prefers-reduced-motion: reduce` used to
get `transition: none`, which is the obvious reading of the preference and the
wrong one: the masthead then appeared and vanished instantly, which is precisely
the jarring transition the preference exists to prevent. Windows has animations
off by default on plenty of machines, so this was most users. The reduce branch
now zeroes the *travel* (`--wfs-chrome-shift: 0%` in both states) and keeps the
cross-fade. If you add another animated affordance, give it a reduced-motion
variant rather than switching it off.

**The masthead's reveal and hide are deliberately asymmetric.** Arriving is
240ms on a decelerating curve with no delay — the cursor is already heading for
the bar, so any delay reads as lag. Leaving is 320ms on an ease-in-out after a
140ms hold, so drifting a few pixels out of the band does not yank it away. All
six numbers live in custom properties on `#masthead-container`; browsers take
transition timing from the state being transitioned *to*, which is what lets one
`transition` declaration produce two different feels. Do not add a second
`transition` declaration to get the asymmetry — see the next trap for why.

**One state, one declaration.** The masthead reveal used to be two rules setting
`transform`/`opacity`/`pointer-events` `!important` against each other, the more
specific one winning on paper. In practice the reveal only took effect
intermittently, and when it lost the bar stayed off-screen with `pointer-events`
already switched on — hover the top edge, nothing happens, then it appears stuck.
The hidden state now declares the properties once and the revealed state swaps
custom properties (`--wfs-chrome-shift` and friends), so there is no contest.
As a bonus the `prefers-reduced-motion` override works again: the old reveal rule
re-declared `transition` and silently beat it on class count.

**`.ytp-overlay-top-right` is not inside `.ytp-chrome-top`.** YouTube parents it
to `.ytp-overlays-container`, so hiding the in-player title bar left Copy link
and Show cards behind. While the player's controls are showing it stretches 74px
across the whole top of the video — the same strip the masthead reveals into, and
above it in the player's stacking context. Moving the cursor to the top edge is
what un-autohides the controls, so it appeared precisely when it would eat the
hover. It is in the hidden list now. Expect more of this: the top overlay is
several sibling elements, not one.

**YouTube takes `ytp-big-mode` back.** It strips the class whenever it
recomputes its player layout, which silently shrinks the control bar from 72px to
59px and the buttons from 48px to 40px. The controller re-applies the classes it
added, capped at `MAX_CLASS_REASSERTIONS`. If you find a way to own the control
sizing outright, that contest can go away.

**Re-assert the class synchronously. Do not defer it.** YouTube sizes the parts of
the control bar that CSS cannot express — the width of every chapter segment, the
scrubber's offset — in JS pixels from the bar width it last measured, and only
recomputes on a resize. It strips `ytp-big-mode` at the *start* of a relayout and
measures afterwards, so writing the class straight back inside the observer
callback means it measures a player that already has it and its own geometry comes
out right. That is why the plain windowed mode has always looked correct.

Deferring the write by a single animation frame was tried, to "let YouTube finish".
It inverts the outcome: YouTube is then *guaranteed* to measure without the class,
so the geometry is guaranteed stale, and windowed mode with no panel — which was
fine — grew a broken chapter bar with segments that no longer tile it and a scrubber
past the end of the track. Immediate is not a race we are losing; it is the race we
win almost every time.

**The nudge is the fallback, and it must be debounced.** Sometimes YouTube has
already measured before the observer fires, and no synchronous write can help; that
is the side-panel case, where narrowing the player is what makes YouTube disagree
about the size in the first place. Only chaptered videos show it, because a bar
without chapters has almost no per-pixel geometry to get wrong.
`scheduleGeometryRepair` asks for a re-measure once the class writes go quiet.
Debounced because the nudge is a resize, YouTube answers a resize by relayouting,
and a relayout is when it strips the class again — nudging once per strip turned one
disagreement into a contest that burned all 50 reassertions in seconds and gave up,
leaving the small control bar for the rest of the session.
`GEOMETRY_REPAIR_DEBOUNCE_MS` collapses a burst into one repair,
`MAX_GEOMETRY_REPAIRS` bounds it. Verified on a chaptered video across three panel
on/off cycles: the bar spans the player minus its gutters exactly, segments tile to
within 1px, the scrubber lands within 0.001 of the true playhead, and `ytp-big-mode`
stays on.

**A third of a pixel wraps the chapter row.** The chapters are LEFT-FLOATED
segments; YouTube gives each an integer px width in JS, summing with their 4px
gaps to the bar width it last measured — which it rounds. Sizing the bar from its
`left`/`right` insets makes it whatever the player leaves, and that is routinely
fractional: 26vw of panel off a 1536px viewport leaves a 1112.65px bar that
YouTube lays out for 1113px, and any scaled display produces a fractional
viewport with no panel involved. A float row over its container by a third of a
pixel does not overflow, it **wraps**: the last chapter drops onto a second row
6px lower, inside the controls, and paints there as a stray red line under the
scrubber. Measured slack is routinely under a pixel (0.40, 0.70, 0.74 at three
window sizes), so which way YouTube's rounding went decides whether it happens —
hence "intermittent". `.ytp-chapters-container` gets `calc(100% + 1px)`, which is
enough because the deficit is always a rounding remainder. It is the only float
row inside the progress bar; everything else there is overlaid, so nothing else
needs the slack. `overflow: hidden` hides the wrapped segment instead of keeping
it on the row, so the last chapter loses its fill — worse. CSS `round()` would
be the direct fix and needs Chrome 125 against a manifest floor of 116.

**Letterboxing in windowed mode is correct.** A maximized window is
proportionally wider than 16:9 because the browser chrome and taskbar take height
and nothing takes width, so an aspect-preserving fit leaves bars at the sides.
`object-fit: contain` is deliberate. `cover` would fill the window by cropping
the top and bottom of every frame; that was considered and rejected.

## How to make common changes

**Add a video site.** Write a `SiteAdapter` in §3, add it to `ADAPTERS` in §4.
Touch nothing else. The interface is the entire contract; `keepsActivePlayerClasses`
returning false costs you nothing if the site leaves your classes alone.

**Add a control to the player bar.** Add a `ButtonSpec` to the `buttons` array in
`startSession` (§9) and a role to `BUTTON_ROLES` (§8). The injector handles
de-duplication, placement, re-injection after re-render, and removal. Give it an
`isAvailable` if it does not apply to every page.

**Add a preference.** Extend `SitePrefs` and `DEFAULT_SITE_PREFS` (§5), then
handle it in `normalizeSitePrefs` — check the new field independently so values
written by an older version still read as valid instead of being discarded as
corrupt. `setSitePrefs` takes a patch and merges, because the settings UI has one
control per field and a whole-object write would reset the others.

**Change the active-mode layout.** It is all in `YT_ACTIVE_MODE_CSS` (§3),
scoped under `html.wfs-windowed`. `!important` is required throughout: YouTube
sizes the player with inline styles from its own JS. Mode-specific rules key off
`.wfs-scrollable`; panel rules off `.wfs-side-panel`. Watch specificity when
overriding an existing rule — several rules deliberately repeat a selector with
an extra `:not()` to win by class count rather than source order.

## Verifying layout changes

`npm test` covers, one file each: URL matching and the adapter registry
(`adapters.test.ts`), preference storage (`prefs.test.ts`), the controller's panel
state machine (`panel.test.ts`), the usage counter (`rating.test.ts`), the pure
exit-destination and prompt-scheduling decisions (`prompts.test.ts`), the
user-facing copy budget (`help-copy.test.ts`), and the structure the settings tree
builds (`settings-dom.test.ts`). It cannot see layout, because layout only exists
inside a real YouTube page.

`npm run verify:live` fills that gap. It attaches to a Chrome instance over the
DevTools protocol, injects the real content script into a watch page, clicks the
actual buttons, and asserts the geometry invariants:

- the panel's left edge sits exactly on the player's right edge (no overlap)
- the control bar clears the panel
- `ytp-big-mode` survives, so the control bar stays at its large size
- the chapter segments tile the bar on one row, with and without the panel
  (skipped on an unchaptered video, so pass `--url=` one with chapters)
- the layers stay ordered player < panel < masthead < popups, none of them clamped
- the site's own menus and dialogs open above the player and the panel, while a
  closed guide drawer stays below the player so it cannot swallow clicks
- the panel is opaque and legible in both the light and the dark theme
- the revealed masthead owns the top edge, rather than the player's overlay
- clicking the chapter title hands the page back, `#secondary` is visible again so
  the Chapters panel can be seen, and auto-apply does not pull the mode back on
  (skipped on an unchaptered video)
- entering fullscreen leaves no class or inline style of ours behind
- every way out of fullscreen lands where invariant 7 says it should: YouTube's
  button, a double-click, `f`, and `Escape` all hand back the state fullscreen was
  entered from — the mode and the panel exactly as they were, or a clean page when
  it was entered from the plain player — and our own buttons return to windowed
  mode with `ytp-big-mode` intact

Run it before shipping any change to §3's CSS, the controller's geometry, or the
fullscreen handoff. It needs a browser and a network, so it is not part of CI.

## Style

Match what is there. The house style is worth keeping:

- Comments explain **why**, including approaches that failed and why they were
  abandoned. A comment restating the code is noise; a comment recording a dead
  end saves the next person a day.
- Every magic number is a named constant with a comment justifying the value.
- Diagnostics are stable codes in the `DIAGNOSTIC` map, written to the console
  and nowhere else.
- Prefer explicit over clever. Where a selector repeats itself to win on
  specificity, say so rather than relying on file order silently.
- British/American spelling: whatever the surrounding paragraph uses.

## Not goals

Say no to these, and say why:

- **A feature suite.** This does one thing. Enhancer for YouTube already owns
  the everything-app niche; competing there is unwinnable and dilutes the reason
  someone installs this.
- **Fullscreen features.** Browser fullscreen belongs to YouTube, including its
  own comments drawer. See invariant 4.
- **Cropping or stretching video** to avoid letterboxing.
- **`chrome.storage.sync`, telemetry, or any network call.**

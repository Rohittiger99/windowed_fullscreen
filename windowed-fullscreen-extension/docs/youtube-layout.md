# YouTube layout traps

Every entry here was learned from a bug. Read this before touching `YT_ACTIVE_MODE_CSS`
(§3), the controller's geometry (§7), or anything that positions a dock.

Do not undo these without reading why they are there. Run `npm run verify:live` after
any change to this area — it is the only thing in the project that sees layout.

`!important` is required throughout the active-mode stylesheet. YouTube sizes the player
and the control bar with inline styles from its own JS, and those beat ordinary rules.

## Sizing and boxes

**`box-sizing` on the panel.** `#below` is `content-box` on YouTube, so a `width` plus
padding renders wider than asked. The panel overhung the video and swallowed the right
end of the control bar, including the fullscreen button. The dock rule sets
`box-sizing: border-box`.

**`100vw` versus a scrollbar.** `100vw` includes the vertical scrollbar; a fixed element
at `right: 0` sits against the viewport's inner edge, which excludes it. Sizing the
player with `calc(100vw - panel)` while positioning the panel at `right: 0` made them
disagree by exactly the scrollbar width on any page that had one. Cover mode sizes the
player from its `left`/`right` insets instead. **Do not reintroduce `vw` into that
calculation.**

**Letterboxing in windowed mode is correct.** A maximized window is proportionally wider
than 16:9, because the browser chrome and taskbar take height and nothing takes width, so
an aspect-preserving fit leaves bars at the sides. `object-fit: contain` is deliberate.
`cover` would fill the window by cropping the top and bottom of every frame; that was
considered and rejected. Painting the bars — a colour, a gradient, or ambient glow — is
not a violation of this: it makes the bars deliberate rather than removing them.

**Do not hide an ancestor of the player.** `#movie_player` lives inside `#page-manager`.
`display: none` on an ancestor takes the video with it — a `position: fixed` descendant
is not spared. That produced a black screen. Only elements outside the player subtree may
go in `chromeAlways` / `chromeCoverOnly`.

## The control bar

**YouTube takes `ytp-big-mode` back.** It strips the class whenever it recomputes its
player layout, which silently shrinks the control bar from 72px to 59px and the buttons
from 48px to 40px. The controller re-applies the classes it added, capped at
`MAX_CLASS_REASSERTIONS`. If you find a way to own the control sizing outright, that
contest can go away.

**Re-assert the class synchronously. Do not defer it.** YouTube sizes the parts of the
control bar that CSS cannot express — the width of every chapter segment, the scrubber's
offset — in JS pixels from the bar width it last measured, and only recomputes on a
resize. It strips `ytp-big-mode` at the *start* of a relayout and measures afterwards, so
writing the class straight back inside the observer callback means it measures a player
that already has it, and its own geometry comes out right.

Deferring the write by a single animation frame was tried, to "let YouTube finish". It
inverts the outcome: YouTube is then *guaranteed* to measure without the class, so the
geometry is guaranteed stale, and windowed mode with no panel — which was fine — grew a
broken chapter bar with segments that no longer tile it and a scrubber past the end of
the track. Immediate is not a race we are losing; it is the race we win almost every
time.

**The nudge is the fallback, and it must be debounced.** Sometimes YouTube has already
measured before the observer fires, and no synchronous write can help; that is the
side-panel case, where narrowing the player is what makes YouTube disagree about the size
in the first place. Only chaptered videos show it, because a bar without chapters has
almost no per-pixel geometry to get wrong.

`scheduleGeometryRepair` asks for a re-measure once the class writes go quiet. Debounced
because the nudge is a resize, YouTube answers a resize by relayouting, and a relayout is
when it strips the class again — nudging once per strip turned one disagreement into a
contest that burned all 50 reassertions in seconds and gave up, leaving the small control
bar for the rest of the session. `GEOMETRY_REPAIR_DEBOUNCE_MS` collapses a burst into one
repair; `MAX_GEOMETRY_REPAIRS` bounds it.

Verified on a chaptered video across three panel on/off cycles: the bar spans the player
minus its gutters exactly, segments tile to within 1px, the scrubber lands within 0.001
of the true playhead, and `ytp-big-mode` stays on.

**A third of a pixel wraps the chapter row.** The chapters are LEFT-FLOATED segments;
YouTube gives each an integer px width in JS, summing with their 4px gaps to the bar
width it last measured — which it rounds. Sizing the bar from its `left`/`right` insets
makes it whatever the player leaves, and that is routinely fractional: 26vw of panel off
a 1536px viewport leaves a 1112.65px bar that YouTube lays out for 1113px, and any scaled
display produces a fractional viewport with no panel involved.

A float row over its container by a third of a pixel does not overflow, it **wraps**: the
last chapter drops onto a second row 6px lower, inside the controls, and paints there as a
stray red line under the scrubber. Measured slack is routinely under a pixel (0.40, 0.70,
0.74 at three window sizes), so which way YouTube's rounding went decides whether it
happens — hence "intermittent".

`.ytp-chapters-container` gets `calc(100% + 1px)`, which is enough because the deficit is
always a rounding remainder. It is the only float row inside the progress bar; everything
else there is overlaid. `overflow: hidden` hides the wrapped segment instead of keeping it
on the row, so the last chapter loses its fill — worse. CSS `round()` would be the direct
fix and needs Chrome 125 against a manifest floor of 116.

**Never inject into the site's button cluster.** YouTube groups its right-hand controls in
`.ytp-right-controls-right`, a flex box sized to an exact number of 48px slots. Putting a
button in there does not widen it — YouTube drops one of its own controls to make room
(the cast button was the casualty) and squeezes the spacing of the rest. The injector
anchors after the cluster instead, as a direct child of the controls container, which is
styled `flex: 0 1 auto` and grows. `outermostChildOf` is what finds that anchor.
`npm run verify:live` asserts both halves of this.

## Mounting and timing

**Controls can become available later than the control bar.** YouTube mounts
`ytd-watch-flexy #below` several seconds *after* the player exists, so the side-panel
toggle is not injectable on the first pass. The detection loop keeps running while any
applicable control is still missing, rather than stopping at the first success —
otherwise the toggle only appeared if some later mutation happened to trigger a re-check,
which on a paused player could be never. Any new `ButtonSpec` with an `isAvailable`
inherits this for free.

**A `SiteDescriptor` field about something that mounts late must be a predicate, not a
snapshot.** `hasSideContent` is a function for exactly this reason. It used to be the
element itself, resolved once in `resolveDescriptor`, and with auto-apply on it was
resolved before `#below` existed — so `setPanelOpen` refused for the rest of the session
and the comment button sat there injected and inert. Only auto-apply on a reload hit it,
because pressing the button by hand happens long after the block has mounted. Everything
else in the descriptor is a genuine snapshot; if you add a field, decide which kind it is
and say so in the comment. `tests/panel.test.ts` guards this one by mounting the block
*after* entry.

**Anything read out of the below-video block is not there yet when you first ask.**
`#below` mounts several seconds after the player, and the owner row that names the channel
is inside it. `hasSideContent` carries this rule for the panel. Anything else that has to
read from `#below` needs the same treatment: ask again later, with a cap, never once and
never forever.

**On an in-app navigation the block does not go blank first — it keeps the PREVIOUS
video's answer.** This is the second half of the same trap and it is worse than the empty
row, because an empty read is obviously "not yet" while a stale read looks like an answer.
`onVideoChange` fires off the `video-id` swap, and YouTube rebinds the below-video block a
few hundred milliseconds after that, so a read taken from the handler names the video
being left. Treat that as the pattern for anything read out of `#below` across a
navigation: a value that matches the last video is not yet an answer, and the only honest
way to tell a stale row from a genuinely unchanged one is to wait out a bounded window.

**This trap is why per-channel auto-apply rules were removed rather than repaired**, and
the history is worth keeping because it prices the trap. A Pro feature in 2.0.0 let the
reader list channel handles the mode would switch itself on for. Every trigger that runs
`maybeAutoApply` — preferences resolving, the entitlement record arriving, our button
appearing, the video changing — fires before the channel is readable, so `readChannel`
returned null, no rule matched, and the `autoApplied` latch meant nothing looked again. The
rule never fired for anyone. Adding an eight-second bounded retry fixed that and exposed
the stale-row half, which broke it both ways: from an unlisted channel to a listed one the
stale read looked like a decided "no rule here" and the mode never came up, and from a
listed channel to an unlisted one the stale read matched and the mode came up on a channel
the reader never listed. Closing that needed a second window on top of the first,
distrusting any read equal to the outgoing channel — which cannot be a hard refusal,
because two videos from one listed channel in a row legitimately produce a read equal to
the outgoing one and never change.

Two nested bounded windows, a give-up diagnostic, a per-video reset, and the best available
behaviour was still "the mode may arrive two seconds into the video". The feature came out.
**Do not reintroduce anything that has to decide from the owner row at page-load time.** If
per-channel behaviour is wanted, take the channel from something stated before render — the
URL, or an id in the document head.

**A dock that must be REQUESTED cannot key off the site's own "it is open" attribute
alone.** This is the difference between live chat and the transcript, and it is the whole
reason the transcript needed a mechanism chat did not.

`#chat` is already mounted and merely carries `collapsed`. Removing that attribute both
reveals the content and makes `:has(#chat:not([collapsed]))` match, so the dock arrives in
the same frame as the reader's press and there is no intermediate state to see.

The transcript engagement panel does not exist until it is asked for. Keyed on
`[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]` alone, the site sets that attribute
only *after* it has mounted the panel in its own host — and in `scrollable` mode that host,
`#panels` inside `#secondary`, is in normal flow **below the player**, because that mode
deliberately keeps the suggestions rail visible. So a press produced three visible stages:
the page scrolled to the newly mounted panel, the panel painted under the video, and only
then did the dock rules start matching and move it into the column.

The fix is to reserve the column before the site is asked, not to move the panel faster
afterwards. `TRANSCRIPT_PENDING_CLASS` goes on `<html>` synchronously in a capture-phase
click listener — the last moment still ahead of the site's own handler — and while it is set
`#panels` is held at the dock's box. A panel that never enters flow cannot be painted under
the player and **cannot be a scroll target**, which removes all three stages at once instead
of hiding them. Bounded, like every contest with the site: a press that opens nothing gives
the column back and reports `transcript-open-abandoned`.

Two dead ends are worth knowing before touching this again:

- **Patching `Element.prototype.scrollIntoView` does nothing.** A content script runs in an
  isolated world with its own `Element.prototype`, so the patch only ever saw our own calls.
  The site's calls went through the page world's untouched prototype. The code carried a
  comment claiming it stopped the site force-scrolling the window; it never could.
- **The four `scrollTo(0, 0)` calls that were added on top of it were the visible symptom,
  not the cure.** Fired immediately, next frame, +60 ms and +200 ms after a dock change,
  they yanked a reader who had scrolled down straight back to the top a fifth of a second
  after the press. That is what "it scrolls the video first" was. They are gone. If you find
  yourself wanting them back, check whether the pending class stopped working first.

Anything else that has to be *requested* from the site rather than revealed needs the same
shape: claim the space synchronously on the press, bound the wait, release on the site's own
confirmation.

**Anything of ours inside a site subtree gets discarded.** `#below` and `#chat` are the
site's own subtrees and its renderer rebuilds them — on a video change and on every lazy
comment load. So the panel's close button and every dock drag grip hang off `<body>` and
are positioned onto the dock's edge, which keeps the dock the site's element and the
control ours. The close button is mounted once per session and shown by the stylesheet
from the same class that docks the panel, so there is no second piece of state to keep in
step. Both the panel and its button read `--wfs-panel-right` for their distance from the
window edge, which is what stops the button drifting off the corner when chat docks
outboard of the panel.

## Cost

Readers reported YouTube feeling laggy with the extension installed. These are the causes
found and fixed, and they share a shape: work paid on every page whether or not the mode
was ever switched on.

**Never observe the player subtree with `subtree: true`.** `#movie_player` is the busiest
part of YouTube. Caption cues mount and unmount as the video speaks, the progress bar
rebuilds its segments, chapter markers and storyboard previews come and go. A
`{ childList: true, subtree: true }` observer there allocates a `MutationRecord` and queues
a microtask for every one of those. `ButtonInjector` did exactly that, falling back to
`documentElement`, for the whole life of every watch page — to answer a question about four
buttons that had not moved. §7's `startPlayerWatcher` already carried a comment calling
document-wide subtree observation "a real source of jank on YouTube" and carefully watched
only the player's parent for `childList`; the injector was the same mistake one element down.

It now watches the controls container and that container's parent, `childList` only, no
subtree. Our controls are direct children of the container, so their removal is visible; the
site can swap the container wholesale, so the parent covers that. Neither node churns during
playback. The initial mount needs no observer at all — the bounded detection loop already
covers it — so `syncObserver` refuses to watch anything until a bar exists, and `ensureButtons`
re-points it when the bar is replaced.

That change fixed a correctness bug in the same place. The callback funnels into a
`DEBOUNCE_MS` timer that is cleared and re-armed per batch, so under a mutation stream that
never pauses for 100 ms — playback with captions on — the timer was reset forever and
`ensureButtons` never ran. Cost and correctness usually fail together here.

**A cheap attribute filter does not make a cheap callback.** `onSiteDockChange` watches
`collapsed` and `visibility` across the document. The filter is cheap; the callback was not.
YouTube puts `collapsed` on its description and comment expanders, so opening ten comment
replies ran the callback ten times, and each run fell through to
`doc.querySelector(YT.transcriptPanel)` — an eleven-branch `:is()` with three substring
attribute matches, walked across the whole document.

That query was also *wrong*, which is the more interesting half. Reaching it proved nothing
carried the expanded value, so the `expanded` it computed was always `false`; the only thing
it contributed was the panel's identity. Feeding that into the dedupe meant an engagement
panel being created or replaced **while the transcript was shut** counted as a dock change —
and a dock change costs `refreshGeometry()`, which dispatches a synthetic `resize` at each of
`REFLOW_NUDGE_DELAYS_MS`. Five whole-page relayouts to report that a dock nobody could see
had been replaced by another one nobody could see. It now reports `null` while nothing is
expanded, which keeps every transition that can move the layout and drops the ones that
cannot.

**A `pointermove` handler on `document` runs about a hundred times a second.** The idle-cursor
reset ran in full on every one of them — a `classList` write on `<html>` and a `clearTimeout`
— on every watch page, for the life of the session, whether or not the mode was on. It now
returns immediately when the mode is inactive. The listener stays registered rather than
being mounted and unmounted with the mode: one comparison per event is cheaper than getting
an add/remove lifecycle wrong.

**A redundant selector branch is paid on every style recalculation.** `YT.transcriptPanel`
listed six exact `[target-id="…"]` values in front of the substring branches, and every one
of them was already matched by a substring that remained. The string is interpolated into
roughly forty rules, several inside a `:has()`, and a substring attribute match is one of the
few selector forms Chrome cannot answer from an index. Eleven branches became five, provably
matching the same set; `tests/transcript-dock.test.ts` asserts the equivalence mechanically
so nobody re-adds the exact values "for documentation".

**Not investigated, and the honest next step.** The active-mode stylesheet is injected on
every watch page and never removed. It is 88 kB, 96 declaration blocks, and **34 of those
blocks use `:has()`** — 91 `:has()` occurrences once the selector lists are counted out.
Every one is scoped under `html.wfs-windowed`, so nothing *renders* differently with the mode
off, but Chrome still sets up `:has()` invalidation for the arguments and re-checks on
relevant DOM mutations. Whether that is measurable on a real watch page is **unknown** — it
was not measured, so it was not changed.

(Counting these from the source is misleading, because `YT_TRANSCRIPT_DOCKED` holds one
`:has()` that is interpolated into about twenty rules. Count the generated string that
`getActiveModeCss()` returns, the way `tests/transcript-dock.test.ts` does.) Deferring the site sheet until first activation is the
obvious experiment, and the obstacle is that seven rules in it are not scoped under the mode
class (`.wfs-panel-close`, `.wfs-dock-grip`, and five for `.wfs-copy-transcript-btn`, which
can be injected with the mode off). Measure before moving them.

## Layers

**`z-index: 2147483647` is a ceiling, not a rank.** z-index is a 32-bit signed integer,
so a rule asking for 2147483648 is clamped back onto the maximum. The masthead did exactly
that to sit "above" the player, tied with it instead, and lost on document order —
`#masthead-container` precedes `#page-manager` — so the revealed bar painted *behind* a
full-viewport player and could be neither seen nor clicked.

§3 declares an explicit scale (`--wfs-z-player` < `--wfs-z-panel` < `--wfs-z-chrome` <
`--wfs-z-overlay`), all below the maximum, and `PLAYER_Z_INDEX` in §7 matches the first of
them because it lands on the same element. Adding a layer means adding a token, not
reaching for the ceiling.

**Raising the player buries everything the site opens over itself.** YouTube appends its
menus, dialogs and toasts to hosts hanging off `ytd-app` — `ytd-popup-container`,
`snackbar-container`, `tp-yt-app-drawer#guide` — at z-indexes in the low thousands, not to
the button that opened them. So they do not inherit the masthead's layer, and the
notifications and account menus opened *underneath* the side panel: a sliver visible past
its left edge and otherwise unusable.

All three hosts are lifted to `--wfs-z-overlay` at the end of §3. **Lift the host, not the
popup:** the host holds every popup the site has, including ones that do not exist yet, and
a z-index on it makes a stacking context so the popups keep their order relative to each
other. A z-index alone creates no containing block, so the `position: fixed` popups inside
still anchor to the viewport. Search suggestions are deliberately absent from that list —
they render inside `yt-searchbox`, so they already ride the masthead.

**The guide drawer may only be lifted while `[opened]`.** It is `position: fixed` across
the whole viewport even when closed, so an unconditional lift parks an invisible
full-window element above the video and eats every click on it — the same mistake as the
masthead hover zone below. `verify:live` asserts a closed drawer is still below the player.

## The masthead

**Hover zones eat clicks.** The masthead reveal used to be a transparent pseudo-element
stretched across the top of the page. Anything that accepts pointer events to sense the
cursor also swallows clicks meant for what is underneath — in that case the top of
YouTube's guide drawer, so Home and Shorts became unclickable. Cursor proximity is tracked
in JS (`REVEAL_CLASS`) precisely because no CSS state both senses the cursor and lets
clicks through.

**The masthead ends where the dock starts.** Chat's close button and overflow menu sit in
the strip the masthead reveals into, so the revealed bar landed on top of them and chat
could not be closed. Raising the panel above the bar is the obvious fix and the wrong one:
`--wfs-z-chrome` outranks `--wfs-z-panel` deliberately, and inverting it buries the
masthead's own account, notifications and Create buttons, which live at the right-hand end
of the bar — exactly where the dock is. That trades one unreachable control set for
another. Insetting `#masthead-container`'s `right` by `--wfs-docked-width` removes the
overlap instead, so there is no z-index contest and both control sets stay reachable.

**One state, one declaration.** The masthead reveal used to be two rules setting
`transform`/`opacity`/`pointer-events` `!important` against each other, the more specific
one winning on paper. In practice the reveal only took effect intermittently, and when it
lost the bar stayed off-screen with `pointer-events` already switched on — hover the top
edge, nothing happens, then it appears stuck. The hidden state now declares the properties
once and the revealed state swaps custom properties (`--wfs-chrome-shift` and friends), so
there is no contest. As a bonus the `prefers-reduced-motion` override works again: the old
reveal rule re-declared `transition` and silently beat it on class count.

**The reveal and the hide are deliberately asymmetric.** Arriving is 240ms on a
decelerating curve with no delay — the cursor is already heading for the bar, so any delay
reads as lag. Leaving is 320ms on an ease-in-out after a 140ms hold, so drifting a few
pixels out of the band does not yank it away. All six numbers live in custom properties on
`#masthead-container`; browsers take transition timing from the state being transitioned
*to*, which is what lets one `transition` declaration produce two different feels. Do not
add a second `transition` declaration to get the asymmetry — see the trap above for why.

**`.ytp-overlay-top-right` is not inside `.ytp-chrome-top`.** YouTube parents it to
`.ytp-overlays-container`, so hiding the in-player title bar left Copy link and Show cards
behind. While the player's controls are showing it stretches 74px across the whole top of
the video — the same strip the masthead reveals into, and above it in the player's stacking
context. Moving the cursor to the top edge is what un-autohides the controls, so it
appeared precisely when it would eat the hover. It is in the hidden list now. Expect more
of this: the top overlay is several sibling elements, not one.

## Theme and motion

**Read the theme, do not inherit a token you cannot see.**
`--yt-spec-base-background` is not set on `<html>`, so `var(..., #0f0f0f)` on the panel
always resolved to the dark fallback. In dark mode that looked correct; in the light theme
it painted a black column behind YouTube's own `#0f0f0f` text. Every colour the stylesheet
paints comes from `--wfs-surface` / `--wfs-edge` / `--wfs-scrim`, defined twice: once for
`html.wfs-windowed` and once for `html[dark].wfs-windowed`, which is the attribute YouTube
itself themes from. `npm run verify:live` flips that attribute and asserts the panel stays
opaque and legible either way.

**Reduced motion means fade, not pop.** `prefers-reduced-motion: reduce` used to get
`transition: none`, which is the obvious reading of the preference and the wrong one: the
masthead then appeared and vanished instantly, which is precisely the jarring transition
the preference exists to prevent. Windows has animations off by default on plenty of
machines, so this was most users. The reduce branch zeroes the *travel*
(`--wfs-chrome-shift: 0%` in both states) and keeps the cross-fade. If you add another
animated affordance, give it a reduced-motion variant rather than switching it off.

## Docks and drag

**A dock width written inline on `<html>` breaks the fullscreen handoff.** The active-mode
stylesheet sets `--wfs-panel-width: 0px` while fullscreen is up, so the site measures an
honest layout in the frames before the mode stands down. An inline custom property on
`<html>` outranks every stylesheet rule, `!important` or not, so writing the reader's
chosen width there beats that collapse and hands YouTube a player still holding a
panel-sized gap — which is the broken control bar of invariant 4, reached by a new route.

The widths go into a second `<style>` element instead (`getDockWidthCss` in §3,
`writeDockWidthCss` in §6), whose selectors are one class short of the fullscreen ones so
they lose to them and beat the `clamp()` defaults on source order. It must also carry no
`!important`, for the same reason.

**Nudge the site to re-measure on drag END only.** `refreshGeometry()` dispatches a
synthetic resize, YouTube answers a resize with a relayout, and a relayout is when it
strips `ytp-big-mode` — so one nudge per `pointermove` turns a single width change into a
contest that burns all 50 class reassertions in a couple of seconds and leaves the small
control bar for the rest of the session. The drag previews in CSS only, coalesced to one
write per animation frame, and asks for exactly one re-measure when the pointer is
released.

**The drag opens a dock up and nothing else. Do not reserve width for the video.** The
only ceiling is `DOCK_DRAG_RESERVE_PX` (24px), which exists so the grip stays on screen
and the drag stays reversible — not to protect the picture. A dock may take almost the
whole window and leave the video a sliver, because the same grip drags it straight back
and a reader who wants chat at full width has asked for exactly that.

An earlier revision reserved 480px for the player, the width at which YouTube starts
dropping control-bar buttons; on a 1366px window with both docks up that left the second
dock a few pixels of travel, so the paid feature read as broken to the people who had
bought it. It was removed and must not come back.

The floor is the other half of the same rule: `getDefaultDockWidth` (§3) mirrors the
stylesheet's `clamp(320px, 26vw, 440px)`, and a drag stops there — the paid control never
makes a dock narrower than the free default. Change that `clamp()` and change the function
in the same commit.

**The width budget has to read the OTHER docks.** With more than one dock up, each can
pass its own ceiling and the total can exceed the window. `clampDockWidth` takes
`otherDockPx` for that reason, and it is the argument that is easy to drop when the
function looks like it only needs its own dock's width.

**A stored width outlives the window it was chosen in.** 1500px chosen on a monitor,
reopened on a 1200px laptop, would paint a dock wider than the viewport and put its grip
off the left edge — a width nobody can undo. `applyDockWidths` (§9) clamps what is
PAINTED on entry, on a preference change, and on `resize`, while leaving the stored number
alone so a wider window gets the full width back. Do not "simplify" this by clamping the
stored value instead.

## Live chat

**Live chat docks off the site's state, not ours.** `#chat` carries a `collapsed`
attribute while the reader has the panel shut, so `:has(#chat:not([collapsed]))` is
exactly "the site is showing chat". The whole feature is that one selector: pressing
YouTube's own chat toggle is all it takes, collapsing it unwinds the dock, and on a video
with no chat nothing matches and the section costs nothing. There is no class of ours, no
state, and nothing for `exit()` to restore — every rule is nested under `.wfs-windowed`.

**`#secondary` has to be revealed**, because `#chat` lives inside it and `display: none`
on an ancestor takes a `position: fixed` descendant with it. It is revealed as a bare host
with every rail role stripped and `#related` hidden, so it collapses to nothing and only
the fixed chat paints. That `!important` also has to outrank the inline `display: none`
the controller writes onto `#secondary` as a chrome element; a stylesheet `!important`
beats an inline declaration without one, which is why the JS and the CSS do not fight.

**A CSS-only dock still has to tell the core it moved.** Being free of JS is the appeal of
that section and it is also what broke the control bar: YouTube sizes its scrubber in JS
pixels from the width it last measured and only recomputes on a resize, so closing chat
widened the player from CSS alone and left a chat-width scrubber sitting in a full-width
bar. Toggling our own comment panel appeared to fix it, because `setPanelOpen` already
nudges — which is how the bug was found.

The adapter's `onSiteDockChange` (§3) watches the `collapsed` attribute and calls
`controller.refreshGeometry()` (§7), the same re-measure the comment panel earns, so one
width change gets one answer whichever side caused it. Two traps in that watcher:
`collapsed` is **not unique to chat** — the description and comment expanders carry it
too, so the mutation only counts after re-reading chat's actual state — and the state it
caches is a **pair** (which frame, and whether it is showing) rather than a boolean,
because a chat *mounting* is not an attribute mutation. Cache a bare `false` for "no chat
here" and the reader's first collapse reads `false` again, reports nothing, and the bug is
back.

**Chat and the comment panel coexist, chat on the outside.** The first version stood chat
down whenever the panel was docked, reasoning that two docks on one strip leave neither
usable. It failed in the one case that matters: the site's "Open panel" chat button is
reachable from inside the docked panel, so pressing it expanded a chat that had nowhere to
render and never appeared — the reader pressed a button and nothing happened. Both dock
now, the video giving up `--wfs-docked-width`. Chat keeps the outer edge because it owns
its own close button.

## Ambient glow

Letterbox bars paint from `--wfs-letterbox-color`. Custom solid swatches
(`LETTERBOX_SWATCHES`, five of them) and gradient mix themes (`LETTERBOX_THEMES`, six) set
that property directly.

When `ambientGlow` is on, an ambient canvas (`#wfs-ambient-glow-canvas`) mounts behind the
video and renders frame-synced light via `requestVideoFrameCallback`, blurred in CSS
(`filter: blur(48px) saturate(160%)`) so the work stays on the GPU. Selecting any custom
palette or theme explicitly turns `ambientGlow` off, and enabling glow clears the custom
colour — the two would otherwise fight over one property.

The sampler has a written budget, because invariant 5 is suspicious of loops:

- It draws into a small offscreen canvas rather than reading the full frame.
  `getImageData` over a 4K canvas copies 33 million bytes.
- It samples a few times a second, not per frame.
- It stops while the tab is hidden, and in browser fullscreen.
- It stops for good after a few consecutive tainted or black reads, so protected playback
  costs nothing.
- **It never touches layout.** Making the site re-measure is what produces the broken
  control bar, and a sampler running several times a second is the worst possible place to
  do it.

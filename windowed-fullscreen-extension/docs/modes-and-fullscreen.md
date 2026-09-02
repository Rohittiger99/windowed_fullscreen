# Modes, and the fullscreen handoff

The two rules in this file are invariants 4 and 7. Both were learned from bugs that
looked like the extension was broken rather than wrong.

## The two modes

Windowed mode has two shapes, chosen by a per-site preference:

- **`cover`** — the player is fixed to the viewport and the page cannot scroll. Nothing
  but the video is reachable, which is the point.
- **`scrollable`** — the player is a viewport-sized block at the top of the normal
  document flow. It fills the screen on arrival, but scrolling continues past it to the
  title, description and comments, and scrolling back up returns to the video.

Neither calls the browser Fullscreen API. That is the whole product: the window stays an
ordinary maximized window, so the tab strip, the clock and the taskbar remain visible.

## Windowed mode and browser fullscreen are alternatives, never layers

Both want to own the player's box. With both applied, YouTube measures a player it does
not control, caches a bogus size, and renders its smallest control bar — a squashed
scrubber with the buttons crammed into a corner.

§9 stands the mode fully down for fullscreen. Browser fullscreen belongs to YouTube,
including its own comments drawer.

**Fullscreen must be pre-empted, not reacted to.** `fullscreenchange` fires *after* the
browser is already fullscreen, which is after YouTube has started measuring. Standing
down there is too late and produces the broken control bar. §9 stands down in the capture
phase of the click, double-click or `f` keypress that triggers the request, with
`fullscreenchange` as a backstop and a grace timer to recover if fullscreen never
arrives.

## Leaving fullscreen retraces the way in

`selectExitDestination` is a pure lookup. For every exit the extension did not request,
it answers from the two pending flags the stand-down recorded: **the page comes back to
the state fullscreen was entered from.**

Entered from windowed mode with the panel docked, that is what you get back — on
YouTube's own button, a double-click, `f`, `Escape`, and the browser's own chrome alike.
Entered from the plain player, the plain player is what comes back.

Our own buttons name their destination on top of that: the windowed button asks for the
mode, and the comment button docks the panel whether or not it was open before.

**The consequence to keep in mind:** `Escape` out of fullscreen gives back **one** layer,
not all of them. Three presses take a docked windowed session to a bare page — out of
fullscreen, out of the panel, out of the mode.

Two halves of the intent mechanism are load-bearing:

- **The intent is written *before* `exitFullscreen()` is called.** `fullscreenchange` can
  arrive synchronously from inside that call, so an intent written afterwards reads as
  absent. The pending flags still bring the mode back, but the press is then treated as an
  ordinary retraced exit — the comment button in particular lands with the panel closed,
  having been pressed to open it.
- **The intent is cleared unconditionally on the leaving edge**, used or not. An intent
  that survives one `fullscreenchange` gets consumed by the next exit, which may well be
  one the reader made for themselves.

**An unreleased revision made every exit the extension had not requested land on the plain
player**, on the argument that people leave fullscreen expecting the ordinary page. It was
reverted: fullscreen is entered *from* somewhere, and leaving it undoes that one step, not
the mode the reader switched on before it and never asked to leave. Do not reintroduce it.

`tests/prompts.test.ts` pins the lookup. `npm run verify:live` pins all four exit
triggers plus the resume.

## Entering and exiting the mode

**`enter()` snapshots before mutating; `exit()` restores exactly.** The snapshot records
properties that were *unset*, so they can be removed again rather than left at a computed
value.

If you add a mutation to `enter()`, add its capture to `LayoutSnapshot` in the same
commit. Mutations that have their own remover — the dock width stylesheet, the letterbox
CSS, the glow canvas, the drag-resizing class — are torn down by that remover rather than
by the snapshot restore, which is consistent as long as each one actually has a teardown
path.

`Escape` dismisses one layer at a time and gives back exactly one: browser fullscreen →
side panel → mode.

## Controls whose result renders outside the player

**A player-bar control whose result renders outside the player is dead in the mode,
silently.** YouTube's chapter title ("View chapter") opens the Chapters engagement panel,
and YouTube mounts that panel in `#secondary` — the first entry in `chromeAlways`, so
`display: none` in both modes. The click landed, the panel opened, and it rendered inside
a hidden container behind a player pinned at the top of the stacking order. Nothing
appeared, no error, no diagnostic: the control just looked broken.

Hiding `#secondary` is not negotiable, so the fix runs the other way.
`YT.pageDependentControls` lists these controls and `onPointerCapture` (§9) tears the mode
down **synchronously, in the capture phase, before the site's handler runs** — via
`exitForPageDependentControl`, which is a real exit, not a stand-down.

**The ordering is the whole fix.** The site's handler has to find the chrome already
restored, because restoring it afterwards would mean the panel had already laid itself out
inside a `display: none` container, and re-opening it is not something we can do without
naming the site's internals.

That exit also latches auto-apply off for `PAGE_HANDOFF_GRACE_MS`. Without it, the control
bar YouTube rebuilds after the click remounts our button, auto-apply re-fires, and the
reader is back in windowed mode with the panel hidden again one frame after opening it.

**When adding to `YT.pageDependentControls`, the selector must resolve inside the player
subtree.** An entry outside it matches clicks the mode has nothing to do with and drops the
reader out of the mode for no reason. `tests/adapters.test.ts` asserts this.

## Bounded loops only

Detection, re-render, class re-assertion, geometry repair, resume
and the transcript open each have an attempt cap or a timeout, and emit a `DIAGNOSTIC` when
they give up. The transcript open is the one bounded by a *timeout* rather than an attempt
count — it reserves the dock column on the press and gives it back after
`TRANSCRIPT_PENDING_TIMEOUT_MS` if the site never opens a panel, reporting
`transcript-open-abandoned`.

Never add an unbounded retry, or an observer that can fight the page forever. The failure
mode is not a crash — it is an extension that quietly burns its retry budget and leaves
the reader with a degraded player for the rest of the session.

**Nor an observer that is merely expensive.** A bounded loop that never spins can still cost
the page every frame. See the "Cost" section of `youtube-layout.md`: the button injector held
a `subtree: true` observer on the player for the life of every watch page, which is what
readers were feeling as lag, and the same narrow scoping fixed a debounce that under a
continuous mutation stream meant the callback never ran at all.

## Cut deliberately

**A deeper "zen" control bar** — hiding `.ytp-chrome-bottom` until the mouse moves. Cut
because that is the exact surface the `ytp-big-mode` reassertion machinery already fights
YouTube over. High regression risk against `verify:live` for a small win. Do not add it
back without deciding that risk is acceptable.

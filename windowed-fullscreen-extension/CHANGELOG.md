# Changelog

Notable changes per released version. `manifest.json` owns the version number and
is bumped immediately before packaging, so the top section here is unreleased work
until that bump happens.

## 2.0.0

A major bump from the published 1.3.0, because three things change what a returning
reader has to re-learn: a paid tier exists, the settings moved into the popup, and the
docks carry settings of their own.

A 1.4.0 was built and never published. Its section was folded in here rather than listed
as a release nobody could install.

### Added — Pro, $10 once

A paid tier. No subscription, no account, no login: a licence key is the only credential.
It covers a limited number of devices, and **Remove key** hands that device's slot back so
the key can be used elsewhere. The key is re-checked roughly once a fortnight and **the
check fails open** — if it cannot complete, nothing changes and you keep every feature.

**Nothing that was free has moved behind the paywall.** All eight paid features below are
new work.

1. **Dock resizing** — drag the comment panel, live chat and transcript columns
   independently. A grip sits on each dock's inboard edge; drag it, or focus it and use the
   arrow keys, `Shift` for a bigger step. Widths are remembered per site.
2. **Transcript dock** — the interactive transcript as its own docked column, beside the
   video rather than in the rail the mode hides.
3. **Channel profiles** — per-channel rules carrying the mode, whether the panel is docked,
   and the dock widths. Matched on the channel's handle, so a rename does not quietly break
   one. Capped at 50 rules per site.
4. **Frame capture** — save the current frame at the video's own resolution, with no
   interface in the picture. A per-site setting copies it to the clipboard instead of
   downloading it.
5. **Custom filename templates** — `{title}`, `{date}`, `{time}`, `{timestamp}`, `{site}`.
6. **Burned timestamp** — stamp the playback time into the corner of a captured frame.
7. **Ambient glow** — letterbox bars lit in real time from the video's own edge colours,
   sampled on the GPU.
8. **Custom letterbox palettes** — 5 solid cinema swatches, 6 gradient mix themes, and a
   colour picker with hex input.

Selecting a custom colour or theme turns ambient glow off, and enabling glow clears the
custom colour. The two would otherwise fight over one property.

The capture button is shown whether or not you have a licence: pressing it without one
opens a prompt naming the price rather than doing nothing. The drag grips and the rules
list are simply absent without one.

### Added — free

- **Live chat docks beside the player on a livestream**, taking width from the video rather
  than covering it, the same as the comment panel. It follows YouTube's own chat toggle:
  open the panel and it docks, collapse it and the dock unwinds. The comment panel can stay
  docked alongside it, chat on the outside.
- **The suggestions rail is back in scrollable mode.** Scrolling past the player used to
  give one wide column of comments and nothing else. It now lays out the way the ordinary
  watch page does — comments left, the chip bar and related videos right — while the player
  above still fills the window. The rail is plain flow content, so the page's single
  scrollbar moves both columns together.
- **Copy video link at the current timestamp**, from a new player-bar button, with
  formatted feedback (`Link copied at MM:SS`) and a clipboard fallback. Free on purpose:
  the mode hides `.ytp-overlay-top-right`, where YouTube's own share control lives, so this
  repairs a loss the mode causes.
- **Idle cursor auto-hide** — the cursor fades after three seconds of inactivity in
  windowed mode. On by default, and switchable per site. Free because it costs almost
  nothing and makes the free mode feel finished.
- **A close button on the docked comment panel**, matching the one the site puts on its own
  chat panel. Closing the panel previously meant knowing that the player-bar comment button
  toggles, or that `Escape` gives back one layer — both true, neither visible.
- **A keyboard shortcut for the comment button**, `Alt+Shift+D`, and an unbound one for
  saving a frame. Both rebindable at `chrome://extensions/shortcuts`. The capture shortcut
  ships unbound on purpose: Chrome lists every command there whatever your tier, so a
  default binding would take a key combination away from every free install for a feature
  they do not have.
- **The masthead now ends where a dock begins**, so the revealed bar no longer covers
  chat's close button and overflow menu — which made a docked chat impossible to close —
  while keeping the bar's own account and notification buttons reachable.

### Changed

- **The settings live in the toolbar popup.** There is no separate options page any more;
  `options_ui` points at the popup, so the toolbar button and the browser's own Options item
  both land in the same place. Pro is a second view inside the popup rather than a tab
  beside the preferences, so you get the whole width for the pitch or for the preferences
  and never scroll past a price to reach a checkbox.
- **A licence key is entered where you are.** The in-page Pro prompt carries the key field
  itself, under **Already bought Pro?**, so activating a key you bought on another machine
  no longer means leaving the video.
- **Five controls beside YouTube's fullscreen button**, up from two: capture, copy link,
  transcript, windowed mode, comment panel.
- **The settings are grouped into four cards** — *Viewing Modes & Playback*,
  *Letterbox Themes*, *Media & Frame Capture*, and *Auto-Fullscreen Channels* — instead of
  one flat column.
- **A refused key says which kind of refusal it was.** Three messages where there had been
  one: check what you pasted, this key is on the maximum number of devices, or this key is
  no longer active. The single message had a real cost — a key refused for the activation
  limit read as a key typed wrongly, so the natural response was to paste it again, and
  every attempt consumed another activation. The split reads the provider's documented
  status code, never its prose — a code is part of the API contract and prose is not, so an
  unrecognised code falls back to the general refusal. Entitlement is still decided by the
  status alone, before any of this is looked at.
- **The privacy position has one exception now, and it is worth stating outright.** Up to
  1.3.0 the extension made no network requests at all. It still makes none unless you have
  entered a licence key — in which case that key, and an id for this device's activation, is
  sent to the payment provider that issued it: when you enter the key, roughly once every 14
  days after, and once more if you remove it. Nothing else. No account, no identifier of
  ours, no page you were on, no video, no history, and no fingerprint of your machine. There
  is no server on our side at all, so there is nowhere for anything to be kept. Saving a
  frame is entirely local.
- The rating prompt reads "Enjoying it? Rate it, or share a suggestion." The feedback
  control is **"Any suggestions?"** rather than "Something is wrong", which presumed a
  fault, and the dismiss control is **"Cancel"**. "Rate it" is the primary control.

### Fixed

- **Per-channel auto-apply now actually fires.** A rule was checked at four moments —
  preferences loading, the licence record arriving, the player-bar button appearing, and the
  video changing — and all four happen before YouTube has put the channel name on the page.
  The channel read as unknown, so no rule matched, and nothing looked a second time. It now
  waits up to eight seconds for the page to name its channel, and gives up in the console
  rather than watching forever.
- **The padlock beside a Pro setting now disappears once Pro is active.** The checkbox
  unlocked and became usable, but the padlock next to it stayed, so a setting you had paid
  for still looked locked.
- **Closing live chat now gives the whole bar back to the player.** The video widened but
  YouTube kept the scrubber at its chat-width size, so the progress bar stopped short of the
  controls beside it. It only looked right after toggling the comment panel, which happened
  to make YouTube re-measure. Chat's own toggle now asks for that re-measure directly.
- **Protected videos no longer save a black rectangle.** Capture reports that the frame came
  back blank instead.
- **Closing the transcript from YouTube's own button now closes it.** It re-opened itself a
  moment later: a retry meant to help when the first press did not take could not tell a
  successful close apart from a press that failed, so it undid the close.
- **The transcript now docks the moment you press it.** It used to open in three visible
  stages: the page scrolled, the transcript appeared below the video, and then it moved into
  the side column. The column is now reserved before YouTube is asked for the panel, so the
  panel arrives in the column and the page does not move. Most visible in scrollable mode,
  which is where the transcript had somewhere below the video to appear.
- **Pressing the transcript no longer jumps you to the top of the page.** If you had
  scrolled down to the comments, opening the transcript pulled the view back to the video a
  fifth of a second later.

### Performance

Readers reported YouTube feeling laggy with the extension installed. Four causes, all of
them work being done on every watch page whether or not windowed mode was ever switched on.

- **The player is no longer watched for changes wholesale.** The extension kept a watch on
  the entire video-player subtree so it could tell if YouTube removed its buttons. That
  subtree is the busiest part of the page — caption lines, the progress bar, chapter markers
  — so it was being woken constantly to answer a question about four buttons that had not
  moved. It now watches only the control bar the buttons sit in. This also fixed a bug in
  the same place: during playback with captions on, the changes never paused long enough for
  the check to actually run.
- **Opening comment replies no longer costs a page re-measure.** A dock check ran an
  expensive search of the whole page every time YouTube collapsed or expanded anything, and
  could conclude that a panel nobody could see had changed — which triggered five full
  re-layouts of the page.
- **Moving the mouse costs nothing with the mode off.** The idle-cursor timer was being reset
  on every mouse movement across every watch page, for a cursor that only hides in windowed
  mode.
- **The extension is 39% smaller.** Release builds are minified: the part injected into every
  YouTube page went from 244 kB to 150 kB, which is that much less for the browser to read
  before the page can use it.

No feature changed, and nothing was removed to achieve any of this.

### Removed

- **The options page.** One settings tree was rendering into two hand-written stylesheets
  with nothing checking that they agreed, so a CSS fix landed in both files or it had not
  landed. It shipped one visible bug that way. The popup was already the surface people
  used.
- **Settings backup and restore.** Built during this release and taken out before it
  shipped. Ten checkboxes and widths take seconds to set by hand, and an import is an
  untrusted record arriving from a file picker, which would make a coercion bug a
  data-integrity bug.

### Internal

- Unit tests go from 65 to 176, including the new `entitlement.test.ts`,
  `pro-features.test.ts` and `transcript-dock.test.ts`. `prefs.test.ts` existed as an empty
  file while two other test files and `docs/testing.md` cited it as covering preference
  coercion and the no-migration promise; it now does.
- A patch on `Element.prototype.scrollIntoView` is gone. A content script runs in an
  isolated world with its own prototypes, so it only ever intercepted our own calls and
  never YouTube's — it could not do what its comment claimed.
- The dock stylesheet derives one `--wfs-docked-width` from three per-dock tokens, instead
  of hand-writing a rule per combination of docks. Two docks needed three rules; three would
  have needed seven.
- Editing documentation is split out of `AGENTS.md` into `docs/`, because `AGENTS.md` had
  grown past the point where an agent reads all of it.


## 1.3.0

### Changed

- Rebuilt settings, popup, and options UI.
- The star row's vertical arrow keys follow the ARIA Authoring Practices: `Down`
  advances, `Up` goes back. They were inverted.
- The site toggles' accessible names now contain their visible labels, so voice
  control reaches them by what is on screen (WCAG 2.5.3). "Scrollable mode" was
  announced as "Scrollable windowed fullscreen on YouTube", which shares no
  phrase with the visible text.
- The review link no longer carries `?hl=en-US&utm_source=ext_sidebar`. `hl`
  forced English on readers whose browser is not English, and `ext_sidebar` named
  a surface this extension does not have.
- The popup no longer asks for "Inter" first. Nothing bundles it and no remote
  font is loaded, so the popup rendered in a different face from the options and
  welcome pages.

### Added

- A **welcome page** on install: thanks, one pin instruction, and four usage
  hints. No settings on it on purpose.
- A **rating row** in the settings footer, and a prompt that is asked **once** in
  the extension's whole life and then never again. Once *answered*: closing the
  popup without touching it leaves the prompt there for the next opening. The
  prompt asks "Enjoying it?" and offers both answers together — rate it, or say
  what is wrong — because showing the review link only to readers who answered the
  question the right way is review gating, which the Chrome Web Store forbids and
  removes listings over. Kept entirely on the device; selecting a star opens the
  store's review page and transmits nothing.
- A **feedback link** to the support page, permanently visible rather than gated
  behind a low score.
- A **pin prompt** in the popup, at most twice, and never once the browser reports
  the action is already pinned.
- A collapsed **Tips** section and the current keyboard combination, read from the
  browser rather than hard-coded.

### Fixed

- **The chapter title in the player bar did nothing in windowed mode.** Clicking
  "View chapter" opens YouTube's Chapters panel, and YouTube mounts that panel in
  `#secondary` — which the mode hides in order to reclaim the width the
  related-videos rail was taking. So the click landed, the panel opened, and it
  rendered inside a hidden container behind the player. Clicking it now hands the
  page back first, and the panel opens exactly as it does on an ordinary watch
  page.

- **The rating prompt destroyed itself.** It mounted into the same node as the
  rating footer, and the footer repaints wholesale on every rating-state change —
  including the write the prompt makes to the rating record. The prompt vanished on
  sight while still spending one of the three lifetime asks. It now has its own
  host.
- **The rating prompt's controls overlapped in the popup.** "Rate it" sat half
  hidden behind "Something is wrong". The popup's link styling carries negative
  side margins so links can sit flush inside a paragraph, and on a row of adjacent
  controls those margins cancelled the gap and then pulled each control under the
  one before it. The row also had no wrapping rule there, so three controls could
  not share 320 px. The options page already had both fixes.
- **Opening the popup used up the rating prompt.** The showing was recorded the
  moment the prompt rendered, so closing the popup — or opening it to flip a
  checkbox and never reading the row — spent the single lifetime ask, and the
  prompt was gone at the next opening having asked nobody anything. It is now
  recorded when one of its three controls is used, so it keeps its place until it
  has been answered once.
- **Synthetic `resize` events outlived the page they were for.** The reflow nudge
  scheduled by `exit()` was only cancelled by the next nudge, which never comes on
  a torn-down session, so up to 1.2 seconds of events fired at a page the
  extension no longer owned after an in-app navigation. The controller has a
  `dispose()` now and the session calls it last.
- **Restoring the player's inline layout could undo half of itself.** The `inset`
  shorthand was restored after its four longhands, and removing `inset` removes
  them too. Shorthand now comes first.
- The debounced geometry repair reports when it gives up, like every other bounded
  loop in the file. It used to hit its cap silently.
- Leaving a watch page is detected through an adapter hook rather than a
  YouTube-specific event named in the content script, which was the one place site
  knowledge had leaked out of the adapter.

### Tests

- Unit tests go from 35 to 65. New: `prompts.test.ts` (the exit-destination lookup
  and every documented gate of both prompt schedulers), `help-copy.test.ts` (the
  copy budget its own doc comment had claimed was enforced since before the file
  existed), and `settings-dom.test.ts` (the settings tree's structure, including a
  regression guard for the prompt/footer host bug).
- `npm run verify:live` contradicted itself over where a fullscreen exit lands,
  asserting one answer in the stand-down leg and the opposite forty lines below, so
  it could not pass. Both legs now assert the shipped rule — the exit hands back
  the state fullscreen was entered from — and its fourth Escape case reports itself
  as unreachable instead of quietly re-running the third.

## 1.2.0

First published release.

- Windowed-fullscreen mode: the player fills the browser window without calling
  the Fullscreen API, so the tab strip, clock, and taskbar stay visible.
- A button beside YouTube's native fullscreen control, plus the toolbar popup and
  `Alt+Shift+F`.
- A comment button that docks everything below the video into a column beside the
  player.
- The masthead slides away and returns on a cursor at the top edge.
- Per-site **cover** and **scrollable** modes, and optional per-site auto-apply.
- Survives YouTube's in-app navigations without a reload.
- Fixed: YouTube's chapter row wrapping its last segment onto a second line in
  windowed mode, which painted a stray red line under the scrubber.

# Changelog

Notable changes per released version. `manifest.json` owns the version number and
is bumped immediately before packaging, so the top section here is unreleased work
until that bump happens.

## 1.4.0

### Added — Pro

A paid tier, $5 once. No subscription, no account, no login: a licence key is the
only credential, entered on the options page's **Pro** tab. It covers a limited
number of devices, and **Remove key** hands that device's slot back so the key can
be used elsewhere.

**Nothing that was free has moved.** The comment panel, both modes, the live-chat
dock, the suggestions rail, and per-site auto-apply have all been free since
1.2.0, and stay free. All three Pro features below are new work.

- **Drag either docked column as wide as you like.** A grip appears on the dock's
  inboard edge; drag it, or focus it and use the arrow keys — `Shift` for a bigger
  step. The width is remembered per site. Comments and live chat both resize, and
  either one can take almost the whole window — down to a sliver of video, if that
  is how you want to read chat. The same grip drags it back. Widening is all the
  drag does: it stops at the default width on the way in, so it cannot make a dock
  narrower than it is without a licence. With both columns docked they share one
  budget, so the two together always leave the grips reachable.
- **Save the current frame as an image**, from a new button to the left of the
  windowed one, at the video's own resolution. A per-site setting copies it to the
  clipboard instead of downloading it. Protected videos cannot be captured — the
  browser hands back a blank frame — and the extension says so rather than saving
  a black rectangle.
- **Switch the mode on automatically for chosen channels**, rather than for the
  whole site. Open the popup on a video and the channel is filled in for you. The
  rules are matched on the channel's handle, so a rename does not quietly break
  one, and are capped at 50 per site.

The capture button is shown whether or not you have a licence: pressing it without
one opens a prompt that names the price rather than doing nothing. The drag grips
and the rules list are simply absent without one.

**The options page is two tabs now: Settings and Pro.** Your preferences are the
first tab and Pro is the second, so changing a setting no longer means scrolling
past a price. The Pro tab says what the three features are and what they cost, and
entering a key — a once-per-device job — is folded into a row underneath called
**Already bought Pro?**, which opens on its own if a check is running or a key was
refused. The popup carries one line about Pro and a button that opens that tab; it
holds neither the feature list nor the key field, because a 36-character key is not
something to paste into a 320px window over the video you are watching.

**Buy** goes straight to the payment provider's checkout. An earlier revision sent
it to a page on the product site that handed off to the provider, which kept the
freedom to change provider without an extension release; that freedom was traded for
one fewer step in front of a $5 purchase. It is one string, so the hop can come back
if there is ever a page worth it.

**A refused key now says which kind of refusal it was.** Three, where there had been
one sentence covering all of them: check what you pasted, this key is on the maximum
number of devices, or this key is no longer active. The single message was a real
cost, not a cosmetic one — a key refused for the activation limit read as a key typed
wrongly, so the natural response was to paste it again, and every attempt consumed
another activation. The split reads the provider's documented error code, never its
message: a code is part of the API contract, prose is not, and an unrecognised code
falls back to the general refusal. Entitlement is still decided by the status alone,
before any of this is looked at.

### Added

- A keyboard shortcut for the comment button, `Alt+Shift+D`, and an unbound one
  for saving a frame. Both rebindable at `chrome://extensions/shortcuts`.
- **The suggestions rail is back in scrollable mode.** Scrolling past the player
  used to give one wide column of comments and nothing else. It now lays out the
  way the ordinary watch page does — comments left, the chip bar and related
  videos right — while the player above still fills the window. The rail is plain
  flow content, so the page's single scrollbar moves both columns together.
- **Live chat docks beside the player on a livestream**, taking width from the
  video rather than covering it, the same as the comment panel. It follows
  YouTube's own chat toggle: open the panel and it docks, collapse it and the dock
  unwinds. The comment panel can stay docked alongside it, chat on the outside.
- The masthead now ends where a dock begins, so the revealed bar no longer covers
  chat's close button and overflow menu — which made a docked chat impossible to
  close — while keeping the bar's own account and notification buttons reachable.

### Fixed

- **Per-channel auto-apply now actually fires.** A rule was checked at four
  moments — preferences loading, the licence record arriving, the player-bar button
  appearing, and the video changing — and all four happen before YouTube has put
  the channel name on the page. The channel read as unknown, so no rule matched,
  and nothing looked a second time. It now waits up to eight seconds for the page
  to name its channel, and gives up in the console rather than watching forever.

- **The padlock beside a Pro setting now disappears once Pro is active.** The
  checkbox unlocked and became usable, but the padlock next to it stayed, so a
  setting you had paid for still looked locked.

- **Closing live chat now gives the whole bar back to the player.** The video
  widened but YouTube kept the scrubber at its chat-width size, so the progress bar
  stopped short of the controls beside it. It only looked right after toggling the
  comment panel, which happened to make YouTube re-measure. Chat's own toggle now
  asks for that re-measure directly.

- **A close button on the docked comment panel**, matching the one the site puts
  on its own chat panel. Closing the panel previously meant knowing that the
  player-bar comment button toggles, or that `Escape` gives back one layer — both
  true, neither visible.

### Changed

- **The privacy position has one exception now, and it is worth stating outright.**
  Up to 1.3.0 the extension made no network requests at all. It still makes none
  unless you have entered a licence key — in which case that key, and an id for
  this device's activation, is sent to the payment provider that issued it: when
  you enter the key, roughly once every 14 days after, and once more if you remove
  it. Nothing else. No account, no identifier of ours, no page you were on, no
  video, no history, and no fingerprint of your machine. There is no server on our
  side at all, so there is nowhere for anything to be kept. If the check cannot
  complete, nothing changes and you keep every feature. Saving a frame is entirely
  local.
- The rating prompt reads "Enjoying it? Rate it, or share a suggestion." The
  feedback control is now **"Any suggestions?"** rather than "Something is wrong",
  which presumed a fault, and the dismiss control is **"Cancel"**.
- "Rate it" is now the prompt's primary control, in blue.

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

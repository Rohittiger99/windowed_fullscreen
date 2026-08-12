# Changelog

Notable changes per released version. `manifest.json` owns the version number and
is bumped immediately before packaging, so the top section here is unreleased work
until that bump happens.

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

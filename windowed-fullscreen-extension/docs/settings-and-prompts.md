# Settings UI and prompts

§11 builds the popup's preferences tree. §12 is the popup shell. This file covers the
rules that shape both, and the prompts that appear inside them.

## The popup is the only settings surface

There is no options page. `manifest.json` points `options_ui.page` at `popup/index.html`,
so the toolbar button and the browser's own Options item both land here.

Up to 2.0.0 there were two, and `renderSettings` built either one from a `surface` flag.
The options page got a heading, a Settings/Pro tab strip and the full Pro panel; the popup
got a single Pro row that opened that page. It was removed for two reasons:

- **The standing cost.** One settings tree rendered into two hand-written stylesheets, and
  nothing checked that they agreed — the unit tests see structure, not layout. A CSS fix
  landed in both files or it had not landed. The selectors were not even copy-pasteable
  between them, because one scoped by `#app` and the other by `#settings`. That asymmetry
  shipped a rating prompt whose primary control sat half-hidden behind its sibling on one
  surface and not the other.
- **It earned nothing.** Both menu entries can point at one surface.

The removal also took ~330 lines of `renderProSection`, which was a near-duplicate of the
live `renderProView`.

**If a second settings surface is ever added, share the stylesheet rather than copying
it.**

## Pro is a second view, not a second panel

`startPopup` swaps the preferences tree out for `renderProView` and back. The reader gets
the whole 320 px for the pitch or for the preferences, and never scrolls past a paywall to
reach a checkbox. That was the point of the old tab strip, and a view swap achieves it in
one surface.

The preferences tree carries a teaser row — one sentence and a button — rather than the
pitch itself. `renderProSummary` builds it and `openProPanel` is required, not optional: a
row that silently does nothing is worse than no row.

An earlier design argued the popup was the wrong place for a feature list or a 36-character
key, because it is 320 px wide and opens over a half-watched video. That was right about the
width and wrong about the fix: closing the reader's popup and opening a settings tab to
answer "what is Pro?" costs more than a cramped column does. Giving the pitch the whole
popup solves the width problem without the navigation.

## The four message regions stay direct children of the root

`[data-wfs-status]`, `[data-wfs-error]`, `[data-wfs-prompt-host]` and
`[data-wfs-footer-host]`, in that order, as direct children of the tree's root.

Load-bearing for two reasons: `startPopup` finds all four by marker on the tree it was
handed, and activation reports into the same region a checkbox does.
`tests/settings-dom.test.ts` asserts the order against `root.children`, so moving one
inside a section fails a test rather than shipping.

## The rating prompt

**It must never ask for sentiment before deciding which link to show.** "Enjoying it?" with
Yes revealing the review page and No revealing the support page is **review gating** — the
review path is withheld from readers whose answer was wrong, so the public score becomes
what the question let through rather than what users think.

The Chrome Web Store's Spam and Abuse policy forbids inflating a listing's rating by
illegitimate means and the penalty is removal, not a warning. This has already been taken
out of this extension once, as a 4–5 stars → store / 1–3 stars → support router.

Both destinations are shown together, to everyone, on one showing. It is also simply a
better prompt: one press instead of two, and nobody has to pass a loyalty check before they
are allowed to report a bug. `tests/settings-dom.test.ts` asserts the prompt has exactly
three controls — two links and one dismiss — so adding a yes/no step fails a test.

**It asks once, and "once" counts ANSWERS, not renders.** `resolved` is written when one of
the three controls is used. It used to be written on mount, on the grounds that it made
"once" true for the reader who closes the popup without touching anything. That was true and
it was still wrong: the single lifetime ask was spent on a popup opened to flip a checkbox,
so the row was gone at the next opening having asked nobody anything. Do not move it back.

`promptsShown` is written in the same record as an independent second guard: if only one of
the two survives, gate 5 of `ratingPromptDue` still catches the repeat.

**Writing on the answer means writing from a context that is about to be destroyed** — the
popup closes as soon as a link opens its tab. So the record is loaded once on mount and
held, and the handler dispatches **one** `set` call merged into that copy. A
read-then-write inside the handler is a bug: the read's round trip is what the closing popup
loses. `auxclick` is handled beside `click` because a middle-click opens the destination
without firing `click`.

**The prompt must not share a host with the rating footer.** The footer repaints by calling
`host.replaceChildren()` on every Rating_State change, and the prompt writes the
Rating_State to record the answer. `chrome.storage.onChanged` fires in the writing context
too, so mounting the prompt in `[data-wfs-footer-host]` destroyed it — on mount back when
the write was on mount, spending a lifetime ask on something nobody saw, and now mid-press
instead.

`renderSettings` provides a separate `[data-wfs-prompt-host]` directly above the footer, and
`tests/settings-dom.test.ts` asserts the two are different nodes.

**The general rule:** any node a storage subscriber repaints wholesale belongs to that
subscriber alone. It applies to the Pro surfaces too.

## The pin prompt

At most one prompt per popup opening, and the pin ask wins when both are due —
`promptPrecedence` decides. The pin prompt has a lifetime cap of 2 and the rating prompt a
cap of 1; both caps are declared in §5 beside the storage coercions that clamp the stored
counts to them, because a bound kept away from its check drifts.

There are no re-ask intervals, because there is no second ask for the rating. An interval
only means anything if a decline leaves the question open, and it no longer does — the
prompt offers a real answer either way, and one answer is the whole conversation. A schedule
for asking again is just a nicer word for nagging someone who already replied.

## The welcome page is its own surface

The tab the install event opens. It thanks the reader, asks them to pin the extension, and
lists four usage hints — no settings.

It used to be a dismissible card at the top of the options page, which meant a fresh
install landed on every preference the extension has in order to say two sentences. A first
run is not the moment to present preferences for a feature the reader has not seen work
yet.

It carries no settings on purpose. `HELP_COPY.welcome` owns the words, `renderWelcome`
(§13) owns the structure, and `public/welcome/index.html` owns the styling.

## Copy lives in one place, and has a budget

Every user-facing string is in `HELP_COPY`, defined exactly once. The HTML shells provide
empty containers only, so no wording can drift into an HTML file.

`tests/help-copy.test.ts` walks it exhaustively and enforces:

- every string non-empty and trimmed
- no term from `JARGON_LIST`
- no sentence over 20 whitespace-separated words
- no string over 140 characters
- **no site named anywhere** — invariant 2 applies to copy too; the site label is passed in

The test is property-based, so it needs no editing when copy changes, only when a rule is
broken.

## Disclosures

A native `<details>` / `<summary>` pair rather than a button carrying `aria-expanded`: the
browser already gives a `<details>` an expand control that is reachable by keyboard and
exposes its own expanded state, where a hand-rolled disclosure has to keep the attribute,
the focus order and the visibility in step by hand.

Nothing about the open state is stored, so the popup opens collapsed every time. Every line
spent at rest is a line of the popup's height budget.

## Opening a tab reports failure

`openInTab` races `chrome.tabs.create` against `REVIEW_OPEN_TIMEOUT_MS`. A refused or
silently dropped open resolves never rather than rejecting, and the user needs to be told
the link did nothing instead of watching a dead control. The timeout applies to every open:
its cost is negligible for pages that respond normally, and a consistent deadline is simpler
to reason about than a per-call flag.

Anchor navigation to `chrome://` URLs is blocked, which is why the shortcuts link goes
through this rather than being an `<a href>`.

## There is no per-channel rules card

2.0.0 carried an *Auto-Fullscreen Channels* card here: a Pro list of channel handles the
mode switched itself on for, each remembering its own mode, panel state and dock widths. It
has been removed outright, along with the `channels` field, `renderChannelRules`,
`prefillChannelRule`, and the `channel` that used to ride along on the `GET_STATUS` reply so
the popup could pre-fill the field from the open tab.

**The reason is in the page, not in the UI.** A rule could only be matched once the
below-video owner row had mounted, which is several seconds after the player, and on an
in-app navigation that row holds the *previous* video's channel for a few hundred
milliseconds after the video has already changed. Making it work at all needed an
eight-second retry window, a settle window on top of it to distrust a stale read, a give-up
diagnostic and a per-video reset of all three — and the honest outcome was still that the
mode could arrive up to two seconds into the video. The whole write-up of that race is in
`youtube-layout.md`.

If per-channel behaviour is ever wanted again, drive it from something the page states
before it renders — the URL, or a channel id in the document head — not from the owner row.

The per-site cards are three now, not four: *Viewing Modes & Playback*, *Letterbox Themes*
and *Media & Frame Capture*.

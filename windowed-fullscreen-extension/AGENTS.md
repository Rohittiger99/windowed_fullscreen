# Working in this repo

Read this before changing anything. It exists so you do not have to infer the design from
the code, and so you do not re-introduce a bug that has already been fixed once.

`README.md` is for users of the extension. This file is for whoever edits it.

**This file is kept short on purpose.** It is injected into every agent session, and it used
to be 800 lines, which meant it was silently truncated and the end of it was never read. The
depth moved into `docs/`. Keep it that way: if a section here grows past a paragraph or two,
move the body into the right `docs/` file and leave a pointer.

## What it is

A Manifest V3 Chromium extension. It adds a **windowed-fullscreen** mode to YouTube: the
player fills the browser window — the whole screen when the window is maximized — without
ever calling the browser Fullscreen API, so the tab strip, clock and taskbar stay visible.
That is the entire reason the product exists.

A second control docks everything below the video into a column beside the player. On a
livestream, chat docks into the same strip off the site's own state. Since 2.0.0 there is a
paid tier, $10 once.

**It does one thing.** Not a feature suite — Enhancer for YouTube already owns that niche.

## Where everything is

```
AGENTS.md                    This file. Invariants and the doc contract
docs/                        The depth. Read the relevant file before editing
CHANGELOG.md                 What changed per version. Update as you go
README.md                    For users of the extension
manifest.json                Extension identity. THE version source of truth
package.json                 Mirrors the manifest version; build fails on drift
src/windowed-fullscreen.ts   ALL extension code, one sectioned file
public/                      Shipped static assets (icons, page HTML shells)
scripts/build.mjs            Bundles the source once per MV3 surface
scripts/package.mjs          Zips the build for the Web Store
scripts/verify-live.mjs      Layout regression check against real YouTube
tests/                       Unit tests (node:test, zero dependencies)
extension/                   BUILD OUTPUT. Never edit; never commit
release/                     The upload zip only
store-assets/                Not shipped: listing copy, screenshots, tiles
```

There is **no server component**. The licence check talks straight to Dodo Payments' public
API from §14.

Navigate the source by section marker — `§3`, `§7` — **never by line number**. The section
index is in the file header and in `docs/architecture.md`.

## Commands

Run everything from `windowed-fullscreen-extension/`.

```bash
npm install
npm run typecheck     # tsc --noEmit. The primary gate
npm test              # unit tests, no browser or network
npm run build         # emits extension/
npm run check         # typecheck + test + build
npm run verify:live   # layout check against a real watch page. Needs Chrome
npm run package       # build + release/windowed-fullscreen-v<version>.zip
npm run store:assets  # re-render listing screenshots and promo tiles
npm run store:icons   # regenerate packaged icons
```

Load the unpacked build at `chrome://extensions` → Developer mode → Load unpacked → select
`extension/`.

**Before you hand work back: `npm run check`.**

## The invariants

Every one was learned from a bug. Breaking one is a regression even if nothing appears to
fail. Each links to where the detail lives.

**1. No top-level side effects.** The four `start*` functions are the only way anything
runs. Add a side effect and every surface's bundle inflates with code it cannot use — the
popup would start shipping content-script logic. → `docs/architecture.md`

**2. Site knowledge lives only in §3.** Every YouTube selector belongs to the `YT` object or
`YT_ACTIVE_MODE_CSS`. The controller, injector and content script work from a
`SiteDescriptor` and must never name a site element. This keeps a YouTube redesign to one
blast radius and makes a second site an additive change. It applies to copy too: no string
in `HELP_COPY` names a site. → `docs/architecture.md`

**3. `enter()` snapshots before mutating; `exit()` restores exactly.** The snapshot records
properties that were *unset*, so they can be removed again rather than left at a computed
value. Add a mutation to `enter()`, add its capture to `LayoutSnapshot` in the same commit.
→ `docs/modes-and-fullscreen.md`

**4. Windowed mode and browser fullscreen are alternatives, never layers.** Both want to own
the player's box. With both applied, YouTube measures a player it does not control and
renders its smallest control bar. Fullscreen must be **pre-empted, not reacted to**.
→ `docs/modes-and-fullscreen.md`

**5. Bounded loops only.** Detection, re-render, class re-assertion, geometry repair,
channel-rule matching, resume and the transcript open each have an attempt cap or a timeout
and emit a `DIAGNOSTIC` when they give up. Never add an unbounded retry, or an observer that
can fight the page forever.

**5a. Never observe a site subtree with `subtree: true`.** The corollary, and it was learned
the same way. `#movie_player`'s subtree mutates continuously during playback — caption cues,
the progress bar, chapter markers — so a `childList: true, subtree: true` observer there
costs a `MutationRecord` and a microtask per mutation, for the life of the page, whether or
not the mode is on. Watch the specific element whose children you care about, and its parent
if the site can replace it. → `docs/youtube-layout.md`, "Cost"

**6. One thing leaves the device, and it is the licence key.** No `chrome.storage.sync`, no
analytics, and **no network request of any kind for a reader without a licence key**. The
single exception is the key plus the provider's activation id, sent to Dodo's public API.
Widening this means editing five published documents in the same commit.
→ `docs/pro-and-licensing.md`

**7. Leaving fullscreen retraces the way in.** The page comes back to the state fullscreen
was entered from — on YouTube's own button, a double-click, `f`, `Escape` and the browser's
chrome alike. Our own buttons name their destination on top of that. An unreleased revision
sent every unrequested exit to the plain player; it was reverted and must not come back.
→ `docs/modes-and-fullscreen.md`

**8. Nothing that was free may move behind the paywall.** The comment panel, both modes, the
live-chat dock, the suggestions rail, per-site auto-apply, copy-link-at-timestamp and idle
cursor auto-hide are free and stay free. That is what makes the tier free of grandfathering
code, and there must never be any. → `docs/pro-and-licensing.md`

**9. Entitlement fails open on re-validation and never on activation.** The line is **4xx
versus everything else**. A 4xx revokes; a 5xx, a timeout or no network leaves an entitled
reader entitled. Fail-open never *grants*. → `docs/pro-and-licensing.md`

## Read before you edit

| Editing | Read first |
| --- | --- |
| `YT_ACTIVE_MODE_CSS`, dock positioning, the control bar, z-index | `docs/youtube-layout.md` |
| An observer, a listener, a timer, or anything else the page pays for repeatedly | `docs/youtube-layout.md`, "Cost" |
| The transcript, or any dock the site has to be *asked* for rather than shown | `docs/youtube-layout.md`, "Cost" and the request-vs-reveal trap |
| `scripts/build.mjs`, bundling, or bundle size | `docs/architecture.md` |
| `enter`/`exit`, the fullscreen handoff, `pageDependentControls` | `docs/modes-and-fullscreen.md` |
| Anything gated, §14, the provider constants | `docs/pro-and-licensing.md` |
| §11, §12, §13, prompts, `HELP_COPY` | `docs/settings-and-prompts.md` |
| Surfaces, the build, sections, adding a site/button/preference/dock | `docs/architecture.md` |
| Tests, or what a green suite does and does not prove | `docs/testing.md` |
| Cutting a release, or the test→live provider flip | `docs/release.md` |

## Keeping the docs true

The docs are load-bearing context for the next agent. Treat them as part of the change, not
as an afterthought.

**When you change behaviour, update the docs in the same commit.** Use this table.

| You changed | Also update |
| --- | --- |
| Any user-visible behaviour | `CHANGELOG.md` (top section), `README.md` |
| A recurring cost — an observer's scope, a listener, a timer, bundle size | `docs/youtube-layout.md` ("Cost"), and say what you measured or that you did not |
| Something only a browser can confirm | The "Outstanding" list in `docs/release.md`, with the exact thing to look at |
| A feature's free/paid status | `docs/pro-and-licensing.md`, `README.md`, `CHANGELOG.md`, `store-assets/LISTING.md`, and invariant 8 above |
| A count a document states (buttons, docks, swatches, features) | Every document stating it. These drift constantly — grep for the old number |
| A section's name or number in `src` | The header index in `src`, and `docs/architecture.md` |
| A layout trap, or its fix | `docs/youtube-layout.md` |
| A test file, or what a layer covers | `docs/testing.md` |
| What the extension sends over the network | `docs/pro-and-licensing.md`, `README.md`, `store-assets/LISTING.md`, the published listing, the store's data-disclosure answers, and the published privacy policy |
| Permissions in `manifest.json` | `README.md`, `store-assets/LISTING.md` |
| Anything visible in a screenshot | Re-run `npm run store:assets` and update the checklist in `store-assets/LISTING.md` |

**Record dead ends, not just decisions.** A comment or doc line saying "this was tried and
here is why it was abandoned" saves the next person a day. Most of `docs/` is exactly that.

**Delete prose that has stopped being true.** A stale doc is worse than no doc: the popup
stylesheet spent a release telling editors to mirror every CSS fix into a file that had been
deleted. When you remove a feature, remove its documentation in the same commit rather than
leaving it in the present tense.

## Style

Match what is there.

- Comments explain **why**, including approaches that failed. A comment restating the code
  is noise.
- Every magic number is a named constant with a comment justifying the value.
- Every class the JS applies has a named constant; a bare string in a `classList` call is a
  typo waiting to become a bug.
- Diagnostics are stable codes in the `DIAGNOSTIC` map, written to the console and nowhere
  else.
- Prefer explicit over clever. Where a selector repeats itself to win on specificity, say
  so rather than relying on file order silently.
- `!important` is required throughout the active-mode stylesheet: YouTube sizes the player
  with inline styles from its own JS.
- British/American spelling: match the surrounding paragraph.

## Not goals

Say no to these, and say why:

- **A feature suite.** This does one thing.
- **Fullscreen features.** Browser fullscreen belongs to YouTube, including its own
  comments drawer. See invariant 4.
- **Cropping or stretching video** to avoid letterboxing. `object-fit: contain` is
  deliberate.
- **Left-side docks.** Considered and dropped; not worth the work.
- **`chrome.storage.sync`, telemetry, or any network call** beyond the licence check.
- **A second permission.** `storage` plus `*://*.youtube.com/*`, and nothing else. In
  particular **no host permission for the payment provider** — it is not needed, and adding
  one would disable the extension for every existing user until they accepted the warning.

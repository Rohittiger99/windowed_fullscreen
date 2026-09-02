# Windowed Fullscreen

A Manifest V3 Chromium extension that adds a **windowed-fullscreen** mode next to YouTube's own fullscreen button. The player fills the browser window — the whole screen once the window is maximized — but the browser Fullscreen API is never called, so the tab strip, clock, and taskbar stay visible.

## Features

- A dedicated button beside YouTube's native fullscreen control.
- Toggle from the button, the toolbar popup, or `Alt+Shift+F`. `Alt+Shift+D` docks the comments. Both are rebindable at `chrome://extensions/shortcuts`, along with an unbound one for saving a frame.
- **Five controls in the player bar**: windowed mode, the comment panel, copy link at the current timestamp, the transcript dock, and frame capture.
- A **comment button** next to it docks everything from below the video — channel, subscribe, likes, description, comments — into a column beside the player, in either mode. Beside, never on top: the panel takes width from the video instead of covering it.
- **Three dock columns**, all on the right: live chat, the comment panel, and the transcript. They share the strip, and each takes width from the video rather than covering it.
- **Letterbox bars you can style** — a colour, one of six gradient themes, or ambient glow that lights them from the video's own edge colours in real time.
- **The cursor fades** after three seconds of inactivity in the mode, and comes back the moment you move.
- The masthead is not removed, only slid away: move the cursor to the top edge and the search bar, hamburger menu, and notifications slide back in. When a dock is open the revealed bar ends where the dock begins, so it never covers the dock's close button or overflow menu.
- Controls whose result lives outside the player hand the page back rather than doing nothing. Clicking the chapter title in the control bar leaves the mode and opens YouTube's Chapters panel on the ordinary page, because that panel renders in a column the mode hides.
- `Escape` dismisses one layer at a time — browser fullscreen first if it is up, then the side panel, then the mode, restoring the page to its exact previous state.
- Never fights YouTube's own fullscreen: entering it stands the mode down completely, and leaving it puts back whatever was on screen before. Go in from windowed mode with the comments docked and that is what you come back to, however you leave — YouTube's button, a double-click, `f`, `Escape`. Go in from the plain player and the plain player is what you get back.
- A welcome page on install, and a rating row plus a permanent feedback link in the settings. The one-time prompt asks "Enjoying it?" and offers both answers side by side — rate it, or say what is wrong. Never twice, and never a question you have to answer correctly before the review link appears.
- Optional per-site **scrollable mode**: the video still fills the screen on entry, but the page keeps scrolling, so the description and comments are one scroll away instead of requiring you to leave the mode. Scroll back up and the video fills the screen again.
- Optional per-site auto-apply: enter the mode automatically when a video loads.
- Survives YouTube's in-app navigations without a reload.

### Free and Pro

Everything in the free tier is permanently free. The comment panel, both modes, the live-chat dock, the suggestions rail, and per-site auto-apply all shipped before there was a paid tier — so **nothing that was free has moved behind the paywall**, and nothing ever will. Every paid feature is new work.

| | Free | Pro — $10 once (Lifetime) |
| --- | --- | --- |
| Windowed mode, both cover and scrollable | Yes | — |
| Docking the comment panel | Yes | — |
| Docking live chat on livestreams | Yes | — |
| Suggestions rail in scrollable mode | Yes | — |
| Masthead reveal, `Escape` layering, fullscreen handoff | Yes | — |
| Auto-apply for a whole site | Yes | — |
| Copy video link with current timestamp | Yes | — |
| Shortcuts for windowed and comment buttons | Yes | — |
| **Dragging any docked column as wide as you like** | No | Yes |
| **Docking interactive video transcripts & 1-click timestamped copy** | No | Yes |
| **Saving the current frame at source video resolution** | No | Yes |
| **Custom filename templates ({title}, {channel}, {date}, etc.)** | No | Yes |
| **Burn timestamp overlay watermark** | No | Yes |
| **Ambient glow letterbox illumination** | No | Yes |
| **Custom letterbox palettes & gradient themes** | No | Yes |
| Idle cursor auto-hide | Yes | — |

One purchase, no renewal, no account, and no login: a licence key is the only credential, and it comes with a 7-day money-back guarantee. Enter it under **Already bought Pro?** — either in the popup's Pro view, or in the prompt that appears in the page when you press a Pro control, so activating a key you bought on another machine does not mean leaving the video. It is a once-per-device job, so it is folded away rather than sitting open under the price. It covers a limited number of devices — **Remove key** hands that device's slot back so you can use it somewhere else. The key is re-checked roughly once a fortnight, and **the check fails open**: if it cannot complete, nothing changes and you keep every feature.

**Dragging a dock** puts a grip on each dock's inboard edge. Drag it, or focus it and use the arrow keys (`Shift` for a bigger step). Comments, live chat, and transcripts all resize independently.

**Saving a frame** writes an uncompressed PNG at the video's own resolution, named with your custom filename template or copied to clipboard.

**Ambient glow & letterbox themes** softly illuminate letterbox bars with real-time video color sampling, or select from 5 cinema swatches and 6 gradient mix themes, or a colour picker with hex input.

### The two modes

Both are the same feature — a CSS-expanded player, no Fullscreen API — differing only in how the player relates to the page. The per-site **Scrollable mode** checkbox in the popup picks between them, and switching it applies to the video already on screen.

| | Cover (default) | Scrollable |
| --- | --- | --- |
| Player | Fixed to the viewport | Viewport-sized block at the top of the page |
| Page scrolling | Locked | Normal |
| Below the player | Nothing reachable | Title, description, comments |
| Related videos rail | Hidden | Shown beside comments (two-column layout) |
| Comment button | Docks the panel beside the video | Docks the panel beside the video |

### The side panel

The comment button is session state, not a preference: entering the mode always starts with the video alone, and exiting closes the panel. Pressing it from a watch page that is not in the mode yet enters the mode and docks the panel in one press.

The panel is YouTube's own `#below` element, positioned rather than moved, so Polymer keeps owning it — the like button, subscribe, comment sorting, and lazy-loaded comment continuations all keep working, and closing the panel undoes a single class.

On a livestream, **chat docks beside the player** the same way — taking width from the video, never covering it. It follows YouTube's own chat toggle: open the panel and it docks, collapse it and the dock unwinds. The comment panel can stay docked alongside it, with chat on the outside. A close button on the docked comment panel matches the one the site puts on its own chat panel.

Two edges of the layout are worth knowing, because both were bugs first:

- The panel is a **border-box** width. `#below` is `content-box` on YouTube, so without that the padding is added to the width and the panel overhangs the video, covering the right end of the control bar.
- Cover mode sizes the player from its `left`/`right` insets, never `calc(100vw - …)`. `100vw` includes the vertical scrollbar and the panel is positioned against the viewport's inner edge, which excludes it — so on any page with a scrollbar the two disagreed by exactly its width.

### Windowed mode and browser fullscreen are alternatives, never layers

Exactly one is ever active. Both want to own the player's box — the mode pins it with fixed positioning, a maximum z-index, a locked page scroll, and hidden site chrome, while fullscreen expects the site's own layout to be intact so it can measure and rebuild it. Left both on, they fight: the site measures a player it does not control, picks its smallest control bar, and the player comes out mangled.

So a fullscreen request stands the mode fully down through the ordinary exit path, which restores the page byte for byte.

**Leaving fullscreen retraces the way in.** The stand-down records what was on screen — whether the mode was up, and whether the panel was docked — and the exit hands that state back. Pressing YouTube's fullscreen button twice leaves you exactly where you started, because fullscreen was entered *from* somewhere and leaving it undoes that one step rather than the mode you switched on before it.

An exit is still only *attributed* to this extension when the extension asked for it — the intent is written immediately before `exitFullscreen()` is called, because `fullscreenchange` can arrive synchronously from inside that call. That attribution decides one thing now: the comment button docks the panel on the way out whether or not it was open beforehand, because the press itself is the request.

**The stand-down happens before the request, not after.** Reacting to `fullscreenchange` is too late: by then the browser is already fullscreen and YouTube has begun measuring its new layout against a player this extension still has pinned. It caches that size and renders its smallest control bar — a squashed scrubber and buttons crammed into the corner. So the mode stands down in the capture phase of the event that triggers the request — YouTube's fullscreen button, a double-click on the player, or the `f` shortcut — and YouTube only ever measures its own untouched layout. `fullscreenchange` remains as the backstop for any path not on that list, and a 900ms grace timer puts the mode back if fullscreen never actually arrives.

Each button always does its own job:

| Press | Result |
| --- | --- |
| Fullscreen button, in windowed mode | Plain YouTube fullscreen, nothing of ours applied |
| Windowed button, in fullscreen | Leaves fullscreen, arrives in windowed mode |
| Comment button, in fullscreen | Leaves fullscreen, docks the panel |
| Any other exit from fullscreen — YouTube's button, double-click, `f`, `Escape` | Whatever was on screen when fullscreen began |

`Escape` takes one press per layer and gives back exactly one, so a docked windowed session in fullscreen is three presses from a bare page: out of fullscreen (the browser's own handling, landing back in windowed mode), out of the panel, out of the mode.

The side panel is a windowed-mode feature for the same reason. Fullscreen sets `display: none` on the two-column container the panel lives inside, so it cannot render there — and YouTube already offers its own fullscreen comments drawer.

One consequence worth knowing: YouTube strips `ytp-big-mode` off the player whenever it recomputes its own layout — every fullscreen transition, and any time it decides the player is not fullscreen-sized, which a narrowed player is not. That silently drops the control bar from 72px to 59px and the buttons from 48px to 40px, so the controller re-applies the classes it added, bounded at 50 re-applications per session.

## Layout

```
AGENTS.md                    How to work in this repo (read before editing)
docs/                        Deep reference, split by topic
CHANGELOG.md                 What changed per version
manifest.json                Extension identity and entry points. Owns the version
src/windowed-fullscreen.ts   ALL extension code, in one sectioned file
public/                      Static shipped assets (icons; popup and welcome
                             HTML shells)
scripts/build.mjs            Bundles the source once per MV3 surface
scripts/package.mjs          Zips the build for the Web Store
scripts/verify-live.mjs      Layout regression check against real YouTube
tests/                       Unit tests (node:test, zero dependencies)
extension/                   Build output: the loadable unpacked extension
release/                     Exactly one file: the zip to upload
store-assets/                Not shipped — listing copy, screenshots, promo tiles
```

## Architecture

**Editing this?** Read [`AGENTS.md`](AGENTS.md) first. It carries the invariants, a
table telling you which [`docs/`](docs/) file to read for the area you are touching,
and the rule about keeping documentation true. This section is the short version.

All the code lives in `src/windowed-fullscreen.ts`, split into numbered sections. `scripts/build.mjs` bundles that file once per surface, synthesizing a one-line entry point for each (`startContentScript`, `startServiceWorker`, `startPopup`, `startWelcomePage`) and letting esbuild tree-shake away whatever that surface does not reach. The file has no top-level side effects, which is what makes the tree-shaking safe.

The settings live in the toolbar popup, and `options_ui` points at it, so the browser's own Options item lands there too. There is no separate options page.

The rule worth preserving: **site-specific DOM knowledge lives only in a site adapter** (§3). The controller and injector work from a `SiteDescriptor` and never reference a site selector, so supporting another video site means adding one adapter to the `ADAPTERS` array and changing nothing else.

## Commands

```bash
npm install
npm run build         # emits extension/ — load this via Load unpacked
npm run build:watch   # rebuild on change, with source maps and no minification
npm run typecheck     # tsc --noEmit, the primary gate
npm test              # unit tests, no browser or network needed
npm run check         # typecheck + test + build, run this before shipping
npm run verify:live   # layout check against a real watch page (needs Chrome)
npm run package       # build + write release/windowed-fullscreen-v<version>.zip
```

Tests run on `node --test` with no test framework installed: Node 22.18+ executes
the TypeScript files directly. `npm run verify:live` is separate because layout
only exists inside a real YouTube page — it injects the real content script into
an open watch page over the DevTools protocol, clicks the real buttons, and
asserts that the panel does not overlap the player, the control bar keeps its
size, and every way out of fullscreen lands where it should. Instructions are in
the header of `scripts/verify-live.mjs`.

Every build except `build:watch` is minified. The content script is injected into
every YouTube page and the browser parses all of it before any of it runs, so the
comments that make the source readable are worth stripping from what ships —
150 kB rather than 244 kB. Watch builds stay readable in DevTools.

`manifest.json` is the single source of truth for the version; `npm run build`
fails if `package.json` has drifted from it.

Load the unpacked build at `chrome://extensions` → **Developer mode** → **Load unpacked** → select `extension/`.

`npm run store:assets` re-renders the listing screenshots and promo tiles; `npm run store:icons` regenerates the packaged icons in `public/icons/`.

## Packaging

`npm run package` writes an upload-ready zip to `release/`, which deliberately holds nothing else. Upload that file as-is.

It refuses to run if a zip for the current version is already sitting in `release/`, because the store will not accept the same version twice and the script wipes the directory before writing — so packaging over it would produce a rejected upload and destroy the evidence of what was there. Bump the version in `manifest.json` (and `package.json` to match), or pass `--force` to re-package a version that was built but never uploaded.

Do **not** zip the build by hand with Windows tooling. `Compress-Archive` and .NET's `ZipFile.CreateFromDirectory` write backslash path separators, but the ZIP spec requires forward slashes — Chrome then reads `content\index.js` as one top-level filename instead of a nested path, so the content script silently goes missing. `scripts/package.mjs` normalizes the entry names and puts `manifest.json` at the archive root.

## Permissions

- `storage` — the per-site settings (auto-apply, scrollable mode, the three dock widths, the letterbox colour and ambient glow, the cursor auto-hide switch, and the capture options), your licence key if you have one, and the local-only bookkeeping behind the rating row and the prompts: a star count, how many times each prompt has been shown, a usage counter, and the install timestamp. All written to `chrome.storage.local` only. `chrome.storage.sync` is deliberately unused, so settings never leave the device, and the star count is never transmitted anywhere — selecting a star opens the store's own review page and nothing else.
- `*://*.youtube.com/*` — to inject the buttons, apply the CSS that expands the player and docks the side panel beside it, and read the active tab's URL so the popup can report whether the page is supported.

No other permissions, no runtime dependencies, no remote code, and no analytics or telemetry.

### The one network request

Since 2.0.0 there is exactly one, and only if you have entered a licence key: the key is sent to **Dodo Payments**, the payment provider that issued it, to confirm it is valid. It happens when you enter the key and roughly once a fortnight afterwards. Up to 1.3.0 there were none at all.

What that request carries is the licence key and an id for this device's activation. Nothing else — no account, no identifier of ours, no page you were on, no video, no browsing history, no settings. There is no server on our side at all: the extension talks to the provider directly, so there is nowhere for us to keep anything even if we wanted to.

The activation id is issued by the provider when you enter your key, and exists so one purchase can cover a limited number of devices. It is not a fingerprint: it carries nothing about your machine, and the name this install registers under is a fixed string identical on every install, deliberately.

Saving a frame is entirely local: the image is drawn from the video already playing in your browser and written straight to your downloads or your clipboard. It is never uploaded anywhere.

Without a licence key the extension makes no network requests at all.

**Why there is no server of ours.** Dodo's licence endpoints are public — no API key — and they send CORS headers, which was worth measuring rather than assuming: a preflight from a `chrome-extension://` origin comes back 200 with the origin reflected. So the extension can call them directly and needs no host permission, which means this update carries no new permission warning. An earlier draft proxied the check through a small service of ours; once the endpoints turned out to be public it had exactly one benefit left — being able to change payment provider without shipping a release — and that is not worth a service to run. The cost of dropping it is stated plainly: these URLs are baked into every install, so leaving Dodo would mean a release, and installs that never update would keep calling Dodo.

Store listing copy and Developer Dashboard answers: `store-assets/LISTING.md`.

## Copyright

Copyright (c) 2026 Rohit Tiger. All rights reserved. No licence file is included on purpose: no licence means no rights are granted, and copyright stays reserved in full. This is not open-source software. Use of the published extension is governed by the [Terms of Use](https://rohittiger.vercel.app/legal/terms).

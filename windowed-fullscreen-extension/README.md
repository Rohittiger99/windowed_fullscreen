# Windowed Fullscreen

A Manifest V3 Chromium extension that adds a **windowed-fullscreen** mode next to YouTube's own fullscreen button. The player fills the browser window — the whole screen once the window is maximized — but the browser Fullscreen API is never called, so the tab strip, clock, and taskbar stay visible.

## Features

- A dedicated button beside YouTube's native fullscreen control.
- Toggle from the button, the toolbar popup, or `Alt+Shift+F` (rebindable at `chrome://extensions/shortcuts`).
- A **comment button** next to it docks everything from below the video — channel, subscribe, likes, description, comments — into a column beside the player, in either mode. Beside, never on top: the panel takes width from the video instead of covering it.
- The masthead is not removed, only slid away: move the cursor to the top edge and the search bar, hamburger menu, and notifications slide back in.
- Controls whose result lives outside the player hand the page back rather than doing nothing. Clicking the chapter title in the control bar leaves the mode and opens YouTube's Chapters panel on the ordinary page, because that panel renders in a column the mode hides.
- `Escape` dismisses one layer at a time — browser fullscreen first if it is up, then the side panel, then the mode, restoring the page to its exact previous state.
- Never fights YouTube's own fullscreen: entering it stands the mode down completely, and leaving it puts back whatever was on screen before. Go in from windowed mode with the comments docked and that is what you come back to, however you leave — YouTube's button, a double-click, `f`, `Escape`. Go in from the plain player and the plain player is what you get back.
- A welcome page on install, and a rating row plus a permanent feedback link in the settings. The one-time prompt asks "Enjoying it?" and offers both answers side by side — rate it, or say what is wrong. Never twice, and never a question you have to answer correctly before the review link appears.
- Optional per-site **scrollable mode**: the video still fills the screen on entry, but the page keeps scrolling, so the description and comments are one scroll away instead of requiring you to leave the mode. Scroll back up and the video fills the screen again.
- Optional per-site auto-apply: enter the mode automatically when a video loads.
- Survives YouTube's in-app navigations without a reload.

### The two modes

Both are the same feature — a CSS-expanded player, no Fullscreen API — differing only in how the player relates to the page. The per-site **Scrollable mode** checkbox in the popup or the options page picks between them, and switching it applies to the video already on screen.

| | Cover (default) | Scrollable |
| --- | --- | --- |
| Player | Fixed to the viewport | Viewport-sized block at the top of the page |
| Page scrolling | Locked | Normal |
| Below the player | Nothing reachable | Title, description, comments |
| Related videos rail | Hidden | Hidden (the player owns the full width) |
| Comment button | Docks the panel beside the video | Docks the panel beside the video |

### The side panel

The comment button is session state, not a preference: entering the mode always starts with the video alone, and exiting closes the panel. Pressing it from a watch page that is not in the mode yet enters the mode and docks the panel in one press.

The panel is YouTube's own `#below` element, positioned rather than moved, so Polymer keeps owning it — the like button, subscribe, comment sorting, and lazy-loaded comment continuations all keep working, and closing the panel undoes a single class. Live-stream chat is not included: `#chat` lives in a different container, and hosting both would mean re-parenting site DOM.

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
CHANGELOG.md                 What changed per version
manifest.json                Extension identity and entry points. Owns the version
src/windowed-fullscreen.ts   ALL extension code, in one sectioned file
public/                      Static shipped assets (icons; popup, options and
                             welcome HTML shells)
scripts/build.mjs            Bundles the source once per MV3 surface
scripts/package.mjs          Zips the build for the Web Store
scripts/verify-live.mjs      Layout regression check against real YouTube
tests/                       Unit tests (node:test, zero dependencies)
extension/                   Build output: the loadable unpacked extension
release/                     Exactly one file: the zip to upload
store-assets/                Not shipped — listing copy, screenshots, promo tiles
```

## Architecture

**Editing this?** Read [`AGENTS.md`](AGENTS.md) first. It carries the invariants,
the traps that have already caused bugs, and how to make the common changes. This
section is the short version.

All the code lives in `src/windowed-fullscreen.ts`, split into numbered sections. `scripts/build.mjs` bundles that file once per surface, synthesizing a one-line entry point for each (`startContentScript`, `startServiceWorker`, `startOptionsPage`, `startPopup`, `startWelcomePage`) and letting esbuild tree-shake away whatever that surface does not reach. The file has no top-level side effects, which is what makes the tree-shaking safe.

The rule worth preserving: **site-specific DOM knowledge lives only in a site adapter** (§3). The controller and injector work from a `SiteDescriptor` and never reference a site selector, so supporting another video site means adding one adapter to the `ADAPTERS` array and changing nothing else.

## Commands

```bash
npm install
npm run build         # emits extension/ — load this via Load unpacked
npm run build:watch   # rebuild on change, with source maps
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

`manifest.json` is the single source of truth for the version; `npm run build`
fails if `package.json` has drifted from it.

Load the unpacked build at `chrome://extensions` → **Developer mode** → **Load unpacked** → select `extension/`.

`npm run store:assets` re-renders the listing screenshots and promo tiles; `npm run store:icons` regenerates the packaged icons in `public/icons/`.

## Packaging

`npm run package` writes an upload-ready zip to `release/`, which deliberately holds nothing else. Upload that file as-is.

It refuses to run if a zip for the current version is already sitting in `release/`, because the store will not accept the same version twice and the script wipes the directory before writing — so packaging over it would produce a rejected upload and destroy the evidence of what was there. Bump the version in `manifest.json` (and `package.json` to match), or pass `--force` to re-package a version that was built but never uploaded.

Do **not** zip the build by hand with Windows tooling. `Compress-Archive` and .NET's `ZipFile.CreateFromDirectory` write backslash path separators, but the ZIP spec requires forward slashes — Chrome then reads `content\index.js` as one top-level filename instead of a nested path, so the content script silently goes missing. `scripts/package.mjs` normalizes the entry names and puts `manifest.json` at the archive root.

## Permissions

- `storage` — two booleans per site (auto-apply and scrollable mode), plus the local-only bookkeeping behind the rating row and the prompts: a star count, how many times each prompt has been shown, a usage counter, and the install timestamp. All written to `chrome.storage.local` only. `chrome.storage.sync` is deliberately unused, so settings never leave the device, and the star count is never transmitted anywhere — selecting a star opens the store's own review page and nothing else.
- `*://*.youtube.com/*` — to inject the buttons, apply the CSS that expands the player and docks the side panel beside it, and read the active tab's URL so the popup can report whether the page is supported.

No other permissions. No runtime dependencies, no network requests, no remote code, no analytics or telemetry.

Store listing copy and Developer Dashboard answers: `store-assets/LISTING.md`.

## Copyright

Copyright (c) 2026 Rohit Tiger. All rights reserved. No licence file is included on purpose: no licence means no rights are granted, and copyright stays reserved in full. This is not open-source software. Use of the published extension is governed by the [Terms of Use](https://rohittiger.vercel.app/legal/terms).

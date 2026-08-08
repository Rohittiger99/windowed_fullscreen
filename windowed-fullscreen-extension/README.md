# Windowed Fullscreen

A Manifest V3 Chromium extension that adds a **windowed-fullscreen** mode next to YouTube's own fullscreen button. The player fills the browser window — the whole screen once the window is maximized — but the browser Fullscreen API is never called, so the tab strip, clock, and taskbar stay visible.

## Features

- A dedicated button beside YouTube's native fullscreen control.
- Toggle from the button, the toolbar popup, or `Alt+Shift+F` (rebindable at `chrome://extensions/shortcuts`).
- `Escape` exits and restores the page to its exact previous state.
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

## Layout

```
manifest.json                Extension identity and entry points
src/windowed-fullscreen.ts   ALL extension code, in one sectioned file
public/                      Static shipped assets (icons, popup + options HTML)
scripts/build.mjs            Bundles the source once per MV3 surface
scripts/package.mjs          Zips the build for the Web Store
extension/                   Build output: the loadable unpacked extension
release/                     Exactly one file: the zip to upload
store-assets/                Not shipped — listing copy, screenshots, promo tiles
```

## Architecture

All the code lives in `src/windowed-fullscreen.ts`, split into numbered sections. `scripts/build.mjs` bundles that file four times, synthesizing a one-line entry point per surface (`startContentScript`, `startServiceWorker`, `startOptionsPage`, `startPopup`) and letting esbuild tree-shake away whatever that surface does not reach. The file has no top-level side effects, which is what makes the tree-shaking safe.

The rule worth preserving: **site-specific DOM knowledge lives only in a site adapter** (§3). The controller and injector work from a `SiteDescriptor` and never reference a site selector, so supporting another video site means adding one adapter to the `ADAPTERS` array and changing nothing else.

## Commands

```bash
npm install
npm run build         # emits extension/ — load this via Load unpacked
npm run build:watch   # rebuild on change, with source maps
npm run typecheck
npm run package       # build + write release/windowed-fullscreen-v<version>.zip
```

Load the unpacked build at `chrome://extensions` → **Developer mode** → **Load unpacked** → select `extension/`.

`npm run store:assets` re-renders the listing screenshots and promo tiles; `npm run store:icons` regenerates the packaged icons in `public/icons/`.

## Packaging

`npm run package` writes an upload-ready zip to `release/`, which deliberately holds nothing else. Upload that file as-is.

Do **not** zip the build by hand with Windows tooling. `Compress-Archive` and .NET's `ZipFile.CreateFromDirectory` write backslash path separators, but the ZIP spec requires forward slashes — Chrome then reads `content\index.js` as one top-level filename instead of a nested path, so the content script silently goes missing. `scripts/package.mjs` normalizes the entry names and puts `manifest.json` at the archive root.

## Permissions

- `storage` — one boolean per site (auto-apply), written to `chrome.storage.local` only. `chrome.storage.sync` is deliberately unused, so settings never leave the device.
- `*://*.youtube.com/*` — to inject the button, apply the CSS that expands the player, and read the active tab's URL so the popup can report whether the page is supported.

No other permissions. No runtime dependencies, no network requests, no remote code, no analytics or telemetry.

Store listing copy and Developer Dashboard answers: `store-assets/LISTING.md`.

## Copyright

Copyright (c) 2026 Rohit Tiger. All rights reserved. No licence file is included on purpose: no licence means no rights are granted, and copyright stays reserved in full. This is not open-source software. Use of the published extension is governed by the [Terms of Use](https://rohittiger.vercel.app/legal/terms).

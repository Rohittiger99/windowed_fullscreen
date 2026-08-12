# Product

**Windowed Fullscreen** — a Manifest V3 Chromium extension that adds a windowed-fullscreen viewing mode to YouTube.

The player fills the browser window (the whole screen when the window is maximized) **without ever calling the browser Fullscreen API**, so the tab strip, clock, and taskbar stay visible. That is the entire reason the product exists.

## What it ships

- A button beside YouTube's native fullscreen control. Also togglable from the toolbar popup or `Alt+Shift+F`.
- A comment button that docks everything below the video (channel, subscribe, likes, description, comments) into a column **beside** the player, taking width from the video rather than covering it.
- The masthead slides away rather than being removed; moving the cursor to the top edge slides it back.
- `Escape` dismisses one layer at a time and gives back exactly one: browser fullscreen → side panel → mode.
- **Leaving fullscreen retraces the way in.** The stand-down records whether the mode was up and whether the panel was docked, and the exit hands that state back — on YouTube's own button, a double-click, `f`, `Escape`, and the browser's chrome alike. Entered from the plain player, the plain player is what comes back. The extension's own buttons name their destination on top of that: the comment button docks the panel whether or not it was open before. An unreleased revision sent every unrequested exit to the plain player; it was reverted and must not come back.
- Two per-site modes: **cover** (player fixed to viewport, page scroll locked) and **scrollable** (viewport-sized block at the top of normal flow, page keeps scrolling).
- Optional per-site auto-apply on video load.
- Survives YouTube's in-app navigations without a reload.

## Hard product rules

- **Nothing leaves the device.** No network requests, no `chrome.storage.sync` (sync would replicate settings through the user's browser account), no analytics or telemetry. The privacy policy promises this.
- **Windowed mode and browser fullscreen are alternatives, never layers.** Browser fullscreen belongs to YouTube, including its own comments drawer.
- **It does one thing.** Not a feature suite; Enhancer for YouTube already owns that niche.
- **No cropping or stretching video** to avoid letterboxing. Letterboxing in a maximized window is correct and deliberate (`object-fit: contain`).
- Permissions are `storage` plus `*://*.youtube.com/*`. Do not add more without a product-level reason.

## Ownership

Copyright (c) 2026 Rohit Tiger. All rights reserved. Not open source; no licence file on purpose.

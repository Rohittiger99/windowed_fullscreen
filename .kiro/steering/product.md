# Product

**Windowed Fullscreen for YouTube™** — a Manifest V3 Chromium extension.

The player fills the browser window (the whole screen when the window is maximized)
**without ever calling the browser Fullscreen API**, so the tab strip, clock and taskbar
stay visible. That is the entire reason the product exists.

Published: 1.3.0. In preparation: **2.0.0**.

## What it ships

- A button beside YouTube's native fullscreen control. Also togglable from the toolbar
  popup or `Alt+Shift+F`.
- Five injected player-bar controls in all: capture, copy-link-at-timestamp, transcript,
  windowed mode, comment panel.
- Three dock columns beside the player, all on the right: live chat, the comment panel
  (channel, subscribe, likes, description, comments), and the transcript. They take width
  from the video rather than covering it.
- Two per-site modes: **cover** (player fixed to viewport, page scroll locked) and
  **scrollable** (viewport-sized block at the top of normal flow, page keeps scrolling).
- The masthead slides away rather than being removed; moving the cursor to the top edge
  slides it back.
- `Escape` dismisses one layer at a time: browser fullscreen → side panel → mode.
- Leaving fullscreen retraces the way in.
- Optional per-site auto-apply.
- Letterbox bar colours, gradient themes and ambient glow.
- Survives YouTube's in-app navigations without a reload.
- Shortcuts: `Alt+Shift+F` toggles the mode, `Alt+Shift+D` docks the comments, and the
  capture command ships **unbound** on purpose.

## Pro tier

**$10 once.** No subscription, no account, no login. A licence key is the only credential.
Every paid feature is new work introduced with the tier. The count and the list live in
`windowed-fullscreen-extension/docs/pro-and-licensing.md` — this file deliberately does not
restate either, because a count stated in two places is a count that drifts.

**Governing rule: nothing that was free has moved behind the paywall, and nothing ever
will.** That is what makes the tier free of grandfathering code, and there must never be
any.

Free and staying free: the comment panel, both modes, the live-chat dock, the suggestions
rail, per-site auto-apply, copy-link-at-timestamp, and idle cursor auto-hide.

The authoritative free/paid list, the gating rules and the entitlement behaviour live in
`windowed-fullscreen-extension/docs/pro-and-licensing.md`. **Do not restate the list
here** — that is how it drifts. This file was carrying "$5" and "exactly three things are
gated" for an entire release cycle after both stopped being true.

## Hard product rules

- **One thing leaves the device, and it is the licence key.** No `chrome.storage.sync`, no
  analytics, no telemetry, and no network request of any kind for a reader without a key.
  The single exception is that key plus the provider's activation id, sent to Dodo
  Payments' own public API. **There is no server on our side at all.** Changing this means
  editing `README.md`, `store-assets/LISTING.md`, the published store listing, the store's
  data-disclosure answers and the published privacy policy in the same commit.
- **No server, and no proxy.** The provider's endpoints are public and CORS-enabled,
  measured rather than assumed.
- **Windowed mode and browser fullscreen are alternatives, never layers.** Browser
  fullscreen belongs to YouTube, including its own comments drawer.
- **It does one thing.** Not a feature suite; Enhancer for YouTube already owns that
  niche. The Pro tier does not change this — every paid feature is about the viewing mode
  itself, not new territory.
- **No cropping or stretching video** to avoid letterboxing. Letterboxing in a maximized
  window is correct and deliberate (`object-fit: contain`). Painting the bars is fine;
  removing them is not.
- **Permissions are `storage` plus `*://*.youtube.com/*`.** Do not add more without a
  product-level reason, and **do not add a host permission for the payment provider** — it
  is not needed, and adding one would disable the extension for every existing user until
  they accepted the new warning.

## Ownership

Copyright (c) 2026 Rohit Tiger. All rights reserved. Not open source; no licence file on
purpose.

# Product

**Windowed Fullscreen** — a Manifest V3 Chromium extension that adds a windowed-fullscreen viewing mode to YouTube.

The player fills the browser window (the whole screen when the window is maximized) **without ever calling the browser Fullscreen API**, so the tab strip, clock, and taskbar stay visible. That is the entire reason the product exists.

## What it ships

- A button beside YouTube's native fullscreen control. Also togglable from the toolbar popup or `Alt+Shift+F`. `Alt+Shift+D` docks the comments; the capture command ships unbound.
- A comment button that docks everything below the video (channel, subscribe, likes, description, comments) into a column **beside** the player, taking width from the video rather than covering it.
- The masthead slides away rather than being removed; moving the cursor to the top edge slides it back.
- `Escape` dismisses one layer at a time and gives back exactly one: browser fullscreen → side panel → mode.
- **Leaving fullscreen retraces the way in.** The stand-down records whether the mode was up and whether the panel was docked, and the exit hands that state back — on YouTube's own button, a double-click, `f`, `Escape`, and the browser's chrome alike. Entered from the plain player, the plain player is what comes back. The extension's own buttons name their destination on top of that: the comment button docks the panel whether or not it was open before. An unreleased revision sent every unrequested exit to the plain player; it was reverted and must not come back.
- Two per-site modes: **cover** (player fixed to viewport, page scroll locked) and **scrollable** (viewport-sized block at the top of normal flow, page keeps scrolling).
- Optional per-site auto-apply on video load.
- Survives YouTube's in-app navigations without a reload.
- Since 1.4.0, three paid additions: draggable dock widths, per-channel auto-apply, and frame capture. See the Pro tier section below.

## Pro tier (1.4.0)

$5 one time, no subscription, no account, no login. A licence key is the only credential.

**Governing rule: nothing that was free has moved behind the paywall, and nothing ever will.** The comment panel, both modes, the live-chat dock, the suggestions rail, and per-site auto-apply all shipped in 1.2.0. Every Pro feature is new work, which is why there is no grandfathering code and must never need to be any.

Exactly three things are gated:

1. Dragging either dock wider or narrower.
2. Per-channel auto-apply rules.
3. Saving the current frame as an image, and the shortcut bound to it.

Two things are deliberately **not** gated. **Live chat docking is free** — it has no control of its own by design, so there is nowhere to attach an upsell without inventing a button purely to lock it, and it is the strongest livestream hook for growth. **Keyboard shortcuts are not a paid category**: the windowed and comment shortcuts are free, and the capture shortcut is Pro only because you cannot bind a shortcut to a feature you do not own.

The capture button is **shown to free users** and opens a prompt naming the price. It is the only paid feature a set-and-forget reader meets without going looking, so it is the whole funnel. Every other paid surface — the drag grips, the rules list — is absent without a licence, because it is reachable only by someone already exploring.

Entitlement lives in §14. It **fails open**: any network or endpoint failure leaves an entitled reader entitled. It never fails open into an entitlement — an install with no definite answer is not Pro.

## Hard product rules

- **Almost nothing leaves the device, and exactly one thing does.** No `chrome.storage.sync` (sync would replicate settings through the user's browser account), no analytics, no telemetry, and no network request of any kind for a reader without a licence key. The single exception, added in 1.4.0: a reader who has entered a key has that key, plus the provider's activation id for this device, sent to **Dodo Payments' own public licence API** — when they enter it, roughly once every 14 days after, and once more if they remove it. No account, no identifier of ours, no page, no video, no history, and no device fingerprint: the activation registers under a fixed string identical on every install. **There is no server on our side at all.** Saving a frame is entirely local. Any change to this paragraph has to land in `README.md`, `store-assets/LISTING.md`, the published store listing, the store's data-disclosure answers, and the published privacy policy in the same commit.

- **No server, and no proxy.** Dodo's activate, validate and deactivate endpoints are public and send CORS headers — measured against the live host, not assumed. So the extension calls them directly, needs no host permission, and an update carries no new permission warning. An earlier draft of 1.4.0 proxied them through a Vercel project of ours on the mistaken premise that they needed an API key; once that was checked, the proxy's only remaining benefit was changing provider without a release, which is not worth a service to run. The accepted cost: these URLs are in every shipped install, so leaving Dodo means a release.
- **Windowed mode and browser fullscreen are alternatives, never layers.** Browser fullscreen belongs to YouTube, including its own comments drawer.
- **It does one thing.** Not a feature suite; Enhancer for YouTube already owns that niche. The Pro tier does not change this: all three paid features are about the viewing mode itself, not new territory.
- **No cropping or stretching video** to avoid letterboxing. Letterboxing in a maximized window is correct and deliberate (`object-fit: contain`).
- Permissions are `storage` plus `*://*.youtube.com/*`. Do not add more without a product-level reason, and **do not add a host permission for the provider** — it is not needed, and adding one would disable the extension for every existing user until they accepted the new warning.

## Ownership

Copyright (c) 2026 Rohit Tiger. All rights reserved. Not open source; no licence file on purpose.

# Windowed Fullscreen

A Manifest V3 Chromium extension that adds a **windowed-fullscreen** viewing mode next to a video site's native fullscreen control. The video fills your entire browser window (and screen) while your taskbar stays visible — so you can keep an eye on the clock, notifications, and other windows without leaving "fullscreen".

Version 1 supports **YouTube**.

## Features

- Adds a dedicated windowed-fullscreen button right next to YouTube's native fullscreen control.
- Expands the player to fill the viewport without calling the browser Fullscreen API, so the taskbar stays visible.
- Toggle via the button, the toolbar popup, or a keyboard shortcut (`Alt+Shift+F` by default).
- Press `Escape` to exit.
- Optional per-site **auto-apply**: enter windowed fullscreen automatically when a video loads.
- Survives YouTube's single-page navigations (moving between videos) without a reload.
- Restores the page to its exact previous state on exit.

## Architecture

The code is deliberately split so the mode logic never knows about any specific site:

- **Generic core** (`src/core`) — a site-independent engine that expands the player and hides page chrome using only a `SiteDescriptor` handed to it. It never references site-specific selectors and never calls the Fullscreen API.
- **Site adapters** (`src/adapters`) — the one place that holds site-specific DOM knowledge. `youtube.ts` is the only adapter in v1; supporting another site means adding one adapter file.
- **Content script** (`src/content`) — injects and maintains the button, and wires everything together per tab.
- **Background service worker** (`src/background`) — handles the keyboard command and cross-surface messaging.
- **Options & popup** (`src/options`, `src/popup`) — the settings and toolbar UIs.
- **Preferences** (`src/preferences`) — reads/writes settings via `chrome.storage` with sensible defaults.

## Getting started

Install dependencies:

```bash
npm install
```

### Build

```bash
npm run build
```

This bundles the extension into the `dist/` folder. Load it in Chrome via `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `dist/` folder.

For an auto-rebuilding dev build (with source maps):

```bash
npm run build:watch
```

### Type-check and test

```bash
npm run typecheck   # TypeScript, no emit
npm test            # Vitest (unit + property-based tests)
```

## Packaging for the Chrome Web Store

1. Run `npm run build` to produce a clean, source-map-free `dist/`.
2. Zip the **contents** of `dist/` (the `manifest.json` must be at the root of the zip, not inside a subfolder).
3. Upload the zip in the Chrome Web Store Developer Dashboard.

> A privacy policy is still required by the Web Store because the extension uses the `storage` permission. Add one before submitting.

## Permissions

- `storage` — persists your per-site settings (e.g. auto-apply).
- `*://*.youtube.com/*` — required to inject the button and run the mode on YouTube.

## License

Released under the [MIT License](./LICENSE).

# Tech

## Stack

- **TypeScript 5.7** — all extension code, one file, strict typing gated by `tsc --noEmit`.
- **esbuild 0.24** — bundler, driven by a hand-written script, not a config file.
- **Node 22.18+ / 24** — runs the TypeScript test files directly via type stripping, which is what keeps the test suite dependency-free.
- **node:test** — the test runner. No Jest, Vitest, or assertion library.
- **Manifest V3**, `minimum_chrome_version: 116`.
- **Zero runtime dependencies.** Dev dependencies only: `typescript`, `esbuild`, `@types/chrome`, `@types/node`. Do not add a runtime dependency.

## Commands

Run everything from the `windowed-fullscreen-extension/` directory.

```bash
npm install
npm run typecheck     # tsc --noEmit — the primary gate
npm test              # unit tests, no browser or network needed
npm run build         # emits extension/
npm run build:watch   # rebuild on change, with source maps
npm run check         # typecheck + test + build — run this before shipping
npm run verify:live   # layout check against a real YouTube watch page (needs Chrome)
npm run package       # build + release/windowed-fullscreen-v<version>.zip
                      # fails if that zip already exists; --force to override
npm run store:assets  # re-render listing screenshots and promo tiles
npm run store:icons   # regenerate packaged icons in public/icons/
```

**Before handing work back:** `npm run typecheck && npm test && npm run build`.

Load the build at `chrome://extensions` → Developer mode → Load unpacked → select `extension/`.

## Build model

`scripts/build.mjs` bundles `src/windowed-fullscreen.ts` **once per MV3 surface**, synthesizing a one-line entry for each so esbuild tree-shakes away everything that surface cannot reach:

| Surface | Entry point |
| --- | --- |
| Content script | `startContentScript()` |
| Service worker | `startServiceWorker()` |
| Options page | `startOptionsPage()` |
| Toolbar popup | `startPopup()` |
| Welcome page | `startWelcomePage()` |

This is why **the source must have no top-level side effects**. Add one and every surface's bundle inflates with code it cannot use.

## Versioning

`manifest.json` is the single source of truth for the version. `package.json` mirrors it and `npm run build` fails if they drift.

## Testing layers

- `npm test` covers URL matching and the registry (`tests/adapters.test.ts`), preferences (`tests/prefs.test.ts`), the controller's panel state machine (`tests/panel.test.ts`), the usage counter (`tests/rating.test.ts`), the pure exit-destination and prompt-scheduling decisions (`tests/prompts.test.ts`), the copy budget (`tests/help-copy.test.ts`), and the settings tree's structure (`tests/settings-dom.test.ts`). It cannot see layout.
- `npm run verify:live` attaches to Chrome over the DevTools protocol, injects the real content script into a watch page, clicks the real buttons, and asserts geometry: the panel's left edge sits exactly on the player's right edge, the control bar clears the panel, `ytp-big-mode` survives, and fullscreen leaves none of our classes or inline styles behind. Needs a browser and network, so it is **not part of CI**. Run it locally before shipping any change to the site CSS, the controller's geometry, or the fullscreen handoff.

## CI

`.github/workflows/ci.yml` runs on every push and PR from `windowed-fullscreen-extension/`: `npm ci` → typecheck → unit tests → build → package, and uploads the unpacked extension as an artifact.

## Packaging

`npm run package` writes the upload-ready zip to `release/`. Never zip the build by hand with Windows tooling — `Compress-Archive` and .NET's `ZipFile.CreateFromDirectory` write backslash path separators, so Chrome reads `content\index.js` as one top-level filename and the content script silently goes missing. `scripts/package.mjs` normalizes entry names and puts `manifest.json` at the archive root.

## Code style

- Comments explain **why**, including approaches that failed and why they were abandoned. A comment restating the code is noise; a comment recording a dead end saves the next person a day.
- Every magic number is a named constant with a comment justifying its value.
- Diagnostics are stable codes in the `DIAGNOSTIC` map, written to the console and nowhere else.
- Prefer explicit over clever. Where a CSS selector repeats itself to win on specificity, say so rather than relying on source order silently.
- `!important` is required throughout the active-mode stylesheet: YouTube sizes the player with inline styles from its own JS.
- Match the surrounding paragraph on British/American spelling.

# Implementation Plan: Windowed Fullscreen Extension

## Overview

This plan builds the Manifest V3 Chromium extension incrementally, starting with project scaffolding and shared types, then the pure/testable layers (preference store, adapter registry, generic core, injector, shortcut validation), and finally the UI surfaces (options page, popup) and cross-surface wiring (service worker, content-script bootstrap). Property-based tests (fast-check + jsdom) validate the 14 correctness properties and are placed next to the code they cover. Each step builds on the previous one and ends by wiring components together so no code is left orphaned.

The implementation language is **TypeScript/JavaScript** (the natural language for a Chromium extension), as specified in the design. Property tests use **fast-check** with a **jsdom**-simulated DOM.

## Tasks

- [x] 1. Set up extension project structure, build, and test tooling
  - [x] 1.1 Scaffold the MV3 project and tooling
    - Create the directory layout (`src/shared`, `src/preferences`, `src/adapters`, `src/core`, `src/content`, `src/background`, `src/options`, `src/popup`, `test`)
    - Add `package.json`, TypeScript config, a bundler/build config that emits the extension, and the test runner with fast-check and jsdom configured
    - Create a baseline `manifest.json` (MV3) with content-script match patterns for YouTube, a service worker entry, options page, and popup entries
    - _Requirements: 6.5_

  - [x] 1.2 Define shared interfaces and types
    - Add `src/shared/types.ts` with `SiteAdapter`, `SiteDescriptor`, `AdapterRegistry`, `WindowedFullscreenController`, `EnterResult`, `LayoutSnapshot`, `ElementStyleSnapshot`, `ShortcutCombination`, `GlobalPrefs`, `SitePrefs`, `DEFAULT_SITE_PREFS`, `WriteResult`, `ExtMessage`, and `ExtResponse`
    - _Requirements: 6.1, 6.2, 4.7_

- [x] 2. Implement the diagnostic Logger
  - [x] 2.1 Implement the structured Logger
    - Add `src/shared/logger.ts` writing structured entries `{ timestamp, surface, code, message, context }` to the console and an in-memory ring buffer, with a stable code set for player-not-found, native-control-not-found, absent-chrome, re-render-abandoned, and player-lost
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6_

  - [x] 2.2 Write unit tests for the Logger
    - Verify ring-buffer capacity, entry shape, and code emission for each diagnostic case
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6_

- [x] 3. Implement the Preference Store
  - [x] 3.1 Implement the chrome.storage-backed Preference Store
    - Add `src/preferences/store.ts` implementing `getGlobal`/`setGlobal`/`getSite`/`setSite` over `chrome.storage.sync` with `local` fallback, per-site namespaced keys (`site:<siteId>`), documented defaults on absence/corruption, and `WriteResult` failure handling that retains the prior value
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 4.7_

  - [x] 3.2 Write property test for preference round-trip and per-site isolation
    - **Property 10: Preference write/read round-trip with per-site isolation**
    - **Validates: Requirements 4.1, 4.6**

  - [x] 3.3 Write property test for defaults on absent or unreadable preferences
    - **Property 11: Defaults when preferences are absent or unreadable**
    - **Validates: Requirements 4.7, 4.4**

  - [x] 3.4 Write property test for write-failure retaining the prior value
    - **Property 12: Write failure retains the prior value**
    - **Validates: Requirements 4.2**

- [x] 4. Implement adapter architecture
  - [x] 4.1 Implement the Adapter Registry
    - Add `src/adapters/registry.ts` with ordered `register` and `resolve(url)` returning the earliest-registered matching adapter or `null`
    - _Requirements: 6.3, 6.4, 6.6_

  - [x] 4.2 Write property test for adapter resolution by registration order
    - **Property 6: Adapter resolution by registration order gates activation**
    - **Validates: Requirements 6.4, 6.6, 3.5**

  - [x] 4.3 Implement the YouTube Site_Adapter
    - Add `src/adapters/youtube.ts` implementing `matches`, `findControlsContainer`, `findNativeFullscreenButton`, `findPlayer`, `getSiteChromeSelectors`, and `onVideoChange` with all YouTube selectors centralized in this file; register it in the registry
    - _Requirements: 6.5, 1.5_

  - [x] 4.4 Write unit tests for the YouTube adapter
    - Verify `matches` for watch/non-watch URLs and selector resolution against a YouTube-like jsdom fixture
    - _Requirements: 6.5_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the Generic_Core / WindowedFullscreen controller
  - [x] 6.1 Implement enter/exit state machine and restore snapshot
    - Add `src/core/controller.ts` with `enter(descriptor)`, `exit()`, `toggle(resolve)`, and `isActive`; capture a `LayoutSnapshot` before mutating, expand the player to fill the viewport, hide located chrome (tolerating/logging absent selectors), refuse entry on incomplete descriptor preserving page state, register the Escape listener, drive button engaged/inactive state, and never call the Fullscreen API
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 6.2, 7.3_

  - [x] 6.2 Implement player-loss watcher
    - Detect removal of the active player element from the DOM, exit, restore chrome from the snapshot, and log "player lost"
    - _Requirements: 7.6_

  - [x] 6.3 Write property test for entry post-conditions
    - **Property 2: Entry post-conditions hold**
    - **Validates: Requirements 2.2, 2.3, 2.9**

  - [x] 6.4 Write property test for toggle/restore round-trip and no-fullscreen
    - **Property 3: Toggle/restore round-trip preserves layout and never goes fullscreen**
    - **Validates: Requirements 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10**

  - [x] 6.5 Write property test for incomplete-descriptor refusal
    - **Property 7: Incomplete descriptor refuses entry and preserves state**
    - **Validates: Requirements 6.2**

  - [x] 6.6 Write property test for partial-chrome handling
    - **Property 8: Partial chrome — hide located, log absent, still enter**
    - **Validates: Requirements 7.3**

  - [x] 6.7 Write property test for player-loss exit and restore
    - **Property 9: Player loss while active exits and restores**
    - **Validates: Requirements 7.6**

- [x] 7. Implement the Button Injector + MutationObserver
  - [x] 7.1 Implement idempotent injection and SPA re-verification
    - Add `src/content/injector.ts` with `start`/`stop`, a debounced `ensureButton()` that inserts exactly one marked button (`data-wfs-button`) immediately after the native control with a distinct accessible name and `aria-pressed`/`is-active` state, never duplicating, leaving the native control untouched, and re-verifying on `onVideoChange`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.10, 6.6_

  - [x] 7.2 Implement bounded detection and re-render loops
    - Initial detection retries at intervals ≤2s for max 10 attempts then logs and stops; re-render after page removal (mode inactive) within 2s of controls reappearing for up to 5 attempts; abandon and log if controls do not reappear within 30s
    - _Requirements: 1.6, 7.1, 7.2, 7.4, 7.5_

  - [x] 7.3 Write property test for idempotent, correctly placed injection
    - **Property 1: Injection is idempotent and correctly placed**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

  - [x] 7.4 Write property test for bounded detection and re-render attempts
    - **Property 4: Detection and re-render attempts are bounded**
    - **Validates: Requirements 1.6, 7.4**

  - [x] 7.5 Write unit tests for detection-timeout skip and re-render abandonment
    - Verify player-not-found (7.1) and native-control-not-found (7.2) skip rendering, leave the page unchanged, and log; verify re-render abandonment after 30s (7.5)
    - _Requirements: 7.1, 7.2, 7.5_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement shortcut handling
  - [x] 9.1 Implement the shortcut combination validator
    - Add `src/shortcut/validate.ts` validating a `ShortcutCombination` as valid iff it has at least one modifier and exactly one non-modifier key
    - _Requirements: 3.2_

  - [x] 9.2 Write property test for shortcut combination validity
    - **Property 5: Shortcut combination validity**
    - **Validates: Requirements 3.2**

  - [x] 9.3 Declare commands in the manifest and implement the service-worker command listener
    - Add the toggle command plus at least one spare unassigned command to the manifest `commands` block; implement `src/background/service-worker.ts` to resolve the active tab, gate on Supported_Site, send a `TOGGLE` message within budget, ignore non-supported sites, and surface a failure indication when the content script is unreachable; route storage reads/writes for UI surfaces
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.6_

  - [x] 9.4 Write unit/integration tests for command routing
    - Verify toggle dispatch on supported sites, ignore on non-supported sites (3.5), and failure indication when content script is unreachable (3.6)
    - _Requirements: 3.1, 3.5, 3.6_

- [x] 10. Implement the Options Page
  - [x] 10.1 Implement options UI, validation, and persistence
    - Add `src/options/` rendering one control per preference (auto-apply plus a per-site section for each Supported_Site reflecting valid inputs) and a shortcut-configuration control linking to the browser shortcuts page; load and display the stored value or documented default per control; on valid change persist within 1s and show a saved confirmation; on invalid input reject, retain the prior value, and show an error identifying the invalid input; on persistence failure retain the prior value and show a not-saved error
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 10.2 Implement the Donation_Link
    - Render the Donation_Link with a visible label, always visible/activatable, opening the external page in a new tab while keeping the options page open; on open failure show an error and leave the page unchanged
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 10.3 Write property test for controls reflecting the effective value
    - **Property 13: Options controls reflect the effective value**
    - **Validates: Requirements 5.4, 5.5**

  - [x] 10.4 Write property test for rejecting invalid input and retaining the prior value
    - **Property 14: Options rejects invalid input and retains the prior value**
    - **Validates: Requirements 5.6**

  - [x] 10.5 Write unit tests for options persistence and donation link
    - Verify shortcut control present (5.2), valid change persists with confirmation (5.3), persistence-failure error (5.7), and donation link present/visible/opens-new-tab/open-failure (8.1–8.4)
    - _Requirements: 5.2, 5.3, 5.7, 8.1, 8.2, 8.3, 8.4_

- [x] 11. Implement the Popup
  - [x] 11.1 Implement the popup surface
    - Add `src/popup/` showing current-site status (adapter active? mode active?) read via `GET_STATUS`, with links to the options page and Donation_Link
    - _Requirements: 8.1_

- [x] 12. Wire the content script together
  - [x] 12.1 Implement the content-script bootstrap
    - Add `src/content/index.ts` that resolves the active adapter from the registry (injecting nothing when none matches), starts the injector, instantiates the core controller, wires the button click and `TOGGLE` message to `toggle`, registers Escape handling, and applies auto-apply (enter within 1s of player load when enabled for the site)
    - _Requirements: 4.5, 6.3, 6.6, 2.7, 3.1_

  - [x] 12.2 Write integration tests for end-to-end enter/exit and auto-apply
    - Verify enter/exit on a YouTube-like jsdom fixture, adapter activation on load (6.3), preferences load on session start (4.3), and auto-apply enters when enabled and not when disabled (4.5)
    - _Requirements: 4.3, 4.5, 6.3_

- [x] 13. Add smoke/configuration tests
  - [x] 13.1 Write smoke/configuration tests
    - Verify the manifest declares the toggle command plus at least one spare unassigned command (3.3), exactly one adapter has `siteId === "youtube"` (6.5), and the Generic_Core module imports no site-specific selectors (architectural boundary for 6.1)
    - _Requirements: 3.3, 6.1, 6.5_

- [x] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP.
- Each task references specific requirements for traceability; property test tasks reference the exact design property and the requirements it validates.
- Property-based tests use fast-check (minimum 100 iterations) with a jsdom-simulated DOM; the Fullscreen API is spied to assert it is never invoked (Property 3), and `chrome.storage` is replaced with a configurable in-memory stub (Properties 10–12).
- Checkpoints provide incremental validation points.
- Timing-bound criteria are verified within the example/integration tests against a fake clock where possible; real-browser timing verification is a manual pre-publish step outside this coding plan.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "4.1", "9.1"] },
    { "id": 3, "tasks": ["2.2", "3.2", "3.3", "3.4", "4.2", "4.3", "9.2"] },
    { "id": 4, "tasks": ["4.4", "6.1", "9.3"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "9.4"] },
    { "id": 6, "tasks": ["7.1", "10.1", "11.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "10.2", "10.3", "10.4"] },
    { "id": 8, "tasks": ["7.4", "7.5", "10.5"] },
    { "id": 9, "tasks": ["12.1"] },
    { "id": 10, "tasks": ["12.2", "13.1"] }
  ]
}
```

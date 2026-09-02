# Releasing

`manifest.json` is the single source of truth for the version. `package.json` mirrors it and
`npm run build` fails if they drift.

## The one mistake with no symptom on your machine

**Never ship a build pointed at the provider's test host.**

A test build validates test-mode keys perfectly and rejects every real one, so the first
person to find out is somebody who paid $10 and was told their key was not accepted.

There are **two** constants and they flip together:

| Constant | Test value | Where |
| --- | --- | --- |
| `DODO_API_BASE` | `https://test.dodopayments.com` | §14 |
| `PRO_PURCHASE_URL` | `https://test.checkout.dodopayments.com/buy/…` | §10 |

The checkout link is the quieter of the two: a test checkout accepts a test card, charges
nothing, and issues a key no live validate call will recognise. Nothing errors anywhere.

`test.checkout.dodopayments.com` does not contain `test.dodopayments.com`, so a single
substring check for the API host lets the checkout link straight through. The package guard
looks for both needles separately.

Each is a single string rather than a mode flag with a lookup table, on purpose: a table
would put both hosts in every bundle and leave the guards nothing to look for.

## Test mode is the correct state while developing

You cannot work against live licence keys without buying the product to test it, which is a
real charge and a refund to file. So both constants stay in test mode for the whole
development phase and move to live in the same commit that bumps the version and cuts the
zip.

`scripts/package.mjs` is what stops a test build reaching the store, and it is absolute. See
`testing.md` for why the other two guards are deliberately weaker.

## Still to do at the provider, at release time and not before

**Create the $10 product in live mode** and put its checkout URL in `PRO_PURCHASE_URL`.
Test-mode and live-mode product ids differ, so the current id cannot simply be moved to the
live host.

## The sequence

1. Flip `DODO_API_BASE` and `PRO_PURCHASE_URL` to live, in one commit.
2. Confirm `manifest.json` and `package.json` carry the same version.
3. `npm run check`
4. `npm run verify:live` — pass `--url=` a chaptered video.
5. `npm run package` — writes `release/windowed-fullscreen-v<version>.zip`.
6. Tag `v<version>`. This is what makes CI run its own `Package` step.
7. Upload the zip. Update the listing from `store-assets/LISTING.md`.

`npm run package` refuses to overwrite an existing zip. Bump the version rather than
reaching for `--force`.

## Never zip the build by hand on Windows

`Compress-Archive` and .NET's `ZipFile.CreateFromDirectory` write backslash path separators,
so Chrome reads `content\index.js` as one top-level filename and the content script silently
goes missing. `scripts/package.mjs` normalizes entry names and puts `manifest.json` at the
archive root.

## Outstanding for 2.0.0

- **`npm run verify:live` has not been run against the finished dock work.** The unit suite
  is green and blind to layout. The dock plumbing moved during this release — three columns,
  a derived `--wfs-docked-width`, per-dock offsets — and that script is the only thing that
  checks any of it against a real page. Run it before packaging, on a chaptered video.
  Widths should land where they did before the refactor, because the fitting order is
  unchanged: outboard to inboard, each dock fitted against what the docks outside it
  actually took. **If a pixel moved, stop and find out why.**
- **The transcript dock's instant open has not been seen in a browser.** The column is now
  reserved synchronously on the press by `TRANSCRIPT_PENDING_CLASS`, and while it is set
  `#panels` is held at the dock's box. `tests/transcript-dock.test.ts` pins the structure,
  including that the pending rule out-specifies the un-hide rule it has to beat — but no test
  can see the frame it actually lands on. Check by hand, **in scrollable mode, scrolled
  partway down the page**, which is the case that produced the three-stage open:
  1. the video narrows and the column appears in the same frame as the press;
  2. the panel never paints below the video;
  3. the page does not scroll, and specifically does not jump to the top.
  Then check a video with **no** transcript: the column must appear briefly and come back,
  with `transcript-open-abandoned` in the console, not stay empty.
  Also check closing it from YouTube's own description button — a retry used to re-open it.
- **The performance work has not been profiled.** Readers reported lag; four causes were
  found and fixed by inspection, not by measurement (see the "Cost" section of
  `youtube-layout.md`). Take a DevTools Performance profile of a playing video **with
  captions on**, mode off and mode on, and keep the numbers somewhere. The one open question
  the fixes did not answer is whether the 34 `:has()` blocks in the active-mode stylesheet
  cost anything while the mode is off; that sheet is injected on every watch page. Do not
  change it without a profile either way.
- **Auto-apply needs one pass by hand now that the per-channel rules are gone.** Its retry
  loops existed only for those rules and went with them, so `maybeAutoApply` decides on the
  first look from the stored switch alone. Check that turning *auto-apply* on for YouTube
  still brings the mode up (a) on a cold load straight onto a watch page, and (b) on an
  in-app navigation from the home page to a video. Neither path is reachable from the unit
  suite — it is a closure inside `startContentScript`.
- **The screenshots are pre-2.0.0** and need reshooting; the popup no longer has an
  *Auto-Fullscreen Channels* card, so any shot showing one is wrong. See
  `store-assets/LISTING.md`.
- **The published privacy policy** needs checking against what this release sends.
- **The live $10 product** does not exist at the provider yet.

## Before submitting

- **Screenshots.** `npm run store:assets` re-renders the listing screenshots and promo
  tiles into `store-assets/marketing/out/`. Check them against what actually ships — the
  injected button count in particular has changed twice.
- **Icons.** `npm run store:icons` regenerates `public/icons/`.
- **The listing copy.** `store-assets/LISTING.md` holds copy-paste answers for the Developer
  Dashboard, including the permission justifications and the Data Practices answers.
- **The privacy claim.** If anything about what the extension sends has changed, it changes
  in `README.md`, `store-assets/LISTING.md`, the published listing, the store's data-disclosure answers
  and the published privacy policy in the same commit. See `pro-and-licensing.md`.
- **`CHANGELOG.md`.** The top section is unreleased work until the version bump happens.

## What a major bump is for

2.0.0 followed 1.3.0 because three things changed what a returning reader has to re-learn: a
paid tier exists, the settings surface moved into the popup, and the docks carry settings of
their own.

A 1.4.0 was built and never published, so its changelog section was folded into 2.0.0 rather
than listed as a release nobody could install. The store only requires the version to sort
higher than the published one, so the gap costs nothing.

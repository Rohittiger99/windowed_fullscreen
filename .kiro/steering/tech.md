# Tech

## Stack

- **TypeScript 5.7** — all extension code in one file, gated by `tsc --noEmit`.
- **esbuild 0.24** — bundler, driven by a hand-written script, not a config file. Every
  build except `build:watch` is minified, with `keepNames`. The content script is parsed on
  every YouTube page before any of it runs, so the comments that make the source readable
  are stripped from what ships.
- **Node 22.18+ / 24** — runs the TypeScript test files directly via type stripping, which
  is what keeps the test suite dependency-free.
- **node:test** — the test runner. No Jest, no Vitest, no assertion library.
- **Manifest V3**, `minimum_chrome_version: 116`.
- **Zero runtime dependencies.** Dev dependencies only: `typescript`, `esbuild`,
  `@types/chrome`, `@types/node`. **Do not add a runtime dependency.**

## Where the detail lives

Commands, the build model, the section index and the invariants are in
`windowed-fullscreen-extension/AGENTS.md`, which is the entry point for editing this
project. Deeper reference is in `windowed-fullscreen-extension/docs/`.

This file deliberately does not restate them. Two copies of a command list means one of
them is wrong, and it is always the copy further from the code.

| Question | File |
| --- | --- |
| What do I run, and what are the invariants? | `AGENTS.md` |
| Surfaces, bundling, sections, adding a thing | `docs/architecture.md` |
| Test layers, and what a green suite does not prove | `docs/testing.md` |
| Cutting a release, the provider test→live flip | `docs/release.md` |

**Before handing work back: `npm run check`** (typecheck + test + build), from
`windowed-fullscreen-extension/`.

## Versioning

`manifest.json` is the single source of truth. `package.json` mirrors it and
`npm run build` fails if they drift.

## CI

`.github/workflows/ci.yml` runs on every push and PR from
`windowed-fullscreen-extension/`: `npm ci` → typecheck → unit tests → build → package, and
uploads the unpacked extension as an artifact.

The `Package` step runs on `v*` tags only. Per commit it would be red for the whole
development phase, because the tree is deliberately pointed at the payment provider's test
host until release. `docs/testing.md` explains the guard split.

## Packaging

`npm run package` writes the upload-ready zip to `release/`. **Never zip the build by hand
with Windows tooling** — `Compress-Archive` and .NET's `ZipFile.CreateFromDirectory` write
backslash path separators, so Chrome reads `content\index.js` as one top-level filename and
the content script silently goes missing. `scripts/package.mjs` normalizes entry names and
puts `manifest.json` at the archive root.

## Code style

Summarised in `AGENTS.md`. The two that get broken most often:

- Comments explain **why**, including approaches that failed and why they were abandoned.
  A comment restating the code is noise; a comment recording a dead end saves the next
  person a day.
- Every magic number is a named constant with a comment justifying its value, and every
  class the JS applies has a named constant.

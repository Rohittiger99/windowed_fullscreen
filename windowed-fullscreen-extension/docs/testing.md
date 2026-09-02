# Testing

Two layers. The unit suite is fast, dependency-free and blind to layout. `verify:live` is
the only thing in the project that sees layout, and it needs a browser and a network.

```bash
npm run typecheck     # tsc --noEmit. The primary gate
npm test              # unit tests, no browser or network
npm run build         # emits extension/
npm run check         # all three, in that order
npm run verify:live   # layout against a real YouTube page. Not in CI
```

Before handing work back: `npm run check`.

## The unit suite

`node:test`, run directly against the TypeScript by Node's type stripping. No Jest, no
Vitest, no assertion library. `npm test` is `node --test "tests/*.test.ts"`, so a new file
matching that glob is picked up with no registration step.

| File | What it covers |
| --- | --- |
| `adapters.test.ts` | URL matching, the adapter registry, and that every `pageDependentControls` selector resolves inside the player subtree |
| `prefs.test.ts` | Preference storage, coercion, and that reading an old record does not rewrite it |
| `transcript-dock.test.ts` | The transcript dock's stylesheet contract: the pending/expanded split, and that the reduced panel selector still matches everything the explicit one did |
| `panel.test.ts` | The controller's panel state machine, including the block mounting *after* entry |
| `rating.test.ts` | The usage counter and the session threshold |
| `prompts.test.ts` | The pure exit-destination lookup and prompt scheduling |
| `help-copy.test.ts` | The copy budget, property-based over every `HELP_COPY` string |
| `settings-dom.test.ts` | The structure the settings tree builds, against a stub document |
| `entitlement.test.ts` | The 4xx-versus-everything-else split, and that the two provider constants are in the same mode |
| `pro-features.test.ts` | Dock width clamping, transcript extraction, capture filenames, timestamp formatting |

`tests/support/dom.ts` holds the stub document. There is no browser anywhere in this layer.

`tests/support/pbt.ts` is a small property-based testing harness, written here rather than
installed — the zero-dependency rule applies to dev dependencies too. `forAll(name, gens, fn)`
is the entry point; the generators are `constant`, `exhaustive`, `oneOf`, `bool`, `int`,
`arrayOf` and `record`. A generator that can enumerate its whole domain does, so a property
over a few small fields is proved rather than sampled; anything larger is sampled from a
seeded `mulberry32`, which is what makes a failure replayable. Tests named `Property: …` use
it. Prefer it wherever the thing under test is pure and its inputs are small — the exit
destination lookup and the prompt gates are the existing examples.

**What it cannot see: layout.** Layout only exists inside a real YouTube page. A green unit
suite says nothing about whether the panel overlaps the video.

**Nor can it see timing, or cost.** `transcript-dock.test.ts` pins the *structure* the
instant transcript open depends on — which rules key off a press in flight and which stay
keyed off the site's expanded panel — and that is worth pinning, because getting the split
wrong is silent. It cannot tell you the dock actually arrives in the same frame as the
press. Nothing here can see a MutationObserver's cost, a forced reflow, or a dropped frame
either. For those, load the unpacked build and take a Performance profile with the mode on
and a video playing; there is no automated coverage of extension overhead in this project
and this file should not imply otherwise.

## `npm run verify:live`

Attaches to a Chrome instance over the DevTools protocol, injects the real content script
into a watch page, clicks the actual buttons, and asserts geometry.

Pass `--url=` a video **with chapters**, or the chapter assertions skip.

It asserts:

- the panel's left edge sits exactly on the player's right edge, with no overlap
- the control bar clears the panel
- `ytp-big-mode` survives, so the control bar stays at its large size
- the chapter segments tile the bar on one row, with and without the panel
- our button anchors after YouTube's control cluster, not inside it
- the layers stay ordered player < panel < masthead < popups, none of them clamped
- the site's own menus and dialogs open above the player and the panel, while a closed
  guide drawer stays below the player so it cannot swallow clicks
- the panel is opaque and legible in both the light and the dark theme
- the revealed masthead owns the top edge, rather than the player's overlay
- clicking the chapter title hands the page back, `#secondary` is visible again so the
  Chapters panel can be seen, and auto-apply does not pull the mode back on
- entering fullscreen leaves no class or inline style of ours behind
- every way out of fullscreen lands where it should: YouTube's button, a double-click, `f`
  and `Escape` all hand back the state fullscreen was entered from, and our own buttons
  return to windowed mode with `ytp-big-mode` intact
- the star controls honour `prefers-reduced-motion`, keep a visible focus outline, and meet
  their hit-area minimum

**Run it before shipping any change to** §3's CSS, the controller's geometry, the dock
plumbing, or the fullscreen handoff.

It is not part of CI because it needs a browser and a network.

## CI

`.github/workflows/ci.yml` runs on every push and PR from `windowed-fullscreen-extension/`:
`npm ci` → typecheck → unit tests → build → package, and uploads the unpacked extension as
an artifact.

**The `Package` step runs on `v*` tags only.** Per commit it would have made CI red for the
entire development phase, because the tree is deliberately pointed at the payment
provider's test host until release. See `release.md`.

## Why the guards are split the way they are

Three things could have asserted that the build points at the live provider. Getting the
split wrong once made both `npm test` and CI red on every commit that was not a release, and
a permanently red check is one nobody reads.

- **`scripts/package.mjs` is the release gate, and it is absolute.** It searches the emitted
  bundle for both test hosts, so it reads what the build actually produced rather than what
  the source says, and the zip it writes is the only thing that can be uploaded. **Never make
  this conditional.**
- **`tests/entitlement.test.ts` asserts only that the two provider constants are in the same
  mode.** That covers the one failure nothing else sees: a live API host with a test checkout
  link sends a buyer to a page that accepts a test card, charges nothing, and issues a key the
  live host will never recognise, with no error anywhere. It used to assert both were live,
  which is what made the suite permanently red.
- **The CI `Package` step runs on tags only**, for the same reason.

## Adding a test

Put it in the file that owns the behaviour. If a decision is pure, make it a pure function
and test it here rather than reaching for `verify:live` — the exit-destination lookup and the
dock width clamp are both pure for exactly that reason.

A new `tests/*.test.ts` file needs no registration. Add it to the table above in the same
commit.

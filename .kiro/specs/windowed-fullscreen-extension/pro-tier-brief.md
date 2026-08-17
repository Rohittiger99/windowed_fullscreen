# Windowed Fullscreen — 1.4.0 Pro tier build brief

Handoff document. Everything decided in planning, plus findings already verified
against the source. Read this instead of re-deriving the plan.

## Context

Chrome MV3 extension in `windowed-fullscreen-extension/`. Adds a windowed-fullscreen
mode to YouTube: the player fills the browser window, the Fullscreen API is never
called, so the tab strip, clock, and taskbar stay visible.

Read `AGENTS.md` and `.kiro/steering/*` before editing. All code is in
`src/windowed-fullscreen.ts`, numbered sections §1–§13 — navigate by section marker,
not line number. Zero runtime dependencies. `manifest.json` owns the version.

## State

- **1.3.0 is live** on the Chrome Web Store. Roughly 10 users.
- **Unreleased work already in `CHANGELOG.md`**: live chat dock, suggestions rail in
  scrollable mode, close button on the docked comment panel, masthead ends where a
  dock begins, live-chat scrubber re-measure fix.
- **`README.md` was corrected already** — the three stale spots (live chat described
  as "not included", the rail listed as hidden in scrollable mode, the missing close
  button) are fixed. No further README drift known.

## Facts the split depends on

- The comment panel, cover/scrollable modes, and per-site auto-apply all shipped in
  **1.2.0** — the first public release. Everything in the Free list below has already
  been public for two versions. This is what makes the "nothing moves" rule possible.
- 1.3.0 was the settings/popup rebuild, welcome page, rating row, and fixes. It added
  no layout features.

## Decision: monetise with a Pro tier

$5 one-time, lifetime. Chosen over donations.

Reasoning: donation-funded software converts terribly — published work on open source
donations is unambiguous, and commercial open source sees under 1% of downloaders buy
anything. Freemium benchmarks sit at 2–5%, but those are mostly SaaS with recurring
engagement, so a $5 consumer utility with free competitors should assume the bottom of
that range: **0.5–1.5%**. Still several times what a donation link would return.

The decisive factor is *surface*, not rate. Most users install this, set it up once,
and never open the settings again. A donate link lives in the options page, which such
a user sees exactly once — on day one, before the extension has done anything for
them. Pro features live in the player, where the user actually is, and are seen
repeatedly after value has accumulated.

**Governing rule: nothing currently free moves behind the paywall.** Every Pro feature
is new work. This removes bait-and-switch risk entirely and means **no grandfathering
code is needed**. Optionally gift Pro to the ~10 early users as goodwill — a
thank-you, not compensation.

### The line

> Free: the docks work. Pro: you control them.

Read the table as a whole. Several features appear on both sides because the *feature*
is free and only one aspect of it is Pro. Do not gate a whole row on the strength of
one word in it.

| Feature | Free | Pro |
| --- | --- | --- |
| Windowed mode, cover + scrollable | Yes, entirely | — |
| Comment panel — **docking it** | Yes | — |
| Comment panel — **dragging it wider** | No | Yes |
| Live chat — **docking it** | **Yes** | — |
| Live chat — **dragging it wider** | No | Yes |
| Suggestions rail in scrollable mode | Yes, entirely | — |
| Auto-apply **per site** ("always on YouTube") | **Yes** | — |
| Auto-apply **per channel** ("always on these channels") | No | Yes |
| Frame capture button | No | Yes |
| Shortcut for the **windowed** button | **Yes** | — |
| Shortcut for the **chat** button | **Yes** | — |
| Shortcut for the **capture** button | No | Yes — because capture itself is Pro |
| Masthead reveal, Escape layering, fullscreen handoff | Yes, entirely | — |

So there are exactly **three** things to build behind the gate:

1. Drag-to-resize, for both docks
2. Per-channel auto-apply rules
3. The frame capture button, and a shortcut bound to it

### Two things that are explicitly NOT gated

**Live chat docking is free.** Do not gate it. It has no control of its own by design —
it reacts to YouTube's own chat toggle — so there is nowhere to attach an upsell
without inventing a button purely to lock it. It is the same class of thing as the free
comment panel, so gating one and not the other reads as arbitrary. And it is the
strongest livestream hook for growth, which feeds the Pro funnel. Only *resizing* it
is Pro.

**Keyboard shortcuts are not a paid category.** The windowed and chat shortcuts are
free. The capture shortcut is Pro solely because you cannot bind a shortcut to a
feature you do not own — it is a consequence, not a gate.

## Release plan — everything in 1.4.0

One submission containing:

- The Unreleased free work (chat dock, suggestions rail, panel close button, masthead
  dock edge, scrubber fix)
- All three Pro features, the entitlement layer, and the licence entry UI
- The Vercel verify endpoint
- New screenshots and a rewritten listing with a clear Free vs Pro section
- Updated privacy claims and store data disclosure

Because it is a single submission: run `npm run verify:live` against every new
geometry path before packaging, and expect a longer store review than 1.3.0 got.

## Technical findings, verified against the code

### Resizable docks — feasible; the architecture already supports it

Width is centralised in CSS custom properties rather than scattered across rules:

```
--wfs-panel-width   → panel width, player right inset, --wfs-docked-width
--wfs-docked-width  → where the masthead stops (sum of both docks)
--wfs-panel-right   → panel offset when chat docks outboard
```

The source even states the intent: every rule that narrows something to clear a dock
reads one property, so the docks cannot disagree about their shared edge. Resizing is
therefore a matter of writing one token.

Three traps:

- A rule sets `--wfs-panel-width: 0px` while fullscreen is active. Writing the width
  **inline on `<html>` from JS would outrank that rule and break the fullscreen
  handoff.** Write the stored width into the injected stylesheet instead, so the
  fullscreen rule can still win on specificity.
- YouTube needs a re-measure nudge on **drag end only** — the same mechanism as the
  live-chat scrubber fix. Nudging during the drag will thrash the player on every
  mouse move.
- Both docks feed `--wfs-docked-width`. Needs a **minimum player width guard** so the
  video cannot be squeezed to a sliver; the drag must stop at the limit.

### Frame capture

`BUTTON_ROLES` is currently `["mode", "panel"]`. Add a `"capture"` role plus a
`ButtonSpec` in `startSession` (§9); the injector already renders specs in on-screen
order. Place it to the left of the windowed button.

- **DRM caveat.** Normal YouTube video arrives through blob URLs, so the canvas is not
  tainted and capture works. Widevine content (rentals, movies) yields a black frame
  or a security error — detect it and say so rather than saving a black PNG.
- Use a temporary `<a download>` element rather than the `chrome.downloads` API, to
  avoid adding a permission.
- Settings option: direct download versus copy to clipboard.

**This button is the shop window.** It is the only Pro feature a set-and-forget user
meets without going looking — it sits in the control bar of every video they watch. So
**show it to free users** and open a clean "Pro — $5 one-time" prompt when they click,
rather than hiding it. A visible locked door converts; an invisible one does not exist.
Every other Pro surface (the drag handle, the rules list) is reachable only by someone
already exploring the settings.

### Shortcuts

Chrome reads commands from the manifest, so the capture shortcut appears at
`chrome://extensions/shortcuts` for free users too and cannot be hidden. Its handler
must show the upgrade prompt rather than silently doing nothing.

### Per-channel rules

Follow the `SitePrefs` / `DEFAULT_SITE_PREFS` / `normalizeSitePrefs` pattern in §5,
checking each new field independently so values written by older versions still read
as valid. Cap the rule list (around 50) or LRU-trim it, so storage cannot grow
unbounded.

## Licence architecture

Payments through **Dodo Payments** — India-founded, merchant of record, INR payouts,
licence keys with activation limits built in. Stripe is invite-only in India, which
also rules out ExtensionPay since it settles through Stripe. Gumroad is the fallback
if Dodo onboarding stalls.

```
Extension → https://<separate-vercel-project>/api/verify → Dodo API
            (holds DODO_API_KEY in Vercel env vars)
```

- The proxy is required because Dodo's licence endpoints need `Bearer <API key>`, and
  anything shipped inside the extension is readable by every user.
- Separate Vercel project, **not** the portfolio site. Two files, no pages, no
  database, no logins, no PII. Add a simple per-IP rate limit.
- No webhooks. An extension has no address to receive them, and a one-time purchase
  does not need them — validation is pull-based.
- No user accounts and no login. The licence key is the only credential.
- Cache `{ pro, checkedAt }` in `chrome.storage.local`, re-validate roughly every
  14 days, and **fail open** on network or endpoint errors. A paying user losing
  features on a flaky connection is worse than a pirate getting a free fortnight.

## Docs that must change in this release

The privacy promise currently claims **no network requests** in `README.md`,
`store-assets/LISTING.md`, the published store listing, and
`.kiro/steering/product.md`. A licence check is a network request. Update all of them
plus the store's data-disclosure answers, or this becomes a policy problem worse than
the paywall itself.

Also update `AGENTS.md`, `CHANGELOG.md`, and the section index in the source file
header.

## Activation, which matters regardless of the paywall

Most users install this, set it up once, and never open the settings again. That means
they also never discover the side panel or scrollable mode — features already built and
already free. The welcome page is the only shot at fixing this, and today it thanks the
user and offers usage hints. It should **teach the two or three things that make the
extension worth keeping.** That lifts retention, reviews, and Pro conversion at the
same time, and costs less than any of them.

## Build order

1. **`§14` entitlement layer** — Pro state type, `chrome.storage.local` read/write, a
   single `isPro()` gate, stub validator. Provider-agnostic, no network. No behaviour
   change yet, so it is easy to review and easy to discard.
2. Wire gates into prefs (§5), the button injector (§8), and `startSession` (§9),
   with upgrade prompts.
3. Resizable docks.
4. Frame capture button and its shortcut.
5. Per-channel auto-apply rules.
6. Licence entry UI in the settings tree (§11).
7. Vercel verify endpoint, then swap the stub validator for it.
8. Docs, listing, screenshots, privacy claims, store disclosure.
9. `npm run typecheck && npm test && npm run build`, then `npm run verify:live`, then
   bump `manifest.json` and `package.json` together and `npm run package`.

## Project rules to respect

- **No top-level side effects.** Per-surface tree-shaking depends on it.
- **Site knowledge only in §3** (the YouTube adapter). The controller, injector, and
  content script work from a `SiteDescriptor` and never name a site element.
- **`enter()` snapshots before mutating; `exit()` restores exactly.** A new mutation
  means a new `LayoutSnapshot` capture in the same commit.
- **Bounded loops only**, each emitting a `DIAGNOSTIC` when it gives up.
- Comments explain **why**, including approaches that failed. Every magic number is a
  named constant with a justification.
- Gate before handing work back: `npm run typecheck && npm test && npm run build`.
  Run `npm run verify:live` before shipping anything touching geometry — resizing is
  exactly what it guards.

# Store listing assets

Everything in `out/` is generated. Don't edit those PNGs — edit the composition
in `src/` and re-render:

```bash
npm run store:assets       # render everything, then verify it
node marketing/render.mjs 04     # re-render only sources matching "04"
```

## What to upload where

| File | Dashboard slot | Notes |
| --- | --- | --- |
| `01-hero-1280x800.png` | Screenshot 1 | Lead with this one. |
| `02-button-1280x800.png` | Screenshot 2 | The integrated button. |
| `03-compare-1280x800.png` | Screenshot 3 | Native vs windowed. |
| `04-popup-1280x800.png` | Screenshot 4 | Popup features. |
| `05-controls-1280x800.png` | Screenshot 5 | Toggles, shortcut, privacy. |
| `promo-small-440x280.png` | Small promo tile | **Required.** Items without one are ranked below items that have one. |
| `promo-marquee-1400x560.png` | Marquee promo tile | Optional, but you cannot be featured in the store's marquee without it. |

Promo tiles are reviewed separately from the extension, and their status shows in
the listing's Promotional Images section: *Pending Review* (not yet shown in the
store), no status (approved and live), or *Rejected* with reasons. Drafts and
trusted-tester items don't get reviewed, so a tile only gets approved once the
item is actually published.

The store accepts a maximum of five screenshots, which is exactly what this
produces. `verify.mjs` enforces that, along with the dimensions and the 24-bit
no-alpha PNG format.

## The brand mark

A browser window drawn as a sticker with a heavy black keyline: a tab strip across
the top (one tall active tab in deep navy carrying a white title pill, plus two
shorter dormant ones), a saturated red viewport with a white four-way expand glyph
on a darker plate, and a light grey bar along the bottom that stays visible —
which is the product in one picture.

Two source files, one identity:

- `src/mark.svg` — full detail, including the three separate tabs, the title pill
  and the five glyphs on the bottom bar. Used for the promo tiles and the 128px
  icon.
- `src/mark-small.svg` — tabs collapsed into one navy band, title pill and bar
  glyphs dropped, four arrows reduced to a bold diagonal pair, and every surviving
  element scaled up. Used for 48px and below.

Both are vector on purpose. The pipeline needs a transparent surround and clean
edges at small sizes, and a raster source carries a baked-in background and
compression noise into both.

### The geometry is measured, not eyeballed

Every coordinate in both marks was read off the reference render by sampling pixel
runs along its centre lines. The reference's artwork occupied x 306..947,
y 368..893 of a 1254x1254 canvas, so `mark.svg` uses a **642x526 viewBox**: one
unit in the file is one pixel in the reference, and any number can be checked
against it directly. The measured palette is keyline `#000000`, tab navy
`#032578`, title pill `#ffffff`, dormant tabs `#555454` and `#1f1f1f`, viewport
`#e9191e`, plate 16% black over the viewport, bar `#878686`, bar glyphs `#050505`.

Two deliberate departures: the keyline is pure black where the reference reads
`#070707` (it was lit by a gradient), and the darker dormant tab is lifted from
`#151515` to `#1f1f1f`, because at `#151515` it is invisible against the keyline
it sits on.

Only `mark.svg` tracks the reference exactly. `mark-small.svg` shares the palette
but is deliberately **less landscape** — 560x526 against 642x526. A square canvas
is filled by its shorter side, so trimming width buys real pixels of height: at
16px the small mark renders 16x15 where the full mark's aspect would give 16x13.
The small icon is not a scaled copy of the large one; optical sizing is normal
practice.

### Two things that made an earlier revision look small and blurry

Worth knowing, because both are easy to reintroduce.

**The viewBox is the artwork, with no built-in margin.** An earlier mark centred
88x76 of drawing inside a 96x96 viewBox and then had `icons.mjs` scale that to
96/128 — so the visible artwork was 88x76 in a 128px canvas, 41% of it, with the
padding applied twice. Padding is the caller's job now, and it is applied once.

**The mark is landscape, so size by width and let height follow.** Setting both
dimensions to the same number makes the renderer letterbox the SVG inside the box
and quietly draw it smaller than asked. `icons.mjs` reads the aspect from the
viewBox; the promo tiles set `width` and `height: auto`.

The blur had a separate cause: `icons.mjs` rasterized at 4x and then had Chrome
downscale the result, on the theory that small sizes needed extra samples for
clean edges. For vector art that is backwards — it resamples an already
antialiased bitmap, softening every edge twice. Rendering once at the target size
measurably reduced blend pixels at 16px (35.6% of opaque pixels to 27.5%) and at
32px (8.3% to 6.5%), was identical at 128px, and was marginally worse at 48px,
which is within noise.

Sizes 48 and 32 both use the small mark. At 48px the full mark's title pill
resolves to about a sixth of a pixel and its bar glyphs to half a pixel, which
reads as smear rather than detail. 48 and 32 therefore look alike, which is fine —
they are never shown side by side.

### Regenerating

```bash
npm run store:icons              # writes public/icons/
npm run store:icons -- --dry-run # writes out/icons/ instead
npm run build                    # copies icons into extension/ — needed before packaging
```

Revert with `git checkout -- public/icons`. The script prints each icon's artwork
size and what share of its canvas it covers, which is the fastest way to catch the
"looks small" regression: expect roughly 72% at 128 and 94% at the toolbar sizes.

Note that the amber in `_base.css` is *product* colour — it marks the injected
button in the screenshots — and is not part of the mark.

### Why it doesn't use YouTube's colours or logo

The store's [branding guidelines](https://developer.chrome.com/docs/webstore/branding)
say: *don't use Google trademarks or a modified version of a Google trademark as
the logo for your extension without written permission from Google.* That rules
out YouTube's play button and any recolour or reshape of it, plus the Chrome logo;
the Windows logo and Explorer folder icon belong to Microsoft and are out for the
same reason.

Competing extensions do use YouTube's red pill with the triangle swapped out.
Being published, popular, and even Featured does not make that compliant — it
means it has not been enforced against yet, and enforcement after an audience is
built is far more costly than before.

What YouTube owns is a specific lockup: a white triangle in a red rounded pill.
The mark here sidesteps it entirely — there is no triangle at all. Expand arrows
carry the mark instead, and they say something a play symbol never could: this is
the *action the extension performs*, not a restatement of the site it runs on.
Red is kept as a line colour rather than a field, so no part of the mark is a red
pill.

The mark does depict a tab strip and a bottom bar, because that arrangement *is*
the product: the video fills the window while the tabs and the taskbar both stay.
Both are drawn as generic shapes rather than as any vendor's UI. **No Start glyph,
no Windows flag, no omnibox, no vendor wordmark, no product-specific silhouette** —
the bar carries a launcher dot, an open-window outline, an overflow chevron, a
signal arc and an account circle, all of which are conventions rather than
anyone's trademark. That distinction is the whole basis for including them:
depicting *a* window with *a* bar describes a category, while reproducing Chrome's
tab shape or Windows' tray borrows an identity.

It is a narrower margin than having no bar at all, so it is worth stating plainly:
if a reviewer reads the bar as Microsoft's shell, the fix is to drop the five bar
glyphs from `mark.svg` — the bar itself, which is the load-bearing part of the
idea, can stay. The stronger version of the claim lives in the screenshots either
way, where it is a truthful depiction of the product in use rather than an
identity borrowed for a logo.

### Both survive, so both get named

The tab strip and the taskbar stay visible, and the copy says so everywhere:
screenshot 01 reads *"tabs and taskbar still there"*, screenshot 03 labels both
panels, and the marquee tile reads *"Tabs and taskbar stay."* An earlier marquee
said only *"Taskbar stays."*, which undersold the feature and contradicted the
screenshot two slots below it. If you reword one of these, reword all of them —
`grep -ri taskbar marketing/src` finds every instance.

The job of saying "YouTube" belongs to the **listing name**, where the guidelines
explicitly permit the constructions "for", "for use with", and "compatible with"
alongside the ™ symbol. That is also where it does more good, since store search
indexes text and not pixels.

## Screenshots vs promo tiles

These two are held to different standards, which is why they look different.

**Screenshots** show the product. They may be annotated, and they are what the
listing body displays. The catch is that the store **downscales every screenshot
to 640x400**, halving all type — so `render.mjs` enforces an 18px minimum on any
text (9px once downscaled, about the floor for a short label). Add
`data-allow-small` to opt a purely decorative element out.

**Promo tiles** sell the brand. The store's [image
guidance](https://developer.chrome.com/docs/webstore/images) is explicit that
they should *not* just be a screenshot, should communicate the brand, avoid text,
use saturated colour, fill the whole region with well-defined edges, and still
work at half size. So the tiles here are the mark, the name, and at most one
short line — no screenshots, no paragraphs, no feature lists.

Both tiles render the mark from `src/mark.svg` at a deliberately large size — 472px
wide on the marquee, 206px on the small tile — and neither redraws it in CSS. An
earlier marquee did rebuild the mark's parts as positioned divs, and it drifted
immediately: it lost the three tabs and the bar glyphs, and its centre plate was
taller than the viewport it sat inside, so it bled out as a dark stripe through
the blue band. Pointing both tiles at the vector means they cannot disagree with
the icons. Both set `width` with `height: auto`, for the landscape-aspect reason
above.

The marquee also carries no miniature of the mark beside its wordmark. A 64px
badge next to a 430px one is the same shape twice, once at a size too small to
read, so the name is set as type instead.

## How it works

Each file in `src/` is a plain HTML document sized to the exact pixel dimensions
of its slot, declared in one place:

```html
<meta name="asset-size" content="1280x800" />
```

`render.mjs` loads each one in headless Chrome over the DevTools protocol,
rasterizes at 2x, downscales to the target size, and flattens the result to a
24-bit PNG with no alpha channel (`lib/png.mjs`). Shared tokens live in
`src/_base.css` and are taken from the extension's own popup and options
surfaces, so the listing and the product match.

### The layout guards

The stage uses `overflow: hidden`, so a broken layout is silently cropped rather
than visibly wrong. Three checks run after every render and fail the build:

- **Overflow.** Every `.shot`, plus anything marked `data-must-fit`, is measured
  against the canvas. This exists because cropping one of these screenshots would
  cut off the taskbar, which is the entire point of the product.
- **Wrapping.** Anything marked `data-no-wrap` must stay on one line. A headline
  quietly wrapping to two lines throws off the whole vertical rhythm below it.
- **Overlap.** Anything marked `data-no-overlap` must stay clear of every `.shot`.
  Absolutely positioned copy will happily sit on top of a screenshot; the footer
  on `04` did exactly that until this check caught it.

If a render stops with `does not fit its canvas`, the guard is doing its job:
shrink the shot's `--w`, or tighten the spacing around it.

### Cropping a capture

`.shot` positions a source capture using fractions of that source, so a crop is
four numbers:

```html
<div class="shot" style="--w: 302px; --cx: 0.6828; --cy: 0.0937; --cw: 0.2087; --ch: 0.6447">
  <img src="../raw/before-popup.png" alt="" />
</div>
```

`--cx` / `--cy` are the crop origin and `--cw` / `--ch` its size, each as a
fraction of the source image. `--w` is how wide the crop should render. Overlay
children positioned in `%` are relative to the crop box, so they line up with
source fractions only on uncropped shots.

**Don't eyeball these numbers.** A crop that is a handful of pixels too wide puts
a strip of the page behind the popup into the shot, which is obvious once someone
zooms in. Measure instead — both captures have flat, uniform surfaces whose edges
are easy to find by scanning luminance along a row or column, and known-size UI
(the popup is 320 CSS px wide, its toggle button inset 18px) to calibrate
against. That is how the popup's bounds above were established: x 1309..1708,
y 101..795.

Percentage-positioned overlays need the same care. A pointer's `left: %` resolves
against its offset parent, so the strip and its pointers on `02` share one
fixed-width wrapper — when the pointers were allowed to stretch to the full stage
width instead, every label sat about 100px right of the icon it named.

`--src-ar` in `_base.css` is the source aspect ratio (height / width). Both raw
captures are 1917x1078; **replace a raw capture with a different aspect ratio and
that token has to change too.**

## Source captures

`raw/` holds the unretouched captures. They were taken at 1917x1078 on a 125%
display, so one CSS pixel of browser UI is exactly 1.25 pixels in the file. That
ratio is worth remembering: it converts any known CSS dimension in the extension
straight into pixels in these captures, which is how the crops were calibrated.

- `after-windowed.png` — windowed fullscreen engaged. The video fills the window
  while the tab strip, address bar, taskbar and clock stay visible. The injected
  button carries its blue active underline (`box-shadow: inset 0 -3px 0 0
  #3ea6ff`), which is what screenshot 2 points at.
- `before-popup.png` — a normal watch page with the toolbar popup open, showing
  the status card, toggle, shortcut link, donation link, auto-apply checkbox and
  privacy link.

### One panel is derived

The "Native fullscreen" panel in `03-compare` is `after-windowed.png` cropped to
just the video area. That is a faithful depiction — native fullscreen shows the
video and nothing else — but it is not a separate capture. To make it a real one,
take a screenshot of the same video in YouTube's own fullscreen (`f`), save it as
`raw/native-fullscreen.png`, and point the left panel's `<img>` at it with the
crop fractions reset to the defaults.

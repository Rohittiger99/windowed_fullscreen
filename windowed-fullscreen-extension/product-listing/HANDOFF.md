# Product Listing Handoff — Windowed Fullscreen

Generated per `PRODUCT_TEMPLATE.md`. These files go into your **portfolio
website** project (not this extension project).

Slug: **`windowedfullscreen`**

## What's in this folder

| File | What it is | Ready? |
|------|-----------|--------|
| `windowedfullscreen.ts` | Product data file | ✅ Ready |
| `windowedfullscreen.png` | Product icon, 256×256 | ✅ Ready |
| `windowedfullscreen-1.png` … | Screenshots, 1280×800 | ❌ You must capture these |

## Screenshots — you need to make these

I can't capture screenshots of the extension running in a real browser, so
you'll need to grab 2–4 yourself at **1280×800**:

1. Load the extension: `npm run build`, then in Chrome go to `chrome://extensions`
   → Developer mode → Load unpacked → pick the `dist/` folder.
2. Open a YouTube video and capture:
   - The windowed-fullscreen button next to YouTube's fullscreen control.
   - The video in windowed-fullscreen mode (taskbar still visible).
   - The toolbar popup.
   - The options page.
3. Save them as `windowedfullscreen-1.png`, `windowedfullscreen-2.png`, etc.

The `windowedfullscreen.ts` file already references two screenshot paths. If you
add fewer or more, update the `screenshots` array to match — otherwise the
gallery will point at missing images.

## Where to copy everything (in the website project)

- `windowedfullscreen.ts`        → `data/products/windowedfullscreen.ts`
- `windowedfullscreen.png`        → `public/icons/windowedfullscreen.png`
- `windowedfullscreen-1.png` etc. → `public/screenshots/windowedfullscreen-1.png`, …

Then register it in `data/products/index.ts`:

```typescript
import windowedfullscreen from "./windowedfullscreen";
```

…and add `windowedfullscreen` to the products array in that same file.

Finally run `npm run build` in the website project to verify.

## Notes on the data I filled in

- **status: `coming-soon`** and **`storeUrl: ""`** — the extension isn't on the
  Chrome Web Store yet. Change status to `live` and paste the store URL once
  published.
- **Privacy:** collects nothing, sends nothing off-device, shares nothing —
  which matches the extension (it only stores your local settings).
- **`accentColor: #1a73e8`** — matches the blue used in the extension's own
  popup/options UI. Change it if you want a different brand color.
- **Dates** are set to 2026-07-10. Adjust `publishedAt` / changelog date to the
  real publish date.

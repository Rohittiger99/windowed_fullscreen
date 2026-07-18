# Product Data Template — Rohit Tiger Developer Hub

## How This Works

You (Rohit) have two separate projects:
1. **The App Project** — where your agent builds the Chrome extension or Android app
2. **The Portfolio Website** (this project) — where the product gets listed

Your app-building agent **cannot directly edit this website**. Instead, the
workflow is:

```
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: Give this template to your coding agent                │
│  STEP 2: That agent reads it and generates:                    │
│          • A TypeScript file (the product data)                │
│          • A product icon image                                │
│                                                                │
│  STEP 3: That agent gives you these files as output            │
│  STEP 4: YOU copy those files into this website project:       │
│          • .ts file    →  data/products/<slug>.ts               │
│          • icon        →  public/icons/<slug>.png               │
│          • screenshots →  public/screenshots/<slug>-1.png       │
│  STEP 5: Register in data/products/index.ts (1 line change)   │
│  STEP 6: Done — website auto-generates everything else         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Instructions for the App-Building Agent

> You are being given this template by the product owner. Your job is to
> generate the product data file for the portfolio website.
>
> **You must output 3 things:**
>
> 1. **A TypeScript file** — Copy the structure below and fill in real data
>    from the product you just built. Name it `<slug>.ts`.
>
> 2. **A product icon** — PNG, 128×128 or 256×256 pixels. Clean design that
>    looks good on dark backgrounds. Name it `<slug>.png`.
>
> 3. **2–4 screenshots** — PNG or WebP, 1280×800 pixels recommended. Show
>    the main UI, key features in action, and settings. Name them
>    `<slug>-1.png`, `<slug>-2.png`, etc.
>
> The product owner will place these files in the correct locations.

---

## TypeScript File Structure

Generate a file with this exact structure. Replace all `<placeholder>` values
with real data from your product.

```typescript
import { Product } from "../types";

const <slug>: Product = {
  // ─── Identity ───────────────────────────────────────
  slug: "<slug>",                          // URL-safe lowercase, e.g. "tabmanager"
  name: "<Product Name>",                  // Display name, e.g. "TabManager"
  tagline: "<Short catchy tagline>",       // One line, e.g. "Organize your browser tabs effortlessly"
  description: "<Full description>",       // 2-4 sentences about what the product does and why
  shortDescription: "<One sentence>",      // Used on listing cards (max ~80 chars)

  // ─── Classification ─────────────────────────────────
  type: "<type>",                          // "chrome-extension" | "android-app" | "web-app"
  status: "<status>",                      // "live" | "coming-soon" | "beta"
  category: "<Category>",                  // e.g. "Productivity", "Utilities", "Finance"
  tags: ["tag1", "tag2", "tag3"],          // For search/filter on listing pages
  platforms: ["<platform>"],               // "chrome" | "firefox" | "edge" | "android"

  // ─── Branding ───────────────────────────────────────
  icon: "/icons/<slug>.png",               // Always use this format (owner will place the file)
  screenshots: [                           // Optional but recommended (2-4 images)
    "/screenshots/<slug>-1.png",
    "/screenshots/<slug>-2.png",
  ],
  accentColor: "#HEXCOLOR",               // Brand color for the product (used in cards/badges)

  // ─── Pricing ────────────────────────────────────────
  pricing: {
    type: "<pricing-type>",                // "free" | "one-time" | "subscription" | "freemium"
    plans: [
      {
        name: "Free",                      // Plan display name
        price: 0,                          // Price in USD (0 for free)
        currency: "USD",
        features: [                        // Bullet points for this plan
          "Feature 1",
          "Feature 2",
        ],
      },
      // Add more plans if needed:
      // {
      //   name: "Pro",
      //   price: 5,
      //   currency: "USD",
      //   interval: "lifetime",           // "month" | "year" | "lifetime"
      //   features: ["Everything in Free", "Pro Feature 1", "Pro Feature 2"],
      //   dodoPriceId: "",                // Dodo Payments price ID (fill later)
      // },
    ],
  },

  // ─── Store Link ─────────────────────────────────────
  storeUrl: "",                            // Chrome Web Store or Play Store URL (empty if not published)

  // ─── Privacy & Permissions ──────────────────────────
  // IMPORTANT: This data auto-generates the privacy policy on the website
  permissions: [                           // For Chrome extensions — list each permission
    { name: "permission_name", reason: "Why this permission is needed" },
    // Examples:
    // { name: "storage", reason: "Saves your settings locally on your device" },
    // { name: "tabs", reason: "Required to manage your open browser tabs" },
    // { name: "activeTab", reason: "Reads the current tab to perform the action" },
  ],
  dataCollected: "None",                   // What user data is collected, e.g. "None" or "Email for account"
  dataSentOffDevice: false,                // Does any data leave the user's device?
  dataSharedWithThirdParties: false,       // Is any data shared with third parties?

  // ─── Features ───────────────────────────────────────
  // 4-6 features displayed on the product page
  // Icon names come from Lucide icons: https://lucide.dev/icons/
  features: [
    {
      icon: "Zap",                         // Lucide icon name (PascalCase)
      title: "Feature Title",
      description: "One sentence describing this feature.",
    },
    // Add 3-5 more features...
  ],

  // ─── FAQ ────────────────────────────────────────────
  // 3-5 common questions
  faq: [
    {
      question: "Question here?",
      answer: "Answer here.",
    },
    // Add more Q&A pairs...
  ],

  // ─── Changelog (optional) ───────────────────────────
  changelog: [
    {
      version: "1.0.0",
      date: "YYYY-MM-DD",
      changes: ["Initial release", "Feature X", "Feature Y"],
    },
  ],

  // ─── SEO ────────────────────────────────────────────
  seo: {
    title: "<Product Name> — <Short Value Prop> | Rohit Tiger",
    description: "<60-160 chars meta description for search engines>",
    keywords: ["keyword1", "keyword2", "keyword3"],
  },

  publishedAt: "YYYY-MM-DD",              // Date product was first published
  featured: false,                         // Set true to highlight on homepage
};

export default <slug>;
```

---

## Field Reference

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `slug` | ✅ | string | URL-safe, lowercase, no spaces. Used in `/product/<slug>` |
| `name` | ✅ | string | Display name |
| `tagline` | ✅ | string | One-line pitch |
| `description` | ✅ | string | 2-4 sentence full description |
| `shortDescription` | ✅ | string | ~80 chars for card view |
| `type` | ✅ | enum | `chrome-extension` \| `android-app` \| `web-app` |
| `status` | ✅ | enum | `live` \| `coming-soon` \| `beta` |
| `category` | ✅ | string | e.g. Productivity, Utilities, Finance |
| `tags` | ❌ | string[] | Used for filtering |
| `platforms` | ✅ | enum[] | `chrome` \| `firefox` \| `edge` \| `android` |
| `icon` | ✅ | string | `/icons/<slug>.png` |
| `screenshots` | ❌ | string[] | `/screenshots/<slug>-1.png` etc. |
| `accentColor` | ✅ | string | Hex color, e.g. `#C2662D` |
| `pricing` | ✅ | object | At least one plan |
| `storeUrl` | ❌ | string | Store listing URL |
| `permissions` | ❌ | array | For Chrome extensions |
| `dataCollected` | ✅ | string | Privacy disclosure |
| `dataSentOffDevice` | ✅ | boolean | Privacy disclosure |
| `dataSharedWithThirdParties` | ✅ | boolean | Privacy disclosure |
| `features` | ✅ | array | At least 1, recommend 4-6 |
| `faq` | ✅ | array | At least 1, recommend 3-5 |
| `changelog` | ❌ | array | Version history |
| `seo` | ✅ | object | Title + description required |
| `publishedAt` | ✅ | string | YYYY-MM-DD format |
| `featured` | ❌ | boolean | Highlight on homepage |

---

## Image Guidelines

### Product Icon
- **Size:** 128×128 or 256×256 pixels (PNG)
- **Style:** Clean, recognizable on dark backgrounds (#0A0A0B)
- **Naming:** `<slug>.png`

### Screenshots
- **Size:** 1280×800 pixels recommended (PNG or WebP)
- **Count:** 2–4 images
- **Naming:** `<slug>-1.png`, `<slug>-2.png`, etc.
- **What to capture:**
  - Main UI / dashboard view
  - Key feature in action
  - Settings or configuration panel
  - Before/after comparison

Screenshots appear in a responsive gallery on the product page between the
description and features sections.

---

## Quick Checklist for Rohit

After your app agent gives you the files:

- [ ] Save `<slug>.ts` file(slug means product name but in lowercase and without spaces) → `data/products/<slug>.ts`
- [ ] Save icon(256x256) → `public/icons/<slug>.png`
- [ ] Save screenshots(2-4 images of size 1280x800) → `public/screenshots/<slug>-1.png`, `<slug>-2.png`, etc.
  [ ] then you have you add the path of these icon and screenshots in the `<slug>.ts` file.
- [ ] Add import in `data/products/index.ts`:
  ```typescript   
  import <slug> from "./<slug>";
  ```
- [ ] Add to the products array in the same file(index.ts)
- [ ] Run `npm run build` to verify (build will fail if data is wrong)
- [ ] Done ✅ — product page, listings, privacy, sitemap all auto-update

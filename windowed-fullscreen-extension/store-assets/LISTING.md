# Chrome Web Store listing

Copy-paste answers for the Developer Dashboard. Asset files live in `marketing/out/`; `marketing/README.md` maps each one to its dashboard slot.

## Submission state

Current package version: **1.2.0** (`release/windowed-fullscreen-v1.2.0.zip`).

1.2.0 combines the three features added since 1.0.0: the masthead hover reveal, scrollable mode, and the side panel. **Nothing in `manifest.json` changed except the version string** — `permissions`, `host_permissions`, `content_scripts.matches`, `commands`, `options_ui`, and `action` are byte-identical to the reviewed 1.0.0 manifest. So there is no new permission warning, no new justification to write, and no data-disclosure change. The three features are CSS and DOM work inside the existing content script:

- **Side panel** repositions YouTube's own `#below` element with CSS. It does not use `chrome.sidePanel`, `scripting`, or `tabs`, and it does not move site DOM — Polymer keeps owning the element, which is why likes, subscribe, and comment pagination keep working.
- **Masthead reveal** tracks cursor proximity in JS and toggles a class. No new host access, and no pointer-event-catching overlay.
- **Scrollable mode** is one extra stored boolean and a second half of the same stylesheet.

If a reviewer asks why the update needs no new permissions, that is the answer.

## Justifications

**Single purpose.** Provide a windowed-fullscreen viewing mode for YouTube videos — the player fills the browser window without entering true fullscreen, so the taskbar remains visible — including how the page content around the player is arranged while that mode is active.

**`storage`.** Stores two booleans per supported site — the optional "auto-apply" setting and the "Scrollable mode" setting — in `chrome.storage.local`. No personal data, and nothing is transmitted. `chrome.storage.sync` is deliberately unused, so settings never leave the device.

**Host permission (`*://*.youtube.com/*`).** Needed to (a) inject the windowed-fullscreen and side-panel buttons next to YouTube's native fullscreen control, (b) apply the CSS that expands the player and positions the panel beside it, and (c) read the active tab's URL so the toolbar popup can report whether the page is supported.

**Why the content script matches all of `youtube.com`, not just `/watch`.** YouTube is a single-page app: navigating from the home page or search results to a video never triggers a document load. The script must already be present on those pages to detect the client-side navigation and inject the button. It does nothing until a video player exists.

**Remote code.** None. All logic is bundled in the package.

**Data usage.** No data collected; nothing sent off device; nothing shared with third parties; no third-party SDKs.

**Privacy policy.** <https://rohittiger.vercel.app/product/windowedfullscreen/privacy>

## Trademark attribution

The listing describes the extension as working with YouTube, a Google trademark, so the [branding guidelines](https://developer.chrome.com/docs/webstore/branding) ask for an attribution in the description:

```
YouTube is a trademark of Google LLC. Use of this trademark is subject to Google Permissions.
```

The same guidelines forbid using a Google trademark, or a modified version of one, as the extension's logo without written permission. The store icon and promo tiles must contain no YouTube play button, no Chrome logo, and no lookalike of either. Microsoft's Windows logo, taskbar shell, and Explorer folder icon are out for the same reason — which is why the mark depicts a bare window rather than a real browser or desktop. See `marketing/README.md` for the mark that replaces them.

## Screenshots

All five were rebuilt for 1.2.0 from a fresh set of captures, so every feature the description claims is now visible in the listing. Upload them in order; `marketing/README.md` maps each file to its dashboard slot.

| Slot | Shows |
| --- | --- |
| `01-hero` | The promise: video fills the window, tab strip and taskbar still there. |
| `02-button` | The two injected buttons, magnified, named alongside YouTube's own fullscreen. |
| `03-panel` | The side panel docked beside the player, with the button that opens it. |
| `04-modes` | Cover vs scrollable side by side, plus the masthead reveal. |
| `05-controls` | The popup, the shortcut, and the privacy position. |

The store caps screenshots at five and `marketing/verify.mjs` enforces exactly that, so anything new has to displace one of these.

## Description

```
Native fullscreen traps you. The video takes over your display, and the moment
you need a tab, a message, or the clock, you have to drop out of it.

Windowed Fullscreen adds a second viewing mode right next to YouTube's own
fullscreen button. The player expands to fill your entire browser window — the
whole screen, once the window is maximized — but it never calls the browser's
Fullscreen API. Nothing gets hidden.

So your tab strip, address bar, taskbar, clock, and notifications all stay
exactly where they are. Click across to another tab, deal with whatever came
up, click back — the video is still right where you left it. No exiting, no
re-entering, no losing your place.

HOW TO USE IT
• Click the windowed-fullscreen button beside YouTube's fullscreen control
• Or use the toolbar popup
• Or press Alt+Shift+F (rebindable at chrome://extensions/shortcuts)
• Press Escape to exit — the page is restored exactly as it was

COMMENTS AND DESCRIPTION, BESIDE THE VIDEO
A second button docks everything from below the video — channel, subscribe,
likes, description, comments — into a column beside the player. Beside, not on
top: the panel takes its width from the video instead of covering it, so the
player controls stay reachable and nothing sits behind an overlay.

It is the real YouTube page, only repositioned, so liking, subscribing, sorting
comments, and loading more comments all keep working. Press the button again to
close it.

THE MASTHEAD IS HIDDEN, NOT GONE
Move your cursor to the top edge of the window and the search bar, hamburger
menu, and notifications slide back in. Move away and they slide out again. Look
up the next video without ever leaving the mode.

TWO MODES, PICK ONE PER SITE
• Cover (default) — the player owns the window and the page cannot scroll.
  Just the video, nothing else reachable.
• Scrollable — the video still fills the screen when you enter, but the page
  keeps scrolling. Scroll down for the title, description, and comments; scroll
  back up and the video fills the screen again.

ESCAPE WORKS ONE LAYER AT A TIME
Escape closes the side panel first, then leaves the mode, restoring the page to
exactly the state it was in before you entered.

IT NEVER FIGHTS YOUTUBE'S OWN FULLSCREEN
Press YouTube's fullscreen button while the mode is on and you get plain,
untouched YouTube fullscreen. Leave fullscreen and the mode comes back, with the
side panel as you left it. Each button always does its own job.

ALSO
• Optional per-site auto-apply: enter the mode automatically when a video loads
• Stays active as you move between videos, no reload needed
• Supports YouTube

PRIVACY
No accounts. No tracking. No analytics. No network requests of any kind.
The only things stored are your two per-site settings, saved locally on your
device and never synced or transmitted.

YouTube is a trademark of Google LLC. Use of this trademark is subject to
Google Permissions.
```

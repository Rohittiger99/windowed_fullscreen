# Chrome Web Store listing

Copy-paste answers for the Developer Dashboard. Asset files live in `marketing/out/`; `marketing/README.md` maps each one to its dashboard slot.

## Justifications

**Single purpose.** Provide a windowed-fullscreen viewing mode for YouTube videos — the player fills the browser window without entering true fullscreen, so the taskbar remains visible.

**`storage`.** Stores one boolean per supported site (the optional "auto-apply" setting) in `chrome.storage.local`. No personal data, and nothing is transmitted.

**Host permission (`*://*.youtube.com/*`).** Needed to (a) inject the windowed-fullscreen button next to YouTube's native fullscreen control, (b) apply the CSS that expands the player, and (c) read the active tab's URL so the toolbar popup can report whether the page is supported.

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

ALSO
• Optional per-site auto-apply: enter the mode automatically when a video loads
• Stays active as you move between videos, no reload needed
• Supports YouTube

PRIVACY
No accounts. No tracking. No analytics. No network requests of any kind.
The only thing stored is your auto-apply setting, saved locally on your device
and never synced or transmitted.

YouTube is a trademark of Google LLC. Use of this trademark is subject to
Google Permissions.
```

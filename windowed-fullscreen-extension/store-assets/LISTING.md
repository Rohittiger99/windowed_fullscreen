# Chrome Web Store listing

Copy-paste answers for the Developer Dashboard. Asset files live in `marketing/out/`; `marketing/README.md` maps each one to its dashboard slot.

## Submission state

Preparing: **2.0.0**. The zip is written by `npm run package` to
`release/windowed-fullscreen-v2.0.0.zip`.

**1.3.0 is what is live on the store.** See `CHANGELOG.md` for the full diff — it is a
large one, because a 1.4.0 was built and never published, so its work is part of this
release too.

Two things must be true before submitting, and neither is automatic:

- The build must point at the provider's **live** licence host. `scripts/package.mjs`
  refuses otherwise, so the zip cannot be produced from a test build — but check
  `docs/release.md` for the sequence rather than discovering it at the last step.
- The **published privacy policy** must already describe the licence request. See the
  Privacy policy note below.

## Name and store search

**Store name: `Windowed Fullscreen for YouTube™`** (32 of the 75 characters a manifest `name` allows). The store listing takes its title from `manifest.json`, not from the dashboard, so the name ships in the package.

Why the trademark is in the title at all: "YouTube" is the term someone looking for this actually types, and the store weights the name heavily in its own search. A title of just "Windowed Fullscreen" competes for a phrase nobody searches, and says nothing about what it works with.

Why it is safe to put there: the [branding guidelines](https://developer.chrome.com/docs/webstore/branding) forbid a Google trademark **as** the name, and separately permit referring to a compatible Google product with "for", "for use with", or "compatible with" plus the ™ symbol — their own worked example is the extension title "Highlight local shops for Google Maps™". So the brand stays first and "for YouTube™" reads as a compatibility statement. The attribution line the same page asks for is already the last line of the description below, and it is now required rather than merely polite, because the mark is in the title.

Note the tension, so nobody is surprised by it: the [YouTube API Services branding guidelines](https://developers.google.com/youtube/branding_guidelines) say never to put "YouTube" or "YT" in an app's name. Those bind YouTube **API clients** — anything using the Data API or the IFrame Player API under the YouTube API ToS. This extension uses neither; it is a content script on a page the user already opened, with no YouTube API key and no call to any YouTube endpoint. Since 2.0.0 it makes one network request of its own — a licence check against the payment provider's public API — which touches nothing of Google's and does not make it an API client. The Chrome Web Store guidelines are what govern the listing. If a reviewer disagrees anyway, the fallback costs nothing: rename to plain `Windowed Fullscreen` and leave "for YouTube" in the description, where descriptive use is not in question.

What not to do: no keyword stuffing in the title. There is room for another 43 characters and the temptation is a tail like "— Full Window Video, Theater Mode, Multitask". Program policies treat keyword-spammed metadata as grounds for removal, and it reads like malware. Secondary terms belong in the 132-character summary and the first two lines of the description, which is where they are.

**Summary (the manifest `description`, 124 of 132 characters):**

```
Watch YouTube full-window without true fullscreen: tabs, taskbar and clock stay visible. Dock the comments beside the video.
```

It leads with the search phrase, names the mechanism that makes the product different, and spends its last clause on the side panel — the feature reviewers and users are least likely to guess from the name.

The in-product wordmark stays **Windowed Fullscreen** — popup, welcome page, toolbar tooltip, brand mark. "for YouTube™" is a descriptor for the store, not part of the logo, and the guidelines specifically want trademark references kept smaller than the mark itself.

## What 2.0.0 contains, and why the permissions did not grow

This release is large — a paid tier, three dock columns, five injected controls, frame
capture, letterbox styling and ambient glow — and it asks for **exactly the same
permissions as 1.3.0**: `storage` and `*://*.youtube.com/*`. That is unusual enough for a
release this size that it is worth stating for the reviewer, with the mechanism for each:

- **The three dock columns** — comments, live chat, and the transcript — reposition
  YouTube's own elements with CSS. No `chrome.sidePanel`, no `scripting`, no `tabs`, and no
  site DOM is moved: Polymer keeps owning every element, which is why likes, subscribe and
  comment pagination all keep working.
- **Live chat docking uses no code at all.** `#chat` carries a `collapsed` attribute while
  the reader has it shut, so one CSS selector is the whole feature. Pressing YouTube's own
  chat toggle is all it takes.
- **The masthead reveal** tracks cursor proximity in JS and toggles a class. No new host
  access, and no pointer-event-catching overlay.
- **Scrollable mode** is one stored boolean and a second half of the same stylesheet.
- **Frame capture** draws the already-playing `<video>` onto a canvas and writes the result
  to the user's downloads or clipboard. Nothing is uploaded, and it needs no `downloads`
  permission: the file is written through a detached `<a download>`.
- **Ambient glow** samples that same canvas a few times a second and paints a blurred layer
  behind the video. Entirely local, entirely on the GPU.
- **The licence check** is the one network request, and it needs no host permission at all.
  See the note below.
- **The settings live in the toolbar popup**, and `options_ui` points at the same file, so
  there is no separate options page to account for.

If a reviewer asks why so little is requested for this much behaviour, that is the answer.

## Justifications

**Single purpose.** Provide a windowed-fullscreen viewing mode for YouTube videos — the player fills the browser window without entering true fullscreen, so the taskbar remains visible — including how the page content around the player is arranged while that mode is active.

**`storage`.** Stores the per-supported-site settings — "auto-apply", "Scrollable mode", the three dock widths, the letterbox colour, the ambient glow switch, the idle-cursor switch, and the frame-capture options — plus the user's licence key and the provider's activation id for this device, if they have bought Pro, in `chrome.storage.local`. It also holds the local-only bookkeeping behind the rating row: a star count, prompt show counts, a usage counter and the install timestamp. No personal data beyond the key the user typed themselves, and nothing is transmitted except that key and the activation id, to the licence check described below. `chrome.storage.sync` is deliberately unused, so settings never leave the device.

**Host permission (`*://*.youtube.com/*`).** Needed to (a) inject five controls next to YouTube's native fullscreen control — windowed mode, the comment panel, copy link at the current timestamp, the transcript dock, and frame capture, (b) apply the CSS that expands the player and positions the dock columns beside it, (c) read the already-playing video into a canvas so a frame can be saved locally and so the ambient glow can sample its edge colours, and (d) read the active tab's URL so the toolbar popup can report whether the page is supported.

**No new permission for the licence check.** Dodo Payments' licence endpoints are public — no API key — and they send CORS headers, so no `host_permissions` entry is needed for them and this update carries no new permission warning. That was verified against the live host before the design was settled, not assumed: a preflight from a `chrome-extension://` origin returns 200 with the origin reflected in `Access-Control-Allow-Origin`. If a reviewer asks why an extension makes a cross-origin request with no host permission, that is the answer.

**Why the content script matches all of `youtube.com`, not just `/watch`.** YouTube is a single-page app: navigating from the home page or search results to a video never triggers a document load. The script must already be present on those pages to detect the client-side navigation and inject the button. It does nothing until a video player exists.

**Remote code.** None. All logic is bundled in the package. The licence check exchanges JSON with the payment provider's API; no code is fetched or executed from it.

**Data usage — read this before answering the dashboard's questions.** This changed in 2.0.0 and the answers given for 1.3.0 are no longer true. Up to 1.3.0 the extension made no network requests at all; it now makes one, and only for a user who has entered a licence key.

Answer the Data Practices form as follows:

| Dashboard question | Answer | Why |
| --- | --- | --- |
| Personally identifiable information | **No** | No name, address, email, age, or identifier of ours. A licence key identifies a purchase, not a person, and the extension never sees who bought it. |
| Health information | No | — |
| Financial and payment information | **No** | The purchase happens on the payment provider's own checkout; the extension never sees a card, a transaction, or a price paid. It holds a key the provider issued afterwards. |
| Authentication information | **No** | There is no account and no login. Read the question narrowly and honestly: a licence key is a purchase token, not a credential to any account of ours — there is nothing to log in to. If a reviewer disagrees, the answer to change is this one, and the honest fallback is "yes", with the same disclosure text. |
| Personal communications | No | — |
| Location | No | — |
| Web history | **No** | The extension reads the active tab's URL to decide whether it is a supported page. Nothing is recorded and nothing is sent — the licence request carries the key and the activation id, and nothing else. |
| User activity | No | No clicks, mouse position, or usage recorded off device. The usage counter behind the rating prompt is local and never transmitted. |
| Website content | No | The captured frame is drawn from the video already playing and written to the user's own downloads or clipboard. It is never uploaded. |

Certifications, all three of which remain true:

- Not being sold to third parties.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending purposes.

**The requests, stated plainly for the reviewer.** All three go to `https://live.dodopayments.com`, the payment provider's own public licence API. There is no server on the developer's side.

| When | Call | Body | Response |
| --- | --- | --- | --- |
| The user enters a key | `POST /licenses/activate` | `{"license_key": "...", "name": "Windowed Fullscreen (browser)"}` | an activation id |
| Roughly every 14 days | `POST /licenses/validate` | `{"license_key": "...", "license_key_instance_id": "..."}` | `{"valid": true\|false}` |
| The user presses Remove key | `POST /licenses/deactivate` | `{"license_key": "...", "license_key_instance_id": "..."}` | 200 |

Two things a reviewer may reasonably ask about:

- **`name` is a fixed string, identical on every install.** It is not a device fingerprint, and nothing derived from the machine is sent. The activation exists so one purchase can cover a limited number of devices; the user frees a device with Remove key.
- **The activation response contains the buyer's name and email**, because the provider returns the customer record. The extension reads the activation id out of it and discards the rest — it is never stored, logged, or transmitted onward. This is a value received and dropped, not data collected.

A user who has not bought Pro makes no network requests at all.

**Privacy policy.** <https://rohittiger.vercel.app/product/windowedfullscreen/privacy>

**Check this page before submitting, and treat it as a release blocker.** It was written
when the extension made no network requests of any kind. If it still says that, it
contradicts this release, and shipping a build that sends something the published policy
says it does not is a worse problem than the paywall itself.

What the policy has to say, at minimum: that a user who enters a licence key has that key
and an activation id sent to Dodo Payments to verify it, on entry and roughly every 14 days
after; that nothing else is sent; that there is no server on the developer's side; and that
a user without a key triggers no requests at all.

This paragraph, the `README.md` privacy section, the description below, the dashboard's
Data Practices answers, and that published page all have to agree. They are five copies of
one promise.

## Trademark attribution

The title and the description both name YouTube, a Google trademark, so the [branding guidelines](https://developer.chrome.com/docs/webstore/branding) require this attribution in the description. It is the last line of the copy below — do not drop it while editing. The ™ symbol belongs in the title, not in the attribution: the attribution text already says the mark is Google's.

```
YouTube is a trademark of Google LLC. Use of this trademark is subject to Google Permissions.
```

The same guidelines forbid using a Google trademark, or a modified version of one, as the extension's logo without written permission. The store icon and promo tiles must contain no YouTube play button, no Chrome logo, and no lookalike of either. Microsoft's Windows logo, taskbar shell, and Explorer folder icon are out for the same reason — which is why the mark depicts a bare window rather than a real browser or desktop. See `marketing/README.md` for the mark that replaces them.

## Screenshots

Upload them in order; `marketing/README.md` maps each file to its dashboard slot.

| Slot | Shows |
| --- | --- |
| `01-hero` | The promise: video fills the window, tab strip and taskbar still there. |
| `02-button` | The injected controls, magnified, named alongside YouTube's own fullscreen. |
| `03-panel` | The side panel docked beside the player, with the button that opens it. |
| `04-modes` | Cover vs scrollable side by side, plus the masthead reveal. |
| `05-controls` | The popup, the shortcut, and the privacy position. |

The store caps screenshots at five and `marketing/verify.mjs` enforces exactly that, so
anything new has to displace one of these.

**Outstanding for 2.0.0.** Re-rendering needs a browser, so this is a manual step before
submission rather than something the build does. What each one has to show now:

- `02-button` — **five** injected controls, not two. In player-bar order: capture, copy
  link, transcript, windowed mode, comment panel. This count has been wrong in this file
  twice; check it against `BUTTON_ROLES` in the source rather than against the last
  screenshot.
- `03-panel` — a drag grip on the dock's inboard edge, since resizing is a headline paid
  feature.
- `04-modes` — worth showing more than one dock column, because three columns beside the
  player is the biggest visible change in the release.
- `05-controls` — where Pro is bought and where a key is entered. The listing names a price,
  so a reviewer will look for it. The popup's Pro view is the surface to capture; there is
  no options page any more.

Run `npm run store:assets` after re-capturing. **Do not ship a listing that claims a paid
tier alongside screenshots that show no sign of one.**

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
untouched YouTube fullscreen. Leave it and you come straight back to windowed
mode, comments and all, exactly as you left it. Nothing to set up again.

LIVE CHAT DOCKS TOO
On a livestream, chat docks beside the player the same way, taking width from
the video rather than covering it. It follows YouTube's own chat toggle, so
there is nothing extra to switch on. The comments can stay docked alongside it.

ALSO FREE
• Copy the video's link at the exact moment you are watching, in one click
• The mouse cursor fades after a few seconds of stillness, and returns the
  instant you move
• Optional per-site auto-apply: enter the mode automatically when a video loads
• Stays active as you move between videos, no reload needed
• Supports YouTube

FREE, AND WHAT PRO ADDS
Everything above is free, and stays free. None of it has ever moved behind the
paywall, and none of it will.

Pro is $10 once (lifetime) — no subscription, no account, no login:
• Drag the comment, live chat, and transcript columns to any width you like
• Dock the interactive transcript into a column of its own
• Save the current frame at the video's original resolution, with no interface
  in the picture
• Name your saved frames with your own template
• Burn the exact playback time onto a saved frame
• Light the letterbox bars from the video's own colours, in real time
• Or set your own bar colour, or pick from six gradient themes
• Stamp the playback time onto a saved frame

One purchase covers several devices, and Remove key frees a device up again.
Backed by a 7-day money-back guarantee.

PRIVACY
No accounts. No logins. No tracking. No analytics. Nothing sold or shared.
Your settings are stored on your own device and never synced.

Saving a frame is entirely local: the image is drawn from the video already
playing in your browser and goes straight to your downloads or clipboard.

If you buy Pro, the licence key you enter is sent to the payment provider that
issued it, to confirm it — the key and nothing else, roughly once a fortnight.
There is no server on our side, so there is nowhere for us to keep anything.
Without a key, the extension makes no network requests at all.

YouTube is a trademark of Google LLC. Use of this trademark is subject to
Google Permissions.
```

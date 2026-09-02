# Pro tier and licensing

$10 once. No subscription, no account, no login. A licence key is the only credential.

All of it lives in §14 except the gates themselves, which live wherever the decision is
made. Read `release.md` before shipping — the test-to-live flip is a release step and
getting it wrong has no symptom on your own machine.

## The governing rule

**Nothing that was free has moved behind the paywall, and nothing ever will.**

The comment panel, both modes, the live-chat dock, the suggestions rail, per-site
auto-apply and copy-link-at-timestamp are free and stay free. That is what makes the tier
free of grandfathering code, and there must never be any.

Every paid feature is new work introduced with the tier. If you are ever tempted to gate
something that already shipped free, the answer is no.

## What is paid

Eight features, all new in 2.0.0:

1. **Dock resizing** — drag any of the three docks wider or narrower.
2. **Transcript dock** — the interactive transcript as its own docked column.
3. **Channel profiles** — per-channel rules carrying mode, panel state and dock widths.
4. **Frame capture** — save the current frame at the video's own resolution.
5. **Custom filename templates** — `{title}`, `{date}`, `{time}`, `{timestamp}`, `{site}`.
6. **Burned timestamp** — stamp the playback time onto a captured frame.
7. **Ambient glow** — letterbox bars lit from the video's own edge colours.
8. **Custom letterbox palettes** — five solid swatches, six gradient themes, plus a
   colour picker with hex input.

**The in-product list shows nine rows, and that is deliberate.**
`HELP_COPY.pro.features` splits channel automation into "Favorite channels" and "Channel
memory", because to a buyer those read as two things they get. It is one feature and one
gate. Do not "reconcile" the counts by merging the rows or by adding a ninth gate.

## What is deliberately NOT paid

**Live chat docking is free.** It has no control of its own by design — it docks off the
site's own `collapsed` attribute — so there is nowhere to attach an upsell without
inventing a button purely to lock it. It is also the strongest livestream hook for growth.

**Keyboard shortcuts are not a paid category.** The windowed and comment shortcuts are
free. The capture shortcut is Pro only because you cannot bind a shortcut to a feature you
do not own.

**Copy link at the current timestamp is free.** The mode hides
`.ytp-overlay-top-right`, where YouTube's own share control lives, so this repairs a loss
the mode causes. Charging for a repair is poor form.

**Idle cursor auto-hide is free**, and on by default. It costs almost nothing and makes
the free mode feel finished, which is what earns the install that later converts. It is not
in `SITE_TOGGLES` as `proGated` and there is no `isPro` check near it. If a document ever
lists it as Pro, the document is wrong.

## Where the gates are

**Ask `isPro(pro)` at the one place that decides. Never store a second copy of the
answer.** Entitlement arrives asynchronously and can be revoked, so a cached boolean is a
stale boolean. Every gate follows `watchProState`.

`SITE_TOGGLES` marks `ambientGlow`, `captureToClipboard` and `captureBurnTimestamp` as
`proGated`. The letterbox colour input and the filename template are registered through
`proGatedControls` instead, because they are not checkboxes.

**The capture button is shown to free users** and opens a prompt naming the price. It is
the only paid feature a set-and-forget reader meets without going looking, so it is the
whole funnel. Every other paid surface — the drag grips, the rules list — is absent
without a licence, because it is reachable only by someone already exploring.

**A Pro badge has to be removable, not just paintable.** The padlock beside a Pro-gated
setting was appended once while the row was built, so it survived the entitlement
arriving: the checkbox unlocked and the icon beside it still said locked. The badge is
registered in `proGatedControls` with its checkbox and cleared by `applyProGateToToggles`,
which is the only place the gate is applied. Any new locked affordance goes through that
function — whatever it turns off, it must be able to turn back on.

**Do not add a suggested key for the capture command.** It has none on purpose. Chrome
lists every manifest command at `chrome://extensions/shortcuts` whatever the reader's tier,
so a default binding would take a key combination away from every free install for a
feature they do not have. The command is still relayed for a free reader rather than
declined in the worker — a key that does nothing at all reads as broken, so the page shows
the Pro prompt instead.

**The capture blank check is not a claim about why.** Protected playback yields either a
canvas that throws on read or a frame of pure black, and a video that has genuinely faded
to black is indistinguishable from both. `captureVideoFrame` returns `blank` for all three
and the message names the likely cause without asserting it. Do not "improve" this into
"this video is protected": telling someone their unprotected video is protected is worse
than being vague.

## Entitlement: fail open on re-validation, never on activation

**The line is 4xx versus everything else.**

A 4xx means the provider read the request and said no, and that is the only thing that
revokes. A 5xx, a timeout, no network, a refused connection, or a body in an unexpected
shape all come back as `unreachable`, which leaves an already-entitled reader entitled — a
paying reader losing features on a flaky connection is worse than a pirate getting a free
fortnight.

**Fail-open never *grants*.** An install that has never had a definite answer is not Pro,
whatever the network did.

`dodoPost` owns the status split so it is not re-derived per call, and `applyValidation` is
a reducer over the previous record rather than a mapping from an outcome, precisely so that
asymmetry has somewhere to live.

**The boundary was measured, not assumed.** Against the live host: `activate` with a wrong
key answers **404**, `validate` answers **200 `{"valid":false}`**, and `deactivate` with a
wrong instance answers **403**. If any of those ever moves into the 5xx range, a wrong key
starts being tolerated instead of reported.

Revalidation runs on worker start rather than on a timer: an MV3 worker is terminated
whenever the browser feels like it, so there is nothing durable to schedule against, and
the worker starts often enough that a 14-day interval is met comfortably. `proCheckDue`
carries the retry bound.

## Privacy

**One thing leaves the device, and it is the licence key.**

No `chrome.storage.sync` — sync would replicate settings through the user's browser
account. No analytics. No telemetry. **No network request of any kind for a reader without
a licence key.**

The single exception: a reader who has entered a key has that key, plus the provider's
activation id for this device, sent to Dodo Payments' own public licence API — on entry,
roughly every 14 days after, and once more on removal. Nothing else: no account, no
identifier of ours, no page, no video, no history, and no device fingerprint. The
activation registers under `DODO_INSTANCE_NAME`, a fixed string identical on every install,
so two installs look the same in the provider's dashboard.

Frame capture is entirely local. **There is no server on our side at all**, so there is
nowhere for anything to accumulate.

**Widening this is not a free edit.** The same promise is published in `README.md`,
`store-assets/LISTING.md`, the store listing, the store's data-disclosure answers, and the
privacy policy at `rohittiger.vercel.app/product/windowedfullscreen/privacy`. Changing what
the extension sends means changing every one of those in the same commit. Submitting a
build that sends something the published policy says it does not is a worse problem than
any feature is worth.

**The activation response contains the buyer's name and email.** `activateLicence` reads
`id` out of it and drops the rest, at the point of receipt, so there is no place in the code
where the customer record sits in a variable something could persist by accident. Do not
widen that destructuring to "keep the customer for later" — there is no later.

## No server, and no proxy

Dodo's activate, validate and deactivate endpoints are public and send CORS headers —
measured against the live host, not assumed: a preflight from a `chrome-extension://`
origin returns 200 with the origin reflected in `Access-Control-Allow-Origin`.

So the extension calls them directly, needs no host permission, and an update carries no
new permission warning. **Do not add a host permission for the provider** — it is not
needed, and adding one would disable the extension for every existing user until they
accepted the new warning.

An earlier draft of 1.4.0 proxied these calls through a Vercel project of ours, on the
mistaken premise that they needed an API key. Once that was checked, the proxy's only
remaining benefit was changing provider without a release, which is not worth a service to
run. The `licence-api/` folder was deleted and should not come back without a reason this
note does not already answer.

The accepted cost: these URLs are in every shipped install, so leaving Dodo means a
release.

## Refusal messages

**A refused activation names two possible causes and does not pick one.** A wrong key and
a key already used on its maximum number of devices are both 4xx, and the provider's own
error prose is the only thing separating them. Branching on a third party's wording is how
a copy edit on their side becomes a silent unlock on ours.

Where the provider gives a *status code* rather than prose, the split is safe and is made:
404 and 403 separate two problems a reader acts on differently. The earlier single message
had a real cost — a key refused for the activation limit read as a key typed wrongly, so
the natural response was to paste it again, and every attempt consumed another activation.

## Activation happens in the page

The in-page Pro prompt carries its own licence field, its own `activateLicence` call and
its own refusal messages. A reader who already owns a key activates it without leaving the
video.

It used to send them to the options page's Pro panel instead, which needed the content
script to ask the service worker to open a tab — a content script cannot navigate to an
extension URL, and making the settings web-accessible would put them one link away from
every site on the internet. That whole route is gone, along with the worker's `onMessage`
listener. Worth keeping gone: an enumerated intent was safe, but the next person to add a
destination to it is one refactor away from a worker that opens whatever a page hands it.

Any write goes through `setProState`, so every watcher — the drag grips, the lock badges,
the popup's Pro view — follows it without knowing where it came from.

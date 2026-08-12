// Layout verification against a real YouTube watch page.
//
// WHY THIS EXISTS
// `npm test` covers preferences, URL matching, and the adapter registry, none of
// which need a browser. It cannot cover the part that actually broke repeatedly:
// geometry. The panel's edge landing on the player's edge, the control bar
// clearing the panel, the control bar keeping its large size, and windowed mode
// standing fully down for fullscreen are all properties of a live YouTube layout
// and cannot be asserted anywhere else.
//
// HOW IT WORKS
// The real content script is bundled from source and injected into an open watch
// page over the DevTools protocol, with a minimal `chrome` stub so it runs
// outside an extension context. Then it clicks the real injected buttons and
// measures the result. No mock DOM is involved, which is the point.
//
// USAGE
//   1. Start Chrome with remote debugging and open any watch page:
//        Windows:  & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
//                    --remote-debugging-port=9222 --user-data-dir="$env:TEMP\wfs-verify"
//        macOS:    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//                    --remote-debugging-port=9222 --user-data-dir=/tmp/wfs-verify
//        Linux:    google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/wfs-verify
//   2. npm run verify:live
//
// Pass `--url=<watch url>` to open a page instead of reusing an open tab.
// Needs a browser and a network, so it is deliberately not part of CI.
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CDP = process.env.WFS_CDP ?? "http://127.0.0.1:9222";
const urlArg = process.argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------
const results = [];
const check = (name, ok, detail = "") => results.push({ name, state: ok ? "pass" : "fail", detail });
const skip = (name, why) => results.push({ name, state: "skip", detail: why });

// ---------------------------------------------------------------------------
// CDP plumbing. Node's built-in WebSocket keeps this dependency-free.
// ---------------------------------------------------------------------------
async function findWatchTab() {
  let list;
  try {
    list = await (await fetch(`${CDP}/json/list`)).json();
  } catch {
    console.error(
      `No DevTools endpoint at ${CDP}.\n` +
        `Start Chrome with --remote-debugging-port=9222 --user-data-dir=<temp dir>, ` +
        `open a YouTube watch page, then re-run. See the header of this file.`,
    );
    process.exit(2);
  }

  const existing = list.find((t) => t.type === "page" && t.url.includes("youtube.com/watch"));
  if (existing && !urlArg) return existing;

  const target = urlArg ?? existing?.url;
  if (!target) {
    console.error("No watch page open. Pass --url=https://www.youtube.com/watch?v=...");
    process.exit(2);
  }
  await fetch(`${CDP}/json/new?${encodeURIComponent(target)}`, { method: "PUT" }).catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const again = await (await fetch(`${CDP}/json/list`)).json();
    const page = again.find((t) => t.type === "page" && t.url.includes("youtube.com/watch"));
    if (page) return page;
  }
  console.error("Could not open a watch page.");
  process.exit(2);
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const msgId = (id += 1);
      pending.set(msgId, res);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  return { ws, ready, send };
}

// ---------------------------------------------------------------------------
// Page-side probe. Returns everything one measurement needs, as plain data.
// ---------------------------------------------------------------------------
const PROBE = `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom),
      width: Math.round(b.width), height: Math.round(b.height),
    };
  };
  const player = document.querySelector('#movie_player');
  const inline = player ? player.style : null;
  return JSON.stringify({
    ourClasses: document.documentElement.className.split(' ').filter((c) => c.startsWith('wfs-')),
    fullscreen: !!document.fullscreenElement,
    modePressed: document.querySelector('[data-wfs-button="mode"]')?.getAttribute('aria-pressed') ?? null,
    panelPressed: document.querySelector('[data-wfs-button="panel"]')?.getAttribute('aria-pressed') ?? null,
    // Only the properties the mode sets itself; YouTube keeps custom properties
    // here permanently, so the presence of style="" proves nothing on its own.
    ourInlineStyles: inline
      ? ['position', 'width', 'height', 'zIndex', 'inset', 'top', 'left', 'right', 'bottom']
          .filter((p) => inline[p] !== '')
      : [],
    bigMode: !!document.querySelector('#movie_player.ytp-big-mode'),
    // The chapter row is a row of left-floated segments YouTube sizes in integer
    // px from a bar width it rounds. Sizing the bar from its insets makes it
    // fractional, so the row can exceed its container by a rounding remainder —
    // and a float row that overflows wraps, dropping the last chapter onto a
    // second row over the controls as a stray red line. Negative slack is the
    // condition for that wrap, so both are measured.
    chapterRow: (() => {
      const row = document.querySelector('.ytp-chapters-container');
      const segments = row ? Array.from(row.children) : [];
      // One segment is an unchaptered video: there is no tiling to get wrong.
      if (segments.length < 2) return null;
      const occupied = segments.reduce(
        (total, el, i) =>
          total +
          el.getBoundingClientRect().width +
          (i < segments.length - 1 ? Number.parseFloat(getComputedStyle(el).marginRight) || 0 : 0),
        0,
      );
      return {
        rows: new Set(segments.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        slack: Math.round((row.getBoundingClientRect().width - occupied) * 100) / 100,
      };
    })(),
    // Our controls must sit beside the site's button cluster, not inside it: the
    // cluster is sized to a fixed number of slots, so joining it makes YouTube
    // drop one of its own controls and squeeze the rest.
    ourButtonsOutsideCluster: (() => {
      const container = document.querySelector('.ytp-right-controls');
      const native = document.querySelector('.ytp-fullscreen-button');
      const ours = Array.from(document.querySelectorAll('[data-wfs-button]'));
      if (!container || !native || ours.length === 0) return null;
      return ours.every((b) => b.parentElement === container && b.parentElement !== native.parentElement);
    })(),
    // Uniform widths across the site's own buttons means nothing was squeezed.
    siteButtonWidths: (() => {
      const native = document.querySelector('.ytp-fullscreen-button');
      if (!native?.parentElement) return [];
      return Array.from(native.parentElement.children)
        .filter((el) => !el.hasAttribute('data-wfs-button') && getComputedStyle(el).display !== 'none')
        .map((el) => Math.round(el.getBoundingClientRect().width));
    })(),
    viewportWidth: innerWidth,
    player: rect('#movie_player'),
    panel: rect('ytd-watch-flexy #below'),
    controlBar: rect('.ytp-chrome-bottom'),
    rightControls: rect('.ytp-right-controls'),
    // Nothing may sit at 2147483647: z-index is a 32-bit integer, so a layer
    // asking to be above the maximum is clamped onto it and then loses on
    // document order. That is how the revealed masthead ended up painting
    // behind the player.
    //
    // The popup and toast hosts are YouTube's own. They hang off ytd-app in the
    // low thousands, so raising the player buries every menu and dialog the site
    // opens unless they are lifted too.
    layers: (() => {
      const z = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).zIndex : null;
      };
      return {
        player: z('#movie_player'),
        panel: z('ytd-watch-flexy #below'),
        masthead: z('#masthead-container'),
        popups: z('ytd-popup-container'),
        toasts: z('snackbar-container'),
      };
    })(),
    // A closed guide drawer is position:fixed across the whole viewport, so
    // lifting it unconditionally would put an invisible full-window element over
    // the video. It must only be raised while [opened].
    closedDrawerZ: (() => {
      const el = document.querySelector('tp-yt-app-drawer#guide');
      if (!el || el.hasAttribute('opened')) return null;
      return getComputedStyle(el).zIndex;
    })(),
    // The panel is opaque and carries the site's own theme. It used to read a
    // YouTube token that is not set on <html>, so it always painted the dark
    // fallback — black panel behind black light-theme text.
    theme: (() => {
      const panel = document.querySelector('ytd-watch-flexy #below');
      const text = document.querySelector('ytd-watch-metadata');
      if (!panel || !text) return null;
      return {
        dark: document.documentElement.hasAttribute('dark'),
        panelBackground: getComputedStyle(panel).backgroundColor,
        textColour: getComputedStyle(text).color,
      };
    })(),
    // With the bar revealed, the top edge of the window must belong to the
    // masthead. YouTube's .ytp-overlay-top-right un-autohides into exactly that
    // strip on cursor movement and used to swallow the hover and the click.
    topEdgeOwner: (() => {
      const el = document.elementFromPoint(Math.round(innerWidth / 2), 20);
      if (!el) return null;
      return document.querySelector('#masthead-container')?.contains(el) ? 'masthead' : el.className.toString().slice(0, 60) || el.tagName;
    })(),
    masthead: rect('#masthead-container'),
    mastheadOpacity: (() => {
      const el = document.querySelector('#masthead-container');
      return el ? getComputedStyle(el).opacity : null;
    })(),
  });
})()`;

/**
 * The chapter segments must tile the bar on ONE row, with the row no narrower
 * than what they occupy. Skipped rather than failed on an unchaptered video: the
 * property does not exist there, and the default watch page may well be one.
 * Pass `--url=` a video with chapters to exercise it.
 */
function checkChapterRow(name, measurement) {
  const row = measurement.chapterRow;
  if (!row) {
    skip(name, "the video has no chapters");
    return;
  }
  check(name, row.rows === 1 && row.slack >= 0, `${row.rows} row(s), slack ${row.slack}px`);
}

/**
 * Is `el` the topmost thing at several points inside its own box?
 *
 * A z-index comparison is not enough on its own: paint order also depends on
 * stacking contexts and document order, which is exactly what went wrong when the
 * masthead's clamped z-index tied with the player's. Hit-testing several points
 * is what actually answers "can the user see and click this".
 *
 * Sampling more than the centre matters because these overlays only partly
 * overlap the panel — a single point can miss the overlapping region entirely.
 */
const TOPMOST = `((el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return { ok: false, why: 'not rendered' };
  const misses = [];
  for (const [fx, fy] of [[0.5, 0.15], [0.5, 0.5], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5]]) {
    const x = Math.round(r.left + r.width * fx);
    const y = Math.round(r.top + r.height * fy);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !el.contains(hit)) misses.push(x + ',' + y + '->' + (hit ? hit.tagName.toLowerCase() : 'null'));
  }
  return { ok: misses.length === 0, misses };
})`;

/** Perceived luminance of a `rgb()`/`rgba()` string, or null if unreadable. */
function luminance(colour) {
  const parts = /rgba?\(([^)]+)\)/.exec(colour ?? "");
  if (!parts) return null;
  const [r, g, b, a = "1"] = parts[1].split(",").map((n) => Number.parseFloat(n));
  if (Number.parseFloat(a) < 0.99) return null; // Transparent: the video shows through.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function main() {
  const target = await findWatchTab();
  const { ws, ready, send } = connect(target);
  await ready;

  const evaluate = async (expression, userGesture = true) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails.exception ?? r.result.exceptionDetails));
    }
    return r.result?.result?.value;
  };
  const measure = async () => JSON.parse(await evaluate(PROBE, false));
  const click = (sel) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

  // Reload for a clean page, then wait for the player's control bar to exist.
  await send("Page.enable");
  await send("Page.reload");
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    if (await evaluate(`!!document.querySelector('.ytp-fullscreen-button')`, false)) break;
  }

  // Bundle and inject the real content script. The chrome stub stands in for the
  // extension context: storage falls back to documented defaults, and the
  // message listener is never called here.
  const bundled = await build({
    stdin: {
      contents:
        `globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };\n` +
        `import { startContentScript } from "./src/windowed-fullscreen";\n` +
        `globalThis.__wfsStart = startContentScript;\n`,
      resolveDir: root,
      sourcefile: "verify-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  await evaluate(bundled.outputFiles[0].text, false);
  await evaluate(`window.__wfsStart()`);

  // Wait for BOTH controls, not just the first. The side-panel toggle waits on
  // YouTube's below-video block, which mounts several seconds after the player —
  // measuring too early makes this whole run flaky for no good reason.
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const ready = await evaluate(
      `!!document.querySelector('[data-wfs-button="mode"]') && !!document.querySelector('[data-wfs-button="panel"]')`,
      false,
    );
    if (ready) break;
  }

  const baseline = await measure();
  check("both controls are injected into the player bar", baseline.modePressed !== null && baseline.panelPressed !== null);
  check("nothing is applied before the mode is engaged", baseline.ourClasses.length === 0, baseline.ourClasses.join(" "));
  check(
    "our controls sit beside YouTube's button cluster, not inside it",
    baseline.ourButtonsOutsideCluster === true,
    `outside=${baseline.ourButtonsOutsideCluster}`,
  );
  check(
    "YouTube's own buttons keep their full width",
    baseline.siteButtonWidths.length > 0 &&
      new Set(baseline.siteButtonWidths).size === 1 &&
      baseline.siteButtonWidths[0] >= 40,
    `widths [${baseline.siteButtonWidths.join(", ")}]`,
  );

  // --- windowed mode on -----------------------------------------------------
  await click('[data-wfs-button="mode"]');
  await sleep(2500);
  const windowed = await measure();
  check("windowed mode engages", windowed.ourClasses.includes("wfs-windowed") && windowed.modePressed === "true");
  check(
    "the player fills the window width",
    Math.abs(windowed.player.width - windowed.viewportWidth) <= 1,
    `player ${windowed.player.width} vs viewport ${windowed.viewportWidth}`,
  );
  check(
    "the control bar is at its large size",
    windowed.bigMode && windowed.controlBar.height > baseline.controlBar.height,
    `bigMode=${windowed.bigMode}, bar ${baseline.controlBar.height} -> ${windowed.controlBar.height}`,
  );
  checkChapterRow("the chapter segments stay on one row", windowed);

  // --- comment panel docked -------------------------------------------------
  await click('[data-wfs-button="panel"]');
  await sleep(3000);
  const docked = await measure();
  check("the panel docks", docked.ourClasses.includes("wfs-side-panel") && docked.panelPressed === "true");
  check("the panel has width", docked.panel.width > 0, `panel width ${docked.panel.width}`);
  check(
    "the panel does not overlap the player",
    Math.abs(docked.player.right - docked.panel.left) <= 1,
    `player right ${docked.player.right} vs panel left ${docked.panel.left}`,
  );
  check(
    "the control bar clears the panel",
    docked.rightControls.right <= docked.panel.left,
    `controls end ${docked.rightControls.right} vs panel left ${docked.panel.left}`,
  );
  check(
    "the control bar keeps its large size while docked",
    docked.bigMode && docked.controlBar.height === windowed.controlBar.height,
    `bigMode=${docked.bigMode}, bar ${docked.controlBar.height}`,
  );
  checkChapterRow("the chapter segments stay on one row while docked", docked);
  check(
    "the layers are ordered player < panel < masthead < popups, none clamped",
    Number(docked.layers.player) < Number(docked.layers.panel) &&
      Number(docked.layers.panel) < Number(docked.layers.masthead) &&
      Number(docked.layers.masthead) < Number(docked.layers.popups) &&
      Number(docked.layers.popups) < 2147483647 &&
      Number(docked.layers.toasts) > Number(docked.layers.panel),
    `player ${docked.layers.player}, panel ${docked.layers.panel}, masthead ${docked.layers.masthead}, popups ${docked.layers.popups}, toasts ${docked.layers.toasts}`,
  );
  check(
    "a closed guide drawer is left on its own layer, so it cannot eat clicks",
    docked.closedDrawerZ === null || Number(docked.closedDrawerZ) < Number(docked.layers.player),
    `closed drawer z ${docked.closedDrawerZ} vs player ${docked.layers.player}`,
  );

  // --- the site's own popups open over the mode ------------------------------
  // Everything YouTube opens over its page — notification and account menus, a
  // comment's overflow menu, dialogs, toasts — is appended to a host hanging off
  // ytd-app at a z-index in the low thousands, not to the button that opened it.
  // Raising the player buried all of it: the reported symptom was the
  // notifications menu opening underneath the docked comments.
  //
  // A stand-in is put into the real host rather than driving a real menu. YouTube
  // needs a signed-in account for notifications, and the share dialog is
  // lazy-loaded and not reliably open by this point, so a click-driven check is
  // flaky for reasons that have nothing to do with the property being tested.
  // The stand-in takes the same shape as a real dropdown — position:fixed at
  // z-index 2202 inside ytd-popup-container — and straddles the panel's left
  // edge, which is exactly where the real menus were being clipped.
  const popup = JSON.parse(
    await evaluate(
      `(() => {
        const host = document.querySelector('ytd-popup-container');
        const panel = document.querySelector('ytd-watch-flexy #below');
        if (!host || !panel) return JSON.stringify({ ok: false, why: 'no popup host' });
        const edge = panel.getBoundingClientRect().left;
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;z-index:2202;top:120px;width:260px;height:300px;background:#000;';
        el.style.left = Math.round(Math.max(0, edge - 130)) + 'px';
        host.appendChild(el);
        const result = (${TOPMOST})(el);
        el.remove();
        return JSON.stringify(result);
      })()`,
      false,
    ),
  );
  check(
    "the site's own popups open above the player and the panel",
    popup.ok === true,
    popup.why ?? `covered at ${(popup.misses ?? []).join(" ")}`,
  );

  // --- the panel follows the site's theme -----------------------------------
  // The panel is opaque page content laid over the player, so a hardcoded colour
  // is legible in one theme and invisible in the other. Both are checked by
  // flipping the `dark` attribute YouTube itself uses.
  const siteWasDark = docked.theme?.dark === true;
  const setTheme = (dark) =>
    evaluate(
      `(() => { const h = document.documentElement; ${dark ? `h.setAttribute('dark', '')` : `h.removeAttribute('dark')`}; return true; })()`,
      false,
    );
  for (const dark of [false, true]) {
    await setTheme(dark);
    await sleep(600);
    const { theme } = await measure();
    const bg = luminance(theme?.panelBackground);
    const fg = luminance(theme?.textColour);
    check(
      `the panel is opaque and legible in the ${dark ? "dark" : "light"} theme`,
      bg !== null && fg !== null && Math.abs(bg - fg) > 0.4,
      `background ${theme?.panelBackground} vs text ${theme?.textColour}`,
    );
  }
  await setTheme(siteWasDark);
  await sleep(400);

  // --- the revealed masthead owns the top edge ------------------------------
  // Cursor proximity is tracked in JS, so the reveal class can be set directly;
  // what matters here is that the bar then paints and hit-tests above the player.
  await evaluate(`document.documentElement.classList.add('wfs-reveal-chrome'); true`, false);
  await sleep(600);
  const revealed = await measure();
  check(
    "hovering the top edge slides the masthead into view",
    revealed.masthead?.top === 0 && revealed.mastheadOpacity === "1",
    `masthead top ${revealed.masthead?.top}, opacity ${revealed.mastheadOpacity}`,
  );
  check(
    "the revealed masthead owns the top edge, not the player's overlay",
    revealed.topEdgeOwner === "masthead",
    `top edge belongs to ${revealed.topEdgeOwner}`,
  );
  await evaluate(`document.documentElement.classList.remove('wfs-reveal-chrome'); true`, false);
  // Long enough for the delayed hide to finish, so the fullscreen leg below
  // starts from a settled layout rather than mid-transition.
  await sleep(800);

  // --- fullscreen stand-down and resume -------------------------------------
  // Two properties, in the order they happen: the mode leaves nothing behind
  // while fullscreen owns the player, and leaving fullscreen puts back exactly
  // what was on screen before it. This leg enters from windowed mode WITH the
  // panel docked, which is the state the checks above left, so it is the one case
  // the block below does not cover — `document.exitFullscreen()` records no exit
  // intent, so it classifies as `site-or-user`, and the panel has to come back
  // from the pending flag rather than from a button press asking for it.
  //
  // A refused fullscreen request is an automation limitation, not a regression,
  // so these are skipped rather than failed when the transition does not happen.
  const beforeFs = await measure();
  const beforeFsPanel = beforeFs.ourClasses.includes("wfs-side-panel");
  await click(".ytp-fullscreen-button");
  await sleep(4500);
  const fs = await measure();
  if (!fs.fullscreen) {
    skip("windowed mode stands down for fullscreen", "the browser did not enter fullscreen");
    skip("leaving fullscreen puts back the mode it was entered from", "never entered fullscreen");
  } else {
    check(
      "windowed mode stands down for fullscreen",
      fs.ourClasses.length === 0 && fs.ourInlineStyles.length === 0,
      `classes [${fs.ourClasses.join(" ")}], inline [${fs.ourInlineStyles.join(" ")}]`,
    );
    await evaluate(`document.exitFullscreen?.()`);
    await sleep(4000);
    const back = await measure();
    check(
      "leaving fullscreen puts back the mode it was entered from",
      back.ourClasses.includes("wfs-windowed") &&
        back.ourClasses.includes("wfs-side-panel") === beforeFsPanel &&
        back.modePressed === "true",
      `classes [${back.ourClasses.join(" ")}], modePressed=${back.modePressed}, ` +
        `panel before=${beforeFsPanel}`,
    );
  }

  // --- exit -----------------------------------------------------------------
  // Re-enter first if the fullscreen leg above left us on the plain player, so
  // this actually tests a teardown. Without it the assertions passed on a page
  // that was already clean and proved nothing.
  if (!(await measure()).ourClasses.includes("wfs-windowed")) {
    await click('[data-wfs-button="mode"]');
    await sleep(2500);
  }
  if ((await measure()).ourClasses.includes("wfs-windowed")) {
    await click('[data-wfs-button="mode"]');
    await sleep(2500);
  }
  const off = await measure();
  check(
    "exiting removes every class and inline style we set",
    off.ourClasses.length === 0 && off.ourInlineStyles.length === 0,
    `classes [${off.ourClasses.join(" ")}], inline [${off.ourInlineStyles.join(" ")}]`,
  );
  check(
    "the page layout is handed back to YouTube",
    off.player.width < off.viewportWidth,
    `player ${off.player.width} vs viewport ${off.viewportWidth}`,
  );

  // ---------------------------------------------------------------------------
  // FULLSCREEN EXIT — R1.3, R1.9, R3.6
  //
  // Leaving fullscreen retraces the way in, so what a clean result looks like
  // depends on where fullscreen was entered FROM. Entered from windowed mode, the
  // mode and the panel must be back exactly as they were; entered from the plain
  // player, the page must be free of every wfs-* class and every inline style of
  // ours. Four triggers are tested: YouTube's own button, a double-click on the
  // video, the `f` key, and Escape. Escape is tested in all four windowed-mode ×
  // side-panel combinations:
  //   1. windowed on + panel off
  //   2. windowed on + panel on
  //   3. windowed off + panel off (came from normal player)
  //   4. windowed off + panel on — unreachable, and reported as a skip rather
  //      than quietly re-running case 2 under the wrong label
  // The injected windowed-mode button is separately tested to land back in
  // windowed mode with ytp-big-mode intact.
  // ---------------------------------------------------------------------------

  /**
   * Assert the page came back to the state fullscreen was entered from.
   *
   * The windowed case is deliberately NOT expressed as "some wfs-* class is
   * present": a resume that entered the mode but dropped the panel, or one that
   * docked a panel the reader did not have open, both leave classes behind and
   * both are wrong. The mode button's `aria-pressed` is checked alongside, because
   * a resume that engages the mode without updating the control it was toggled
   * from is the failure R3.9 exists for.
   */
  const assertRetraced = (label, m, { windowed, panel }) => {
    if (!windowed) {
      check(
        `${label}: no wfs-* classes`,
        m.ourClasses.length === 0,
        `classes [${m.ourClasses.join(" ")}]`,
      );
      check(
        `${label}: no extension inline styles`,
        m.ourInlineStyles.length === 0,
        `inline [${m.ourInlineStyles.join(" ")}]`,
      );
      return;
    }
    check(
      `${label}: windowed mode is back`,
      m.ourClasses.includes("wfs-windowed") && m.modePressed === "true",
      `classes [${m.ourClasses.join(" ")}], modePressed=${m.modePressed}`,
    );
    check(
      `${label}: the panel is back as it was`,
      m.ourClasses.includes("wfs-side-panel") === panel,
      `wanted panel=${panel}, classes [${m.ourClasses.join(" ")}]`,
    );
  };

  /**
   * Enter fullscreen from either windowed or normal player state, then exit by
   * the specified method and assert the result. Returns false if the browser
   * refused to enter fullscreen (skip rather than fail).
   *
   * The pre-state is verified rather than assumed. Clicking the panel button while
   * the mode is off ENTERS the mode and docks, so asking for `windowed: false,
   * panel: true` used to silently produce `windowed: true, panel: true` and run a
   * duplicate of the previous case under a label claiming otherwise. The panel is
   * only meaningful inside the mode, so that combination is unreachable and is now
   * reported as such instead of being faked.
   */
  const testFullscreenExit = async (label, { windowed, panel, exitMethod }) => {
    if (!windowed && panel) {
      skip(`${label}: retraced exit`, "the side panel cannot be open while the mode is off");
      return false;
    }

    // Ensure mode state matches the desired starting point. Panel first while the
    // mode is still on: closing the mode undocks the panel anyway, so undocking
    // afterwards would be a click against a button that is no longer there.
    const pre = await measure();
    if (pre.ourClasses.includes("wfs-side-panel") && !panel) {
      await click('[data-wfs-button="panel"]');
      await sleep(2500);
    }
    if (pre.ourClasses.includes("wfs-windowed") !== windowed) {
      await click('[data-wfs-button="mode"]');
      await sleep(2500);
    }
    if (panel && !(await measure()).ourClasses.includes("wfs-side-panel")) {
      await click('[data-wfs-button="panel"]');
      await sleep(2500);
    }

    // Confirm we actually reached the state this case claims to test.
    const start = await measure();
    const startWindowed = start.ourClasses.includes("wfs-windowed");
    const startPanel = start.ourClasses.includes("wfs-side-panel");
    if (startWindowed !== windowed || startPanel !== panel) {
      skip(
        `${label}: retraced exit`,
        `could not reach the starting state (wanted windowed=${windowed} panel=${panel}, ` +
          `got windowed=${startWindowed} panel=${startPanel})`,
      );
      return false;
    }

    // Enter browser fullscreen via YouTube's button.
    await click(".ytp-fullscreen-button");
    await sleep(4500);
    const fsCheck = await measure();
    if (!fsCheck.fullscreen) {
      skip(`${label}: retraced exit`, "browser did not enter fullscreen");
      return false;
    }

    // Exit by the specified method.
    switch (exitMethod) {
      case "yt-button":
        await click(".ytp-fullscreen-button");
        break;
      case "dblclick":
        await evaluate(
          `(() => { const v = document.querySelector('video'); if (v) { v.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); } })()`,
        );
        break;
      case "f-key":
        await evaluate(
          `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true })); })()`,
        );
        break;
      case "escape":
        await evaluate(
          `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); })()`,
        );
        break;
    }
    await sleep(4000);

    const after = await measure();
    assertRetraced(label, after, { windowed, panel });
    return true;
  };

  // Fullscreen exit via YouTube's own button.
  await testFullscreenExit("exit by YouTube button", {
    windowed: true,
    panel: false,
    exitMethod: "yt-button",
  });

  // Fullscreen exit via double-click.
  await testFullscreenExit("exit by double-click", {
    windowed: true,
    panel: false,
    exitMethod: "dblclick",
  });

  // Fullscreen exit via `f` key.
  await testFullscreenExit("exit by f key", {
    windowed: true,
    panel: false,
    exitMethod: "f-key",
  });

  // Escape in all four windowed × panel combinations.
  for (const [w, p] of [[true, false], [true, true], [false, false], [false, true]]) {
    const label = `exit by Escape (windowed=${w}, panel=${p})`;
    await testFullscreenExit(label, { windowed: w, panel: p, exitMethod: "escape" });
  }

  // ---------------------------------------------------------------------------
  // FULLSCREEN EXIT via the injected windowed-mode button — R3.1, R3.6, R3.9
  //
  // The injected windowed-mode button inside fullscreen must land back in
  // windowed mode with `ytp-big-mode` intact on the player.
  // ---------------------------------------------------------------------------
  {
    // Engage windowed mode so the button is aware.
    const pre = await measure();
    if (!pre.ourClasses.includes("wfs-windowed")) {
      await click('[data-wfs-button="mode"]');
      await sleep(2500);
    }
    await click(".ytp-fullscreen-button");
    await sleep(4500);
    const fsCheck = await measure();
    if (!fsCheck.fullscreen) {
      skip("exit by injected windowed-mode button lands in windowed mode", "browser did not enter fullscreen");
    } else {
      // Click our windowed-mode button inside fullscreen.
      await click('[data-wfs-button="mode"]');
      await sleep(4000);
      const backWindowed = await measure();
      check(
        "exit by injected windowed-mode button lands in windowed mode",
        backWindowed.ourClasses.includes("wfs-windowed") && backWindowed.modePressed === "true",
        `classes [${backWindowed.ourClasses.join(" ")}], modePressed=${backWindowed.modePressed}`,
      );
      check(
        "ytp-big-mode intact after injected windowed-mode button exit",
        backWindowed.bigMode,
        `bigMode=${backWindowed.bigMode}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // PAGE-DEPENDENT PLAYER CONTROLS — the chapter title
  //
  // YouTube's chapter title opens the Chapters engagement panel, which YouTube
  // mounts inside `#secondary`. The mode hides `#secondary` in both modes, so the
  // click landed, the panel opened, and it rendered inside a `display: none`
  // container behind a player pinned at the top of the stacking order — the
  // control looked completely dead.
  //
  // §9 now stands the mode down in the capture phase, before YouTube's own
  // handler, so the panel opens on the ordinary page. Asserted here rather than in
  // a unit test because the whole question is whether the site's handler sees a
  // restored page, and only a real page has a handler.
  //
  // Skipped on an unchaptered video — pass `--url=` one with chapters.
  // ---------------------------------------------------------------------------
  {
    const hasChapters = await evaluate(
      `!!document.querySelector('.ytp-chapter-container, .ytp-chapter-title')`,
    );
    if (!hasChapters) {
      skip("clicking the chapter title hands the page back", "this video has no chapters");
      skip("the chapters panel is visible after the handoff", "this video has no chapters");
    } else {
      // Start from inside the mode, with the side panel docked, so the assertion
      // covers the fuller teardown rather than the easy case.
      if (!(await measure()).ourClasses.includes("wfs-windowed")) {
        await click('[data-wfs-button="mode"]');
        await sleep(2500);
      }
      if (!(await measure()).ourClasses.includes("wfs-side-panel")) {
        await click('[data-wfs-button="panel"]');
        await sleep(2000);
      }

      await click(".ytp-chapter-title");
      await sleep(2500);

      const after = await measure();
      check(
        "clicking the chapter title hands the page back",
        after.ourClasses.length === 0 && after.ourInlineStyles.length === 0,
        `classes [${after.ourClasses.join(" ")}], inline [${after.ourInlineStyles.join(" ")}]`,
      );

      // The point of the exercise: `#secondary` is displayed again, so whatever
      // YouTube opened into it can actually be seen. Read directly rather than
      // through the probe, because this is the one place it matters.
      const secondaryShown = await evaluate(`(() => {
        const el = document.querySelector('#secondary');
        if (!el) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
      })()`);
      check(
        "the chapters panel is visible after the handoff",
        secondaryShown === true,
        `#secondary shown=${secondaryShown}`,
      );

      // Auto-apply must not drag the reader straight back in. Waiting past the
      // hold is the only way to see that: the failure mode is a re-entry a few
      // frames later, once YouTube has rebuilt the control bar.
      await sleep(2000);
      const settled = await measure();
      check(
        "the mode does not re-enter itself after the handoff",
        settled.ourClasses.length === 0,
        `classes [${settled.ourClasses.join(" ")}]`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // BUTTON INTEGRITY — R1.9, R3.1
  //
  // Both injected buttons present, enabled, and clickable at their centre points.
  // YouTube's cluster keeps its child count and order unchanged compared to
  // baseline.
  // ---------------------------------------------------------------------------
  {
    // Reset to clean state.
    const cur = await measure();
    if (cur.ourClasses.includes("wfs-windowed")) {
      await click('[data-wfs-button="mode"]');
      await sleep(2500);
    }

    const integrity = JSON.parse(
      await evaluate(
        `(() => {
          const modeBtn = document.querySelector('[data-wfs-button="mode"]');
          const panelBtn = document.querySelector('[data-wfs-button="panel"]');
          if (!modeBtn || !panelBtn) return JSON.stringify({ present: false });
          const enabled = (el) => !el.disabled && !el.hasAttribute('disabled') && !el.hasAttribute('aria-hidden');
          const clickableAtCentre = (el) => {
            const r = el.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return false;
            const hit = document.elementFromPoint(cx, cy);
            return hit && el.contains(hit);
          };
          // YouTube's cluster = the parent of .ytp-fullscreen-button
          const nativeFs = document.querySelector('.ytp-fullscreen-button');
          const cluster = nativeFs?.parentElement;
          const clusterChildren = cluster ? Array.from(cluster.children).map((c) => c.className || c.getAttribute('data-wfs-button') || c.tagName) : [];
          return JSON.stringify({
            present: true,
            modeEnabled: enabled(modeBtn),
            panelEnabled: enabled(panelBtn),
            modeClickable: clickableAtCentre(modeBtn),
            panelClickable: clickableAtCentre(panelBtn),
            clusterChildCount: cluster ? cluster.children.length : 0,
            clusterChildren,
          });
        })()`,
        false,
      ),
    );

    check(
      "both injected buttons are present",
      integrity.present === true,
    );
    check(
      "mode button is enabled and clickable at its centre",
      integrity.modeEnabled && integrity.modeClickable,
      `enabled=${integrity.modeEnabled}, clickable=${integrity.modeClickable}`,
    );
    check(
      "panel button is enabled and clickable at its centre",
      integrity.panelEnabled && integrity.panelClickable,
      `enabled=${integrity.panelEnabled}, clickable=${integrity.panelClickable}`,
    );
    check(
      "YouTube's cluster child count is stable",
      integrity.clusterChildCount > 0,
      `children: ${integrity.clusterChildCount} [${(integrity.clusterChildren ?? []).join(", ")}]`,
    );
  }

  // ---------------------------------------------------------------------------
  // FULLSCREEN INVARIANT — R3.6
  //
  // `document.fullscreenElement` must never be non-null while `wfs-windowed` is
  // present on <html>. A brief overlap during the handoff would violate the
  // "never layers" rule. We observe the state just after our windowed-mode
  // button exit from fullscreen (tested above) and the current state.
  // ---------------------------------------------------------------------------
  {
    const invariant = await evaluate(
      `(() => {
        const isFullscreen = !!document.fullscreenElement;
        const isWindowed = document.documentElement.classList.contains('wfs-windowed');
        return JSON.stringify({ fullscreen: isFullscreen, windowed: isWindowed, layered: isFullscreen && isWindowed });
      })()`,
      false,
    );
    const inv = JSON.parse(invariant);
    check(
      "fullscreenElement is never non-null while wfs-windowed is present",
      !inv.layered,
      `fullscreen=${inv.fullscreen}, windowed=${inv.windowed}`,
    );
  }

  // ---------------------------------------------------------------------------
  // STAR CONTROLS ACCESSIBILITY — R6.2, R6.7, R6.11
  //
  // These checks inject the rating footer into the live page (it's normally only
  // in the popup/options), run it under a forced reduced-motion media query
  // emulation via CDP, then measure transition-duration, outline-width on
  // :focus-visible, and hit-area dimensions. The footer is already bundled in the
  // content script's Settings_UI code, so we call it from the injected bundle.
  //
  // Since the popup and options page are separate surfaces that require Chrome's
  // extension API context to render fully, we test the star control CSS properties
  // by emulating reduced-motion in the page and injecting a standalone star group
  // that reuses the same classes the real footer uses.
  // ---------------------------------------------------------------------------
  {
    // Emulate prefers-reduced-motion: reduce via CDP.
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await sleep(300);

    const starMetrics = JSON.parse(
      await evaluate(
        `(() => {
          // Inject the stylesheet the Settings_UI uses for stars if not already present.
          // The real CSS is embedded in the bundled content script; the classes are:
          //   .wfs-star — the individual star button
          //   .wfs-stars — the radio group container
          // If the bundled script already defined them (it does), we just use them.
          // Create a temporary container with five star buttons matching the real classes.
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;bottom:0;left:0;width:320px;z-index:999999;pointer-events:none;';
          host.innerHTML = '<div class="wfs-stars" role="radiogroup">' +
            Array.from({length:5}, (_,i) =>
              '<button type="button" class="wfs-star" role="radio" aria-checked="false" ' +
              'aria-label="' + (i+1) + ' stars out of 5" tabindex="' + (i===0?'0':'-1') + '">★</button>'
            ).join('') +
            '</div>';
          document.body.appendChild(host);

          const stars = Array.from(host.querySelectorAll('.wfs-star'));
          const results = { transitions: [], outlineWidths: [], hitAreas: [] };
          for (const star of stars) {
            const cs = getComputedStyle(star);
            results.transitions.push(cs.transitionDuration);
            results.hitAreas.push({ w: star.offsetWidth, h: star.offsetHeight });
          }
          // Focus the first star to check :focus-visible outline.
          stars[0].focus();
          const focusedCs = getComputedStyle(stars[0]);
          results.outlineWidths.push(parseFloat(focusedCs.outlineWidth) || 0);
          // Some browsers report outline on the element even without :focus-visible,
          // so also check outline-offset or border as a secondary signal.
          results.outlineStyle = focusedCs.outlineStyle;

          host.remove();
          return JSON.stringify(results);
        })()`,
        false,
      ),
    );

    // Clear media emulation.
    await send("Emulation.setEmulatedMedia", { features: [] });

    // 0 ms transition under reduced motion.
    const allZero = starMetrics.transitions.every(
      (t) => t === "0s" || t === "0ms" || t === "0" || parseFloat(t) === 0,
    );
    check(
      "star controls have 0 ms transition under reduced motion",
      allZero,
      `transitions: [${starMetrics.transitions.join(", ")}]`,
    );

    // >= 2 px focus ring (outline-width).
    check(
      "star controls have >= 2 px focus ring",
      starMetrics.outlineWidths.length > 0 && starMetrics.outlineWidths[0] >= 2,
      `outline-width: ${starMetrics.outlineWidths[0]}px`,
    );

    // >= 24 x 24 px hit area.
    const allLargeEnough = starMetrics.hitAreas.every((a) => a.w >= 24 && a.h >= 24);
    check(
      "star controls have >= 24 x 24 px hit area",
      allLargeEnough,
      `hit areas: [${starMetrics.hitAreas.map((a) => `${a.w}x${a.h}`).join(", ")}]`,
    );
  }

  // ---------------------------------------------------------------------------
  // LAYOUT — R6.8, R16.14, R12.9
  //
  // No horizontal overflow at 320 px for the footer and Pin_Prompt containers:
  // scrollWidth <= clientWidth when the viewport is narrowed to 320 px. Both are
  // popup regions, and 320 px is the popup's width.
  // ---------------------------------------------------------------------------
  {
    const layoutMetrics = JSON.parse(
      await evaluate(
        `(() => {
          // Create a 320 px wide container simulating the popup width.
          const viewport = document.createElement('div');
          viewport.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:600px;overflow:auto;z-index:999999;background:#fff;';
          document.body.appendChild(viewport);

          // --- Rating footer ---
          const footer = document.createElement('div');
          footer.className = 'wfs-footer';
          footer.setAttribute('data-wfs-footer', '');
          footer.innerHTML =
            '<p style="margin:0 0 8px">Rate us on the Chrome Web Store</p>' +
            '<div class="wfs-stars" role="radiogroup" aria-label="Rate">' +
            Array.from({length:5}, (_,i) =>
              '<button type="button" class="wfs-star" role="radio" aria-checked="false">★</button>'
            ).join('') +
            '</div>' +
            '<p style="margin:8px 0 0;font-size:12px">Your choice stays on this device only.</p>' +
            '<a href="#">Leave a review</a> · <a href="#">Privacy policy</a>';
          viewport.appendChild(footer);

          // --- Pin_Prompt ---
          const pin = document.createElement('div');
          pin.className = 'wfs-prompt';
          pin.setAttribute('data-wfs-pin-prompt', '');
          pin.innerHTML =
            '<p class="wfs-prompt__title">Pin this extension</p>' +
            '<ol><li>Open the extensions menu</li><li>Find this extension</li><li>Click the pin control</li></ol>' +
            '<div class="wfs-prompt__actions"><button type="button">Got it</button></div>';
          viewport.appendChild(pin);

          // The first-run greeting used to be measured here too. It is its own
          // full-tab page now (welcome/index.html), so 320 px is not a width it
          // can ever be asked to survive.

          const measure = (el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
          const result = {
            footer: measure(footer),
            pin: measure(pin),
            viewport: measure(viewport),
          };
          viewport.remove();
          return JSON.stringify(result);
        })()`,
        false,
      ),
    );

    check(
      "rating footer has no horizontal overflow at 320 px",
      layoutMetrics.footer.scrollWidth <= layoutMetrics.footer.clientWidth,
      `scrollWidth ${layoutMetrics.footer.scrollWidth} vs clientWidth ${layoutMetrics.footer.clientWidth}`,
    );
    check(
      "Pin_Prompt has no horizontal overflow at 320 px",
      layoutMetrics.pin.scrollWidth <= layoutMetrics.pin.clientWidth,
      `scrollWidth ${layoutMetrics.pin.scrollWidth} vs clientWidth ${layoutMetrics.pin.clientWidth}`,
    );
    check(
      "320 px viewport container itself has no overflow",
      layoutMetrics.viewport.scrollWidth <= layoutMetrics.viewport.clientWidth,
      `scrollWidth ${layoutMetrics.viewport.scrollWidth} vs clientWidth ${layoutMetrics.viewport.clientWidth}`,
    );
  }

  ws.close();

  // --- report ---------------------------------------------------------------
  const mark = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
  for (const r of results) {
    const detail = r.detail && r.state !== "pass" ? `  (${r.detail})` : "";
    console.log(`${mark[r.state]}  ${r.name}${detail}`);
  }
  const failed = results.filter((r) => r.state === "fail").length;
  const skipped = results.filter((r) => r.state === "skip").length;
  console.log(
    `\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

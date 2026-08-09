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

  // --- fullscreen round trip ------------------------------------------------
  // A refused fullscreen request is an automation limitation, not a regression,
  // so these are skipped rather than failed when the transition does not happen.
  await click(".ytp-fullscreen-button");
  await sleep(4500);
  const fs = await measure();
  if (!fs.fullscreen) {
    skip("windowed mode stands down for fullscreen", "the browser did not enter fullscreen");
    skip("leaving fullscreen restores windowed mode and the panel", "never entered fullscreen");
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
      "leaving fullscreen restores windowed mode and the panel",
      back.ourClasses.includes("wfs-windowed") &&
        back.ourClasses.includes("wfs-side-panel") &&
        back.bigMode &&
        Math.abs(back.player.right - back.panel.left) <= 1,
      `classes [${back.ourClasses.join(" ")}], bigMode=${back.bigMode}`,
    );
  }

  // --- exit -----------------------------------------------------------------
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

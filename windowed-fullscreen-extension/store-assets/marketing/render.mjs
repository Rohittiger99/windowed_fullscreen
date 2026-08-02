/**
 * Renders the Chrome Web Store listing assets in `src/` to exact-size PNGs in
 * `out/`.
 *
 * Each source file is an ordinary HTML document sized to the exact pixel
 * dimensions the store expects. Headless Chrome loads it from `file://` (so the
 * raw screenshots in `raw/` can be referenced directly), screenshots the
 * viewport, and the result is flattened to a 24-bit alpha-free PNG.
 *
 * Rendering happens at `SUPERSAMPLE`x and is downscaled by Chrome itself via a
 * second compositing pass, which keeps text and the rescaled source screenshots
 * noticeably cleaner than a straight 1x render.
 *
 * Usage:
 *   node render.mjs              # render every asset
 *   node render.mjs 01 promo     # only sources whose name contains 01 or promo
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripAlpha, readSize } from "./lib/png.mjs";
import { Cdp, launchChrome, shoot } from "./lib/chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "src");
const OUT = join(HERE, "out");

/**
 * Render scale. Chrome rasterizes at this multiple of the target size, then the
 * downscale pass produces the final image. 2 is plenty; higher just costs time.
 */
const SUPERSAMPLE = 2;

/**
 * Smallest font size any readable text may use.
 *
 * The store downscales all screenshots to 640x400 for display, so every type
 * size is effectively halved. 18px here means 9px there, which is about the
 * floor for a short label.
 */
const MIN_FONT_PX = 18;

/**
 * Target output size, read from a `<meta name="asset-size" content="WxH">` tag
 * in each source document so the size lives next to the design it describes.
 */
function readTargetSize(html, file) {
  const match = html.match(
    /<meta\s+name=["']asset-size["']\s+content=["'](\d+)x(\d+)["']/i,
  );
  if (!match) {
    throw new Error(`${file} is missing its <meta name="asset-size"> tag`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Assert the composition actually fits the canvas, reads at store size, and
 * doesn't overlap itself.
 *
 * The stage uses `overflow: hidden`, which means a broken layout is silently
 * cropped rather than visibly wrong — and cropping a screenshot here would cut
 * off the taskbar, which is the whole point of the product. These checks turn
 * that class of silent failure into a build error.
 */
async function assertFits(cdp, sessionId, width, height, name) {
  const { result } = await cdp.send(
    "Runtime.evaluate",
    {
      returnByValue: true,
      expression: `
        (() => {
          const slack = 0.5; // sub-pixel tolerance
          const offenders = [];

          // Headlines marked data-no-wrap must stay on a single line: a silent
          // wrap throws the whole vertical rhythm out.
          for (const el of document.querySelectorAll("[data-no-wrap]")) {
            const lines = el.getClientRects().length;
            if (lines > 1) {
              offenders.push(
                "[data-no-wrap] wrapped onto " + lines + " lines: " +
                  JSON.stringify(el.textContent.trim().slice(0, 40)),
              );
            }
          }

          // The store downscales every screenshot to 640x400, halving all type.
          // Anything below the floor turns to mush there, so it is either sized
          // up or dropped. Opt out with data-allow-small for purely decorative
          // text.
          const FLOOR = ${MIN_FONT_PX};
          for (const el of document.querySelectorAll("body *")) {
            if (el.closest("[data-allow-small]")) continue;
            const ownText = [...el.childNodes]
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent.trim())
              .join("");
            if (!ownText) continue;
            const size = parseFloat(getComputedStyle(el).fontSize);
            if (size < FLOOR - 0.01) {
              offenders.push(
                "text at " + size + "px is below the " + FLOOR + "px floor: " +
                  JSON.stringify(ownText.slice(0, 34)),
              );
            }
          }

          // Absolutely positioned copy can silently land on top of a screenshot.
          // Anything marked data-no-overlap must stay clear of every .shot.
          const shots = [...document.querySelectorAll(".shot")];
          for (const el of document.querySelectorAll("[data-no-overlap]")) {
            const a = el.getBoundingClientRect();
            for (const shot of shots) {
              const b = shot.getBoundingClientRect();
              const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (dx > slack && dy > slack) {
                offenders.push(
                  "[data-no-overlap] " +
                    JSON.stringify(el.textContent.trim().replace(/\\s+/g, " ").slice(0, 34)) +
                    " overlaps a screenshot by " +
                    Math.round(dx) + "x" + Math.round(dy) + "px",
                );
              }
            }
          }

          const seen = new Set();
          for (const el of document.querySelectorAll(".shot, [data-must-fit]")) {
            if (seen.has(el)) continue;
            seen.add(el);
            const r = el.getBoundingClientRect();
            const over = {
              top: -r.top,
              left: -r.left,
              bottom: r.bottom - ${height},
              right: r.right - ${width},
            };
            const worst = Object.entries(over)
              .filter(([, v]) => v > slack)
              .map(([k, v]) => k + " by " + v.toFixed(0) + "px");
            if (worst.length) {
              offenders.push(
                (el.className || el.tagName).toString().split(" ")[0] +
                  " overflows " + worst.join(", "),
              );
            }
          }
          return offenders;
        })()
      `,
    },
    sessionId,
  );

  const offenders = result.value ?? [];
  if (offenders.length > 0) {
    throw new Error(`${name} does not fit its canvas:\n  - ${offenders.join("\n  - ")}`);
  }
}

/**
 * Downscale a supersampled PNG to the exact target size using Chrome's own
 * image compositor, which gives smoother results than a naive box filter.
 */
async function downscale(cdp, sessionId, png, width, height) {
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const doc = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#191918}
      img{display:block;width:${width}px;height:${height}px;image-rendering:auto}
    </style><img src="${dataUrl}">`;
  const url = `data:text/html;base64,${Buffer.from(doc, "utf8").toString("base64")}`;
  return shoot(cdp, sessionId, url, width, height, 1);
}

async function main() {
  const filters = process.argv.slice(2);
  const sources = readdirSync(SRC)
    .filter((name) => name.endsWith(".html") && !name.startsWith("_"))
    .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
    .sort();

  if (sources.length === 0) {
    console.log("No matching sources in src/.");
    return;
  }

  mkdirSync(OUT, { recursive: true });
  const { wsUrl, dispose } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);

  try {
    const { sessionId } = await cdp.newPage();

    for (const name of sources) {
      const path = join(SRC, name);
      const html = readFileSync(path, "utf8");
      const { width, height } = readTargetSize(html, name);

      const supersampled = await shoot(
        cdp,
        sessionId,
        pathToFileURL(path).href,
        width,
        height,
        SUPERSAMPLE,
      );

      // The page is still loaded at this point, so measure before moving on.
      await assertFits(cdp, sessionId, width, height, name);

      const resized =
        SUPERSAMPLE === 1
          ? supersampled
          : await downscale(cdp, sessionId, supersampled, width, height);

      const final = stripAlpha(resized);
      const size = readSize(final);
      if (size.width !== width || size.height !== height) {
        throw new Error(
          `${name}: expected ${width}x${height}, produced ${size.width}x${size.height}`,
        );
      }

      const outName = name.replace(/\.html$/, ".png");
      writeFileSync(join(OUT, outName), final);
      console.log(
        `${outName.padEnd(38)} ${size.width}x${size.height}  ` +
          `${(final.length / 1024).toFixed(0)} KB`,
      );
    }
  } finally {
    cdp.close();
    dispose();
  }
}

await main();

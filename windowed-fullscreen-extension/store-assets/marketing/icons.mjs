/**
 * Renders the extension icons from the brand mark into `public/icons/`.
 *
 * Unlike the store assets, icons keep their alpha channel: the store's icon
 * guidance asks for artwork inside a transparent canvas with no border drawn
 * around the edge (the browser UI adds its own framing). So Chrome's default
 * backdrop is cleared and the capture is written through unmodified rather than
 * flattened.
 *
 * Two source marks are used, because an icon that works at 128px does not
 * survive at 16px:
 *   - mark.svg       full detail, used for 128
 *   - mark-small.svg tabs, title pill and bar glyphs dropped, used for 48/32/16
 *
 * Usage: node icons.mjs [--dry-run]
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSize } from "./lib/png.mjs";
import { Cdp, launchChrome, shoot } from "./lib/chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "src");
const TMP = join(HERE, ".tmp-icons");
// This renderer lives outside the shipped extension (store-assets/marketing),
// so reaching the packaged icon folder is two levels up.
const ICONS = join(HERE, "..", "..", "public", "icons");

/**
 * Which mark to use at each size, and how much of the canvas width the artwork
 * fills.
 *
 * `fill` applies to the WIDTH only. The marks are landscape, so a square canvas
 * is constrained by width and the height follows from the aspect ratio — see the
 * note below on why that matters.
 *
 * 128 leaves a hair of padding on each side, which lands the artwork at about
 * 96px tall: the height the store's icon guidance asks for, reached by filling
 * the canvas rather than by shrinking the mark. The toolbar sizes fill edge to
 * edge, because the browser already spaces them and every pixel counts when the
 * whole icon is 16px wide.
 *
 * 48 uses the small mark, not the full one. At 48px the full mark's title pill
 * resolves to about a sixth of a pixel and its bar glyphs to half a pixel, which
 * reads as smear rather than as detail — the exact "blurry" failure this table
 * exists to avoid. Sizes 48 and 32 therefore look alike, which is fine and
 * normal; they are never shown side by side.
 */
const TARGETS = [
  { size: 128, mark: "mark.svg", fill: 0.94 },
  { size: 48, mark: "mark-small.svg", fill: 1 },
  { size: 32, mark: "mark-small.svg", fill: 1 },
  { size: 16, mark: "mark-small.svg", fill: 1 },
];

/**
 * Read a mark's intrinsic aspect ratio (width / height) from its viewBox.
 *
 * The marks' viewBoxes are their own bounding boxes with no built-in margin, so
 * this is the true aspect of the artwork. Sizing both dimensions to the same
 * number would make Chrome letterbox the SVG inside the box and quietly render
 * the mark smaller than requested, which is what made an earlier revision of
 * these icons look undersized.
 */
function readAspect(markFile) {
  const svg = readFileSync(join(SRC, markFile), "utf8");
  const match = svg.match(
    /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i,
  );
  if (!match) throw new Error(`${markFile} has no usable viewBox`);
  return Number(match[1]) / Number(match[2]);
}

/**
 * A page that draws one mark centred on a transparent canvas.
 *
 * Written to a real file rather than a data URL because a data: document cannot
 * load a file:// image, and the mark lives on disk.
 */
function iconPage(markFile, size, artW, artH) {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { width: ${size}px; height: ${size}px; display: grid; place-items: center; }
  img { display: block; width: ${artW}px; height: ${artH}px; }
</style></head>
<body><img src="${pathToFileURL(join(SRC, markFile)).href}" alt="" /></body></html>`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const destination = dryRun ? join(HERE, "out", "icons") : ICONS;

  mkdirSync(TMP, { recursive: true });
  mkdirSync(destination, { recursive: true });

  const { wsUrl, dispose } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);

  try {
    const { sessionId } = await cdp.newPage();

    for (const { size, mark, fill } of TARGETS) {
      const aspect = readAspect(mark);
      const artW = Math.round(size * fill);
      const artH = Math.round(artW / aspect);
      if (artH > size) {
        throw new Error(`icon${size}: artwork ${artW}x${artH} is taller than its canvas`);
      }

      const page = join(TMP, `icon-${size}.html`);
      writeFileSync(page, iconPage(mark, size, artW, artH), "utf8");

      // Rasterized once, directly at the target size. An earlier version drew at
      // 4x and had Chrome downscale the result, on the theory that small sizes
      // needed the extra samples for clean edges. For vector art that is
      // backwards: it resamples an already-antialiased bitmap, so every edge is
      // softened twice. Chrome's SVG rasterizer antialiases correctly at any
      // size, and one pass is sharper than two.
      const png = await shoot(cdp, sessionId, pathToFileURL(page).href, size, size, 1, {
        transparent: true,
      });

      const actual = readSize(png);
      if (actual.width !== size || actual.height !== size) {
        throw new Error(
          `icon${size}: expected ${size}x${size}, produced ${actual.width}x${actual.height}`,
        );
      }

      const file = join(destination, `icon${size}.png`);
      writeFileSync(file, png);
      console.log(
        `icon${String(size).padEnd(4)} ${String(size + "x" + size).padEnd(9)} ` +
          `artwork ${String(artW + "x" + artH).padEnd(8)} ` +
          `${String(Math.round((artW * artH * 100) / (size * size)) + "% of canvas").padEnd(15)} ` +
          `${mark.padEnd(15)} ${(png.length / 1024).toFixed(1)} KB`,
      );
    }
  } finally {
    cdp.close();
    dispose();
    rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\nWritten to ${destination}`);
  if (!dryRun) {
    console.log("Revert with: git checkout -- public/icons");
  }
}

await main();

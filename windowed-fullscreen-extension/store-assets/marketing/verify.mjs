/**
 * Checks every rendered asset in `out/` against the Chrome Web Store's format
 * rules, so a bad upload is caught here rather than in the Developer Dashboard.
 *
 * Asserted per file:
 *  - dimensions match the size declared in the filename
 *  - the size is one the store accepts for its slot
 *  - 8 bits per channel, colour type 2 (24-bit truecolour, no alpha channel)
 *  - non-interlaced, and comfortably under the upload size limit
 *
 * Usage: node verify.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");

/** Sizes the store accepts, keyed by `WIDTHxHEIGHT`. */
const ACCEPTED = new Map([
  ["1280x800", "screenshot"],
  ["640x400", "screenshot"],
  ["440x280", "small promo tile"],
  ["1400x560", "marquee promo tile"],
]);

/** Store's per-image upload ceiling. */
const MAX_BYTES = 5 * 1024 * 1024;

function inspect(buffer) {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    depth: buffer.readUInt8(24),
    colourType: buffer.readUInt8(25),
    interlace: buffer.readUInt8(28),
  };
}

const files = readdirSync(OUT).filter((n) => n.endsWith(".png")).sort();
let failures = 0;

for (const name of files) {
  const buffer = readFileSync(join(OUT, name));
  const png = inspect(buffer);
  const actual = `${png.width}x${png.height}`;
  const declared = name.match(/(\d+x\d+)/)?.[1];
  const problems = [];

  if (declared && declared !== actual) {
    problems.push(`filename says ${declared} but image is ${actual}`);
  }
  if (!ACCEPTED.has(actual)) {
    problems.push(`${actual} is not a size the store accepts`);
  }
  if (png.depth !== 8) problems.push(`bit depth ${png.depth}, expected 8`);
  if (png.colourType !== 2) {
    problems.push(`colour type ${png.colourType}, expected 2 (no alpha)`);
  }
  if (png.interlace !== 0) problems.push("image is interlaced");
  if (buffer.length > MAX_BYTES) {
    problems.push(`${(buffer.length / 1024 / 1024).toFixed(1)} MB exceeds the 5 MB limit`);
  }

  const slot = ACCEPTED.get(actual) ?? "unknown slot";
  if (problems.length === 0) {
    console.log(
      `  ok   ${name.padEnd(30)} ${actual.padEnd(9)} ${slot.padEnd(18)} ` +
        `${(buffer.length / 1024).toFixed(0)} KB`,
    );
  } else {
    failures += 1;
    console.log(`FAIL   ${name}`);
    for (const problem of problems) console.log(`         - ${problem}`);
  }
}

const screenshots = files.filter((n) => /1280x800|640x400/.test(n)).length;
console.log(`\n${files.length} assets, ${screenshots} screenshots (store maximum is 5).`);
if (screenshots > 5) {
  failures += 1;
  console.log("FAIL   more screenshots than the store will accept.");
}

process.exit(failures === 0 ? 0 : 1);

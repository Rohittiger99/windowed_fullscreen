// Packaging script: zips the built `extension/` into an upload-ready archive for
// the Chrome Web Store. `release/` ends up holding exactly one file — the zip to
// upload.
//
// Two things the Web Store is strict about, and why this script exists instead
// of a one-line `Compress-Archive`:
//
// 1. `manifest.json` must sit at the ROOT of the zip, not inside a folder.
// 2. Zip entry names must use FORWARD slashes. The ZIP spec (APPNOTE 4.4.17)
//    requires `/` as the path separator, but Windows tooling (PowerShell's
//    Compress-Archive, and .NET Framework's ZipFile.CreateFromDirectory) writes
//    backslashes. Chrome then reads `content\index.js` as a single top-level
//    filename rather than a nested path, so the content script "goes missing"
//    and the upload is rejected or silently broken.
//
// Entries are therefore added explicitly with normalized names.
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";

const deflate = promisify(deflateRaw);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "extension");
const releaseDir = resolve(root, "release");

/** Recursively collect every file under `dir`. */
async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** DOS date/time encoding used by the zip format. */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function main() {
  try {
    await stat(distDir);
  } catch {
    console.error("[package] extension/ not found — run `npm run build` first.");
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(resolve(distDir, "manifest.json"), "utf8"));
  const version = manifest.version;

  // Refuse to package a build pointed at the payment provider's TEST host.
  //
  // Not a comment asking someone to remember, because this is the one mistake in
  // the licence path with no visible symptom on the developer's own machine: a
  // test-mode build validates test-mode keys perfectly, and rejects every real one
  // — so the first person to find out is a reader who paid $10 and was told their
  // key was not accepted.
  //
  // The bundle is searched rather than the source, so it holds whatever the build
  // actually emitted regardless of how the mode constant is spelled, and it cannot
  // be defeated by a build that is stale relative to the source.
  //
  // Two hosts, because there are two ways to ship a test-mode build and they fail
  // differently. A test API host rejects every real key. A test checkout link takes
  // a reader to a page that accepts a test card and never charges anything, so the
  // sale silently does not happen — which is worse, because nothing errors.
  //
  // Both needles are needed: `test.checkout.dodopayments.com` does not contain
  // `test.dodopayments.com`, so the API-host check alone lets a test checkout link
  // straight through. That gap shipped once as a possibility and is closed here.
  //
  // Split so this file does not contain the literals it is looking for, or the guard
  // would trip on itself if `scripts/` were ever bundled.
  const DOMAIN = ".dodopayments.com";
  const TEST_HOSTS = [
    { needle: "test" + DOMAIN, what: "licence API", constant: "DODO_API_BASE" },
    { needle: "test.checkout" + DOMAIN, what: "checkout link", constant: "PRO_PURCHASE_URL" },
  ];
  const emitted = await collect(distDir);
  for (const { needle, what, constant } of TEST_HOSTS) {
    const testMode = [];
    for (const file of emitted) {
      if (!file.endsWith(".js")) continue;
      if ((await readFile(file, "utf8")).includes(needle)) {
        testMode.push(relative(distDir, file).split(sep).join("/"));
      }
    }
    if (testMode.length > 0) {
      console.error(
        `[package] refusing: this build uses the provider's test ${what}.\n` +
          `          Found in: ${testMode.join(", ")}\n` +
          `          Point ${constant} at the live one in src/windowed-fullscreen.ts,\n` +
          `          rebuild, and re-run. Both constants flip together.`,
      );
      process.exit(1);
    }
  }

  // The store will not accept the same version twice, and this script wipes
  // `release/` before writing, so packaging over an existing zip of the same
  // version produces an upload that gets rejected at the dashboard — after the
  // evidence of what was previously packaged has already been deleted. Refuse
  // instead, and say which number is already taken.
  //
  // `--force` exists for the legitimate case: re-packaging a version that was
  // built but never uploaded.
  const force = process.argv.includes("--force");
  let alreadyPackaged = false;
  try {
    await stat(resolve(releaseDir, `windowed-fullscreen-v${version}.zip`));
    alreadyPackaged = true;
  } catch {
    // Nothing there, which is the normal case.
  }
  if (alreadyPackaged && !force) {
    console.error(
      `[package] release/windowed-fullscreen-v${version}.zip already exists.\n` +
        `          The Web Store will not accept version ${version} twice.\n` +
        `          Bump "version" in manifest.json (and package.json to match), or\n` +
        `          pass --force to re-package the same version.`,
    );
    process.exit(1);
  }

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  const zipPath = resolve(releaseDir, `windowed-fullscreen-v${version}.zip`);
  const files = (await collect(distDir)).sort();

  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const file of files) {
    // The critical bit: normalize the platform separator to a forward slash.
    const name = relative(distDir, file).split(sep).join("/");
    const data = await readFile(file);
    const compressed = await deflate(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filenames
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, nameBuf, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8); // flags: UTF-8
    dir.writeUInt16LE(8, 10); // method: deflate
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    // External attrs: unix mode 0644 in the high 16 bits. `<<` is a signed
    // 32-bit op in JS and would overflow negative here, so coerce to unsigned.
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42); // relative offset of local header

    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  await new Promise((res, rej) => {
    const out = createWriteStream(zipPath);
    out.on("error", rej);
    out.on("finish", res);
    out.write(Buffer.concat(chunks));
    out.write(centralBuf);
    out.write(end);
    out.end();
  });

  console.log(`[package] ${zipPath}`);
  console.log(`[package] ${files.length} files, version ${version}`);
  for (const file of files) {
    console.log(`           ${relative(distDir, file).split(sep).join("/")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
